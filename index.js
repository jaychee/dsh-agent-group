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
6. 派 worker，phase="implement"：zcode 负责后端，qoder 负责前端产品代码；都按 PLAN-APPROVED.md + SPEC.md 实现并自测，写 REPORT.md。**两层并行是默认运行方式**：① 小队层——external 执行者的 implement/rework 默认后台派发（不阻塞，结果完成时以消息送达），连续派多个 worker 并行跑（如 zcode 后端 + qoder 前端同时）；需要在本回合同步拿结果时才传 background: false；② worker 层——派单消息把可并行的独立文件/模块逐项列出，worker 默认用自己的子代理同时开发（只改规格内文件、逐条 AC 留证）。
7. 派 gpt，phase="tech-review"：技术验收，附实际 diff 与测试证据，写 TECH-REVIEW.md。
8. 技术验收 changes_requested → 把编号缺陷派回对应 worker，phase="rework"（技术返工额度 ${MAX_TECH_REWORK_ROUNDS} 轮，前后端共享、不因换人或规格修订重置；未扩展时第 4 轮暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="tech", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派）。
9. 技术验收 approved → 派 codex，phase="review"：业务验收，写 REVIEW.md。
10. 业务验收 changes_requested → phase="rework"（业务返工额度 ${MAX_BUSINESS_REWORK_ROUNDS} 轮，与技术额度独立计数；业务返工改了代码后必须重新通过技术验收，再重新业务验收）。
11. 两份验收都 approved 且仍然新鲜（代码/规格未再变动）→ squad_finish 收尾，随后向用户汇总交付结果。

