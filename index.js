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
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { createSettingsStore, seedFromBundle } from './settings.js'
import { registerRoutes } from './http.js'
import { createSquadWorktree } from './worktree.js'

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
const PLUGIN_MARKER = 'agent-squad/zh-v5'

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

const BRAIN_CHARTER = `你是小队里的思考者，负责方案与验收标准。

- 把目标拆成可执行的方案：实现路径、文件级改动、接口、测试策略与风险。
- 把方案和编号化验收标准写进 PLAN.md。每条标准都必须能用命令或检查某个具名文件来判定。
- 被要求验收时，对照 PLAN.md 逐条比对实现。亲自运行或检查测试，不接受没有证据的声明。
- 只有每条标准都有证据通过时才报 "approved"；否则报 "changes_requested"，给出编号缺陷清单和每项的最小修复方案。
- REVIEW.md 的最后一行必须是机器可读的「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」（Lead 的收尾门禁只认这一行）。
- 不写生产代码；一次性探针脚本可以放在 /tmp。
- 方案要克制：计划正文默认不超过约 80 行；测试数量不超过 max(6, 验收条数×2)，除非任务确实更复杂，并在 PLAN.md 里说明理由。
- 不扩大范围，取满足目标的最小方案。`

const WORKER_CHARTER = `你是小队里的执行者，严格按已批准的方案实现。

- 动手前先读 TASK.md 与 PLAN.md，遵循其中的接口与验收标准。
- 只做最小正确改动；不重新设计、不改名、不扩范围。
- 方案含糊或明显错误时停下，报 "blocked" 并给出具体问题，不要猜。
- 按方案写或更新测试，并亲自运行验收命令。
- 在 REPORT.md 记录证据：运行的命令、退出码、关键输出。
- 返工派单仍是在同一段对话里：逐条修复验收提出的编号缺陷，重跑完整相关测试，再次报告。`

const LEAD_POLICY = `Agent Squad 已启用：你是 Lead，小队里有按角色分工的队友。

非平凡任务按以下流程（先审方案再实现）：
1. 调用 squad_start 一次，写入目标与验收标准（验收标准确实含糊时先问用户）。
2. 派 brain 队友，phase="design"。读共享目录里的 PLAN.md。
3. Lead 亲自审核 PLAN.md：发现问题时把编号缺陷派回 brain（phase="design"）返工迭代，最多 ${MAX_DESIGN_REWORK_ROUNDS} 轮设计返工（初始设计 + 返工合计 ${MAX_PLAN_ROUNDS} 次 design 派单，第 ${MAX_PLAN_ROUNDS + 1} 次会被拒绝）；方案合格后调用 squad_approve_plan 批准（归档 PLAN-APPROVED.md）。有 brain 参与的任务，PLAN 未批准前 implement/rework 派单会被拒绝；没有 brain 参与的任务豁免此门禁。
4. 批准后派一个 worker，phase="implement"，给出明确的文件范围。
5. 派 brain，phase="review"，附上实际 diff 与测试证据。
6. 若验收返回 changes_requested，把同样的缺陷派回同一个 worker，phase="rework"。进程内队友会续跑同一会话；外部 provider（codex 等）是一次性调用，返工必须重发 BRIEF 与编号缺陷。
7. 只有 brain 的 "approved" 才能收尾；随后向用户汇总交付结果。

规则：
- 你是组织者，不写业务代码；自己的改动只限协调文件与最终整合。
- 两种批准相互独立：Lead 用 squad_approve_plan 批准的是「方案」，brain 在 REVIEW.md 给出的 VERDICT: APPROVED 批准的是「实现」；前者不能替代后者，收尾仍然只认 brain 验收。设计预算（初始 + ${MAX_DESIGN_REWORK_ROUNDS} 轮返工）与实现返工预算（${MAX_REWORK_ROUNDS} 轮）也相互独立、分别计数。
- 一个角色一个 agent。按能力选 worker：zcode 负责实现，qoder 负责并行或前端偏重的改动。
- 每次派单后结束当前回合，等队友的 squad_report 唤醒你；查看状态用 squad_status，只有必须在本回合阻塞时才用 squad_wait。
- 队友在跑时不得声称完成；没有 brain 验收不得接受结果。
- 同一个任务的实现返工最多 ${MAX_REWORK_ROUNDS} 轮；设计返工最多 ${MAX_DESIGN_REWORK_ROUNDS} 轮。任一超限就停下，向用户报告阻塞点与已完成部分。
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
 * the session moves into a worktree: the worktree keeps a pointer back to the
 * source checkout's memory directory.
 */
async function memoryDirectory(ctx, agent, config) {
  const base = config.memoryDir || DEFAULT_MEMORY_DIR
  const cwd = sessionDirectory(ctx, agent)
  const pointer = await readJson(join(cwd, base, 'current.json'))
  if (pointer?.memoryRoot) return pointer.memoryRoot
  return resolve(cwd, base)
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

汇报：任务完成、受阻或验收结束时，调用一次 squad_report，带上 status、简短总结和改动文件。Lead 会被这条报告唤醒。不要创建队友或重新分配工作。`
}

