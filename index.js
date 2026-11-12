/**
 * Agent Squad — role-based local agent team for DeepSeek Harness.
 *
 * The squad is a thin, opinionated role layer over the shipped experimental
 * Agent Teams runtime (`ctx.agentTeams`):
 *
 *   lead   — the DSH session itself; orchestrates and assigns work.
 *   brain  — designs the plan and acceptance bar, then reviews the result.
 *   worker — implements the approved plan and runs the tests.
 *
 * Context policy:
 *   - A teammate is a durable, continuable child of the Lead. Re-dispatching an
 *     existing teammate sends a message into the *same* session, so a rework
 *     round continues the previous conversation instead of paying for a new one.
 *   - Cross-agent memory lives in `<workspace>/.agent-squad/<task>/`: TASK.md,
 *     PLAN.md, REVIEW.md, REPORT.md, JOURNAL.md. Every assignment points at that
 *     directory, so agents exchange artifacts rather than transcript copies.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { createSettingsStore, seedFromBundle } from './settings.js'
import { registerRoutes } from './http.js'
import { createSquadWorktree, createSquadWorktrees, rollbackSquadWorktrees } from './worktree.js'
import { createQoderProvider } from './qoder.js'

const runFile = promisify(execFile)

/** Cordis plugin name. */
export const name = 'agent-squad'

/** Services this plugin builds on. Activation waits for the Team runtime. */
export const inject = ['agentTeams', 'agents', 'tools', 'systemPrompt']

/** Order of the squad prompt sections relative to first-party guidance. */
const SECTION_ORDER = 610

/** Directory (relative to the session workspace) that holds shared memory. */
const DEFAULT_MEMORY_DIR = '.agent-squad'

const MAX_REWORK_ROUNDS = 3
/** Design budget: initial design + at most 3 rework rounds = 4 design dispatches. */
const MAX_DESIGN_REWORK_ROUNDS = 3
const MAX_PLAN_ROUNDS = 1 + MAX_DESIGN_REWORK_ROUNDS

/** Liveness marker surfaced by squad_status; changes whenever behavior changes. */
const PLUGIN_MARKER = 'agent-squad/zh-v7'

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
    designUsed: Number(state.planRounds ?? 0),
    implementUsed: Number(state.reworkRounds ?? 0),
  }
}

const BRAIN_CHARTER = `你是小队里的思考者，负责方案与验收标准。

- 把目标写成可执行规格，存入 PLAN.md：逐个列出新增、修改、删除的文件路径，每个文件写明改动位置、改动要点及对应 AC 编号。
- 逐项写出接口名称与精确签名、参数类型与默认值、返回类型与返回值；错误必须写明错误类型、触发条件与完整消息。没有接口变更时明确写“无接口变更”，并列出须保留的接口与错误行为。
- 列出边界输入与精确期望值；逐项指定测试文件、测试名、输入和期望输出。每条 AC 必须给出可直接执行的验证命令、执行目录、退出码与通过条件，并映射到改动文件和测试名。
- 在“假设与待确认”中显式列出假设及影响；未确定且影响实现的事项标为待确认，不能让 worker 猜测。禁止使用“适当”“合理”“类似”“等等”“参考现有实现”替代具体规格。
- 写完后自检“一个没有上下文的 worker 能否只靠 PLAN 完成”，把结论写入 PLAN.md；不能时补全规格，或列入“假设与待确认”并标明阻塞项，不得宣称方案可执行。
- 被要求验收时，以 PLAN-APPROVED.md 为唯一权威规格，逐条核对 AC 并在 REVIEW.md 写明 AC 编号、文件路径、测试名、验证命令、退出码、关键输出与结论；亲自运行或检查测试，不接受没有证据的声明。
- 只有每条标准都有证据通过时才报 "approved"；否则报 "changes_requested"，给出编号缺陷清单和每项的最小修复方案。
- REVIEW.md 的最后一行必须是机器可读的「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」（Lead 的收尾门禁只认这一行）。
- 不写生产代码；一次性探针脚本可以放在 /tmp。
- 方案要克制：计划正文默认不超过约 80 行；测试数量不超过 max(6, 验收条数×2)，除非任务确实更复杂，并在 PLAN.md 里说明理由。
- 不扩大范围，取满足目标的最小方案。`