规则：
- 你是组织者，不写业务代码；自己的改动只限协调文件与最终整合。
- 三种批准相互独立：squad_approve_plan 批准的是「业务方案」，TECH-REVIEW.md 的 VERDICT: APPROVED 批准的是「技术」，REVIEW.md 的 VERDICT: APPROVED 批准的是「业务」；任何一个不能替代另一个。代码、规格或方案变动后旧结论失效，不能用旧批准收尾。
- worker 不可用时可直接指定 gpt 接手实现（phase="implement"/"rework"）；${MAX_TECH_REWORK_ROUNDS} 轮技术返工仍未通过时先问用户是否继续，获准继续后直接派 gpt 接手，不需要再次确认选人。gpt 接手写代码后不能自签技术验收：tech-review 改派 codex 对照 SPEC.md 独立代签技术验收，业务验收仍由 codex 按业务方案单独签署，两份验收独立记录。
- 一个角色一个 agent。按能力选 worker：zcode 负责后端实现，qoder 负责前端产品实现与自测。
- 每次派单后结束当前回合，等队友的 squad_report 唤醒你；查看状态用 squad_status，只有必须在本回合阻塞时才用 squad_wait。
- 队友在跑时不得声称完成；没有双验收不得接受结果。
- 技术返工与业务返工各自默认最多 3 轮、独立计数、互不重置。任一到上限就暂停派单，先向用户说明阻塞点与已完成部分并等待决策；仅用户明确同意后调用 squad_extend(kind="tech"/"business", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派单，每次扩展都要重新确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。
- 外部 provider（agent 配置里 provider 非空且不是 spawn/fork）走一次性派发：squad_dispatch 阻塞到它返回并把结果直接给你；它不会 squad_report，也不能续跑。返工=再派一次，必须重发 BRIEF 与编号缺陷。
- 外部 agent 不共享你的会话上下文，只读共享文件；派单靠路径和编号，不要假设它记得上一轮。
- 默认在 worktree 分支开发：squad_start 会创建新分支并切过去；不要在源 checkout 上直接改业务代码。
- 收尾：双验收 approved 后调用 squad_finish（提交 worktree 改动、切回源目录、给出分支与合并命令）。
- 队友共享你的工作目录与 .agent-squad 记忆，不要重复他们的工作。
- 架构师容错：gpt 因额度耗尽不可用时（派单报出额度类错误或队友上报额度耗尽），插件会自动挂起 gpt 并提示改派；架构师职责（spec 与 tech-review）由 codex 代行完成剩下的任务。也可手动 squad_failover({ agent: "gpt", reason: "原因" }) 挂起。挂起期间派 gpt 会被拒绝；用户确认额度恢复后调用 squad_failover({ agent: "gpt", recover: true }) 交还职责。
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
    description: '前端 worker：实现前端产品代码并自测。',
    provider: '',
    context: 'fresh',
    charter: `前端执行者分工：
- 负责前端产品代码的实现：页面、样式、交互与前端状态，并编写/运行 UI 与组件测试、构建验证。
- 边界：不改后端代码；涉及接口契约的问题报告 Lead 转交 zcode，不代改。`,
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
  const names = ['TASK.md', 'PLAN.md', 'SPEC.md', 'TECH-REVIEW.md', 'REVIEW.md', 'REPORT.md', 'JOURNAL.md']
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
        const worktrees = created.worktrees
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
        worktrees: worktree ? [{ ...worktree, repo: worktree.repositoryRoot }] : [],
        taskRoot: worktree ? worktree.path : sourceDirectory,
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
      return lines.join('\n')
    },
  })

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
      const target = roster.find((agent) => agent.name === args.agent)
      if (!target) {
        throw new Error(
          `未知 agent "${args.agent}"。已配置 agent：${roster.map((agent) => agent.name).join(', ') || '（无）'}`,
        )
      }
      // Failover: a suspended teammate (e.g. the architect after quota
      // exhaustion) refuses every dispatch until squad_failover recovers it.
      if (runtime.isSuspended(target.name)) {
        const record = runtime.suspendedRecord?.(target.name)
        throw new Error(
          `队友 ${target.name} 已挂起${record ? `（自 ${record.at}；原因：${clip(record.reason, 80)}）` : ''}，不能派单。` +
            (target.role === 'architect'
              ? `架构师职责由 brain 代行：squad_dispatch({ agent: "codex", phase: "spec" | "tech-review", … })。`
              : '') +
            `用户确认恢复后调用 squad_failover({ agent: "${target.name}", recover: true }) 解除挂起。`,
        )
      }
      const current = await readJson(join(directory, 'current.json'))
      const taskId = String(args.task_id ?? current?.taskId ?? '')
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const taskDir = join(directory, taskId)
      const state = await readJson(join(taskDir, 'STATE.json'))
      if (!state) throw new Error(`未知小队任务 "${taskId}"。先调用 squad_start。`)

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
      const workspace = workspaceOf(state, sessionDirectory(ctx, lead))
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
      // Parallel-by-default (squad layer): external one-shot executors would
      // block the tool call until they return, serializing the workers.
      // implement/rework dispatches therefore default to background delivery
      // ('parent': the result reaches the Lead as a message) so several
      // workers can run concurrently; background:false forces the old
      // blocking call. The review-family phases still read the deliverable
      // right after the result and stay synchronous either way.
      const background =
        external && (phase === 'implement' || phase === 'rework') && args.background !== false
      if (args.background === true && (!external || (phase !== 'implement' && phase !== 'rework'))) {
        throw new Error(
          !external
            ? 'background 仅支持 external 执行者（一次性外部 provider）；local/team 执行者本就不阻塞。'
            : 'background 仅支持 implement/rework 阶段；design/spec/review/tech-review 需要同步读取交付物，不能后台派发。',
        )
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
        if (flow.specRequired && target.role !== 'worker' && target.role !== 'architect') {
          throw new Error(
            `完整流程的 ${phase} 只能派 worker，或由 architect 接手实现；${target.name} 当前是 ${target.role}。`,
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
        if (background) {
          // Fire-and-report: the runtime delivers the result to the Lead as a
          // message when the run finishes; the plugin does not await it, so
          // the Lead can keep dispatching (parallel workers).
          mode = 'external-background'
          await appendFile(
            join(taskDir, 'RUNS.md'),
            `\n## ${new Date().toISOString()} ${target.name} (${target.role}) phase=${phase} round=${round} provider=${target.model} mode=background（结果将以后台消息送达 Lead）\n`,
            'utf8',
          ).catch(() => {})
        } else {
          let result
          try {
            result = await activation.result
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
        const reviewText = await readFile(join(taskDir, 'REVIEW.md'), 'utf8').catch(() => '')
        const verdicts = [
          ...reviewText.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi),
        ]
        state.lastVerdict = verdicts.at(-1)?.[1]?.toUpperCase() ?? null
        if (reviewText) {
          await writeFile(join(taskDir, `REVIEW-R${round}.md`), reviewText, 'utf8').catch(() => {})
        }
        // Full flow: bind the business acceptance to the code/spec version it
        // examined; a later implement/rework/spec dispatch makes it stale.
        if (flow.specRequired) {
          state.businessReview = {
            codeEpoch: Number(state.codeEpoch ?? 0),
            specVersion: Number(state.specVersion ?? 0),
            reviewer: target.name,
            at: new Date().toISOString(),
          }
        }
      }
      if (phase === 'tech-review') {
        const techText = await readFile(join(taskDir, 'TECH-REVIEW.md'), 'utf8').catch(() => '')
        const techVerdicts = [
          ...techText.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi),
        ]
        state.lastTechVerdict = techVerdicts.at(-1)?.[1]?.toUpperCase() ?? null
        if (techText) {
          await writeFile(join(taskDir, `TECH-REVIEW-R${round}.md`), techText, 'utf8').catch(() => {})
        }
        state.techReview = {
          codeEpoch: Number(state.codeEpoch ?? 0),
          specVersion: Number(state.specVersion ?? 0),
          reviewer: target.name,
          at: new Date().toISOString(),
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
        if (external) {
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
        if (external) {
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
        ...(external ? { provider: target.model } : {}),
        ...(tokens === undefined ? {} : { tokens }),
      })
      if (state.dispatches.length > 50) state.dispatches = state.dispatches.slice(-50)
      await writeJson(join(taskDir, 'STATE.json'), state)
      await appendFile(
        join(taskDir, 'JOURNAL.md'),
        `- ${new Date().toISOString()} lead → ${target.name} (${target.role}) phase=${phase} round=${round} mode=${mode}${reworkKind ? ` kind=${reworkKind}` : ''}\n`,
        'utf8',
      ).catch(() => {})

      const reworkLine = flow.specRequired
        ? `rework: tech=${state.techReworkRounds ?? 0}/${budget.techLimit} business=${state.businessReworkRounds ?? 0}/${budget.businessLimit}`
        : `rework=${state.reworkRounds ?? 0}/${budget.reworkLimit}`
      const actingLine =
        target.role !== 'architect' && (phase === 'spec' || phase === 'tech-review')
          ? ['（代行架构师职责：架构师挂起，交付 SPEC.md / TECH-REVIEW.md）']
          : []
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
          await runtime.suspendAgent(name, `派单失败自动挂起：${firstLine(message)}`, true)
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
      const lines = [
        `${PLUGIN_MARKER}  task=${taskId}  phase=${state.phase ?? 'unknown'}  round=${state.round ?? '?'}  flow=${flow.flow}  created=${state.createdAt ?? '?'}`,
        (() => {
          const rows = runtime.suspendedRows()
          return rows.length === 0
            ? '挂起：无'
            : `挂起：${rows.map((row) => `${row.name}（自 ${row.at}；${row.auto ? '自动' : '手动'}；原因：${clip(row.reason, 60)}）→ 架构师职责由 brain 代行`).join('；')}`
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
          await runtime.suspendAgent(name, `队友报告额度耗尽：${firstLine(args.summary)}`, true)
        } catch {}
      }
      if (current?.taskId) {
        const journal = join(directory, String(current.taskId), 'JOURNAL.md')
        await appendFile(
          journal,
          `- ${new Date().toISOString()} ${name} (${role}) report=${args.status} — ${firstLine(args.summary)}\n`,
          'utf8',
        ).catch(() => {})
      }
      const files = Array.isArray(args.files) && args.files.length > 0 ? args.files.join(', ') : '—'
      const text = `[squad-report] task=${taskId} agent=${name} role=${role} status=${args.status}
总结：
${String(args.summary).trim()}
文件：${files}
下一步：${String(args.next ?? '—').trim()}`
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
      const reviewRequired = state.gate?.reviewRequired !== false
      const flow = flowOf(state)
      if (flow.specRequired) {
        // Full flow: technical acceptance first, then business acceptance.
        // Each must end with VERDICT: APPROVED and its binding must still be
        // fresh — any code or spec dispatch after the review invalidates it.
        const tech = await readFile(join(taskDir, 'TECH-REVIEW.md'), 'utf8').catch(() => '')
        if (!tech) throw new Error('缺少 TECH-REVIEW.md：先让 gpt 技术验收（或由 codex 代签）并写 TECH-REVIEW.md。')
        const techVerdicts = [
          ...tech.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi),
        ]
        const techLast = techVerdicts.at(-1)?.[1]?.toUpperCase()
        if (techLast !== 'APPROVED') {
          throw new Error(
            `TECH-REVIEW.md 最后一条 VERDICT 不是 APPROVED（当前：${techLast ?? '缺失'}）；需要以 \`VERDICT: APPROVED\` 结束。`,
          )
        }
        if (!bindingFresh(state.techReview, state)) {
          throw new Error(
            '技术验收结论已失效：验收后代码或规格又发生了变动（codeEpoch/specVersion 不一致）。重新派 tech-review 通过后再收尾。',
          )
        }
      }
      if (reviewRequired) {
        const review = await readFile(join(taskDir, 'REVIEW.md'), 'utf8').catch(() => '')
        if (!review) throw new Error('缺少 REVIEW.md：先让 brain 验收并写 REVIEW.md。')
        const verdicts = [
          ...review.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi),
        ]
        const last = verdicts.at(-1)?.[1]?.toUpperCase()
        if (last !== 'APPROVED') {
          throw new Error(
            `REVIEW.md 最后一条 VERDICT 不是 APPROVED（当前：${last ?? '缺失'}）；需要以 \`VERDICT: APPROVED\` 结束。`,
          )
        }
        if (flow.specRequired && !bindingFresh(state.businessReview, state)) {
          throw new Error(
            '业务验收结论已失效：验收后代码或规格又发生了变动（codeEpoch/specVersion 不一致）。重新派 review 通过后再收尾。',
          )
        }
      }

      const summary = String(args.summary ?? '').trim() || '任务完成'
      const repoRows = worktreesOf(state)

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
      let planText
      try {
        planText = await readFile(join(taskDir, 'PLAN.md'), 'utf8')
      } catch {
        throw new Error(
          `任务 ${taskId} 缺少可读的 PLAN.md：先派 brain（phase="design"）产出方案，再调用 squad_approve_plan。`,
        )
      }
      const plan = planGateOf(state)
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
      '架构师容错交接（仅 Lead）：把因额度耗尽等原因不可用的架构师（gpt）挂起，其职责（SPEC.md 技术规格、TECH-REVIEW.md 技术验收）由 brain（codex）代行直到恢复；挂起期间对它的派单被拒绝。派单报出额度类错误、或架构师 squad_report 上报额度耗尽时会自动挂起，此工具用于手动挂起与恢复。用户确认架构师已恢复（额度重置/换 key）后再传 recover: true。',
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
        await runtime.recoverAgent(name)
        return [
          `队友 ${name} 已解除挂起，恢复架构师职责。`,
          `下次派单恢复正常（spec/tech-review 重新派给它；挂起期间由 brain 代行的结论仍有效）。`,
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
      await runtime.suspendAgent(name, reason, false)
      return [
        `架构师 ${name} 已挂起（原因：${reason}）。`,
        '架构师职责由 brain（codex）代行：squad_dispatch({ agent: "codex", phase: "spec" | "tech-review", … })；对挂起队友的派单会被拒绝。',
        `用户确认恢复后调用 squad_failover({ agent: "${name}", recover: true })。`,
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

  return { start, dispatch, status, wait, report, finish, approvePlan, extend, enable, failover }
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
      })),
    suspendAgent: async (name, reason, auto) => {
      suspended.set(name, { at: new Date().toISOString(), reason: String(reason ?? ''), auto: auto === true })
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