function renderTask({ taskId, goal, acceptance, constraints, participants, taskDir, worktree }) {
  const members = participants
    .map((agent) => `| ${agent.displayName} (${agent.name}) | ${agent.role} | ${agent.executor}${agent.model ? ` · ${agent.model}` : ''} | ${clip(agent.description, 80) || '—'} |`)
    .join('\n')
  return `# 小队任务 \`${taskId}\`

## 目标

${goal}

## 验收标准

${acceptance}

## 约束

${constraints || '—'}

## 工作区

${
  worktree
    ? `- worktree：\`${worktree.path}\`
- 分支：\`${worktree.branch}\`
- 源仓库：\`${worktree.repositoryRoot}\`
- 基线提交：\`${worktree.baseCommit}\`
- 源 checkout 的未提交改动不会复制到 worktree；所有改动只写在这个 worktree 里。`
    : '- 原地开发（未创建 worktree）。'
}

## 共享记忆协议

- 任何派单动手前先读本文件。
- Lead 先审方案再实现：\`brain\` 写 \`PLAN.md\` 后由 Lead 审核并用 \`squad_approve_plan\` 批准（Lead 只批准**方案**，归档 \`PLAN-APPROVED.md\`）；设计问题须带编号缺陷再派 \`phase="design"\` 返工，初始设计 + 3 轮返工 = 4 次 design 派单，第 5 次被拒绝；未批准前不派 implement/rework（无 brain 任务豁免）。
- \`brain\` 写 \`PLAN.md\`（方案 + 编号验收标准）与 \`REVIEW.md\`（逐条结论与证据）。
- \`worker\` 写 \`REPORT.md\`（改动、执行的命令、测试证据）。
- 每个成员在调用 \`squad_report\` 前，向 \`JOURNAL.md\` 追加一条简短记录。
- 实现验收只有 \`brain\` 能批准（\`REVIEW.md\` 以 \`VERDICT: APPROVED\` 结束），与 Lead 的方案批准相互独立；实现返工独立计数，最多 3 轮、第 4 次被拒绝；Lead 在 brain 批准后收尾。
- 记忆目录：\`${taskDir}\`

## 成员

| 名称 | 角色 | 上下文 | 职责 |
| --- | --- | --- | --- |
${members}
`
}

function renderDispatch({ taskId, taskDir, phase, round, agent, message, includeCharter, config, workspace }) {
  const deliverable =
    agent.role === 'brain'
      ? '写或更新 PLAN.md 的编号验收标准；验收派单时写 REVIEW.md，每条标准一行结论并附确切证据。'
      : '写或更新 REPORT.md，记录改动、执行的命令与测试证据。'
  const charter = includeCharter ? `\n角色章程：\n${charterFor(agent, config)}\n` : ''
  return `[Agent Squad] task=${taskId} phase=${phase} round=${round} role=${agent.role}
${charter}
共享记忆：${taskDir}
工作区：${workspace}
（只在工作区内改动；动手前先确认 pwd 与它一致，不要写回源 checkout。）
先读 TASK.md；存在时再读 PLAN.md 与 JOURNAL.md 最后约 80 行。

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
  const lines = [
    `# BRIEF · ${state.taskId}`,
    '',
    `phase=${phase} round=${round} rework=${state.reworkRounds ?? 0}/${MAX_REWORK_ROUNDS}`,
    `agent=${agent.name} role=${agent.role}`,
    '',
    '## 目标 / 验收 / 约束',
    '见同目录 TASK.md（先读，本文件不复述）。',
    '',
    '## 必读',
    '- TASK.md',
    '- PLAN.md（存在时）',
    '- REVIEW.md（存在时：上一轮验收结论）',
    '- REPORT.md（存在时：实现证据）',
    '- JOURNAL.md 最后 40 行',
    '',
    '## 交付',
    agent.role === 'brain'
      ? '- 设计轮写 PLAN.md；验收轮写 REVIEW.md（逐条 AC + 证据）'
      : '- 写 REPORT.md（改动、命令、测试证据）',
    '- 只回复 ≤150 字摘要 + 文件路径，不回贴正文',
  ]
  await writeFile(join(taskDir, 'BRIEF.md'), `${lines.join('\n')}\n`, 'utf8')
}

