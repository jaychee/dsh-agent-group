/**
 * Agent Squad — role-based local agent team for DeepSeek Harness.
 *
 * The squad is a thin, opinionated role layer over the standard subagent
 * runtime (`ctx.subagents`): every teammate is a named continuable child of
 * the Lead's subagent tree, and team membership is resolved through
 * `rootOf`/`namesOf`/`listDescendants` (DSH 0.2.x Agent-Teams API).
 *
 * The squad is OPT-IN: a normal session never sees the squad persona or tools.
 * Only an explicit user request ("用小队实现") makes the Lead call
 * `squad_enable`; mentioning a teammate's name alone never enables it.
 *
 *   lead      — the DSH session itself; orchestrates and assigns work.
 *   brain     — codex: business design (PLAN.md), technical design (SPEC.md),
 *               technical acceptance (TECH-REVIEW.md) and business acceptance
 *               (REVIEW.md). Changing business behavior needs a user decision.
 *   tester    — gpt: test acceptor on a pinned local model. Reviews the
 *               workers' test cases against the brain's spec and acceptance
 *               plan (TEST-REVIEW.md); supplements missing test cases and runs
 *               the complete suite when the workers' cases fall short. Also
 *               countersigns TECH-REVIEW.md when the brain itself implemented.
 *   worker    — zcode (backend) / qoder (frontend): implement and self-test.
 *
 * Full flow (new code tasks): business plan → Lead approval → technical spec →
 * implementation → test acceptance → technical acceptance → business
 * acceptance. Tech and business rework budgets are independent (3 rounds each,
 * first acceptance free); acceptances are versioned against the code/spec they
 * examined.
 *
 * Context policy:
 *   - A teammate is a durable, continuable child of the Lead. Re-dispatching an
 *     existing teammate sends a message into the *same* session, so a rework
 *     round continues the previous conversation instead of paying for a new one.
 *   - Cross-agent memory lives in `<workspace>/.agent-squad/<task>/`: TASK.md,
 *     PLAN.md, SPEC.md, REVIEW.md, TECH-REVIEW.md, REPORT.md, JOURNAL.md. Every
 *     assignment points at that directory, so agents exchange artifacts rather
 *     than transcript copies.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { createSettingsStore, seedFromBundle } from './settings.js'
import { registerRoutes } from './http.js'
import { createSquadWorktree, createSquadWorktrees, rollbackSquadWorktrees } from './worktree.js'
import { createCodexProvider } from './codex.js'
import { createQoderProvider } from './qoder.js'

const runFile = promisify(execFile)

/** Cordis plugin name. */
export const name = 'agent-squad'

/** Services this plugin builds on. Activation waits for the subagent runtime. */
export const inject = ['subagents', 'agents', 'tools', 'systemPrompt']

/** Order of the squad prompt sections relative to first-party guidance. */
const SECTION_ORDER = 610

/** Directory (relative to the session workspace) that holds shared memory. */
const DEFAULT_MEMORY_DIR = '.agent-squad'

const MAX_REWORK_ROUNDS = 3
/** Design budget: initial design + at most 3 rework rounds = 4 design dispatches. */
const MAX_DESIGN_REWORK_ROUNDS = 3
const MAX_PLAN_ROUNDS = 1 + MAX_DESIGN_REWORK_ROUNDS
/** Full-flow acceptance budgets: tech and business rework, 3 rounds each. */
const MAX_TECH_REWORK_ROUNDS = 3
const MAX_BUSINESS_REWORK_ROUNDS = 3

/** Liveness marker surfaced by squad_status; changes whenever behavior changes. */
const PLUGIN_MARKER = 'agent-squad/zh-v13'

/** Defaults for the opt-in context policy (S1); `false` keeps the legacy path. */
const CONTEXT_POLICY_DEFAULTS = Object.freeze({
  thresholdRatio: 0.86,
  maxOutputTokens: 16384,
  autoCompact: true,
  showUsage: true,
})

/** Fields the context policy accepts; unknown keys are configuration faults. */
const CONTEXT_POLICY_KEYS = new Set([
  'thresholdRatio',
  'maxOutputTokens',
  'autoCompact',
  'showUsage',
])

/** Verbatim context discipline shared by prompts and every BRIEF version (S8). */
const CONTEXT_DISCIPLINE =
  '先 grep 定位，再 read 指定行段；不 cat 大文件。测试/构建输出重定向到文件，只读摘要；长日志不回贴。只回复 ≤150 字摘要 + 文件路径；返工只改编号缺陷。'

/** Task-execution discipline: test scoping, batching, JAR reuse and parallelism. */
const EXECUTION_DISCIPLINE =
  '编码轮只跑 compile + 受影响单测；每轮 implement/rework 结束只跑一次受影响 IT，不跑全量；全量只在测试验收、合并 Base（squad_deliver）与最终交付（squad_finish）三处跑。返工按批次一次修完再跑全量，禁止修一条跑一次全量；同一 IT 类的正向场景复用同一 JAR 生命周期/Flow，反例再独立启动，保留真实入口、不降低断言。独立包的单测/IT 可并行写，共享 schema/主题/JAR 的测试仍串行，避免资源冲突。worker 只读 REPORT 对应段 + SPEC 相关章节，不通读大文件；派单短、带文件路径/编号。仅 Base 合并 HEAD 跑一次 full --require-full-coverage。'

/** Short form for per-dispatch/BRIEF repetition. */
const EXECUTION_DISCIPLINE_SHORT =
  '编码轮 compile+受影响单测；轮末一次受影响 IT；全量只在测试验收/合并 Base/最终交付；返工批量修完再全量；共享 schema/主题/JAR 的测试串行。'

/** Verbatim rework scope line (S7); rework never re-reads passed work. */
const REWORK_SCOPE =
  '只处理编号缺陷；不要重做已通过部分；只读相关文件段落，不要通读无关文件。'

/** Budget for one manual compaction (S5); forwarded to host discovery/compaction. */
const COMPACT_TIMEOUT_MS = 180000

/** Fixed roster ids accepted by squad_compact (S5). */
const MEMBER_IDS = new Set(['brain', 'tester', 'worker1', 'front1', 'worker2'])

/** In-memory bound for report usage snapshots (S6); reload starts empty. */
const USAGE_CACHE_LIMIT = 128

/**
 * Plan-gate snapshot for one STATE. New tasks persist all four fields at
 * start; a legacy STATE without them falls back to the review gate snapshot
 * (conservative: required unless the gate explicitly said reviewRequired=false)
 * and is never relaxed by the current roster.
 */
function planGateOf(state) {
  return {
    planRequired: state.planRequired ?? (state.gate?.reviewRequired !== false),
    planRounds: Number(state.planRounds ?? 0),
    planApproved: state.planApproved === true,
    planApprovedAt: state.planApprovedAt ?? null,
  }
}

/**
 * Budget snapshot for one STATE. Limits come from STATE (designLimit /
 * reworkLimit) with the constants as defaults; a legacy or null limit falls
 * back to 4/3 and a missing/null extensions array reads as []. Read-only:
 * callers must not migrate legacy states to disk.
 */
function budgetOf(state) {
  return {
    designLimit: Number(state.designLimit ?? MAX_PLAN_ROUNDS),
    reworkLimit: Number(state.reworkLimit ?? MAX_REWORK_ROUNDS),
    techLimit: Number(state.techReworkLimit ?? MAX_TECH_REWORK_ROUNDS),
    businessLimit: Number(state.businessReworkLimit ?? MAX_BUSINESS_REWORK_ROUNDS),
    designUsed: Number(state.planRounds ?? 0),
    implementUsed: Number(state.reworkRounds ?? 0),
    techUsed: Number(state.techReworkRounds ?? 0),
    businessUsed: Number(state.businessReworkRounds ?? 0),
  }
}

/**
 * Flow snapshot for one STATE. `full` tasks snapshot specRequired at start
 * (tester participant required); every other shape — explicit `simple`
 * tasks and legacy states created before flows existed — keeps the legacy
 * gates: plan approval (when a brain participated) and a single REVIEW close.
 */
function flowOf(state) {
  // Acceptance mode: no design/spec pipeline; the designated authority
  // document replaces the brain's plan and the squad runs dual-dimension
  // acceptance (tester → brain) against it.
  const acceptance = state.mode === 'acceptance' || state.flow === 'acceptance'
  return {
    flow: acceptance
      ? 'acceptance'
      : state.flow === 'full' || state.flow === 'simple'
        ? state.flow
        : 'legacy',
    specRequired: !acceptance && state.flow === 'full' && state.specRequired === true,
    acceptance,
  }
}

/** Read the last machine verdict line of an acceptance file. */
async function readVerdict(taskDir, fileName) {
  const text = await readFile(join(taskDir, fileName), 'utf8').catch(() => '')
  if (!text) return undefined
  const verdicts = [...text.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi)]
  return verdicts.at(-1)?.[1]?.toUpperCase() ?? null
}

/**
 * One acceptance binding: a review dispatch remembers the code epoch and spec
 * version it examined. The verdict itself is read from the file at gate time;
 * the acceptance is usable only while the binding is still fresh (no code or
 * spec dispatch happened after it), so any change invalidates old conclusions.
 */
function bindingFresh(binding, state) {
  return (
    binding !== null &&
    binding !== undefined &&
    Number(binding.codeEpoch) === Number(state.codeEpoch ?? 0) &&
    Number(binding.specVersion) === Number(state.specVersion ?? 0)
  )
}

const BRAIN_CHARTER = `你是小队里的 brain（业务设计与技术设计+双验收），测试验收者（tester）管测试：你出方案与规格、并签技术/业务两份验收，tester 专职测试验收。

- 把业务目标写成可执行业务方案，存入 PLAN.md：对外行为、用户可见结果、边界场景与编号验收标准（AC）。
- 涉及对外接口时逐项写明接口契约与错误行为；没有接口变更时明确写“无接口变更”，并列出须保留的对外行为。
- 列出边界输入与精确期望值；每条 AC 必须给出可直接执行的验收命令、执行目录、退出码与通过条件。
- 在“假设与待确认”中显式列出假设及影响；未确定且影响交付的事项标为待确认，不能让测试验收者或 worker 猜测。禁止使用“适当”“合理”“类似”“等等”“参考现有实现”替代具体规格。
- 你可以澄清方案；但要改变原有业务功能、对外结果或验收标准，必须先请用户决策，不得擅自变更。
- 写完后自检“一个没有上下文的实现者能否只靠 PLAN 拍板技术设计”，把结论写入 PLAN.md；不能时补全方案，或列入“假设与待确认”并标明阻塞项，不得宣称方案可执行。
- 设计轮（spec）读取已批准的 PLAN-APPROVED.md，把技术规格写入 SPEC.md，至少覆盖适用的：代码结构、文件与模块职责、数据库表与迁移、领域模型及其依赖、对外接口与错误行为、各模块实现、可执行验证用例；对不适用的部分逐项明确说明“不适用”。技术实现可以调整，但不能擅改业务行为；若必须改业务预期，暂停受影响工作并在报告中交 Lead 转用户决策。
- 规格有问题时按 worker/tester 的上报修订并发布新版本（更新 SPEC.md，版本号以派单为准）；单纯澄清规格不扣返工额度，也不重置已用额度。
- 技术验收轮（tech-review）以当前 SPEC.md 为唯一权威技术规格：做代码审查、亲自运行验证测试，在 TECH-REVIEW.md 逐条记录需求/AC 编号、命令、退出码、关键输出与可执行的编号缺陷清单；技术验收前必须已有一份仍然新鲜的 APPROVED 测试验收（TEST-REVIEW.md）。TECH-REVIEW.md 的最后一行必须是机器可读的「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」。
- 业务验收轮以 PLAN-APPROVED.md 为唯一权威业务规格，逐条核对 AC 并在 REVIEW.md 写明 AC 编号、验证命令、退出码、关键输出与结论；亲自运行或检查，不接受没有证据的声明。测试结论对照 TEST-REVIEW.md，技术结论对照 SPEC.md 与 TECH-REVIEW.md。
- 只有每条标准都有证据通过时才报 "approved"；否则报 "changes_requested"，给出编号缺陷清单和每项的最小修复方案。
- REVIEW.md 的最后一行必须是机器可读的「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」（Lead 的收尾门禁只认这一行）。
- 当你本人接手实现过代码时，不能再签署自己改动的技术验收：技术验收改由 tester 对照 SPEC.md 代签；你的业务验收仍单独签署，两份验收独立记录。
- tester 挂起（额度耗尽容错交接）时代行测试验收职责：按 tester 章程写 TEST-REVIEW.md（审核测试用例、必要时补充并完整测试）；技术/业务验收仍按本章程单独签署，记录独立。tester 恢复后交还职责。
- 验收模式（acceptance 阶段）：以 AUTHORITY.md 为唯一权威方案做**业务维度**验收——对外行为、用户可见结果、边界场景逐项核对；与技术维度结论汇总**定稿 ACCEPTANCE-REPORT.md**，五要素齐全（验收方案与标准 / 上一轮修复情况 / 本轮问题 / 修复建议 / 结论），最后一行机器可读 VERDICT：两维度均通过才 APPROVED，任一维度有问题即 CHANGES_REQUESTED 并附编号问题与修复建议。你不产出新的设计方案，也不改权威方案。
- 不写生产代码；一次性探针脚本可以放在 /tmp。
- 方案要克制：计划正文默认不超过约 80 行，除非任务确实更复杂并在 PLAN.md 里说明理由。
- 不扩大范围，取满足目标的最小方案。`

const TESTER_CHARTER = `你是小队里的测试验收者（tester）：依据 brain 交付的技术实现规格与验收方案，审核 worker 写的测试用例是否合格，并对测试质量负责。

- 测试验收轮（test-review）读取 brain 的 SPEC.md（技术实现规格）与 PLAN-APPROVED.md（验收方案），逐条 AC 审核 worker 在 REPORT.md 中提交的测试用例：是否覆盖每条 AC、测试名/输入/期望值是否与规格一致、命令是否可直接执行、证据是否真实完整。
- worker 的测试用例不合格（缺失、覆盖不足、与规格不符、证据不实）时，由你补充测试用例并进行完整测试：补齐缺失用例、亲自运行完整测试套件、记录真实结果，不得只指出问题不补齐。
- 把测试验收结论写入 TEST-REVIEW.md：逐条 AC 记录审核结论、你补充的测试用例、完整测试的命令/退出码/关键输出；最后一行必须是机器可读的「VERDICT: APPROVED」（用例合格或已补齐且完整测试通过）或「VERDICT: CHANGES_REQUESTED」（存在测试无法覆盖的实现缺陷，给出编号缺陷清单与每项最小修复方案）。
- CHANGES_REQUESTED 的编号缺陷由 Lead 派回 worker 返工；返工后代码变化会使你的结论失效，需要重新测试验收。
- brain 本人接手实现过代码时，由你对照 SPEC.md 代签技术验收（TECH-REVIEW.md）：代码审查、亲自运行验证测试、逐条记录命令/退出码/关键输出与编号缺陷，最后一行同样是「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」。
- 不写生产代码：只补测试用例与测试脚本，不改实现逻辑；发现实现缺陷报 CHANGES_REQUESTED 转 worker 修复，不代改。
- 规格（SPEC.md/PLAN-APPROVED.md）缺失、矛盾或明显错误时停止审核，报 "blocked" 并引用具体章节与编号；不确定的预期交 Lead 转 brain 澄清，不要猜。
- 验收模式（acceptance 阶段）：以 AUTHORITY.md 为唯一权威方案做**技术维度**验收——亲自运行测试/构建、逐项核对实现与方案的一致性；第 2 轮起先逐条核对上一轮 ACCEPTANCE-REPORT 中编号问题的修复情况（已修复/部分修复/未修复 + 证据）。你只写技术维度结论，不定稿 VERDICT；不定权威标准，一切从 AUTHORITY.md 推导。`

const WORKER_CHARTER = `你是小队里的执行者，严格按已批准的业务方案与技术规格实现。

- 动手前先读 TASK.md、PLAN-APPROVED.md（业务方案）与 SPEC.md（技术规格）。PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- 只做规格定义的最小改动；不得引入规格未定义的接口、文件或依赖，不重新设计、不改名、不扩大范围。
- 规格缺失、矛盾或明显错误时立即停止实现，报 "blocked"，引用 PLAN-APPROVED.md/SPEC.md 的具体章节与编号，并列出缺失项或冲突原文；需要归档而文件缺失时明确引用文件名；豁免任务引用 TASK.md 章节或 Lead 派单条目。规格有问题上报 Lead 转 brain 修订发布，不自行偏离或改用 PLAN.md。
- 按 SPEC.md 指定的测试名、输入与期望输出写或更新测试，并亲自运行每条 AC 的验收命令；豁免任务按 TASK.md 与 Lead 本轮派单执行。
- 在 REPORT.md 逐条 AC 给证据：AC 编号、改动文件路径、测试名、实际命令、退出码、关键输出与结论；失败或未执行必须如实标注，不得只写“测试通过”。
- 交付口径：以 PLAN-APPROVED.md 的验收方案与 SPEC.md 的技术实现规格为依据进行功能开发与测试用例编写；每条 AC 自测通过才算完成，自测未通过或未执行不得请求验收、不得标记交付，也不得触发提交/合并（squad_deliver 与收尾提交都必须以自测全部通过为前提）。
- 并行默认：实现工作包含多个独立文件/模块时，默认用你自己的子代理/并行能力同时开发；不独立的部分串行完成。边界不变：只改规格内文件、逐条 AC 留证、汇总写 REPORT.md。
- 返工派单仍是在同一段对话里：逐条修复验收提出的编号缺陷，重跑完整相关测试，再次报告。`

const LEAD_POLICY = `Agent Squad 已启用：你是 Lead，小队里有按角色分工的队友（brain=业务+技术设计与双验收，tester=测试验收者，worker=执行者）。小队有两种调用模式：**研发模式**（默认，squad_start 不传 mode 即是；完整设计→开发→验收流程，下述第 1–13 步）与**验收模式**（squad_start 传 mode="acceptance" 与 authority 权威方案；不做设计，以权威方案为准做双维度验收并交付验收报告，见文末「验收模式流程」）。

完整流程（新代码任务默认：先业务方案、再技术规格、后实现与双验收）：
1. 调用 squad_start 一次，写入目标与验收标准（验收标准确实含糊时先问用户）。非代码任务可在创建时传 flow="simple" 走简化流程。
2. 派 brain，phase="design"：写业务方案 PLAN.md。
3. Lead 亲自审核 PLAN.md：假装自己是没有上下文的架构师，无法只靠 PLAN 拍板技术设计的点按 D1 起连续编号，写明章节、缺失或矛盾、最小补全要求，派回 brain（phase="design"）返工迭代，默认初始设计 + ${MAX_DESIGN_REWORK_ROUNDS} 轮返工 = ${MAX_PLAN_ROUNDS} 次 design 派单，未扩展时第 ${MAX_PLAN_ROUNDS + 1} 次暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派 design；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。
4. 方案合格后调用 squad_approve_plan 批准（归档 PLAN-APPROVED.md）。有 brain 参与的任务，PLAN 未批准前 implement/rework/spec 派单会被拒绝；没有 brain 参与的任务豁免此门禁。
5. 派 brain，phase="spec"：读取 PLAN-APPROVED.md，发布技术规格 SPEC.md（代码结构、文件与模块职责、表与迁移、领域模型、接口与错误行为、各模块实现、可执行验证用例；不适用的明确说明）。技术设计与技术规格由 brain 负责。规格可多轮修订、不占返工额度；发布后即可派工，不需要 Lead 再审批。
6. 派 worker，phase="implement"：worker 固定为 worker1 / worker2 / front1 三名。后端任务**优先派 worker1**（主力后端），worker1 不可用时改派**备份 worker2**；front1 固定做前端（页面交互设计、实现与自测），不做后端。都按 PLAN-APPROVED.md + SPEC.md 实现并自测，自测全部通过才交付，写 REPORT.md。其他角色默认不作为 worker（如确需 brain/gpt 或你自己接手实现，须经用户同意并显式开启该成员的 worker 能力）；实现过代码的角色不能签署自己实现的技术验收。
6.1 阶段化并行（强制）：拆分任务时把**通用/底层功能排在前面、串行开发**（一次只派一个 worker，不要同时派多个）；基础层完成后走技术+业务验收，再调用 **squad_deliver** 把基础层合并到 Base 分支（"当前项目所在分支"）。只有基础层交付后，才允许 **squad_parallel_start({ features: [...] })** 基于 Base 为每个业务特性拉独立 worktree/分支，并用 squad_dispatch({ …, feature: "<name>" }) 分派给多个 worker 并行开发；每个特性完成后 **squad_deliver({ feature: "<name>" })** 直接合入 Base。全部特性合并后，在 Base 分支上重新跑技术/业务验收（验收需对合并后的代码新鲜），再 squad_finish 收尾。**两层并行是默认运行方式**：① 小队层——external 执行者的 implement/rework 默认后台派发（不阻塞，结果完成时以消息送达），连续派多个 worker 并行跑（如 worker1 后端 + front1 前端同时）；需要在本回合同步拿结果时才传 background: false；② worker 层——派单消息把可并行的独立文件/模块逐项列出，worker 默认用自己的子代理同时开发（只改规格内文件、逐条 AC 留证）。
7. 派 tester，phase="test-review"：测试验收——tester 依据 brain 的 SPEC.md（技术实现规格）与 PLAN-APPROVED.md（验收方案）审核 worker 的测试用例是否合格；不合格由 tester 补充测试用例并进行完整测试，写 TEST-REVIEW.md（最后一行 VERDICT）。
8. 测试验收 changes_requested → 把编号缺陷派回对应 worker，phase="rework"（计入技术返工额度）；返工后测试验收失效，需重走 test-review。
9. 测试验收 approved → 派 brain，phase="tech-review"：技术验收（代码审查 + 亲自运行验证测试，写 TECH-REVIEW.md）。若 brain 本任务写过代码，tech-review 改派 tester 代签。
10. 技术验收 changes_requested → 把编号缺陷派回对应 worker，phase="rework"（技术返工额度 ${MAX_TECH_REWORK_ROUNDS} 轮，前后端共享、不因换人或规格修订重置；未扩展时第 4 轮暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="tech", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派）。
11. 技术验收 approved → 派 brain，phase="review"：业务验收，写 REVIEW.md。
12. 业务验收 changes_requested → phase="rework"（业务返工额度 ${MAX_BUSINESS_REWORK_ROUNDS} 轮，与技术额度独立计数；业务返工改了代码后必须重新通过测试验收与技术验收，再重新业务验收）。
13. 两份验收都 approved 且仍然新鲜（代码/规格未再变动）→ squad_finish 收尾，随后向用户汇总交付结果。

规则：
- 你是组织者，默认不写业务代码；自己的改动只限协调文件与最终整合。若设置里开启了 Lead 的 worker 能力（leaderWorker），你可以直接作为 worker 实现代码并与队友并行，但仍不得签署自己实现的验收，业务方案/技术规格照常走流程。
- 三种批准相互独立：squad_approve_plan 批准的是「业务方案」，TECH-REVIEW.md 的 VERDICT: APPROVED 批准的是「技术」，REVIEW.md 的 VERDICT: APPROVED 批准的是「业务」；任何一个不能替代另一个。代码、规格或方案变动后旧结论失效，不能用旧批准收尾。
- worker 选人与替补：后端任务优先派 worker1（主力后端）；worker1 不可用（挂起/额度类错误）时插件自动改派、或由你手动改派备份 worker2（DeepSeek V4.1 Flash，max 思考强度，可续跑）。front1 固定前端（页面交互设计、实现与自测），不承接后端任务。${MAX_TECH_REWORK_ROUNDS} 轮技术返工仍未通过时先问用户是否继续，获准继续后可派 tester 接手实现（须先显式开启其 worker 能力），不需要再次确认选人。tester 接手写代码后，技术验收仍由 brain（未写代码时）签署；若 brain 也写过代码，两份验收按代签规则交叉签署，实现者不签自己的验收。
- 一个角色一个 agent。worker 固定为三名：worker1（主力后端）、worker2（备份后端）、front1（固定前端）；tester 是测试验收者（tester），不默认写实现代码。
- 执行效率纪律：${EXECUTION_DISCIPLINE}
- 临时辅助队员纪律：任务进行中禁止自行添加计划外临时辅助队员 aux（包括用内置 subagent/subagent_* 创建计划外子代理、fork/spawn 临时成员，或让普通子代理承担小队成员职责/验收）。确实需要额外人手时，必须先用 ask_user_question 向用户说明原因、人数与工作范围并取得明确同意；获准后应优先使用已配置的 team 模式成员（executor="team"）；确需新增成员时也必须把新成员配置为 team 模式，不得以一次性 aux 绕过小队编制。未获同意不得添加。
- 每次派单后结束当前回合，等队友的 squad_report 唤醒你；查看状态用 squad_status，只有必须在本回合阻塞时才用 squad_wait。
- 信息同步：插件在每个派单、squad_approve_plan、squad_parallel_start、squad_deliver、squad_finish 以及收到 squad_report 时自动刷新 PROGRESS.md；squad_status 顶部即分层进度（任务总览→阶段进度→队员进度→并行特性）。每个阶段完成、收到关键报告、交付与收尾时，用最新分层进度向用户简报一次（不要只报"进行中"）。
- 不阻塞主会话：所有 external 派单（含 brain 的 design/spec/tech-review/review、tester 的 test-review）默认**后台派发**，工具立即返回、结束本回合，结果以后台消息送达后再继续；不要用 squad_wait 干等。需要在本回合同步拿结果时才传 background: false。后台任务仍在跑时 squad_approve_plan / squad_deliver / squad_finish 会拒绝并提示等待，这是正常的。
- 队友在跑时不得声称完成；没有双验收不得接受结果。
- 技术返工与业务返工各自默认最多 3 轮、独立计数、互不重置。任一到上限就暂停派单，先向用户说明阻塞点与已完成部分并等待决策；仅用户明确同意后调用 squad_extend(kind="tech"/"business", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派单，每次扩展都要重新确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。
- 外部 provider（agent 配置里 provider 非空且不是 spawn/fork）走一次性派发：squad_dispatch 阻塞到它返回并把结果直接给你；它不会 squad_report，也不能续跑。返工=再派一次，必须重发 BRIEF 与编号缺陷。
- 外部 agent 不共享你的会话上下文，只读共享文件；派单靠路径和编号，不要假设它记得上一轮。
- 默认在 worktree 分支开发：squad_start 会创建新分支并切过去；不要在源 checkout 上直接改业务代码。
- 收尾：双验收 approved 后调用 squad_finish（提交 worktree 改动、切回源目录、给出分支与合并命令）。
- 队友共享你的工作目录与 .agent-squad 记忆，不要重复他们的工作。
- 测试者容错：tester 因额度耗尽不可用时（派单报出额度类错误或队友上报额度耗尽），插件会自动挂起 tester 并提示改派；测试验收职责（TEST-REVIEW.md）由 brain 代行完成剩下的任务。也可手动 squad_failover({ agent: "tester", reason: "原因" }) 挂起。挂起期间派 tester 会被拒绝；用户确认额度恢复后调用 squad_failover({ agent: "tester", recover: true }) 交还职责。
- worker 可用性门禁：每次 implement/rework 派单前插件会自动做一轮轻量可用性探测（同一任务同一 worker 探测成功即缓存；dispatch 传 probe:true 强制重探、probe:false 跳过）。若探测返回额度类错误（limit/quota/429/余额…），插件立即把该 worker 记为不可用、自动改派另一个可用 worker 执行本轮，并在派单反馈里明示"谁不可用、原因、改由谁执行"；此后的派单也会自动绕开它。用户确认额度恢复后 squad_failover({ agent: "<name>", recover: true }) 解除。

验收模式流程（mode="acceptance"，适用于对既有实现按指定权威方案做验收）：
A1. squad_start 传 mode="acceptance"、goal、authority（权威方案的文件路径或全文）；方案会固化为 AUTHORITY.md，brain 不再产出设计，design/spec/implement 等研发阶段被拒绝。
A2. 派 tester，phase="acceptance"：技术维度验收（亲自运行测试/构建、逐项核对方案一致性；第 2 轮起先核对上一轮编号问题的修复情况）。
A3. 派 brain，phase="acceptance"：业务维度验收并定稿 ACCEPTANCE-REPORT.md——五要素齐全：① 验收方案与标准（从 AUTHORITY.md 推导）② 上一轮验收报告修复情况 ③ 本轮发现的问题（编号/维度/证据/严重度）④ 修复建议 ⑤ 结论（最后一行 VERDICT: APPROVED 或 CHANGES_REQUESTED）。顺序强制：先 tester 后 brain。
A4. VERDICT=CHANGES_REQUESTED → 把编号问题与修复建议以 phase="rework" 派给 worker 修复（后端优先 worker1，备份 worker2；前端 front1；计入验收返工预算，默认 3 轮，扩展同 squad_extend(kind="tech", …) 规则）；修复使本轮验收失效，重走 A2→A3。
A5. VERDICT=APPROVED 且仍然新鲜 → squad_finish 收尾，向用户交付验收报告。
A6. 验收模式中你和队友都不改权威方案；方案有矛盾或缺失时停下来转用户决策。
- 面向用户的回复必须使用用户所用的语言（用户用中文就用中文）；角色章程的语言不影响你回复用户的语言。`

const DEFAULT_AGENTS = [
  {
    name: 'brain',
    role: 'brain',
    description: '业务设计与验收：给出业务方案、对外行为与验收标准，并做业务验收。',
    provider: '',
    context: 'fresh',
    charter: '',
  },
  {
    name: 'tester',
    role: 'tester',
    description: '测试验收者：依据 brain 的技术实现规格与验收方案审核 worker 的测试用例，不合格时补充测试用例并完整测试（默认不参与实现）。',
    provider: '',
    model: 'openai/gpt-6.2-sol',
    context: 'fresh',
    charter: '',
  },
  {
    name: 'worker1',
    role: 'worker',
    description: '主力后端 worker：后端任务优先派发；实现后端代码并自测，自测通过后才交付。',
    provider: '',
    context: 'fresh',
    charter: `主力后端执行者分工：
- 后端任务的第一人选：任务优先派发给你；你不可用时由备份 worker2 接手。
- 负责后端/服务端代码的实现：业务逻辑、API、数据层、脚本与配置。
- 负责后端测试：单元测试、集成测试与回归验证，逐条 AC 留证；自测全部通过后才交付。
- 边界：不承担前端页面/样式/交互改动；发现前端问题转交 front1，不代改。`,
  },
  {
    name: 'worker2',
    role: 'worker',
    description: '备份后端 worker：worker1 不可用时接手后端实现与自测（OpenCode Go DeepSeek V4.1 Flash，max，可续跑）。',
    provider: '',
    model: 'dsh-opencode-go/deepseek-v4.1-flash',
    context: 'fresh',
    charter: `备份后端执行者分工：
- worker1 的备份：worker1 不可用（挂起/额度）时接手后端任务；平时与 worker1 同标准开发。
- 负责后端/服务端代码的实现：业务逻辑、API、数据层、脚本与配置。
- 负责后端测试：单元测试、集成测试与回归验证，逐条 AC 留证；自测全部通过后才交付。
- 边界：不承担前端页面/样式/交互改动；发现前端问题转交 front1，不代改。`,
  },
  {
    name: 'front1',
    role: 'worker',
    description: '前端 worker：固定负责前端页面交互设计、实现与自测（不做后端）。',
    provider: '',
    context: 'fresh',
    charter: `前端执行者分工：
- 固定前端：负责前端页面的交互设计、实现与自测——页面、样式、交互与前端状态，并编写/运行 UI 与组件测试、构建验证；自测全部通过后才交付。
- 边界：不承担后端代码（接口/脚本/数据层）的实现；涉及接口契约的跨端问题报告 Lead 协调，不擅自改契约。`,
  },
]

/** Quota-exhaustion signatures that auto-suspend a tester (failover). */
const QUOTA_ERROR = /额度|余额|欠费|限流|quota|insufficient|balance|exceeded|429|rate.?limit/i

/** Build a registry-ready tool definition from a JSON-Schema parameter object. */
function defineTool(definition) {
  return definition
}

/** True when `value` is a plain, non-array configuration object. */
function isPolicyObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve and strictly validate the opt-in context policy (S1).
 *
 * Returns `false` for the explicit compatibility switch, otherwise a detached
 * object with all four fields filled. Omitted fields take the 0.86/16384/true
 * defaults; explicit `null` maxOutputTokens survives as "no request cap".
 * Validation is by original type — no Number()/truthiness coercion.
 *
 * @param {unknown} value raw `contextPolicy` input.
 * @returns {false | {thresholdRatio: number, maxOutputTokens: number|null, autoCompact: boolean, showUsage: boolean}}
 * @throws {TypeError} with the full field path for an invalid field.
 */
function resolveContextPolicy(value) {
  if (value === false) return false
  const input = value === undefined ? {} : value
  if (!isPolicyObject(input)) throw new TypeError('contextPolicy 必须是对象或 false')
  for (const key of Object.keys(input)) {
    if (!CONTEXT_POLICY_KEYS.has(key)) throw new TypeError(`contextPolicy.${key} 未知字段`)
  }
  let thresholdRatio = CONTEXT_POLICY_DEFAULTS.thresholdRatio
  if (Object.hasOwn(input, 'thresholdRatio')) {
    const ratio = input.thresholdRatio
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0.12 || ratio > 1) {
      throw new TypeError('contextPolicy.thresholdRatio 必须是 (0.12,1] 的有限数')
    }
    thresholdRatio = ratio
  }
  let maxOutputTokens = CONTEXT_POLICY_DEFAULTS.maxOutputTokens
  if (Object.hasOwn(input, 'maxOutputTokens')) {
    const cap = input.maxOutputTokens
    if (cap !== null && !(Number.isSafeInteger(cap) && cap > 0)) {
      throw new TypeError('contextPolicy.maxOutputTokens 必须是正安全整数或 null')
    }
    maxOutputTokens = cap
  }
  let autoCompact = CONTEXT_POLICY_DEFAULTS.autoCompact
  if (Object.hasOwn(input, 'autoCompact')) {
    if (typeof input.autoCompact !== 'boolean') {
      throw new TypeError('contextPolicy.autoCompact 必须是布尔值')
    }
    autoCompact = input.autoCompact
  }
  let showUsage = CONTEXT_POLICY_DEFAULTS.showUsage
  if (Object.hasOwn(input, 'showUsage')) {
    if (typeof input.showUsage !== 'boolean') {
      throw new TypeError('contextPolicy.showUsage 必须是布尔值')
    }
    showUsage = input.showUsage
  }
  return { thresholdRatio, maxOutputTokens, autoCompact, showUsage }
}