const WORKER_CHARTER = `你是小队里的执行者，严格按已批准的方案实现。

- 动手前先读 TASK.md 和 PLAN-APPROVED.md。PLAN-APPROVED.md 是实现、返工与验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- 只做方案定义的最小改动；不得引入方案未定义的接口、文件或依赖，不重新设计、不改名、不扩大范围。
- 规格缺失、矛盾或明显错误时立即停止实现，报 "blocked"，引用 PLAN-APPROVED.md 的具体章节与 AC 编号，并列出缺失项或冲突原文；需要批准归档而文件缺失时明确引用文件名；豁免任务引用 TASK.md 章节或 Lead 派单条目。不得自行补全规格或改用 PLAN.md。
- 按 PLAN-APPROVED.md 指定的测试名、输入与期望输出写或更新测试，并亲自运行每条 AC 的验收命令；豁免任务按 TASK.md 与 Lead 本轮派单执行。
- 在 REPORT.md 逐条 AC 给证据：AC 编号、改动文件路径、测试名、实际命令、退出码、关键输出与结论；失败或未执行必须如实标注，不得只写“测试通过”。
- 返工派单仍是在同一段对话里：逐条修复验收提出的编号缺陷，重跑完整相关测试，再次报告。`

const LEAD_POLICY = `Agent Squad 已启用：你是 Lead，小队里有按角色分工的队友。

非平凡任务按以下流程（先审方案再实现）：
1. 调用 squad_start 一次，写入目标与验收标准（验收标准确实含糊时先问用户）。
2. 派 brain 队友，phase="design"。读共享目录里的 PLAN.md。
3. Lead 亲自做 PLAN.md 的可执行性审核：假装自己是一个没有上下文的 worker，逐项检查文件改动、接口与错误、边界值、测试预期、AC 验证命令和假设；无法只靠 PLAN 实现、需要 worker 猜测的点一律按 D1 起连续编号，写明章节、缺失或矛盾、最小补全要求，派回 brain（phase="design"）返工迭代，默认初始设计 + ${MAX_DESIGN_REWORK_ROUNDS} 轮返工 = ${MAX_PLAN_ROUNDS} 次 design 派单，未扩展时第 ${MAX_PLAN_ROUNDS + 1} 次暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派 design；方案合格后调用 squad_approve_plan 批准（归档 PLAN-APPROVED.md）。有 brain 参与的任务，PLAN 未批准前 implement/rework 派单会被拒绝；没有 brain 参与的任务豁免此门禁。
4. 批准后派一个 worker，phase="implement"，给出 PLAN-APPROVED.md 路径、文件范围与本轮 AC 编号映射。
5. 派 brain，phase="review"，附上实际 diff 与测试证据。
6. 若验收返回 changes_requested，把同样的缺陷派回同一个 worker，phase="rework"。进程内队友会续跑同一会话；外部 provider（codex 等）是一次性调用，返工必须重发 BRIEF 与编号缺陷。
7. 只有 brain 的 "approved" 才能收尾；随后向用户汇总交付结果。

规则：
- 你是组织者，不写业务代码；自己的改动只限协调文件与最终整合。
- 两种批准相互独立：Lead 用 squad_approve_plan 批准的是「方案」，brain 在 REVIEW.md 给出的 VERDICT: APPROVED 批准的是「实现」；前者不能替代后者，收尾仍然只认 brain 验收。设计预算（默认初始 + ${MAX_DESIGN_REWORK_ROUNDS} 轮返工 = ${MAX_PLAN_ROUNDS} 次 design 派单）与实现返工预算（默认 ${MAX_REWORK_ROUNDS} 轮）也相互独立、分别计数，两类预算均可由用户决定追加。
- 一个角色一个 agent。按能力选 worker：zcode 负责实现，qoder 负责并行或前端偏重的改动。
- 每次派单后结束当前回合，等队友的 squad_report 唤醒你；查看状态用 squad_status，只有必须在本回合阻塞时才用 squad_wait。
- 队友在跑时不得声称完成；没有 brain 验收不得接受结果。
- 同一个任务的实现返工默认最多 ${MAX_REWORK_ROUNDS} 轮；设计返工默认最多 ${MAX_DESIGN_REWORK_ROUNDS} 轮。任一到上限就暂停派单，先向用户说明阻塞点与已完成部分并等待决策；仅用户明确同意后调用 squad_extend(kind/rounds/reason/confirmed=true) 追加轮次再派单，每次扩展都要重新确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。
- 外部 provider（agent 配置里 provider 非空且不是 spawn/fork）走一次性派发：squad_dispatch 阻塞到它返回并把结果直接给你；它不会 squad_report，也不能续跑。返工=再派一次，必须重发 BRIEF 与缺陷清单。
- 外部 agent 不共享你的会话上下文，只读共享文件；派单靠路径和编号，不要假设它记得上一轮。
- 默认在 worktree 分支开发：squad_start 会创建新分支并切过去；不要在源 checkout 上直接改业务代码。
- 收尾：brain approved 后调用 squad_finish（提交 worktree 改动、切回源目录、给出分支与合并命令）。
- 队友共享你的工作目录与 .agent-squad 记忆，不要重复他们的工作。
- 面向用户的回复必须使用用户所用的语言（用户用中文就用中文）；角色章程的语言不影响你回复用户的语言。`