/** Prompt for an external one-shot or a local pinned-model child. */
function dispatchPrompt({ mode, taskId, taskDir, phase, round, agent, message, workspace, config, includeCharter = true }) {
  const charter = includeCharter ? `\n角色章程：\n${charterFor(agent, config)}\n` : ''
  return `[Agent Squad · ${mode}] task=${taskId} phase=${phase} round=${round} role=${agent.role}
工作区：${workspace}
共享记忆：${taskDir}
先读 BRIEF.md；按需读 TASK.md / PLAN.md / REVIEW.md / REPORT.md。
${charter}
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
        dispatches: [],
        worktree: worktree ?? null,
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
      if (phase === 'rework' && priorRework >= MAX_REWORK_ROUNDS) {
        throw new Error(
          `返工已达上限 ${MAX_REWORK_ROUNDS} 轮。停止返工，向用户报告阻塞点与已完成部分。`,
        )
      }
      const round = phase === 'rework' ? Number(state.round ?? 1) + 1 : Number(state.round ?? 1)
      const worktreePath = state.worktree?.path
      const workspace = worktreePath ?? sessionDirectory(ctx, lead)

      const moveTeammate = async (sessionId) => {
        if (!worktreePath) return
        const service = ctx.get('workingDirectory')
        const memberAgent = service ? ctx.agents.get(sessionId) : undefined
        if (!service || !memberAgent) return
        try {
          await service.set(memberAgent, worktreePath, exec.signal)
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
        if (plan.planRounds >= MAX_PLAN_ROUNDS) {
          throw new Error(
            `设计预算已用完：初始设计 + ${MAX_DESIGN_REWORK_ROUNDS} 轮返工 = ${MAX_PLAN_ROUNDS} 次 design 派单（当前 planRounds=${plan.planRounds}），第 ${MAX_PLAN_ROUNDS + 1} 次被拒绝。停下，向用户报告阻塞点与已完成部分。`,
          )
        }
      }
      if ((phase === 'implement' || phase === 'rework') && plan.planRequired && !plan.planApproved) {
        throw new Error(
          `任务 ${taskId} 的 PLAN.md 尚未经 Lead 审核批准（planRounds=${plan.planRounds}/${MAX_PLAN_ROUNDS}）。先审核 PLAN.md 并调用 squad_approve_plan，再派 ${phase}。`,
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
                ...(worktreePath ? { cwd: worktreePath } : {}),
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
            ...(worktreePath ? { cwd: worktreePath } : {}),
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
          `task=${taskId} phase=${phase} round=${round} rework=${state.reworkRounds ?? 0}/${MAX_REWORK_ROUNDS}`,
          ...(phase === 'design' ? [`planRounds=${state.planRounds}/${MAX_PLAN_ROUNDS}（Lead 审核后用 squad_approve_plan 批准）`] : []),
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
          ...(phase === 'design' ? [`planRounds=${state.planRounds}/${MAX_PLAN_ROUNDS}（已归档 PLAN-R${state.planRounds}.md；Lead 审核后用 squad_approve_plan 批准）`] : []),
          `workspace=${workspace}`,
          '输出：',
          clipped || '（无文本输出）',
        ].join('\n')
      }
      return [
        `${mode === 'spawned' ? '已创建' : '已续跑'} ${target.name} [${target.role}] session=${sessionId}`,
        `task=${taskId} phase=${phase} round=${round} rework=${state.reworkRounds ?? 0}/${MAX_REWORK_ROUNDS}`,
        ...(phase === 'design' ? [`planRounds=${state.planRounds}/${MAX_PLAN_ROUNDS}（Lead 审核后用 squad_approve_plan 批准）`] : []),
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
      const members = ctx.agentTeams.listMembers(lead)
      const lines = [
        `${PLUGIN_MARKER}  task=${taskId}  phase=${state.phase ?? 'unknown'}  round=${state.round ?? '?'}  rework=${state.reworkRounds ?? 0}/${MAX_REWORK_ROUNDS}  created=${state.createdAt ?? '?'}`,
        `PLAN：planRequired=${plan.planRequired}  planRounds=${plan.planRounds}/${MAX_PLAN_ROUNDS}  planApproved=${plan.planApproved}${
          plan.planApproved
            ? `  planApprovedAt=${plan.planApprovedAt ?? '?'}（已归档 PLAN-APPROVED.md）`
            : plan.planRequired
              ? '（未批准：implement/rework 会被拒绝，先 squad_approve_plan）'
              : ''
        }`,
        `当前目录：${sessionDirectory(ctx, lead)}`,
        state.worktree
          ? `工作区：worktree ${state.worktree.branch} @ ${state.worktree.path}（源仓库 ${state.worktree.repositoryRoot}）`
          : '工作区：原地开发',
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
        `- ${approvedAt} lead: 审核 PLAN 通过（设计轮次 ${plan.planRounds}/${MAX_PLAN_ROUNDS}），归档 PLAN-APPROVED.md\n`,
        'utf8',
      ).catch(() => {})
      return [
        `任务 ${taskId} 的 PLAN 已批准（第 ${plan.planRounds}/${MAX_PLAN_ROUNDS} 次设计）。`,
        `批准时间：${approvedAt}`,
        `归档：${archived.map((name) => join(taskDir, name)).join('、')}`,
        '下一步：squad_dispatch({ agent: "<worker>", phase: "implement" })；实现后仍需 brain 验收（REVIEW.md VERDICT: APPROVED）才能收尾。',
      ].join('\n')
    },
  })

  return { start, dispatch, status, wait, report, finish, approvePlan }
}

/** Host plugin entry. */
export function apply(ctx, input) {
  const config = resolveSettings(input)
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