/** Request output cap for a child session (S3); undefined means "not injected". */
function requestCap(policy, parent) {
  if (!policy || policy === false || policy.maxOutputTokens === null) return undefined
  const parentCap = parent?.options?.maxTokens
  if (Number.isSafeInteger(parentCap) && parentCap > 0) {
    return Math.min(parentCap, policy.maxOutputTokens)
  }
  return policy.maxOutputTokens
}

/**
 * Compose the `agentOptions` payload for one activation (S3).
 *
 * Pinned local/external-probe routes keep provider/model/reasoningEffort and
 * add the capped output budget; a team `spawn` adds only `maxTokens` (the host
 * still inherits the route); a team `fork` adds it only when the host reports
 * `capabilities.agentOptions`, otherwise the whole payload is omitted.
 * Non-pinned external CLI/ACP executors receive no options at all.
 *
 * @param {object} input activation facts.
 * @returns {{agentOptions?: object}} spreadable activation field.
 */
function activationOptions({ policy, parent, executor, pinned, reasoning, provider, subagents }) {
  if (executor === 'external' && !pinned) return {}
  const cap = policy ? requestCap(policy, parent) : undefined
  const options = {}
  if (pinned) {
    options.provider = pinned.provider
    options.model = pinned.model
    if (reasoning) options.reasoningEffort = reasoning
    if (cap !== undefined) options.maxTokens = cap
  } else if (provider === 'spawn' || provider === 'fork') {
    if (cap === undefined) return {}
    if (provider === 'fork') {
      let supported = false
      try {
        supported = subagents?.getProvider?.('fork')?.capabilities?.agentOptions === true
      } catch {
        supported = false
      }
      if (!supported) return {}
    }
    options.maxTokens = cap
  } else {
    return {}
  }
  return Object.keys(options).length > 0 ? { agentOptions: options } : {}
}

/** Normalize the patch-row config, applying defaults without a schema dependency. */
function resolveSettings(input) {
  const config = input && typeof input === 'object' ? input : {}
  const text = (value, fallback) =>
    typeof value === 'string' && value.trim() !== '' ? value : fallback
  const agents =
    Array.isArray(config.agents) && config.agents.length > 0 ? config.agents : DEFAULT_AGENTS
  return {
    memoryDir: text(config.memoryDir, DEFAULT_MEMORY_DIR),
    brainCharter: text(config.brainCharter, BRAIN_CHARTER),
    testerCharter: text(config.testerCharter, TESTER_CHARTER),
    workerCharter: text(config.workerCharter, WORKER_CHARTER),
    agents,
    contextPolicy: resolveContextPolicy(config.contextPolicy),
    worktreeDir: text(config.worktreeDir, '.agents/worktrees'),
    workerProbe: config.workerProbe !== false,
    /** How long a successful availability probe is reused (profile-wide). */
    probeTtlMs: Number.isFinite(Number(config.probeTtlMs)) ? Number(config.probeTtlMs) : 600000,
    worktreeFrom: text(config.worktreeFrom, 'HEAD'),
    worktreeAutoCommit: config.worktreeAutoCommit !== false,
    qoderCommand: text(config.qoderCommand, 'qoderclicn'),
    qoderPermissionMode: text(config.qoderPermissionMode, 'accept_edits'),
    /** Extra dirs a headless qoder run may read (toolchain + dependency caches). */
    qoderAddDirs: Array.isArray(config.qoderAddDirs)
      ? config.qoderAddDirs.map(String).filter((dir) => dir !== '')
      : undefined,
    /** Command patterns auto-approved for a headless qoder run. */
    qoderAllowedTools: Array.isArray(config.qoderAllowedTools)
      ? config.qoderAllowedTools.map(String).filter((tool) => tool !== '')
      : undefined,
    qoderModel: text(config.qoderModel, ''),
    codexCommand: text(config.codexCommand, 'codex'),
    codexModel: text(config.codexModel, 'gpt-6.2-astra'),
    codexReasoningEffort: text(config.codexReasoningEffort, 'xhigh'),
    codexSandboxMode: text(config.codexSandboxMode, 'workspace-write'),
  }
}

/**
 * Map one settings-file agent to the runtime dispatch shape: the fixed id
 * stays the internal key, displayName is display-only, and the bundle rows
 * keep contributing per-agent charters.
 */
function runtimeAgent(settingsAgent, config) {
  const bundle =
    configuredAgents({ agents: config.agents }).find((row) => row.name === settingsAgent.id) ?? {}
  return {
    name: settingsAgent.id,
    displayName: settingsAgent.displayName || settingsAgent.id,
    role: settingsAgent.role,
    description: settingsAgent.description ?? '',
    executor: settingsAgent.executor,
    model: settingsAgent.model ?? '',
    reasoning: ['low', 'high', 'xhigh', 'max'].includes(settingsAgent.reasoning)
      ? settingsAgent.reasoning
      : '',
    // Worker capability: fixed to the worker-role members (zcode/opencode/
    // qoder) by default; brain and tester implement only via an explicit
    // worker: true (and the Lead via leaderWorker).
    worker:
      typeof settingsAgent.worker === 'boolean'
        ? settingsAgent.worker
        : settingsAgent.role === 'worker',
    context: bundle.context === 'fork' ? 'fork' : 'fresh',
    charter: bundle.charter ?? '',
  }
}

/** Full roster for one settings snapshot, in fixed id order. */
function settingsRoster(settings, config) {
  return settings.agents.map((agent) => runtimeAgent(agent, config))
}

/** Read the calling agent, which scoped tool discovery guarantees for these tools. */
function callingAgent(exec, toolName) {
  if (!exec.agent) throw new Error(`${toolName} requires a calling agent`)
  return exec.agent
}

/**
 * Live child rows of the Lead's subagent tree (replaces the removed
 * `agentTeams.listMembers`). Rows are `kind: 'child'` catalog entries with an
 * `activity` of 'running' | 'inactive'; a child absent from the catalog is
 * cold. Failures degrade to an empty list rather than failing the tool.
 */
async function treeRowsOf(ctx, lead, signal) {
  const subagents = ctx.get('subagents')
  if (!subagents || typeof subagents.listDescendants !== 'function') return []
  try {
    const rows = await subagents.listDescendants(lead.id, signal)
    return rows.filter((row) => row.kind === 'child')
  } catch {
    return []
  }
}

/** Running check for one child id against fetched tree rows. */
function isRowRunning(rows, childId) {
  const row = rows.find((entry) => entry.id === childId)
  return row !== undefined && row.activity === 'running'
}

/** Enrich tree rows into member-like rows for display (name/role/status). */
function memberRowsOf(rows, runtime, config) {
  // Display filter: keep rows this squad owns — anything running, rows with a
  // dispatch binding, and rows named after a roster agent. Cold children from
  // earlier plugin generations (label-only rows like `t-x/implement/zcode`)
  // stay hidden from the member list; finish/wait gates read the raw rows.
  const roster = configuredAgents(config)
  return rows
    .filter((row) => {
      if (row.activity === 'running') return true
      if (runtime.bindingOf(row.id) !== undefined) return true
      return row.name !== undefined && roster.some((agent) => agent.name === row.name)
    })
    .map((row) => {
      const name = row.name ?? row.label ?? String(row.id)
      const binding = runtime.bindingOf(row.id)
      const configured = binding ?? roster.find((agent) => agent.name === name)
      return {
        id: row.id,
        name,
        role: configured?.role ?? 'teammate',
        description: configured?.description,
        status: row.activity === 'running' ? 'running' : 'inactive',
      }
    })
}

/** Resolve the workspace directory visible to one session. */
function sessionDirectory(ctx, agent) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory && agent.session) return workingDirectory.get(agent.session)
  return process.cwd()
}

/** Run one reader, degrading any throw to a fallback (S6: each read catches alone). */
function safeRead(read, fallback) {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** A usable `provider/model` route pair, or undefined when either side is blank. */
function routePair(config) {
  if (
    typeof config?.provider === 'string' &&
    config.provider !== '' &&
    typeof config?.model === 'string' &&
    config.model !== ''
  ) {
    return `${config.provider}/${config.model}`
  }
  return undefined
}

/**
 * One lightweight context-usage reading (S6).
 *
 * `new`/`external`/`cold` short-circuit without touching an Agent; `last`
 * replays a report-time snapshot; `live` reads the session header, the
 * tokenMeter pressure/measurement pair and the resolved compaction policy to
 * report the configured threshold and, when provable, the effective one.
 *
 * @param {object} ctx host context.
 * @param {{agent?: object, binding?: object, policy?: object|false, kind?: string, snapshot?: object}} input
 * @returns {{model?: string, window?: number, used?: number, threshold: number, kind: string, effectiveTokens?: number, warning?: string}}
 */
function contextUsageOf(ctx, { agent, binding, policy, kind = 'live', snapshot } = {}) {
  const threshold =
    policy && policy !== false && Number.isFinite(policy.thresholdRatio)
      ? policy.thresholdRatio
      : CONTEXT_POLICY_DEFAULTS.thresholdRatio
  if (kind === 'new' || kind === 'external' || kind === 'cold') return { threshold, kind }
  if (kind === 'last') {
    return snapshot
      ? { ...snapshot, threshold, kind }
      : { threshold, kind }
  }
  const session = safeRead(() => agent?.session, undefined)
  const header = session ? safeRead(() => session.requestHeader?.(), undefined) : undefined
  // Independent read (TR-06): a failing header/config getter only degrades the
  // model/threshold fields, never window/used/ratio or the whole tool.
  const headerConfig = safeRead(
    () => (header && typeof header.config === 'object' ? header.config : undefined),
    undefined,
  )
  let model = 'unknown'
  const headerRoute = safeRead(() => routePair(headerConfig), undefined)
  if (headerRoute !== undefined) {
    model = headerRoute
  } else {
    const optionRoute = safeRead(
      () => routePair(safeRead(() => agent?.options, undefined)),
      undefined,
    )
    if (optionRoute !== undefined) model = optionRoute
    else if (typeof binding?.model === 'string' && binding.model.includes('/')) model = binding.model
  }
  // TR-07: every meter accessor, call and result-field read is independently
  // protected, and calls keep their receiver. A throwing optional getter only
  // drops its own field; report/status/resume never lose the whole line.
  const meter = safeRead(() => ctx.get('tokenMeter'), undefined)
  const pressureReader =
    meter === undefined ? undefined : safeRead(() => meter.contextPressure, undefined)
  const measurementReader =
    meter === undefined ? undefined : safeRead(() => meter.measure, undefined)
  const pressure =
    session && typeof pressureReader === 'function'
      ? safeRead(() => pressureReader.call(meter, session), undefined)
      : undefined
  const measurement =
    session && typeof measurementReader === 'function'
      ? safeRead(() => measurementReader.call(meter, session), undefined)
      : undefined
  let window
  const contextWindow = safeRead(() => pressure?.contextWindow, undefined)
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) window = contextWindow
  let used
  const totalTokens = safeRead(() => measurement?.totalTokens, undefined)
  if (Number.isSafeInteger(totalTokens) && totalTokens >= 0) {
    used = totalTokens
  } else {
    const pressureTokens = safeRead(() => pressure?.pressureTokens, undefined)
    if (Number.isSafeInteger(pressureTokens) && pressureTokens >= 0) used = pressureTokens
  }
  const usage = {
    threshold,
    kind,
    ...(model === 'unknown' ? {} : { model }),
    ...(window === undefined ? {} : { window }),
    ...(used === undefined ? {} : { used }),
  }
  // TECH-05: service-missing and threshold diagnostics are independent; one
  // must not overwrite the other. The normal sample stays byte-identical when
  // both are clean.
  const warnings = []
  if (meter === undefined) warnings.push('（tokenMeter 不可用）')
  // Effective threshold: only claim it when the routed route, window and the
  // durable request output reservation are all provable (S2/S6). Every getter
  // is read independently (TR-06); a throwing compaction config only loses the
  // effective-threshold detail.
  if (model !== 'unknown') {
    const effective = safeRead(
      () => effectiveThresholdOf(ctx, { model, headerConfig, window, threshold }),
      { warning: '（实际阈值未知）' },
    )
    if (effective.effectiveTokens !== undefined) usage.effectiveTokens = effective.effectiveTokens
    else if (effective.warning) warnings.push(effective.warning)
  }
  if (warnings.length > 0) usage.warning = warnings.join('')
  return usage
}

/**
 * Compute the host's effective pressure threshold for one exact route (S6.3).
 *
 * Reads the resolved compaction config and its `modelPolicies` independently;
 * retention follows the host rule — row `retainTokens`, else row `retainRatio`,
 * else the global `retainTokens`, else the global `retainRatio` — so an
 * inherited exact retention that is not below T reports an unavailable
 * retention instead of an incorrect effective threshold (TR-05).
 *
 * @param {object} ctx host context.
 * @param {{model: string, headerConfig?: object, window?: number, threshold: number}} input
 * @returns {{effectiveTokens?: number, warning?: string}}
 */
function effectiveThresholdOf(ctx, { model, headerConfig, window, threshold }) {
  const basic = safeRead(() => ctx.get('compaction'), undefined)
  const resolved = safeRead(() => {
    const config = basic?.config
    return config && typeof config === 'object' && !Array.isArray(config) ? config : undefined
  }, undefined)
  if (resolved === undefined) return { warning: '（compaction 不可用；实际阈值未知）' }
  const rows = safeRead(
    () => (Array.isArray(resolved.modelPolicies) ? resolved.modelPolicies : []),
    [],
  )
  const row = rows.find(
    (item) =>
      item &&
      typeof item.provider === 'string' &&
      typeof item.model === 'string' &&
      `${item.provider}/${item.model}` === model,
  )
  if (row === undefined) return { warning: '（无精确模型策略；实际阈值未知）' }
  // TECH-05: read the provable native ratio before deciding whether T can be
  // computed, so a known differing native ratio is still reported.
  const ratio = safeRead(() => row.thresholdRatio ?? resolved.thresholdRatio, undefined)
  const headroom = safeRead(() => row.headroomTokens ?? resolved.headroomTokens, undefined)
  const ratioKnown = Number.isFinite(ratio) && ratio > 0
  const unknownReason = (detail) =>
    ratioKnown && ratio !== threshold
      ? `（原生比例=${ratio}；实际阈值未知）`
      : `（${detail}；实际阈值未知）`
  if (window === undefined) return { warning: unknownReason('窗口未知') }
  const headerO = safeRead(() => headerConfig?.maxTokens, undefined)
  const hasO = Number.isSafeInteger(headerO) && headerO >= 0
  if (!hasO) return { warning: unknownReason('实际阈值未知') }
  const messageBudget = window - headerO
  const pressureBudget = messageBudget - headroom
  const headroomKnown = Number.isFinite(headroom) && headroom >= 0
  if (messageBudget <= 0) return { warning: unknownReason('窗口压力预算不足') }
  if (!ratioKnown || !headroomKnown) return { warning: '（模型策略不完整；实际阈值未知）' }
  if (pressureBudget <= 0) return { warning: unknownReason('headroom 超出窗口') }
  const retain = safeRead(() => {
    if (row.retainTokens !== undefined) return row.retainTokens
    if (row.retainRatio !== undefined) return Math.floor(messageBudget * row.retainRatio)
    if (resolved.retainTokens !== undefined) return resolved.retainTokens
    return Math.floor(messageBudget * resolved.retainRatio)
  }, undefined)
  const effective = Math.floor(Math.min(window * ratio, pressureBudget))
  const target = Math.floor(window * threshold)
  if (!Number.isFinite(retain) || retain >= effective) {
    // Keep the retention-specific diagnosis (S6/S5 wording) while still
    // surfacing a provable differing native ratio (TECH-05).
    return {
      warning:
        ratioKnown && ratio !== threshold
          ? `（保留量不可用；原生比例=${ratio}；实际阈值未知）`
          : '（保留量不可用；实际阈值未知）',
    }
  }
  if (ratio !== threshold || effective < target) return { effectiveTokens: effective }
  return {}
}

/** Render one usage reading in the fixed S6 field order. */
function formatContextUsage(usage) {
  const model = usage?.model ?? 'unknown'
  const window = usage?.window === undefined ? 'unknown' : String(usage.window)
  const used = usage?.used === undefined ? 'unknown' : String(usage.used)
  const ratio =
    usage?.window !== undefined && usage?.used !== undefined
      ? `${((100 * usage.used) / usage.window).toFixed(1)}%`
      : 'unknown'
  const threshold = usage?.threshold ?? CONTEXT_POLICY_DEFAULTS.thresholdRatio
  let line = `context: model=${model} window=${window} used=${used} ratio=${ratio} threshold=${threshold}`
  if (usage?.kind === 'new') line += '（新建/暂无用量）'
  else if (usage?.kind === 'external') line += '（external）'
  else if (usage?.kind === 'cold') line += '（cold）'
  else if (usage?.kind === 'last') line += '（上次汇报）'
  if (usage?.effectiveTokens !== undefined) line += ` 实际阈值=${usage.effectiveTokens} tokens`
  else if (usage?.warning) line += usage.warning
  return line
}

/** Pack the small report-time snapshot the status/dispatch fallbacks replay. */
function usageSnapshotOf(usage) {
  return {
    ...(usage?.model === undefined ? {} : { model: usage.model }),
    ...(usage?.window === undefined ? {} : { window: usage.window }),
    ...(usage?.used === undefined ? {} : { used: usage.used }),
    ...(usage?.effectiveTokens === undefined ? {} : { effectiveTokens: usage.effectiveTokens }),
    ...(usage?.warning === undefined ? {} : { warning: usage.warning }),
  }
}


/**
 * Shared-memory root for one agent. The pointer file makes the root stable when
 * the session moves into a squad task root (multi-repository tasks) or a
 * worktree: the checkout keeps a pointer back to the task-root memory
 * directory, so every member resolves the same shared memory.
 */
async function memoryDirectory(ctx, agent, config) {
  const base = config.memoryDir || DEFAULT_MEMORY_DIR
  const cwd = sessionDirectory(ctx, agent)
  const pointer = await readJson(join(cwd, base, 'current.json'))
  if (pointer?.memoryRoot) return pointer.memoryRoot
  return resolve(cwd, base)
}

/**
 * Every repository row of a STATE, in input order: new multi-repository
 * tasks carry `worktrees`; single-repository and legacy states fall back to
 * the `worktree` object (with `repo` defaulted); in-place tasks give [].
 */
function worktreesOf(state) {
  if (Array.isArray(state.worktrees)) return state.worktrees
  if (state.worktree) return [{ ...state.worktree, repo: state.worktree.repositoryRoot }]
  return []
}

/** Working cwd for a task: task root, else worktree, else the fallback. */
function workspaceOf(state, fallback) {
  return state.taskRoot ?? state.worktree?.path ?? fallback
}

/** A memoryDir usable for multi-repository task roots (relative, no escape). */
function memoryDirectorySafe(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return false
  const normalized = dir.replace(/\\/g, '/')
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes('\0')
  ) {
    return false
  }
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return normalized !== '.git' && !normalized.startsWith('.git/')
}

/** POSIX single-quote wrap so copy-paste commands survive spaces (PLAN §29). */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Create the memory directory and keep it out of git in both source and worktree. */
async function ensureSelfIgnore(directory) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, '.gitignore'), '*\n', 'utf8')
}