const DEFAULT_AGENTS = [
  {
    name: 'codex',
    role: 'brain',
    description: '负责方案设计与验收标准，并对实现做最终验收。',
    provider: '',
    context: 'fresh',
    charter: '',
  },
  {
    name: 'zcode',
    role: 'worker',
    description: '按已批准方案实现并运行测试。',
    provider: '',
    context: 'fresh',
    charter: '',
  },
  {
    name: 'qoder',
    role: 'worker',
    description: '第二执行者，负责并行任务或前端偏重的改动。',
    provider: '',
    context: 'fresh',
    charter: '',
  },
]

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
    workerCharter: text(config.workerCharter, WORKER_CHARTER),
    agents,
    worktreeDir: text(config.worktreeDir, '.agents/worktrees'),
    worktreeFrom: text(config.worktreeFrom, 'HEAD'),
    worktreeAutoCommit: config.worktreeAutoCommit !== false,
    qoderCommand: text(config.qoderCommand, 'qoderclicn'),
    qoderPermissionMode: text(config.qoderPermissionMode, 'accept_edits'),
    qoderModel: text(config.qoderModel, ''),
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
      role: entry.role === 'brain' ? 'brain' : 'worker',
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
  return agent.role === 'brain' ? config.brainCharter : config.workerCharter
}

function teammatePrompt(agent, config) {
  return `你是 "${agent.name}"，DSH Agent Squad 里的 ${agent.role} 角色。Team Lead 的代号是 "lead"。

${charterFor(agent, config)}

共享记忆：每次派单都会给出共享目录。先读 TASK.md；PLAN.md、REVIEW.md、REPORT.md、JOURNAL.md 分别承载方案、验收结论、交付证据与历史。保持这些文件最新，队友才能不靠复述对话协作。
- PLAN-APPROVED.md 是实现、返工与验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/REVIEW.md 按批准方案逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。

汇报：任务完成、受阻或验收结束时，调用一次 squad_report，带上 status、简短总结和改动文件。Lead 会被这条报告唤醒。不要创建队友或重新分配工作。`
}

function repoLines(worktrees) {
  return worktrees.map(
    (wt) => `仓库：${wt.repo} | worktree：${wt.path} | 分支：${wt.branch} | 基线：${wt.baseCommit}`,
  )
}

function renderTask({ taskId, goal, acceptance, constraints, participants, taskDir, worktree, worktrees = [], workspace }) {
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

- 任何派单动手前先读本文件。
- Lead 先审方案再实现：\`brain\` 写 \`PLAN.md\` 后由 Lead 审核并用 \`squad_approve_plan\` 批准（Lead 只批准**方案**，归档 \`PLAN-APPROVED.md\`）；设计问题须带编号缺陷再派 \`phase="design"\` 返工；默认初始设计 + 3 轮返工 = 4 次 design 派单，未扩展时第 5 次暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派 design；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。未批准前不派 implement/rework（无 brain 任务豁免）。
- \`brain\` 写 \`PLAN.md\`（方案 + 编号验收标准）与 \`REVIEW.md\`（逐条结论与证据）。
- \`worker\` 写 \`REPORT.md\`（改动、执行的命令、测试证据）。
- PLAN-APPROVED.md 是实现、返工与验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/REVIEW.md 按批准方案逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。
- 每个成员在调用 \`squad_report\` 前，向 \`JOURNAL.md\` 追加一条简短记录。
- 实现验收只有 \`brain\` 能批准（\`REVIEW.md\` 以 \`VERDICT: APPROVED\` 结束），与 Lead 的方案批准相互独立；实现返工独立计数，默认 3 轮，未扩展时第 4 次暂停：先向用户说明阻塞点与已完成部分并等待决策，用户同意后调用 squad_extend(kind="implement", rounds=3, reason="用户批准的追加理由", confirmed=true) 追加轮次再派 rework；每次扩展都要重新取得用户明确确认，可重复扩展，不自动续跑；用户拒绝或未回复时保持暂停。Lead 在 brain 批准后收尾。
- 记忆目录：\`${taskDir}\`

## 成员

| 名称 | 角色 | 上下文 | 职责 |
| --- | --- | --- | --- |
${members}
`
}

