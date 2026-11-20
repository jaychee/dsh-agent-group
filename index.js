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
 *   brain     — codex: business design (PLAN.md) and business acceptance
 *               (REVIEW.md). Changing business behavior needs a user decision.
 *   architect — gpt: system architect on a pinned local model. Publishes the
 *               technical spec (SPEC.md) and signs technical acceptance
 *               (TECH-REVIEW.md); may take over implementation, but then never
 *               signs acceptance for their own code — the brain does.
 *   worker    — zcode (backend) / qoder (frontend): implement and self-test.
 *
 * Full flow (new code tasks): business plan → Lead approval → technical spec →
 * implementation → technical acceptance → business acceptance. Tech and
 * business rework budgets are independent (3 rounds each, first acceptance
 * free); acceptances are versioned against the code/spec they examined.
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
const PLUGIN_MARKER = 'agent-squad/zh-v8'

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
 * (architect participant required); every other shape — explicit `simple`
 * tasks and legacy states created before flows existed — keeps the legacy
 * gates: plan approval (when a brain participated) and a single REVIEW close.
 */
function flowOf(state) {
  return {
    flow: state.flow === 'full' || state.flow === 'simple' ? state.flow : 'legacy',
    specRequired: state.flow === 'full' && state.specRequired === true,
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

const BRAIN_CHARTER = `你是小队里的 brain（业务设计与验收），与架构师分工：你管业务，架构师管技术。

- 把业务目标写成可执行业务方案，存入 PLAN.md：对外行为、用户可见结果、边界场景与编号验收标准（AC）。
- 涉及对外接口时逐项写明接口契约与错误行为；没有接口变更时明确写“无接口变更”，并列出须保留的对外行为。
- 列出边界输入与精确期望值；每条 AC 必须给出可直接执行的验收命令、执行目录、退出码与通过条件。
- 在“假设与待确认”中显式列出假设及影响；未确定且影响交付的事项标为待确认，不能让架构师或 worker 猜测。禁止使用“适当”“合理”“类似”“等等”“参考现有实现”替代具体规格。
- 你可以澄清方案；但要改变原有业务功能、对外结果或验收标准，必须先请用户决策，不得擅自变更。
- 写完后自检“一个没有上下文的架构师能否只靠 PLAN 拍板技术设计”，把结论写入 PLAN.md；不能时补全方案，或列入“假设与待确认”并标明阻塞项，不得宣称方案可执行。
- 业务验收轮以 PLAN-APPROVED.md 为唯一权威业务规格，逐条核对 AC 并在 REVIEW.md 写明 AC 编号、验证命令、退出码、关键输出与结论；亲自运行或检查，不接受没有证据的声明。技术结论对照 SPEC.md 与 TECH-REVIEW.md，不替技术验收背书。
- 只有每条标准都有证据通过时才报 "approved"；否则报 "changes_requested"，给出编号缺陷清单和每项的最小修复方案。
- REVIEW.md 的最后一行必须是机器可读的「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」（Lead 的收尾门禁只认这一行）。
- 当架构师接手实现时，由你对照 SPEC.md 亲自运行验证测试并代签技术验收：在 TECH-REVIEW.md 记录命令、退出码、关键输出与编号缺陷，最后一行同样是「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」；之后再按业务方案单独签署业务验收，两份验收独立记录。
- 架构师挂起（额度耗尽容错交接）时代行架构师职责：按架构师章程写 SPEC.md（技术规格）与 TECH-REVIEW.md（对照 SPEC 亲自运行验证测试）；业务验收仍按本章程单独签署，两份记录独立。架构师恢复后交还职责。
- 不写生产代码；一次性探针脚本可以放在 /tmp。
- 方案要克制：计划正文默认不超过约 80 行，除非任务确实更复杂并在 PLAN.md 里说明理由。
- 不扩大范围，取满足目标的最小方案。`

const ARCHITECT_CHARTER = `你是小队里的系统架构师（architect），与 brain 分工：brain 管业务，你管技术。

- 设计轮（spec）读取已批准的业务方案 PLAN-APPROVED.md；对缺失的技术设计拍板，对已有设计审核、补充。
- 把技术规格写入 SPEC.md，至少覆盖适用的：代码结构、文件与模块职责、数据库表与迁移、领域模型及其依赖、对外接口与错误行为、各模块实现、可执行验证用例；对不适用的部分逐项明确说明“不适用”。
- 技术实现可以调整，但不能擅改业务行为；若必须改业务预期，暂停受影响工作并在报告中交 Lead 转用户决策。
- 规格有问题时按 worker 的上报修订并发布新版本（更新 SPEC.md，版本号以派单为准）；单纯澄清规格不扣返工额度，也不重置已用额度。
- 技术验收轮（tech-review）以当前 SPEC.md 为唯一权威技术规格：做代码审查、亲自运行验证测试，在 TECH-REVIEW.md 逐条记录需求/AC 编号、命令、退出码、关键输出与可执行的编号缺陷清单。
- TECH-REVIEW.md 的最后一行必须是机器可读的「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」（Lead 的技术验收门禁只认这一行）。
- 接手实现时按 worker 章程执行并自测，但你不能签署自己改动的技术验收：插件会拒绝对你派 tech-review；交由 brain（codex）对照 SPEC.md 独立代签技术验收。
- 不确定的业务预期不要猜：交 Lead 转用户决策。`

const WORKER_CHARTER = `你是小队里的执行者，严格按已批准的业务方案与技术规格实现。

- 动手前先读 TASK.md、PLAN-APPROVED.md（业务方案）与 SPEC.md（技术规格）。PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- 只做规格定义的最小改动；不得引入规格未定义的接口、文件或依赖，不重新设计、不改名、不扩大范围。
- 规格缺失、矛盾或明显错误时立即停止实现，报 "blocked"，引用 PLAN-APPROVED.md/SPEC.md 的具体章节与编号，并列出缺失项或冲突原文；需要归档而文件缺失时明确引用文件名；豁免任务引用 TASK.md 章节或 Lead 派单条目。规格有问题上报 Lead 转 gpt 修订发布，不自行偏离或改用 PLAN.md。
- 按 SPEC.md 指定的测试名、输入与期望输出写或更新测试，并亲自运行每条 AC 的验收命令；豁免任务按 TASK.md 与 Lead 本轮派单执行。
- 在 REPORT.md 逐条 AC 给证据：AC 编号、改动文件路径、测试名、实际命令、退出码、关键输出与结论；失败或未执行必须如实标注，不得只写“测试通过”。
- 并行默认：实现工作包含多个独立文件/模块时，默认用你自己的子代理/并行能力同时开发；不独立的部分串行完成。边界不变：只改规格内文件、逐条 AC 留证、汇总写 REPORT.md。
- 返工派单仍是在同一段对话里：逐条修复验收提出的编号缺陷，重跑完整相关测试，再次报告。`

const LEAD_POLICY = `Agent Squad 已启用：你是 Lead，小队里有按角色分工的队友（brain=业务设计与验收，architect=系统架构师，worker=执行者）。

完整流程（新代码任务默认：先业务方案、再技术规格、后实现与双验收）：
1. 调用 squad_start 一次，写入目标与验收标准（验收标准确实含糊时先问用户）。非代码任务可在创建时传 flow="simple" 走简化流程。
2. 派 brain（codex），phase="design"：写业务方案 PLAN.md。
3. Lead 亲自审核 PLAN.md：假装自己是没有上下文的架构师，无法只靠 PLAN 拍板技术设计的点按 D1 起连续编号，写明章节、缺失或矛盾、最小补全要求，派回 brain（phase="design"）返工迭代，默认初始设计 + ${MAX_DESIGN_REWORK_ROUNDS} 轮返工 = ${MAX_PLAN_ROUNDS} 次 design 派单，未扩展时第 ${MAX_PLAN_ROUNDS + 1} 次暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派 design；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。
4. 方案合格后调用 squad_approve_plan 批准（归档 PLAN-APPROVED.md）。有 brain 参与的任务，PLAN 未批准前 implement/rework/spec 派单会被拒绝；没有 brain 参与的任务豁免此门禁。
5. 派 architect（gpt），phase="spec"：读取 PLAN-APPROVED.md，发布技术规格 SPEC.md（代码结构、文件与模块职责、表与迁移、领域模型、接口与错误行为、各模块实现、可执行验证用例；不适用的明确说明）。规格可多轮修订、不占返工额度；发布后即可派工，不需要 Lead 再审批。
6. 派 worker，phase="implement"：zcode 负责后端，qoder 主责前端（兼做后端）；都按 PLAN-APPROVED.md + SPEC.md 实现并自测，写 REPORT.md。任何开启了 worker 能力的角色（含 codex/gpt，或开启了 leaderWorker 的你）都可作为 worker 并行实现；实现过代码的角色不能签署自己实现的技术验收。
6.1 阶段化并行（强制）：拆分任务时把**通用/底层功能排在前面、串行开发**（一次只派一个 worker，不要同时派多个）；基础层完成后走技术+业务验收，再调用 **squad_deliver** 把基础层合并到 Base 分支（"当前项目所在分支"）。只有基础层交付后，才允许 **squad_parallel_start({ features: [...] })** 基于 Base 为每个业务特性拉独立 worktree/分支，并用 squad_dispatch({ …, feature: "<name>" }) 分派给多个 worker 并行开发；每个特性完成后 **squad_deliver({ feature: "<name>" })** 直接合入 Base。全部特性合并后，在 Base 分支上重新跑技术/业务验收（验收需对合并后的代码新鲜），再 squad_finish 收尾。**两层并行是默认运行方式**：① 小队层——external 执行者的 implement/rework 默认后台派发（不阻塞，结果完成时以消息送达），连续派多个 worker 并行跑（如 zcode 后端 + qoder 前端同时）；需要在本回合同步拿结果时才传 background: false；② worker 层——派单消息把可并行的独立文件/模块逐项列出，worker 默认用自己的子代理同时开发（只改规格内文件、逐条 AC 留证）。
7. 派 gpt，phase="tech-review"：技术验收，附实际 diff 与测试证据，写 TECH-REVIEW.md。
8. 技术验收 changes_requested → 把编号缺陷派回对应 worker，phase="rework"（技术返工额度 ${MAX_TECH_REWORK_ROUNDS} 轮，前后端共享、不因换人或规格修订重置；未扩展时第 4 轮暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="tech", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派）。
9. 技术验收 approved → 派 codex，phase="review"：业务验收，写 REVIEW.md。
10. 业务验收 changes_requested → phase="rework"（业务返工额度 ${MAX_BUSINESS_REWORK_ROUNDS} 轮，与技术额度独立计数；业务返工改了代码后必须重新通过技术验收，再重新业务验收）。
11. 两份验收都 approved 且仍然新鲜（代码/规格未再变动）→ squad_finish 收尾，随后向用户汇总交付结果。

规则：
- 你是组织者，默认不写业务代码；自己的改动只限协调文件与最终整合。若设置里开启了 Lead 的 worker 能力（leaderWorker），你可以直接作为 worker 实现代码并与队友并行，但仍不得签署自己实现的验收，业务方案/技术规格照常走流程。
- 三种批准相互独立：squad_approve_plan 批准的是「业务方案」，TECH-REVIEW.md 的 VERDICT: APPROVED 批准的是「技术」，REVIEW.md 的 VERDICT: APPROVED 批准的是「业务」；任何一个不能替代另一个。代码、规格或方案变动后旧结论失效，不能用旧批准收尾。
- worker 不可用时可直接指定 gpt 接手实现（phase="implement"/"rework"）；${MAX_TECH_REWORK_ROUNDS} 轮技术返工仍未通过时先问用户是否继续，获准继续后直接派 gpt 接手，不需要再次确认选人。gpt 接手写代码后不能自签技术验收：tech-review 改派 codex 对照 SPEC.md 独立代签技术验收，业务验收仍由 codex 按业务方案单独签署，两份验收独立记录。
- 一个角色一个 agent。按能力选 worker：zcode 负责后端实现，qoder 负责前端产品实现与自测。
- 每次派单后结束当前回合，等队友的 squad_report 唤醒你；查看状态用 squad_status，只有必须在本回合阻塞时才用 squad_wait。
- 信息同步：插件在每个派单、squad_approve_plan、squad_parallel_start、squad_deliver、squad_finish 以及收到 squad_report 时自动刷新 PROGRESS.md；squad_status 顶部即分层进度（任务总览→阶段进度→队员进度→并行特性）。每个阶段完成、收到关键报告、交付与收尾时，用最新分层进度向用户简报一次（不要只报"进行中"）。
- 不阻塞主会话：所有 external 派单（含 codex 的 design/review、gpt 的 spec/tech-review）默认**后台派发**，工具立即返回、结束本回合，结果以后台消息送达后再继续；不要用 squad_wait 干等。需要在本回合同步拿结果时才传 background: false。后台任务仍在跑时 squad_approve_plan / squad_deliver / squad_finish 会拒绝并提示等待，这是正常的。
- 队友在跑时不得声称完成；没有双验收不得接受结果。
- 技术返工与业务返工各自默认最多 3 轮、独立计数、互不重置。任一到上限就暂停派单，先向用户说明阻塞点与已完成部分并等待决策；仅用户明确同意后调用 squad_extend(kind="tech"/"business", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派单，每次扩展都要重新确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。
- 外部 provider（agent 配置里 provider 非空且不是 spawn/fork）走一次性派发：squad_dispatch 阻塞到它返回并把结果直接给你；它不会 squad_report，也不能续跑。返工=再派一次，必须重发 BRIEF 与编号缺陷。
- 外部 agent 不共享你的会话上下文，只读共享文件；派单靠路径和编号，不要假设它记得上一轮。
- 默认在 worktree 分支开发：squad_start 会创建新分支并切过去；不要在源 checkout 上直接改业务代码。
- 收尾：双验收 approved 后调用 squad_finish（提交 worktree 改动、切回源目录、给出分支与合并命令）。
- 队友共享你的工作目录与 .agent-squad 记忆，不要重复他们的工作。
- 架构师容错：gpt 因额度耗尽不可用时（派单报出额度类错误或队友上报额度耗尽），插件会自动挂起 gpt 并提示改派；架构师职责（spec 与 tech-review）由 codex 代行完成剩下的任务。也可手动 squad_failover({ agent: "gpt", reason: "原因" }) 挂起。挂起期间派 gpt 会被拒绝；用户确认额度恢复后调用 squad_failover({ agent: "gpt", recover: true }) 交还职责。
- worker 可用性门禁：每次 implement/rework 派单前插件会自动做一轮轻量可用性探测（同一任务同一 worker 探测成功即缓存；dispatch 传 probe:true 强制重探、probe:false 跳过）。若探测返回额度类错误（limit/quota/429/余额…），插件立即把该 worker 记为不可用、自动改派另一个可用 worker 执行本轮，并在派单反馈里明示"谁不可用、原因、改由谁执行"；此后的派单也会自动绕开它。用户确认额度恢复后 squad_failover({ agent: "<name>", recover: true }) 解除。
- 面向用户的回复必须使用用户所用的语言（用户用中文就用中文）；角色章程的语言不影响你回复用户的语言。`

const DEFAULT_AGENTS = [
  {
    name: 'codex',
    role: 'brain',
    description: '业务设计与验收：给出业务方案、对外行为与验收标准，并做业务验收。',
    provider: '',
    context: 'fresh',
    charter: '',
  },
  {
    name: 'gpt',
    role: 'architect',
    description: '系统架构师：发布技术规格并做技术验收；可接手实现（不能自签技术验收）。',
    provider: '',
    model: 'openai/gpt-6.2-sol',
    context: 'fresh',
    charter: '',
  },
  {
    name: 'zcode',
    role: 'worker',
    description: '后端 worker：实现后端代码并自测。',
    provider: '',
    context: 'fresh',
    charter: `后端执行者分工：
- 负责后端/服务端代码的实现：业务逻辑、API、数据层、脚本与配置。
- 负责后端测试：单元测试、集成测试与回归验证，逐条 AC 留证。
- 边界：不承担前端页面/样式/交互改动；发现前端问题转交 qoder，不代改。`,
  },
  {
    name: 'qoder',
    role: 'worker',
    description: '前端 worker：主责前端产品代码开发与自测，兼做后端代码开发。',
    provider: '',
    context: 'fresh',
    charter: `前端执行者分工：
- 主责前端产品代码的实现：页面、样式、交互与前端状态，并编写/运行 UI 与组件测试、构建验证。
- 兼职后端：可承担后端代码（接口/脚本/数据层）的实现与测试；前端资源竞争时前端优先。
- 边界：涉及接口契约的跨端问题报告 Lead 协调，不擅自改契约。`,
  },
]

/** Quota-exhaustion signatures that auto-suspend an architect (failover). */
const QUOTA_ERROR = /额度|余额|欠费|限流|quota|insufficient|balance|exceeded|429|rate.?limit/i

/** Build a registry-ready tool definition from a JSON-Schema parameter object. */
function defineTool(definition) {
  return definition
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
    architectCharter: text(config.architectCharter, ARCHITECT_CHARTER),
    workerCharter: text(config.workerCharter, WORKER_CHARTER),
    agents,
    worktreeDir: text(config.worktreeDir, '.agents/worktrees'),
    workerProbe: config.workerProbe !== false,
    worktreeFrom: text(config.worktreeFrom, 'HEAD'),
    worktreeAutoCommit: config.worktreeAutoCommit !== false,
    qoderCommand: text(config.qoderCommand, 'qoderclicn'),
    qoderPermissionMode: text(config.qoderPermissionMode, 'accept_edits'),
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
    // Worker capability: any role may act as an implementation worker when
    // enabled (brain and architect included, plus the Lead via leaderWorker).
    worker:
      typeof settingsAgent.worker === 'boolean'
        ? settingsAgent.worker
        : settingsAgent.role !== 'brain',
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
      role: ['brain', 'architect', 'worker'].includes(entry.role) ? entry.role : 'worker',
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
  if (agent.role === 'architect') return config.architectCharter
  return config.workerCharter
}

function teammatePrompt(agent, config) {
  return `你是 "${agent.name}"，DSH Agent Squad 里的 ${agent.role} 角色。Team Lead 的代号是 "lead"。

${charterFor(agent, config)}

共享记忆：每次派单都会给出共享目录。先读 TASK.md；PLAN.md、SPEC.md、TECH-REVIEW.md、REVIEW.md、REPORT.md、JOURNAL.md 分别承载业务方案、技术规格、技术验收、业务验收、交付证据与历史。保持这些文件最新，队友才能不靠复述对话协作。
- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。

汇报：任务完成、受阻或验收结束时，调用一次 squad_report，带上 status、简短总结和改动文件。Lead 会被这条报告唤醒。不要创建队友或重新分配工作。`
}

function repoLines(worktrees) {
  return worktrees.map(
    (wt) => `仓库：${wt.repo} | worktree：${wt.path} | 分支：${wt.branch} | 基线：${wt.baseCommit}`,
  )
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
  const protocol = full
    ? [
        '- 任何派单动手前先读本文件。',
        '- 流程（完整）：brain 业务方案 → Lead 审核批准 → architect 技术规格 → worker 实现自测 → 技术验收 → 业务验收 → 收尾。插件强制门禁，不自动派发后续阶段。',
        '- Lead 先审方案再实现：`brain` 写 `PLAN.md`（业务方案 + 编号验收标准）后由 Lead 审核并用 `squad_approve_plan` 批准（Lead 只批准**业务方案**，归档 `PLAN-APPROVED.md`）；设计问题须带编号缺陷再派 `phase="design"` 返工；默认初始设计 + 3 轮返工 = 4 次 design 派单，未扩展时第 5 次暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派 design；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。未批准前不派 implement/rework/spec（无 brain 任务豁免）。',
        '- `architect` 写 `SPEC.md`（技术规格：代码结构、模块职责、表与迁移、领域模型、接口与错误、验证用例；不适用处明确说明）。规格有问题由 worker 上报、gpt 修订发布版本；单纯澄清不扣返工额度，也不重置已用额度；发布后即可派工，不需要 Lead 再审批。若必须改业务预期，暂停受影响工作，交给用户决策。',
        '- `worker` 写 `REPORT.md`（改动、执行的命令、测试证据）；zcode 负责后端，qoder 负责前端产品代码与自测。',
        '- 技术验收：`architect` 对照当前 `SPEC.md` 做代码审查、亲自运行验证测试，写 `TECH-REVIEW.md`（最后一行 `VERDICT: APPROVED` 或 `VERDICT: CHANGES_REQUESTED`）。技术返工默认 3 轮（前后端共享、不因换人或规格修订重置），未扩展时第 4 轮暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="tech", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。',
        '- 业务验收：`brain` 以 `PLAN-APPROVED.md` 为唯一业务规格写 `REVIEW.md`（最后一行 `VERDICT: APPROVED` 或 `VERDICT: CHANGES_REQUESTED`），与技术验收相互独立、不能互相替代。业务返工默认 3 轮（与技术额度独立计数），未扩展时第 4 轮暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="business", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。业务返工改了代码后必须重新通过技术验收。',
        '- 验收记录与同一版候选代码、业务方案与技术规格对应：任一变化使旧结论失效，不能用旧批准收尾。',
        '- worker 不可用时 Lead 可直接指定 `architect` 接手实现；接手写代码后不能签署自己改动的技术验收，由 `brain` 对照 SPEC.md 独立代签技术验收，再单独签署业务验收（两份独立记录）。',
        '- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。',
        '- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。',
        '- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。',
        '- 每个成员在调用 `squad_report` 前，向 `JOURNAL.md` 追加一条简短记录。',
        `- 收尾需要技术验收与业务验收都以 \`VERDICT: APPROVED\` 结束且仍然新鲜；Lead 在双验收 approved 后调用 squad_finish。`,
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
  // The phase decides the artifact; the acting-architect note marks a brain
  // covering a suspended architect (failover) or countersigning a takeover.
  const acting = agent.role !== 'architect' && (phase === 'spec' || phase === 'tech-review')
    ? '（代行架构师职责）' : ''
  if (phase === 'spec') {
    return `发布/修订技术规格 SPEC.md（代码结构、模块职责、表与迁移、领域模型、接口与错误、验证用例；不适用处明确说明），版本号以派单为准。${acting}`
  }
  if (phase === 'tech-review') {
    return `技术验收轮以当前 SPEC.md 为唯一技术规格写 TECH-REVIEW.md：代码审查、亲自运行验证测试、逐条记录命令/退出码/关键输出与编号缺陷，最后一行 VERDICT。${acting}`
  }
  if (agent.role === 'brain') {
    return '业务验收轮以 PLAN-APPROVED.md 为唯一业务规格写 REVIEW.md，逐条 AC 给结论与证据。'
  }
  if (agent.role === 'architect') {
    return '写 REPORT.md，按 PLAN-APPROVED.md + SPEC.md 逐条 AC 记录改动、测试名、命令、退出码、关键输出与结论（接手实现时按 worker 规程执行并自测）。'
  }
  return '写 REPORT.md，按 PLAN-APPROVED.md + SPEC.md 逐条 AC 记录改动、测试名、命令、退出码、关键输出与结论；豁免任务按 TASK.md 与 Lead 本轮派单逐条 AC 留证。'
}

function renderDispatch({ taskId, taskDir, phase, round, agent, message, includeCharter, config, workspace, worktrees = [] }) {
  const deliverable = deliverableOf(agent, phase)
  const charter = includeCharter ? `\n角色章程：\n${charterFor(agent, config)}\n` : ''
  const repoBlock = worktrees.length > 1 ? `${repoLines(worktrees).join('\n')}\n` : ''
  const readHint =
    phase === 'spec'
      ? '先读 TASK.md 与 PLAN-APPROVED.md；spec 轮读取既有 SPEC.md（存在时）；读取 JOURNAL.md 最后 80 行。'
      : phase === 'tech-review'
        ? '先读 TASK.md；读取 SPEC.md、REPORT.md 与 TECH-REVIEW.md（存在时）；读取 JOURNAL.md 最后 80 行。'
        : phase === 'review'
          ? '先读 TASK.md；读取 PLAN-APPROVED.md、REPORT.md 与 TECH-REVIEW.md（存在时）；读取 JOURNAL.md 最后 80 行。'
          : '先读 TASK.md；设计轮读取 PLAN.md（存在时）；实现/返工读取 SPEC.md；读取 JOURNAL.md 最后 80 行。'
  const parallelHint =
    phase === 'implement' || phase === 'rework'
      ? '并行默认：本轮交办包含多个独立文件/模块时，用你的子代理/并行能力同时开发；不独立的部分串行完成；只改规格内文件，逐条 AC 留证。'
      : ''
  return `[Agent Squad] task=${taskId} phase=${phase} round=${round} role=${agent.role}
${charter}
共享记忆：${taskDir}
工作区：${workspace}
${repoBlock}（只在工作区内改动；动手前先确认 pwd 与它一致，不要写回源 checkout。）
${readHint}
- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。

Lead 的本轮派单：
${message}
${parallelHint}
交付物：${deliverable}
汇报前：更新你的文件，向 JOURNAL.md 追加 2–5 行，然后调用 squad_report（status、简短总结、改动文件）。受阻写进报告，不要在对话里向 Lead 提问。`
}

function formatMembers(members) {
  return members
    .map((member) => {
      const detail = member.description ? ` — ${clip(member.description, 100)}` : ''
      return `- ${member.name} [${member.role}] ${member.status}${detail}`
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
async function writeBrief({ taskDir, state, agent, phase, round }) {
  const budget = budgetOf(state)
  const flow = flowOf(state)
  const reworkLine = flow.specRequired
    ? `rework: tech=${state.techReworkRounds ?? 0}/${budget.techLimit} business=${state.businessReworkRounds ?? 0}/${budget.businessLimit}`
    : `rework=${state.reworkRounds ?? 0}/${budget.reworkLimit}`
  const lines = [
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
  await writeFile(join(taskDir, 'BRIEF.md'), `${lines.join('\n')}\n`, 'utf8')
}

/** Prompt for an external one-shot or a local pinned-model child. */
function dispatchPrompt({ mode, taskId, taskDir, phase, round, agent, message, workspace, config, includeCharter = true, worktrees = [] }) {
  const charter = includeCharter ? `\n角色章程：\n${charterFor(agent, config)}\n` : ''
  const repoBlock = worktrees.length > 1 ? `${repoLines(worktrees).join('\n')}\n` : ''
  const deliverFile =
    phase === 'spec'
      ? 'SPEC.md'
      : phase === 'tech-review'
        ? 'TECH-REVIEW.md'
        : agent.role === 'brain'
          ? phase === 'review'
            ? 'REVIEW.md'
            : 'PLAN.md'
          : agent.role === 'architect'
            ? 'REPORT.md'
            : 'REPORT.md'
  const actingNote =
    agent.role !== 'architect' && (phase === 'spec' || phase === 'tech-review')
      ? '\n注：架构师当前不可用时由你代行架构师职责，按上述规格交付。\n'
      : ''
  const parallelHint =
    phase === 'implement' || phase === 'rework'
      ? '\n并行默认：本轮交办包含多个独立文件/模块时，用你的子代理/并行能力同时开发；不独立的部分串行完成；只改规格内文件，逐条 AC 留证。\n'
      : ''
  return `[Agent Squad · ${mode}] task=${taskId} phase=${phase} round=${round} role=${agent.role}
工作区：${workspace}
${repoBlock}共享记忆：${taskDir}
先读 BRIEF.md 与 TASK.md；设计轮读取 PLAN.md（存在时），spec 轮读取 PLAN-APPROVED.md 与既有 SPEC.md，实现、返工与验收读取 PLAN-APPROVED.md + SPEC.md；按需读取 TECH-REVIEW.md / REVIEW.md / REPORT.md。
${charter}
- PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。
本轮交办：
${message}
${parallelHint}${actingNote}
交付：把结果写入 ${deliverFile}；只回复 ≤150 字摘要 + 文件路径，不要回贴全文。`
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
  if (flow.specRequired) {
    const tech = await readFile(join(taskDir, 'TECH-REVIEW.md'), 'utf8').catch(() => '')
    if (!tech) return '缺少 TECH-REVIEW.md：先让 gpt 技术验收（或由 codex 代签）并写 TECH-REVIEW.md。'
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
  const techFresh = flow.specRequired && bindingFresh(state.techReview, state) && techVerdict === 'APPROVED'
  const businessFresh = bindingFresh(state.businessReview, state) && businessVerdict === 'APPROVED'
  const pendingRuns = Array.isArray(state.pendingRuns) ? state.pendingRuns : []
  const done = state.phase === 'done'
  const lines = ['## 进度总览', `- 阶段：${progressSummaryOf(state)}`, `- 当前：phase=${state.phase ?? '?'} round=${state.round ?? '?'}${done ? '（已收尾）' : ''}`]
  const gates = [`方案 ${plan.planApproved ? '已批准' : plan.planRequired ? '待批准' : '豁免'}`]
  if (flow.specRequired) {
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
  lines.push(
    `- ${check(plan.planApproved)} 业务方案：${plan.planApproved ? `已批准（第 ${plan.planRounds}/${budgetOf(state).designLimit} 次设计，${plan.planApprovedAt ?? '?'}）` : plan.planRequired ? `待 Lead 批准（第 ${plan.planRounds}/${budgetOf(state).designLimit} 次设计）` : '豁免'}`,
  )
  if (flow.specRequired) {
    lines.push(`- ${check(state.specPublished)} 技术规格：${state.specPublished ? `v${state.specVersion ?? 0}（SPEC.md）` : '未交付'}`)
  }
  const baseImpl = dispatches.filter((item) => !item.feature && (item.phase === 'implement' || item.phase === 'rework')).length
  lines.push(`- ${check(baseImpl > 0)} 基础层实现：${baseImpl} 轮${state.baseDelivered ? '（已交付）' : ''}`)
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
    if (item.phase === 'review' || item.phase === 'tech-review') {
      const file = item.phase === 'review' ? 'REVIEW.md' : 'TECH-REVIEW.md'
      const text = await readFile(join(taskDir, file), 'utf8').catch(() => '')
      const verdicts = [...text.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi)]
      const verdict = verdicts.at(-1)?.[1]?.toUpperCase() ?? null
      if (item.phase === 'review') state.lastVerdict = verdict
      else state.lastTechVerdict = verdict
      if (text) {
        const name = item.phase === 'review' ? `REVIEW-R${item.round}.md` : `TECH-REVIEW-R${item.round}.md`
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
/** Build the six model-facing tools. */
function createTools(ctx, config, runtime, store) {
  const start = defineTool({
    name: 'squad_start',
    description:
      '创建 Agent Squad 任务：建立共享记忆目录（.agent-squad/<task>/ 下的 TASK.md、JOURNAL.md）并设为当前任务。每个任务先调用一次。',
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
            'Task flow. "full" (default): business plan → Lead approval → technical spec → implementation → technical acceptance → business acceptance. "simple": legacy gates only; choose it explicitly for non-code tasks.',
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
      // R07: starting a new task must not steal `current.json` away from a task
      // whose local children are still active.
      {
        const memory = await memoryDirectory(ctx, lead, config)
        const pointer = await readJson(join(memory, 'current.json'))
        const previous = pointer?.taskId
          ? await readJson(join(memory, pointer.taskId, 'STATE.json'))
          : undefined
        if (previous && previous.phase !== 'done') {
          const treeRows = await treeRowsOf(ctx, lead)
          const active = Object.entries(previous.children ?? {}).filter(
            ([, child]) => child.status === 'provisioning' || isRowRunning(treeRows, child.id),
          )
          if (active.length > 0) {
            throw new Error(
              `当前任务 ${pointer.taskId} 仍有运行中的本地子代理：${active.map(([name]) => name).join(', ')}。先收尾或等它们完成，再开新任务。`,
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
      // Flow snapshot at creation: `full` requires an architect participant to
      // publish the technical spec; without one the task keeps the legacy
      // gates and the start output says so. Legacy states (created before
      // flows existed) read as legacy through flowOf().
      const requestedFlow = args.flow === 'simple' ? 'simple' : 'full'
      const hasBrain = participants.some((agent) => agent.role === 'brain')
      const hasArchitect = participants.some((agent) => agent.role === 'architect')
      const specRequired = requestedFlow === 'full' && hasArchitect
      const flowInfo = {
        flow: specRequired ? 'full' : requestedFlow,
        specRequired,
        downgraded: requestedFlow === 'full' && !hasArchitect,
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
          await writeJson(join(taskDir, 'STATE.json'), {
            taskId,
            createdAt: new Date().toISOString(),
            phase: 'design',
            round: 1,
            reworkRounds: 0,
            flow: requestedFlow,
            specRequired,
            specPublished: false,
            specVersion: 0,
            codeEpoch: 0,
            implementers: [],
            techReview: null,
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
            planRequired: participants.some((agent) => agent.role === 'brain'),
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
        lines.push(`流程：${specRequired ? 'full（业务方案 → 技术规格 → 实现 → 技术验收 → 业务验收）' : requestedFlow === 'simple' ? 'simple（简化：无技术规格/双验收门禁）' : 'simple（兼容：未配置 architect，自动降级）'}`)
        if (flowInfo.downgraded) {
          lines.push('警告：没有 architect 参与，完整流程无法启用：本次任务按简化规则执行（无技术规格与技术验收门禁）。')
        }
        if (!hasBrain) {
          lines.push('警告：没有 brain 参与，任务豁免 PLAN 审批门禁，也无法获得最终的设计/验收评审。')
        }
        lines.push(
          specRequired
            ? '下一步：squad_dispatch({ agent: "codex", phase: "design" }) 写业务方案；Lead 审核后 squad_approve_plan 批准，再派 gpt phase="spec" 发布技术规格，之后才允许 implement。'
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
      await writeJson(join(taskDir, 'STATE.json'), {
        taskId,
        createdAt: new Date().toISOString(),
        phase: 'design',
        round: 1,
        reworkRounds: 0,
        flow: requestedFlow,
        specRequired,
        specPublished: false,
        specVersion: 0,
        codeEpoch: 0,
        implementers: [],
        techReview: null,
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
        planRequired: participants.some((agent) => agent.role === 'brain'),
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
      lines.push(`流程：${specRequired ? 'full（业务方案 → 技术规格 → 实现 → 技术验收 → 业务验收）' : requestedFlow === 'simple' ? 'simple（简化：无技术规格/双验收门禁）' : 'simple（兼容：未配置 architect，自动降级）'}`)
      if (flowInfo.downgraded) {
        lines.push('警告：没有 architect 参与，完整流程无法启用：本次任务按简化规则执行（无技术规格与技术验收门禁）。')
      }
      if (!hasBrain) {
        lines.push('警告：没有 brain 参与，任务豁免 PLAN 审批门禁，也无法获得最终的设计/验收评审。')
      }
      lines.push(
        specRequired
          ? '下一步：squad_dispatch({ agent: "codex", phase: "design" }) 写业务方案；Lead 审核后 squad_approve_plan 批准，再派 gpt phase="spec" 发布技术规格，之后才允许 implement。'
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
        ...(pinned
          ? {
              agentOptions: {
                provider: pinned.provider,
                model: pinned.model,
                ...(target.reasoning ? { reasoningEffort: target.reasoning } : {}),
              },
            }
          : {}),
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
        agent: { type: 'string', description: 'Configured teammate name, e.g. codex.' },
        message: {
          type: 'string',
          description: 'Complete, self-contained assignment for this round.',
        },
        phase: {
          type: 'string',
          enum: ['design', 'spec', 'implement', 'tech-review', 'review', 'rework'],
          description:
            'Pipeline phase. Full flow: design (business plan) → spec (technical spec, architect) → implement → tech-review (architect) → review (business, brain). Use rework when sending acceptance defects back to a worker.',
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
      const directory = await memoryDirectory(ctx, lead, config)
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
      const workerCapable = (agent) => agent.role === 'worker' || agent.worker === true
      const pickSubstitute = (exclude) => {
        // Worker rounds move to another worker-capable member; the architect
        // keeps its own role (its failover path is separate).
        const candidates = roster.filter(
          (agent) =>
            !exclude.includes(agent.name) &&
            agent.role !== 'architect' &&
            workerCapable(agent) &&
            !runtime.isSuspended(agent.name),
        )
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
      // another worker instead (the architect handover stays explicit).
      if (runtime.isSuspended(target.name)) {
        const record = runtime.suspendedRecord?.(target.name)
        const detail = `已挂起${record ? `（自 ${record.at}；原因：${clip(record.reason, 120)}）` : ''}`
        if (target.role === 'architect') {
          throw new Error(
            `队友 ${target.name} ${detail}，不能派单。` +
              `架构师职责由 brain 代行：squad_dispatch({ agent: "codex", phase: "spec" | "tech-review", … })。` +
              `用户确认恢复后调用 squad_failover({ agent: "${target.name}", recover: true }) 解除挂起。`,
          )
        }
        routeToSubstitute(detail)
      }
      const current = await readJson(join(directory, 'current.json'))
      const taskId = String(args.task_id ?? current?.taskId ?? '')
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const taskDir = join(directory, taskId)
      const state = await readJson(join(taskDir, 'STATE.json'))
      if (!state) throw new Error(`未知小队任务 "${taskId}"。先调用 squad_start。`)

      // Flush any settled background run before the gates read STATE, but do
      // not write progress here: a refused dispatch must leave files untouched.
      await flushPendingRuns({ ctx, lead, taskDir, state, signal: exec.signal }).catch(() => {})
      const phase = args.phase ?? 'design'
      const flow = flowOf(state)
      const treeRows = await treeRowsOf(ctx, lead, exec.signal)
      const existing = treeRows.find(
        (row) => (row.name ?? row.label ?? String(row.id)) === target.name,
      )
      const priorRework = Number(state.reworkRounds ?? 0)
      const budget = budgetOf(state)
      // Full-flow rework: resolve which acceptance the defects come from and
      // check that quota; legacy tasks keep the single implement quota. All
      // refusals happen before any shared file or state mutation.
      let reworkKind = null
      if (phase === 'rework' && flow.specRequired) {
        const techVerdict = await readVerdict(taskDir, 'TECH-REVIEW.md')
        const businessVerdict = await readVerdict(taskDir, 'REVIEW.md')
        const businessPending =
          bindingFresh(state.businessReview, state) && businessVerdict === 'CHANGES_REQUESTED'
        const techPending =
          bindingFresh(state.techReview, state) && techVerdict === 'CHANGES_REQUESTED'
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
            '没有待返工的验收结论：先派 tech-review/review 得到 CHANGES_REQUESTED，或确认验收结论未因后续代码/规格变动失效。',
          )
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

      const includeCharter = !existing || !runtime.isInstalled(existing.id)
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
      })

      const executor = target.executor
      const slash = executor === 'local' || executor === 'external'
        ? target.model.indexOf('/')
        : -1
      const pinned =
        slash > 0
          ? { provider: target.model.slice(0, slash), model: target.model.slice(slash + 1) }
          : undefined
      const external = executor === 'external'

      // Unified activity guard (R07): refuse re-dispatch while the target's
      // current binding — local child or team member — is running/provisioning,
      // regardless of executor or model changes. Checked BEFORE any shared
      // file (BRIEF) or state mutation so a refusal leaves them untouched.
      const recordedChild = state.children?.[target.name]
      const childBusy =
        recordedChild !== undefined &&
        (recordedChild.status === 'provisioning' || isRowRunning(treeRows, recordedChild.id))
      const memberBusy = existing !== undefined && existing.activity === 'running'
      if (childBusy || memberBusy) {
        const where = childBusy ? `本地子代理 ${recordedChild.id}` : `队友 ${existing.id}`
        throw new Error(
          `目标 ${target.name} 仍在运行或创建中（${where}）。等它完成后再派单，不能并行重派或切换执行方式。`,
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
      // refused until the Lead approves PLAN.md and (full flow) the architect
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
      // background:false restores the old synchronous call.
      const background = external && args.background !== false
      if (args.background === true && !external) {
        throw new Error('background 仅支持 external 执行者（一次性外部 provider）；local/team 执行者本就不阻塞。')
      }
      if (phase === 'design') {
        if (plan.planApproved) {
          throw new Error(
            `任务 ${taskId} 的 PLAN 已批准（${plan.planApprovedAt ?? '?'}）：不能再派 design 返工，请派 architect 发布技术规格（phase="spec"）。`,
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
            `任务 ${taskId} 未启用完整流程（没有 architect 参与，或创建时选择了 flow="simple"）：不能派 spec，直接按简化流程派单。`,
          )
        }
        // Failover: the brain may act as architect while every roster
        // architect is suspended (quota exhaustion handover).
        const architectAvailable = roster.some(
          (agent) => agent.role === 'architect' && !runtime.isSuspended(agent.name),
        )
        if (target.role !== 'architect' && !(target.role === 'brain' && !architectAvailable)) {
          throw new Error(
            `spec 阶段只能派 architect 角色${architectAvailable ? '' : '（架构师已挂起时可由 brain 代行）'}；${target.name} 当前是 ${target.role}。`,
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
            `任务 ${taskId} 的技术规格尚未交付：先派 architect（gpt）phase="spec" 发布 SPEC.md，再派 ${phase}；规格发布后即可派工，不需要 Lead 再审批。`,
          )
        }
        if (flow.specRequired && target.worker !== true && target.role !== 'worker') {
          throw new Error(
            `完整流程的 ${phase} 需要 worker 能力：${target.name}（${target.role}）的 worker 能力未启用；在设置页开启后即可作为 worker 并行实现。`,
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
        if (target.role !== 'architect' && target.role !== 'brain') {
          throw new Error(
            `tech-review 只能派 architect（gpt），或由 brain（codex）在架构师接手实现后代签；${target.name} 当前是 ${target.role}。`,
          )
        }
        const implementers = Array.isArray(state.implementers) ? state.implementers : []
        if (implementers.includes(target.name)) {
          throw new Error(
            `${target.name} 已在本任务中写代码，不能签署自己改动的技术验收：改派 brain（codex）对照 SPEC.md 独立代签技术验收，业务验收仍由 codex 按业务方案单独签署，两份验收独立记录。`,
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
        let needProbe = args.probe === true || state.probes?.[target.name]?.ok !== true
        while (needProbe && workerCapable(target) && target.executor !== 'team' && !tried.has(target.name)) {
          tried.add(target.name)
          const probe = await probeWorker(target, workspace, lead, exec.signal)
          if (probe.ok) {
            state.probes = { ...(state.probes ?? {}), [target.name]: { at: new Date().toISOString(), ok: true } }
            await writeJson(join(taskDir, 'STATE.json'), state)
            needProbe = false
            break
          }
          const detail = firstLine(String(probe.detail ?? 'unknown'))
          if (!QUOTA_ERROR.test(String(probe.detail))) {
            probeNote = `[可用性门禁] ${target.name} 探测异常（非额度类）：${detail}；继续按计划派发，以实际运行为准。`
            needProbe = false
            break
          }
          await runtime.suspendAgent(target.name, `可用性探测失败：${detail}`, true, target.role)
          routeToSubstitute(`可用性探测失败：${detail}`)
          needProbe = state.probes?.[target.name]?.ok !== true
        }
      }
      await writeBrief({ taskDir, state, agent: target, phase, round })

      let mode
      let sessionId
      let externalText = ''
      let tokens
      // local + `provider/model` = continuable pinned child; the same form on
      // an external executor falls through to the one-shot branch below.
      if (pinned && !external) {
        const subagents = ctx.get('subagents')
        if (!subagents) {
          throw new Error('本地固定模型子代理需要宿主 subagents 服务，但当前不可用。')
        }
        const recorded = state.children?.[target.name]
        const bindingChanged = recorded !== undefined && recorded.model !== target.model
        const existingChild = bindingChanged ? undefined : recorded
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
        })
        if (existingChild === undefined) {
          const childId = randomUUID()
          runtime.registerBinding(childId, target)
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
              name: target.name,
              label: `${taskId}/${phase}/${target.name}`,
              prompt: [{ type: 'text', text: prompt }],
              parent: lead,
              agentOptions: {
                provider: pinned.provider,
                model: pinned.model,
                ...(target.reasoning ? { reasoningEffort: target.reasoning } : {}),
              },
              ...(hasWorkspace ? { cwd: workspace } : {}),
              signal: exec.signal,
              delivery: 'parent',
            })
            sessionId = activation.childId
            state.children[target.name] = { id: childId, model: target.model, status: 'active' }
            mode = 'local'
          } catch (error) {
            delete state.children[target.name]
            await writeJson(join(taskDir, 'STATE.json'), state).catch(() => {})
            throw error
          }
        } else {
          runtime.rebind(existingChild.id, target)
          await moveTeammate(existingChild.id)
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
        })
        const startedAt = Date.now()
        const tokensBefore =
          ['codex', 'codex-cli'].includes(target.model)
            ? await captureCodexTokens(startedAt - 600000)
            : undefined
        // An external `provider/model` form runs a ONE-SHOT pinned child:
        // fresh context on every dispatch, no name/binding, no children
        // entry — the continuable path is the local/team executors.
        const pinnedOptions = pinned
          ? {
              provider: pinned.provider,
              model: pinned.model,
              ...(target.reasoning ? { reasoningEffort: target.reasoning } : {}),
            }
          : undefined
        const activation = await subagents.startActivation({
          provider: pinned ? 'spawn' : target.model,
          ...(pinned ? { agentOptions: pinnedOptions } : {}),
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
        // here, so drop the record instead of resuming a dead child later.
        if (state.children?.[target.name] !== undefined) {
          delete state.children[target.name]
        }
      } else if (!existing) {
        // Team executor: a named continuable child on the Lead's subagent
        // tree (the 0.2.x replacement for agentTeams.spawnTeammate).
        const subagents = ctx.get('subagents')
        if (!subagents) {
          throw new Error('team 执行者需要宿主 subagents 服务，但当前不可用。')
        }
        const provider = target.context === 'fork' ? 'fork' : 'spawn'
        const childId = randomUUID()
        // Publish this round's snapshots before spawning so an agent/created
        // fired mid-spawn already installs the dispatched identity (R08).
        runtime.setPending(target.name, target)
        let activation
        try {
          activation = await subagents.startActivation({
            provider,
            childId,
            name: target.name,
            label: `${taskId}/${phase}/${target.name}`,
            prompt: [{ type: 'text', text: message }],
            parent: lead,
            ...(hasWorkspace ? { cwd: workspace } : {}),
            signal: exec.signal,
            delivery: 'parent',
          })
        } finally {
          runtime.clearPending(target.name)
        }
        mode = 'spawned'
        sessionId = activation.childId
        await moveTeammate(sessionId)
        // Team members carry the dispatch-time settings snapshot, exactly like
        // local children, so later edits cannot restyle their identity (R08).
        runtime.rebind(sessionId, target)
      } else {
        const subagents = ctx.get('subagents')
        if (!subagents) {
          throw new Error('team 执行者需要宿主 subagents 服务，但当前不可用。')
        }
        await moveTeammate(existing.id)
        // Idle resume: refresh the binding and identity section to this
        // round's snapshot before the message is delivered (R08).
        runtime.rebind(existing.id, target)
        await subagents.sendMessage(
          lead,
          existing.id,
          [{ type: 'text', text: message }],
          { signal: exec.signal },
        )
        mode = 'resumed'
        sessionId = existing.id
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
      // architect taking over) advances the candidate code version, so both
      // acceptance bindings go stale until re-examined.
      if (phase === 'implement' || phase === 'rework') {
        state.codeEpoch = Number(state.codeEpoch ?? 0) + 1
        const implementers = Array.isArray(state.implementers) ? state.implementers : []
        if (!implementers.includes(target.name)) {
          state.implementers = [...implementers, target.name]
        }
      }
      if (phase === 'rework') {
        if (flow.specRequired) {
          if (reworkKind === 'business') {
            state.businessReworkRounds = budget.businessUsed + 1
          } else {
            state.techReworkRounds = budget.techUsed + 1
          }
        } else {
          state.reworkRounds = priorRework + 1
        }
      }
      // Executor switched away from local: drop the idle stale child record so
      // one agent never keeps two live bindings (R07).
      if (executor !== 'local' && state.children?.[target.name] && !childBusy) {
        delete state.children[target.name]
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

      const reworkLine = flow.specRequired
        ? `rework: tech=${state.techReworkRounds ?? 0}/${budget.techLimit} business=${state.businessReworkRounds ?? 0}/${budget.businessLimit}`
        : `rework=${state.reworkRounds ?? 0}/${budget.reworkLimit}`
      const actingLine =
        target.role !== 'architect' && (phase === 'spec' || phase === 'tech-review')
          ? ['（代行架构师职责：架构师挂起，交付 SPEC.md / TECH-REVIEW.md）']
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
        ...(phase === 'tech-review'
          ? [`techReview: codeEpoch=${state.codeEpoch ?? 0} specVersion=${state.specVersion ?? 0}${state.lastTechVerdict ? ` verdict=${state.lastTechVerdict}` : ''}（verdict 以 TECH-REVIEW.md 为准）`]
          : []),
      ]
      if (mode === 'local' || mode === 'local-resumed') {
        return [
          `${mode === 'local' ? '已创建' : '已续跑'}本地子代理 ${target.name} [${target.role}] model=${target.model} session=${sessionId}`,
          `task=${taskId} phase=${phase} round=${round} ${reworkLine}`,
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
  // Failover: an architect dispatch that dies with a quota-like error (额度
  // exhausted, 429, insufficient balance…) auto-suspends that architect and
  // enriches the error with the handover guidance; the brain then covers the
  // architect duties for the remaining phases.
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
          target?.role === 'architect' &&
          !runtime.isSuspended(name) &&
          QUOTA_ERROR.test(message)
        ) {
          await runtime.suspendAgent(name, `派单失败自动挂起：${firstLine(message)}`, true, target.role)
          handover = `${message}\n[${name} 已因额度问题自动挂起] 架构师职责改由 brain（codex）代行：重派 squad_dispatch({ agent: "codex", phase: "${args.phase ?? 'design'}", … })；用户确认恢复后 squad_failover({ agent: "${name}", recover: true })。`
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
                      row.role === 'architect' ? '架构师职责由 brain 代行' : '派单将自动改由其他 worker 执行'
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
        ...(flow.specRequired
          ? [
              `SPEC：specRequired=true  specPublished=${state.specPublished === true}  specVersion=${state.specVersion ?? 0}  codeEpoch=${state.codeEpoch ?? 0}  implementers=${(Array.isArray(state.implementers) ? state.implementers : []).join(',') || '—'}`,
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
        `当前目录：${sessionDirectory(ctx, lead)}`,
        ...(backgroundRunning > 0
          ? [`后台执行器运行中：${backgroundRunning} 个（background 派发，结果将以消息送达；squad_finish 会等待）`]
          : []),
        ...workspaceBlock,
        `共享记忆：${taskDir}`,
        '成员：',
        formatMembers(memberRows),
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
                return `- ${name} → ${child.id} (${child.model}) ${status}`
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
          lines.push(
            `- ${item.at} ${item.agent} (${item.role}) phase=${item.phase} round=${item.round} ${item.mode}`,
          )
        }
      }
      return lines.join('\n')
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
      const directory = await memoryDirectory(ctx, me, config)
      const current = await readJson(join(directory, 'current.json'))
      const taskId = current?.taskId ? String(current.taskId) : 'unknown'
      // Dispatch-time snapshot first; fall back to the current settings roster
      // for agents bound before snapshots existed (R08).
      const configured =
        runtime.bindingOf(me.id) ??
        settingsRoster(await store.read(), config).find((agent) => agent.name === name)
      const role = configured?.role ?? 'worker'
      // Failover: an architect reporting blocked with a quota-like summary
      // (额度耗尽/429/insufficient…) auto-suspends it; the Lead gets the
      // handover hint through the report text and squad_status.
      if (args.status === 'blocked' && role === 'architect' && QUOTA_ERROR.test(String(args.summary ?? ''))) {
        try {
          await runtime.suspendAgent(name, `队友报告额度耗尽：${firstLine(args.summary)}`, true, role)
        } catch {}
      }
      let reportProgress = null
      if (current?.taskId) {
        const reportTaskDir = join(directory, String(current.taskId))
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
      const text = `[squad-report] task=${taskId} agent=${name} role=${role} status=${args.status}
总结：
${String(args.summary).trim()}
文件：${files}
下一步：${String(args.next ?? '—').trim()}${reportProgress ? `\n进度同步：${reportProgress}` : ''}`
      if (!subagents || (!rootId && !me.__membership)) {
        throw new Error('squad_report 需要 subagents 服务把报告发给 Lead。')
      }
      await subagents.sendMessage(me, root, [{ type: 'text', text }], {
        signal: exec.signal,
      })
      return `已把报告发给 lead（task=${taskId} status=${args.status}）。`
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
      const directory = await memoryDirectory(ctx, lead, config)
      const current = await readJson(join(directory, 'current.json'))
      const taskId = String(args.task_id ?? current?.taskId ?? '')
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const taskDir = join(directory, taskId)
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
      const directory = await memoryDirectory(ctx, lead, config)
      const current = await readJson(join(directory, 'current.json'))
      const taskId = String(args.task_id ?? current?.taskId ?? '')
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const taskDir = join(directory, taskId)
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
          ? '下一步：squad_dispatch({ agent: "gpt", phase: "spec" }) 发布技术规格 SPEC.md；规格交付后即可派 worker implement，不需要 Lead 再审批。'
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
      '队友可用性恢复（仅 Lead）：解除因额度耗尽等原因挂起的队友（架构师 gpt 或 worker）。架构师挂起时其职责（SPEC.md/TECH-REVIEW.md）由 brain 代行、对它的派单被拒绝；worker 挂起时派单会自动改派其他 worker。自动挂起由派单报错、可用性探测失败或队友上报额度耗尽触发；此工具用于手动挂起架构师（reason）与恢复任意成员（recover: true）。用户确认额度恢复后再传 recover: true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', description: 'Teammate name, e.g. gpt.' },
        reason: { type: 'string', description: 'Why the architect is suspended (required unless recovering).' },
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
          record?.role === 'architect'
            ? `下次派单恢复正常（spec/tech-review 重新派给它；挂起期间由 brain 代行的结论仍有效）。`
            : `下次派单恢复由它执行（挂起期间由其他 worker 代行的结论仍有效）。`,
        ].join('\n')
      }
      if (args.recover !== undefined) throw new Error('recover 只能是 true（解除挂起）或省略（挂起）。')
      if (target.role !== 'architect') {
        throw new Error(`仅架构师支持挂起交接（brain 代行架构师职责）；${name} 当前是 ${target.role}。`)
      }
      if (runtime.isSuspended(name)) {
        const record = runtime.suspendedRecord?.(name)
        throw new Error(`${name} 已处于挂起状态${record ? `（自 ${record.at}；原因：${clip(record.reason, 80)}）` : ''}，不能重复挂起。`)
      }
      const reason = String(args.reason ?? '').trim()
      if (!reason) throw new Error('reason 必须是非空字符串（挂起原因）。')
      await runtime.suspendAgent(name, reason, false, target.role)
      return [
        `架构师 ${name} 已挂起（原因：${reason}）。`,
        '架构师职责由 brain（codex）代行：squad_dispatch({ agent: "codex", phase: "spec" | "tech-review", … })；对挂起队友的派单会被拒绝。',
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
      const directory = await memoryDirectory(ctx, lead, config)
      const current = await readJson(join(directory, 'current.json'))
      const taskId = String(args.task_id ?? current?.taskId ?? '')
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const taskDir = join(directory, taskId)
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
      const directory = await memoryDirectory(ctx, lead, config)
      const current = await readJson(join(directory, 'current.json'))
      const taskId = String(args.task_id ?? current?.taskId ?? '')
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const taskDir = join(directory, taskId)
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
      '为当前会话启用 Agent Squad（智能体小队）。仅当用户明确要求使用小队时调用（例如“用小队实现”“用智能体小队做这个任务”“use the agent squad”）；仅提到队友名字（codex/gpt/zcode/qoder）不算启用，普通任务直接自己做，不要调用本工具。插件重载后若小队会话失去身份，也用本工具恢复。调用后本会话成为 Squad Lead，获得 squad_* 工具与 Lead 章程。',
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
          '小队角色：codex [brain] 业务设计与验收；gpt [architect] 系统架构师（技术规格 + 技术验收，可接手实现）；zcode [worker] 后端实现与自测；qoder [worker] 前端产品实现与自测。',
          '完整流程：squad_start → codex design（业务方案）→ Lead 审核后 squad_approve_plan → gpt spec（技术规格）→ worker implement → gpt tech-review → codex review（业务验收）→ squad_finish。非代码任务可在 squad_start 时传 flow="simple"。',
          '用户没有明确要求时不要启用小队；提到队友名字也不算启用。',
        ].join('\n')
      }
      return '当前会话已启用 Agent Squad（你是 Squad Lead）。用 squad_status 查看状态。'
    },
  })

  return { start, dispatch, status, wait, report, finish, approvePlan, extend, enable, failover, parallelStart, deliver }
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
  // Failover state: suspended teammates (quota-exhausted architects) persist
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
    bindingOf: (sessionId) => agentBindings.get(sessionId),
    setPending: (name, agentConfig) => pendingByName.set(name, agentConfig),
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
  for (const [definition, condition] of [
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
  ]) {
    ctx.tools.register(definition, { when: ({ agent }) => condition(agent) })
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