/** Run one git command in a directory and return stdout. */
async function git(directory, args) {
  const { stdout } = await runFile('git', ['-C', directory, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

/** Branch checked out in a source repository (null when detached). */
async function sourceBranchOf(repo) {
  try {
    const out = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return out === 'HEAD' || out === '' ? null : out
  } catch {
    return null
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Like readJson, but non-ENOENT I/O errors (e.g. EISDIR on a path squatting
 * on a file) propagate with their original code/message; only a missing file
 * (or unparseable content) reads as undefined. Used by squad_extend so a
 * broken filesystem is never misreported as a missing task.
 */
async function readJsonIoStrict(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === undefined) return undefined
    throw error
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').find((part) => part.trim() !== '')
  return (line ?? '').trim()
}

function clip(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function newTaskId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** Normalize the configured roster, ignoring malformed rows. */
function configuredAgents(config) {
  const seen = new Set()
  const agents = []
  for (const entry of config.agents ?? []) {
    const agentName = String(entry?.name ?? '').trim()
    if (!agentName || seen.has(agentName)) continue
    seen.add(agentName)
    agents.push({
      name: agentName,
      role: ['brain', 'tester', 'worker'].includes(entry.role) ? entry.role : 'worker',
      description: String(entry.description ?? ''),
      provider: String(entry.provider ?? ''),
      model: String(entry.model ?? ''),
      context: entry.context === 'fork' ? 'fork' : 'fresh',
      charter: String(entry.charter ?? ''),
    })
  }
  return agents
}

function charterFor(agent, config) {
  if (agent.charter) return agent.charter
  if (agent.role === 'brain') return config.brainCharter
  if (agent.role === 'tester') return config.testerCharter
  return config.workerCharter
}

function teammatePrompt(agent, config) {
  // TECH-04: `contextPolicy:false` restores the baseline identity section
  // byte-for-byte; the new discipline paragraph only appears when the policy
  // is enabled. S/E/M lines are identical in both modes.
  const sharedMemory =
    config.contextPolicy === false
      ? '共享记忆：每次派单都会给出共享目录。先读 TASK.md；PLAN.md、SPEC.md、TECH-REVIEW.md、REVIEW.md、REPORT.md、JOURNAL.md 分别承载业务方案、技术规格、技术验收、业务验收、交付证据与历史。保持这些文件最新，队友才能不靠复述对话协作。'
      : `共享记忆：每次派单都会给出共享目录。TASK.md、PLAN.md、SPEC.md、TECH-REVIEW.md、REVIEW.md、REPORT.md、JOURNAL.md 分别承载任务、业务方案、技术规格、技术验收、业务验收、交付证据与历史。保持这些文件最新，队友才能不靠复述对话协作。
上下文纪律：${CONTEXT_DISCIPLINE}
执行效率纪律：${EXECUTION_DISCIPLINE}`
  return `你是 "${agent.name}"，DSH Agent Squad 里的 ${agent.role} 角色。Team Lead 的代号是 "lead"。

${charterFor(agent, config)}

${sharedMemory}
- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。

- 临时辅助队员纪律：禁止自行创建小队级临时辅助队员 aux；确需额外人手时，在 squad_report 中报 blocked，说明原因、人数与工作范围，由 Lead 先取得用户明确同意后以 team 模式安排。worker 为并行开发使用自己的普通子代理不在此列，但不得命名为 aux、不得当作小队成员或让它签署验收。

汇报：任务完成、受阻或验收结束时，调用一次 squad_report，带上 status、简短总结和改动文件。Lead 会被这条报告唤醒。不要创建队友或重新分配工作。`
}

function repoLines(worktrees) {
  return worktrees.map(
    (wt) => `仓库：${wt.repo} | worktree：${wt.path} | 分支：${wt.branch} | 基线：${wt.baseCommit}`,
  )
}

/**
 * Resolve the acceptance-mode authority designation into task memory: an
 * existing file (absolute or session-relative) is copied verbatim; any other
 * non-empty text is the plan itself. Returns the STATE authority record.
 * @returns {Promise<{source: string, file: string} | undefined>}
 */
async function materializeAuthority({ authority, taskDir, sourceDirectory }) {
  const text = String(authority ?? '').trim()
  if (text === '') return undefined
  for (const candidate of [resolve(text), resolve(sourceDirectory, text)]) {
    const content = await readFile(candidate, 'utf8').then(
      (value) => `${value.trim()}\n`,
      () => null,
    )
    if (content !== null) {
      await writeFile(join(taskDir, 'AUTHORITY.md'), content, 'utf8')
      return { source: candidate, file: 'AUTHORITY.md' }
    }
  }
  await writeFile(join(taskDir, 'AUTHORITY.md'), `${text}\n`, 'utf8')
  return { source: 'inline', file: 'AUTHORITY.md' }
}

function renderTask({ taskId, goal, acceptance, constraints, participants, taskDir, worktree, worktrees = [], workspace, flowInfo }) {
  const members = participants
    .map((agent) => `| ${agent.displayName} (${agent.name}) | ${agent.role} | ${agent.executor}${agent.model ? ` · ${agent.model}` : ''} | ${clip(agent.description, 80) || '—'} |`)
    .join('\n')
  const effectiveWorkspace = workspace ?? worktree?.path
  let workspaceBlock
  if (worktrees.length > 1) {
    workspaceBlock = [
      `- 工作区（任务根）：\`${effectiveWorkspace}\``,
      ...repoLines(worktrees).map((line) => `- ${line}`),
      `- 每个仓库在任务根下各有一个 worktree；源 checkout 的未提交改动不会复制过去，所有改动只写在任务根里。`,
    ].join('\n')
  } else if (worktree) {
    workspaceBlock = `- worktree：\`${worktree.path}\`
- 分支：\`${worktree.branch}\`
- 源仓库：\`${worktree.repositoryRoot}\`
- 基线提交：\`${worktree.baseCommit}\`
- 源 checkout 的未提交改动不会复制到 worktree；所有改动只写在这个 worktree 里。`
  } else {
    workspaceBlock = '- 原地开发（未创建 worktree）。'
  }
  const full = flowInfo?.specRequired === true
  const acceptanceMode = flowInfo?.mode === 'acceptance'
  const protocol = acceptanceMode
    ? [
        '- 任何派单动手前先读本文件。',
        '- 流程（验收模式）：指定权威方案（AUTHORITY.md）→ tester 技术维度验收 → brain 业务维度验收 → 汇总 ACCEPTANCE-REPORT.md → （CHANGES_REQUESTED → worker 修复 → 下一轮验收）→ APPROVED → 收尾。插件强制门禁，不自动派发后续阶段。brain 不再产出设计：一切以 AUTHORITY.md 为准。',
        '- 权威方案：`AUTHORITY.md` 是本任务唯一权威方案（由创建任务时的 authority 指定，文件路径或全文）。验收标准从它推导，不得另行发明标准；方案本身有矛盾或缺失时，报 Lead 转用户决策，不猜测。',
        '- 双验收顺序（强制）：先派 `tester`（tester，phase="acceptance"）做技术维度验收，完成后才允许派 `brain`（brain，phase="acceptance"）做业务维度验收并定稿报告；两人顺序不可颠倒。',
        '- 验收报告 `ACCEPTANCE-REPORT.md` 五要素（缺一不可）：① 验收方案与标准（从 AUTHORITY.md 推导，逐条可执行）；② 上一轮验收报告修复情况（第 2 轮起，逐条核对 `ACCEPTANCE-REPORT-R<n-1>.md` 的问题编号：已修复/部分修复/未修复 + 证据）；③ 本轮发现的问题（编号、维度、证据、严重度）；④ 本轮发现问题的修复建议（逐条最小修复方案，供 worker 执行）；⑤ 结论（最后一行机器可读 `VERDICT: APPROVED` 或 `VERDICT: CHANGES_REQUESTED`）。',
        '- 修复由 worker 承担：CHANGES_REQUESTED 的编号问题与修复建议由 Lead 以 phase="rework" 派给 worker（后端优先 worker1，备份 worker2；前端 front1）；修复计入验收返工预算（默认 3 轮，未扩展时第 4 轮暂停：先向用户说明阻塞点并等待决策，用户同意后调用 squad_extend(kind="tech", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑）。修复使上一轮验收结论失效，需重走双验收。',
        '- 每一轮验收完成后报告归档为 `ACCEPTANCE-REPORT-R<n>.md`；下一轮验收必须先逐条核对上一轮的修复情况。',
        '- 每个成员在调用 `squad_report` 前，向 `JOURNAL.md` 追加一条简短记录。',
        `- 收尾需要最后一轮验收以 \`VERDICT: APPROVED\` 结束且仍然新鲜（修复未再改动代码）；Lead 在验收 approved 后调用 squad_finish。`,
        `- 记忆目录：\`${taskDir}\``,
      ].join('\n')
    : full
    ? [
        '- 任何派单动手前先读本文件。',
        '- 流程（完整）：brain 业务方案 → Lead 审核批准 → brain 技术规格 → worker 实现自测 → tester 测试验收 → brain 技术验收 → brain 业务验收 → 收尾。插件强制门禁，不自动派发后续阶段。',
        '- Lead 先审方案再实现：`brain` 写 `PLAN.md`（业务方案 + 编号验收标准）后由 Lead 审核并用 `squad_approve_plan` 批准（Lead 只批准**业务方案**，归档 `PLAN-APPROVED.md`）；设计问题须带编号缺陷再派 `phase="design"` 返工；默认初始设计 + 3 轮返工 = 4 次 design 派单，未扩展时第 5 次暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派 design；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。未批准前不派 implement/rework/spec（无 brain 任务豁免）。',
        '- `brain` 写 `SPEC.md`（技术规格：代码结构、模块职责、表与迁移、领域模型、接口与错误、验证用例；不适用处明确说明）。技术设计与技术规格由 brain 负责；规格有问题由 worker/tester 上报、brain 修订发布版本；单纯澄清不扣返工额度，也不重置已用额度；发布后即可派工，不需要 Lead 再审批。若必须改业务预期，暂停受影响工作，交给用户决策。',
        '- `worker` 写 `REPORT.md`（改动、执行的命令、测试证据）；worker1 主力后端（不可用改派备份 worker2），front1 固定前端（页面交互设计、实现与自测）。',
        '- 测试验收：`tester`（tester）依据 SPEC.md 与 PLAN-APPROVED.md 审核 worker 的测试用例是否合格；不合格由 tester 补充测试用例并进行完整测试，写 `TEST-REVIEW.md`（最后一行 `VERDICT: APPROVED` 或 `VERDICT: CHANGES_REQUESTED`）。技术验收前必须有一份仍然新鲜的 APPROVED 测试验收；返工使测试验收失效，需重走 test-review。',
        '- 技术验收：`brain` 对照当前 `SPEC.md` 做代码审查、亲自运行验证测试，写 `TECH-REVIEW.md`（最后一行 `VERDICT: APPROVED` 或 `VERDICT: CHANGES_REQUESTED`）；brain 本任务写过代码时由 `tester` 代签。技术返工默认 3 轮（前后端共享、不因换人或规格修订重置），未扩展时第 4 轮暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="tech", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。',
        '- 业务验收：`brain` 以 `PLAN-APPROVED.md` 为唯一业务规格写 `REVIEW.md`（最后一行 `VERDICT: APPROVED` 或 `VERDICT: CHANGES_REQUESTED`），与技术验收相互独立、不能互相替代。业务返工默认 3 轮（与技术额度独立计数），未扩展时第 4 轮暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="business", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。业务返工改了代码后必须重新通过技术验收。',
        '- 验收记录与同一版候选代码、业务方案与技术规格对应：任一变化使旧结论失效，不能用旧批准收尾。',
        '- worker 替补：后端任务 worker1 不可用时改派备份 worker2（自动改派或 Lead 手动改派）；三轮技术返工仍未通过且用户同意继续后，Lead 可指定 tester（须显式开启 worker 能力）接手实现；接手写代码后技术验收与业务验收仍由 brain 独立签署（两份独立记录）。',
        '- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。',
        '- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。',
        '- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。',
        '- 每个成员在调用 `squad_report` 前，向 `JOURNAL.md` 追加一条简短记录。',
        `- 收尾需要测试验收、技术验收与业务验收都以 \`VERDICT: APPROVED\` 结束且仍然新鲜；Lead 在验收 approved 后调用 squad_finish。`,
        `- 记忆目录：\`${taskDir}\``,
      ].join('\n')
    : [
        '- 任何派单动手前先读本文件。',
        '- 流程（简化/兼容）：brain 方案 → Lead 审核批准 → worker 实现 → brain 验收 → 收尾；无技术规格/技术验收门禁。',
        '- Lead 先审方案再实现：`brain` 写 `PLAN.md` 后由 Lead 审核并用 `squad_approve_plan` 批准（Lead 只批准**方案**，归档 `PLAN-APPROVED.md`）；设计问题须带编号缺陷再派 `phase="design"` 返工；默认初始设计 + 3 轮返工 = 4 次 design 派单，未扩展时第 5 次暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派 design；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。未批准前不派 implement/rework（无 brain 任务豁免）。',
        '- `brain` 写 `PLAN.md`（方案 + 编号验收标准）与 `REVIEW.md`（逐条结论与证据）。',
        '- `worker` 写 `REPORT.md`（改动、执行的命令、测试证据）。',
        '- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。',
        '- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。',
        '- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。',
        '- 每个成员在调用 `squad_report` 前，向 `JOURNAL.md` 追加一条简短记录。',
        '- 实现验收只有 `brain` 能批准（`REVIEW.md` 以 `VERDICT: APPROVED` 结束），与 Lead 的方案批准相互独立；实现返工独立计数，默认 3 轮，未扩展时第 4 次暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="implement", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派 rework；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。Lead 在 brain 批准后收尾。',
        `- 记忆目录：\`${taskDir}\``,
      ].join('\n')
  return `# 小队任务 \`${taskId}\`

## 目标

${goal}

## 验收标准

${acceptance}

## 约束

${constraints || '—'}

## 工作区

${workspaceBlock}

## 共享记忆协议

${protocol}

## 成员

| 名称 | 角色 | 上下文 | 职责 |
| --- | --- | --- | --- |
${members}
`
}

function deliverableOf(agent, phase) {
  // The phase decides the artifact; cross-role notes mark a tester
  // countersigning TECH-REVIEW (brain implemented) or a brain covering
  // test acceptance for a suspended tester (failover).
  const acting =
    phase === 'tech-review' && agent.role === 'tester'
      ? '（代签技术验收：brain 已在本任务写代码）'
      : phase === 'test-review' && agent.role === 'brain'
        ? '（代行测试验收职责：测试者挂起）'
        : ''
  if (phase === 'spec') {
    return `发布/修订技术规格 SPEC.md（代码结构、模块职责、表与迁移、领域模型、接口与错误、验证用例；不适用处明确说明），版本号以派单为准。技术规格由 brain 负责。`
  }
  if (phase === 'acceptance') {
    return agent.role === 'tester'
      ? `技术维度验收（第 ${1} 步/共 2 步）：以 AUTHORITY.md 为唯一权威方案，对代码与测试做技术维度验收（亲自运行测试/构建，逐项核对）；把技术维度结论写进 ACCEPTANCE-REPORT.md，并与业务维度共同覆盖五要素：① 验收方案与标准（从 AUTHORITY.md 推导）② 上一轮验收报告修复情况（第 2 轮起核对 ACCEPTANCE-REPORT-R<上一轮>.md 的问题编号与证据）③ 本轮发现的问题（编号、维度、证据、严重度）④ 修复建议（逐条最小修复方案，供 worker 执行）⑤ 结论（由 brain 定稿 VERDICT）。你不定稿 VERDICT，交由业务维度完成后统一给出。`
      : `业务维度验收（第 2 步/共 2 步，定稿）：以 AUTHORITY.md 为唯一权威方案，对外行为与用户可见结果做业务维度验收；与技术维度结论汇总定稿 ACCEPTANCE-REPORT.md，确保五要素齐全（验收方案与标准 / 上一轮修复情况 / 本轮问题 / 修复建议 / 结论），最后一行必须是机器可读的「VERDICT: APPROVED」（两维度均通过）或「VERDICT: CHANGES_REQUESTED」（任一维度存在问题，附编号问题与修复建议）。`
  }
  if (phase === 'test-review') {
    return `测试验收轮依据 SPEC.md（技术实现规格）与 PLAN-APPROVED.md（验收方案）审核 worker 测试用例：逐条 AC 检查覆盖与一致性；不合格由你补充测试用例并进行完整测试，写 TEST-REVIEW.md（审核结论、补充的用例、完整测试的命令/退出码/关键输出），最后一行 VERDICT。${acting}`
  }
  if (phase === 'tech-review') {
    return `技术验收轮以当前 SPEC.md 为唯一技术规格写 TECH-REVIEW.md：代码审查、亲自运行验证测试、逐条记录命令/退出码/关键输出与编号缺陷，最后一行 VERDICT。技术验收前必须已有仍然新鲜的 APPROVED 测试验收（TEST-REVIEW.md）。${acting}`
  }
  if (agent.role === 'brain') {
    return '业务验收轮以 PLAN-APPROVED.md 为唯一业务规格写 REVIEW.md，逐条 AC 给结论与证据。'
  }
  return '写 REPORT.md，按 PLAN-APPROVED.md + SPEC.md 逐条 AC 记录改动、测试名、命令、退出码、关键输出与结论；豁免任务按 TASK.md 与 Lead 本轮派单逐条 AC 留证。'
}

/**
 * One per-round dispatch strategy (S7): the phase decides the material a
 * teammate needs. Pure: no I/O; callers pass the real phase/flow/target.
 *
 * @param {object} input dispatch facts.
 * @returns {{scopeLine: string, reads: string[], deliveryFile: string, deliveryHint: string, briefHints: string[]}}
 */
function makeDispatchStrategy({
  phase,
  flow,
  reworkKind = null,
  round = 1,
  target,
  failedReports = [],
  planRequired = true,
}) {
  const acceptance = flow?.acceptance === true
  const specRequired = flow?.specRequired === true
  const taskScope =
    '目标：TASK.md#目标；验收：TASK.md#验收标准；约束：TASK.md#约束（完整读取这三节；不要用一句摘要替代）'
  // TECH-03: acceptance ADDS the authority note; it never replaces the three
  // TASK section entry points on a normal (non-rework) dispatch.
  const scopeLine =
    phase === 'acceptance'
      ? `${taskScope}；另注：AUTHORITY.md 是唯一判据，开发流程的 S/E/M 不替代 AUTHORITY.md。`
      : taskScope
  const failureRead = (name) => {
    if (name === 'TEST-REVIEW.md') return 'TEST-REVIEW.md 的失败/缺陷段（按编号定位）'
    if (name === 'TECH-REVIEW.md') return 'TECH-REVIEW.md 的失败/缺陷段（按编号定位）'
    if (name === 'REVIEW.md') return 'REVIEW.md 的失败/缺陷段（按编号定位）'
    if (name === 'ACCEPTANCE-REPORT.md') return 'ACCEPTANCE-REPORT.md 的问题段（按编号定位）'
    return `${name}（按编号定位）`
  }
  if (phase === 'rework') {
    // TR-03: the authoritative sources follow the flow, not a fixed dev list.
    const sources = failedReports.length > 0
      ? failedReports.map(failureRead)
      : [
          acceptance
            ? 'ACCEPTANCE-REPORT.md 的问题段（按编号定位）'
            : specRequired
              ? '本次新鲜失败报告的对应段（按编号定位）'
              : 'REVIEW.md 的失败/缺陷段（按编号定位）',
        ]
    let reads
    let scopeLine
    if (acceptance) {
      // Acceptance tasks never read the dev pipeline (TASK/PLAN/SPEC).
      reads = ['AUTHORITY.md 中对应条款（按编号定位）', ...sources]
      scopeLine = `${REWORK_SCOPE} 开发流程的 S/E/M 不替代 AUTHORITY.md：权威只取 AUTHORITY.md 对应条款与 ACCEPTANCE-REPORT.md 问题段。缺陷包按 Lead 本轮消息的“缺陷ID / 受影响AC / 文件:行或章节 / 最小修复建议 / 复验命令”逐项执行；缺项从本次新鲜报告同编号段补齐，仍缺则写 blocked：<缺陷ID或未给编号> 缺<字段>。`
    } else if (specRequired) {
      // Full flow: the same gate chose the failing report, so index it. A
      // plan-exempt task (snapshot planRequired=false) may have no approved
      // archive; do not demand one that cannot exist (TECH-07).
      reads = [
        'TASK.md 中受影响 AC 与约束（按编号定位，不整读）',
        planRequired
          ? 'PLAN-APPROVED.md 中对应 AC（按编号定位）'
          : 'PLAN-APPROVED.md 中对应 AC（存在时；无归档时用 TASK.md 对应 AC 与本轮交办）',
        'SPEC.md 中对应实现段与验证用例（按编号定位）',
        ...sources,
      ]
      scopeLine = `${REWORK_SCOPE} 缺陷包按 Lead 本轮消息的“缺陷ID / 受影响AC / 文件:行或章节 / 最小修复建议 / 复验命令”逐项执行；缺项从本次新鲜报告同编号段补齐，仍缺则写 blocked：<缺陷ID或未给编号> 缺<字段>。`
    } else {
      // Simple/legacy: the business review is the only authority; no absent
      // PLAN-APPROVED/SPEC is demanded.
      reads = ['TASK.md 中受影响 AC 与约束（按编号定位，不整读）', ...sources]
      scopeLine = `${REWORK_SCOPE} 缺陷包按 Lead 本轮消息的“缺陷ID / 受影响AC / 文件:行或章节 / 最小修复建议 / 复验命令”逐项执行；缺项从本次新鲜报告同编号段补齐，仍缺则写 blocked：<缺陷ID或未给编号> 缺<字段>。`
    }
    return {
      scopeLine,
      reads,
      deliveryFile: 'REPORT.md',
      deliveryHint:
        '交付：更新 REPORT.md，逐项复验并保留原有已通过证据；只回复 ≤150 字摘要 + 文件路径。',
      briefHints: [
        `- ${REWORK_SCOPE}`,
        '- 缺陷包仅以 Lead 本轮消息为准，不把任务正文或历史报告复制进 BRIEF',
        '- REPORT.md（逐项复验，保留原有已通过证据）',
      ],
    }
  }
  const stageReads =
    phase === 'design'
      ? ['PLAN.md（已有方案；存在时）']
      : phase === 'spec'
        ? ['PLAN-APPROVED.md', 'SPEC.md（已有；存在时）']
        : phase === 'implement'
          ? [
              planRequired
                ? 'PLAN-APPROVED.md（业务方案）'
                : 'PLAN-APPROVED.md（豁免任务可缺；按 TASK.md 与本轮派单）',
              ...(specRequired ? ['SPEC.md（技术规格）'] : []),
            ]
          : phase === 'test-review'
            ? ['PLAN-APPROVED.md', 'SPEC.md', 'REPORT.md', 'TEST-REVIEW.md（已有；存在时）']
            : phase === 'tech-review'
              ? ['SPEC.md', 'TEST-REVIEW.md（新鲜 APPROVED）', 'REPORT.md', 'TECH-REVIEW.md（已有；存在时）']
              : phase === 'review'
                ? [
                    'PLAN-APPROVED.md',
                    'REPORT.md',
                    'TECH-REVIEW.md（已有；存在时）',
                    ...(specRequired ? ['TEST-REVIEW.md', 'SPEC.md'] : []),
                  ]
                : acceptance || phase === 'acceptance'
                  ? [
                      'AUTHORITY.md（唯一权威方案）',
                      'ACCEPTANCE-REPORT.md（存在时）',
                      `ACCEPTANCE-REPORT-R${Math.max(1, Number(round) - 1)}.md（存在时；核对上一轮修复情况）`,
                    ]
                  : []
  const deliveryFile =
    phase === 'design'
      ? 'PLAN.md'
      : phase === 'spec'
        ? 'SPEC.md'
        : phase === 'test-review'
          ? 'TEST-REVIEW.md'
          : phase === 'tech-review'
            ? 'TECH-REVIEW.md'
            : phase === 'review'
              ? 'REVIEW.md'
              : phase === 'acceptance'
                ? 'ACCEPTANCE-REPORT.md'
                : 'REPORT.md'
  // TECH-03: keep each phase's short delivery contract (five elements, a
  // machine-readable VERDICT, tester-vs-brain duties) rather than replacing it
  // with one generic line.
  let deliveryHint
  if (phase === 'acceptance') {
    deliveryHint =
      target?.role === 'tester'
        ? '交付：技术维度验收写入 ACCEPTANCE-REPORT.md（五要素：① 验收方案与标准 ② 上一轮修复情况 ③ 本轮问题 ④ 修复建议 ⑤ 结论）；你不定稿 VERDICT，由 brain 业务维度完成后定稿。'
        : '交付：业务维度验收并定稿 ACCEPTANCE-REPORT.md（五要素齐全），最后一行机器可读 VERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED。'
  } else if (phase === 'test-review') {
    deliveryHint =
      '交付：写 TEST-REVIEW.md（逐条 AC 审核结论、补充用例、完整测试命令/退出码/关键输出），最后一行 VERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED。'
  } else if (phase === 'tech-review') {
    deliveryHint =
      '交付：写 TECH-REVIEW.md（代码审查、亲自运行验证测试、逐条命令/退出码/关键输出与编号缺陷），最后一行 VERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED。'
  } else if (phase === 'review') {
    deliveryHint =
      '交付：写 REVIEW.md，逐条 AC 给出验证命令、退出码、关键输出与结论，最后一行 VERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED。'
  } else if (phase === 'spec') {
    deliveryHint =
      '交付：发布/修订 SPEC.md（代码结构、模块职责、表与迁移、领域模型、接口与错误、验证用例），版本号以派单为准。'
  } else if (phase === 'design') {
    deliveryHint = '交付：写 PLAN.md（业务方案 + 编号验收标准 + 可执行验收命令），只回复 ≤150 字摘要 + 文件路径。'
  } else {
    deliveryHint = `交付：写 ${deliveryFile}，逐条 AC 记录改动文件、测试名、命令、退出码、关键输出与结论；只回复 ≤150 字摘要 + 文件路径。`
  }
  return {
    scopeLine,
    reads: stageReads,
    deliveryFile,
    deliveryHint,
    briefHints: [`- ${scopeLine}`, ...stageReads.slice(0, 2).map((item) => `- ${item}`)],
  }
}

function renderDispatch({
  taskId,
  taskDir,
  phase,
  round,
  agent,
  message,
  includeCharter,
  config,
  workspace,
  worktrees = [],
  strategy = null,
}) {
  const deliverable = deliverableOf(agent, phase)
  const charter = includeCharter ? `\n角色章程：\n${charterFor(agent, config)}\n` : ''
  const repoBlock = worktrees.length > 1 ? `${repoLines(worktrees).join('\n')}\n` : ''
  const readHint =
    phase === 'acceptance'
      ? '先读 TASK.md 与 AUTHORITY.md（唯一权威方案）；读取 ACCEPTANCE-REPORT.md 与最近一份 ACCEPTANCE-REPORT-R<n>.md（存在时，核对上一轮修复情况）；读取 REPORT.md/JOURNAL.md 最后 80 行。'
      : phase === 'spec'
        ? '先读 TASK.md 与 PLAN-APPROVED.md；spec 轮读取既有 SPEC.md（存在时）；读取 JOURNAL.md 最后 80 行。'
        : phase === 'tech-review'
          ? '先读 TASK.md；读取 SPEC.md、TEST-REVIEW.md、REPORT.md 与 TECH-REVIEW.md（存在时）；读取 JOURNAL.md 最后 80 行。'
          : phase === 'test-review'
            ? '先读 TASK.md；读取 SPEC.md、PLAN-APPROVED.md、REPORT.md 与 TEST-REVIEW.md（存在时）；读取 JOURNAL.md 最后 80 行。'
            : phase === 'review'
              ? '先读 TASK.md；读取 PLAN-APPROVED.md、REPORT.md 与 TECH-REVIEW.md（存在时）；读取 JOURNAL.md 最后 80 行。'
              : '先读 TASK.md；设计轮读取 PLAN.md（存在时）；实现/返工读取 SPEC.md；读取 JOURNAL.md 最后 80 行。'
  const acting =
    phase === 'tech-review' && agent.role === 'tester'
      ? '（代签技术验收：brain 已在本任务写代码）'
      : phase === 'test-review' && agent.role === 'brain'
        ? '（代行测试验收职责：测试者挂起）'
        : ''
  const strategyBlock = strategy
    ? `本轮范围：${strategy.scopeLine}\n必读：${strategy.reads.join('；')}`
    : readHint
  const discipline = includeCharter
    ? `上下文纪律：${CONTEXT_DISCIPLINE}\n执行效率纪律：${EXECUTION_DISCIPLINE_SHORT}`
    : '上下文纪律：按 BRIEF 的上下文纪律。\n执行效率纪律：按 BRIEF 的执行效率纪律。'
  const parallelHint =
    phase === 'implement' || phase === 'rework'
      ? '并行默认：本轮交办包含多个独立文件/模块时，用你的子代理/并行能力同时开发；不独立的部分串行完成；只改规格内文件，逐条 AC 留证。'
      : ''
  return `[Agent Squad] task=${taskId} phase=${phase} round=${round} role=${agent.role}
${charter}
共享记忆：${taskDir}
工作区：${workspace}
${repoBlock}（只在工作区内改动；动手前先确认 pwd 与它一致，不要写回源 checkout。）
${strategyBlock}${strategy ? `\n${discipline}` : ''}
- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。

Lead 的本轮派单：
${message}
${parallelHint}
${strategy ? `${strategy.deliveryHint}${acting ? ` ${acting}` : ''}` : `交付物：${deliverable}`}
汇报前：更新你的文件，向 JOURNAL.md 追加 2–5 行，然后调用 squad_report（status、简短总结、改动文件）。受阻写进报告，不要在对话里向 Lead 提问。`
}

function formatMembers(members, usageById) {
  return members
    .map((member) => {
      const detail = member.description ? ` — ${clip(member.description, 100)}` : ''
      const usage = usageById?.get(member.id)
      return `- ${member.name} [${member.role}] ${member.status}${detail}${usage ? ` | ${usage}` : ''}`
    })
    .join('\n')
}

async function fileSummary(taskDir) {
  const names = ['TASK.md', 'PROGRESS.md', 'PLAN.md', 'SPEC.md', 'TECH-REVIEW.md', 'REVIEW.md', 'REPORT.md', 'JOURNAL.md']
  const parts = []
  for (const fileName of names) {
    try {
      const info = await stat(join(taskDir, fileName))
      parts.push(`${fileName} ${(info.size / 1024).toFixed(1)}KB`)
    } catch {
      parts.push(`${fileName} —`)
    }
  }
  return parts.join(' | ')
}


/** Deterministic one-page brief; the only file an external agent must read first. */
async function writeBrief({ taskDir, state, agent, phase, round, strategy = null, config = null }) {
  const budget = budgetOf(state)
  const flow = flowOf(state)
  const reworkLine = flow.specRequired
    ? `rework: tech=${state.techReworkRounds ?? 0}/${budget.techLimit} business=${state.businessReworkRounds ?? 0}/${budget.businessLimit}`
    : `rework=${state.reworkRounds ?? 0}/${budget.reworkLimit}`
  const legacyLines = [
    `# BRIEF · ${state.taskId}`,
    '',
    `phase=${phase} round=${round} ${reworkLine}`,
    `agent=${agent.name} role=${agent.role}`,
    '',
    '## 目标 / 验收 / 约束',
    '见同目录 TASK.md（先读，本文件不复述）。',
    '',
    '## 必读',
    '- TASK.md',
    '- PLAN.md（仅设计轮；存在时）',
    '- PLAN-APPROVED.md（业务方案；实现、返工与验收；豁免且无归档时按 TASK.md 与本轮派单）',
    '- SPEC.md（技术规格；spec/实现/返工/技术验收轮）',
    '- TECH-REVIEW.md（存在时：上一轮技术验收结论）',
    '- REVIEW.md（存在时：上一轮业务验收结论）',
    '- REPORT.md（存在时：实现证据）',
    '- JOURNAL.md 最后 40 行',
    '',
    '- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。',
    '- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。',
    '- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。',
    '',
    '## 交付',
    `- ${deliverableOf(agent, phase)}`,
    '- 只回复 ≤150 字摘要 + 文件路径，不回贴正文',
  ]
  const authorityLabel =
    '- PLAN-APPROVED.md（业务方案；实现、返工与验收；豁免且无归档时按 TASK.md 与本轮派单）'
  const semLines = [
    '- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。',
    '- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。',
    '- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。',
  ]
  // TR-04: rework BRIEF indexes this round's actual reports (one merged
  // line), never demands a full TASK read and never copies defect bodies.
  const strategyLines = strategy
    ? phase === 'rework'
      ? [
          `# BRIEF · ${state.taskId}`,
          '',
          `phase=${phase} round=${round} ${reworkLine}`,
          `agent=${agent.name} role=${agent.role}`,
          '',
          '## 返工范围',
          `- ${REWORK_SCOPE}`,
          '- 缺陷包仅以 Lead 本轮派单消息为准（不在 BRIEF 复制缺陷正文）',
          '',
          '## 必读（按编号定位）',
          `- ${strategy.reads.join('；')}`,
          authorityLabel,
          ...(flow.acceptance
            ? ['- 开发流程的 S/E/M 不替代 AUTHORITY.md：权威只取 AUTHORITY.md 对应条款与 ACCEPTANCE-REPORT.md 问题段。']
            : []),
          '',
          ...semLines,
          '',
          '## 交付',
          `- ${strategy.deliveryHint}`,
          `- 上下文纪律：${CONTEXT_DISCIPLINE}`,
          `- 执行效率纪律：${EXECUTION_DISCIPLINE_SHORT}`,
          '- 只回复 ≤150 字摘要 + 文件路径，不回贴正文',
        ]
      : [
          `# BRIEF · ${state.taskId}`,
          '',
          `phase=${phase} round=${round} ${reworkLine}`,
          `agent=${agent.name} role=${agent.role}`,
          '',
          '## 目标 / 验收 / 约束',
          `- ${strategy.scopeLine}`,
          '- 本轮 Lead 交办全文以派单消息为准（本文件不复述）',
          '',
          '## 必读',
          '- TASK.md（先读；目标/验收/约束三节完整读取）',
          `- 完整索引：${strategy.reads.join('；')}`,
          authorityLabel,
          '- JOURNAL.md 最后 40 行（仅需要历史时按需读，不整读）',
          '',
          ...semLines,
          '',
          '## 交付',
          `- ${strategy.deliveryHint}`,
          `- 上下文纪律：${CONTEXT_DISCIPLINE}`,
          `- 执行效率纪律：${EXECUTION_DISCIPLINE_SHORT}`,
          '- 只回复 ≤150 字摘要 + 文件路径，不回贴正文',
        ]
    : legacyLines
  await writeFile(join(taskDir, 'BRIEF.md'), `${strategyLines.join('\n')}\n`, 'utf8')
}

/** Prompt for an external one-shot or a local pinned-model child. */
function dispatchPrompt({
  mode,
  taskId,
  taskDir,
  phase,
  round,
  agent,
  message,
  workspace,
  config,
  includeCharter = true,
  worktrees = [],
  strategy = null,
}) {
  const charter = includeCharter ? `\n角色章程：\n${charterFor(agent, config)}\n` : ''
  const repoBlock = worktrees.length > 1 ? `${repoLines(worktrees).join('\n')}\n` : ''
  const deliverFile =
    phase === 'spec'
      ? 'SPEC.md'
      : phase === 'tech-review'
        ? 'TECH-REVIEW.md'
        : phase === 'test-review'
          ? 'TEST-REVIEW.md'
          : agent.role === 'brain'
            ? phase === 'review'
              ? 'REVIEW.md'
              : 'PLAN.md'
            : 'REPORT.md'
  const readBlock = strategy
    ? `本轮范围：${strategy.scopeLine}\n必读：${strategy.reads.join('；')}`
    : '先读 BRIEF.md 与 TASK.md；设计轮读取 PLAN.md（存在时），spec 轮读取 PLAN-APPROVED.md 与既有 SPEC.md，实现、返工与验收读取 PLAN-APPROVED.md + SPEC.md；按需读取 TECH-REVIEW.md / REVIEW.md / REPORT.md。'
  const discipline = includeCharter
    ? `上下文纪律：${CONTEXT_DISCIPLINE}\n执行效率纪律：${EXECUTION_DISCIPLINE_SHORT}`
    : '上下文纪律：按 BRIEF 的上下文纪律。\n执行效率纪律：按 BRIEF 的执行效率纪律。'
  const actingNote =
    (phase === 'tech-review' && agent.role === 'tester') || (phase === 'test-review' && agent.role === 'brain')
      ? '\n注：本阶段由你代行/代签，按上述规格交付。\n'
      : ''
  const parallelHint =
    phase === 'implement' || phase === 'rework'
      ? '\n并行默认：本轮交办包含多个独立文件/模块时，用你的子代理/并行能力同时开发；不独立的部分串行完成；只改规格内文件，逐条 AC 留证。\n'
      : ''
  return `[Agent Squad · ${mode}] task=${taskId} phase=${phase} round=${round} role=${agent.role}
工作区：${workspace}
${repoBlock}共享记忆：${taskDir}
${readBlock}${strategy ? `\n${discipline}` : ''}
${charter}
- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。
本轮交办：
${message}
${parallelHint}${actingNote}
${strategy ? strategy.deliveryHint : `交付：把结果写入 ${deliverFile}；只回复 ≤150 字摘要 + 文件路径，不要回贴全文。`}`
}

/** Best-effort Codex token read from the newest session rollout touched after `since`. */
async function captureCodexTokens(since) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const at = new Date(since)
      const dir = join(
        homedir(),
        '.codex',
        'sessions',
        String(at.getFullYear()),
        String(at.getMonth() + 1).padStart(2, '0'),
        String(at.getDate()).padStart(2, '0'),
      )
      const files = (await readdir(dir)).filter((file) => file.endsWith('.jsonl'))
      let best
      for (const file of files) {
        const info = await stat(join(dir, file))
        if (info.mtimeMs >= since - 5000 && (!best || info.mtimeMs > best.mtimeMs)) {
          best = { file, mtimeMs: info.mtimeMs }
        }
      }
      if (best) {
        const text = await readFile(join(dir, best.file), 'utf8')
        const values = [...text.matchAll(/"total_tokens":(\d+)/g)].map((match) => Number(match[1]))
        return values.length > 0 ? Math.max(...values) : undefined
      }
    } catch {}
    await delay(300)
  }
  return undefined
}


/** Acceptance gate shared by squad_deliver and squad_finish. */
async function acceptanceGateError(taskDir, state) {
  const flow = flowOf(state)
  if (flow.acceptance) {
    const report = await readFile(join(taskDir, 'ACCEPTANCE-REPORT.md'), 'utf8').catch(() => '')
    if (!report) return '缺少 ACCEPTANCE-REPORT.md：先完成双维度验收（tester 技术维度 → brain 业务维度）并定稿验收报告。'
    const verdicts = [...report.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi)]
    const last = verdicts.at(-1)?.[1]?.toUpperCase()
    if (last !== 'APPROVED') {
      return `ACCEPTANCE-REPORT.md 最后一条 VERDICT 不是 APPROVED（当前：${last ?? '缺失'}）；CHANGES_REQUESTED 的问题由 worker rework 修复后重走双验收。`
    }
    if (!bindingFresh(state.acceptance, state)) {
      return '验收结论已失效：验收后代码又发生了变动（codeEpoch 不一致）。重新完成一轮双验收后再交付。'
    }
    return null
  }
  if (flow.specRequired) {
    const tech = await readFile(join(taskDir, 'TECH-REVIEW.md'), 'utf8').catch(() => '')
    if (!tech) return '缺少 TECH-REVIEW.md：先让 tester 技术验收（或由 brain 代签）并写 TECH-REVIEW.md。'
    const techVerdicts = [...tech.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi)]
    const techLast = techVerdicts.at(-1)?.[1]?.toUpperCase()
    if (techLast !== 'APPROVED') {
      return `TECH-REVIEW.md 最后一条 VERDICT 不是 APPROVED（当前：${techLast ?? '缺失'}）；需要以 \`VERDICT: APPROVED\` 结束。`
    }
    if (!bindingFresh(state.techReview, state)) {
      return '技术验收结论已失效：验收后代码或规格又发生了变动（codeEpoch/specVersion 不一致）。重新派 tech-review 通过后再交付。'
    }
  }
  const reviewRequired = state.gate?.reviewRequired !== false
  if (reviewRequired) {
    const review = await readFile(join(taskDir, 'REVIEW.md'), 'utf8').catch(() => '')
    if (!review) return '缺少 REVIEW.md：先让 brain 验收并写 REVIEW.md。'
    const verdicts = [...review.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi)]
    const last = verdicts.at(-1)?.[1]?.toUpperCase()
    if (last !== 'APPROVED') {
      return `REVIEW.md 最后一条 VERDICT 不是 APPROVED（当前：${last ?? '缺失'}）；需要以 \`VERDICT: APPROVED\` 结束。`
    }
    if (flow.specRequired && !bindingFresh(state.businessReview, state)) {
      return '业务验收结论已失效：验收后代码或规格又发生了变动（codeEpoch/specVersion 不一致）。重新派 review 通过后再交付。'
    }
  }
  return null
}

/** Merge one squad branch into the source repository's Base branch. */
async function mergeIntoBase({ repo, branch, baseBranch, message }) {
  const current = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  if (current !== baseBranch) {
    throw new Error(`源仓库 ${repo} 当前在 "${current}"，不是 Base 分支 "${baseBranch}"；请先切回 Base 分支再交付。`)
  }
  try {
    await git(repo, ['merge', '--no-ff', branch, '-m', message])
  } catch (error) {
    const first = String(error?.message ?? error).split('\n')[0]
    throw new Error(
      `合并 ${branch} 到 ${baseBranch} 失败（${repo}）：${first}；请手动解决冲突后重试；本次交付未标记为完成。`,
    )
  }
  return (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim()
}


/** One-line stage summary used in reports and status. */
function progressSummaryOf(state) {
  const features = Array.isArray(state.features) ? state.features : []
  if (state.phase === 'done') return '任务已完成'
  if (state.baseDelivered) {
    const merged = features.filter((item) => item.merged).length
    return `并行阶段：Base 已交付，特性 ${merged}/${features.length} 已合并${features.length ? `（${features.map((item) => `${item.name}${item.merged ? '✓' : '…'}`).join(' ')}）` : ''}`
  }
  return `串行阶段（基础层）：phase=${state.phase} round=${state.round}`
}

/**
 * Layered progress view: task overview → phase checklist → teammate progress →
 * parallel features. Used by squad_status and the auto-synced PROGRESS.md.
 */
async function renderProgress({ taskDir, state, rows = [] }) {
  const flow = flowOf(state)
  const features = Array.isArray(state.features) ? state.features : []
  const dispatches = Array.isArray(state.dispatches) ? state.dispatches : []
  const plan = planGateOf(state)
  const running = new Set(
    rows.filter((row) => row.activity === 'running' && row.name).map((row) => row.name),
  )
  const lastOf = (name) => [...dispatches].reverse().find((item) => item.agent === name)
  const techVerdict = flow.specRequired ? await readVerdict(taskDir, 'TECH-REVIEW.md') : undefined
  const businessVerdict = await readVerdict(taskDir, 'REVIEW.md')
  const testVerdict = flow.specRequired ? await readVerdict(taskDir, 'TEST-REVIEW.md') : undefined
  const testFresh = flow.specRequired && bindingFresh(state.testReview, state) && testVerdict === 'APPROVED'
  const techFresh = flow.specRequired && bindingFresh(state.techReview, state) && techVerdict === 'APPROVED'
  const businessFresh = bindingFresh(state.businessReview, state) && businessVerdict === 'APPROVED'
  const acceptanceVerdict = flow.acceptance ? await readVerdict(taskDir, 'ACCEPTANCE-REPORT.md') : undefined
  const acceptanceFresh =
    flow.acceptance && bindingFresh(state.acceptance, state) && acceptanceVerdict === 'APPROVED'
  const pendingRuns = Array.isArray(state.pendingRuns) ? state.pendingRuns : []
  const done = state.phase === 'done'
  const lines = ['## 进度总览', `- 阶段：${progressSummaryOf(state)}`, `- 当前：phase=${state.phase ?? '?'} round=${state.round ?? '?'}${done ? '（已收尾）' : ''}`]
  const gates = [`方案 ${plan.planApproved ? '已批准' : plan.planRequired ? '待批准' : '豁免'}`]
  if (flow.acceptance) {
    const steps = state.acceptanceSteps ?? { tech: null, biz: null }
    gates.push(`双验收 技术 ${steps.tech ? `已完成（${steps.tech}）` : '未开始'}`)
    gates.push(`双验收 业务 ${steps.biz ? `已完成（${steps.biz}）` : steps.tech ? '待进行' : '未开始'}`)
    gates.push(`验收报告 ${acceptanceFresh ? '新鲜 APPROVED' : acceptanceVerdict ?? '未定稿'}`)
  } else if (flow.specRequired) {
    gates.push(`测试验收 ${testFresh ? '新鲜 APPROVED' : testVerdict ?? '未验收'}`)
    gates.push(`技术验收 ${techFresh ? '新鲜 APPROVED' : techVerdict ?? '未验收'}`)
    gates.push(`业务验收 ${businessFresh ? '新鲜 APPROVED' : businessVerdict ?? '未验收'}`)
  } else if (state.gate?.reviewRequired !== false) {
    gates.push(`业务验收 ${businessVerdict ?? '未验收'}`)
  }
  lines.push(`- 门禁：${gates.join(' · ')}`)
  if (pendingRuns.length > 0) {
    lines.push(
      `- 后台运行中：${pendingRuns.map((item) => `${item.agent} ${item.phase} r${item.round}（自 ${item.at}）`).join('、')}——结果以后台消息送达，主会话不被占用`,
    )
  }

  lines.push('## 分阶段进度')
  const check = (ok) => (ok ? '✓' : '…')
  if (flow.acceptance) {
    const steps = state.acceptanceSteps ?? { tech: null, biz: null }
    const rounds = Number(state.acceptanceRounds ?? 0)
    lines.push(`- ✓ 权威方案：AUTHORITY.md（以指定方案为准，brain 不产出设计）`)
    lines.push(`- ${check(Boolean(steps.tech))} 技术维度验收（tester）：${steps.tech ?? '未开始'}`)
    lines.push(`- ${check(Boolean(steps.biz))} 业务维度验收（brain，定稿）：${steps.biz ?? steps.tech ? steps.biz ?? '待进行' : '未开始'}`)
    lines.push(`- ${check(acceptanceFresh)} 验收报告：第 ${rounds} 轮，${acceptanceFresh ? '新鲜 APPROVED' : `${acceptanceVerdict ?? '未定稿'}（ACCEPTANCE-REPORT.md 五要素）`}`)
    const fixes = dispatches.filter((item) => item.phase === 'rework').length
    lines.push(`- ${check(acceptanceFresh)} 问题修复（worker）：${fixes} 轮 rework（技术维度返工预算 ${budgetOf(state).techLimit} 轮）`)
  } else {
  lines.push(
    `- ${check(plan.planApproved)} 业务方案：${plan.planApproved ? `已批准（第 ${plan.planRounds}/${budgetOf(state).designLimit} 次设计，${plan.planApprovedAt ?? '?'}）` : plan.planRequired ? `待 Lead 批准（第 ${plan.planRounds}/${budgetOf(state).designLimit} 次设计）` : '豁免'}`,
  )
  if (flow.specRequired) {
    lines.push(`- ${check(state.specPublished)} 技术规格：${state.specPublished ? `v${state.specVersion ?? 0}（SPEC.md）` : '未交付'}`)
    lines.push(`- ${check(testFresh)} 测试验收：${testFresh ? '新鲜 APPROVED（TEST-REVIEW.md）' : `${testVerdict ?? '未验收'}（tester 审核测试用例，必要时补充并完整测试）`}`)
  }
  const baseImpl = dispatches.filter((item) => !item.feature && (item.phase === 'implement' || item.phase === 'rework')).length
  lines.push(`- ${check(baseImpl > 0)} 基础层实现：${baseImpl} 轮${state.baseDelivered ? '（已交付）' : ''}`)
  }
  if (state.baseDelivered) {
    lines.push(`- ✓ 基础层交付：${state.baseDelivered.summary ?? ''} @ ${state.baseDelivered.at}（Base：${(state.baseDelivered.commits ?? []).map((row) => row.baseBranch).join(',') || '?'}）`)
  }
  if (features.length > 0) {
    lines.push('## 并行特性')
    for (const feature of features) {
      const latest = [...dispatches].reverse().find((item) => item.feature === feature.name)
      const who = latest ? `${latest.agent} ${latest.phase} r${latest.round}` : '未派单'
      lines.push(`- ${feature.merged ? '✓' : '…'} ${feature.name}${feature.focus ? `（${feature.focus}）` : ''}：${feature.merged ? `已合并 ${feature.mergedAt ?? ''} 提交 ${feature.commit ?? ''}` : who}`)
    }
  }
  const members = [...new Set(Array.isArray(state.participants) ? state.participants : [])]
  if (members.length > 0) {
    lines.push('## 队员进度')
    for (const name of members) {
      const latest = lastOf(name)
      const role = state.participantRoles?.[name] ?? latest?.role ?? '—'
      const status = running.has(name) ? '运行中' : '空闲'
      lines.push(
        `- ${name} [${role}] ${status}${latest ? ` · 最近 ${latest.phase} r${latest.round} @ ${latest.at}` : ' · 尚未派单'}`,
      )
    }
  }
  return lines.join('\n')
}

/** Best-effort auto-sync of PROGRESS.md at meaningful moments. */
async function writeProgress({ ctx, lead, taskDir, state, signal }) {
  try {
    const rows = lead ? await treeRowsOf(ctx, lead, signal) : []
    const progress = await renderProgress({ taskDir, state, rows })
    await writeFile(join(taskDir, 'PROGRESS.md'), `# 任务进度 · ${state.taskId}\n\n自动同步：${new Date().toISOString()}\n\n${progress}\n`, 'utf8')
  } catch {}
}

/**
 * Flush the bookkeeping of background (parent-delivered) external runs whose
 * result has already arrived: design → PLAN-R archive, review/tech-review →
 * verdict capture + round archive. Runs still in flight stay pending.
 */
async function flushPendingRuns({ ctx, lead, taskDir, state, signal }) {
  const pending = Array.isArray(state.pendingRuns) ? state.pendingRuns : []
  if (pending.length === 0) return { changed: false, running: [] }
  let rows = []
  try {
    rows = lead ? await treeRowsOf(ctx, lead, signal) : []
  } catch {
    rows = []
  }
  const running = pending.filter((item) => {
    const row = rows.find((entry) => entry.id === item.childId)
    return row !== undefined && row.activity === 'running'
  })
  const finished = pending.filter((item) => !running.includes(item))
  for (const item of finished) {
    if (item.phase === 'design') {
      const round = Number(state.planRounds ?? 0)
      if (round > 0) {
        const archive = join(taskDir, `PLAN-R${round}.md`)
        const exists = await stat(archive).then(() => true, () => false)
        if (!exists) {
          const text = await readFile(join(taskDir, 'PLAN.md'), 'utf8').catch(() => '')
          if (text) await writeFile(archive, text, 'utf8').catch(() => {})
        }
      }
    }
    if (item.phase === 'spec') {
      const version = Number(state.specVersion ?? 0)
      if (version > 0) {
        const archive = join(taskDir, `SPEC-V${version}.md`)
        const exists = await stat(archive).then(() => true, () => false)
        if (!exists) {
          const text = await readFile(join(taskDir, 'SPEC.md'), 'utf8').catch(() => '')
          if (text) await writeFile(archive, text, 'utf8').catch(() => {})
        }
      }
    }
    if (item.phase === 'acceptance' && item.role === 'brain') {
      const text = await readFile(join(taskDir, 'ACCEPTANCE-REPORT.md'), 'utf8').catch(() => '')
      const verdicts = [...text.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi)]
      state.lastAcceptanceVerdict = verdicts.at(-1)?.[1]?.toUpperCase() ?? null
      if (text) {
        await writeFile(join(taskDir, `ACCEPTANCE-REPORT-R${item.round}.md`), text, 'utf8').catch(() => {})
      }
    }
    if (item.phase === 'review' || item.phase === 'tech-review' || item.phase === 'test-review') {
      const file =
        item.phase === 'review' ? 'REVIEW.md' : item.phase === 'test-review' ? 'TEST-REVIEW.md' : 'TECH-REVIEW.md'
      const text = await readFile(join(taskDir, file), 'utf8').catch(() => '')
      const verdicts = [...text.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi)]
      const verdict = verdicts.at(-1)?.[1]?.toUpperCase() ?? null
      if (item.phase === 'review') state.lastVerdict = verdict
      else if (item.phase === 'test-review') state.lastTestVerdict = verdict
      else state.lastTechVerdict = verdict
      if (text) {
        const name =
          item.phase === 'review'
            ? `REVIEW-R${item.round}.md`
            : item.phase === 'test-review'
              ? `TEST-REVIEW-R${item.round}.md`
              : `TECH-REVIEW-R${item.round}.md`
        await writeFile(join(taskDir, name), text, 'utf8').catch(() => {})
      }
    }
  }
  state.pendingRuns = running
  await writeJson(join(taskDir, 'STATE.json'), state)
  return { changed: finished.length > 0, running }
}