function renderDispatch({ taskId, taskDir, phase, round, agent, message, includeCharter, config, workspace, worktrees = [] }) {
  const deliverable =
    agent.role === 'brain'
      ? '设计轮写 PLAN.md 的可执行规格与 AC 映射；验收轮依据 PLAN-APPROVED.md 写 REVIEW.md，逐条 AC 给结论与证据。'
      : '写 REPORT.md，按 PLAN-APPROVED.md 逐条 AC 记录改动、测试名、命令、退出码、关键输出与结论；豁免任务按 TASK.md 与 Lead 本轮派单逐条 AC 留证。'
  const charter = includeCharter ? `\n角色章程：\n${charterFor(agent, config)}\n` : ''
  const repoBlock = worktrees.length > 1 ? `${repoLines(worktrees).join('\n')}\n` : ''
  return `[Agent Squad] task=${taskId} phase=${phase} round=${round} role=${agent.role}
${charter}
共享记忆：${taskDir}
工作区：${workspace}
${repoBlock}（只在工作区内改动；动手前先确认 pwd 与它一致，不要写回源 checkout。）
先读 TASK.md；设计轮读取 PLAN.md（存在时）；读取 JOURNAL.md 最后 80 行。
- PLAN-APPROVED.md 是实现、返工与验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/REVIEW.md 按批准方案逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。

Lead 的本轮派单：
${message}

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
  const names = ['TASK.md', 'PLAN.md', 'REVIEW.md', 'REPORT.md', 'JOURNAL.md']
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
  const lines = [
    `# BRIEF · ${state.taskId}`,
    '',
    `phase=${phase} round=${round} rework=${state.reworkRounds ?? 0}/${budget.reworkLimit}`,
    `agent=${agent.name} role=${agent.role}`,
    '',
    '## 目标 / 验收 / 约束',
    '见同目录 TASK.md（先读，本文件不复述）。',
    '',
    '## 必读',
    '- TASK.md',
    '- PLAN.md（仅设计轮；存在时）',
    '- PLAN-APPROVED.md（实现、返工与验收；豁免且无归档时按 TASK.md 与本轮派单）',
    '- REVIEW.md（存在时：上一轮验收结论）',
    '- REPORT.md（存在时：实现证据）',
    '- JOURNAL.md 最后 40 行',
    '',
    '- PLAN-APPROVED.md 是实现、返工与验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。',
    '- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。',
    '- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/REVIEW.md 按批准方案逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。',
    '',
    '## 交付',
    agent.role === 'brain'
      ? '- 设计轮写 PLAN.md；验收轮写 REVIEW.md（逐条 AC + 证据）'
      : '- 写 REPORT.md（逐条 AC：文件路径、测试名、命令、退出码、关键输出与结论）',
    '- 只回复 ≤150 字摘要 + 文件路径，不回贴正文',
  ]
  await writeFile(join(taskDir, 'BRIEF.md'), `${lines.join('\n')}\n`, 'utf8')
}

/** Prompt for an external one-shot or a local pinned-model child. */
function dispatchPrompt({ mode, taskId, taskDir, phase, round, agent, message, workspace, config, includeCharter = true, worktrees = [] }) {
  const charter = includeCharter ? `\n角色章程：\n${charterFor(agent, config)}\n` : ''
  const repoBlock = worktrees.length > 1 ? `${repoLines(worktrees).join('\n')}\n` : ''
  return `[Agent Squad · ${mode}] task=${taskId} phase=${phase} round=${round} role=${agent.role}
工作区：${workspace}
${repoBlock}共享记忆：${taskDir}
先读 BRIEF.md 与 TASK.md；设计轮读取 PLAN.md（存在时），实现、返工与验收读取 PLAN-APPROVED.md；按需读取 REVIEW.md / REPORT.md。
${charter}
- PLAN-APPROVED.md 是实现、返工与验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。
- 仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。
- AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/REVIEW.md 按批准方案逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。
本轮交办：
${message}

交付：把结果写入 ${agent.role === 'brain' ? 'PLAN.md（验收轮写 REVIEW.md）' : 'REPORT.md'}；只回复 ≤150 字摘要 + 文件路径，不要回贴全文。`
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
          const active = Object.entries(previous.children ?? {}).filter(([, child]) => {
            const live = ctx.agents.get(child.id)
            return live?.status === 'running' || live?.status === 'provisioning'
          })
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
        if (!participants.some((agent) => agent.role === 'brain')) {
          lines.push('警告：没有 brain 参与，任务豁免 PLAN 审批门禁，也无法获得最终的设计/验收评审。')
        }
        lines.push(
          `下一步：squad_dispatch({ agent: "<name>", phase: "design", message: "<派单内容>" })；Lead 审核 PLAN.md 后用 squad_approve_plan 批准，再进入 implement。`,
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
      if (!participants.some((agent) => agent.role === 'brain')) {
        lines.push('警告：没有 brain 参与，任务豁免 PLAN 审批门禁，也无法获得最终的设计/验收评审。')
      }
      lines.push(
        `下一步：squad_dispatch({ agent: "<name>", phase: "design", message: "<派单内容>" })；Lead 审核 PLAN.md 后用 squad_approve_plan 批准，再进入 implement。`,
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
          enum: ['design', 'implement', 'review', 'rework'],
          description: 'Pipeline phase. Use rework when sending review defects back to the worker.',
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
      const current = await readJson(join(directory, 'current.json'))
      const taskId = String(args.task_id ?? current?.taskId ?? '')
      if (!taskId) throw new Error('还没有小队任务。先调用 squad_start。')
      const taskDir = join(directory, taskId)
      const state = await readJson(join(taskDir, 'STATE.json'))
      if (!state) throw new Error(`未知小队任务 "${taskId}"。先调用 squad_start。`)

      const phase = args.phase ?? 'design'
      const members = ctx.agentTeams.listMembers(lead)
      const existing = members.find((member) => member.name === target.name)
      const priorRework = Number(state.reworkRounds ?? 0)
      const budget = budgetOf(state)
      if (phase === 'rework' && priorRework >= budget.reworkLimit) {
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
      const slash = executor === 'local' ? target.model.indexOf('/') : -1
      const pinned =
        executor === 'local' && slash > 0
          ? { provider: target.model.slice(0, slash), model: target.model.slice(slash + 1) }
          : undefined
      const external = executor === 'external'

      // Unified activity guard (R07): refuse re-dispatch while the target's
      // current binding — local child or team member — is running/provisioning,
      // regardless of executor or model changes. Checked BEFORE any shared
      // file (BRIEF) or state mutation so a refusal leaves them untouched.
      const recordedChild = state.children?.[target.name]
      const childLive = recordedChild ? ctx.agents.get(recordedChild.id) : undefined
      const childBusy =
        recordedChild !== undefined &&
        (recordedChild.status === 'provisioning' ||
          childLive?.status === 'running' ||
          childLive?.status === 'provisioning')
      const memberBusy =
        existing !== undefined &&
        (existing.status === 'running' || existing.status === 'provisioning')
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
          const live = ctx.agents.get(otherChild.id)
          if (
            otherChild.status === 'provisioning' ||
            live?.status === 'running' ||
            live?.status === 'provisioning'
          ) {
            throw new Error(
              `目标 ${target.name} 在任务 ${name} 中仍有运行中的本地子代理（${otherChild.id}）。等它完成后再派单。`,
            )
          }
        }
      }
      // Plan gate, checked before any shared file (BRIEF) is written or an
      // executor is called, so a refusal leaves STATE/BRIEF/dispatch records
      // untouched. Design is refused once the PLAN is approved or the design
      // budget (initial + 3 rework rounds) is spent; implement/rework are
      // refused until the Lead approves PLAN.md. Tasks without a brain
      // participant are exempt (planRequired snapshot).
      const plan = planGateOf(state)
      if (phase === 'design') {
        if (plan.planApproved) {
          throw new Error(
            `任务 ${taskId} 的 PLAN 已批准（${plan.planApprovedAt ?? '?'}）：不能再派 design 返工，请进入 implement。`,
          )
        }
        if (plan.planRounds >= budget.designLimit) {
          throw new Error(
            `设计预算已用完：已到上限 ${budget.designLimit} 次 design 派单（已用 ${budget.designUsed}）。先向用户说明阻塞点与已完成部分并等待决策；用户同意后调用 squad_extend(kind="design", confirmed=true, reason="用户批准的追加理由") 追加轮次，再派 design；用户拒绝或未回复时保持暂停，不得自动续跑。`,
          )
        }
      }
      if ((phase === 'implement' || phase === 'rework') && plan.planRequired && !plan.planApproved) {
        throw new Error(
          `任务 ${taskId} 的 PLAN.md 尚未经 Lead 审核批准（planRounds=${plan.planRounds}/${budget.designLimit}）。先审核 PLAN.md 并调用 squad_approve_plan，再派 ${phase}。`,
        )
      }
      await writeBrief({ taskDir, state, agent: target, phase, round })

      let mode
      let sessionId
      let externalText = ''
      let tokens
      if (pinned) {
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
              label: `${taskId}/${phase}/${target.name}`,
              request: {
                prompt: [{ type: 'text', text: prompt }],
                parent: lead,
                agentOptions: { provider: pinned.provider, model: pinned.model },
                ...(hasWorkspace ? { cwd: workspace } : {}),
              },
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
          target.model === 'codex' ? await captureCodexTokens(startedAt - 600000) : undefined
        const activation = await subagents.startActivation({
          provider: target.model,
          label: `${taskId}/${phase}/${target.name}`,
          request: {
            prompt: [{ type: 'text', text: prompt }],
            parent: lead,
            ...(hasWorkspace ? { cwd: workspace } : {}),
          },
          signal: exec.signal,
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
        sessionId = activation.childId
        if (result.stopReason !== 'completed') {
          throw new Error(
            `外部 agent ${target.name} 异常结束（${result.stopReason}）${result.diagnostic ? `：${result.diagnostic}` : ''}`,
          )
        }
        externalText = result.output
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('')
        if (target.model === 'codex') {
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
      } else if (!existing) {
        const context = target.context === 'fork' ? 'fork' : 'fresh'
        const provider = context === 'fork' ? 'fork' : 'spawn'
        // Publish this round's snapshot before spawning so an agent/created
        // fired mid-spawn already installs the dispatched identity (R08).
        runtime.setPending(target.name, target)
        let spawned
        try {
          spawned = await ctx.agentTeams.spawnTeammate(lead, {
            name: target.name,
            description: target.description || `${target.role} teammate`,
            prompt: [{ type: 'text', text: message }],
            context,
            provider,
            signal: exec.signal,
          })
        } finally {
          runtime.clearPending(target.name)
        }
        mode = 'spawned'
        sessionId = spawned.member.id
        await moveTeammate(sessionId)
        // Team members carry the dispatch-time settings snapshot, exactly like
        // local children, so later edits cannot restyle their identity (R08).
        runtime.rebind(sessionId, target)
      } else if (existing.status === 'failed') {
        throw new Error(
          `队友 "${target.name}" 创建失败，该名字已被永久占用。换一个配置名，或开新会话。`,
        )
      } else if (existing.status === 'provisioning') {
        throw new Error(
          `队友 "${target.name}" 仍在创建中。先调用 squad_wait，再重试派单。`,
        )
      } else {
        await moveTeammate(existing.id)
        // Idle resume: refresh the binding and identity section to this
        // round's snapshot before the message is delivered (R08).
        runtime.rebind(existing.id, target)
        await ctx.agentTeams.sendMessage(lead, {
          target: existing.name,
          content: [{ type: 'text', text: message }],
          signal: exec.signal,
        })
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
      if (phase === 'rework') state.reworkRounds = priorRework + 1
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
        ...(external ? { provider: target.model } : {}),
        ...(tokens === undefined ? {} : { tokens }),
      })
      if (state.dispatches.length > 50) state.dispatches = state.dispatches.slice(-50)
      await writeJson(join(taskDir, 'STATE.json'), state)
      await appendFile(
        join(taskDir, 'JOURNAL.md'),
        `- ${new Date().toISOString()} lead → ${target.name} (${target.role}) phase=${phase} round=${round} mode=${mode}\n`,
        'utf8',
      ).catch(() => {})

      if (mode === 'local' || mode === 'local-resumed') {
        return [
          `${mode === 'local' ? '已创建' : '已续跑'}本地子代理 ${target.name} [${target.role}] model=${target.model} session=${sessionId}`,
          `task=${taskId} phase=${phase} round=${round} rework=${state.reworkRounds ?? 0}/${budget.reworkLimit}`,
          ...(phase === 'design' ? [`planRounds=${state.planRounds}/${budget.designLimit}（Lead 审核后用 squad_approve_plan 批准）`] : []),
          `workspace=${workspace}`,
          '它完成后会以完成通知唤醒你；返工用同一 child id 续跑。',
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
          ...(phase === 'design' ? [`planRounds=${state.planRounds}/${budget.designLimit}（已归档 PLAN-R${state.planRounds}.md；Lead 审核后用 squad_approve_plan 批准）`] : []),
          `workspace=${workspace}`,
          '输出：',
          clipped || '（无文本输出）',
        ].join('\n')
      }
      return [
        `${mode === 'spawned' ? '已创建' : '已续跑'} ${target.name} [${target.role}] session=${sessionId}`,
        `task=${taskId} phase=${phase} round=${round} rework=${state.reworkRounds ?? 0}/${budget.reworkLimit}`,
        ...(phase === 'design' ? [`planRounds=${state.planRounds}/${budget.designLimit}（Lead 审核后用 squad_approve_plan 批准）`] : []),
        `workspace=${workspace}`,
        '队友完成后会调用 squad_report。结束本回合等报告；需要查看时用 squad_status。',
      ].join('\n')
    },
  })

  // R07: process-local dispatch lock keyed by Lead + fixed agent id. It closes
  // the window between the STATE read and the provisional provisioning record,
  // which a persisted record alone cannot cover. Held only for this call.
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
      const extensions = Array.isArray(state.extensions) ? state.extensions : []
      const members = ctx.agentTeams.listMembers(lead)
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
        `${PLUGIN_MARKER}  task=${taskId}  phase=${state.phase ?? 'unknown'}  round=${state.round ?? '?'}  rework=${state.reworkRounds ?? 0}/${budget.reworkLimit}  created=${state.createdAt ?? '?'}`,
        `PLAN：planRequired=${plan.planRequired}  planRounds=${plan.planRounds}/${budget.designLimit}  planApproved=${plan.planApproved}${
          plan.planApproved
            ? `  planApprovedAt=${plan.planApprovedAt ?? '?'}（已归档 PLAN-APPROVED.md）`
            : plan.planRequired
              ? '（未批准：implement/rework 会被拒绝，先 squad_approve_plan）'
              : ''
        }`,
        `预算：design 上限=${budget.designLimit} 已用=${budget.designUsed} 剩余=${Math.max(0, budget.designLimit - budget.designUsed)}；implement 上限=${budget.reworkLimit} 已用=${budget.implementUsed} 剩余=${Math.max(0, budget.reworkLimit - budget.implementUsed)}`,
        ...(extensions.length === 0
          ? ['最近扩展：无']
          : [
              '最近扩展（最多 6 条）：',
              ...extensions.slice(-6).map(
                (item) => `- ${item.at} kind=${item.kind} rounds=${item.rounds} reason=${item.reason}`,
              ),
            ]),
        `当前目录：${sessionDirectory(ctx, lead)}`,
        ...workspaceBlock,
        `共享记忆：${taskDir}`,
        '成员：',
        formatMembers(members),
        '本地子代理：',
        state.children
          ? Object.entries(state.children)
              .map(([name, child]) => {
                const live = ctx.agents.get(child.id)
                const status =
                  live === undefined ? 'cold' : live.status === 'running' ? 'running' : 'inactive'
                return `- ${name} → ${child.id} (${child.model}) ${status}`
              })
              .join('\n')
          : '- （无）',
        `文件：${await fileSummary(taskDir)}`,
        `累计 tokens（Codex session 统计）：${state.tokens ?? 0}`,
        `最后验收结论：${state.lastVerdict ?? '—'}`,
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
      const before = ctx.agentTeams.listMembers(lead)
      const active = before.some(
        (member) =>
          member.id !== lead.id && (member.status === 'running' || member.status === 'provisioning'),
      )
      if (!active) {
        return `没有队友在运行或创建中，等待不会产生进展。用 squad_status 复查，然后派下一个任务。\n${formatMembers(before)}`
      }
      const result = await ctx.agentTeams.waitForChange(lead, timeout, exec.signal)
      const after = ctx.agentTeams.listMembers(lead)
      return [`等待${result.timedOut ? '超时' : '观察到变化'}。`, formatMembers(after)].join('\n')
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
      const membership = ctx.agentTeams.tryMembership(me)
      if (!membership) {
        throw new Error('squad_report 只能在 Agent Squad 队友会话里使用')
      }
      if (membership.role === 'lead') {
        throw new Error('squad_report 是队友工具；Lead 用 squad_status 查看状态')
      }
      const directory = await memoryDirectory(ctx, me, config)
      const current = await readJson(join(directory, 'current.json'))
      const taskId = current?.taskId ? String(current.taskId) : 'unknown'
      // Dispatch-time snapshot first; fall back to the current settings roster
      // for agents bound before snapshots existed (R08).
      const configured =
        runtime.bindingOf(me.id) ??
        settingsRoster(await store.read(), config).find((agent) => agent.name === membership.name)
      const role = configured?.role ?? 'worker'
      if (current?.taskId) {
        const journal = join(directory, String(current.taskId), 'JOURNAL.md')
        await appendFile(
          journal,
          `- ${new Date().toISOString()} ${membership.name} (${role}) report=${args.status} — ${firstLine(args.summary)}\n`,
          'utf8',
        ).catch(() => {})
      }
      const files = Array.isArray(args.files) && args.files.length > 0 ? args.files.join(', ') : '—'
      const text = `[squad-report] task=${taskId} agent=${membership.name} role=${role} status=${args.status}
总结：
${String(args.summary).trim()}
文件：${files}
下一步：${String(args.next ?? '—').trim()}`
      await ctx.agentTeams.sendMessage(me, {
        target: 'lead',
        content: [{ type: 'text', text }],
        signal: exec.signal,
      })
      return `已把报告发给 lead（task=${taskId} status=${args.status}）。`
    },
  })

  const finish = defineTool({
    name: 'squad_finish',
    description:
      '收尾任务：确认没有队友在运行且 brain 已 approved，提交 worktree 改动（可配置），把会话切回源目录，写出 FINAL.md 并给出分支/合并命令。',
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

      const members = ctx.agentTeams.listMembers(lead)
      const active = members.filter(
        (member) =>
          member.id !== lead.id &&
          (member.status === 'running' || member.status === 'provisioning'),
      )
      if (active.length > 0) {
        throw new Error(
          `仍有队友在运行：${active.map((member) => member.name).join(', ')}。等报告后再收尾。`,
        )
      }
      const runningChildren = Object.entries(state.children ?? {}).filter(([, child]) => {
        const live = ctx.agents.get(child.id)
        return child.status === 'provisioning' || live?.status === 'running'
      })
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
        '下一步：squad_dispatch({ agent: "<worker>", phase: "implement" })；实现后仍需 brain 验收（REVIEW.md VERDICT: APPROVED）才能收尾。',
      ].join('\n')
    },
  })

  const extend = defineTool({
    name: 'squad_extend',
    description:
      '仅允许 Lead 在对应预算（design/implement）已耗尽且用户明确同意后调用：为当前任务追加轮次，提高该类预算上限并记录扩展历史。每次调用都必须先向用户说明阻塞点并取得本次同意，再传 confirmed=true；可重复扩展，但不得预先充值，也不会自动续跑派单。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['design', 'implement'] },
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
      let membership
      try {
        membership = ctx.agentTeams.tryMembership(lead)
      } catch {
        membership = undefined
      }
      if (membership?.role !== 'lead') {
        throw new Error('squad_extend 仅允许 Lead 调用。')
      }
      const kind = args.kind
      if (kind !== 'design' && kind !== 'implement') {
        throw new Error('kind 必须是 design 或 implement。')
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
      const used = kind === 'design' ? budget.designUsed : budget.implementUsed
      const limit = kind === 'design' ? budget.designLimit : budget.reworkLimit
      if (used < limit) {
        throw new Error(
          `任务 ${taskId} 的 ${kind} 预算尚未到上限（已用 ${used}/${limit}），不能追加轮次。`,
        )
      }
      if (!Number.isSafeInteger(limit + rounds)) {
        throw new Error('追加后的预算上限超出安全整数范围。')
      }
      // All checks passed: write back both effective limits, raising only the
      // selected budget, and append one history record. Nothing else changes.
      const extensions = Array.isArray(state.extensions) ? state.extensions : []
      state.designLimit = budget.designLimit
      state.reworkLimit = budget.reworkLimit
      if (kind === 'design') state.designLimit = limit + rounds
      else state.reworkLimit = limit + rounds
      state.extensions = [
        ...extensions,
        { kind, rounds, reason, at: new Date().toISOString() },
      ]
      await writeJson(join(taskDir, 'STATE.json'), state)
      return `任务 ${taskId} 的 ${kind} 预算已扩展：上限 ${limit} → ${limit + rounds}，已用 ${used}，剩余 ${Math.max(0, limit + rounds - used)}（追加 ${rounds} 轮）。\n原因：${reason}`
    },
  })

  return { start, dispatch, status, wait, report, finish, approvePlan, extend }
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
  const store = createSettingsStore({
    seed: seedFromBundle(config.agents, config.worktreeDir),
    logger: { warn: (text) => ctx.logger?.('agent-squad')?.warn?.(text) },
  })
  // Settings page routes: registered only while a host web server is mounted.
  const disposeRoutes = registerRoutes({
    ctx,
    store,
    models: { llm: ctx.get('llm'), subagents: ctx.get('subagents') },
  })
  if (disposeRoutes) ctx.effect(() => disposeRoutes, 'agent-squad: settings routes')
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

  const membershipOf = (agent) => {
    try {
      return ctx.agentTeams.tryMembership(agent)
    } catch {
      return undefined
    }
  }

  const installSection = (agent) => {
    if (installed.has(agent.id)) return
    const resolved = membershipOf(agent) ?? agent.__membership
    const binding =
      agentBindings.get(agent.id) ??
      (resolved?.name ? pendingByName.get(resolved.name) : undefined)
    const membership = binding ? { role: 'teammate', name: binding.name } : resolved
    if (!membership) return
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
  }, store)
  const isLead = (agent) => membershipOf(agent)?.role === 'lead'
  const isTeammate = (agent) => membershipOf(agent)?.role === 'teammate'

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
  ctx.on('agent/disposed', ({ agent }) => uninstallSection(agent))
}