/** Gate message when a background run is still in flight, else null. */
function pendingRunGate(state, action) {
  const pending = Array.isArray(state.pendingRuns) ? state.pendingRuns : []
  if (pending.length === 0) return null
  const list = pending.map((item) => `${item.agent} ${item.phase} r${item.round}`).join('、')
  return `后台任务仍在运行：${list}；结果以后台消息送达，等它到达（squad_status 可查看进度）后再${action}。`
}

/**
 * Profile-level task registry: taskId → { memoryRoot, worktree, active }.
 * Multi-task support needs task resolution that does not depend on the
 * session cwd (which can only point at one worktree), so every task a squad
 * starts is registered here and tools may address it with `task_id`.
 */
function taskRegistryPath(store) {
  return join(dirname(store.path), 'tasks.json')
}

async function readTaskRegistry(store) {
  const raw = await readJson(taskRegistryPath(store))
  return raw && typeof raw === 'object' && raw.tasks && typeof raw.tasks === 'object'
    ? { tasks: raw.tasks }
    : { tasks: {} }
}

async function registerTask(store, row) {
  const registry = await readTaskRegistry(store)
  registry.tasks[row.taskId] = { ...(registry.tasks[row.taskId] ?? {}), ...row }
  await writeJson(taskRegistryPath(store), registry)
}

async function markTaskActive(store, taskId, active) {
  const registry = await readTaskRegistry(store)
  if (!registry.tasks[taskId]) return
  registry.tasks[taskId] = { ...registry.tasks[taskId], active: active === true }
  await writeJson(taskRegistryPath(store), registry)
}

/** Number of tasks that have not finished yet. */
async function activeTaskCount(store) {
  const registry = await readTaskRegistry(store)
  return Object.values(registry.tasks).filter((row) => row.active === true).length
}

/**
 * Point the memory root's current file at the most recently created task that
 * is still active, so a closed task never stays "current". Leaves the file
 * untouched when no task remains active.
 */
async function repointCurrent(store, closedTaskId) {
  const registry = await readTaskRegistry(store)
  const others = Object.entries(registry.tasks)
    .filter(([id, row]) => id !== closedTaskId && row.active === true && row.memoryRoot)
    .sort((a, b) => String(b[1].createdAt ?? '').localeCompare(String(a[1].createdAt ?? '')))
  if (others.length === 0) return
  const [nextId, nextRow] = others[0]
  await writeJson(join(nextRow.memoryRoot, 'current.json'), {
    taskId: nextId,
    memoryRoot: nextRow.memoryRoot,
    worktree: nextRow.worktree ?? null,
  })
}

/** True when `directory` sits inside a worktree owned by another active task. */
async function insideOtherTaskWorktree(store, directory) {
  try {
    const registry = await readTaskRegistry(store)
    const real = resolve(directory)
    return Object.values(registry.tasks).some(
      (row) =>
        row.active === true &&
        typeof row.worktree === 'string' &&
        row.worktree !== '' &&
        (real === resolve(row.worktree) || real.startsWith(`${resolve(row.worktree)}/`)),
    )
  } catch {
    return false
  }
}

/**
 * Resolve the task a tool call targets.
 * @param {string} [explicitTaskId] `args.task_id`; when absent the workspace
 *   current pointer decides (backward compatible single-task behaviour).
 * @returns {{taskId: string, taskDir: string, memoryRoot: string, current: object|undefined}}
 */
async function resolveTask({ ctx, agent, config, store, explicitTaskId }) {
  const wanted = typeof explicitTaskId === 'string' ? explicitTaskId.trim() : ''
  if (wanted !== '') {
    const registry = await readTaskRegistry(store)
    const row = registry.tasks[wanted]
    if (!row?.memoryRoot) {
      throw new Error(`未知小队任务 "${wanted}"：先 squad_start 创建，或核对任务 id。`)
    }
    return {
      taskId: wanted,
      taskDir: join(row.memoryRoot, wanted),
      memoryRoot: row.memoryRoot,
      current: { taskId: wanted, memoryRoot: row.memoryRoot, worktree: row.worktree ?? null },
    }
  }
  const directory = await memoryDirectory(ctx, agent, config)
  const current = await readJson(join(directory, 'current.json'))
  const taskId = String(current?.taskId ?? '')
  return {
    taskId,
    taskDir: taskId ? join(directory, taskId) : '',
    memoryRoot: directory,
    current,
  }
}

/**
 * Spawn name for a teammate. With more than one active task the name is
 * prefixed so two tasks can each own a `zcode` child without colliding in the
 * subagent tree; a single active task keeps the plain roster name.
 */
/**
 * Read-only dispatch-busy refusal shared by the pre-probe and final gates
 * (TR-13/16/17). Priority: this task's own recorded id and its actual row.
 * Only when that id has no row at all may the original base name act as a
 * fallback; a name-only row never grants resume/compaction rights.
 *
 * @param {{state: object, targetName: string, taskId: string, activeTasks: number, rows: object[]}} input
 * @returns {{where: string}|null} refusal detail, or null when dispatch may proceed
 */
function readOnlyBusyRefusal({ state, targetName, taskId, activeTasks, rows }) {
  const childRecord = state.children?.[targetName]
  if (childRecord?.status === 'provisioning') {
    return { where: `本地子代理 ${childRecord.id}` }
  }
  // TR-18: both recorded ids of this task are meaningful. A historical local
  // record must not mask a running team member (or vice versa); any exact row
  // that is running refuses, and the presence of exact rows disables the
  // unrelated base-name fallback.
  const records = []
  if (childRecord?.id) records.push({ kind: 'child', id: childRecord.id })
  const memberRecord = state.members?.[targetName]
  if (memberRecord?.id) records.push({ kind: 'member', id: memberRecord.id })
  const exactRows = []
  for (const record of records) {
    const row = rows.find((entry) => entry.id === record.id)
    if (row !== undefined) exactRows.push({ ...record, row })
  }
  const runningRow = exactRows.find((entry) => entry.row.activity === 'running')
  if (runningRow) {
    return {
      where:
        runningRow.kind === 'child'
          ? `本地子代理 ${runningRow.id}`
          : `队友 ${runningRow.id}`,
    }
  }
  if (exactRows.length > 0) return null
  const baseName = childNameFor(taskId, targetName, activeTasks)
  const nameRow = rows.find((row) => (row.name ?? row.label ?? String(row.id)) === baseName)
  return nameRow?.activity === 'running' ? { where: `队友（宿主名 ${baseName}）` } : null
}

/**
 * TR-09: derive a legal host-side child name that is unique among the Lead's
 * current children. The fixed roster id stays the logical identity; only the
 * host name is suffixed when an idle stale child still holds the base name
 * (the host does not release a name merely because the session is idle).
 */
function uniqueChildName(base, taken) {
  const legal = String(base)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^[^a-z]+/, '')
  const root = legal === '' ? 'child' : legal
  if (!taken.has(root)) return root
  for (let index = 2; index < 10000; index += 1) {
    const suffix = `-${index}`
    const room = 32 - suffix.length
    if (room < 1) break
    const candidate = `${root.slice(0, room)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return root.slice(0, 32)
}

function childNameFor(taskId, name, activeTasks) {
  if (activeTasks <= 1) return name
  // The subagent runtime only accepts 1-32 lower-case letters, digits or
  // hyphens starting with a letter ("<task>/<agent>" is rejected).
  const safeTask = String(taskId)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^[^a-z]+/, '')
  const safeName = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
  if (safeTask === '') return safeName
  const room = 32 - safeName.length - 1
  if (room < 1) return safeName.slice(0, 32)
  return `${safeTask.slice(0, room)}-${safeName}`
}
/** Build the model-facing tools. */
function createTools(ctx, config, runtime, store) {
  // S6: one bounded in-memory cache of successful report snapshots. Keys are
  // [taskId, sessionId]; a rewrite deletes then re-inserts (LRU-ish), and the
  // oldest entry falls out at 128. Reload clears it.
  const usagePolicy = config.contextPolicy
  const autoUsage = usagePolicy !== false && usagePolicy.showUsage === true
  const usageCache = new Map()
  const usageKey = (taskId, sessionId) => JSON.stringify([String(taskId), String(sessionId)])
  const rememberUsage = (taskId, sessionId, usage) => {
    if (!autoUsage || !usage) return
    const key = usageKey(taskId, sessionId)
    usageCache.delete(key)
    usageCache.set(key, usageSnapshotOf(usage))
    while (usageCache.size > USAGE_CACHE_LIMIT) {
      usageCache.delete(usageCache.keys().next().value)
    }
  }
  const lastUsage = (taskId, sessionId) => usageCache.get(usageKey(taskId, sessionId))
  const usageLineFor = (agent, binding, kind) =>
    autoUsage
      ? formatContextUsage(
          contextUsageOf(ctx, { agent, binding, policy: usagePolicy, kind }),
        )
      : null
  const sessionUsageLine = (taskId, sessionId) => {
    if (!autoUsage) return null
    const live = ctx.agents.get(sessionId)
    if (live) return usageLineFor(live, runtime.bindingOf(sessionId), 'live')
    const snapshot = lastUsage(taskId, sessionId)
    return snapshot
      ? formatContextUsage(contextUsageOf(ctx, { policy: usagePolicy, kind: 'last', snapshot }))
      : formatContextUsage(contextUsageOf(ctx, { policy: usagePolicy, kind: 'cold' }))
  }

  const start = defineTool({
    name: 'squad_start',
    description:
      '创建 Agent Squad 任务：建立共享记忆目录（.agent-squad/<task>/ 下的 TASK.md、JOURNAL.md）并设为当前任务。每个任务先调用一次。任务中禁止自行增编临时辅助队员 aux；确需额外人手，先取得用户明确同意并优先使用 team 模式成员。执行测试遵循执行效率纪律：编码轮 compile+受影响单测，轮末一次受影响 IT，全量只在测试验收/合并 Base/最终交付。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: 'What the task must achieve, in full.' },
        acceptance: {
          type: 'string',
          description: 'Acceptance criteria. Use a numbered list when possible.',
        },
        constraints: {
          type: 'string',
          description: 'Scope limits, files to avoid, commands to run, budget.',
        },
        agents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subset of configured teammate names. Defaults to every configured agent.',
        },
        flow: {
          type: 'string',
          enum: ['full', 'simple'],
          description:
            'Dev-mode task flow (mode="dev"). "full" (default): business plan → Lead approval → technical spec → implementation → test/technical/business acceptance. "simple": legacy gates only; choose it explicitly for non-code tasks. Ignored in acceptance mode.',
        },
        mode: {
          type: 'string',
          enum: ['dev', 'acceptance'],
          description:
            'Squad invocation mode. "dev" (default): the full design → develop → acceptance pipeline. "acceptance": no brain design round — the squad performs dual-dimension acceptance (tester: technical, brain: business) against a designated authority document, delivering ACCEPTANCE-REPORT.md; workers fix the reported issues between rounds.',
        },
        authority: {
          type: 'string',
          description:
            'Acceptance mode only (required there): the authoritative plan the acceptance runs against — a file path resolved against the session directory, or the full text of the plan itself. Copied into the task memory as AUTHORITY.md.',
        },
        repos: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          description:
            'Explicit list of independent Git repositories for this task; the first entry is the primary repository. Relative paths resolve against the session directory. Omit to use the current repository only.',
        },
      },
      required: ['goal', 'acceptance'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_start')
      const sourceDirectory = sessionDirectory(ctx, lead)
      const settings = await store.read()
      const roster = settingsRoster(settings, config)
      // Multi-task: previous tasks stay addressable through the registry, so a
      // new task no longer has to wait for the old one's children to finish.
      // Only an in-place task sharing this exact memory root is refused, since
      // both would fight over the same checkout.
      {
        const memory = await memoryDirectory(ctx, lead, config)
        const pointer = await readJson(join(memory, 'current.json'))
        const previous = pointer?.taskId
          ? await readJson(join(memory, pointer.taskId, 'STATE.json'))
          : undefined
        if (previous && previous.phase !== 'done' && !previous.worktree) {
          const treeRows = await treeRowsOf(ctx, lead)
          const active = Object.entries(previous.children ?? {}).filter(
            ([, child]) => child.status === 'provisioning' || isRowRunning(treeRows, child.id),
          )
          if (active.length > 0) {
            throw new Error(
              `当前原地开发任务 ${pointer.taskId} 仍有运行中的本地子代理：${active.map(([name]) => name).join(', ')}。先收尾或等它们完成，再开新任务。`,
            )
          }
        }
      }
      const requested = Array.isArray(args.agents) && args.agents.length > 0 ? args.agents.map(String) : null
      const participants = requested ? roster.filter((agent) => requested.includes(agent.name)) : roster
      if (participants.length === 0) {
        throw new Error(`没有匹配的队友。已配置 agent：${roster.map((agent) => agent.name).join(', ') || '（无）'}`)
      }
      const missing = requested
        ? requested.filter((wanted) => !roster.some((agent) => agent.name === wanted))
        : []
      const taskId = newTaskId()
      // Flow snapshot at creation: `full` requires a tester participant to
      // run the test acceptance gate; without one the task keeps the legacy
      // gates and the start output says so. Legacy states (created before
      // flows existed) read as legacy through flowOf().
      const requestedFlow = args.flow === 'simple' ? 'simple' : 'full'
      const mode = args.mode === 'acceptance' ? 'acceptance' : 'dev'
      const hasBrain = participants.some((agent) => agent.role === 'brain')
      const hasTester = participants.some((agent) => agent.role === 'tester')
      if (mode === 'acceptance') {
        // Dual-dimension acceptance needs both reviewers.
        if (!hasBrain || !hasTester) {
          throw new Error(
            `验收模式需要 brain（业务维度）与 tester（技术维度）同时参与；当前参与成员：${participants.map((agent) => `${agent.name}(${agent.role})`).join(', ')}。`,
          )
        }
        if (String(args.authority ?? '').trim() === '') {
          throw new Error('验收模式必须提供 authority：以哪份权威方案为准（文件路径或方案全文）。研发设计不再由 brain 产出。')
        }
      }
      const specRequired = mode === 'dev' && requestedFlow === 'full' && hasTester
      const flowInfo = {
        flow: mode === 'acceptance' ? 'acceptance' : specRequired ? 'full' : requestedFlow,
        specRequired,
        downgraded: mode === 'dev' && requestedFlow === 'full' && !hasTester,
        mode,
        authority: mode === 'acceptance' ? String(args.authority).trim() : undefined,
      }

      // --- explicit multi/single repository path (strict, no fallback) -------
      if (args.repos !== undefined) {
        if (
          Array.isArray(args.repos) &&
          args.repos.length > 1 &&
          !memoryDirectorySafe(config.memoryDir)
        ) {
          throw new Error(
            `multi-repository memory directory must stay inside the task root: ${config.memoryDir}`,
          )
        }
        const created = await createSquadWorktrees({
          ctx,
          lead,
          sourceDirectory,
          repos: args.repos,
          taskId,
          directory: settings.worktree.directory,
          base: config.worktreeFrom,
          signal: exec.signal,
        })
        const { taskRoot } = created
        const worktrees = []
        for (const wt of created.worktrees) {
          worktrees.push({ ...wt, sourceBranch: await sourceBranchOf(wt.repo) })
        }
        const multi = worktrees.length > 1
        const memoryRoot = join(taskRoot, config.memoryDir)
        const taskDir = join(memoryRoot, taskId)
        const primarySource = worktrees[0].repo
        const pointer = { taskId, memoryRoot, worktree: worktrees[0].path, taskRoot }
        const sourceMemoryDirs = []
        const pushSourceDir = (dir) => {
          const full = resolve(dir, config.memoryDir)
          if (!sourceMemoryDirs.some((item) => item.dir === full)) {
            sourceMemoryDirs.push({ dir: full, sourceDirectory: dir, created: false })
          }
        }
        pushSourceDir(primarySource)
        if (resolve(sourceDirectory) !== resolve(primarySource)) pushSourceDir(sourceDirectory)
        const snapshots = []
        const snapshotFile = async (location, name) => {
          const path = join(location.dir, name)
          let existed = true
          let bytes = null
          try {
            bytes = await readFile(path)
          } catch (error) {
            if (error.code === 'ENOENT') existed = false
            else throw error
          }
          snapshots.push({ path, existed, bytes, sourceDirectory: location.sourceDirectory })
        }
        try {
          for (const location of sourceMemoryDirs) {
            await snapshotFile(location, '.gitignore')
            await snapshotFile(location, 'current.json')
          }
          for (const location of sourceMemoryDirs) {
            location.created = (await mkdir(location.dir, { recursive: true })) !== undefined
            await ensureSelfIgnore(location.dir)
          }
          await ensureSelfIgnore(memoryRoot)
          for (const wt of worktrees) await ensureSelfIgnore(join(wt.path, config.memoryDir))
          await mkdir(taskDir, { recursive: true })
          await writeFile(
            join(taskDir, 'TASK.md'),
            renderTask({
              taskId,
              goal: String(args.goal).trim(),
              acceptance: String(args.acceptance).trim(),
              constraints: String(args.constraints ?? '').trim(),
              participants,
              taskDir,
              worktree: worktrees[0],
              worktrees,
              workspace: taskRoot,
              flowInfo,
            }),
            'utf8',
          )
          await writeFile(join(taskDir, 'JOURNAL.md'), `# 日志 · ${taskId}\n\n`, 'utf8')
          const authorityRecord = flowInfo.mode === 'acceptance'
            ? await materializeAuthority({ authority: flowInfo.authority, taskDir, sourceDirectory })
            : undefined
          await writeJson(join(taskDir, 'STATE.json'), {
            taskId,
            createdAt: new Date().toISOString(),
            phase: 'design',
            round: 1,
            reworkRounds: 0,
            flow: flowInfo.flow,
            mode: flowInfo.mode,
            ...(authorityRecord ? { authority: authorityRecord } : {}),
            acceptanceRounds: 0,
            acceptanceSteps: { tech: null, biz: null },
            acceptance: null,
            lastAcceptanceVerdict: null,
            specRequired,
            specPublished: false,
            specVersion: 0,
            codeEpoch: 0,
            implementers: [],
            techReview: null,
            testReview: null,
            businessReview: null,
            techReworkRounds: 0,
            techReworkLimit: MAX_TECH_REWORK_ROUNDS,
            businessReworkRounds: 0,
            businessReworkLimit: MAX_BUSINESS_REWORK_ROUNDS,
            participants: participants.map((agent) => agent.name),
            participantRoles: Object.fromEntries(participants.map((agent) => [agent.name, agent.role])),
            gate: {
              reviewRequired: participants.some((agent) => agent.role === 'brain'),
              brainIds: participants.filter((agent) => agent.role === 'brain').map((agent) => agent.name),
            },
            planRequired: flowInfo.mode === 'acceptance' ? false : participants.some((agent) => agent.role === 'brain'),
            planRounds: 0,
            planApproved: false,
            planApprovedAt: null,
            designLimit: MAX_PLAN_ROUNDS,
            reworkLimit: MAX_REWORK_ROUNDS,
            extensions: [],
            dispatches: [],
            worktree: worktrees[0],
            worktrees,
            taskRoot,
            baseDelivered: null,
            features: [],
          })
          // Publish only after all three task files are complete.
          for (const location of sourceMemoryDirs) {
            await writeJson(join(location.dir, 'current.json'), pointer)
          }
          await writeJson(join(memoryRoot, 'current.json'), pointer)
          for (const wt of worktrees) {
            await writeJson(join(wt.path, config.memoryDir, 'current.json'), pointer)
          }
          await registerTask(store, {
            taskId,
            memoryRoot,
            worktree: worktrees[0].path,
            taskRoot,
            active: true,
            createdAt: new Date().toISOString(),
          })
        } catch (error) {
          if (!multi) throw error
          // Multi-repository init/publish failure: restore every touched
          // source file byte-for-byte, drop newly created empty source memory
          // dirs, then roll the Git artifacts back (PLAN §23).
          const restoreDetails = []
          for (const snap of [...snapshots].reverse()) {
            try {
              if (snap.existed) await writeFile(snap.path, snap.bytes)
              else await rm(snap.path, { force: true })
            } catch (restoreError) {
              restoreDetails.push(
                `${snap.sourceDirectory}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
              )
            }
          }
          for (const location of sourceMemoryDirs) {
            if (!location.created) continue
            try {
              if ((await readdir(location.dir)).length === 0) await rmdir(location.dir)
            } catch (restoreError) {
              if (restoreError.code !== 'ENOENT') {
                restoreDetails.push(
                  `${location.sourceDirectory}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
                )
              }
            }
          }
          try {
            await rollbackSquadWorktrees({ ctx, lead, sourceDirectory, taskRoot, worktrees })
          } catch (rollbackFailure) {
            restoreDetails.push(rollbackFailure.message.replace(/^multi-repository rollback failed: /, ''))
          }
          if (restoreDetails.length > 0) {
            const fatal = new Error(
              `multi-repository creation failed: ${error.message}; multi-repository rollback failed: ${restoreDetails.join('; ')}`,
            )
            fatal.fatal = true
            throw fatal
          }
          throw new Error(`multi-repository creation failed: ${error.message}`)
        }
        const lines = [
          `任务 ${taskId} 已创建。`,
          multi
            ? `工作区：${taskRoot}`
            : `工作区：worktree 分支 ${worktrees[0].branch}`,
        ]
        if (multi) {
          lines.push(...repoLines(worktrees))
          lines.push(
            `  主仓库：${primarySource}；每个仓库在任务根下各有一个 worktree，分支都是 ${worktrees[0].branch}。`,
            '  注意：源 checkout 的未提交改动不会复制到 worktree。当前会话目录已切到任务根，队友 spawn 时继承。',
          )
        } else {
          lines.push(
            `  路径：${worktrees[0].path}`,
            `  源仓库：${worktrees[0].repositoryRoot}（基线 ${worktrees[0].baseCommit.slice(0, 8)}）`,
            '  注意：源 checkout 的未提交改动不会复制到 worktree。当前会话目录已切到 worktree，队友 spawn 时继承。',
          )
        }
        lines.push(`共享记忆：${taskDir}`, '参与成员：')
        for (const agent of participants) {
          lines.push(
            `- ${agent.displayName} (${agent.name}) [${agent.role}] executor=${agent.executor}${agent.model ? ` model=${agent.model}` : ''} — ${clip(agent.description, 80) || '无描述'}`,
          )
        }
        if (missing.length > 0) lines.push(`已忽略未配置的 agent：${missing.join(', ')}`)
        lines.push(`流程：${flowInfo.mode === 'acceptance' ? 'acceptance（权威方案 → tester 技术维度验收 → brain 业务维度验收 → 验收报告 → worker 修复循环）' : specRequired ? 'full（业务方案 → 技术规格 → 实现 → 测试验收 → 技术验收 → 业务验收）' : requestedFlow === 'simple' ? 'simple（简化：无技术规格/双验收门禁）' : 'simple（兼容：未配置 tester，自动降级）'}`)
        if (flowInfo.downgraded) {
          lines.push('警告：没有 tester 参与，完整流程无法启用：本次任务按简化规则执行（无技术规格与测试/技术验收门禁）。')
        }
        if (!hasBrain) {
          lines.push('警告：没有 brain 参与，任务豁免 PLAN 审批门禁，也无法获得最终的设计/验收评审。')
        }
        lines.push(
          flowInfo.mode === 'acceptance'
            ? `权威方案：${authorityRecord ? `已固化到 AUTHORITY.md（来源：${authorityRecord.source === 'inline' ? '创建时提供的方案全文' : authorityRecord.source}）。` : ''}下一步：squad_dispatch({ agent: "tester", phase: "acceptance" }) 技术维度验收 → squad_dispatch({ agent: "brain", phase: "acceptance" }) 业务维度验收并定稿 ACCEPTANCE-REPORT.md；CHANGES_REQUESTED → worker phase="rework" 修复后重走双验收；APPROVED → squad_finish。`
            : specRequired
            ? '下一步：squad_dispatch({ agent: "brain", phase: "design" }) 写业务方案；Lead 审核后 squad_approve_plan 批准，再派 brain phase="spec" 发布技术规格，之后 implement → tester phase="test-review" 测试验收 → brain phase="tech-review"/"review"。'
            : '下一步：squad_dispatch({ agent: "<name>", phase: "design", message: "<派单内容>" })；Lead 审核 PLAN.md 后用 squad_approve_plan 批准，再进入 implement。',
        )
        return lines.join('\n')
      }

      // --- default single-repository path (unchanged behavior) --------------
      let worktree
      let worktreeNote
      try {
        const created = await createSquadWorktree({
          ctx,
          lead,
          sourceDirectory,
          taskId,
          directory: settings.worktree.directory,
          base: config.worktreeFrom,
          reuseLinked: !(await insideOtherTaskWorktree(store, sourceDirectory)),
          signal: exec.signal,
        })
        worktree = { ...created }
        worktree.sourceBranch = await sourceBranchOf(created.repositoryRoot)
        if (created.reused) worktreeNote = '当前会话已在 linked worktree 内，复用当前 checkout。'
      } catch (error) {
        if (error?.fatal) throw error
        worktreeNote = `worktree 创建失败，本次原地开发：${error instanceof Error ? error.message : String(error)}`
      }

      const memoryRoot = worktree
        ? join(worktree.path, config.memoryDir)
        : resolve(sourceDirectory, config.memoryDir)
      await ensureSelfIgnore(memoryRoot)
      if (worktree) {
        const sourceMemory = resolve(sourceDirectory, config.memoryDir)
        await ensureSelfIgnore(sourceMemory)
        await writeJson(join(sourceMemory, 'current.json'), {
          taskId,
          memoryRoot,
          worktree: worktree.path,
        })
      }
      const taskDir = join(memoryRoot, taskId)
      await mkdir(taskDir, { recursive: true })
      await writeFile(
        join(taskDir, 'TASK.md'),
        renderTask({
          taskId,
          goal: String(args.goal).trim(),
          acceptance: String(args.acceptance).trim(),
          constraints: String(args.constraints ?? '').trim(),
          participants,
          taskDir,
          worktree,
          worktrees: worktree ? [{ ...worktree, repo: worktree.repositoryRoot }] : [],
          workspace: worktree ? worktree.path : undefined,
          flowInfo,
        }),
        'utf8',
      )
      await writeFile(join(taskDir, 'JOURNAL.md'), `# 日志 · ${taskId}\n\n`, 'utf8')
      const authorityRecord = flowInfo.mode === 'acceptance'
        ? await materializeAuthority({ authority: flowInfo.authority, taskDir, sourceDirectory })
        : undefined
      await writeJson(join(taskDir, 'STATE.json'), {
        taskId,
        createdAt: new Date().toISOString(),
        phase: 'design',
        round: 1,
        reworkRounds: 0,
        flow: flowInfo.flow,
        mode: flowInfo.mode,
        ...(authorityRecord ? { authority: authorityRecord } : {}),
        acceptanceRounds: 0,
        acceptanceSteps: { tech: null, biz: null },
        acceptance: null,
        lastAcceptanceVerdict: null,
        specRequired,
        specPublished: false,
        specVersion: 0,
        codeEpoch: 0,
        implementers: [],
        techReview: null,
        testReview: null,
        businessReview: null,
        techReworkRounds: 0,
        techReworkLimit: MAX_TECH_REWORK_ROUNDS,
        businessReworkRounds: 0,
        businessReworkLimit: MAX_BUSINESS_REWORK_ROUNDS,
        participants: participants.map((agent) => agent.name),
        participantRoles: Object.fromEntries(participants.map((agent) => [agent.name, agent.role])),
        // Acceptance gate snapshotted at task creation: later role edits cannot
        // relax the review requirement for this task (R09).
        gate: {
          reviewRequired: participants.some((agent) => agent.role === 'brain'),
          brainIds: participants.filter((agent) => agent.role === 'brain').map((agent) => agent.name),
        },
        // Plan gate snapshotted from the same participants: Lead must approve
        // PLAN.md via squad_approve_plan before implement/rework dispatches.
        planRequired: flowInfo.mode === 'acceptance' ? false : participants.some((agent) => agent.role === 'brain'),
        planRounds: 0,
        planApproved: false,
        planApprovedAt: null,
        designLimit: MAX_PLAN_ROUNDS,
        reworkLimit: MAX_REWORK_ROUNDS,
        extensions: [],
        dispatches: [],
        worktree: worktree ?? null,
        worktrees: worktree ? [{ ...worktree, repo: worktree.repositoryRoot, sourceBranch: worktree.sourceBranch }] : [],
        taskRoot: worktree ? worktree.path : sourceDirectory,
        baseDelivered: null,
        features: [],
      })
      await writeJson(join(memoryRoot, 'current.json'), {
        taskId,
        memoryRoot,
        worktree: worktree?.path ?? null,
      })
      await registerTask(store, {
        taskId,
        memoryRoot,
        worktree: worktree?.path ?? null,
        taskRoot: worktree?.path ?? sourceDirectory,
        active: true,
        createdAt: new Date().toISOString(),
      })
      if (worktree) {
        const worktreeMemory = join(worktree.path, config.memoryDir)
        await ensureSelfIgnore(worktreeMemory)
        await writeJson(join(worktreeMemory, 'current.json'), {
          taskId,
          memoryRoot,
          worktree: worktree.path,
        })
      }

      const lines = [
        `任务 ${taskId} 已创建。`,
        worktree
          ? `工作区：worktree 分支 ${worktree.branch}`
          : '工作区：原地开发（未创建 worktree）',
      ]
      if (worktree) {
        lines.push(
          `  路径：${worktree.path}`,
          `  源仓库：${worktree.repositoryRoot}（基线 ${worktree.baseCommit.slice(0, 8)}）`,
          '  注意：源 checkout 的未提交改动不会复制到 worktree。当前会话目录已切到 worktree，队友 spawn 时继承。',
        )
      }
      if (worktreeNote) lines.push(`说明：${worktreeNote}`)
      lines.push(`共享记忆：${taskDir}`, '参与成员：')
      for (const agent of participants) {
        lines.push(
          `- ${agent.displayName} (${agent.name}) [${agent.role}] executor=${agent.executor}${agent.model ? ` model=${agent.model}` : ''} — ${clip(agent.description, 80) || '无描述'}`,
        )
      }
      if (missing.length > 0) lines.push(`已忽略未配置的 agent：${missing.join(', ')}`)
      lines.push(`流程：${flowInfo.mode === 'acceptance' ? 'acceptance（权威方案 → tester 技术维度验收 → brain 业务维度验收 → 验收报告 → worker 修复循环）' : specRequired ? 'full（业务方案 → 技术规格 → 实现 → 测试验收 → 技术验收 → 业务验收）' : requestedFlow === 'simple' ? 'simple（简化：无技术规格/双验收门禁）' : 'simple（兼容：未配置 tester，自动降级）'}`)
      if (flowInfo.downgraded) {
        lines.push('警告：没有 tester 参与，完整流程无法启用：本次任务按简化规则执行（无技术规格与测试/技术验收门禁）。')
      }
      if (!hasBrain) {
        lines.push('警告：没有 brain 参与，任务豁免 PLAN 审批门禁，也无法获得最终的设计/验收评审。')
      }
      lines.push(
        flowInfo.mode === 'acceptance'
          ? `权威方案：${authorityRecord ? `已固化到 AUTHORITY.md（来源：${authorityRecord.source === 'inline' ? '创建时提供的方案全文' : authorityRecord.source}）。` : ''}下一步：squad_dispatch({ agent: "tester", phase: "acceptance" }) 技术维度验收 → squad_dispatch({ agent: "brain", phase: "acceptance" }) 业务维度验收并定稿 ACCEPTANCE-REPORT.md；CHANGES_REQUESTED → worker phase="rework" 修复后重走双验收；APPROVED → squad_finish。`
          : specRequired
          ? '下一步：squad_dispatch({ agent: "brain", phase: "design" }) 写业务方案；Lead 审核后 squad_approve_plan 批准，再派 brain phase="spec" 发布技术规格，之后 implement → tester phase="test-review" 测试验收 → brain phase="tech-review"/"review"。'
          : '下一步：squad_dispatch({ agent: "<name>", phase: "design", message: "<派单内容>" })；Lead 审核 PLAN.md 后用 squad_approve_plan 批准，再进入 implement。',
      )
      await writeProgress({ ctx, lead, taskDir, state: await readJson(join(taskDir, 'STATE.json')), signal: exec.signal })
      return lines.join('\n')
    },
  })

  /**
   * Availability probe: a trivial one-shot through the target's executor.
   * external/local runs use the same provider/agentOptions as a real
   * dispatch; team members are in-process and skipped. Errors are classified
   * by QUOTA_ERROR at the call site.
   */
  const probeWorker = async (target, workspace, lead, signal) => {
    const subagents = ctx.get('subagents')
    if (!subagents || target.executor === 'team') return { ok: true, skipped: true }
    const slash = target.model.indexOf('/')
    const pinned =
      slash > 0 ? { provider: target.model.slice(0, slash), model: target.model.slice(slash + 1) } : undefined
    try {
      const activation = await subagents.startActivation({
        provider: target.executor === 'external' && !pinned ? target.model : 'spawn',
        ...activationOptions({
          policy: config.contextPolicy,
          parent: lead,
          executor: target.executor,
          pinned,
          reasoning: target.reasoning,
          provider: target.executor === 'external' && !pinned ? target.model : 'spawn',
          subagents,
        }),
        label: `probe/${target.name}`,
        prompt: [{ type: 'text', text: '可用性探测：这是自动门禁的临时探测请求，只回复 OK，不要做其他事。' }],
        parent: lead,
        ...(workspace ? { cwd: workspace } : {}),
        signal,
        delivery: 'caller',
      })
      let result
      try {
        result = await activation.result
      } finally {
        try {
          await activation.dispose()
        } catch {}
      }
      if (result.stopReason !== 'completed') {
        return { ok: false, detail: result.diagnostic || `stopReason=${result.stopReason}` }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  const dispatch = defineTool({
    name: 'squad_dispatch',
    description:
      '把工作派给已配置的队友。第一次派单创建该队友；之后每次派单都续跑同一段对话，返工因此复用上下文。返回派单模式与会话 id。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: 'Configured teammate name, e.g. brain.' },
        message: {
          type: 'string',
          description: 'Complete, self-contained assignment for this round.',
        },
        phase: {
          type: 'string',
          enum: ['design', 'spec', 'implement', 'test-review', 'tech-review', 'review', 'rework', 'acceptance'],
          description:
            'Pipeline phase. Dev mode: design (business plan) → spec (technical spec, brain) → implement (workers) → test-review (tester) → tech-review (brain) → review (business, brain); rework sends defects back to a worker. Acceptance mode: acceptance only — tester first (technical dimension), then brain brain (business dimension, finalizes ACCEPTANCE-REPORT.md with VERDICT); rework sends the reported issues to a worker.',
        },
        rework_kind: {
          type: 'string',
          enum: ['tech', 'business'],
          description:
            'Full-flow rework quota to consume: "tech" (technical acceptance defects) or "business". Optional; defaults to the freshest failing acceptance.',
        },
        feature: {
          type: 'string',
          description:
            'Parallel phase only: the feature worktree (created by squad_parallel_start) this round works in. Required once the base/common delivery has been merged.',
        },
        probe: {
          type: 'boolean',
          description:
            'Worker availability gate: with the default config each worker is probed once per task before an implement/rework round; pass true to force a fresh probe, false to skip it this round.',
        },
        background: {
          type: 'boolean',
          description:
            'External implement/rework runs in the background BY DEFAULT (non-blocking; the result arrives as a message, so several workers can run in parallel). Pass false only when you need the result synchronously in this very turn.',
        },
        task_id: { type: 'string', description: 'Task id; defaults to the current task.' },
      },
      required: ['agent', 'message'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_dispatch')
      const settings = await store.read()
      const roster = settingsRoster(settings, config)
      // Target is mutable: the worker availability gate may hand the round to
      // an alternate worker (auto substitution) and the dispatch then runs as
      // that substitute, surfacing the handover in the feedback.
      let target = roster.find((agent) => agent.name === args.agent)
      if (!target) {
        throw new Error(
          `未知 agent "${args.agent}"。已配置 agent：${roster.map((agent) => agent.name).join(', ') || '（无）'}`,
        )
      }
      const workerCapable = (agent) =>
        agent.worker === true || (agent.role === 'worker' && agent.worker !== false)
      // Backend pairing: zcode is the primary backend worker and opencode its
      // designated backup, so an unavailable zcode hands its round to opencode
      // first (and vice versa) before any generic worker substitute.
      const BACKUP_PAIR = { worker1: 'worker2', worker2: 'worker1' }
      const pickSubstitute = (exclude) => {
        // Worker rounds move to another worker-capable member; the tester
        // keeps its own role (its failover path is separate).
        const candidates = roster.filter(
          (agent) =>
            !exclude.includes(agent.name) &&
            agent.role !== 'tester' &&
            workerCapable(agent) &&
            !runtime.isSuspended(agent.name),
        )
        const backup = candidates.find((agent) => agent.name === BACKUP_PAIR[target.name])
        if (backup) return backup
        return candidates.find((agent) => agent.role === 'worker') ?? candidates[0]
      }
      const substitutions = []
      const routeToSubstitute = (reason) => {
        const next = pickSubstitute([target.name])
        if (!next) {
          throw new Error(
            `[可用性门禁] ${target.name} 不可用：${reason}；且没有其他可用 worker 可以替代，本轮派单被拒绝。恢复后重派：squad_failover({ agent: "${target.name}", recover: true })。`,
          )
        }
        substitutions.push({ from: target.name, reason })
        target = next
      }
      // Failover: a suspended teammate refuses every dispatch until
      // squad_failover recovers it; a suspended worker is auto-replaced by
      // another worker instead (the tester handover stays explicit).
      if (runtime.isSuspended(target.name)) {
        const record = runtime.suspendedRecord?.(target.name)
        const detail = `已挂起${record ? `（自 ${record.at}；原因：${clip(record.reason, 120)}）` : ''}`
        if (target.role === 'tester') {
          throw new Error(
            `队友 ${target.name} ${detail}，不能派单。` +
              `测试验收职责由 brain 代行：squad_dispatch({ agent: "brain", phase: "test-review", … })。` +
              `用户确认恢复后调用 squad_failover({ agent: "${target.name}", recover: true }) 解除挂起。`,
          )
        }
        routeToSubstitute(detail)
      }
      const resolved = await resolveTask({
        ctx, agent: lead, config, store, explicitTaskId: args.task_id,
      })
      const { taskId, taskDir } = resolved
      const directory = resolved.memoryRoot
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const state = await readJson(join(taskDir, 'STATE.json'))
      if (!state) throw new Error(`未知小队任务 "${taskId}"。先调用 squad_start。`)

      // Flush any settled background run before the gates read STATE, but do
      // not write progress here: a refused dispatch must leave files untouched.
      await flushPendingRuns({ ctx, lead, taskDir, state, signal: exec.signal }).catch(() => {})
      const phase = args.phase ?? 'design'
      const flow = flowOf(state)
      const treeRows = await treeRowsOf(ctx, lead, exec.signal)
      const activeTasks = await activeTaskCount(store).catch(() => 1)
      // Snapshot for the *originally requested* target only. The availability
      // gate may substitute another worker, so every identity/session/route
      // fact is re-derived from the actual target after that point (TR-01);
      // these first snapshots only feed the pre-probe refusal gates.
      const initialTargetName = target.name
      const priorRework = Number(state.reworkRounds ?? 0)
      const budget = budgetOf(state)
      // Full-flow rework: resolve which acceptance the defects come from and
      // check that quota; legacy tasks keep the single implement quota. All
      // refusals happen before any shared file or state mutation.
      let reworkKind = null
      // Fresh failing report names recorded at gate time (S7): the rework
      // strategy points at these instead of re-reading the whole history.
      const failedReports = []
      if (phase === 'rework' && flow.acceptance) {
        // Acceptance-mode fixes ride the tech rework budget; a fresh
        // CHANGES_REQUESTED acceptance report is the only valid trigger.
        const accVerdict = await readVerdict(taskDir, 'ACCEPTANCE-REPORT.md')
        const accPending = bindingFresh(state.acceptance, state) && accVerdict === 'CHANGES_REQUESTED'
        if (!accPending) {
          throw new Error(
            `验收模式下 rework 需要仍然新鲜的 CHANGES_REQUESTED 验收结论：本轮验收未给出 CHANGES_REQUESTED，或结论已因修复/代码变动失效。先完成一轮双验收（phase="acceptance"）。`,
          )
        }
        reworkKind = 'tech'
        failedReports.push('ACCEPTANCE-REPORT.md')
        if (budget.techUsed >= budget.techLimit) {
          throw new Error(
            `验收返工已达上限 ${budget.techLimit} 轮（已用 ${budget.techUsed}）。先向用户说明阻塞点与已完成部分并等待决策；用户同意后调用 squad_extend(kind="tech", confirmed=true, reason="用户批准的追加理由") 追加轮次，再派 rework；用户拒绝或未回复时保持暂停，不得自动续跑。`,
          )
        }
      } else if (phase === 'rework' && flow.specRequired) {
        const techVerdict = await readVerdict(taskDir, 'TECH-REVIEW.md')
        const businessVerdict = await readVerdict(taskDir, 'REVIEW.md')
        const testVerdict = await readVerdict(taskDir, 'TEST-REVIEW.md')
        const businessPending =
          bindingFresh(state.businessReview, state) && businessVerdict === 'CHANGES_REQUESTED'
        // Test-acceptance defects ride the tech quota: TEST-REVIEW and
        // TECH-REVIEW both funnel into the same technical rework budget.
        const techPending =
          (bindingFresh(state.techReview, state) && techVerdict === 'CHANGES_REQUESTED') ||
          (bindingFresh(state.testReview, state) && testVerdict === 'CHANGES_REQUESTED')
        if (args.rework_kind !== undefined) {
          if (args.rework_kind !== 'tech' && args.rework_kind !== 'business') {
            throw new Error('rework_kind 必须是 tech 或 business。')
          }
          reworkKind = args.rework_kind
          const pending = reworkKind === 'business' ? businessPending : techPending
          if (!pending) {
            throw new Error(
              `没有待返工的${reworkKind === 'business' ? '业务' : '技术'}验收结论：对应验收未给出 CHANGES_REQUESTED，或结论已因代码/规格变动失效。`,
            )
          }
        } else if (businessPending) {
          reworkKind = 'business'
        } else if (techPending) {
          reworkKind = 'tech'
        } else {
          throw new Error(
            '没有待返工的验收结论：先派 test-review/tech-review/review 得到 CHANGES_REQUESTED，或确认验收结论未因后续代码/规格变动失效。',
          )
        }
        if (reworkKind === 'business') {
          failedReports.push('REVIEW.md')
        } else {
          if (bindingFresh(state.testReview, state) && testVerdict === 'CHANGES_REQUESTED') {
            failedReports.push('TEST-REVIEW.md')
          }
          if (bindingFresh(state.techReview, state) && techVerdict === 'CHANGES_REQUESTED') {
            failedReports.push('TECH-REVIEW.md')
          }
        }
        const used = reworkKind === 'business' ? budget.businessUsed : budget.techUsed
        const limit = reworkKind === 'business' ? budget.businessLimit : budget.techLimit
        if (used >= limit) {
          throw new Error(
            `${reworkKind === 'business' ? '业务' : '技术'}返工已达上限 ${limit} 轮（已用 ${used}）。先向用户说明阻塞点与已完成部分并等待决策；用户同意后调用 squad_extend(kind="${reworkKind}", confirmed=true, reason="用户批准的追加理由") 追加轮次，再派 rework；用户拒绝或未回复时保持暂停，不得自动续跑。`,
          )
        }
      }
      if (phase === 'rework' && !flow.specRequired && priorRework >= budget.reworkLimit) {
        throw new Error(
          `返工已达上限 ${budget.reworkLimit} 轮（已用 ${budget.implementUsed}）。先向用户说明阻塞点与已完成部分并等待决策；用户同意后调用 squad_extend(kind="implement", confirmed=true, reason="用户批准的追加理由") 追加轮次，再派 rework；用户拒绝或未回复时保持暂停，不得自动续跑。`,
        )
      }
      const round = phase === 'rework' ? Number(state.round ?? 1) + 1 : Number(state.round ?? 1)
      const repoRows = worktreesOf(state)
      const featureName = args.feature === undefined ? null : String(args.feature).trim()
      let feature = null
      if (featureName !== null && featureName !== '') {
        feature = (Array.isArray(state.features) ? state.features : []).find((item) => item.name === featureName)
        if (!feature) {
          throw new Error(`未知 feature "${featureName}"：先调用 squad_parallel_start 创建特性 worktree。`)
        }
        if (feature.merged) throw new Error(`feature "${featureName}" 已交付并合入 Base，不能再派单。`)
        if (!state.baseDelivered) {
          throw new Error('并行特性派单前必须先交付通用功能：squad_deliver({ summary }) 把基础层合并到 Base 分支。')
        }
      }
      if (state.baseDelivered && (phase === 'implement' || phase === 'rework') && !feature) {
        throw new Error(
          '通用功能已交付：并行阶段请用 feature 指定本次实现的特性（squad_dispatch({ …, feature: "<name>" })）；不能继续在基础层 worktree 上开发。',
        )
      }
      // Parallel-phase reviews run against the merged Base branch in the source
      // repository (the task worktree no longer holds the combined candidate).
      const reviewOnBase = Boolean(state.baseDelivered) && (phase === 'tech-review' || phase === 'review')
      const workspace = feature
        ? feature.path
        : reviewOnBase
          ? repoRows[0]?.repo ?? sessionDirectory(ctx, lead)
          : workspaceOf(state, sessionDirectory(ctx, lead))
      const hasWorkspace = Boolean(state.worktree || state.taskRoot)

      const moveTeammate = async (sessionId) => {
        if (!hasWorkspace) return
        const service = ctx.get('workingDirectory')
        const memberAgent = service ? ctx.agents.get(sessionId) : undefined
        if (!service || !memberAgent) return
        try {
          await service.set(memberAgent, workspace, exec.signal)
        } catch {}
      }

      // Unified activity guard (R07): refuse re-dispatch while the target's
      // current binding — local child or team member — is running/provisioning,
      // regardless of executor or model changes. Checked BEFORE any shared
      // file (BRIEF) or state mutation so a refusal leaves them untouched.
      const initialRefusal = readOnlyBusyRefusal({
        state,
        targetName: target.name,
        taskId,
        activeTasks,
        rows: treeRows,
      })
      if (initialRefusal) {
        throw new Error(
          `目标 ${target.name} 仍在运行或创建中（${initialRefusal.where}）。等它完成后再派单，不能并行重派或切换执行方式。`,
        )
      }
      // R07 (cross-task): a child bound to this agent in ANY task of the same
      // memory root blocks dispatch, regardless of the addressed task_id.
      {
        const entries = await readdir(directory).catch(() => [])
        for (const name of entries) {
          const other = await readJson(join(directory, name, 'STATE.json'))
          const otherChild = other?.children?.[target.name]
          if (!otherChild) continue
          if (otherChild.status === 'provisioning' || isRowRunning(treeRows, otherChild.id)) {
            throw new Error(
              `目标 ${target.name} 在任务 ${name} 中仍有运行中的本地子代理（${otherChild.id}）。等它完成后再派单。`,
            )
          }
        }
      }
      // Phase gates, checked before any shared file (BRIEF) is written or an
      // executor is called, so a refusal leaves STATE/BRIEF/dispatch records
      // untouched. Design is refused once the PLAN is approved or the design
      // budget (initial + 3 rework rounds) is spent; implement/rework are
      // refused until the Lead approves PLAN.md and (full flow) the tester
      // has published SPEC.md. Tasks without a brain participant are exempt
      // from the plan gate (planRequired snapshot).
      const plan = planGateOf(state)
      /** True when this round's result is still running in the background. */
      let asyncPending = false
      // Parallel-by-default (squad layer): external one-shot executors would
      // block the tool call until they return, serializing the workers.
      // implement/rework dispatches therefore default to background delivery
      // ('parent': the result reaches the Lead as a message) so several
      // workers can run concurrently; background:false forces the old
      // blocking call. The review-family phases still read the deliverable
      // right after the result and stay synchronous either way.
      // Every external dispatch is non-blocking by default: the runtime
      // delivers the result as a message and the plugin records the run as
      // pending, so the Lead's turn ends instead of hanging for minutes on a
      // codex design/review. Fast runs (tests, instant providers) settle within
      // a tick and are handled inline exactly like a blocking dispatch.
      // background:false restores the old synchronous call. This gate keeps
      // refusing the originally requested target; the actual target's
      // background legality is re-checked after substitution below.
      if (args.background === true && target.executor !== 'external') {
        throw new Error('background 仅支持 external 执行者（一次性外部 provider）；local/team 执行者本就不阻塞。')
      }
      // Mode exclusivity: the dev pipeline phases do not exist in acceptance
      // mode, and the acceptance phase does not exist in dev mode.
      if (flow.acceptance && ['design', 'spec', 'implement', 'test-review', 'tech-review', 'review'].includes(phase)) {
        throw new Error(
          `验收模式任务没有 ${phase} 阶段：验收模式以 AUTHORITY.md 为准，走 phase="acceptance"（tester 技术维度 → brain 业务维度，定稿 ACCEPTANCE-REPORT.md）；发现问题派 worker phase="rework" 修复。研发流程请另建 mode="dev" 任务。`,
        )
      }
      if (!flow.acceptance && phase === 'acceptance') {
        throw new Error(
          `研发模式任务没有 acceptance 阶段：双维度验收属于 mode="acceptance" 的任务（squad_start 传 mode="acceptance" 与 authority 权威方案）。`,
        )
      }
      if (phase === 'acceptance') {
        const steps =
          state.acceptanceSteps && typeof state.acceptanceSteps === 'object'
            ? state.acceptanceSteps
            : { tech: null, biz: null }
        const implementers = Array.isArray(state.implementers) ? state.implementers : []
        if (implementers.includes(target.name)) {
          throw new Error(
            `${target.name} 已在本任务中写过代码（修复），不能验收自己改动的部分：改由另一位验收者执行本维度。`,
          )
        }
        if (target.role === 'tester') {
          const previousComplete = steps.tech !== null && steps.biz !== null
          if (steps.tech && !previousComplete) {
            throw new Error(
              `本轮（第 ${state.acceptanceRounds ?? 1} 轮）技术维度验收已由 ${steps.tech} 完成：先派 brain（phase="acceptance"）完成业务维度并定稿 ACCEPTANCE-REPORT.md（最后一行 VERDICT）。`,
            )
          }
        } else if (target.role === 'brain') {
          if (!steps.tech) {
            throw new Error(
              '双验收顺序（强制）：先派 tester（phase="acceptance"）完成技术维度验收，再派 brain 完成业务维度并定稿报告。',
            )
          }
          if (steps.biz) {
            throw new Error(
              `本轮（第 ${state.acceptanceRounds ?? 1} 轮）验收已定稿（VERDICT 已记录）。CHANGES_REQUESTED → 把编号问题与修复建议派 worker phase="rework" 修复；APPROVED → squad_finish 收尾。`,
            )
          }
        } else {
          throw new Error(
            `acceptance 只能派 tester（技术维度）与 brain（业务维度）；${target.name} 当前是 ${target.role}。`,
          )
        }
      }
      if (phase === 'design') {
        if (plan.planApproved) {
          throw new Error(
            `任务 ${taskId} 的 PLAN 已批准（${plan.planApprovedAt ?? '?'}）：不能再派 design 返工，请派 brain 发布技术规格（phase="spec"）。`,
          )
        }
        if (plan.planRounds >= budget.designLimit) {
          throw new Error(
            `设计预算已用完：已到上限 ${budget.designLimit} 次 design 派单（已用 ${budget.designUsed}）。先向用户说明阻塞点与已完成部分并等待决策；用户同意后调用 squad_extend(kind="design", confirmed=true, reason="用户批准的追加理由") 追加轮次，再派 design；用户拒绝或未回复时保持暂停，不得自动续跑。`,
          )
        }
      }
      if (phase === 'spec') {
        if (!flow.specRequired) {
          throw new Error(
            `任务 ${taskId} 未启用完整流程（没有 tester 参与，或创建时选择了 flow="simple"）：不能派 spec，直接按简化流程派单。`,
          )
        }
        // The technical spec is the brain's own duty now.
        if (target.role !== 'brain') {
          throw new Error(
            `spec 阶段只能派 brain——技术设计与技术规格由 brain 负责；${target.name} 当前是 ${target.role}。`,
          )
        }
        if (plan.planRequired && !plan.planApproved) {
          throw new Error(
            `任务 ${taskId} 的业务方案（PLAN.md）尚未经 Lead 审核批准：先派 brain 设计并 squad_approve_plan，再派 spec。`,
          )
        }
      }
      if (phase === 'implement' || phase === 'rework') {
        if (plan.planRequired && !plan.planApproved) {
          throw new Error(
            `任务 ${taskId} 的 PLAN.md 尚未经 Lead 审核批准（planRounds=${plan.planRounds}/${budget.designLimit}）。先审核 PLAN.md 并调用 squad_approve_plan，再派 ${phase}。`,
          )
        }
        if (flow.specRequired && !state.specPublished) {
          throw new Error(
            `任务 ${taskId} 的技术规格尚未交付：先派 brain phase="spec" 发布 SPEC.md，再派 ${phase}；规格发布后即可派工，不需要 Lead 再审批。`,
          )
        }
        if ((flow.specRequired || flow.acceptance) && !workerCapable(target)) {
          throw new Error(
            `完整流程的 ${phase} 需要 worker 能力：${target.name} 的 worker 能力未启用；worker 固定为 worker1（主力后端）/ worker2（备份后端）/ front1（固定前端），请改派这三名成员。如确需 ${target.name} 接手实现，须经用户同意并显式开启其 worker 能力（编辑 settings.json 或经 PUT /agent-squad/settings）。`,
          )
        }
      }
      if (phase === 'test-review') {
        if (!flow.specRequired) {
          throw new Error(
            `任务 ${taskId} 未启用完整流程：没有测试验收阶段，业务验收直接派 brain（phase="review"）。`,
          )
        }
        if (Number(state.codeEpoch ?? 0) === 0) {
          throw new Error(
            '任务还没有任何实现轮次（codeEpoch=0）：先派 worker phase="implement"，再派测试验收。',
          )
        }
        // The tester owns test acceptance; the brain may cover a suspended
        // tester (quota exhaustion handover).
        const testerAvailable = roster.some(
          (agent) => agent.role === 'tester' && !runtime.isSuspended(agent.name),
        )
        if (target.role !== 'tester' && !(target.role === 'brain' && !testerAvailable)) {
          throw new Error(
            `test-review 只能派 tester${testerAvailable ? '' : '（测试者挂起时可由 brain 代行）'}；${target.name} 当前是 ${target.role}。`,
          )
        }
      }
      if (phase === 'tech-review') {
        if (!flow.specRequired) {
          throw new Error(
            `任务 ${taskId} 未启用完整流程：没有技术验收阶段，业务验收直接派 brain（phase="review"）。`,
          )
        }
        if (Number(state.codeEpoch ?? 0) === 0) {
          throw new Error(
            '任务还没有任何实现轮次（codeEpoch=0）：先派 worker phase="implement"，再派技术验收。',
          )
        }
        // Test acceptance gates the technical acceptance: TECH-REVIEW needs a
        // still-fresh APPROVED TEST-REVIEW of the same code/spec version.
        const testVerdict = await readVerdict(taskDir, 'TEST-REVIEW.md')
        if (!bindingFresh(state.testReview, state) || testVerdict !== 'APPROVED') {
          throw new Error(
            `测试验收未通过或已失效：技术验收前必须先有仍然新鲜的测试验收（TEST-REVIEW.md 以 VERDICT: APPROVED 结束，且验收后代码/规格未再变动）${state.testReview && !bindingFresh(state.testReview, state) ? '（旧结论已因代码/规格变动失效，需重新测试验收）' : ''}。先派 tester phase="test-review"。`,
          )
        }
        const implementers = Array.isArray(state.implementers) ? state.implementers : []
        const brainName = roster.find((agent) => agent.role === 'brain')?.name
        const brainImplemented = brainName !== undefined && implementers.includes(brainName)
        const selfSigned = implementers.includes(target.name)
        const wrongRole = target.role !== 'brain' && target.role !== 'tester'
        const brainBlocked = target.role === 'brain' && selfSigned
        const testerBlocked = target.role === 'tester' && (!brainImplemented || selfSigned)
        if (brainBlocked) {
          throw new Error(
            `${target.name} 已在本任务中写代码，不能签署自己改动的技术验收：改派 tester 对照 SPEC.md 代签技术验收，业务验收仍按业务方案单独签署，两份验收独立记录。`,
          )
        }
        if (wrongRole || testerBlocked) {
          throw new Error(
            `tech-review 默认派 brain；brain 已在本任务写代码时改派 tester 代签；${target.name} 当前是 ${target.role}${selfSigned ? '（已在本任务写代码，不能签署自己改动的技术验收）' : ''}。`,
          )
        }
      }
      if (phase === 'review' && flow.specRequired) {
        if (target.role !== 'brain') {
          throw new Error(
            `完整流程的业务验收只能派 brain 角色；${target.name} 当前是 ${target.role}。`,
          )
        }
        const techVerdict = await readVerdict(taskDir, 'TECH-REVIEW.md')
        if (!bindingFresh(state.techReview, state) || techVerdict !== 'APPROVED') {
          throw new Error(
            `技术验收未通过或已失效：业务验收前必须先有仍然新鲜的技术验收（TECH-REVIEW.md 以 VERDICT: APPROVED 结束，且验收后代码/规格未再变动）${bindingFresh(state.techReview, state) ? '' : '（旧结论已因代码/规格变动失效，需重新验收）'}。先派 tech-review。`,
          )
        }
      }
      // Worker availability gate: before an implement/rework round the target
      // gets a trivial probe; a quota hit suspends it on the spot, reports it,
      // and the round is handed to another worker. Successful probes are
      // cached per task (dispatch probe:true forces a fresh probe).
      let probeNote = null
      const probeWanted =
        config.workerProbe &&
        args.probe !== false &&
        (phase === 'implement' || phase === 'rework') &&
        workerCapable(target) &&
        target.executor !== 'team'
      if (probeWanted) {
        const tried = new Set()
        let needProbe =
          args.probe === true ||
          (args.probe !== false && runtime.probeFresh(target.name) !== false
            ? false
            : state.probes?.[target.name]?.ok !== true)
        // TR-16: the dispatch-entry snapshot only describes the primary. When
        // a quota failure substitutes another worker, refresh the tree before
        // judging/probing the substitute; never cache its eligibility from the
        // initial rows. The final pre-start gate below refreshes again.
        let probeRows = treeRows
        let probeRowsFor = initialTargetName
        while (needProbe && workerCapable(target) && target.executor !== 'team' && !tried.has(target.name)) {
          tried.add(target.name)
          if (target.name !== probeRowsFor) {
            probeRows = await treeRowsOf(ctx, lead, exec.signal)
            probeRowsFor = target.name
          }
          const probeRefusal = readOnlyBusyRefusal({
            state,
            targetName: target.name,
            taskId,
            activeTasks,
            rows: probeRows,
          })
          if (probeRefusal) {
            throw new Error(
              `目标 ${target.name} 仍在运行或创建中（${probeRefusal.where}）。等它完成后再派单，不能并行重派或切换执行方式。`,
            )
          }
          const probe = await probeWorker(target, workspace, lead, exec.signal)
          if (probe.ok) {
            state.probes = { ...(state.probes ?? {}), [target.name]: { at: new Date().toISOString(), ok: true } }
            await writeJson(join(taskDir, 'STATE.json'), state)
            await runtime.recordProbe(target.name, true).catch(() => {})
            needProbe = false
            break
          }
          const detail = firstLine(String(probe.detail ?? 'unknown'))
          if (!QUOTA_ERROR.test(String(probe.detail))) {
            probeNote = `[可用性门禁] ${target.name} 探测异常（非额度类）：${detail}；继续按计划派发，以实际运行为准。`
            needProbe = false
            break
          }
          await runtime.recordProbe(target.name, false).catch(() => {})
          await runtime.suspendAgent(target.name, `可用性探测失败：${detail}`, true, target.role)
          routeToSubstitute(`可用性探测失败：${detail}`)
          needProbe = state.probes?.[target.name]?.ok !== true
        }
      }
      // S3/TR-01: the availability gate may have handed the round to another
      // worker. Identity, bound session, busy state, route, background
      // legality, strategy and rendered prompt must all describe the actual
      // target; the primary's snapshots are never reused for the backup.
      const recordedChildId = state.children?.[target.name]?.id ?? state.members?.[target.name]?.id
      const finalRows = target.name === initialTargetName
        ? treeRows
        : await treeRowsOf(ctx, lead, exec.signal)
      // TR-13: the read-only busy refusal must look at the actual substitute's
      // original base name (or its recorded id), never at a derived free name.
      const baseSpawnName = childNameFor(taskId, target.name, activeTasks)
      // TECH-01/TR-17: a tree row can prove activity for the refusal guard,
      // but by itself (name-only legacy row) it never grants a resumable
      // binding or usage. Only STATE records of this task, selected by the
      // actual executor, are binding facts; the exact id wins over any
      // same-base-name legacy row.
      const recordedChild = state.children?.[target.name]
      const recordedMember = state.members?.[target.name]
      const childBusy =
        recordedChild !== undefined &&
        (recordedChild.status === 'provisioning' || isRowRunning(finalRows, recordedChild.id))
      const finalRefusal = readOnlyBusyRefusal({
        state,
        targetName: target.name,
        taskId,
        activeTasks,
        rows: finalRows,
      })
      if (target.name !== initialTargetName && finalRefusal) {
        throw new Error(
          `目标 ${target.name} 仍在运行或创建中（${finalRefusal.where}）。等它完成后再派单，不能并行重派或切换执行方式。`,
        )
      }
      if (target.name !== initialTargetName) {
        // Cross-task activity guard also follows the actual target.
        const otherEntries = await readdir(directory).catch(() => [])
        for (const name of otherEntries) {
          const other = await readJson(join(directory, name, 'STATE.json'))
          const otherChild = other?.children?.[target.name]
          if (!otherChild) continue
          if (otherChild.status === 'provisioning' || isRowRunning(finalRows, otherChild.id)) {
            throw new Error(
              `目标 ${target.name} 在任务 ${name} 中仍有运行中的本地子代理（${otherChild.id}）。等它完成后再派单。`,
            )
          }
        }
      }
      const executor = target.executor
      const slash = executor === 'local' || executor === 'external'
        ? target.model.indexOf('/')
        : -1
      const pinned =
        slash > 0
          ? { provider: target.model.slice(0, slash), model: target.model.slice(slash + 1) }
          : undefined
      const external = executor === 'external'
      const background = external && args.background !== false
      if (args.background === true && !external) {
        throw new Error('background 仅支持 external 执行者（一次性外部 provider）；local/team 执行者本就不阻塞。')
      }
      // TR-13: derive a free legal host name only now that the refusal gates
      // passed and a new child may actually be created. Taking a name never
      // grants a resumable/compaction binding.
      const takenChildNames = new Set()
      for (const row of finalRows) {
        if (typeof row?.name === 'string' && row.name !== '') takenChildNames.add(row.name)
      }
      for (const pendingName of runtime.pendingNames?.() ?? []) takenChildNames.add(pendingName)
      const spawnName = uniqueChildName(baseSpawnName, takenChildNames)
      // TECH-01: select the binding that the actual executor may continue.
      // Switching executors spawns a fresh child of the new kind instead of
      // resuming the other kind's id; a model change also needs a new child.
      const childBinding =
        executor === 'local' &&
        recordedChild !== undefined &&
        recordedChild.status !== 'provisioning' &&
        recordedChild.model === target.model
          ? recordedChild
          : undefined
      const memberBinding =
        executor === 'team' && recordedMember?.id ? recordedMember : undefined
      // S7: one strategy per round, computed from the worker that actually
      // runs; `contextPolicy:false` keeps the legacy renderers byte-for-byte.
      const strategy = config.contextPolicy === false ? null : makeDispatchStrategy({
        phase,
        flow,
        reworkKind,
        round,
        target,
        failedReports,
        planRequired: planGateOf(state).planRequired,
      })
      // S8: a new local/team child gets the full charter; reusing the same id
      // only gets this round's strategy (system-section refresh is separate).
      const includeCharter =
        executor === 'local'
          ? childBinding === undefined
          : executor === 'team'
            ? memberBinding === undefined
            : true
      const message = renderDispatch({
        taskId,
        taskDir,
        phase,
        round,
        agent: target,
        message: String(args.message).trim(),
        includeCharter,
        config,
        workspace,
        worktrees: repoRows,
        ...(strategy ? { strategy } : {}),
      })
      await writeBrief({ taskDir, state, agent: target, phase, round, ...(strategy ? { strategy } : {}) })

      let mode
      let sessionId
      let externalText = ''
      let tokens
      /** S6 automatic context line for this dispatch receipt, when enabled. */
      let usageLine = null
      /** S3 fork capability fallback surfaced in the receipt. */
      let forkCapFallback = false
      // local + `provider/model` = continuable pinned child; the same form on
      // an external executor falls through to the one-shot branch below.
      if (pinned && !external) {
        const subagents = ctx.get('subagents')
        if (!subagents) {
          throw new Error('本地固定模型子代理需要宿主 subagents 服务，但当前不可用。')
        }
        const existingChild = childBinding
        const prompt = dispatchPrompt({
          mode: 'local',
          taskId,
          taskDir,
          phase,
          round,
          agent: target,
          message: String(args.message).trim(),
          workspace,
          config,
          includeCharter: existingChild === undefined,
          worktrees: repoRows,
          ...(strategy ? { strategy } : {}),
        })
        if (existingChild === undefined) {
          usageLine = usageLineFor(undefined, undefined, 'new')
          const previousChildRecord = state.children?.[target.name]
          const childId = randomUUID()
          runtime.registerBinding(childId, { ...target, taskId })
          // Persist the provisional binding BEFORE creating the child so an
          // overlapping dispatch in another task sees the in-flight creation.
          state.children = {
            ...(state.children ?? {}),
            [target.name]: { id: childId, model: target.model, status: 'provisioning' },
          }
          await writeJson(join(taskDir, 'STATE.json'), state)
          try {
            const activation = await subagents.startActivation({
              provider: 'spawn',
              childId,
              name: spawnName,
              label: `${taskId}/${phase}/${target.name}`,
              prompt: [{ type: 'text', text: prompt }],
              parent: lead,
              ...activationOptions({
                policy: config.contextPolicy,
                parent: lead,
                executor: 'local',
                pinned,
                reasoning: target.reasoning,
                provider: 'spawn',
                subagents,
              }),
              ...(hasWorkspace ? { cwd: workspace } : {}),
              signal: exec.signal,
              delivery: 'parent',
            })
            sessionId = activation.childId
            state.children[target.name] = { id: childId, model: target.model, status: 'active' }
            mode = 'local'
          } catch (error) {
            // TR-14: roll back only this round's provisional id and restore the
            // previously proven record, so status/compact keep targeting it.
            runtime.unregisterBinding(childId)
            if (previousChildRecord !== undefined) {
              state.children[target.name] = previousChildRecord
            } else {
              delete state.children[target.name]
            }
            await writeJson(join(taskDir, 'STATE.json'), state).catch(() => {})
            throw error
          }
        } else {
          runtime.rebind(existingChild.id, { ...target, taskId })
          await moveTeammate(existingChild.id)
          // S6: sample the resumed child before the message is delivered, so a
          // live Agent gives live numbers and a cold id replays its last report.
          usageLine = sessionUsageLine(taskId, existingChild.id)
          await subagents.sendMessage(lead, existingChild.id, [{ type: 'text', text: prompt }], {
            signal: exec.signal,
          })
          sessionId = existingChild.id
          mode = 'local-resumed'
        }
        await appendFile(
          join(taskDir, 'RUNS.md'),
          `\n## ${new Date().toISOString()} ${target.name} (${target.role}) phase=${phase} round=${round} mode=${mode} model=${target.model} child=${sessionId}\n`,
          'utf8',
        ).catch(() => {})
      } else if (external) {
        const subagents = ctx.get('subagents')
        if (!subagents) {
          throw new Error(`外部 provider "${target.model}" 需要宿主 subagents 服务，但当前不可用。`)
        }
        const prompt = dispatchPrompt({
          mode: 'external',
          taskId,
          taskDir,
          phase,
          round,
          agent: target,
          message: String(args.message).trim(),
          workspace,
          config,
          worktrees: repoRows,
          ...(strategy ? { strategy } : {}),
        })
        usageLine = usageLineFor(undefined, undefined, 'external')
        const startedAt = Date.now()
        const tokensBefore =
          ['codex', 'codex-cli'].includes(target.model)
            ? await captureCodexTokens(startedAt - 600000)
            : undefined
        // An external `provider/model` form runs a ONE-SHOT pinned child:
        // fresh context on every dispatch, no name/binding, no children
        // entry — the continuable path is the local/team executors.
        const activation = await subagents.startActivation({
          provider: pinned ? 'spawn' : target.model,
          ...activationOptions({
            policy: config.contextPolicy,
            parent: lead,
            executor: 'external',
            pinned,
            reasoning: target.reasoning,
            provider: pinned ? 'spawn' : target.model,
            subagents,
          }),
          label: `${taskId}/${phase}/${target.name}`,
          prompt: [{ type: 'text', text: prompt }],
          parent: lead,
          ...(hasWorkspace ? { cwd: workspace } : {}),
          signal: exec.signal,
          delivery: background ? 'parent' : 'caller',
        })
        sessionId = activation.childId
        // Let already-settled runs take the inline path so fast providers keep
        // the old synchronous semantics (archives, token capture, errors).
        let settled = null
        let settledError = null
        activation.result.then(
          (value) => {
            settled = value
          },
          (error) => {
            settledError = error
          },
        )
        if (background) await new Promise((resolve) => setImmediate(resolve))
        if (background && settled === null && settledError === null) {
          // Still running: record the pending run and return immediately; the
          // result arrives as a message and the bookkeeping (PLAN-R archive,
          // verdict capture) is flushed by the next tool call.
          mode = 'external-background'
          asyncPending = true
          state.pendingRuns = [
            ...(Array.isArray(state.pendingRuns) ? state.pendingRuns : []),
            {
              phase,
              round,
              agent: target.name,
              role: target.role,
              childId: sessionId,
              at: new Date().toISOString(),
            },
          ]
          await appendFile(
            join(taskDir, 'RUNS.md'),
            `\n## ${new Date().toISOString()} ${target.name} (${target.role}) phase=${phase} round=${round} provider=${target.model} mode=background（结果将以后台消息送达 Lead）\n`,
            'utf8',
          ).catch(() => {})
        } else {
          let result
          try {
            if (settledError !== null) throw settledError
            result = settled ?? (await activation.result)
          } finally {
            try {
              await activation.dispose()
            } catch {}
          }
          if (result.stopReason !== 'completed') {
            throw new Error(
              `外部 agent ${target.name} 异常结束（${result.stopReason}）${result.diagnostic ? `：${result.diagnostic}` : ''}`,
            )
          }
          externalText = result.output
            .filter((block) => block?.type === 'text')
            .map((block) => block.text)
            .join('')
          if (['codex', 'codex-cli'].includes(target.model)) {
            const after = await captureCodexTokens(startedAt)
            tokens =
              after !== undefined
                ? tokensBefore !== undefined && after > tokensBefore
                  ? after - tokensBefore
                  : after
                : undefined
          }
          mode = 'external'
          await appendFile(
            join(taskDir, 'RUNS.md'),
            `\n## ${new Date().toISOString()} ${target.name} (${target.role}) phase=${phase} round=${round} provider=${target.model} tokens=${tokens ?? 'unknown'}\n\n${externalText || '（无文本输出）'}\n`,
            'utf8',
          ).catch(() => {})
          state.tokens = (state.tokens ?? 0) + (tokens ?? 0)
        }
        // An external dispatch obsoletes any stale continuable binding for
        // this name — the activity guard above proved it idle before we got
        // here, so drop both records instead of resuming a dead child later.
        if (state.children?.[target.name] !== undefined) {
          delete state.children[target.name]
        }
        if (state.members?.[target.name] !== undefined) {
          delete state.members[target.name]
        }
      } else if (!memberBinding) {
        // Team executor: a named continuable child on the Lead's subagent
        // tree (the 0.2.x replacement for agentTeams.spawnTeammate).
        const subagents = ctx.get('subagents')
        if (!subagents) {
          throw new Error('team 执行者需要宿主 subagents 服务，但当前不可用。')
        }
        const provider = target.context === 'fork' ? 'fork' : 'spawn'
        // S3: team spawn only caps the request; a fork also needs the host to
        // declare agentOptions support, otherwise fork semantics stay as-is.
        const teamOptions = activationOptions({
          policy: config.contextPolicy,
          parent: lead,
          executor: 'team',
          pinned: undefined,
          reasoning: target.reasoning,
          provider,
          subagents,
        })
        forkCapFallback =
          provider === 'fork' &&
          config.contextPolicy !== false &&
          requestCap(config.contextPolicy, lead) !== undefined &&
          teamOptions.agentOptions === undefined
        const childId = randomUUID()
        // Publish this round's snapshots before spawning so an agent/created
        // fired mid-spawn already installs the dispatched identity (R08); the
        // reserved child id gets the same task binding as a local child so the
        // automatic fallback can verify it before acting.
        runtime.registerBinding(childId, { ...target, taskId })
        runtime.setPending(spawnName, { ...target, taskId })
        let activation
        try {
          activation = await subagents.startActivation({
            provider,
            childId,
            name: spawnName,
            label: `${taskId}/${phase}/${target.name}`,
            prompt: [{ type: 'text', text: message }],
            parent: lead,
            ...teamOptions,
            ...(hasWorkspace ? { cwd: workspace } : {}),
            signal: exec.signal,
            delivery: 'parent',
          })
        } catch (error) {
          // Withdraw exactly this reserved id and clear the pending persona.
          runtime.unregisterBinding(childId)
          runtime.clearPending(spawnName)
          throw error
        } finally {
          runtime.clearPending(spawnName)
        }
        mode = 'spawned'
        usageLine = usageLineFor(undefined, undefined, 'new')
        sessionId = activation.childId
        state.members = { ...(state.members ?? {}), [target.name]: { id: sessionId } }
        await moveTeammate(sessionId)
        // Team members carry the dispatch-time settings snapshot, exactly like
        // local children, so later edits cannot restyle their identity (R08).
        runtime.rebind(sessionId, { ...target, taskId })
      } else {
        const subagents = ctx.get('subagents')
        if (!subagents) {
          throw new Error('team 执行者需要宿主 subagents 服务，但当前不可用。')
        }
        await moveTeammate(memberBinding.id)
        // Idle resume: refresh the binding and identity section to this
        // round's snapshot before the message is delivered (R08). The task
        // record is kept as the single team binding for this member.
        runtime.rebind(memberBinding.id, { ...target, taskId })
        state.members = { ...(state.members ?? {}), [target.name]: { id: memberBinding.id } }
        // S6: sample before delivery (live Agent) or replay the last report.
        usageLine = sessionUsageLine(taskId, memberBinding.id)
        await subagents.sendMessage(
          lead,
          memberBinding.id,
          [{ type: 'text', text: message }],
          { signal: exec.signal },
        )
        mode = 'resumed'
        sessionId = memberBinding.id
      }

      // TR-10: the round succeeded. Withdraw the runtime compression binding
      // of every superseded id so its pre-step can no longer fall back into
      // the squad's automatic compaction; the active id keeps its binding.
      {
        const activeBindingId =
          mode === 'local' || mode === 'local-resumed' || mode === 'spawned' || mode === 'resumed'
            ? sessionId
            : undefined
        for (const oldRecord of [recordedChild, recordedMember]) {
          if (oldRecord?.id && oldRecord.id !== activeBindingId) {
            runtime.unregisterBinding(oldRecord.id)
          }
        }
      }
      if (phase === 'review') {
        // Full flow: bind the business acceptance to the code/spec version it
        // examined (recorded at dispatch, also for background rounds); a later
        // implement/rework/spec dispatch makes it stale.
        if (flow.specRequired) {
          state.businessReview = {
            codeEpoch: Number(state.codeEpoch ?? 0),
            specVersion: Number(state.specVersion ?? 0),
            reviewer: target.name,
            at: new Date().toISOString(),
          }
        }
        if (!asyncPending) {
          const reviewText = await readFile(join(taskDir, 'REVIEW.md'), 'utf8').catch(() => '')
          const verdicts = [
            ...reviewText.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi),
          ]
          state.lastVerdict = verdicts.at(-1)?.[1]?.toUpperCase() ?? null
          if (reviewText) {
            await writeFile(join(taskDir, `REVIEW-R${round}.md`), reviewText, 'utf8').catch(() => {})
          }
        }
      }
      if (phase === 'acceptance') {
        const steps =
          state.acceptanceSteps && typeof state.acceptanceSteps === 'object'
            ? state.acceptanceSteps
            : { tech: null, biz: null }
        if (target.role === 'tester') {
          // A technical step starts a new round whenever the previous one
          // concluded (its business step ran); otherwise it opens round 1.
          const previousComplete = Number(state.acceptanceRounds ?? 0) > 0 && steps.biz !== null
          state.acceptanceRounds = previousComplete
            ? Number(state.acceptanceRounds) + 1
            : Math.max(1, Number(state.acceptanceRounds ?? 0))
          state.acceptanceSteps = { tech: target.name, biz: null }
        } else {
          state.acceptanceSteps = { ...steps, biz: target.name }
        }
        state.acceptance = {
          codeEpoch: Number(state.codeEpoch ?? 0),
          specVersion: Number(state.specVersion ?? 0),
          round: Number(state.acceptanceRounds ?? 1),
          at: new Date().toISOString(),
        }
        if (!asyncPending && target.role === 'brain') {
          const reportText = await readFile(join(taskDir, 'ACCEPTANCE-REPORT.md'), 'utf8').catch(() => '')
          const reportVerdicts = [
            ...reportText.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi),
          ]
          state.lastAcceptanceVerdict = reportVerdicts.at(-1)?.[1]?.toUpperCase() ?? null
          if (reportText) {
            await writeFile(
              join(taskDir, `ACCEPTANCE-REPORT-R${state.acceptanceRounds}.md`),
              reportText,
              'utf8',
            ).catch(() => {})
          }
        }
      }
      if (phase === 'test-review') {
        state.testReview = {
          codeEpoch: Number(state.codeEpoch ?? 0),
          specVersion: Number(state.specVersion ?? 0),
          reviewer: target.name,
          at: new Date().toISOString(),
        }
        if (!asyncPending) {
          const testText = await readFile(join(taskDir, 'TEST-REVIEW.md'), 'utf8').catch(() => '')
          const testVerdicts = [
            ...testText.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi),
          ]
          state.lastTestVerdict = testVerdicts.at(-1)?.[1]?.toUpperCase() ?? null
          if (testText) {
            await writeFile(join(taskDir, `TEST-REVIEW-R${round}.md`), testText, 'utf8').catch(() => {})
          }
        }
      }
      if (phase === 'tech-review') {
        state.techReview = {
          codeEpoch: Number(state.codeEpoch ?? 0),
          specVersion: Number(state.specVersion ?? 0),
          reviewer: target.name,
          at: new Date().toISOString(),
        }
        if (!asyncPending) {
          const techText = await readFile(join(taskDir, 'TECH-REVIEW.md'), 'utf8').catch(() => '')
          const techVerdicts = [
            ...techText.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi),
          ]
          state.lastTechVerdict = techVerdicts.at(-1)?.[1]?.toUpperCase() ?? null
          if (techText) {
            await writeFile(join(taskDir, `TECH-REVIEW-R${round}.md`), techText, 'utf8').catch(() => {})
          }
        }
      }
      state.phase = phase
      state.round = round
      // Design accounting: increment only after a successful dispatch. For
      // external executors the current PLAN.md is archived synchronously as
      // PLAN-R<n>.md; an archive failure throws (the dispatch already ran) and
      // leaves planRounds unchanged. Local/team designs count on delivery and
      // are archived at approve time instead.
      let planRound
      if (phase === 'design') {
        planRound = plan.planRounds + 1
        if (external && !asyncPending) {
          try {
            const planText = await readFile(join(taskDir, 'PLAN.md'), 'utf8')
            await writeFile(join(taskDir, `PLAN-R${planRound}.md`), planText, 'utf8')
          } catch (error) {
            throw new Error(
              `design 派单已派发成功，但归档 PLAN-R${planRound}.md 失败：${error instanceof Error ? error.message : String(error)}。planRounds 未增加；请补写 PLAN.md 后重试 design。不会自动重派。`,
            )
          }
        }
        state.planRounds = planRound
      }
      // Spec accounting: every spec dispatch publishes a new version; external
      // executors archive SPEC.md synchronously as SPEC-V<n>.md (an archive
      // failure throws with specVersion unchanged, mirroring design). Spec
      // revisions consume no rework quota.
      let specVersion
      if (phase === 'spec') {
        specVersion = Number(state.specVersion ?? 0) + 1
        if (external && !asyncPending) {
          try {
            const specText = await readFile(join(taskDir, 'SPEC.md'), 'utf8')
            await writeFile(join(taskDir, `SPEC-V${specVersion}.md`), specText, 'utf8')
          } catch (error) {
            throw new Error(
              `spec 派单已派发成功，但归档 SPEC-V${specVersion}.md 失败：${error instanceof Error ? error.message : String(error)}。specVersion 未增加；请补写 SPEC.md 后重试 spec。不会自动重派。`,
            )
          }
        }
        state.specVersion = specVersion
        state.specPublished = true
      }
      // Code epoch: every implementation/rework dispatch (worker or the
      // tester taking over) advances the candidate code version, so both
      // acceptance bindings go stale until re-examined.
      if (phase === 'implement' || phase === 'rework') {
        state.codeEpoch = Number(state.codeEpoch ?? 0) + 1
        const implementers = Array.isArray(state.implementers) ? state.implementers : []
        if (!implementers.includes(target.name)) {
          state.implementers = [...implementers, target.name]
        }
      }
      if (phase === 'rework') {
        if (flow.specRequired || flow.acceptance) {
          if (reworkKind === 'business') {
            state.businessReworkRounds = budget.businessUsed + 1
          } else {
            state.techReworkRounds = budget.techUsed + 1
          }
        } else {
          state.reworkRounds = priorRework + 1
        }
      }
      // TECH-01: after a successful (re)dispatch exactly one binding kind may
      // remain for this member. Withdraw the idle stale record of the other
      // executor so status/compact never see a mixed identity (R07).
      if (executor !== 'local' && state.children?.[target.name] && !childBusy) {
        delete state.children[target.name]
      }
      if (executor !== 'team' && state.members?.[target.name]) {
        delete state.members[target.name]
      }
      state.dispatches.push({
        at: new Date().toISOString(),
        agent: target.name,
        role: target.role,
        phase,
        round,
        mode,
        ...(planRound === undefined ? {} : { planRound }),
        ...(specVersion === undefined ? {} : { specVersion }),
        ...(reworkKind ? { reworkKind } : {}),
        ...(feature ? { feature: feature.name } : {}),
        ...(substitutions.length > 0
          ? { substitutedFrom: substitutions.map((item) => item.from), substitutionReason: substitutions.at(-1).reason }
          : {}),
        ...(external ? { provider: target.model } : {}),
        ...(tokens === undefined ? {} : { tokens }),
      })
      if (state.dispatches.length > 50) state.dispatches = state.dispatches.slice(-50)
      await writeJson(join(taskDir, 'STATE.json'), state)
      await appendFile(
        join(taskDir, 'JOURNAL.md'),
        `- ${new Date().toISOString()} lead → ${target.name} (${target.role}) phase=${phase} round=${round} mode=${mode}${reworkKind ? ` kind=${reworkKind}` : ''}${substitutions.length > 0 ? ` substituted_from=${substitutions.map((item) => item.from).join(',')}` : ''}\n`,
        'utf8',
      ).catch(() => {})
      await writeProgress({ ctx, lead, taskDir, state, signal: exec.signal })

      const reworkLine = flow.specRequired || flow.acceptance
        ? `rework: tech=${state.techReworkRounds ?? 0}/${budget.techLimit} business=${state.businessReworkRounds ?? 0}/${budget.businessLimit}`
        : `rework=${state.reworkRounds ?? 0}/${budget.reworkLimit}`
      const actingLine =
        phase === 'test-review' && target.role === 'brain'
          ? ['（代行测试验收职责：测试者挂起，交付 TEST-REVIEW.md）']
          : phase === 'tech-review' && target.role === 'tester'
            ? ['（代签技术验收：brain 已在本任务写代码）']
            : []
      const gateLines = []
      if (substitutions.length > 0) {
        gateLines.push(
          `[可用性门禁] ${substitutions.map((item) => `${item.from} 不可用（${item.reason}）`).join('；')}→ 已上报，并自动改由 ${target.name} 执行本轮任务。`,
        )
        gateLines.push(
          `已记录为不可用（其他轮次也会自动绕开）；用户确认恢复后 squad_failover({ agent: "${substitutions[0].from}", recover: true }) 解除。`,
        )
      }
      if (probeNote) gateLines.push(probeNote)
      const phaseLines = [
        ...(phase === 'design'
          ? [`planRounds=${state.planRounds}/${budget.designLimit}（Lead 审核后用 squad_approve_plan 批准）`]
          : []),
        ...(phase === 'spec'
          ? [`specVersion=${state.specVersion}${external ? `（已归档 SPEC-V${state.specVersion}.md）` : ''}（发布后即可派工，不需要 Lead 再审批）`]
          : []),
        ...(phase === 'acceptance'
          ? [`acceptance: 轮次=${state.acceptanceRounds ?? 1} 技术维度=${state.acceptanceSteps?.tech ?? '—'} 业务维度=${state.acceptanceSteps?.biz ?? '—'} verdict=${state.lastAcceptanceVerdict ?? '—'}（以 ACCEPTANCE-REPORT.md 为准；修复 rework 后需重走双验收）`]
          : []),
        ...(phase === 'test-review'
          ? [`testReview: codeEpoch=${state.codeEpoch ?? 0} specVersion=${state.specVersion ?? 0}${state.lastTestVerdict ? ` verdict=${state.lastTestVerdict}` : ''}（verdict 以 TEST-REVIEW.md 为准；技术验收前必须 APPROVED 且新鲜）`]
          : []),
        ...(phase === 'tech-review'
          ? [`techReview: codeEpoch=${state.codeEpoch ?? 0} specVersion=${state.specVersion ?? 0}${state.lastTechVerdict ? ` verdict=${state.lastTechVerdict}` : ''}（verdict 以 TECH-REVIEW.md 为准）`]
          : []),
      ]
      if (mode === 'local' || mode === 'local-resumed') {
        return [
          `${mode === 'local' ? '已创建' : '已续跑'}本地子代理 ${target.name} [${target.role}] model=${target.model} session=${sessionId}`,
          `task=${taskId} phase=${phase} round=${round} ${reworkLine}`,
          ...(usageLine ? [usageLine] : []),
          ...(forkCapFallback ? ['fork 继承输出预留：宿主未声明 agentOptions 能力，本轮未注入 maxTokens；保留 fork 语义。'] : []),
          ...gateLines,
          ...phaseLines,
          ...actingLine,
          `workspace=${workspace}`,
          '它完成后会以完成通知唤醒你；返工用同一 child id 续跑。',
        ].join('\n')
      }
      if (mode === 'external-background') {
        return [
          `已后台派发 ${target.displayName} (${target.name}) [${target.role}] provider=${target.model}（不阻塞，可继续派其他队友）`,
          `task=${taskId} phase=${phase} round=${round} ${reworkLine}`,
          ...(usageLine ? [usageLine] : []),
          ...(forkCapFallback ? ['fork 继承输出预留：宿主未声明 agentOptions 能力，本轮未注入 maxTokens；保留 fork 语义。'] : []),
          ...gateLines,
          ...phaseLines,
          ...actingLine,
          `workspace=${workspace}`,
          '结果完成时会以后台消息送达；期间可用 squad_status 查看，squad_finish 会等它结束。异常结束也会以消息告知。',
        ].join('\n')
      }
      if (external) {
        const clipped =
          externalText.length > 3000
            ? `${externalText.slice(0, 3000)}\n…（已截断，全文见 RUNS.md）`
            : externalText
        return [
          `已外部派发 ${target.displayName} (${target.name}) [${target.role}] provider=${target.model}（一次性，不续跑）`,
          `task=${taskId} phase=${phase} round=${round} tokens=${tokens ?? 'unknown'} totalTokens=${state.tokens ?? 0}`,
          ...(usageLine ? [usageLine] : []),
          ...(forkCapFallback ? ['fork 继承输出预留：宿主未声明 agentOptions 能力，本轮未注入 maxTokens；保留 fork 语义。'] : []),
          ...gateLines,
          ...phaseLines,
          ...actingLine,
          `workspace=${workspace}`,
          '输出：',
          clipped || '（无文本输出）',
        ].join('\n')
      }
      return [
        `${mode === 'spawned' ? '已创建' : '已续跑'} ${target.name} [${target.role}] session=${sessionId}`,
        `task=${taskId} phase=${phase} round=${round} ${reworkLine}`,
        ...(usageLine ? [usageLine] : []),
        ...(forkCapFallback ? ['fork 继承输出预留：宿主未声明 agentOptions 能力，本轮未注入 maxTokens；保留 fork 语义。'] : []),
        ...gateLines,
        ...phaseLines,
        ...actingLine,
        `workspace=${workspace}`,
        '队友完成后会调用 squad_report。结束本回合等报告；需要查看时用 squad_status。',
      ].join('\n')
    },
  })

  // R07: process-local dispatch lock keyed by Lead + fixed agent id. It closes
  // the window between the STATE read and the provisional provisioning record,
  // which a persisted record alone cannot cover. Held only for this call.
  // Failover: a tester dispatch that dies with a quota-like error (额度
  // exhausted, 429, insufficient balance…) auto-suspends that tester and
  // enriches the error with the handover guidance; the brain then covers the
  // hands test acceptance to the brain for the remaining phases.
  const dispatchInFlight = new Set()
  const dispatchExecute = dispatch.execute
  dispatch.execute = async (args, exec) => {
    const lead = exec.agent
    if (!lead) return dispatchExecute(args, exec)
    const key = `${lead.id}:${String(args.agent ?? '')}`
    if (dispatchInFlight.has(key)) {
      throw new Error(`目标 ${args.agent} 已有派发在进行中，请等待它返回。`)
    }
    dispatchInFlight.add(key)
    try {
      return await dispatchExecute(args, exec)
    } catch (error) {
      const name = String(args.agent ?? '')
      const message = error instanceof Error ? error.message : String(error)
      let handover = null
      try {
        const roster = settingsRoster(await store.read(), config)
        const target = roster.find((agent) => agent.name === name)
        if (
          target?.role === 'tester' &&
          !runtime.isSuspended(name) &&
          QUOTA_ERROR.test(message)
        ) {
          await runtime.suspendAgent(name, `派单失败自动挂起：${firstLine(message)}`, true, target.role)
          handover = `${message}\n[${name} 已因额度问题自动挂起] 测试验收职责改由 brain 代行：重派 squad_dispatch({ agent: "brain", phase: "test-review", … })；用户确认恢复后 squad_failover({ agent: "${name}", recover: true })。`
        }
      } catch {}
      if (handover) throw new Error(handover)
      throw error
    } finally {
      dispatchInFlight.delete(key)
    }
  }

  const status = defineTool({
    name: 'squad_status',
    description:
      '查看小队状态：当前任务、阶段/轮次、返工计数、队友可用性、共享记忆文件，以及已配置的全部 agent（含尚未创建的）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const lead = callingAgent(exec, 'squad_status')
      const directory = await memoryDirectory(ctx, lead, config)
      const settings = await store.read()
      const roster = settingsRoster(settings, config)
      const rosterLine = roster.length
        ? roster
            .map(
              (agent) =>
                `- ${agent.displayName} (${agent.name}) [${agent.role}] executor=${agent.executor}${
                  agent.model ? ` model=${agent.model}` : ''
                } ${clip(agent.description, 90) || '无描述'}`,
            )
            .join('\n')
        : '- （无）'
      const current = await readJson(join(directory, 'current.json'))
      if (!current?.taskId) {
        return `暂无小队任务。当前目录：${sessionDirectory(ctx, lead)}\n已配置 agent：\n${rosterLine}\n\n先调用 squad_start。`
      }
      const taskId = current.taskId
      const taskDir = join(directory, taskId)
      const state = (await readJson(join(taskDir, 'STATE.json'))) ?? {}
      const plan = planGateOf(state)
      /** True when this round's result is still running in the background. */
      const budget = budgetOf(state)
      const flow = flowOf(state)
      const techVerdict = flow.specRequired ? await readVerdict(taskDir, 'TECH-REVIEW.md') : undefined
      const businessVerdict = await readVerdict(taskDir, 'REVIEW.md')
      const testVerdict = flow.specRequired ? await readVerdict(taskDir, 'TEST-REVIEW.md') : undefined
      const extensions = Array.isArray(state.extensions) ? state.extensions : []
      const treeRows = await treeRowsOf(ctx, lead)
      const backgroundRunning = treeRows.filter(
        (row) => row.activity === 'running' && row.name === undefined,
      ).length
      const childIds = new Set(
        Object.values(state.children ?? {}).map((child) => child.id),
      )
      const memberRows = memberRowsOf(
        treeRows.filter((row) => !childIds.has(row.id)),
        runtime,
        config,
      )
      const repoRows = worktreesOf(state)
      const workspaceBlock =
        repoRows.length > 1
          ? [
              `工作区：${workspaceOf(state, sessionDirectory(ctx, lead))}`,
              ...repoLines(repoRows),
            ]
          : state.worktree
            ? [`工作区：worktree ${state.worktree.branch} @ ${state.worktree.path}（源仓库 ${state.worktree.repositoryRoot}）`]
            : ['工作区：原地开发']
      await flushPendingRuns({ ctx, lead, taskDir, state, signal: undefined }).catch(() => {})
      const progressBlock = await renderProgress({ taskDir, state, rows: treeRows })
      // Multi-task overview: every non-finished task stays addressable.
      let otherTasks = []
      try {
        const registry = await readTaskRegistry(store)
        for (const [id, row] of Object.entries(registry.tasks)) {
          if (id === taskId || row.active !== true) continue
          const otherState = row.memoryRoot
            ? await readJson(join(row.memoryRoot, id, 'STATE.json'))
            : undefined
          otherTasks.push(
            `- ${id}  phase=${otherState?.phase ?? '?'}  round=${otherState?.round ?? '?'}  ${progressSummaryOf(otherState ?? { phase: '?' })}`,
          )
        }
      } catch {}
      // S6: usage for this task's own ids only. Cold members absent from the
      // tree rows still get their line so the block is complete.
      const memberUsageById = new Map()
      const coldMemberLines = []
      if (autoUsage) {
        for (const [memberName, record] of Object.entries(state.members ?? {})) {
          if (!record?.id) continue
          const memberLine = sessionUsageLine(taskId, record.id)
          memberUsageById.set(record.id, memberLine)
          if (!treeRows.some((row) => row.id === record.id)) {
            const memberRole =
              state.participantRoles?.[memberName] ?? runtime.bindingOf(record.id)?.role ?? 'teammate'
            coldMemberLines.push(`- ${memberName} [${memberRole}] cold | ${memberLine}`)
          }
        }
      }
      const lines = [
        `${PLUGIN_MARKER}  task=${taskId}  phase=${state.phase ?? 'unknown'}  round=${state.round ?? '?'}  flow=${flow.flow}  created=${state.createdAt ?? '?'}`,
        ...progressBlock.split('\n'),
        (() => {
          const features = Array.isArray(state.features) ? state.features : []
          if (state.baseDelivered) {
            return `并行：Base 已交付（${state.baseDelivered.summary ?? ''} @ ${state.baseDelivered.at}）；特性：${
              features.length === 0
                ? '无'
                : features
                    .map((item) => `${item.name}${item.merged ? `（已合并 ${item.commit ?? ''}）` : '（并行中）'}`)
                    .join('、')
            }`
          }
          return features.length > 0
            ? `并行：基础层未交付；特性：${features.map((item) => item.name).join('、')}`
            : '并行：串行阶段（基础层）'
        })(),
        (() => {
          const rows = runtime.suspendedRows()
          return rows.length === 0
            ? '挂起：无'
            : `挂起：${rows
                .map(
                  (row) =>
                    `${row.name}（自 ${row.at}；${row.auto ? '自动' : '手动'}；原因：${clip(row.reason, 60)}）→ ${
                      row.role === 'tester' ? '测试验收职责由 brain 代行' : '派单将自动改由其他 worker 执行'
                    }`,
                )
                .join('；')}`
        })(),
        `PLAN：planRequired=${plan.planRequired}  planRounds=${plan.planRounds}/${budget.designLimit}  planApproved=${plan.planApproved}${
          plan.planApproved
            ? `  planApprovedAt=${plan.planApprovedAt ?? '?'}（已归档 PLAN-APPROVED.md）`
            : plan.planRequired
              ? '（未批准：implement/rework 会被拒绝，先 squad_approve_plan）'
              : ''
        }`,
        ...(flow.acceptance
          ? [
              `模式：acceptance（以 AUTHORITY.md 权威方案为准，brain 不产出设计）  codeEpoch=${state.codeEpoch ?? 0}  implementers=${(Array.isArray(state.implementers) ? state.implementers : []).join(',') || '—'}`,
              `双验收：第 ${state.acceptanceRounds ?? 0} 轮  技术维度=${state.acceptanceSteps?.tech ?? '未开始'}  业务维度=${state.acceptanceSteps?.biz ?? '未开始'}`,
              `验收报告：${bindingFresh(state.acceptance, state) ? '新鲜' : '失效/未定稿'}  verdict=${(await readVerdict(taskDir, 'ACCEPTANCE-REPORT.md')) ?? state.lastAcceptanceVerdict ?? '—'}（ACCEPTANCE-REPORT.md）`,
              `预算：验收返工上限=${budget.techLimit} 已用=${budget.techUsed} 剩余=${Math.max(0, budget.techLimit - budget.techUsed)}`,
            ]
          : flow.specRequired
          ? [
              `SPEC：specRequired=true  specPublished=${state.specPublished === true}  specVersion=${state.specVersion ?? 0}  codeEpoch=${state.codeEpoch ?? 0}  implementers=${(Array.isArray(state.implementers) ? state.implementers : []).join(',') || '—'}`,
              `测试验收：${bindingFresh(state.testReview, state) ? '新鲜' : '失效/未验收'}  verdict=${testVerdict ?? state.lastTestVerdict ?? '—'}  reviewer=${state.testReview?.reviewer ?? '—'}（TEST-REVIEW.md）`,
              `技术验收：${bindingFresh(state.techReview, state) ? '新鲜' : '失效/未验收'}  verdict=${techVerdict ?? state.lastTechVerdict ?? '—'}  reviewer=${state.techReview?.reviewer ?? '—'}（TECH-REVIEW.md）`,
              `业务验收：${bindingFresh(state.businessReview, state) ? '新鲜' : '失效/未验收'}  verdict=${businessVerdict ?? state.lastVerdict ?? '—'}  reviewer=${state.businessReview?.reviewer ?? '—'}（REVIEW.md）`,
              `预算：design 上限=${budget.designLimit} 已用=${budget.designUsed}；tech 上限=${budget.techLimit} 已用=${budget.techUsed} 剩余=${Math.max(0, budget.techLimit - budget.techUsed)}；business 上限=${budget.businessLimit} 已用=${budget.businessUsed} 剩余=${Math.max(0, budget.businessLimit - budget.businessUsed)}`,
            ]
          : [
              `预算：design 上限=${budget.designLimit} 已用=${budget.designUsed} 剩余=${Math.max(0, budget.designLimit - budget.designUsed)}；implement 上限=${budget.reworkLimit} 已用=${budget.implementUsed} 剩余=${Math.max(0, budget.reworkLimit - budget.implementUsed)}`,
            ]),
        ...(extensions.length === 0
          ? ['最近扩展：无']
          : [
              '最近扩展（最多 6 条）：',
              ...extensions.slice(-6).map(
                (item) => `- ${item.at} kind=${item.kind} rounds=${item.rounds} reason=${item.reason}`,
              ),
            ]),
        ...(otherTasks.length > 0 ? ['其他活动任务（用 task_id 寻址）：', ...otherTasks] : []),
        `当前目录：${sessionDirectory(ctx, lead)}`,
        ...(backgroundRunning > 0
          ? [`后台执行器运行中：${backgroundRunning} 个（background 派发，结果将以消息送达；squad_finish 会等待）`]
          : []),
        ...workspaceBlock,
        `共享记忆：${taskDir}`,
        '成员：',
        formatMembers(memberRows, autoUsage ? memberUsageById : undefined),
        ...(coldMemberLines.length > 0 ? coldMemberLines : []),
        '本地子代理：',
        state.children
          ? Object.entries(state.children)
              .map(([name, child]) => {
                const row = treeRows.find((entry) => entry.id === child.id)
                const status =
                  child.status === 'provisioning'
                    ? 'provisioning'
                    : row === undefined
                      ? 'cold'
                      : row.activity === 'running'
                        ? 'running'
                        : 'inactive'
                const contextLine = autoUsage ? sessionUsageLine(taskId, child.id) : null
                return `- ${name} → ${child.id} (${child.model}) ${status}${contextLine ? ` | ${contextLine}` : ''}`
              })
              .join('\n')
          : '- （无）',
        `文件：${await fileSummary(taskDir)}`,
        `累计 tokens（Codex session 统计）：${state.tokens ?? 0}`,
        `最后验收结论：${flow.specRequired ? `技术=${state.lastTechVerdict ?? '—'} 业务=${state.lastVerdict ?? '—'}` : state.lastVerdict ?? '—'}`,
        '已配置 agent：',
        rosterLine,
      ]
      const recent = Array.isArray(state.dispatches) ? state.dispatches.slice(-6) : []
      if (recent.length > 0) {
        lines.push('最近派单：')
        for (const item of recent) {
          const externalRow = item.mode === 'external' || item.mode === 'external-background'
          const contextLine =
            autoUsage && externalRow ? usageLineFor(undefined, undefined, 'external') : null
          lines.push(
            `- ${item.at} ${item.agent} (${item.role}) phase=${item.phase} round=${item.round} ${item.mode}${contextLine ? ` | ${contextLine}` : ''}`,
          )
        }
      }
      return lines.join('\n')
    },
  })

  const compact = defineTool({
    name: 'squad_compact',
    description:
      '仅 Lead：对单个本任务队友会话做一次人工压缩。默认压缩当前任务的队友；task_id 可指定其它活动任务。local/team 队友走宿主 compaction.compactNow（先按需修剪工具输出，再摘要），返回压缩前后上下文用量与 shadowedTokens/Seqs；队友运行中返回 busy，冷会话不唤醒，external 一次性执行者不可压缩。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['agent'],
      properties: {
        agent: { type: 'string', enum: ['brain', 'tester', 'worker1', 'front1', 'worker2'] },
        task_id: { type: 'string', minLength: 1 },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_compact')
      const memberName = typeof args.agent === 'string' ? args.agent.trim() : ''
      if (!MEMBER_IDS.has(memberName)) {
        throw new Error(
          'squad_compact 的 agent 必须是固定成员 id（brain/tester/worker1/front1/worker2）；不能压缩 Lead 自身。',
        )
      }
      for (const key of Object.keys(args)) {
        if (key !== 'agent' && key !== 'task_id') {
          throw new Error(`squad_compact 不接受参数 "${key}"。`)
        }
      }
      if (
        args.task_id !== undefined &&
        (typeof args.task_id !== 'string' || args.task_id.trim() === '')
      ) {
        throw new Error('squad_compact 的 task_id 必须是非空字符串。')
      }
      if (!runtime.isLeadEnabled(lead.id)) {
        throw new Error('squad_compact 仅允许已启用小队的 Lead 调用。')
      }
      let isRoot = false
      try {
        isRoot = ctx.get('subagents')?.rootOf(lead)?.id === lead.id
      } catch {}
      if (!isRoot) throw new Error('squad_compact 仅允许 Lead 调用。')

      // One operation budget shared by discovery and compaction (S5).
      const timeout = AbortSignal.timeout(COMPACT_TIMEOUT_MS)
      const signal = exec.signal ? AbortSignal.any([exec.signal, timeout]) : timeout
      // TECH-02: AbortSignal.any keeps the FIRST abort reason. Only a
      // timeout-originated combined abort is a tool timeout; a caller cancel
      // that happened before the budget stays a cancellation.
      const abortedResult = () => {
        if (!signal.aborted) return null
        if (timeout.aborted && signal.reason === timeout.reason) return '压缩超时（180 秒）'
        return '已取消压缩'
      }
      const prunedSuffix = (count) => (count > 0 ? `\n已修剪=${count}，请复查` : '')

      const resolved = await resolveTask({
        ctx,
        agent: lead,
        config,
        store,
        explicitTaskId: args.task_id === undefined ? undefined : args.task_id.trim(),
      })
      const stopAfterResolve = abortedResult()
      if (stopAfterResolve) return stopAfterResolve
      const { taskId, taskDir } = resolved
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const state = await readJson(join(taskDir, 'STATE.json'))
      const stopAfterState = abortedResult()
      if (stopAfterState) return stopAfterState
      if (!state) throw new Error(`未知小队任务 "${taskId}"。先调用 squad_start。`)
      if (state.taskId !== undefined && state.taskId !== taskId) {
        throw new Error(`任务 ${taskId} 的 STATE 记录不一致，未压缩。`)
      }
      if (state.phase === 'done') throw new Error(`任务 ${taskId} 已经收尾，不能人工压缩。`)
      const registry = await readTaskRegistry(store)
      const stopAfterRegistry = abortedResult()
      if (stopAfterRegistry) return stopAfterRegistry
      if (registry.tasks[taskId]?.active === false) {
        throw new Error(`任务 ${taskId} 已结束，不能人工压缩。`)
      }
      const settings = await store.read()
      const stopAfterSettings = abortedResult()
      if (stopAfterSettings) return stopAfterSettings
      const roster = settingsRoster(settings, config)
      const rosterAgent = roster.find((agent) => agent.name === memberName)
      if (!rosterAgent) throw new Error(`未知 agent "${memberName}"。`)
      const dispatches = Array.isArray(state.dispatches) ? state.dispatches : []
      const last = [...dispatches].reverse().find((item) => item.agent === memberName)
      if (
        last?.mode === 'external' ||
        last?.mode === 'external-background' ||
        (last === undefined && rosterAgent.executor === 'external')
      ) {
        return 'external：一次性执行者不可人工压缩'
      }
      let record
      if (last?.mode === 'local' || last?.mode === 'local-resumed') {
        record = state.children?.[memberName]
      } else if (last?.mode === 'spawned' || last?.mode === 'resumed') {
        record = state.members?.[memberName]
      } else {
        const childRecord = state.children?.[memberName]
        const memberRecord = state.members?.[memberName]
        if (childRecord?.id && memberRecord?.id && childRecord.id !== memberRecord.id) {
          return '目标不唯一，未压缩'
        }
        record = childRecord ?? memberRecord
      }
      if (!record?.id) return '队友尚无本任务会话'
      if (record.status === 'provisioning') return 'busy：队友运行中，稍后再试'

      const subagents = ctx.get('subagents')
      let rows = []
      try {
        if (subagents && typeof subagents.listDescendants === 'function') {
          rows = await subagents.listDescendants(lead.id, signal)
        }
      } catch {
        rows = []
      }
      const stopAfterTree = abortedResult()
      if (stopAfterTree) return stopAfterTree
      const treeRow = rows.find(
        (entry) =>
          entry.id === record.id && entry.kind === 'child' && entry.mode === 'continuable',
      )
      if (record.id === lead.id) return '目标不属于本任务的小队'
      const binding = runtime.bindingOf(record.id)
      if (binding && (binding.taskId !== taskId || binding.name !== memberName)) {
        return '目标不属于本任务的小队'
      }
      const target = ctx.agents.get(record.id)
      let treeRoot
      try {
        treeRoot = subagents?.rootOf(target)
      } catch {
        treeRoot = undefined
      }
      if (target && treeRoot?.id !== lead.id) return '目标不属于本任务的小队'
      if (!treeRow) {
        return target ? '目标不属于本任务的小队' : 'cold：会话未驻留，不能人工压缩'
      }
      if (!target) return 'cold：会话未驻留，不能人工压缩'
      if (target.status === 'running') return 'busy：队友运行中，稍后再试'
      const compaction = ctx.get('compaction')
      if (!compaction || typeof compaction.compactNow !== 'function') {
        return '不可用：缺少 compaction.compactNow'
      }
      const policy = config.contextPolicy === false ? CONTEXT_POLICY_DEFAULTS : config.contextPolicy
      const before = contextUsageOf(ctx, { agent: target, binding, policy, kind: 'live' })
      const pruner = ctx.get('toolResultPruner')
      const hasPruner = Boolean(pruner && typeof pruner.pruneSession === 'function')
      let pruneNote = null
      if (!hasPruner) pruneNote = '未修剪：toolResultPruner 不可用'
      else if (typeof target.runMaintenance !== 'function') {
        pruneNote = '未修剪：缺少安全维护能力'
      }
      let pruned = 0
      // TR-12: prune status is its own axis, independent from the termination
      // reason: not-started / started-but-unfinished / completed-with-count.
      let pruneState = 'not-started'
      if (pruneNote === null) {
        let entered = false
        let maintenanceCancelled = false
        // TR-11: keep the maintenance signal itself, not a snapshot boolean;
        // it can be aborted between the callback returning and the short
        // maintenance releasing (e.g. from a microtask scheduled by pruning).
        let maintenanceSignalRef
        try {
          await target.runMaintenance(async (maintenanceSignal) => {
            entered = true
            maintenanceSignalRef = maintenanceSignal
            if (signal.aborted || maintenanceSignal?.aborted) {
              maintenanceCancelled = true
              return
            }
            pruneState = 'started'
            const result = pruner.pruneSession(target.session)
            pruned = Array.isArray(result?.pruned) ? result.pruned.length : 0
            pruneState = 'completed'
            if (signal.aborted || maintenanceSignal?.aborted) maintenanceCancelled = true
          })
        } catch {
          // TR-15: the saved maintenance signal also decides the first line
          // when the callback throws after its own cancellation; a tool
          // timeout (combined signal) keeps priority. The prune state decides
          // only the appended evidence line.
          const stop = abortedResult() ?? (maintenanceSignalRef?.aborted ? '已取消压缩' : null)
          const partial =
            pruneState === 'started'
              ? '\n修剪结果未知，请复查'
              : prunedSuffix(pruned)
          if (stop) return `${stop}${partial}`
          if (!entered) return 'busy：队友运行中，稍后再试'
          return `修剪失败，请复查${partial}`
        }
        // Re-read both signals after the maintenance promise settles: an abort
        // triggered while unwinding must still prevent compactNow.
        if (maintenanceSignalRef?.aborted || signal.aborted) maintenanceCancelled = true
        if (maintenanceCancelled) {
          const stop = abortedResult() ?? '已取消压缩'
          return `${stop}${prunedSuffix(pruned)}`
        }
        const stopAfterPrune = abortedResult()
        if (stopAfterPrune) return `${stopAfterPrune}${prunedSuffix(pruned)}`
        if (target.status === 'running') {
          return `busy：队友运行中，稍后再试${prunedSuffix(pruned)}`
        }
      }
      // Never call compactNow inside the maintenance callback (compactNow
      // claims maintenance itself and would report busy).
      let result
      try {
        result = await compaction.compactNow(target, signal)
      } catch (error) {
        const stop = abortedResult()
        if (stop) return `${stop}${prunedSuffix(pruned)}`
        const code = error?.code
        // TR-02: pruning already landed and is never rolled back, so every
        // failure reply after it keeps the classified first line and appends
        // the known count (unknown partial writes are stated as unknown).
        if (code === 'busy') return `busy：队友运行中，稍后再试${prunedSuffix(pruned)}`
        if (code === 'cancelled') return `已取消压缩${prunedSuffix(pruned)}`
        if (code === 'changed') return `历史已变化，请复查${prunedSuffix(pruned)}`
        if (code === 'summary') return `摘要失败，请复查${prunedSuffix(pruned)}`
        if (code === 'commit') return `提交失败，可能已部分生效，请复查${prunedSuffix(pruned)}`
        if (code === 'persistence') return `压缩完成但保存失败，请复查${prunedSuffix(pruned)}`
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          return `已取消压缩${prunedSuffix(pruned)}`
        }
        const detail = clip(
          firstLine(error instanceof Error ? error.message : String(error ?? '')),
          150,
        )
        return `压缩失败：${detail || '原因未知'}${prunedSuffix(pruned)}`
      }
      const stopAfterCompact = abortedResult()
      if (stopAfterCompact) return `${stopAfterCompact}${prunedSuffix(pruned)}`
      const after = contextUsageOf(ctx, { agent: target, binding, policy, kind: 'live' })
      const beforeLine = `压缩前 ${formatContextUsage(before)}`
      const afterLine = `压缩后 ${formatContextUsage(after)}`
      const noteLines = pruneNote ? [pruneNote] : []
      if (result === null) {
        return [
          '无安全可压缩范围',
          beforeLine,
          afterLine,
          'shadowedTokens=0 shadowedSeqs=[]',
          ...noteLines,
        ].join('\n')
      }
      const seqs = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs : []
      const shown = seqs.slice(0, 16).join(',')
      const shadowedSeqs = `[${shown}]${seqs.length > 16 ? `…（共${seqs.length}个）` : ''}`
      const shadowedTokens =
        Number.isFinite(result.shadowedTokenCount) && result.shadowedTokenCount >= 0
          ? result.shadowedTokenCount
          : 0
      return [
        `已压缩 ${memberName}（task=${taskId}）`,
        beforeLine,
        afterLine,
        `shadowedTokens=${shadowedTokens} shadowedSeqs=${shadowedSeqs}`,
        ...noteLines,
      ].join('\n')
    },
  })

  const wait = defineTool({
    name: 'squad_wait',
    description:
      '最多阻塞 timeout_ms 等待队友状态、消息或任务变化，然后返回成员列表。只在必须等待时使用；否则结束回合，让 squad_report 唤醒你。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeout_ms: {
          type: 'integer',
          description: 'Wait in milliseconds, 10000–600000. Defaults to 30000.',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_wait')
      const requested = Number(args.timeout_ms ?? 30000)
      const timeout = Math.min(600000, Math.max(10000, Number.isFinite(requested) ? requested : 30000))
      // 0.2.x removed agentTeams.waitForChange; poll the subagent tree until
      // no child is running or the timeout expires (2s interval).
      const runningNow = async () =>
        (await treeRowsOf(ctx, lead, exec.signal)).some((row) => row.activity === 'running')
      const beforeRows = memberRowsOf(await treeRowsOf(ctx, lead, exec.signal), runtime, config)
      if (!(await runningNow())) {
        return `没有队友在运行或创建中，等待不会产生进展。用 squad_status 复查，然后派下一个任务。\n${formatMembers(beforeRows)}`
      }
      const deadline = Date.now() + timeout
      let stillRunning = true
      while (Date.now() < deadline) {
        if (exec.signal?.aborted) break
        await delay(Math.min(2000, Math.max(1, deadline - Date.now())), undefined, {
          signal: exec.signal,
        }).catch(() => {})
        stillRunning = await runningNow()
        if (!stillRunning) break
      }
      const afterRows = memberRowsOf(await treeRowsOf(ctx, lead, exec.signal), runtime, config)
      return [`等待${stillRunning ? '超时' : '观察到变化'}。`, formatMembers(afterRows)].join('\n')
    },
  })

  const report = defineTool({
    name: 'squad_report',
    description:
      '仅队友可用：把本轮结果汇报给 Team Lead。Lead 会被这条消息唤醒。任务完成、受阻或验收结束时调用一次。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['done', 'blocked', 'changes_requested', 'approved'],
          description: 'Outcome of this assignment.',
        },
        summary: {
          type: 'string',
          description: 'Concise result: what changed, evidence, and any defect list.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files touched or produced.',
        },
        next: { type: 'string', description: 'Suggested next action for the Lead.' },
      },
      required: ['status', 'summary'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const me = callingAgent(exec, 'squad_report')
      const subagents = ctx.get('subagents')
      let rootId
      try {
        rootId = subagents?.rootOf(me)?.id
      } catch {}
      const binding = runtime.bindingOf(me.id)
      if (rootId === me.id) {
        throw new Error('squad_report 是队友工具；Lead 用 squad_status 查看状态')
      }
      if (!rootId && !binding && !me.__membership) {
        throw new Error('squad_report 只能在 Agent Squad 队友会话里使用')
      }
      let selfName
      try {
        selfName = subagents?.namesOf?.(me)?.self
      } catch {}
      const name = binding?.name ?? selfName ?? me.__membership?.name ?? String(me.id)
      const root = rootId ?? 'lead'
      // The binding records which task dispatched this child; with several
      // active tasks the cwd pointer may belong to a different one.
      let taskId = 'unknown'
      let directory = await memoryDirectory(ctx, me, config)
      if (binding?.taskId) {
        try {
          const resolved = await resolveTask({
            ctx, agent: me, config, store, explicitTaskId: binding.taskId,
          })
          taskId = resolved.taskId
          directory = resolved.memoryRoot
        } catch {}
      } else {
        const current = await readJson(join(directory, 'current.json'))
        taskId = current?.taskId ? String(current.taskId) : 'unknown'
      }
      // Dispatch-time snapshot first; fall back to the current settings roster
      // for agents bound before snapshots existed (R08).
      const configured =
        runtime.bindingOf(me.id) ??
        settingsRoster(await store.read(), config).find((agent) => agent.name === name)
      const role = configured?.role ?? 'worker'
      // Failover: a tester reporting blocked with a quota-like summary
      // (额度耗尽/429/insufficient…) auto-suspends it; the Lead gets the
      // handover hint through the report text and squad_status.
      if (args.status === 'blocked' && role === 'tester' && QUOTA_ERROR.test(String(args.summary ?? ''))) {
        try {
          await runtime.suspendAgent(name, `队友报告额度耗尽：${firstLine(args.summary)}`, true, role)
        } catch {}
      }
      let reportProgress = null
      if (taskId && taskId !== 'unknown') {
        const reportTaskDir = join(directory, taskId)
        const journal = join(reportTaskDir, 'JOURNAL.md')
        await appendFile(
          journal,
          `- ${new Date().toISOString()} ${name} (${role}) report=${args.status} — ${firstLine(args.summary)}\n`,
          'utf8',
        ).catch(() => {})
        const reportState = await readJson(join(reportTaskDir, 'STATE.json'))
        if (reportState) {
          await flushPendingRuns({ ctx, lead: rootId ? { id: rootId } : undefined, taskDir: reportTaskDir, state: reportState, signal: exec.signal }).catch(() => {})
          reportProgress = progressSummaryOf(reportState)
          await writeProgress({ ctx, lead: rootId ? { id: rootId } : undefined, taskDir: reportTaskDir, state: reportState, signal: exec.signal })
        }
      }
      const files = Array.isArray(args.files) && args.files.length > 0 ? args.files.join(', ') : '—'
      // S6: measure the reporter once and append the identical line to both the
      // outgoing report and the caller's receipt. A measurement failure must
      // never break delivery, so this whole block degrades silently.
      let measured
      let usageLine = null
      if (autoUsage) {
        try {
          measured = contextUsageOf(ctx, {
            agent: me,
            binding,
            policy: usagePolicy,
            kind: 'live',
          })
          usageLine = formatContextUsage(measured)
        } catch {
          usageLine = null
        }
      }
      const text = `[squad-report] task=${taskId} agent=${name} role=${role} status=${args.status}
总结：
${String(args.summary).trim()}
文件：${files}
下一步：${String(args.next ?? '—').trim()}${reportProgress ? `\n进度同步：${reportProgress}` : ''}${usageLine ? `\n${usageLine}` : ''}`
      if (!subagents || (!rootId && !me.__membership)) {
        throw new Error('squad_report 需要 subagents 服务把报告发给 Lead。')
      }
      await subagents.sendMessage(me, root, [{ type: 'text', text }], {
        signal: exec.signal,
      })
      if (usageLine) {
        rememberUsage(taskId, me.id, measured)
      }
      return `已把报告发给 lead（task=${taskId} status=${args.status}）。${usageLine ? `\n${usageLine}` : ''}`
    },
  })

  const finish = defineTool({
    name: 'squad_finish',
    description:
      '收尾任务：确认没有队友在运行且验收已 approved（完整流程需技术+业务双验收且仍然新鲜），提交 worktree 改动（可配置），把会话切回源目录，写出 FINAL.md 并给出分支/合并命令。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: '交付摘要，写入 FINAL.md 和提交信息首行。' },
        task_id: { type: 'string', description: '任务 id；默认当前任务。' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_finish')
      const resolved = await resolveTask({
        ctx, agent: lead, config, store, explicitTaskId: args.task_id,
      })
      const { taskId, taskDir, memoryRoot: directory } = resolved
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const state = await readJson(join(taskDir, 'STATE.json'))
      if (!state) throw new Error(`未知小队任务 "${taskId}"。`)
      if (state.phase === 'done') throw new Error(`任务 ${taskId} 已经收尾。`)

      const treeRows = await treeRowsOf(ctx, lead, exec.signal)
      const active = treeRows.filter((row) => row.activity === 'running')
      if (active.length > 0) {
        const names = active.map(
          (row) => row.name ?? row.label ?? String(row.id),
        )
        throw new Error(`仍有队友在运行：${names.join(', ')}。等报告后再收尾。`)
      }
      const runningChildren = Object.entries(state.children ?? {}).filter(
        ([, child]) => child.status === 'provisioning' || isRowRunning(treeRows, child.id),
      )
      if (runningChildren.length > 0) {
        throw new Error(
          `仍有本地子代理在运行：${runningChildren.map(([name]) => name).join(', ')}。等完成通知后再收尾。`,
        )
      }
      const participantNames = Array.isArray(state.participants) ? state.participants : []
      // Prefer the gate snapshotted at start. A legacy STATE without a gate is
      // treated conservatively: review is required unless the snapshot
      // explicitly recorded reviewRequired=false (R09).
      const flow = flowOf(state)
      // Phase-2 guard first: every parallel feature must be delivered (merged
      // into Base) before acceptance or closing make sense.
      const features = Array.isArray(state.features) ? state.features : []
      const unmerged = features.filter((item) => item.merged !== true)
      if (unmerged.length > 0) {
        throw new Error(
          `仍有未交付合并的并行特性：${unmerged.map((item) => item.name).join(', ')}。先对每个特性执行 squad_deliver({ feature: "<name>" }) 合入 Base 再收尾。`,
        )
      }
      await flushPendingRuns({ ctx, lead, taskDir, state, signal: exec.signal })
      const pendingGate = pendingRunGate(state, '收尾')
      if (pendingGate) throw new Error(pendingGate)
      const gateError = await acceptanceGateError(taskDir, state)
      if (gateError) throw new Error(gateError)

      const summary = String(args.summary ?? '').trim() || '任务完成'
      const repoRows = worktreesOf(state)

      // --- parallel workflow: Base already carries the merged deliveries ----
      if (state.baseDelivered) {
        const lines = [`任务 ${taskId} 收尾。`]
        lines.push(
          `通用功能已交付：${state.baseDelivered.summary ?? ''} @ ${state.baseDelivered.at}`,
          ...(state.baseDelivered.commits ?? []).map(
            (row) => `  仓库：${row.repo}  Base：${row.baseBranch}  合并提交：${row.commit}`,
          ),
        )
        for (const item of features) {
          lines.push(`  特性：${item.name} 分支 ${item.branch} → 已合入 Base（${item.mergedAt ?? '?'}）`)
        }
        const source = repoRows[0]?.repo
        const workingDirectory = ctx.get('workingDirectory')
        if (workingDirectory && source) {
          try {
            await workingDirectory.set(lead, source, exec.signal)
            lines.push(`会话已切回源目录：${source}`)
          } catch (error) {
            lines.push(`切换回源目录失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        state.phase = 'done'
        state.closedAt = new Date().toISOString()
        state.verdict = 'approved'
        state.commit = state.baseDelivered.commits?.[0]?.commit ?? null
        await markTaskActive(store, taskId, false).catch(() => {})
        await repointCurrent(store, taskId).catch(() => {})
        state.finishSummary = summary
        await writeJson(join(taskDir, 'STATE.json'), state)
        await writeFile(
          join(taskDir, 'FINAL.md'),
          `# 收尾 · ${taskId}\n\n## 摘要\n\n${summary}\n\n## 交付\n\n${lines.join('\n')}\n`,
          'utf8',
        )
        await appendFile(
          join(taskDir, 'JOURNAL.md'),
          `- ${new Date().toISOString()} lead: squad_finish（并行交付收尾，Base=${state.baseDelivered.commits?.[0]?.baseBranch ?? '?'}，features=${features.map((item) => item.name).join(',') || '无'}）\n`,
          'utf8',
        ).catch(() => {})
        await writeProgress({ ctx, lead, taskDir, state, signal: exec.signal })
        return lines.join('\n')
      }

      // --- multi-repository finish: commit per repository (PLAN §26–§29) ----
      if (repoRows.length > 1) {
        const primarySource = repoRows[0].repo
        const commits = []
        const lines = [`任务 ${taskId} 收尾。`]
        const finalBlocks = []
        for (const wt of repoRows) {
          const row = {
            repo: wt.repo,
            path: wt.path,
            branch: wt.branch,
            baseCommit: wt.baseCommit,
            commit: null,
            status: 'error',
            error: null,
          }
          const errors = []
          try {
            const dirty = (await git(wt.path, ['status', '--porcelain'])).trim()
            if (config.worktreeAutoCommit) {
              if (dirty) {
                await git(wt.path, ['add', '-A'])
                await git(wt.path, ['commit', '-m', `squad(${taskId}): ${firstLine(summary)}`])
                row.status = 'committed'
              } else {
                row.status = 'no-change'
              }
            } else {
              row.status = 'skipped'
            }
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
          try {
            row.commit = (await git(wt.path, ['rev-parse', '--short', 'HEAD'])).trim() || null
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
          let statText = ''
          try {
            statText = (await git(wt.path, ['diff', '--stat', `${wt.baseCommit}..HEAD`])).trim()
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
          if (errors.length > 0) {
            row.status = 'error'
            row.error = errors.join('; ')
          }
          commits.push(row)
          const view = `git -C ${shellQuote(wt.repo)} diff ${shellQuote(`${wt.baseCommit}..${wt.branch}`)}`
          const merge = `git -C ${shellQuote(wt.repo)} merge --no-ff ${shellQuote(wt.branch)}`
          lines.push(
            `仓库：${wt.repo}`,
            `  worktree：${wt.path}`,
            `  分支：${wt.branch}（基线 ${wt.baseCommit}）`,
            `  提交：${row.commit ?? '（无）'} 状态：${row.status}${row.error ? ` 错误：${row.error}` : ''}`,
          )
          if (statText) {
            for (const statLine of statText.split('\n')) lines.push(`  ${statLine}`)
          }
          lines.push(`  查看：${view}`, `  合并：${merge}`)
          finalBlocks.push(
            [
              `### ${wt.repo}`,
              '',
              `- worktree：${wt.path}`,
              `- 分支：${wt.branch}`,
              `- 基线：${wt.baseCommit}`,
              `- 提交：${row.commit ?? '（无）'}`,
              `- 状态：${row.status}${row.error ? `（错误：${row.error}）` : ''}`,
              ...(statText ? ['', '```text', statText, '```'] : []),
              '',
              `- 查看：\`${view}\``,
              `- 合并：\`${merge}\``,
            ].join('\n'),
          )
        }
        state.commits = commits
        state.commit = commits[0]?.commit ?? null
        state.finishSummary = summary
        const details = commits
          .filter((row) => row.status === 'error')
          .map((row) => `${row.repo}: ${row.error}`)
        const workingDirectory = ctx.get('workingDirectory')
        try {
          if (typeof workingDirectory?.set !== 'function') {
            throw new Error('workingDirectory service is unavailable; cannot enter the squad worktree')
          }
          await workingDirectory.set(lead, primarySource, undefined)
          lines.push(`会话已切回源目录：${primarySource}`)
        } catch (error) {
          details.push(`cwd: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (details.length === 0) {
          state.phase = 'done'
          state.closedAt = new Date().toISOString()
          state.verdict = 'approved'
        }
        await writeJson(join(taskDir, 'STATE.json'), state)
        await writeFile(
          join(taskDir, 'FINAL.md'),
          `# 收尾 · ${taskId}\n\n## 摘要\n\n${summary}\n\n## 仓库\n\n${finalBlocks.join('\n\n')}\n`,
          'utf8',
        )
        for (const row of commits) {
          await appendFile(
            join(taskDir, 'JOURNAL.md'),
            `- ${new Date().toISOString()} lead: squad_finish repo=${row.repo} status=${row.status} commit=${row.commit ?? 'none'}\n`,
            'utf8',
          ).catch(() => {})
        }
        if (details.length > 0) {
          throw new Error(`multi-repository finish failed: ${details.join('; ')}`)
        }
        return lines.join('\n')
      }

      const worktree = state.worktree
      const lines = [`任务 ${taskId} 收尾。`]
      let commit = null
      if (worktree?.path) {
        if (config.worktreeAutoCommit) {
          const dirty = (await git(worktree.path, ['status', '--porcelain']).catch(() => '')).trim()
          if (dirty) {
            try {
              await git(worktree.path, ['add', '-A'])
              await git(worktree.path, ['commit', '-m', `squad(${taskId}): ${firstLine(summary)}`])
              lines.push('已在 worktree 提交改动。')
            } catch (error) {
              lines.push(
                `自动提交失败（改动保留未提交）：${error instanceof Error ? error.message : String(error)}`,
              )
            }
          } else {
            lines.push('worktree 没有未提交改动。')
          }
        }
        commit = (await git(worktree.path, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim() || null
        const stat = (
          await git(worktree.path, ['diff', '--stat', `${worktree.baseCommit}..HEAD`]).catch(() => '')
        ).trim()
        if (stat) lines.push('改动统计：', stat)
        lines.push(
          `分支：${worktree.branch}`,
          `worktree：${worktree.path}`,
          `查看：git -C ${worktree.repositoryRoot} diff ${worktree.baseCommit}..${worktree.branch}`,
          `合并：git -C ${worktree.repositoryRoot} merge --no-ff ${worktree.branch}`,
        )
        const workingDirectory = ctx.get('workingDirectory')
        if (workingDirectory && worktree.sourceDirectory) {
          try {
            await workingDirectory.set(lead, worktree.sourceDirectory, exec.signal)
            lines.push(`会话已切回源目录：${worktree.sourceDirectory}`)
          } catch (error) {
            lines.push(
              `切换回源目录失败：${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      } else {
        lines.push('本次未使用 worktree（原地开发）。')
      }

      state.phase = 'done'
      state.closedAt = new Date().toISOString()
      state.verdict = 'approved'
      state.commit = commit
      state.finishSummary = summary
      await markTaskActive(store, taskId, false).catch(() => {})
      await repointCurrent(store, taskId).catch(() => {})
      await writeJson(join(taskDir, 'STATE.json'), state)
      await writeFile(
        join(taskDir, 'FINAL.md'),
        `# 收尾 · ${taskId}\n\n## 摘要\n\n${summary}\n\n## 工作区\n\n${
          worktree
            ? `- 分支：${worktree.branch}\n- worktree：${worktree.path}\n- 基线：${worktree.baseCommit}\n- 提交：${commit ?? '（未提交）'}`
            : '- 原地开发'
        }\n`,
        'utf8',
      )
      await appendFile(
        join(taskDir, 'JOURNAL.md'),
        `- ${new Date().toISOString()} lead: squad_finish（commit=${commit ?? 'none'}）\n`,
        'utf8',
      ).catch(() => {})
      await writeProgress({ ctx, lead, taskDir, state, signal: exec.signal })
      return lines.join('\n')
    },
  })

  const approvePlan = defineTool({
    name: 'squad_approve_plan',
    description:
      'Lead-only：审核通过当前任务的 PLAN.md。归档 PLAN-APPROVED.md（必要时补归档当前轮次 PLAN-R<n>.md），写入 planApproved/planApprovedAt；批准后才允许 implement/rework 派单，之后不能再派 design。缺少 PLAN.md、任务已收尾或已批准时拒绝。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: '任务 id；默认当前任务。' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_approve_plan')
      const resolved = await resolveTask({
        ctx, agent: lead, config, store, explicitTaskId: args.task_id,
      })
      const { taskId, taskDir, memoryRoot: directory } = resolved
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const state = await readJson(join(taskDir, 'STATE.json'))
      if (!state) throw new Error(`未知小队任务 "${taskId}"。先调用 squad_start。`)
      if (state.phase === 'done') throw new Error(`任务 ${taskId} 已经收尾，不能批准 PLAN。`)
      if (state.planApproved === true) {
        throw new Error(`任务 ${taskId} 的 PLAN 已批准（${state.planApprovedAt ?? '?'}），不能重复批准。`)
      }
      // A background design round must land before the plan can be reviewed.
      await flushPendingRuns({ ctx, lead, taskDir, state, signal: exec.signal }).catch(() => {})
      const awaitingGate = pendingRunGate(state, '批准方案')
      if (awaitingGate) throw new Error(awaitingGate)
      let planText
      try {
        planText = await readFile(join(taskDir, 'PLAN.md'), 'utf8')
      } catch {
        throw new Error(
          `任务 ${taskId} 缺少可读的 PLAN.md：先派 brain（phase="design"）产出方案，再调用 squad_approve_plan。`,
        )
      }
      const plan = planGateOf(state)
      /** True when this round's result is still running in the background. */
      const designLimit = budgetOf(state).designLimit
      // Local/team designs are archived only here; a historical archive from
      // the external path is never rewritten. An existing path must be a
      // regular file — a directory or anything else is an archive fault and
      // keeps the task unapproved.
      const archived = []
      if (plan.planRounds > 0) {
        const roundPath = join(taskDir, `PLAN-R${plan.planRounds}.md`)
        let roundInfo
        try {
          roundInfo = await stat(roundPath)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        if (roundInfo && !roundInfo.isFile()) {
          throw new Error(
            `轮次归档 ${roundPath} 已存在但不是普通文件，不能批准；请先修复该归档路径。`,
          )
        }
        if (!roundInfo) {
          await writeFile(roundPath, planText, 'utf8')
          archived.push(`PLAN-R${plan.planRounds}.md`)
        }
      }
      // Any archive failure above throws before the state flips to approved.
      await writeFile(join(taskDir, 'PLAN-APPROVED.md'), planText, 'utf8')
      archived.push('PLAN-APPROVED.md')
      const approvedAt = new Date().toISOString()
      state.planApproved = true
      state.planApprovedAt = approvedAt
      await writeJson(join(taskDir, 'STATE.json'), state)
      await appendFile(
        join(taskDir, 'JOURNAL.md'),
        `- ${approvedAt} lead: 审核 PLAN 通过（设计轮次 ${plan.planRounds}/${designLimit}），归档 PLAN-APPROVED.md\n`,
        'utf8',
      ).catch(() => {})
      await writeProgress({ ctx, lead, taskDir, state, signal: exec.signal })
      return [
        `任务 ${taskId} 的 PLAN 已批准（第 ${plan.planRounds}/${designLimit} 次设计）。`,
        `批准时间：${approvedAt}`,
        `归档：${archived.map((name) => join(taskDir, name)).join('、')}`,
        flowOf(state).specRequired
          ? '下一步：squad_dispatch({ agent: "brain", phase: "spec" }) 发布技术规格 SPEC.md；规格交付后即可派 worker implement，不需要 Lead 再审批。'
          : '下一步：squad_dispatch({ agent: "<worker>", phase: "implement" })；实现后仍需 brain 验收（REVIEW.md VERDICT: APPROVED）才能收尾。',
      ].join('\n')
    },
  })

  const extend = defineTool({
    name: 'squad_extend',
    description:
      '仅允许 Lead 在对应预算（完整流程：design/tech/business；简化/兼容流程：design/implement）已耗尽且用户明确同意后调用：为当前任务追加轮次，提高该类预算上限并记录扩展历史。每次调用都必须先向用户说明阻塞点并取得本次同意，再传 confirmed=true；可重复扩展，但不得预先充值，也不会自动续跑派单。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['design', 'tech', 'business', 'implement'] },
        rounds: { type: 'integer', minimum: 1, default: 3 },
        reason: { type: 'string', minLength: 1 },
        confirmed: { type: 'boolean', const: true },
        task_id: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'reason', 'confirmed'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_extend')
      let rootId
      try {
        rootId = ctx.get('subagents')?.rootOf(lead)?.id
      } catch {}
      if (rootId !== lead.id) {
        throw new Error('squad_extend 仅允许 Lead 调用。')
      }
      const kind = args.kind
      if (!['design', 'tech', 'business', 'implement'].includes(kind)) {
        throw new Error('kind 必须是 design、tech、business 或 implement。')
      }
      const rounds = args.rounds === undefined ? 3 : args.rounds
      if (!(Number.isSafeInteger(rounds) && rounds > 0)) {
        throw new Error('rounds 必须是正的安全整数。')
      }
      if (typeof args.reason !== 'string' || args.reason.trim() === '') {
        throw new Error('reason 必须是非空字符串。')
      }
      const reason = args.reason.trim()
      if (args.confirmed !== true) {
        throw new Error('必须先获得用户明确同意，并传入 confirmed=true 才能追加轮次。')
      }
      if (args.task_id !== undefined && (typeof args.task_id !== 'string' || args.task_id.trim() === '')) {
        throw new Error('task_id 必须是非空字符串。')
      }
      // Shared-root resolution mirrors memoryDirectory, but non-ENOENT I/O
      // errors propagate as-is instead of reading as "no task" (§16).
      const base = config.memoryDir || DEFAULT_MEMORY_DIR
      const cwd = sessionDirectory(ctx, lead)
      const pointer = await readJsonIoStrict(join(cwd, base, 'current.json'))
      const directory = pointer?.memoryRoot ? pointer.memoryRoot : resolve(cwd, base)
      const current = await readJsonIoStrict(join(directory, 'current.json'))
      const taskId = args.task_id !== undefined ? args.task_id.trim() : String(current?.taskId ?? '')
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const taskDir = join(directory, taskId)
      const state = await readJsonIoStrict(join(taskDir, 'STATE.json'))
      if (!state) throw new Error(`未知小队任务 "${taskId}"。先调用 squad_start。`)
      if (state.phase === 'done') {
        throw new Error(`任务 ${taskId} 已经收尾，不能追加轮次。`)
      }
      const budget = budgetOf(state)
      const flow = flowOf(state)
      // Flow compatibility: full-flow tasks split the rework budget into
      // tech/business; legacy and simple tasks keep the single implement kind.
      if (flow.specRequired && kind === 'implement') {
        throw new Error(
          `任务 ${taskId} 走完整流程：没有 implement 返工预算。技术返工用 kind="tech"，业务返工用 kind="business"。`,
        )
      }
      if (!flow.specRequired && (kind === 'tech' || kind === 'business')) {
        throw new Error(
          `任务 ${taskId} 未启用完整流程（无技术/业务返工预算）：用 kind="design" 或 kind="implement"。`,
        )
      }
      const quota =
        kind === 'design'
          ? { used: budget.designUsed, limit: budget.designLimit }
          : kind === 'tech'
            ? { used: budget.techUsed, limit: budget.techLimit }
            : kind === 'business'
              ? { used: budget.businessUsed, limit: budget.businessLimit }
              : { used: budget.implementUsed, limit: budget.reworkLimit }
      const { used, limit } = quota
      if (used < limit) {
        throw new Error(
          `任务 ${taskId} 的 ${kind} 预算尚未到上限（已用 ${used}/${limit}），不能追加轮次。`,
        )
      }
      if (!Number.isSafeInteger(limit + rounds)) {
        throw new Error('追加后的预算上限超出安全整数范围。')
      }
      // All checks passed: write back all effective limits, raising only the
      // selected budget, and append one history record. Nothing else changes.
      const extensions = Array.isArray(state.extensions) ? state.extensions : []
      state.designLimit = budget.designLimit
      state.reworkLimit = budget.reworkLimit
      state.techReworkLimit = budget.techLimit
      state.businessReworkLimit = budget.businessLimit
      if (kind === 'design') state.designLimit = limit + rounds
      else if (kind === 'tech') state.techReworkLimit = limit + rounds
      else if (kind === 'business') state.businessReworkLimit = limit + rounds
      else state.reworkLimit = limit + rounds
      state.extensions = [
        ...extensions,
        { kind, rounds, reason, at: new Date().toISOString() },
      ]
      await writeJson(join(taskDir, 'STATE.json'), state)
      return `任务 ${taskId} 的 ${kind} 预算已扩展：上限 ${limit} → ${limit + rounds}，已用 ${used}，剩余 ${Math.max(0, limit + rounds - used)}（追加 ${rounds} 轮）。\n原因：${reason}`
    },
  })

  const failover = defineTool({
    name: 'squad_failover',
    description:
      '队友可用性恢复（仅 Lead）：解除因额度耗尽等原因挂起的队友（测试验收者 tester 或 worker）。tester 挂起时其职责（TEST-REVIEW.md）由 brain 代行、对它的派单被拒绝；worker 挂起时派单会自动改派其他 worker。自动挂起由派单报错、可用性探测失败或队友上报额度耗尽触发；此工具用于手动挂起 tester（reason）与恢复任意成员（recover: true）。用户确认额度恢复后再传 recover: true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: 'Teammate name, e.g. tester.' },
        reason: { type: 'string', description: 'Why the tester is suspended (required unless recovering).' },
        recover: { type: 'boolean', description: 'true lifts the suspension instead of creating one.' },
      },
      required: ['agent'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_failover')
      const name = String(args.agent ?? '').trim()
      if (!name) throw new Error('agent 必须是非空字符串。')
      const roster = settingsRoster(await store.read(), config)
      const target = roster.find((agent) => agent.name === name)
      if (!target) {
        throw new Error(`未知 agent "${name}"。已配置 agent：${roster.map((agent) => agent.name).join(', ') || '（无）'}`)
      }
      if (args.recover === true) {
        if (!runtime.isSuspended(name)) throw new Error(`队友 ${name} 未挂起，无需恢复。`)
        const record = runtime.suspendedRecord?.(name)
        await runtime.recoverAgent(name)
        return [
          `队友 ${name} 已解除挂起，恢复正常职责。`,
          record?.role === 'tester'
            ? `下次派单恢复正常（test-review 重新派给它；挂起期间由 brain 代行的结论仍有效）。`
            : `下次派单恢复由它执行（挂起期间由其他 worker 代行的结论仍有效）。`,
        ].join('\n')
      }
      if (args.recover !== undefined) throw new Error('recover 只能是 true（解除挂起）或省略（挂起）。')
      if (target.role !== 'tester') {
        throw new Error(`仅测试验收者（tester）支持挂起交接（brain 代行测试验收）；${name} 当前是 ${target.role}。`)
      }
      if (runtime.isSuspended(name)) {
        const record = runtime.suspendedRecord?.(name)
        throw new Error(`${name} 已处于挂起状态${record ? `（自 ${record.at}；原因：${clip(record.reason, 80)}）` : ''}，不能重复挂起。`)
      }
      const reason = String(args.reason ?? '').trim()
      if (!reason) throw new Error('reason 必须是非空字符串（挂起原因）。')
      await runtime.suspendAgent(name, reason, false, target.role)
      return [
        `测试验收者 ${name} 已挂起（原因：${reason}）。`,
        '测试验收职责由 brain 代行：squad_dispatch({ agent: "brain", phase: "test-review", … })；对挂起队友的派单会被拒绝。',
        `用户确认恢复后调用 squad_failover({ agent: "${name}", recover: true })。`,
      ].join('\n')
    },
  })


  const parallelStart = defineTool({
    name: 'squad_parallel_start',
    description:
      '（仅 Lead）开启并行阶段：通用功能已交付合并到 Base 分支后，为每个业务特性从 Base 拉取独立 worktree 与分支（squad-<task>-<feature>），之后用 squad_dispatch({ …, feature: "<name>" }) 派给不同 worker 并行开发。要求：任务已 squad_deliver、无队友运行、单仓任务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        features: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'Feature id, lowercase letters/digits/hyphens, e.g. auth-api.' },
              focus: { type: 'string', description: 'One-line focus of this feature for the worker brief.' },
            },
            required: ['name'],
          },
          description: 'Business features to develop in parallel, each gets its own worktree from the Base branch.',
        },
        task_id: { type: 'string', description: 'Task id; defaults to the current task.' },
      },
      required: ['features'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_parallel_start')
      const resolved = await resolveTask({
        ctx, agent: lead, config, store, explicitTaskId: args.task_id,
      })
      const { taskId, taskDir, memoryRoot: directory } = resolved
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const state = await readJson(join(taskDir, 'STATE.json'))
      if (!state) throw new Error(`未知小队任务 "${taskId}"。先调用 squad_start。`)
      if (state.phase === 'done') throw new Error(`任务 ${taskId} 已经收尾，不能开启并行阶段。`)
      await flushPendingRuns({ ctx, lead, taskDir, state, signal: exec.signal })
      if (!state.baseDelivered) {
        throw new Error(
          '并行阶段前必须先交付通用功能：squad_deliver({ summary }) 通过验收并把基础层合并到 Base 分支后，再 squad_parallel_start。',
        )
      }
      const repoRows = worktreesOf(state)
      if (repoRows.length !== 1) {
        throw new Error('多仓任务暂不支持并行特性 worktree；请在单仓任务中使用。')
      }
      const repoRow = repoRows[0]
      const baseBranch = repoRow.sourceBranch
      if (!baseBranch) {
        throw new Error('任务缺少 Base 分支信息（源仓库 detached HEAD 或旧任务）；无法基于 Base 拉取特性 worktree。')
      }
      const rows = await treeRowsOf(ctx, lead, exec.signal)
      if (rows.some((row) => row.activity === 'running')) {
        throw new Error('仍有队友在运行，等它们结束后再开启并行阶段。')
      }
      const list = Array.isArray(args.features) ? args.features : []
      if (list.length === 0) throw new Error('features 不能为空。')
      const seen = new Set()
      for (const item of list) {
        const name = String(item?.name ?? '').trim()
        if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
          throw new Error(`feature 名不合法 "${name}"：只允许小写字母/数字/短横线，1–31 字符。`)
        }
        if (seen.has(name)) throw new Error(`feature 名重复：${name}`)
        seen.add(name)
        if ((state.features ?? []).some((row) => row.name === name)) {
          throw new Error(`feature "${name}" 已存在。`)
        }
      }
      const worktreeRoot = dirname(repoRow.path)
      const created = []
      for (const item of list) {
        const name = String(item.name).trim()
        const branch = `squad-${taskId}-${name}`
        const path = join(worktreeRoot, `squad-${taskId}-${name}`)
        if (await stat(path).then(() => true, () => false)) {
          throw new Error(`特性 worktree 路径已存在：${path}`)
        }
        try {
          await git(repoRow.repo, ['worktree', 'add', '-b', branch, path, baseBranch])
        } catch (error) {
          throw new Error(
            `创建特性 worktree 失败（${name}）：${String(error?.message ?? error).split('\n')[0]}`,
          )
        }
        const baseCommit = (await git(repoRow.repo, ['rev-parse', `${baseBranch}^{commit}`])).trim()
        // Point the feature checkout at the shared task memory.
        await ensureSelfIgnore(join(path, config.memoryDir))
        await writeJson(join(path, config.memoryDir, 'current.json'), {
          taskId,
          memoryRoot: directory,
          worktree: path,
        })
        created.push({
          name,
          focus: String(item?.focus ?? ''),
          branch,
          path,
          baseBranch,
          baseCommit,
          merged: false,
          createdAt: new Date().toISOString(),
        })
      }
      state.features = [...(state.features ?? []), ...created]
      state.stage = 'parallel'
      await writeJson(join(taskDir, 'STATE.json'), state)
      await appendFile(
        join(taskDir, 'JOURNAL.md'),
        `- ${new Date().toISOString()} lead: 开启并行阶段 features=${created.map((item) => item.name).join(',')}（Base=${baseBranch}）\n`,
        'utf8',
      ).catch(() => {})
      await writeProgress({ ctx, lead, taskDir, state, signal: exec.signal })
      const lines = [
        `并行阶段已开启（Base 分支 ${baseBranch}）。`,
        ...created.map(
          (item) =>
            `- ${item.name}：分支 ${item.branch}  路径 ${item.path}  基线 ${item.baseCommit.slice(0, 8)}${item.focus ? `  focus=${item.focus}` : ''}`,
        ),
        `下一步：squad_dispatch({ agent: "<worker>", phase: "implement", feature: "<name>", message: "…" })；每个特性完成后 squad_deliver({ feature: "<name>" }) 合入 Base。`,
      ]
      return lines.join('\n')
    },
  })

  const deliver = defineTool({
    name: 'squad_deliver',
    description:
      '（仅 Lead）交付并合并：不传 feature 时交付当前任务的基础层——校验验收门禁、提交 worktree 改动并把 squad 分支合入 Base 分支（源仓库当前分支）；传 feature 时把该特性的 worktree 分支合入 Base。源仓库必须切在 Base 分支上；合并冲突会报错且不标记完成。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: 'Delivery summary for the merge commit / FINAL.' },
        feature: { type: 'string', description: 'Parallel feature to deliver; omit to deliver the base/common layer.' },
        task_id: { type: 'string', description: 'Task id; defaults to the current task.' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const lead = callingAgent(exec, 'squad_deliver')
      const resolved = await resolveTask({
        ctx, agent: lead, config, store, explicitTaskId: args.task_id,
      })
      const { taskId, taskDir, memoryRoot: directory } = resolved
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const state = await readJson(join(taskDir, 'STATE.json'))
      if (!state) throw new Error(`未知小队任务 "${taskId}"。先调用 squad_start。`)
      if (state.phase === 'done') throw new Error(`任务 ${taskId} 已经收尾，不能再交付。`)
      const rows = await treeRowsOf(ctx, lead, exec.signal)
      if (rows.some((row) => row.activity === 'running')) {
        throw new Error('仍有队友在运行，等它们结束后再交付。')
      }
      await flushPendingRuns({ ctx, lead, taskDir, state, signal: exec.signal })
      const pendingGate = pendingRunGate(state, '交付')
      if (pendingGate) throw new Error(pendingGate)
      const summary = String(args.summary ?? '').trim()
      const featureName = args.feature === undefined ? null : String(args.feature).trim()
      const repoRow = worktreesOf(state)[0]
      if (!repoRow) throw new Error('任务没有 worktree（原地开发），无法交付合并到 Base。')
      const baseBranch = repoRow.sourceBranch
      if (!baseBranch) {
        throw new Error('任务缺少 Base 分支信息（源仓库 detached HEAD 或旧任务）；请手动合并。')
      }

      if (featureName !== null) {
        if (!state.baseDelivered) {
          throw new Error('并行特性交付前必须先交付通用功能：squad_deliver({ summary }) 合并基础层到 Base。')
        }
        const feature = (Array.isArray(state.features) ? state.features : []).find(
          (item) => item.name === featureName,
        )
        if (!feature) throw new Error(`未知 feature "${featureName}"。`)
        if (feature.merged) throw new Error(`feature "${featureName}" 已经交付合并。`)
        let commit = null
        if (config.worktreeAutoCommit) {
          const dirty = (await git(feature.path, ['status', '--porcelain']).catch(() => '')).trim()
          if (dirty) {
            await git(feature.path, ['add', '-A'])
            await git(feature.path, ['commit', '-m', `squad(${taskId}): feature ${feature.name}${summary ? ` — ${firstLine(summary)}` : ''}`])
          }
        }
        commit = await mergeIntoBase({
          repo: repoRow.repo,
          branch: feature.branch,
          baseBranch,
          message: `squad(${taskId}): merge feature ${feature.name} into ${baseBranch}`,
        })
        feature.merged = true
        feature.mergedAt = new Date().toISOString()
        feature.commit = commit
        await writeJson(join(taskDir, 'STATE.json'), state)
        await appendFile(
          join(taskDir, 'JOURNAL.md'),
          `- ${new Date().toISOString()} lead: squad_deliver feature=${feature.name} base=${baseBranch} commit=${commit}\n`,
          'utf8',
        ).catch(() => {})
        await writeProgress({ ctx, lead, taskDir, state, signal: exec.signal })
        return [
          `特性 ${feature.name} 已交付并合入 Base 分支 ${baseBranch}（合并提交 ${commit}）。`,
          `worktree：${feature.path}  分支：${feature.branch}（保留，可手动清理）`,
          '继续派下一个特性，或全部合并后跑最终技术/业务验收并 squad_finish。',
        ].join('\n')
      }

      if (state.baseDelivered) {
        throw new Error('通用功能已交付合并；后续请用 squad_deliver({ feature: "<name>" }) 交付各特性。')
      }
      const gateError = await acceptanceGateError(taskDir, state)
      if (gateError) throw new Error(gateError)
      const repoRows = worktreesOf(state)
      const commits = []
      for (const wt of repoRows) {
        if (!wt.sourceBranch) {
          throw new Error(`仓库 ${wt.repo} 缺少 Base 分支信息；请手动合并。`)
        }
        if (config.worktreeAutoCommit) {
          const dirty = (await git(wt.path, ['status', '--porcelain']).catch(() => '')).trim()
          if (dirty) {
            await git(wt.path, ['add', '-A'])
            await git(wt.path, ['commit', '-m', `squad(${taskId}): ${firstLine(summary) || 'base delivery'}`])
          }
        }
        const commit = await mergeIntoBase({
          repo: wt.repo,
          branch: wt.branch,
          baseBranch: wt.sourceBranch,
          message: `squad(${taskId}): merge base into ${wt.sourceBranch}`,
        })
        commits.push({ repo: wt.repo, baseBranch: wt.sourceBranch, commit })
      }
      state.baseDelivered = {
        at: new Date().toISOString(),
        summary: summary || '通用功能交付',
        commits,
      }
      state.stage = 'base-delivered'
      await writeJson(join(taskDir, 'STATE.json'), state)
      await appendFile(
        join(taskDir, 'JOURNAL.md'),
        `- ${new Date().toISOString()} lead: squad_deliver base commits=${commits.map((row) => `${row.repo}@${row.commit}`).join(',')}\n`,
        'utf8',
      ).catch(() => {})
      await writeProgress({ ctx, lead, taskDir, state, signal: exec.signal })
      return [
        `通用功能已交付并合入 Base 分支。`,
        ...commits.map((row) => `- ${row.repo} → ${row.baseBranch}（合并提交 ${row.commit}）`),
        '下一步：squad_parallel_start({ features: [...] }) 基于 Base 拉特性 worktree，再并行派发各业务特性。',
      ].join('\n')
    },
  })

  const enable = defineTool({
    name: 'squad_enable',
    description:
      '为当前会话启用 Agent Squad（智能体小队）。仅当用户明确要求使用小队时调用（例如“用小队实现”“用智能体小队做这个任务”“use the agent squad”）；仅提到队友名字（brain/tester/worker1/front1/worker2）不算启用，普通任务直接自己做，不要调用本工具。插件重载后若小队会话失去身份，也用本工具恢复。调用后本会话成为 Squad Lead，获得 squad_* 工具与 Lead 章程。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const lead = callingAgent(exec, 'squad_enable')
      if (!runtime.isLeadEnabled(lead.id)) {
        runtime.enableLead(lead)
        return [
          'Agent Squad 已为当前会话启用：你是 Squad Lead。',
          '小队角色：brain（大脑）业务方案 + 技术规格（SPEC.md）+ 技术/业务双验收；tester（测试者）测试验收者（依据 brain 的规格与验收方案审核 worker 测试用例，不合格则补充测试用例并完整测试）；worker1（后端开发者1）主力后端实现与自测；worker2（后端开发者2）备份后端；front1（前端开发者1）固定前端（页面交互设计、实现与自测）。',
          '纪律：任务中禁止自行添加临时辅助队员 aux；确需额外人手，先取得用户明确同意，并优先使用 team 模式成员。',
          '执行效率纪律：编码轮只跑 compile + 受影响单测；轮末只跑一次受影响 IT；全量只在测试验收/合并 Base/最终交付；返工批量修完再全量；共享 schema/主题/JAR 的测试串行。',
          '研发模式（默认）：squad_start → brain design（业务方案）→ Lead 审核后 squad_approve_plan → brain spec（技术规格）→ worker implement → tester test-review（测试验收）→ brain tech-review（技术验收）→ brain review（业务验收）→ squad_finish。非代码任务可在 squad_start 时传 flow="simple"。',
          '验收模式：squad_start 传 mode="acceptance" 与 authority（权威方案）→ tester acceptance（技术维度）→ brain acceptance（业务维度，定稿 ACCEPTANCE-REPORT.md：验收方案与标准/上一轮修复情况/本轮问题/修复建议/结论）→ CHANGES_REQUESTED 则 worker rework 修复后重走双验收 → APPROVED 后 squad_finish。',
          '用户没有明确要求时不要启用小队；提到队友名字也不算启用。',
        ].join('\n')
      }
      return '当前会话已启用 Agent Squad（你是 Squad Lead）。用 squad_status 查看状态。'
    },
  })

  return { start, dispatch, status, wait, report, finish, approvePlan, extend, enable, failover, parallelStart, deliver, compact }
}

/** Host plugin entry. */
export function apply(ctx, input) {
  const config = resolveSettings(input)
  // Built-in qoder-cli external provider. Registered right after config
  // resolution (before the settings routes, so the model catalog sees it);
  // a missing subagents service is skipped, and the returned unregister
  // function is owned by this plugin's context effect (unload removes it).
  ctx.effect(
    () =>
      ctx.get('subagents')?.registerProvider(
        createQoderProvider({
          command: config.qoderCommand,
          permissionMode: config.qoderPermissionMode,
          model: config.qoderModel,
          ...(config.qoderAddDirs === undefined ? {} : { addDirs: config.qoderAddDirs }),
          ...(config.qoderAllowedTools === undefined ? {} : { allowedTools: config.qoderAllowedTools }),
        }),
      ),
    'agent-squad: qoder-cli provider',
  )
  // Built-in codex-cli external provider: drives the user's codex CLI
  // (codex exec) directly, so the squad rides the newest CLI models
  // instead of the bundled app-server kernel's model ceiling.
  ctx.effect(
    () =>
      ctx.get('subagents')?.registerProvider(
        createCodexProvider({
          command: config.codexCommand,
          model: config.codexModel,
          reasoningEffort: config.codexReasoningEffort,
          sandboxMode: config.codexSandboxMode,
        }),
      ),
    'agent-squad: codex-cli provider',
  )
  const store = createSettingsStore({
    seed: seedFromBundle(config.agents, config.worktreeDir),
    logger: { warn: (text) => ctx.logger?.('agent-squad')?.warn?.(text) },
  })
  // Failover state: suspended teammates (quota-exhausted testers) persist
  // next to the settings file so reloads and restarts keep the handover in
  // force until squad_failover recovers them. Loaded synchronously at apply
  // so the very first dispatch already sees it.
  const failoverPath = join(dirname(store.path), 'failover.json')
  const suspended = new Map()
  try {
    const raw = JSON.parse(readFileSync(failoverPath, 'utf8'))
    for (const [name, record] of Object.entries(raw?.suspended ?? {})) {
      if (record && typeof record === 'object') suspended.set(name, record)
    }
  } catch {}
  const persistFailover = () =>
    writeJson(failoverPath, { suspended: Object.fromEntries(suspended) }).catch(() => {})
  // Availability-probe cache: a worker that answered a probe recently is not
  // probed again on the next dispatch (across tasks), so the gate costs at most
  // one short round-trip per worker per TTL window.
  const probeCachePath = join(dirname(store.path), 'probe-cache.json')
  const probeCache = new Map()
  try {
    const raw = JSON.parse(readFileSync(probeCachePath, 'utf8'))
    for (const [name, record] of Object.entries(raw?.probes ?? {})) {
      if (record && Number.isFinite(Number(record.at))) probeCache.set(name, record)
    }
  } catch {}
  const persistProbeCache = () =>
    writeJson(probeCachePath, { probes: Object.fromEntries(probeCache) }).catch(() => {})
  const probeFresh = (name) => {
    const record = probeCache.get(name)
    if (!record) return false
    return Date.now() - Number(record.at) < config.probeTtlMs
  }
  // Settings page routes: register when the host web server is available.
  // `ctx.get()` at apply time can be undefined during startup in newer DSH
  // releases, so use a reactive injection instead of a one-shot check.
  ctx.inject(['webServer'], (webCtx) => {
    const disposeRoutes = registerRoutes({
      ctx: webCtx,
      store,
      models: { llm: webCtx.get('llm'), subagents: webCtx.get('subagents') },
    })
    if (disposeRoutes) webCtx.effect(() => disposeRoutes, 'agent-squad: settings routes')
  })
  /** Per-agent prompt-section disposers, owned by this plugin's context effect. */
  const installed = new Map()
  /**
   * Session id → dispatch-time settings snapshot for every bound child (local
   * pinned children and spawned team members alike), so identity and report
   * roles follow the snapshot rather than later settings edits (R08).
   */
  const agentBindings = new Map()
  /**
   * Name → pending dispatch snapshot, registered before a team member is
   * spawned so an `agent/created` fired mid-spawn already sees this round's
   * role (R08).
   */
  const pendingByName = new Map()
  /**
   * Session ids that explicitly opted into the squad (squad_enable). The squad
   * is opt-in: a root session without an entry here never sees the Lead
   * persona or the squad_* tools. In-memory only; after a plugin reload the
   * Lead re-enables with squad_enable (kept visible to roots for recovery).
   */
  const enabledLeads = new Set()

  // 0.2.x membership: the Lead is the subagent-tree root; a teammate is a
  // bound child (dispatch snapshot), a pending spawn, or a roster name. An
  // unrelated subagent from another plugin resolves to no membership.
  // A root only counts as the Lead once its session opted in (enabledLeads).
  const membershipOf = (agent) => {
    try {
      const subagents = ctx.get('subagents')
      const root = subagents?.rootOf(agent)
      if (root) {
        if (root.id === agent.id) {
          return enabledLeads.has(agent.id) ? { role: 'lead', name: 'lead' } : undefined
        }
        const binding = agentBindings.get(agent.id)
        if (binding) return { role: 'teammate', name: binding.name }
        let self
        try {
          self = subagents.namesOf?.(agent)?.self
        } catch {}
        if (self && pendingByName.has(self)) return { role: 'teammate', name: self }
        const rosterName =
          configuredAgents(config).find((entry) => entry.name === self)?.name ??
          (agent.__membership && configuredAgents(config).find((entry) => entry.name === agent.__membership.name)?.name)
        if (rosterName) return { role: 'teammate', name: rosterName }
      }
    } catch {}
    if (agent?.__membership?.role === 'lead' && !enabledLeads.has(agent.id)) return undefined
    return agent?.__membership
  }

  const installSection = (agent) => {
    if (installed.has(agent.id)) return
    const resolved = membershipOf(agent) ?? agent.__membership
    const binding =
      agentBindings.get(agent.id) ??
      (resolved?.name ? pendingByName.get(resolved.name) : undefined)
    const membership = binding ? { role: 'teammate', name: binding.name } : resolved
    if (!membership) return
    if (membership.role === 'lead' && !enabledLeads.has(agent.id)) return
    const configured = binding ?? configuredAgents(config).find((entry) => entry.name === membership.name)
    const text =
      membership.role === 'lead'
        ? LEAD_POLICY
        : teammatePrompt(
            configured ?? {
              name: membership.name,
              role: 'worker',
              charter: '',
              context: 'fresh',
              description: '',
              provider: '',
            },
            config,
          )
    const dispose = agent.ctx.systemPrompt.section({
      name: 'squad:identity',
      order: SECTION_ORDER,
      text,
    })
    installed.set(agent.id, dispose)
  }

  const uninstallSection = (agent) => {
    const dispose = installed.get(agent.id)
    installed.delete(agent.id)
    agentBindings.delete(agent.id)
    try {
      dispose?.()
    } catch {}
  }

  /**
   * Update one child's dispatch snapshot and refresh its installed identity
   * section, so a resumed dispatch with a changed role restyles the prompt
   * before the message is delivered (R08).
   */
  const rebindSection = (sessionId, agentConfig) => {
    agentBindings.set(sessionId, agentConfig)
    const agent = ctx.agents.get(sessionId)
    if (!agent) return
    const dispose = installed.get(sessionId)
    if (dispose) {
      installed.delete(sessionId)
      try {
        dispose()
      } catch {}
    }
    try {
      installSection(agent)
    } catch {}
  }

  const tools = createTools(ctx, config, {
    install: installSection,
    isInstalled: (sessionId) => installed.has(sessionId),
    registerBinding: (sessionId, agentConfig) => agentBindings.set(sessionId, agentConfig),
    unregisterBinding: (sessionId) => agentBindings.delete(sessionId),
    bindingOf: (sessionId) => agentBindings.get(sessionId),
    setPending: (name, agentConfig) => pendingByName.set(name, agentConfig),
    pendingNames: () => [...pendingByName.keys()],
    clearPending: (name) => pendingByName.delete(name),
    rebind: rebindSection,
    isLeadEnabled: (sessionId) => enabledLeads.has(sessionId),
    enableLead: (agent) => {
      enabledLeads.add(agent.id)
      try {
        installSection(agent)
      } catch (error) {
        ctx.logger?.('agent-squad')?.warn?.('squad lead section install failed', error)
      }
    },
    isSuspended: (name) => suspended.has(name),
    probeFresh,
    recordProbe: async (name, ok) => {
      probeCache.set(name, { at: Date.now(), ok: ok === true })
      await persistProbeCache()
    },
    suspendedRecord: (name) => suspended.get(name),
    suspendedRows: () =>
      [...suspended.entries()].map(([name, record]) => ({
        name,
        at: record.at ?? '?',
        reason: record.reason ?? '',
        auto: record.auto === true,
        role: record.role ?? null,
      })),
    suspendAgent: async (name, reason, auto, role) => {
      suspended.set(name, {
        at: new Date().toISOString(),
        reason: String(reason ?? ''),
        auto: auto === true,
        role: role ?? suspended.get(name)?.role ?? null,
      })
      await persistFailover()
      ctx.logger?.('agent-squad')?.warn?.(`failover: ${name} suspended (${auto ? 'auto' : 'manual'}): ${reason}`)
    },
    recoverAgent: async (name) => {
      suspended.delete(name)
      await persistFailover()
      probeCache.delete(name)
      await persistProbeCache()
    },
  }, store)
  const isLead = (agent) => membershipOf(agent)?.role === 'lead'
  const isTeammate = (agent) => membershipOf(agent)?.role === 'teammate'
  // The enable gate is offered to every subagent-tree root that has not opted
  // in yet: an un-enabled root sees exactly one squad tool, squad_enable.
  const isEnableCandidate = (agent) => {
    if (enabledLeads.has(agent.id)) return false
    try {
      const subagents = ctx.get('subagents')
      return subagents?.rootOf(agent)?.id === agent.id
    } catch {
      return false
    }
  }

  // Global registrations are owned by this plugin's context, so a reload removes
  // them atomically; per-agent visibility comes from the step-time condition.
  const registrations = [
    [tools.start, isLead],
    [tools.dispatch, isLead],
    [tools.approvePlan, isLead],
    [tools.extend, isLead],
    [tools.status, isLead],
    [tools.wait, isLead],
    [tools.finish, isLead],
    [tools.report, isTeammate],
    [tools.enable, isEnableCandidate],
    [tools.failover, isLead],
    [tools.parallelStart, isLead],
    [tools.deliver, isLead],
  ]
  // S5: the manual teammate compaction entry exists only with the policy on;
  // `contextPolicy:false` keeps the old tool set exactly.
  if (config.contextPolicy !== false) registrations.push([tools.compact, isLead])
  for (const [definition, condition] of registrations) {
    ctx.tools.register(definition, { when: ({ agent }) => condition(agent) })
  }

  // S4: the only automatic execution point. Basic's native `auto` owns
  // pre-step/overflow by default; this fallback runs at most one
  // `compactIfNeeded('pressure')` for a verifiably bound resident child of an
  // enabled Lead when (and only when) the host explicitly disabled its auto.
  if (config.contextPolicy !== false && config.contextPolicy.autoCompact === true) {
    // WeakMap key is the Agent (no strong retention); the value remembers the
    // set of already-warned reasons, so A/B/A reports A once (S4.4).
    const fallbackWarned = new WeakMap()
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      try {
        const service = ctx.get('compaction')
        const binding = agent ? agentBindings.get(agent.id) : undefined
        if (
          agent &&
          binding?.taskId &&
          signal &&
          !signal.aborted &&
          service &&
          service.config?.auto === false &&
          typeof service.compactIfNeeded === 'function'
        ) {
          let root
          try {
            root = ctx.get('subagents')?.rootOf?.(agent)
          } catch {
            root = undefined
          }
          if (root && root.id !== agent.id && enabledLeads.has(root.id)) {
            await service.compactIfNeeded(agent, 'pressure', signal)
          }
        }
      } catch (error) {
        try {
          const reason = firstLine(error instanceof Error ? error.message : String(error))
          const warnedReasons = fallbackWarned.get(agent)
          if (warnedReasons === undefined) {
            fallbackWarned.set(agent, new Set([reason]))
            ctx.logger?.('agent-squad')?.warn?.(
              `squad 补位压缩失败（${reason}），继续本轮；宿主 native 策略不受影响`,
            )
          } else if (!warnedReasons.has(reason)) {
            warnedReasons.add(reason)
            ctx.logger?.('agent-squad')?.warn?.(
              `squad 补位压缩失败（${reason}），继续本轮；宿主 native 策略不受影响`,
            )
          }
        } catch {}
      }
      return next()
    })
  }

  // Sections live on each agent's context; tie their disposal to this plugin so
  // a reload cannot leave an old charter behind.
  ctx.effect(() => {
    for (const agent of ctx.agents.list()) {
      try {
        installSection(agent)
      } catch {}
    }
    return () => {
      for (const dispose of installed.values()) {
        try {
          dispose()
        } catch {}
      }
      installed.clear()
    }
  })

  ctx.on('agent/created', ({ agent }) => {
    try {
      installSection(agent)
    } catch (error) {
      ctx.logger?.('agent-squad')?.warn?.('squad section install failed', error)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    enabledLeads.delete(agent.id)
    uninstallSection(agent)
  })
}
