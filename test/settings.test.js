/**
 * Settings-page test suite — exactly ten top-level tests (T01–T10).
 * Run: node --test dsh-agent-squad/test/settings.test.js
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const BUNDLE_AGENTS = [
  { name: 'codex', role: 'brain', provider: 'mock-ext', context: 'fresh', description: 'brain' },
  { name: 'gpt', role: 'architect', provider: '', model: '', context: 'fresh', description: 'architect' },
  { name: 'zcode', role: 'worker', provider: '', model: 'zai-coding-cn/glm-5.3', context: 'fresh', description: 'worker' },
  { name: 'qoder', role: 'worker', provider: '', model: 'zai-coding-cn/glm-5.3', context: 'fresh', description: 'worker2' },
]

/** Shared S/E/M contract lines and charter items, asserted verbatim (PLAN §2/§3). */
const S_TEXT = 'PLAN-APPROVED.md 是业务方案与业务验收的唯一权威规格；SPEC.md 是技术实现、返工与技术验收的唯一权威规格；PLAN.md 只用于设计，不能覆盖批准归档。'
const E_TEXT = '仅任务快照豁免方案门禁且无批准归档时，按 TASK.md 与 Lead 本轮派单执行；仍须逐条 AC 留证。'
const M_TEXT =
  'AC 映射：沿用 TASK.md 的 AC 编号；未编号时按条目顺序从 AC1 开始编号。PLAN.md/SPEC.md 为每条 AC 指定改动文件、测试名、验证命令与期望值；REPORT.md/TECH-REVIEW.md/REVIEW.md 按对应规格逐条记录 AC 编号、文件路径、测试名、命令、退出码、关键输出与结论。'
const BRAIN_ITEMS = [
  '把业务目标写成可执行业务方案，存入 PLAN.md：对外行为、用户可见结果、边界场景与编号验收标准（AC）。',
  '涉及对外接口时逐项写明接口契约与错误行为；没有接口变更时明确写“无接口变更”，并列出须保留的对外行为。',
  '列出边界输入与精确期望值；每条 AC 必须给出可直接执行的验收命令、执行目录、退出码与通过条件。',
  '在“假设与待确认”中显式列出假设及影响；未确定且影响交付的事项标为待确认，不能让架构师或 worker 猜测。禁止使用“适当”“合理”“类似”“等等”“参考现有实现”替代具体规格。',
  '你可以澄清方案；但要改变原有业务功能、对外结果或验收标准，必须先请用户决策，不得擅自变更。',
  '写完后自检“一个没有上下文的架构师能否只靠 PLAN 拍板技术设计”，把结论写入 PLAN.md；不能时补全方案，或列入“假设与待确认”并标明阻塞项，不得宣称方案可执行。',
  '业务验收轮以 PLAN-APPROVED.md 为唯一权威业务规格，逐条核对 AC 并在 REVIEW.md 写明 AC 编号、验证命令、退出码、关键输出与结论；亲自运行或检查，不接受没有证据的声明。技术结论对照 SPEC.md 与 TECH-REVIEW.md，不替技术验收背书。',
  '当架构师接手实现时，由你对照 SPEC.md 亲自运行验证测试并代签技术验收：在 TECH-REVIEW.md 记录命令、退出码、关键输出与编号缺陷，最后一行同样是「VERDICT: APPROVED」或「VERDICT: CHANGES_REQUESTED」；之后再按业务方案单独签署业务验收，两份验收独立记录。',
]
const ARCHITECT_ITEMS = [
  '设计轮（spec）读取已批准的业务方案 PLAN-APPROVED.md；对缺失的技术设计拍板，对已有设计审核、补充。',
  '把技术规格写入 SPEC.md，至少覆盖适用的：代码结构、文件与模块职责、数据库表与迁移、领域模型及其依赖、对外接口与错误行为、各模块实现、可执行验证用例；对不适用的部分逐项明确说明“不适用”。',
  '技术实现可以调整，但不能擅改业务行为；若必须改业务预期，暂停受影响工作并在报告中交 Lead 转用户决策。',
  '规格有问题时按 worker 的上报修订并发布新版本（更新 SPEC.md，版本号以派单为准）；单纯澄清规格不扣返工额度，也不重置已用额度。',
  '技术验收轮（tech-review）以当前 SPEC.md 为唯一权威技术规格：做代码审查、亲自运行验证测试，在 TECH-REVIEW.md 逐条记录需求/AC 编号、命令、退出码、关键输出与可执行的编号缺陷清单。',
  '接手实现时按 worker 章程执行并自测，但你不能签署自己改动的技术验收：插件会拒绝对你派 tech-review；交由 brain（codex）对照 SPEC.md 独立代签技术验收。',
]
const WORKER_ITEMS = [
  `动手前先读 TASK.md、PLAN-APPROVED.md（业务方案）与 SPEC.md（技术规格）。${S_TEXT}${E_TEXT}`,
  '只做规格定义的最小改动；不得引入规格未定义的接口、文件或依赖，不重新设计、不改名、不扩大范围。',
  '规格缺失、矛盾或明显错误时立即停止实现，报 "blocked"，引用 PLAN-APPROVED.md/SPEC.md 的具体章节与编号，并列出缺失项或冲突原文；需要归档而文件缺失时明确引用文件名；豁免任务引用 TASK.md 章节或 Lead 派单条目。规格有问题上报 Lead 转 gpt 修订发布，不自行偏离或改用 PLAN.md。',
  '按 SPEC.md 指定的测试名、输入与期望输出写或更新测试，并亲自运行每条 AC 的验收命令；豁免任务按 TASK.md 与 Lead 本轮派单执行。',
  '在 REPORT.md 逐条 AC 给证据：AC 编号、改动文件路径、测试名、实际命令、退出码、关键输出与结论；失败或未执行必须如实标注，不得只写“测试通过”。',
]
const assertSEM = (text) => {
  for (const literal of [S_TEXT, E_TEXT, M_TEXT]) {
    assert.ok(text.includes(literal), `missing S/E/M literal: ${literal}`)
  }
}
const assertBrief = async (dir) => {
  const brief = await readFile(join(dir, 'BRIEF.md'), 'utf8')
  assertSEM(brief)
  assert.ok(brief.includes('PLAN-APPROVED.md（业务方案；实现、返工与验收；豁免且无归档时按 TASK.md 与本轮派单）'))
  assert.ok(brief.trimEnd().split('\n').length <= 30, 'BRIEF exceeds 30 lines')
}

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'asq-test-'))
}

/** T01 — store lifecycle: seed, persistence, revision, corrupt recovery, atomic-write failure. */
test('T01 settings store seeds, persists, recovers corruption, keeps old file on write failure', async () => {
  const { createSettingsStore, seedFromBundle } = await import('../settings.js')
  const root = await tempRoot()
  const filePath = join(root, 'agent-squad', 'settings.json')
  const store = createSettingsStore({ filePath, seed: seedFromBundle(BUNDLE_AGENTS, '.agents/worktrees') })

  const first = await store.read()
  assert.equal(first.version, 2)
  assert.equal(first.revision, 1)
  assert.equal(first.agents.length, 4)
  assert.deepEqual(
    first.agents.map((agent) => [agent.id, agent.role, agent.executor, agent.model]),
    [
      ['codex', 'brain', 'external', 'mock-ext'],
      ['gpt', 'architect', 'team', ''],
      ['zcode', 'worker', 'local', 'zai-coding-cn/glm-5.3'],
      ['qoder', 'worker', 'local', 'zai-coding-cn/glm-5.3'],
    ],
  )
  assert.equal(first.worktree.directory, '.agents/worktrees')

  const saved = await store.save({
    expectedRevision: 1,
    agents: first.agents.map((agent) =>
      agent.id === 'zcode' ? { ...agent, displayName: '实现者' } : agent,
    ),
    worktree: first.worktree,
  })
  assert.equal(saved.revision, 2)
  const persisted = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal(persisted.revision, 2)
  assert.equal(persisted.agents.find((agent) => agent.id === 'zcode').displayName, '实现者')
  const reread = await store.read()
  assert.equal(reread.revision, 2)

  // v1 → v2 migration: a three-agent file gains the gpt architect row while
  // every user edit and the revision survive; the file converges to v2.
  {
    const v1Path = join(root, 'v1', 'settings.json')
    await mkdir(join(root, 'v1'), { recursive: true })
    await writeFile(
      v1Path,
      JSON.stringify({
        version: 1,
        revision: 7,
        agents: [
          { id: 'codex', displayName: '老codex', role: 'brain', executor: 'external', model: 'mock-ext', description: 'kept' },
          { id: 'zcode', displayName: '实现者', role: 'worker', executor: 'local', model: 'p/m1', description: 'w' },
          { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'team', model: '', description: 'w2' },
        ],
        worktree: { directory: 'kept-worktrees' },
      }),
      'utf8',
    )
    const migratedStore = createSettingsStore({ filePath: v1Path })
    const migrated = await migratedStore.read()
    assert.equal(migrated.version, 2)
    assert.equal(migrated.revision, 7)
    assert.deepEqual(
      migrated.agents.map((agent) => agent.id),
      ['codex', 'gpt', 'zcode', 'qoder'],
    )
    assert.equal(migrated.agents[0].displayName, '老codex')
    assert.equal(migrated.agents[1].role, 'architect')
    assert.equal(migrated.agents[2].displayName, '实现者')
    assert.equal(migrated.worktree.directory, 'kept-worktrees')
    const onDisk = JSON.parse(await readFile(v1Path, 'utf8'))
    assert.equal(onDisk.version, 2)
    assert.equal(onDisk.agents.length, 4)
  }

  // Corrupt file → backed up, effective seed (not static defaults) restored (R05).
  await writeFile(filePath, '{ this is not json', 'utf8')
  const recovered = await store.read()
  assert.equal(recovered.revision, 1)
  assert.equal(recovered.agents[0].executor, 'external')
  assert.equal(recovered.agents[1].executor, 'team')
  assert.equal(recovered.agents[2].executor, 'local')
  assert.equal(recovered.worktree.directory, '.agents/worktrees')
  const backups = (await readdir(join(root, 'agent-squad'))).filter((name) =>
    name.startsWith('settings.json.corrupt-'),
  )
  assert.equal(backups.length, 1)
  assert.match(await readFile(join(root, 'agent-squad', backups[0]), 'utf8'), /not json/)

  // Backup failure → IO_ERROR, original corrupt file preserved (R04): a
  // read-only directory makes the backup copy fail before any restore write.
  await writeFile(filePath, '{ still not json', 'utf8')
  await chmod(join(root, 'agent-squad'), 0o500)
  try {
    await assert.rejects(store.read(), (error) => error.code === 'IO_ERROR')
  } finally {
    await chmod(join(root, 'agent-squad'), 0o700)
  }
  assert.equal(await readFile(filePath, 'utf8'), '{ still not json')

  // Rename (write) failure keeps the last good file.
  const good = await store.read()
  await chmod(join(root, 'agent-squad'), 0o500)
  try {
    await store.save({
      expectedRevision: good.revision,
      agents: good.agents,
      worktree: good.worktree,
    })
    assert.fail('save should have failed')
  } catch (error) {
    assert.equal(error.code, 'IO_ERROR')
  } finally {
    await chmod(join(root, 'agent-squad'), 0o700)
  }
  const after = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal(after.revision, good.revision)
  const leftovers = (await readdir(join(root, 'agent-squad'))).filter((name) =>
    name.includes('.tmp-'),
  )
  assert.deepEqual(leftovers, [])
  await rm(root, { recursive: true, force: true })
})

/** T02 — model aggregation: two groups, single failure keeps the rest. */
test('T02 collectModels groups providers and survives single-provider failure', async () => {
  const { collectModels } = await import('../http.js')
  const result = await collectModels({
    llm: {
      listProviders: () => [
        { id: 'deepseek-account', name: 'DeepSeek Account' },
        { id: 'zai-coding-cn', name: 'ZAI Coding' },
      ],
      listModels: async (provider) => {
        if (provider === 'zai-coding-cn') throw new Error('provider down')
        return [
          { provider, id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { provider, id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ]
      },
    },
    subagents: { list: () => ['spawn', 'codex', 'zcode-cli', 'qoder-cli', 'fork'] },
  })
  assert.deepEqual(
    result.groups.map((group) => group.provider),
    ['deepseek-account', 'zai-coding-cn'],
  )
  const okGroup = result.groups[0]
  assert.deepEqual(
    okGroup.models.map((model) => model.value),
    ['deepseek-account/deepseek-chat', 'deepseek-account/deepseek-reasoner'],
  )
  assert.equal(okGroup.models[0].label, 'DeepSeek Chat')
  assert.equal(result.groups[1].error, 'provider down')
  assert.deepEqual(result.groups[1].models, [])
  assert.deepEqual(
    result.externalProviders.map((entry) => entry.id),
    ['codex', 'zcode-cli', 'qoder-cli'],
  )
})

/** Mock host for T03/T07/T08 wiring: minimal surface the plugin's apply() touches. */
function mockHost(workspace, dshHome, hooks = {}, options = {}) {
  // Tool registrations keep their `when` visibility condition so tests can
  // assert Lead-only registration (squad_approve_plan).
  const registered = []
  const activations = []
  const sent = []
  const spawned = []
  const sections = []
  const members = []
  const createdHandlers = []
  const disposers = []
  /** name → provider, maintained by registerProvider/unregister. */
  const providers = new Map()
  /** run.id of every provider start that went through startActivation. */
  const runIds = []
  /** Every workingDirectory get/set call, in order (T09). */
  const cwdCalls = []
  const baseWorkingDirectory =
    options.workingDirectory ?? { get: () => workspace, set: async () => {} }
  let childSeq = 0
  const agentsById = new Map()
  const makeAgent = (id, membership) => {
    const agent = {
      id,
      status: 'inactive',
      session: { id: 'session-1' },
      __membership: membership,
      ctx: {
        systemPrompt: {
          section: (definition) => {
            sections.push(definition.text)
            return () => {}
          },
        },
      },
    }
    agentsById.set(id, agent)
    return agent
  }
  const subagents = {
    registerProvider: (provider) => {
      if (providers.has(provider.name)) {
        const error = new Error(
          `a subagent provider named "${provider.name}" is already registered`,
        )
        error.code = 'DUPLICATE_PROVIDER'
        throw error
      }
      providers.set(provider.name, provider)
      return () => {
        if (providers.get(provider.name) === provider) providers.delete(provider.name)
      }
    },
    list: () => ['spawn', 'fork', 'mock-ext', ...providers.keys()],
    // 0.2.x flat SubagentActivationSpec (no nested request object).
    startActivation: async ({ provider, childId, name, prompt, parent, agentOptions, cwd, signal, label, delivery }) => {
      childSeq += 1
      const id = childId ?? `child-${childSeq}`
      activations.push({ provider, childId: id, name, prompt, agentOptions, cwd, label, delivery })
      const isTeamSpawn = (provider === 'spawn' || provider === 'fork') && agentOptions === undefined
      if (isTeamSpawn && name) {
        spawned.push({ name, prompt, description: label })
        // Named continuable teammate (the spawnTeammate replacement):
        // agent/created fires before the activation resolves (R08), and the
        // member becomes visible in listDescendants.
        const member = makeAgent(id, { role: 'teammate', name })
        member.__root = parent
        member.__name = name
        members.push({ id, name, status: 'inactive' })
        for (const handler of createdHandlers) handler({ agent: member })
        return {
          childId: id,
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }),
          dispose: async () => {},
        }
      }
      // Test hook: external activations run before the (already
      // resolved) result is awaited, so the mock "agent" can produce
      // PLAN.md synchronously — exactly what an external brain does.
      if (provider !== 'spawn' && provider !== 'fork' && hooks.onExternal) {
        await hooks.onExternal(provider, { prompt, cwd, signal, label })
      }
      // Providers registered through registerProvider run for real
      // (e.g. the built-in qoder-cli adapter around a stub CLI).
      const registeredProvider = providers.get(provider)
      if (registeredProvider) {
        const run = await registeredProvider.start({
          prompt,
          parent,
          cwd: cwd ?? workspace,
          signal,
          label,
        })
        runIds.push(run.id)
        return { childId: id, result: run.result, dispose: run.dispose }
      }
      return {
        childId: id,
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: 'done' }],
        }),
        dispose: async () => {},
      }
    },
    sendMessage: async (_from, targetId, content) => {
      sent.push({ targetId, content })
    },
    rootOf: (agent) => agent?.__root ?? (agent?.__membership?.role === 'lead' ? agent : undefined),
    namesOf: (agent) => ({ self: agent?.__name ?? agent?.__membership?.name ?? String(agent?.id) }),
    listDescendants: async () =>
      members.map((member) => ({
        id: member.id,
        kind: 'child',
        mode: 'continuable',
        name: member.name,
        label: member.name,
        activity: member.status === 'running' ? 'running' : 'inactive',
        hasChildren: false,
      })),
    getProvider: (id) => providers.get(id),
  }
  const ctx = {
    agents: {
      list: () => [...agentsById.values()],
      get: (id) => agentsById.get(id),
    },
    tools: { register: (definition, options) => registered.push({ definition, when: options?.when }) },
    get: (name) => {
      if (name === 'workingDirectory') {
        return {
          get: (session) => {
            cwdCalls.push({ op: 'get', session })
            return baseWorkingDirectory.get(session)
          },
          set: async (agent, directory, signal) => {
            cwdCalls.push({ op: 'set', directory })
            return baseWorkingDirectory.set(agent, directory, signal)
          },
        }
      }
      if (name === 'subagents') {
        return options.noSubagents ? undefined : subagents
      }
      return undefined
    },
    on: (event, handler) => {
      if (event === 'agent/created') createdHandlers.push(handler)
    },
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    inject: (_deps, callback) => callback(ctx),
  }
  // A running row WITHOUT a name: local children appear in listDescendants
  // but must not match the team-member name lookup.
  const markRunning = (id) => {
    if (!members.some((member) => member.id === id)) members.push({ id, status: 'running' })
  }
  const unmarkRunning = (id) => {
    const index = members.findIndex((member) => member.id === id)
    if (index >= 0) members.splice(index, 1)
  }
  return {
    ctx, registered, activations, sent, spawned, sections, members, agentsById, makeAgent,
    dshHome, subagents, providers, runIds, disposers, cwdCalls, markRunning, unmarkRunning,
  }
}

/** T03 — start/dispatch re-read settings; three executors; live children keep their binding. */
test('T03 dispatch reads fresh settings and routes external/local/team executors', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  try {
    // Pre-write a legal settings file: codex→external(mock-ext), gpt→team(architect),
    // zcode→local(p/m), qoder→team.
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'external', model: 'mock-ext', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'local', model: 'p/m1', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'team', model: '', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )

    const { apply } = await import('../index.js')
    // Real qoder-stub CLI: writes the cwd marker file and prints its argv as
    // JSON, proving the plugin config reaches the provider's spawn.
    const stubPath = join(dshHome, 'qoder-stub.cjs')
    await writeFile(
      stubPath,
      '#!/usr/bin/env node\n' +
        "const { writeFileSync } = require('node:fs')\n" +
        "writeFileSync('qoder-test-output.txt', 'ok\\n')\n" +
        'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n',
      'utf8',
    )
    await chmod(stubPath, 0o755)
    // The mock external brain writes PLAN.md before its activation resolves.
    const host = mockHost(workspace, dshHome, {
      onExternal: async (_provider, request) => {
        const text = request.prompt.map((block) => block.text).join('')
        const dir = /共享记忆：(\S+)/.exec(text)?.[1]
        if (dir) await writeFile(join(dir, 'PLAN.md'), '# PLAN (mock)\n', 'utf8')
      },
    })
    apply(host.ctx, { workerProbe: false,
      agents: BUNDLE_AGENTS,
      qoderCommand: stubPath,
      qoderPermissionMode: 'custom',
      qoderModel: 'm1',
    })
    const tool = (name) =>
      host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' } }
    const exec = { agent: lead, signal: undefined }

    const startOutput = await tool('squad_start').execute(
      // No architect participant: the task downgrades to the legacy gates, so
      // T03 keeps exercising pure executor routing (spec/tech-review gates
      // belong to T11).
      { goal: 'g', acceptance: 'a', agents: ['codex', 'zcode', 'qoder'] },
      exec,
    )
    assert.match(startOutput, /任务 .+ 已创建/)
    assert.match(startOutput, /原地开发/)
    assert.match(startOutput, /没有 architect 参与/)
    assert.match(startOutput, /squad_approve_plan/)
    const firstTaskId = /任务 (t-\S+) 已创建/.exec(startOutput)[1]
    const firstDir = join(workspace, '.agent-squad', firstTaskId)

    // external: one-shot activation through the provider named by settings.model.
    const externalOutput = await tool('squad_dispatch').execute(
      { agent: 'codex', message: 'design', phase: 'design' },
      exec,
    )
    assert.match(externalOutput, /已外部派发 codex/)
    assert.match(externalOutput, /planRounds=1\/4/)
    assert.equal(host.activations.at(-1).provider, 'mock-ext')
    // S/E/M contract reaches the external activation prompt (charter included).
    assertSEM(host.activations.at(-1).prompt.map((block) => block.text).join(''))
    await assertBrief(firstDir)
    // The external design round is archived synchronously as PLAN-R1.md.
    assert.equal(await readFile(join(firstDir, 'PLAN-R1.md'), 'utf8'), '# PLAN (mock)\n')
    // Plan gate: implement is refused until the Lead approves the PLAN.
    await assert.rejects(
      tool('squad_dispatch').execute({ agent: 'zcode', message: 'early', phase: 'implement' }, exec),
      /squad_approve_plan/,
    )
    const approveFirst = await tool('squad_approve_plan').execute({ task_id: firstTaskId }, exec)
    assert.match(approveFirst, /已批准/)
    assert.equal(await readFile(join(firstDir, 'PLAN-APPROVED.md'), 'utf8'), '# PLAN (mock)\n')

    // local: pinned model p/m1, first dispatch creates a child.
    const local1 = await tool('squad_dispatch').execute(
      { agent: 'zcode', message: 'implement', phase: 'implement' },
      exec,
    )
    assert.match(local1, /已创建本地子代理 zcode/)
    const firstChild = host.activations.at(-1).childId
    assert.deepEqual(host.activations.at(-1).agentOptions, { provider: 'p', model: 'm1' })
    assertSEM(host.activations.at(-1).prompt.map((block) => block.text).join(''))
    await assertBrief(firstDir)

    // Same binding → resume the same child id.
    const local2 = await tool('squad_dispatch').execute(
      { agent: 'zcode', message: 'rework', phase: 'rework' },
      exec,
    )
    assert.match(local2, /已续跑本地子代理 zcode/)
    assert.equal(host.sent.at(-1).targetId, firstChild)
    {
      const resumeText = host.sent.at(-1).content.map((block) => block.text).join('')
      // includeCharter=false still outputs S/E/M, without the charter block.
      assertSEM(resumeText)
      assert.ok(!resumeText.includes('角色章程：'))
    }
    await assertBrief(firstDir)

    // team: spawnTeammate path, with qoder re-roled to brain first (R08).
    const { createSettingsStore } = await import('../settings.js')
    const settingsStore = createSettingsStore({ filePath: settingsPath })
    let snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) =>
        agent.id === 'qoder' ? { ...agent, role: 'brain' } : agent,
      ),
      worktree: snapshot.worktree,
    })
    const teamOutput = await tool('squad_dispatch').execute(
      { agent: 'qoder', message: 'parallel', phase: 'implement' },
      exec,
    )
    assert.match(teamOutput, /已创建 qoder \[brain\]/)
    assert.equal(host.spawned.at(-1).name, 'qoder')
    assertSEM(host.spawned.at(-1).prompt.map((block) => block.text).join(''))
    await assertBrief(firstDir)
    // The spawned member's identity section follows the dispatch snapshot
    // (R08), including the section installed by agent/created firing before
    // spawnTeammate resolved.
    assert.match(host.sections.at(-1), /qoder.*brain 角色/s)
    const qoderBrainSections = host.sections.filter((text) => text.includes('"qoder"'))
    assert.ok(qoderBrainSections.length >= 1)
    for (const text of qoderBrainSections) assert.match(text, /brain 角色/)
    // squad_report uses the same snapshot role, not the current roster (R08).
    const qoderAgent = [...host.agentsById.values()].find((agent) => agent.__membership?.name === 'qoder')
    const reportOutput = await tool('squad_report').execute(
      { status: 'done', summary: 'ok' },
      { agent: qoderAgent, signal: undefined },
    )
    assert.match(reportOutput, /status=done/)
    assert.match(
      host.sent.filter((item) => item.targetId === 'lead-1').at(-1).content[0].text,
      /role=brain/,
    )

    // Save a new model binding for zcode (child idle: agents.get → undefined).
    snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) =>
        agent.id === 'zcode' ? { ...agent, model: 'p/m2' } : agent,
      ),
      worktree: snapshot.worktree,
    })

    // R07: a running target is refused re-dispatch — same binding,
    // changed model, and executor switch all hit the unified guard — and the
    // refusal leaves BRIEF.md / STATE.json untouched.
    const firstTaskDir = join(workspace, '.agent-squad', firstTaskId)
    const briefPath = join(firstTaskDir, 'BRIEF.md')
    const statePath = join(firstTaskDir, 'STATE.json')
    const briefBefore = await readFile(briefPath, 'utf8')
    const stateBefore = await readFile(statePath, 'utf8')
    host.markRunning(firstChild)
    await assert.rejects(
      tool('squad_dispatch').execute(
        { agent: 'zcode', message: 'same binding', phase: 'implement' },
        exec,
      ),
      /仍在运行或创建中/,
    )
    await assert.rejects(
      tool('squad_dispatch').execute({ agent: 'zcode', message: 'new model', phase: 'implement' }, exec),
      /仍在运行或创建中/,
    )
    snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) =>
        agent.id === 'zcode' ? { ...agent, executor: 'external', model: 'mock-ext' } : agent,
      ),
      worktree: snapshot.worktree,
    })
    await assert.rejects(
      tool('squad_dispatch').execute({ agent: 'zcode', message: 'switch', phase: 'implement' }, exec),
      /仍在运行或创建中/,
    )
    assert.equal(await readFile(briefPath, 'utf8'), briefBefore)
    assert.equal(await readFile(statePath, 'utf8'), stateBefore)
    // R07: a new task cannot steal current.json while a child is still active.
    await assert.rejects(
      tool('squad_start').execute({ goal: 'g9', acceptance: 'a9' }, exec),
      /仍有运行中的本地子代理/,
    )
    host.unmarkRunning(firstChild)

    // R07 (cross-task): a child busy in ANOTHER task of the same memory root
    // blocks dispatch here too, whatever task_id is addressed.
    snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) =>
        agent.id === 'zcode' ? { ...agent, executor: 'local', model: 'p/m1' } : agent,
      ),
      worktree: snapshot.worktree,
    })
    const resumeTaskA = await tool('squad_dispatch').execute(
      { agent: 'zcode', message: 'back to local on A', phase: 'implement' },
      exec,
    )
    assert.match(resumeTaskA, /已续跑本地子代理 zcode/)
    const startB = await tool('squad_start').execute({ goal: 'gB', acceptance: 'aB', agents: ['codex'] }, exec)
    const taskB = /任务 (t-\S+) 已创建/.exec(startB)[1]
    // Task B has a brain participant: approve its PLAN before implementing.
    const taskBDir = join(workspace, '.agent-squad', taskB)
    await writeFile(join(taskBDir, 'PLAN.md'), '# PLAN B\n', 'utf8')
    await tool('squad_approve_plan').execute({ task_id: taskB }, exec)
    const resumeTaskAExplicit = await tool('squad_dispatch').execute(
      { agent: 'zcode', message: 'explicit A resume', phase: 'implement', task_id: firstTaskId },
      exec,
    )
    assert.match(resumeTaskAExplicit, /已续跑本地子代理 zcode/)
    host.markRunning(firstChild)
    const stateBPath = join(workspace, '.agent-squad', taskB, 'STATE.json')
    const stateBBefore = await readFile(stateBPath, 'utf8')
    const activationsBefore = host.activations.length
    await assert.rejects(
      tool('squad_dispatch').execute(
        { agent: 'zcode', message: 'dispatch on B', phase: 'implement' },
        exec,
      ),
      /在任务 .+ 中仍有运行中的本地子代理/,
    )
    assert.equal(await readFile(stateBPath, 'utf8'), stateBBefore)
    assert.equal(host.activations.length, activationsBefore)
    host.unmarkRunning(firstChild)
    // Restore the external binding for the assertions below.
    snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) =>
        agent.id === 'zcode' ? { ...agent, executor: 'external', model: 'mock-ext' } : agent,
      ),
      worktree: snapshot.worktree,
    })

    // R08: idle team resume re-binds the snapshot before the message goes out.
    snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) =>
        agent.id === 'qoder' ? { ...agent, role: 'worker' } : agent,
      ),
      worktree: snapshot.worktree,
    })
    const resumeOutput = await tool('squad_dispatch').execute(
      { agent: 'qoder', message: 'resume as worker', phase: 'implement' },
      exec,
    )
    assert.match(resumeOutput, /已续跑 qoder \[worker\]/)
    assert.match(host.sections.at(-1), /qoder.*worker 角色/s)
    {
      const resumeText = host.sent.at(-1).content.map((block) => block.text).join('')
      assertSEM(resumeText)
      assert.ok(!resumeText.includes('角色章程：'))
    }
    await assertBrief(firstDir)
    const reportAfterResume = await tool('squad_report').execute(
      { status: 'done', summary: 'ok2' },
      { agent: qoderAgent, signal: undefined },
    )
    assert.match(reportAfterResume, /status=done/)
    assert.match(
      host.sent.filter((item) => item.targetId === 'lead-1').at(-1).content[0].text,
      /role=worker/,
    )

    // Idle + changed binding → next dispatch uses the new binding (new child).
    snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) =>
        agent.id === 'zcode' ? { ...agent, executor: 'external', model: 'p2/m9' } : agent,
      ),
      worktree: snapshot.worktree,
    })
    const local3 = await tool('squad_dispatch').execute(
      { agent: 'zcode', message: 'next', phase: 'implement', background: false },
      exec,
    )
    assert.match(local3, /已外部派发/)

    // External `provider/model` form → ONE-SHOT pinned spawn: provider=spawn
    // with agentOptions, no name, no member created, no children entry.
    {
      const before = host.members.length
      const out = await tool('squad_dispatch').execute(
        { agent: 'zcode', message: 'one-shot probe', phase: 'implement', background: false },
        exec,
      )
      assert.match(out, /已外部派发 zcode \(zcode\).*provider=p2\/m9（一次性，不续跑）/)
      const act = host.activations.at(-1)
      assert.equal(act.provider, 'spawn')
      assert.deepEqual(act.agentOptions, { provider: 'p2', model: 'm9' })
      assert.equal(act.name, undefined)
      assert.equal(host.members.length, before)
      const oneShotTask = /task=(t-\S+) /.exec(out)[1]
      const st = JSON.parse(
        await readFile(join(workspace, '.agent-squad', oneShotTask, 'STATE.json'), 'utf8'),
      )
      assert.equal(st.children?.zcode, undefined)
      // Second dispatch is a brand-new activation (fresh context).
      await tool('squad_dispatch').execute(
        { agent: 'zcode', message: 'one-shot again', phase: 'implement' },
        exec,
      )
      assert.notEqual(host.activations.at(-1).childId, act.childId)
    }

    // R09: roles edited after start cannot relax the acceptance gate snapshotted
    // at task creation. A second task runs with only codex (brain) as the
    // participant; afterwards codex becomes worker and qoder (not a
    // participant) becomes brain — the gate still demands an approved REVIEW.
    const secondStart = await tool('squad_start').execute(
      { goal: 'g2', acceptance: 'a2', agents: ['codex'] },
      exec,
    )
    const secondTaskId = /任务 (t-\S+) 已创建/.exec(secondStart)[1]
    snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) => {
        if (agent.id === 'codex') return { ...agent, role: 'worker' }
        if (agent.id === 'qoder') return { ...agent, role: 'brain' }
        return agent
      }),
      worktree: snapshot.worktree,
    })
    await assert.rejects(
      tool('squad_finish').execute({ summary: 'done?', task_id: secondTaskId }, exec),
      /REVIEW/,
    )
    // R09: a legacy STATE without a gate is treated conservatively — review is
    // still required.
    const secondStatePath = join(workspace, '.agent-squad', secondTaskId, 'STATE.json')
    const secondState = JSON.parse(await readFile(secondStatePath, 'utf8'))
    delete secondState.gate
    await writeFile(secondStatePath, JSON.stringify(secondState, null, 2), 'utf8')
    await assert.rejects(
      tool('squad_finish').execute({ summary: 'done?', task_id: secondTaskId }, exec),
      /REVIEW/,
    )

    // --- built-in qoder-cli provider: registration, catalog, dispatch -------
    assert.ok(host.providers.has('qoder-cli'), 'qoder-cli provider registered')
    assert.ok(host.providers.has('codex-cli'), 'codex-cli provider registered')
    assert.ok(host.subagents.list().includes('qoder-cli'))
    // Loopback GET /agent-squad/models surfaces the provider as external.
    {
      const { createRequestHandler } = await import('../http.js')
      const { createSettingsStore: mkStore } = await import('../settings.js')
      const handler = createRequestHandler({
        store: mkStore({ filePath: settingsPath }),
        models: { llm: { listProviders: () => [] }, subagents: host.subagents },
      })
      const res = {
        statusCode: 0,
        headers: null,
        body: '',
        writeHead(code, headers) {
          this.statusCode = code
          this.headers = headers
        },
        end(text) {
          this.body = String(text ?? '')
        },
      }
      await handler(
        {
          method: 'GET',
          url: '/agent-squad/models',
          headers: { host: 'localhost:57954' },
          socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
        },
        res,
      )
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.ok(
        body.externalProviders.some(
          (entry) => entry.id === 'qoder-cli' && entry.label === 'qoder-cli',
        ),
      )
    }

    // External dispatch through the real stub CLI: settings say qoder runs on
    // the built-in provider with the custom command/mode/model.
    snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) => {
        if (agent.id === 'qoder') {
          return { ...agent, role: 'worker', executor: 'external', model: 'qoder-cli' }
        }
        if (agent.id === 'codex') return { ...agent, role: 'brain' }
        return agent
      }),
      worktree: snapshot.worktree,
    })
    const qoderStart = await tool('squad_start').execute(
      { goal: 'qoder test', acceptance: 'ok', agents: ['qoder'] },
      exec,
    )
    assert.match(qoderStart, /已创建/)
    const sentBeforeQoder = host.sent.length
    const spawnedBeforeQoder = host.spawned.length
    const runsBefore = host.runIds.length
    const qoderOut = await tool('squad_dispatch').execute(
      { agent: 'qoder', message: 'qoder test', phase: 'implement', background: false },
      exec,
    )
    assert.match(qoderOut, /已外部派发 qoder/)
    assert.match(qoderOut, /provider=qoder-cli/)
    assert.equal(host.activations.at(-1).provider, 'qoder-cli')
    const qoderPrompt = host.activations
      .at(-1)
      .prompt.map((block) => block.text)
      .join('')
    const stubArgs = JSON.parse(qoderOut.split('输出：\n')[1])
    assert.deepEqual(stubArgs, [
      '-p', qoderPrompt,
      '-w', workspace,
      '--permission-mode', 'custom',
      '-m', 'm1',
    ])
    assert.equal(await readFile(join(workspace, 'qoder-test-output.txt'), 'utf8'), 'ok\n')
    // Second one-shot dispatch: fresh run id, still no sendMessage/spawnTeammate.
    await tool('squad_dispatch').execute(
      { agent: 'qoder', message: 'qoder test again', phase: 'implement' },
      exec,
    )
    assert.equal(host.activations.at(-1).provider, 'qoder-cli')
    assert.equal(host.runIds.length, runsBefore + 2)
    assert.notEqual(host.runIds.at(-1), host.runIds.at(-2))
    assert.equal(host.sent.length, sentBeforeQoder)
    assert.equal(host.spawned.length, spawnedBeforeQoder)
    // The effect's disposer unregisters the provider exactly once.
    const qoderDispose = host.disposers[0]
    assert.equal(typeof qoderDispose, 'function')
    qoderDispose()
    assert.ok(!host.providers.has('qoder-cli'))
    assert.ok(!host.subagents.list().includes('qoder-cli'))
    qoderDispose() // idempotent no-op

    // Independent hosts: no subagents service is skipped; missing/blank/
    // non-string qoder config falls back to the defaults AND the defaults
    // actually reach the spawned command line. An isolated PATH stub named
    // `qoderclicn` captures the resolved script and argv — never a vendor CLI.
    {
      const bareRoot = await tempRoot()
      const bare = mockHost(bareRoot, dshHome, {}, { noSubagents: true })
      apply(bare.ctx, { workerProbe: false,}) // must not throw
      assert.equal(bare.providers.size, 0)
      await rm(bareRoot, { recursive: true, force: true })

      const stubDir = await mkdtemp(join(tmpdir(), 'asq-qoder-bin-'))
      const stubPath = join(stubDir, 'qoderclicn')
      await writeFile(
        stubPath,
        '#!/usr/bin/env node\n' +
          "const { writeFileSync } = require('node:fs')\n" +
          "writeFileSync('qoder-default-output.txt', JSON.stringify({ script: process.argv[1], argv: process.argv.slice(2) }) + '\\n')\n",
        'utf8',
      )
      await chmod(stubPath, 0o755)
      const pathBefore = process.env.PATH
      process.env.PATH = `${stubDir}${pathBefore ? `:${pathBefore}` : ''}`
      const casesRoot = await tempRoot()
      try {
        const cases = [
          ['omitted', undefined],
          ['blank-command', { qoderCommand: '   ' }],
          ['blank-permission', { qoderPermissionMode: '' }],
          ['blank-model', { qoderModel: '' }],
          ['nonstring-command', { qoderCommand: 42 }],
          ['nonstring-permission', { qoderPermissionMode: {} }],
          ['nonstring-model', { qoderModel: 9 }],
        ]
        for (const [label, config] of cases) {
          const root = await mkdtemp(join(casesRoot, `${label}-`))
          const host = mockHost(root, dshHome)
          apply(host.ctx, config)
          const provider = host.providers.get('qoder-cli')
          assert.ok(provider, label)
          const run = await provider.start({
            prompt: [{ type: 'text', text: 'defaults probe' }],
            parent: { id: 'lead-1' },
            cwd: root,
          })
          const result = await run.result
          assert.equal(result.stopReason, 'completed', label)
          const captured = JSON.parse(await readFile(join(root, 'qoder-default-output.txt'), 'utf8'))
          // The provider spawned the DEFAULT command, resolved to the PATH stub.
          assert.ok(captured.script.endsWith('/qoderclicn'), label)
          // Default permission mode, and no -m flag for the empty default model.
          assert.deepEqual(
            captured.argv,
            ['-p', 'defaults probe', '-w', root, '--permission-mode', 'accept_edits'],
            label,
          )
          assert.equal(await run.dispose(), undefined, label)
          if (label === 'omitted') {
            const dispose = host.disposers[0]
            dispose()
            assert.ok(!host.providers.has('qoder-cli'))
            dispose() // unregister once is enough; repeat is a no-op
          }
        }
      } finally {
        process.env.PATH = pathBefore
        await rm(stubDir, { recursive: true, force: true })
        await rm(casesRoot, { recursive: true, force: true })
      }
    }
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T04 — table-driven validation with field paths; non-loopback HTTP gets 403 without touching the store. */
test('T04 validation rejects invalid rosters with field paths and HTTP refuses non-loopback requests', async () => {
  const { validateAgentsAndWorktree, createSettingsStore, seedFromBundle } = await import('../settings.js')
  const { createRequestHandler } = await import('../http.js')

  const validAgent = (id, patch = {}) => ({
    id,
    displayName: id,
    role: 'worker',
    executor: 'team',
    model: '',
    description: '',
    ...patch,
  })
  const architect = validAgent('gpt', { role: 'architect' })
  const four = (codex, zcode, qoder) => [codex, architect, zcode, qoder]
  const valid = (agents, worktree = { directory: '.agents/worktrees' }) =>
    validateAgentsAndWorktree(agents, worktree)

  assert.equal(valid(four(validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder'))).ok, true)
  assert.equal(valid(four(validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder'))).ok, true)
  assert.equal(valid([validAgent('codex', { role: 'brain' }), validAgent('gpt', { role: 'architect', executor: 'local', model: 'openai/gpt-6.2-sol', reasoning: 'xhigh' }), validAgent('zcode'), validAgent('qoder')]).ok, true)
  assert.equal(valid(four(validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder', { role: 'architect' }))).ok, true)

  const cases = [
    {
      name: 'wrong count',
      agents: [validAgent('codex', { role: 'brain' }), validAgent('zcode')],
      field: 'agents',
      code: 'AGENT_COUNT',
    },
    {
      name: 'v1 three-agent roster is no longer a valid v2 shape',
      agents: [validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder')],
      field: 'agents',
      code: 'AGENT_COUNT',
    },
    {
      name: 'duplicate names',
      agents: four(
        validAgent('codex', { role: 'brain', displayName: 'Same' }),
        validAgent('zcode', { displayName: 'same' }),
        validAgent('qoder'),
      ),
      field: 'agents.zcode.displayName',
      code: 'NAME_DUPLICATE',
    },
    {
      name: 'no brain',
      agents: four(validAgent('codex'), validAgent('zcode'), validAgent('qoder')),
      field: 'agents',
      code: 'BRAIN_REQUIRED',
    },
    {
      name: 'bad executor',
      agents: four(validAgent('codex', { role: 'brain', executor: 'magic' }), validAgent('zcode'), validAgent('qoder')),
      field: 'agents.codex.executor',
      code: 'EXECUTOR_INVALID',
    },
    {
      name: 'bad role on the architect slot',
      agents: four(validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder')).map((agent) =>
        agent.id === 'gpt' ? { ...agent, role: 'wizard' } : agent,
      ),
      field: 'agents.gpt.role',
      code: 'ROLE_INVALID',
    },
    {
      name: 'unknown reasoning effort',
      agents: four(validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder')).map((agent) =>
        agent.id === 'gpt' ? { ...agent, reasoning: 'extreme' } : agent,
      ),
      field: 'agents.gpt.reasoning',
      code: 'REASONING_INVALID',
    },
    {
      name: 'local model without provider',
      agents: four(validAgent('codex', { role: 'brain' }), validAgent('zcode', { executor: 'local', model: 'nomodel' }), validAgent('qoder')),
      field: 'agents.zcode.model',
      code: 'MODEL_INVALID',
    },
    {
      name: 'changed id',
      agents: four(validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('other')),
      field: 'agents.qoder.id',
      code: 'ID_READONLY',
    },
    {
      name: 'absolute directory',
      agents: four(validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder')),
      worktree: { directory: '/abs' },
      field: 'worktree.directory',
      code: 'DIRECTORY_ABSOLUTE',
    },
    {
      name: 'traversal directory',
      agents: four(validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder')),
      worktree: { directory: 'a/../..' },
      field: 'worktree.directory',
      code: 'DIRECTORY_TRAVERSAL',
    },
  ]
  for (const item of cases) {
    const result = valid(item.agents, item.worktree)
    assert.equal(result.ok, false, item.name)
    assert.equal(result.fields[item.field], item.code, `${item.name}: ${item.field}`)
  }

  // Invalid save does not write to disk.
  const root = await tempRoot()
  const filePath = join(root, 'agent-squad', 'settings.json')
  const store = createSettingsStore({ filePath })
  const current = await store.read()
  await assert.rejects(
    store.save({
      expectedRevision: current.revision,
      agents: four(validAgent('codex', { role: 'brain', displayName: 'x' }), validAgent('zcode', { displayName: 'x' }), validAgent('qoder')),
      worktree: current.worktree,
    }),
    (error) => error.fields['agents.zcode.displayName'] === 'NAME_DUPLICATE',
  )
  assert.equal((await store.read()).revision, current.revision)

  // HTTP: non-loopback socket → 403, store file untouched (still unseeded path).
  const freshPath = join(root, 'other', 'settings.json')
  const handler = createRequestHandler({
    store: createSettingsStore({ filePath: freshPath }),
    models: {},
  })
  const responses = []
  const makeRes = () => ({
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(text) {
      this.body = String(text ?? '')
    },
  })
  const remoteReq = {
    method: 'GET',
    url: '/agent-squad/settings',
    headers: { host: '127.0.0.1:57954' },
    socket: { remoteAddress: '192.168.1.23', localPort: 57954 },
  }
  let res = makeRes()
  responses.push(res)
  await handler(remoteReq, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.match(res.body, /FORBIDDEN/)
  await assert.rejects(stat(freshPath))
  // And a cross-origin loopback request is refused too.
  res = makeRes()
  responses.push(res)
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: '127.0.0.1:57954', origin: 'http://evil.example' },
      socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  await assert.rejects(stat(freshPath))

  // R01: local-looking attacker hostnames and scheme-mismatched origins fail.
  res = makeRes()
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: '127.attacker.example:57954' },
      socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  res = makeRes()
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: '127.0.0.1:57954', origin: 'https://127.0.0.1:57954' },
      socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  await assert.rejects(stat(freshPath))

  // R01: malformed ports, wrong listening ports and fake-loopback IPv6 fail.
  res = makeRes()
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: 'localhost:bad' },
      socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  res = makeRes()
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: '127.0.0.1:12345', origin: 'http://127.0.0.1:12345' },
      socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  res = makeRes()
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: '127.0.0.1:57954' },
      socket: { remoteAddress: '2001:db8::127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  await assert.rejects(stat(freshPath))

  // R01: different hostnames are different origins, even with equal ports.
  res = makeRes()
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: 'localhost:57954', origin: 'http://127.0.0.1:57954' },
      socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  // R01: Origin must be a pure origin — no path, no userinfo.
  res = makeRes()
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: '127.0.0.1:57954', origin: 'http://127.0.0.1:57954/evil' },
      socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  res = makeRes()
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: '127.0.0.1:57954', origin: 'http://user@127.0.0.1:57954' },
      socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)
  // R01: an omitted Host port resolves to the scheme default (80) and must
  // still match the actual listening port — 57954 here, so it is refused.
  res = makeRes()
  await handler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 403)

  // R01 + R05: a proper mapped-IPv6 loopback request with a matching Origin
  // passes the guard; GET returns defaults from the store's effective seed.
  const seededPath = join(root, 'seeded', 'settings.json')
  const seeded = createSettingsStore({
    filePath: seededPath,
    seed: seedFromBundle(BUNDLE_AGENTS, 'custom-worktrees'),
  })
  const seededHandler = createRequestHandler({ store: seeded, models: {} })
  res = makeRes()
  await seededHandler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: '[::1]:57954', origin: 'http://[::1]:57954' },
      socket: { remoteAddress: '::ffff:127.0.0.1', localPort: 57954 },
    },
    res,
  )
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.defaults.worktree.directory, 'custom-worktrees')
  assert.equal(body.defaults.agents[0].executor, 'external')

  // PUT validation: an external executor may carry a pinned `provider/model`
  // value (one-shot spawn path) — it must check the LLM catalog like the local
  // executor instead of demanding a registered subagent provider.
  {
    const putPath = join(root, 'put', 'settings.json')
    const putStore = createSettingsStore({ filePath: putPath })
    const current = await putStore.read()
    const models = {
      llm: {
        listProviders: () => [{ id: 'zai-coding-cn', name: 'ZAI' }],
        listModels: async () => [{ id: 'glm-5.3', name: 'GLM' }],
      },
      subagents: { getProvider: (id) => (id === 'mock-ext' ? {} : undefined) },
    }
    const putHandler = createRequestHandler({ store: putStore, models })
    const roster = (zcodeModel) =>
      four(
        validAgent('codex', { role: 'brain', executor: 'external', model: 'mock-ext' }),
        validAgent('zcode', { executor: 'external', model: zcodeModel }),
        validAgent('qoder'),
      )
    const sendPut = async (agents, expectedRevision = 1) => {
      const payload = JSON.stringify({ expectedRevision, agents, worktree: current.worktree })
      const r = makeRes()
      await putHandler(
        {
          method: 'PUT',
          url: '/agent-squad/settings',
          headers: { host: '127.0.0.1:57954' },
          socket: { remoteAddress: '127.0.0.1', localPort: 57954 },
          on(event, listener) {
            if (event === 'data') setImmediate(() => listener(Buffer.from(payload)))
            if (event === 'end') setImmediate(() => listener())
            return this
          },
          destroy() {},
        },
        r,
      )
      return r
    }
    // Pinned external form validates against the catalog and saves.
    res = await sendPut(roster('zai-coding-cn/glm-5.3'))
    assert.equal(res.statusCode, 200, `pinned external model must save: ${res.body}`)
    assert.equal(JSON.parse(res.body).settings.revision, 2)
    // A pinned external model missing from the catalog is a field error.
    res = await sendPut(roster('zai-coding-cn/nope-9.9'), 2)
    assert.equal(res.statusCode, 400)
    assert.equal(JSON.parse(res.body).error.fields['agents.zcode.model'], 'MODEL_NOT_FOUND')
    // A bare external provider still requires registration.
    res = await sendPut(roster('not-registered'), 2)
    assert.equal(res.statusCode, 400)
    assert.equal(JSON.parse(res.body).error.fields['agents.zcode.model'], 'PROVIDER_NOT_REGISTERED')
  }
  // R01: full-form mapped loopback and ::1 spellings pass the guard.
  for (const remoteAddress of ['0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:0:0:0001']) {
    res = makeRes()
    await seededHandler(
      {
        method: 'GET',
        url: '/agent-squad/settings',
        headers: { host: '[::1]:57954', origin: 'http://[::1]:57954' },
        socket: { remoteAddress, localPort: 57954 },
      },
      res,
    )
    assert.equal(res.statusCode, 200)
  }
  // R01: Host without a port is legal when the listener really is on 80.
  res = makeRes()
  await seededHandler(
    {
      method: 'GET',
      url: '/agent-squad/settings',
      headers: { host: 'localhost' },
      socket: { remoteAddress: '127.0.0.1', localPort: 80 },
    },
    res,
  )
  assert.equal(res.statusCode, 200)
  await rm(root, { recursive: true, force: true })
})

/** T05 — concurrent saves on one revision: exactly one winner, one 409 (also across two store instances). */
test('T05 concurrent saves on one revision yield a single winner and one 409', async () => {
  const { createSettingsStore } = await import('../settings.js')
  const root = await tempRoot()
  const filePath = join(root, 'agent-squad', 'settings.json')
  const storeA = createSettingsStore({ filePath })
  const storeB = createSettingsStore({ filePath })
  const base = await storeA.read()
  const make = (name) => ({
    expectedRevision: base.revision,
    agents: base.agents.map((agent) => (agent.id === 'zcode' ? { ...agent, displayName: name } : agent)),
    worktree: base.worktree,
  })
  // Two instances over the same file share the module-level queue (R03).
  const [a, b] = await Promise.allSettled([storeA.save(make('first')), storeB.save(make('second'))])
  const outcomes = [a, b].sort((left, right) => (left.status === 'fulfilled' ? -1 : 1))
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[1].status, 'rejected')
  const conflict = outcomes[1].reason
  assert.equal(conflict.code, 'REVISION_CONFLICT')
  assert.equal(conflict.status, 409)
  // R02: the 409 carries the current (winning) settings for the client.
  assert.equal(conflict.current.revision, base.revision + 1)
  assert.equal(
    conflict.current.agents.find((agent) => agent.id === 'zcode').displayName,
    outcomes[0].value.agents.find((agent) => agent.id === 'zcode').displayName,
  )
  const finalSettings = await storeB.read()
  assert.equal(finalSettings.revision, base.revision + 1)
  assert.equal(
    finalSettings.agents.find((agent) => agent.id === 'zcode').displayName,
    outcomes[0].value.agents.find((agent) => agent.id === 'zcode').displayName,
  )
  await rm(root, { recursive: true, force: true })
})

/** T06 — plugin worktree creation in a real temp Git repository. */
test('T06 createSquadWorktree creates the configured branch and rejects escapes and collisions', async () => {
  const { createSquadWorktree } = await import('../worktree.js')
  const repo = await mkdtemp(join(tmpdir(), 'asq-test-'))
  const realRepo = await realpath(repo)
  await run('git', ['-C', repo, 'init', '-q'])
  await run('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base'])
  const switched = []
  const ctx = {
    get: (name) =>
      name === 'workingDirectory'
        ? { set: async (_agent, directory) => switched.push(directory) }
        : undefined,
  }
  const created = await createSquadWorktree({
    ctx,
    lead: { id: 'lead' },
    sourceDirectory: repo,
    taskId: 't6a',
    directory: '.agents/worktrees',
  })
  assert.equal(created.reused, false)
  assert.equal(created.branch, 'squad-t6a')
  assert.equal(created.path, join(realRepo, '.agents', 'worktrees', 'squad-t6a'))
  assert.equal(created.repositoryRoot, realRepo)
  assert.match(created.baseCommit, /^[0-9a-f]{40}$/)
  assert.deepEqual(switched, [created.path])
  const info = (await run('git', ['-C', repo, 'worktree', 'list', '--porcelain'])).stdout
  assert.match(info, /squad-t6a/)
  const branch = (await run('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'squad-t6a'])).stdout
  assert.equal(branch.trim(), 'squad-t6a')

  // Reject traversal and absolute directories.
  await assert.rejects(
    createSquadWorktree({ ctx, lead: {}, sourceDirectory: repo, taskId: 't6b', directory: '../evil' }),
    /\.\./,
  )
  await assert.rejects(
    createSquadWorktree({ ctx, lead: {}, sourceDirectory: repo, taskId: 't6b', directory: '/abs' }),
    /must be relative/,
  )
  // Existing target directory is a collision.
  await mkdir(join(repo, '.agents', 'worktrees', 'squad-t6b'), { recursive: true })
  await assert.rejects(
    createSquadWorktree({ ctx, lead: {}, sourceDirectory: repo, taskId: 't6b', directory: '.agents/worktrees' }),
    /already exists/,
  )
  // .git is refused.
  await assert.rejects(
    createSquadWorktree({ ctx, lead: {}, sourceDirectory: repo, taskId: 't6c', directory: '.git' }),
    /\.git/,
  )
  // Reuse: dispatching from inside the linked worktree reuses it.
  const reused = await createSquadWorktree({
    ctx,
    lead: { id: 'lead' },
    sourceDirectory: created.path,
    taskId: 't6d',
    directory: '.agents/worktrees',
  })
  assert.equal(reused.reused, true)
  assert.equal(reused.path, created.path)

  // R10: a missing workingDirectory service refuses creation before any Git
  // artifacts appear (no false success, no leftover worktree/branch/path).
  await assert.rejects(
    createSquadWorktree({
      ctx: { get: () => undefined },
      lead: { id: 'lead' },
      sourceDirectory: repo,
      taskId: 't6e',
      directory: '.agents/worktrees',
    }),
    /workingDirectory service is unavailable/,
  )
  {
    const listing = (await run('git', ['-C', repo, 'worktree', 'list', '--porcelain'])).stdout
    assert.ok(!listing.includes('squad-t6e'))
    const branches = (await run('git', ['-C', repo, 'branch', '--list', 'squad-t6e'])).stdout.trim()
    assert.equal(branches, '')
    await assert.rejects(stat(join(realRepo, '.agents', 'worktrees', 'squad-t6e')))
  }
  // R10: a failed cwd switch restores the source directory.
  const flaky = []
  let flakyCalls = 0
  const flakyCtx = {
    get: () => ({
      set: async (_agent, directory) => {
        flakyCalls += 1
        flaky.push(directory)
        if (flakyCalls === 1) throw new Error('switch failed')
      },
    }),
  }
  await assert.rejects(
    createSquadWorktree({
      ctx: flakyCtx,
      lead: { id: 'lead' },
      sourceDirectory: repo,
      taskId: 't6f',
      directory: '.agents/worktrees',
    }),
    /could not move/,
  )
  assert.deepEqual(flaky.slice(-1), [repo])
  await run('git', ['-C', repo, 'worktree', 'remove', '--force', join(realRepo, '.agents', 'worktrees', 'squad-t6f')])
  await run('git', ['-C', repo, 'branch', '-D', 'squad-t6f'])
  // R10: when the restore also fails the error is fatal (start must stop).
  const brokenCtx = {
    get: () => ({
      set: async () => {
        throw new Error('unavailable')
      },
    }),
  }
  await assert.rejects(
    createSquadWorktree({
      ctx: brokenCtx,
      lead: { id: 'lead' },
      sourceDirectory: repo,
      taskId: 't6g',
      directory: '.agents/worktrees',
    }),
    (error) => error.fatal === true && /could not be restored/.test(error.message),
  )
  await run('git', ['-C', repo, 'worktree', 'remove', '--force', join(realRepo, '.agents', 'worktrees', 'squad-t6g')])
  await run('git', ['-C', repo, 'branch', '-D', 'squad-t6g'])

  // Cleanup only what this test created.
  await run('git', ['-C', repo, 'worktree', 'remove', '--force', created.path])
  await run('git', ['-C', repo, 'branch', '-D', 'squad-t6a'])
  await rm(repo, { recursive: true, force: true })
})

/** T07 — plan gate: Lead review before implement, design budget, approve tool, archive & status. */
test('T07 plan gate: lead review, design budget, squad_approve_plan, archives and status', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  try {
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'external', model: 'mock-ext', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'local', model: 'p/m1', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'team', model: '', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )

    const { apply } = await import('../index.js')
    // Mock external brain: writes PLAN.md (or simulates failures) before the
    // activation result resolves, so the dispatch-side archive sees it.
    let writes = 0
    let failNext = false
    let skipPlan = false
    const host = mockHost(workspace, dshHome, {
      onExternal: async () => {
        if (failNext) {
          failNext = false
          throw new Error('provider exploded')
        }
        if (skipPlan) return
        writes += 1
        const memory = join(workspace, '.agent-squad')
        const pointer = JSON.parse(await readFile(join(memory, 'current.json'), 'utf8'))
        await writeFile(join(pointer.memoryRoot ?? memory, pointer.taskId, 'PLAN.md'), `# PLAN W${writes}\n`, 'utf8')
      },
    })
    apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const teammate = { id: 'te-1', __membership: { role: 'teammate', name: 'zcode' } }
    const exec = { agent: lead, signal: undefined }

    // --- AC3: registration, opt-in gate and Lead-only visibility ------------
    const names = host.registered.map((entry) => entry.definition.name).sort()
    assert.deepEqual(names, [
      'squad_approve_plan', 'squad_deliver', 'squad_dispatch', 'squad_enable', 'squad_extend', 'squad_failover', 'squad_finish', 'squad_parallel_start', 'squad_report', 'squad_start', 'squad_status', 'squad_wait',
    ])
    // Before opting in, the root sees ONLY the enable gate; the squad tools
    // and the Lead persona stay hidden (opt-in contract).
    const enableEntry = host.registered.find((entry) => entry.definition.name === 'squad_enable')
    assert.equal(enableEntry.when({ agent: lead }), true)
    assert.equal(enableEntry.when({ agent: teammate }), false)
    const approveEntry = host.registered.find((entry) => entry.definition.name === 'squad_approve_plan')
    assert.equal(approveEntry.when({ agent: lead }), false)
    assert.equal(approveEntry.when({ agent: teammate }), false)
    const enableOutput = await tool('squad_enable').execute({}, exec)
    assert.match(enableOutput, /已为当前会话启用/)
    assert.equal(enableEntry.when({ agent: lead }), false)
    assert.equal(approveEntry.when({ agent: lead }), true)
    assert.equal(approveEntry.when({ agent: teammate }), false)
    const extendEntry = host.registered.find((entry) => entry.definition.name === 'squad_extend')
    assert.equal(extendEntry.when({ agent: lead }), true)
    assert.equal(extendEntry.when({ agent: teammate }), false)
    assert.equal(extendEntry.when({ agent: { id: 'anon' } }), false)
    // Idempotent: enabling twice keeps the Lead enabled.
    assert.match(await tool('squad_enable').execute({}, exec), /已启用/)

    // --- AC1: snapshot initialization (no architect → legacy gates) ---------
    const startA = await tool('squad_start').execute({ goal: 'g', acceptance: 'a', agents: ['codex', 'zcode', 'qoder'] }, exec)
    const taskA = /任务 (t-\S+) 已创建/.exec(startA)[1]
    const dirA = join(workspace, '.agent-squad', taskA)
    const readState = async (task) =>
      JSON.parse(await readFile(join(workspace, '.agent-squad', task, 'STATE.json'), 'utf8'))
    const stateA = await readState(taskA)
    assert.equal(stateA.planRequired, true)
    assert.equal(stateA.planRounds, 0)
    assert.equal(stateA.planApproved, false)
    assert.equal(stateA.planApprovedAt, null)
    assert.equal(stateA.flow, 'full')
    assert.equal(stateA.specRequired, false) // no architect → downgraded gates
    assert.equal(stateA.gate.reviewRequired, true) // gate untouched
    assert.deepEqual(stateA.gate.brainIds, ['codex'])

    // --- AC4: unapproved implement/rework are refused with no side effects --
    const dispatch = (args) => tool('squad_dispatch').execute(args, exec)
    const activationsBefore = host.activations.length
    await assert.rejects(dispatch({ agent: 'zcode', message: 'x', phase: 'implement' }), /squad_approve_plan/)
    await assert.rejects(dispatch({ agent: 'zcode', message: 'x', phase: 'rework' }), /squad_approve_plan/)
    await assert.rejects(stat(join(dirA, 'BRIEF.md')))
    assert.deepEqual(await readState(taskA), stateA)
    assert.equal(host.activations.length, activationsBefore)

    // --- AC2: design budget = initial + 3 rework rounds = 4 dispatches ------
    const design = (message) => dispatch({ agent: 'codex', message, phase: 'design' })
    const lastDispatch = async (task) => (await readState(task)).dispatches.at(-1)
    const assertRound = async (n) => {
      const state = await readState(taskA)
      assert.equal(state.planRounds, n)
      assert.equal(await readFile(join(dirA, `PLAN-R${n}.md`), 'utf8'), `# PLAN W${n}\n`)
      assert.equal((await lastDispatch(taskA)).planRound, n) // dispatch record carries the round
      assert.equal(state.round, 1) // design does not bump impl round
      assert.equal(state.reworkRounds, 0)
    }
    await design('r1')
    await assertRound(1)

    // Dispatch failure does not count.
    failNext = true
    await assert.rejects(design('boom'), /provider exploded/)
    assert.equal((await readState(taskA)).planRounds, 1)

    // Archive failure reports loudly, keeps planRounds, never re-dispatches.
    skipPlan = true
    await rm(join(dirA, 'PLAN.md'), { force: true }) // no fresh PLAN this round
    const activationsBeforeSkip = host.activations.length
    await assert.rejects(design('no plan'), /已派发成功，但归档 PLAN-R2/)
    assert.equal((await readState(taskA)).planRounds, 1)
    await assert.rejects(stat(join(dirA, 'PLAN-R2.md')))
    assert.equal(host.activations.length, activationsBeforeSkip + 1) // ran once, no auto retry
    skipPlan = false

    await design('r2')
    await assertRound(2)
    const statusMid = await tool('squad_status').execute({}, exec)
    assert.match(statusMid, /planRequired=true/)
    assert.match(statusMid, /planRounds=2\/4/)
    assert.match(statusMid, /planApproved=false/)
    await design('r3')
    await assertRound(3)
    await design('r4')
    await assertRound(4)
    // 5th refusal: STATE bytes and the existing BRIEF stay identical.
    const statePathA = join(dirA, 'STATE.json')
    const briefPathA = join(dirA, 'BRIEF.md')
    const stateBefore5th = await readFile(statePathA, 'utf8')
    const briefBefore5th = await readFile(briefPathA, 'utf8')
    const activationsBefore5th = host.activations.length
    await assert.rejects(design('r5'), /设计预算已用完/)
    assert.equal(host.activations.length, activationsBefore5th)
    assert.equal(await readFile(statePathA, 'utf8'), stateBefore5th)
    assert.equal(await readFile(briefPathA, 'utf8'), briefBefore5th)

    // --- AC3: approve success / repeat rejection -----------------------------
    // History is never rewritten: make the current PLAN differ from R4 first.
    await writeFile(join(dirA, 'PLAN.md'), '# PLAN FINAL\n', 'utf8')
    const approveA = await tool('squad_approve_plan').execute({ task_id: taskA }, exec)
    assert.match(approveA, /已批准（第 4\/4 次设计）/)
    assert.equal(await readFile(join(dirA, 'PLAN-APPROVED.md'), 'utf8'), '# PLAN FINAL\n')
    assert.equal(await readFile(join(dirA, 'PLAN-R4.md'), 'utf8'), '# PLAN W4\n') // history untouched
    const approvedA = await readState(taskA)
    assert.equal(approvedA.planApproved, true)
    assert.ok(!Number.isNaN(Date.parse(approvedA.planApprovedAt)))
    assert.equal(approvedA.planRounds, 4) // counting unchanged by approval
    assert.deepEqual(approvedA.gate, stateA.gate) // approval keeps the review gate
    assert.equal(approvedA.lastVerdict, undefined) // approval records no review verdict
    assert.match(await readFile(join(dirA, 'JOURNAL.md'), 'utf8'), /lead: 审核 PLAN 通过（设计轮次 4\/4）/)
    await assert.rejects(tool('squad_approve_plan').execute({ task_id: taskA }, exec), /已批准/)

    // The approved archive stays authoritative even if the draft drifts later.
    await writeFile(join(dirA, 'PLAN.md'), '# UNAPPROVED DRAFT\n', 'utf8')

    // --- AC4: independence after approval ------------------------------------
    assert.match(await dispatch({ agent: 'zcode', message: 'impl', phase: 'implement' }), /本地子代理 zcode/)
    assert.match(await dispatch({ agent: 'zcode', message: 'fix', phase: 'rework' }), /本地子代理 zcode/)
    assert.equal(await readFile(join(dirA, 'PLAN-APPROVED.md'), 'utf8'), '# PLAN FINAL\n')
    assertSEM(host.activations.at(-1).prompt.map((block) => block.text).join(''))
    assertSEM(host.sent.at(-1).content.map((block) => block.text).join(''))
    await assertBrief(dirA)
    await assert.rejects(design('late'), /PLAN 已批准/)
    // Plan approval does not bypass the REVIEW gate on finish — neither a
    // missing REVIEW nor an explicit CHANGES_REQUESTED verdict.
    await assert.rejects(
      tool('squad_finish').execute({ summary: 's', task_id: taskA }, exec),
      /REVIEW/,
    )
    await writeFile(join(dirA, 'REVIEW.md'), '# REVIEW\n\nVERDICT: CHANGES_REQUESTED\n', 'utf8')
    await assert.rejects(
      tool('squad_finish').execute({ summary: 's', task_id: taskA }, exec),
      /CHANGES_REQUESTED/,
    )

    // A review dispatch still carries S/E/M (charter included, fresh external
    // call) and the approved archive + REVIEW verdict are untouched.
    skipPlan = true
    assert.match(
      await dispatch({ agent: 'codex', message: 'review', phase: 'review' }),
      /已外部派发 codex/,
    )
    skipPlan = false
    assertSEM(host.activations.at(-1).prompt.map((block) => block.text).join(''))
    await assertBrief(dirA)
    assert.equal(await readFile(join(dirA, 'PLAN-APPROVED.md'), 'utf8'), '# PLAN FINAL\n')
    assert.equal(
      await readFile(join(dirA, 'REVIEW.md'), 'utf8'),
      '# REVIEW\n\nVERDICT: CHANGES_REQUESTED\n',
    )

    // --- AC3: approve rejections (missing PLAN, zero rounds, closed task) ----
    await assert.rejects(tool('squad_approve_plan').execute({ task_id: 't-nope' }, exec), /未知小队任务/)
    const startB = await tool('squad_start').execute({ goal: 'b', acceptance: 'b', agents: ['codex'] }, exec)
    const taskB = /任务 (t-\S+) 已创建/.exec(startB)[1]
    const dirB = join(workspace, '.agent-squad', taskB)
    await assert.rejects(tool('squad_approve_plan').execute({ task_id: taskB }, exec), /PLAN\.md/)
    await writeFile(join(dirB, 'PLAN.md'), '# ZERO\n', 'utf8')
    await tool('squad_approve_plan').execute({ task_id: taskB }, exec)
    assert.equal((await readState(taskB)).planRounds, 0) // approval with zero design rounds
    assert.ok(!(await readdir(dirB)).includes('PLAN-R0.md')) // no R0 archive

    // Archive failure keeps the task unapproved.
    const startC = await tool('squad_start').execute({ goal: 'c', acceptance: 'c', agents: ['codex'] }, exec)
    const taskC = /任务 (t-\S+) 已创建/.exec(startC)[1]
    const dirC = join(workspace, '.agent-squad', taskC)
    await design('c1')
    await mkdir(join(dirC, 'PLAN-APPROVED.md')) // a directory blocks the archive write
    await assert.rejects(tool('squad_approve_plan').execute({ task_id: taskC }, exec), /(EISDIR|PLAN-APPROVED)/)
    assert.notEqual((await readState(taskC)).planApproved, true)
    await rm(join(dirC, 'PLAN-APPROVED.md'), { recursive: true, force: true })

    // --- AC1: no-brain exemption ----------------------------------------------
    const startD = await tool('squad_start').execute({ goal: 'd', acceptance: 'd', agents: ['zcode', 'qoder'] }, exec)
    const taskD = /任务 (t-\S+) 已创建/.exec(startD)[1]
    assert.equal((await readState(taskD)).planRequired, false)
    assert.match(await dispatch({ agent: 'zcode', message: 'impl', phase: 'implement' }), /本地子代理 zcode/)
    assert.match(await dispatch({ agent: 'zcode', message: 'fix', phase: 'rework' }), /本地子代理 zcode/)
    // Exempt task's BRIEF still carries the exemption line (E).
    const briefD = await readFile(join(workspace, '.agent-squad', taskD, 'BRIEF.md'), 'utf8')
    assert.ok(briefD.includes(E_TEXT))
    const finishD = await tool('squad_finish').execute({ summary: 'no brain', task_id: taskD }, exec)
    assert.match(finishD, /收尾/)
    await assert.rejects(tool('squad_approve_plan').execute({ task_id: taskD }, exec), /已经收尾/)

    // --- AC1: legacy STATE fallback -------------------------------------------
    const startE = await tool('squad_start').execute({ goal: 'e', acceptance: 'e', agents: ['codex'] }, exec)
    const taskE = /任务 (t-\S+) 已创建/.exec(startE)[1]
    const stateEPath = join(workspace, '.agent-squad', taskE, 'STATE.json')
    const stripPlan = (state, mutate) => {
      delete state.planRequired
      delete state.planRounds
      delete state.planApproved
      delete state.planApprovedAt
      mutate?.(state)
      return writeFile(stateEPath, JSON.stringify(state, null, 2), 'utf8')
    }
    // gate true → plan still required
    await stripPlan(JSON.parse(await readFile(stateEPath, 'utf8')))
    await assert.rejects(dispatch({ agent: 'zcode', message: 'x', phase: 'implement' }), /squad_approve_plan/)
    // gate explicitly false → exempt
    await stripPlan(JSON.parse(await readFile(stateEPath, 'utf8')), (state) => {
      state.gate.reviewRequired = false
    })
    assert.match(await dispatch({ agent: 'zcode', message: 'x', phase: 'implement' }), /本地子代理 zcode/)
    // gate missing → conservative (required)
    await stripPlan(JSON.parse(await readFile(stateEPath, 'utf8')), (state) => {
      delete state.gate
    })
    await assert.rejects(dispatch({ agent: 'zcode', message: 'x', phase: 'implement' }), /squad_approve_plan/)

    // --- AC5: local/team design archives only at approve time -----------------
    const { createSettingsStore } = await import('../settings.js')
    const settingsStore = createSettingsStore({ filePath: settingsPath })
    let snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) => (agent.id === 'qoder' ? { ...agent, role: 'brain' } : agent)),
      worktree: snapshot.worktree,
    })
    const startF = await tool('squad_start').execute({ goal: 'f', acceptance: 'f', agents: ['qoder'] }, exec)
    const taskF = /任务 (t-\S+) 已创建/.exec(startF)[1]
    const dirF = join(workspace, '.agent-squad', taskF)
    const designF = await dispatch({ agent: 'qoder', message: 'team design', phase: 'design' })
    assert.match(designF, /已创建 qoder \[brain\]/)
    assert.equal((await readState(taskF)).planRounds, 1) // counted on delivery
    assert.ok(!(await readdir(dirF)).includes('PLAN-R1.md')) // archived only at approve
    await writeFile(join(dirF, 'PLAN.md'), '# TEAM PLAN\n', 'utf8')
    // D1: a directory squatting on the round-archive path blocks approval and
    // keeps the task unapproved.
    await mkdir(join(dirF, 'PLAN-R1.md'))
    await assert.rejects(
      tool('squad_approve_plan').execute({ task_id: taskF }, exec),
      /不是普通文件/,
    )
    assert.notEqual((await readState(taskF)).planApproved, true)
    await rm(join(dirF, 'PLAN-R1.md'), { recursive: true, force: true })
    await tool('squad_approve_plan').execute({ task_id: taskF }, exec)
    assert.equal(await readFile(join(dirF, 'PLAN-R1.md'), 'utf8'), '# TEAM PLAN\n')
    const statusF = await tool('squad_status').execute({}, exec)
    assert.match(statusF, /planRequired=true/)
    assert.match(statusF, /planRounds=1\/4/)
    assert.match(statusF, /planApproved=true/)
    assert.match(statusF, /planApprovedAt=/)
    assert.match(statusF, /PLAN-APPROVED\.md/)

    // --- AC1: roster edits after start cannot relax the plan gate ------------
    const startG = await tool('squad_start').execute(
      { goal: 'g2', acceptance: 'a2', agents: ['codex'] },
      exec,
    )
    const taskG = /任务 (t-\S+) 已创建/.exec(startG)[1]
    snapshot = await settingsStore.read()
    await settingsStore.save({
      expectedRevision: snapshot.revision,
      agents: snapshot.agents.map((agent) => {
        if (agent.id === 'codex') return { ...agent, role: 'worker' }
        if (agent.id === 'qoder') return { ...agent, role: 'brain' }
        return agent
      }),
      worktree: snapshot.worktree,
    })
    await assert.rejects(dispatch({ agent: 'zcode', message: 'x', phase: 'implement' }), /squad_approve_plan/)
    await assert.rejects(dispatch({ agent: 'zcode', message: 'x', phase: 'rework' }), /squad_approve_plan/)

    // --- AC6: the generated TASK.md protocol distinguishes the two approvals --
    const taskMd = await readFile(join(dirA, 'TASK.md'), 'utf8')
    assert.match(taskMd, /squad_approve_plan/)
    assert.match(taskMd, /Lead 只批准\*\*方案\*\*/)
    assert.match(taskMd, /编号缺陷再派/)
    assert.match(taskMd, /4 次 design 派单，未扩展时第 5 次暂停/)
    assert.match(taskMd, /实现验收只有 `brain` 能批准/)
    assert.match(taskMd, /默认 3 轮，未扩展时第 4 次暂停/)
    assertSEM(taskMd)

    // --- AC6/AC7: flow copy, dictionary and SVG wiring in the sources ---------
    const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
    const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    for (const text of [indexSource, readme]) {
      assert.match(text, /squad_approve_plan/)
      assert.match(text, /PLAN-APPROVED\.md/)
      assert.match(text, /PLAN-R<n>\.md|PLAN-R\$\{/)
      assert.match(text, /3 轮|3 rework rounds|MAX_DESIGN_REWORK_ROUNDS/)
    }
    assert.match(indexSource, /先审方案再实现/)
    assert.match(indexSource, /三种批准相互独立/)
    assert.match(clientSource, /flowPlanReview/)
    assert.match(clientSource, /flowPlanLoop/)
    assert.match(clientSource, /flowApprove/)
    assert.match(clientSource, /settings\.section/)
    assert.match(clientSource, /roleArchitect/)
    // The settings page exposes the per-agent reasoning effort for pinned
    // provider/model executors (local + one-shot external).
    assert.match(clientSource, /asq-\$\{agent\.id\}-reasoning/)
    assert.match(clientSource, /update\(\{ reasoning: event\.target\.value \}\)/)
    assert.match(readme, /先审方案再实现|Lead 审核 PLAN/)
    assert.match(readme, /第 4 轮/)
    assert.ok(!/6 轮返工|第 7 次/.test(readme))
    // --- PLAN §6: verbatim S/E/M and charter items in the changed sections ---
    const brainSeg = indexSource.slice(
      indexSource.indexOf('const BRAIN_CHARTER ='),
      indexSource.indexOf('const ARCHITECT_CHARTER ='),
    )
    const architectSeg = indexSource.slice(
      indexSource.indexOf('const ARCHITECT_CHARTER ='),
      indexSource.indexOf('const WORKER_CHARTER ='),
    )
    const workerSeg = indexSource.slice(
      indexSource.indexOf('const WORKER_CHARTER ='),
      indexSource.indexOf('const LEAD_POLICY ='),
    )
    const leadSeg = indexSource.slice(
      indexSource.indexOf('const LEAD_POLICY ='),
      indexSource.indexOf('const DEFAULT_AGENTS ='),
    )
    for (const item of BRAIN_ITEMS) assert.ok(brainSeg.includes(item), `BRAIN missing: ${item}`)
    for (const item of ARCHITECT_ITEMS) assert.ok(architectSeg.includes(item), `ARCHITECT missing: ${item}`)
    for (const item of WORKER_ITEMS) assert.ok(workerSeg.includes(item), `WORKER missing: ${item}`)
    // §4 step 3: the Lead reviews the business plan as a context-free
    // architect; step 4 approves; step 5 dispatches the spec round.
    assert.ok(
      leadSeg.includes(
        '3. Lead 亲自审核 PLAN.md：假装自己是没有上下文的架构师，无法只靠 PLAN 拍板技术设计的点按 D1 起连续编号，写明章节、缺失或矛盾、最小补全要求，派回 brain（phase="design"）返工迭代，',
      ),
      'LEAD step 3 new text missing',
    )
    assert.ok(
      leadSeg.includes('4. 方案合格后调用 squad_approve_plan 批准（归档 PLAN-APPROVED.md）。'),
      'LEAD step 4 sentence missing',
    )
    assert.ok(
      leadSeg.includes('5. 派 architect（gpt），phase="spec"：读取 PLAN-APPROVED.md，发布技术规格 SPEC.md'),
      'LEAD step 5 sentence missing',
    )
    for (const item of [...BRAIN_ITEMS, ...ARCHITECT_ITEMS, S_TEXT, E_TEXT, M_TEXT]) {
      assert.ok(readme.includes(item), `README missing: ${item}`)
    }
    assert.ok(readme.includes(WORKER_ITEMS[1]), 'README missing worker no-introduce item')
    assert.ok(readme.includes(WORKER_ITEMS[2]), 'README missing worker blocked item')
    // Budget-gate copy: LEAD_POLICY, the generated TASK.md and the README all
    // describe the user-decision pause + squad_extend flow (PLAN §27/D2),
    // with a fully valid example call (kind, rounds, reason, confirmed=true).
    const validCall = 'squad_extend(kind="design", rounds=3, reason="用户批准的追加理由", confirmed=true)'
    for (const text of [leadSeg, taskMd, readme]) {
      for (const literal of ['squad_extend', 'confirmed=true', '等待', '不自动续跑', validCall]) {
        assert.ok(text.includes(literal), `budget-gate copy missing "${literal}"`)
      }
    }
    // D2: the generated TASK carries the full decision rules, and the README
    // Lead role row lists squad_extend among its tools.
    for (const literal of [
      '已完成部分',
      'rounds=3',
      '每次扩展都要重新取得用户明确确认',
      '可重复扩展',
      '用户拒绝或未回复时保持暂停',
    ]) {
      assert.ok(taskMd.includes(literal), `TASK decision-gate rule missing: ${literal}`)
    }
    assert.ok(
      readme.includes('`squad_approve_plan` / `squad_extend` / `squad_status`'),
      'README lead tool row must list squad_extend',
    )
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T08 — qoder-cli provider: arg builder defaults/overrides and full process lifecycle. */
test('T08 qoder provider builds args and handles process lifecycle', async () => {
  const { createQoderProvider, buildQoderArgs } = await import('../qoder.js')
  const { PassThrough } = await import('node:stream')
  const { EventEmitter, getEventListeners } = await import('node:events')

  // --- arg builder: defaults, empty strings, frozen config -----------------
  assert.deepEqual(buildQoderArgs('hi', '/tmp/a b'), [
    '-p', 'hi', '-w', '/tmp/a b', '--permission-mode', 'accept_edits',
  ])
  assert.deepEqual(buildQoderArgs('', '', { model: '' }), [
    '-p', '', '-w', '', '--permission-mode', 'accept_edits',
  ])
  assert.deepEqual(
    buildQoderArgs('a\nb;$(x)', '/tmp/a b', Object.freeze({ permissionMode: 'custom', model: 'm1' })),
    ['-p', 'a\nb;$(x)', '-w', '/tmp/a b', '--permission-mode', 'custom', '-m', 'm1'],
  )

  // --- codex-cli provider: arg builder + answer extraction -----------------
  const { buildCodexArgs, extractCodexAnswer, createCodexProvider } = await import('../codex.js')
  assert.deepEqual(buildCodexArgs('hi', '/tmp/w'), [
    'exec', '--skip-git-repo-check',
    '-m', 'gpt-6.2-astra',
    '-c', 'model_reasoning_effort="xhigh"',
    '-s', 'workspace-write',
    '-C', '/tmp/w',
    'hi',
  ])
  assert.deepEqual(
    buildCodexArgs('p', '/w', { model: 'm9', reasoningEffort: 'low', sandboxMode: 'read-only' }),
    [
      'exec', '--skip-git-repo-check',
      '-m', 'm9',
      '-c', 'model_reasoning_effort="low"',
      '-s', 'read-only',
      '-C', '/w',
      'p',
    ],
  )
  {
    const stdout = [
      'OpenAI Codex v0.170.0',
      '--------',
      'workdir: /w',
      'model: gpt-6.2-astra',
      '',
      'user',
      'do it',
      'codex',
      'line one',
      'line two',
      'tokens used',
      '7,844',
      'line one',
      'line two',
      '',
    ].join('\n')
    assert.equal(extractCodexAnswer(stdout), 'line one\nline two')
    assert.equal(extractCodexAnswer('no markers'), 'no markers')
  }
  {
    const codexBare = createCodexProvider()
    assert.equal(codexBare.name, 'codex-cli')
    assert.equal(codexBare.inheritsParentContext, false)
    assert.deepEqual(codexBare.capabilities, {
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    })
  }

  // --- constructor defaults: shape, capabilities, one-shot -----------------
  const bare = createQoderProvider()
  assert.equal(bare.name, 'qoder-cli')
  assert.equal(bare.inheritsParentContext, false)
  assert.deepEqual(bare.capabilities, {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  })
  assert.equal(bare.prepareContinuable, undefined)

  // --- spawn double: EventEmitter child + PassThrough stdio -----------------
  const makeChild = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 4321
    child.kills = []
    child.kill = (signal) => {
      child.kills.push(signal)
      return true
    }
    return child
  }
  const spawnCalls = []
  const spawnImpl = (command, args, options) => {
    const child = makeChild()
    spawnCalls.push({ command, args, options, child })
    return child
  }
  const text = (t) => ({ type: 'text', text: t })
  const baseRequest = (over = {}) => ({
    prompt: [text('A'), text('B')],
    parent: { id: 'lead-1' },
    cwd: '/tmp/a b',
    ...over,
  })
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const startRun = async (provider, over) => {
    const run = await provider.start(baseRequest(over))
    return { run, child: spawnCalls.at(-1).child }
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  const defaultProvider = createQoderProvider({ spawnImpl })
  const run1 = await startRun(defaultProvider)
  assert.deepEqual(spawnCalls.at(-1), {
    command: 'qoderclicn',
    args: ['-p', 'A\nB', '-w', '/tmp/a b', '--permission-mode', 'accept_edits'],
    options: { cwd: '/tmp/a b', stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    child: spawnCalls.at(-1).child,
  })
  assert.match(run1.run.id, UUID_RE)
  const customProvider = createQoderProvider({
    command: '/tmp/qoder',
    permissionMode: 'custom',
    model: 'm1',
    spawnImpl,
  })
  const run2 = await startRun(customProvider)
  assert.equal(spawnCalls.at(-1).command, '/tmp/qoder')
  assert.deepEqual(spawnCalls.at(-1).args, [
    '-p', 'A\nB', '-w', '/tmp/a b', '--permission-mode', 'custom', '-m', 'm1',
  ])
  assert.match(run2.run.id, UUID_RE)
  assert.notEqual(run1.run.id, run2.run.id)

  // --- success: split multibyte stdout, stderr excluded, exit≠settle -------
  {
    const { run, child } = await startRun(defaultProvider)
    const bytes = Buffer.from('你好\n', 'utf8')
    // Split inside the FIRST multibyte character (你 = 3 bytes): only a real
    // UTF-8 decoder on the stream reassembles '你好\n' correctly.
    child.stdout.write(bytes.subarray(0, 1))
    child.stdout.write(bytes.subarray(1))
    child.stderr.write('warning\n')
    child.emit('exit', 0)
    let settled = false
    run.result.then(() => {
      settled = true
    })
    await flush()
    assert.equal(settled, false) // exit alone must not settle the result
    child.emit('close', 0, null)
    assert.deepEqual(await run.result, {
      output: [{ type: 'text', text: '你好\n' }],
      stopReason: 'completed',
    })
    // Completed: dispose reuses one cached cleanup Promise and never kills.
    const doneDispose = run.dispose()
    assert.equal(run.dispose(), doneDispose)
    assert.equal(await doneDispose, undefined)
    assert.deepEqual(child.kills, [])
  }
  {
    const { run, child } = await startRun(defaultProvider)
    child.emit('close', 0, null)
    assert.deepEqual(await run.result, {
      output: [{ type: 'text', text: '' }],
      stopReason: 'completed',
    })
    const doneDispose = run.dispose()
    assert.equal(run.dispose(), doneDispose)
    assert.equal(await doneDispose, undefined)
    assert.deepEqual(child.kills, [])
  }

  // --- failure table: non-zero exit / signal / no status --------------------
  {
    const cases = [
      { code: 2, signal: null, stderr: ' denied\n', diagnostic: 'Qoder CLI exited with code 2: denied' },
      { code: 1, signal: null, stderr: '', diagnostic: 'Qoder CLI exited with code 1' },
      { code: null, signal: 'SIGTERM', stderr: '', diagnostic: 'Qoder CLI terminated by signal SIGTERM' },
      { code: null, signal: null, stderr: '', diagnostic: 'Qoder CLI exited without status' },
    ]
    for (const item of cases) {
      const { run, child } = await startRun(defaultProvider)
      child.stdout.write('partial')
      if (item.stderr !== '') child.stderr.write(item.stderr)
      child.emit('close', item.code, item.signal)
      const result = await run.result
      assert.deepEqual(result.output, [{ type: 'text', text: 'partial' }])
      assert.equal(result.stopReason, 'error')
      assert.equal(result.diagnostic, item.diagnostic)
    }
  }

  // --- errors: spawn throw and child error ----------------------------------
  {
    const throwing = createQoderProvider({
      spawnImpl: () => {
        throw new Error('ENOENT')
      },
    })
    const controller = new AbortController() // not aborted yet
    const run = await throwing.start(baseRequest({ signal: controller.signal }))
    assert.deepEqual(await run.result, {
      output: [{ type: 'text', text: '' }],
      stopReason: 'error',
      diagnostic: 'Qoder CLI error: ENOENT',
    })
    // No abort listener may remain on a settled run.
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    // Never spawned: dispose still reuses one cached cleanup Promise.
    const thrownDispose = run.dispose()
    assert.equal(run.dispose(), thrownDispose)
    assert.equal(await thrownDispose, undefined)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    // A late abort must not re-arm anything either.
    controller.abort()
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.deepEqual(await run.result, {
      output: [{ type: 'text', text: '' }],
      stopReason: 'error',
      diagnostic: 'Qoder CLI error: ENOENT',
    })
  }
  {
    const { run, child } = await startRun(defaultProvider)
    child.emit('error', new Error('ENOENT'))
    const result = await run.result
    assert.deepEqual(result.output, [{ type: 'text', text: '' }])
    assert.equal(result.stopReason, 'error')
    assert.equal(result.diagnostic, 'Qoder CLI error: ENOENT')
    child.emit('close', 0, null) // late close must not rewrite the result
    const again = await run.result
    assert.equal(again.stopReason, 'error')
    assert.equal(again.diagnostic, 'Qoder CLI error: ENOENT')
  }

  // --- cancel: dispose settles aborted, SIGTERM then close ------------------
  {
    const { run, child } = await startRun(defaultProvider)
    child.stdout.write('partial')
    const first = run.dispose()
    const second = run.dispose()
    assert.equal(second, first) // one cleanup Promise for concurrent dispose
    assert.deepEqual(child.kills, ['SIGTERM'])
    assert.deepEqual(await run.result, {
      output: [{ type: 'text', text: 'partial' }],
      stopReason: 'aborted',
    })
    child.emit('close', null, 'SIGTERM')
    assert.equal(await first, undefined)
    assert.equal(run.dispose(), first) // still the same promise
    assert.deepEqual(child.kills, ['SIGTERM'])
  }

  // --- no-pid spawn failure AFTER dispose: cleanup resolves without close ----
  {
    const { run, child } = await startRun(defaultProvider)
    child.pid = undefined // spawn-failure shape: no process, kill→false
    child.kill = (signal) => {
      child.kills.push(signal)
      return false
    }
    const disposed = run.dispose()
    child.emit('error', new Error('ENOENT')) // no close will ever arrive
    assert.equal(await disposed, undefined)
    const result = await run.result
    assert.equal(result.stopReason, 'aborted') // first terminal state kept
    assert.equal(result.output[0].text, '')
    assert.equal(result.diagnostic, undefined)
    const again = run.dispose()
    assert.equal(await again, undefined)
    assert.deepEqual(child.kills, ['SIGTERM']) // later dispose kills nothing
  }

  // --- cancel escalation: 1000ms without close adds SIGKILL -----------------
  {
    const { run, child } = await startRun(defaultProvider)
    child.stdout.write('partial')
    mock.timers.enable({ apis: ['setTimeout'] })
    const disposed = run.dispose()
    try {
      assert.deepEqual(child.kills, ['SIGTERM'])
      mock.timers.tick(1000)
      assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
      child.emit('close', null, 'SIGKILL')
      mock.timers.tick(1000) // no leftover timer fires again
      assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
      assert.equal(await disposed, undefined)
    } finally {
      mock.timers.reset()
    }
    const result = await run.result
    assert.equal(result.stopReason, 'aborted')
    assert.equal(result.output[0].text, 'partial')
    assert.equal(result.diagnostic, undefined)
  }

  // --- abort DURING spawn: the returned child must still be cancelled -------
  {
    const controller = new AbortController()
    const child = makeChild()
    const racing = createQoderProvider({
      spawnImpl: () => {
        controller.abort() // fires before spawn returns
        return child
      },
    })
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const run = await racing.start(baseRequest({ signal: controller.signal }))
      assert.deepEqual(child.kills, ['SIGTERM']) // child got terminated
      assert.deepEqual(await run.result, {
        output: [{ type: 'text', text: '' }],
        stopReason: 'aborted',
      })
      const first = run.dispose()
      const second = run.dispose()
      assert.equal(second, first) // one cleanup Promise
      let fulfilled = false
      first.then(() => {
        fulfilled = true
      })
      await flush()
      assert.equal(fulfilled, false) // not resolved before close
      mock.timers.tick(999)
      assert.deepEqual(child.kills, ['SIGTERM']) // no escalation yet
      mock.timers.tick(1)
      assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
      child.emit('close', 0, null) // late success must not complete a cancelled run
      assert.equal(await first, undefined)
      const again = await run.result
      assert.equal(again.stopReason, 'aborted')
      assert.equal(again.diagnostic, undefined)
      assert.equal(run.dispose(), first)
      mock.timers.tick(1000)
      assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']) // later dispose kills nothing
    } finally {
      mock.timers.reset()
    }
  }

  // --- kill failure surfaces the termination error ---------------------------
  {
    const { run, child } = await startRun(defaultProvider)
    child.kill = (signal) => {
      child.kills.push(signal)
      throw new Error('denied')
    }
    await assert.rejects(run.dispose(), { message: 'Qoder CLI termination failed: denied' })
  }

  // --- abort signal: pre-aborted skips spawn; abort mid-run ≡ dispose -------
  {
    const spawnCount = spawnCalls.length
    const controller = new AbortController()
    controller.abort()
    const run = await defaultProvider.start(baseRequest({ signal: controller.signal }))
    assert.equal(spawnCalls.length, spawnCount) // no spawn for a dead signal
    assert.deepEqual(await run.result, {
      output: [{ type: 'text', text: '' }],
      stopReason: 'aborted',
    })
    const deadDispose = run.dispose()
    assert.equal(run.dispose(), deadDispose)
    assert.equal(await deadDispose, undefined)
  }
  {
    const controller = new AbortController()
    const { run, child } = await startRun(defaultProvider, { signal: controller.signal })
    child.stdout.write('partial')
    controller.abort()
    assert.deepEqual(child.kills, ['SIGTERM'])
    assert.deepEqual(await run.result, {
      output: [{ type: 'text', text: 'partial' }],
      stopReason: 'aborted',
    })
    child.emit('close', null, 'SIGTERM')
    assert.equal(await run.dispose(), undefined)
  }
})

// --- T09 helpers: real temp Git repositories and strict wrappers ------------

/** Create a temp Git repository with local identity and one commit. */
async function makeGitRepo(parent, name, message, files = {}) {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  await run('git', ['-C', dir, 'init', '-q'])
  await run('git', ['-C', dir, 'config', 'user.email', 't@t'])
  await run('git', ['-C', dir, 'config', 'user.name', 't'])
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), content, 'utf8')
  }
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-q', '-m', message])
  return realpath(dir)
}

async function writeSquadSettings(dshHome, qoderExecutor) {
  await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
  await writeFile(
    join(dshHome, 'agent-squad', 'settings.json'),
    JSON.stringify(
      {
        version: 2,
        revision: 1,
        agents: [
          { id: 'codex', displayName: 'codex', role: 'brain', executor: 'external', model: 'mock-ext', description: 'b' },
          { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
          { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'local', model: 'p/m1', description: 'w' },
          {
            id: 'qoder',
            displayName: 'qoder',
            role: 'worker',
            executor: qoderExecutor ?? 'team',
            model: qoderExecutor === 'external' ? 'qoder-cli' : '',
            description: 'w2',
          },
        ],
        worktree: { directory: '.agents/worktrees' },
      },
      null,
      2,
    ),
    'utf8',
  )
}

const gitOut = async (dir, args) => (await run('git', ['-C', dir, ...args])).stdout.trim()
const readOptional = async (path) => readFile(path, 'utf8').catch(() => undefined)
const gitSnapshot = async (repo) => ({
  worktrees: await gitOut(repo, ['worktree', 'list', '--porcelain']),
  branches: await gitOut(repo, ['branch', '--list']),
})

/** Remove every squad worktree/branch a test created under .agents/worktrees. */
async function cleanupSquadArtifacts(repos) {
  for (const repo of repos) {
    const list = await gitOut(repo, ['worktree', 'list', '--porcelain']).catch(() => '')
    for (const line of list.split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const path = line.slice('worktree '.length).trim()
      if (path.includes('.agents')) {
        await run('git', ['-C', repo, 'worktree', 'remove', '--force', path]).catch(() => {})
      }
    }
    const branches = await gitOut(repo, ['branch', '--list', 'squad-*']).catch(() => '')
    for (const branch of branches.split('\n')) {
      const name = branch.replace(/^\*?\s*/, '').trim()
      if (name) await run('git', ['-C', repo, 'branch', '-D', name]).catch(() => {})
    }
  }
}

/** T09 — one task across multiple independent Git repositories (PLAN §30–§36). */
test('T09 multi-repository lifecycle, validation, rollback and compatibility', async () => {
  const root = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  const labeled = async (name, fn) => {
    try {
      await fn()
    } catch (error) {
      error.message = `[${name}] ${error.message}`
      throw error
    }
  }
  try {
    // --- start-dispatch-status (PLAN §31) -----------------------------------
    await labeled('start-dispatch-status', async () => {
      const caller = join(root, 's1-caller')
      await mkdir(caller, { recursive: true })
      const repoA = await makeGitRepo(caller, 'a/shared repo', 'base A', { 'README.md': 'seed A\n' })
      const repoB = await makeGitRepo(root, 's1-b/shared repo', 'base B', { 'README.md': 'seed B\n' })
      await writeFile(join(repoA, 'dirty.txt'), 'uncommitted\n', 'utf8')
      await writeSquadSettings(dshHome)
      let currentDir = caller
      const cwdService = { get: () => currentDir, set: async (_a, d) => { currentDir = d } }
      const host = mockHost(caller, dshHome, {}, { workingDirectory: cwdService })
      const { apply } = await import('../index.js')
      apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
      const tool = (name) =>
        host.registered.find((entry) => entry.definition.name === name).definition
      const lead = { id: 'lead-1', session: { id: 'session-1' } }
      const exec = { agent: lead, signal: undefined }

      // schema.repos is a non-empty array of non-empty strings.
      const startSchema = tool('squad_start').parameters.properties.repos
      assert.equal(startSchema.type, 'array')
      assert.equal(startSchema.minItems, 1)
      assert.equal(startSchema.items.minLength, 1)

      try {
        const startOutput = await tool('squad_start').execute(
          // No architect participant → legacy gates; the spec/tech-review
          // pipeline is T11's scope.
          { goal: 'multi', acceptance: 'ok', agents: ['codex', 'zcode', 'qoder'], repos: ['a/shared repo', repoB] },
          exec,
        )
        const taskId = /任务 (t-\S+) 已创建/.exec(startOutput)[1]
        const taskRoot = join(repoA, '.agents', 'worktrees', `squad-${taskId}`)
        const wtA = join(taskRoot, '1-shared-repo')
        const wtB = join(taskRoot, '2-shared-repo')
        const branch = `squad-${taskId}`
        const baseA = await gitOut(repoA, ['rev-parse', 'HEAD'])
        const baseB = await gitOut(repoB, ['rev-parse', 'HEAD'])
        assert.notEqual(baseA, baseB)
        // Exact layout, unified branch, per-repo base, primary alias.
        const state = JSON.parse(await readFile(join(taskRoot, '.agent-squad', taskId, 'STATE.json'), 'utf8'))
        assert.equal(state.taskRoot, taskRoot)
        assert.equal(state.worktree.path, wtA)
        assert.deepEqual(
          state.worktrees.map((wt) => [wt.repo, wt.path, wt.branch, wt.baseCommit]),
          [
            [repoA, wtA, branch, baseA],
            [repoB, wtB, branch, baseB],
          ],
        )
        assert.equal(state.worktrees[0].repositoryRoot, repoA)
        assert.equal(currentDir, taskRoot)
        assert.equal(host.cwdCalls.at(-1).directory, taskRoot)
        // New budget snapshot fields persist at start (PLAN §6).
        assert.deepEqual(
          [state.designLimit, state.reworkLimit, state.extensions],
          [4, 3, []],
        )
        // Five deduplicated current pointers (task root, both worktrees,
        // primary source, caller source), all with the same content.
        const expectedPointer = { taskId, memoryRoot: join(taskRoot, '.agent-squad'), worktree: wtA, taskRoot }
        const pointerPaths = [
          join(taskRoot, '.agent-squad', 'current.json'),
          join(wtA, '.agent-squad', 'current.json'),
          join(wtB, '.agent-squad', 'current.json'),
          join(repoA, '.agent-squad', 'current.json'),
          join(caller, '.agent-squad', 'current.json'),
        ]
        for (const pointerPath of pointerPaths) {
          assert.deepEqual(JSON.parse(await readFile(pointerPath, 'utf8')), expectedPointer, pointerPath)
        }
        // TASK.md and status list every repository, path and base SHA.
        const taskMd = await readFile(join(taskRoot, '.agent-squad', taskId, 'TASK.md'), 'utf8')
        for (const text of [taskMd, startOutput]) {
          assert.ok(text.includes(`仓库：${repoA} | worktree：${wtA} | 分支：${branch} | 基线：${baseA}`))
          assert.ok(text.includes(`仓库：${repoB} | worktree：${wtB} | 分支：${branch} | 基线：${baseB}`))
        }
        assert.ok(taskMd.includes(taskRoot))
        // The dirty source file did not leak into the new worktree.
        await assert.rejects(stat(join(wtA, 'dirty.txt')))

        // Approve the PLAN (brain participates) before implement dispatches.
        await writeFile(join(taskRoot, '.agent-squad', taskId, 'PLAN.md'), '# PLAN T09\n', 'utf8')
        await tool('squad_approve_plan').execute({ task_id: taskId }, exec)

        // external dispatch: request cwd is the task root; prompt lists repos.
        await tool('squad_dispatch').execute(
          { agent: 'codex', message: 'review it', phase: 'review' },
          exec,
        )
        assert.equal(host.activations.at(-1).cwd, taskRoot)
        const externalPrompt = host.activations.at(-1).prompt.map((b) => b.text).join('')
        assert.ok(externalPrompt.includes(`仓库：${repoA}`))
        assert.ok(externalPrompt.includes(`仓库：${repoB}`))

        // local dispatch: request cwd is the task root; prompt lists repos.
        await tool('squad_dispatch').execute(
          { agent: 'zcode', message: 'implement', phase: 'implement' },
          exec,
        )
        assert.equal(host.activations.at(-1).cwd, taskRoot)
        const localPrompt = host.activations.at(-1).prompt.map((b) => b.text).join('')
        assert.ok(localPrompt.includes(`仓库：${repoA}`))
        assert.ok(localPrompt.includes(`仓库：${repoB}`))

        // team dispatch (new + resume): teammate cwd moves to the task root.
        const setsBefore = host.cwdCalls.filter((c) => c.op === 'set').length
        await tool('squad_dispatch').execute(
          { agent: 'qoder', message: 'parallel', phase: 'implement' },
          exec,
        )
        const spawnedPrompt = host.spawned.at(-1).prompt.map((b) => b.text).join('')
        assert.ok(spawnedPrompt.includes(`仓库：${repoA}`))
        assert.ok(host.cwdCalls.filter((c) => c.op === 'set').length > setsBefore)
        await tool('squad_dispatch').execute(
          { agent: 'qoder', message: 'again', phase: 'implement' },
          exec,
        )
        assert.ok(host.cwdCalls.some((c) => c.op === 'set' && c.directory === taskRoot))

        // qoder-cli external dispatch: -w is the task root, never --add-dir.
        const stubDir = await mkdtemp(join(tmpdir(), 'asq-qoder-t9-'))
        const stubPath = join(stubDir, 'qoder-argv.cjs')
        await writeFile(stubPath, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
        await chmod(stubPath, 0o755)
        try {
          const host2 = mockHost(caller, dshHome, {}, { workingDirectory: cwdService })
          apply(host2.ctx, { workerProbe: false, agents: BUNDLE_AGENTS, qoderCommand: stubPath })
          const tool2 = (name) =>
            host2.registered.find((entry) => entry.definition.name === name).definition
          await writeSquadSettings(dshHome, 'external')
          const qoderOut = await tool2('squad_dispatch').execute(
            { agent: 'qoder', message: 'argv probe', phase: 'review', task_id: taskId },
            exec,
          )
          const argv = JSON.parse(qoderOut.split('输出：\n')[1])
          const wIndex = argv.indexOf('-w')
          assert.equal(argv[wIndex + 1], taskRoot)
          assert.ok(!argv.includes('--add-dir'))
          assert.equal(host2.activations.at(-1).cwd, taskRoot)
        } finally {
          await rm(stubDir, { recursive: true, force: true })
        }

        const statusOut = await tool('squad_status').execute({}, exec)
        assert.ok(statusOut.includes(`工作区：${taskRoot}`))
        assert.ok(statusOut.includes(repoA) && statusOut.includes(repoB))
        assert.ok(statusOut.includes(baseA) && statusOut.includes(baseB))
      } finally {
        await cleanupSquadArtifacts([repoA, repoB])
      }
    })

    // --- invalid-and-conflicts (PLAN §32 + §39) ------------------------------
    await labeled('invalid-and-conflicts', async () => {
      const caller = join(root, 's2-caller')
      await mkdir(caller, { recursive: true })
      const repoC = await makeGitRepo(caller, 'repo-c', 'base C', { 'README.md': 'seed C\n' })
      await mkdir(join(repoC, 'sub'), { recursive: true })
      const notRepo = join(caller, 'not-repo')
      await mkdir(notRepo, { recursive: true })
      const plainFile = join(caller, 'plain-file')
      await writeFile(plainFile, 'x', 'utf8')
      const bare = await mkdtemp(join(tmpdir(), 'asq-bare-'))
      await run('git', ['-C', bare, 'init', '-q', '--bare'])
      const repoE = await makeGitRepo(caller, 'repo-e', 'base E', { 'README.md': 'seed E\n' })
      const repoF = await makeGitRepo(caller, 'repo-f', 'base F', { 'README.md': 'seed F\n' })
      const repoG = await makeGitRepo(caller, 'repo-g', 'base G', { 'README.md': 'seed G\n' })
      const repoH = await makeGitRepo(caller, 'repo-h', 'base H', { 'README.md': 'seed H\n' })
      await run('git', ['-C', repoC, 'worktree', 'add', join(root, 's2-linked-c'), '-b', 'probe-linked'])
      await symlink(repoC, join(caller, 'repo-c-link'))
      await writeSquadSettings(dshHome)
      let currentDir = caller
      const host = mockHost(caller, dshHome, {}, {
        workingDirectory: { get: () => currentDir, set: async (_a, d) => { currentDir = d } },
      })
      const { apply, createSquadWorktrees } = { ...(await import('../index.js')), ...(await import('../worktree.js')) }
      apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
      const tool = (name) =>
        host.registered.find((entry) => entry.definition.name === name).definition
      const lead = { id: 'lead-1', session: { id: 'session-1' } }
      const exec = { agent: lead, signal: undefined }

      const cases = [
        { repos: [], message: 'repos must be a non-empty array of non-empty strings' },
        { repos: null, message: 'repos must be a non-empty array of non-empty strings' },
        { repos: [''], message: 'repos must be a non-empty array of non-empty strings' },
        { repos: [7], message: 'repos must be a non-empty array of non-empty strings' },
        { repos: ['missing'], message: `repository does not exist: ${join(caller, 'missing')}` },
        { repos: [plainFile], message: `not a usable Git repository: ${plainFile}` },
        { repos: [notRepo], message: `not a usable Git repository: ${notRepo}` },
        { repos: [bare], message: `not a usable Git repository: ${bare}` },
        { repos: ['repo-c', 'repo-c'], message: `duplicate repository: ${repoC}` },
        { repos: ['repo-c', 'repo-c-link'], message: `duplicate repository: ${repoC}` },
        { repos: [repoC, join(repoC, 'sub')], message: `duplicate repository: ${repoC}` },
        { repos: [repoC, join(root, 's2-linked-c')], message: `duplicate repository: ${await realpath(join(root, 's2-linked-c'))}` },
      ]
      const pointerBefore = await readOptional(join(caller, '.agent-squad', 'current.json'))
      const snapshotC = await gitSnapshot(repoC)
      for (const item of cases) {
        await assert.rejects(
          tool('squad_start').execute({ goal: 'x', acceptance: 'y', repos: item.repos }, exec),
          { message: item.message },
        )
        assert.deepEqual(await gitSnapshot(repoC), snapshotC)
        assert.equal(await readOptional(join(caller, '.agent-squad', 'current.json')), pointerBefore)
      }
      await run('git', ['-C', repoC, 'worktree', 'remove', '--force', join(root, 's2-linked-c')])
      await run('git', ['-C', repoC, 'branch', '-D', 'probe-linked'])

      // Direct createSquadWorktrees conflicts with a fixed task id.
      const taskRoot = join(repoE, '.agents', 'worktrees', 'squad-t9-conflict')
      const wctx = { get: () => ({ set: async () => {} }) }
      const base = { ctx: wctx, lead: { id: 'lead' }, sourceDirectory: caller, taskId: 't9-conflict', directory: '.agents/worktrees' }
      // D06: cancellation is checked after each preflight validation stage.
      const cancelled = new AbortController()
      cancelled.abort()
      const signal = cancelled.signal
      const beforeAbort = await Promise.all([gitSnapshot(repoE), gitSnapshot(repoF)])
      for (const item of cases.slice(0, -1)) {
        await assert.rejects(createSquadWorktrees({ ...base, repos: item.repos, signal }),
          { message: item.message }, 'D06: repository validation precedes cancellation')
      }
      for (const [overrides, message] of [
        [{ directory: '../bad' }, 'worktree directory must not contain "." or ".." segments: ../bad'],
        [{ base: 'nope' }, `base revision is not a commit in ${repoE}: nope`],
        [{ ctx: { get: () => ({}) } }, 'workingDirectory service is unavailable; cannot enter the squad worktree'],
        [{ ctx: { get: () => ({ set: true }) } }, 'workingDirectory service is unavailable; cannot enter the squad worktree'],
        [{}, 'worktree creation aborted'],
      ]) {
        await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF], ...overrides, signal }),
          { message }, 'D06: directory/base/cwd validation precedes cancellation')
      }
      assert.deepEqual(await Promise.all([gitSnapshot(repoE), gitSnapshot(repoF)]), beforeAbort, 'D06: zero Git mutations')
      assert.equal(await readOptional(join(caller, '.agent-squad', 'current.json')), pointerBefore)
      await assert.rejects(stat(join(repoE, '.agents')), { code: 'ENOENT' })
      const snapshotE = await gitSnapshot(repoE)
      const snapshotF = await gitSnapshot(repoF)
      const assertClean = async () => {
        assert.deepEqual(await gitSnapshot(repoE), snapshotE)
        assert.deepEqual(await gitSnapshot(repoF), snapshotF)
        assert.equal(await readOptional(join(caller, '.agent-squad', 'current.json')), pointerBefore)
      }
      // Existing taskRoot directory.
      await mkdir(taskRoot, { recursive: true })
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF], signal }), {
        message: `worktree target already exists: ${taskRoot}`,
      }, 'D06: target validation precedes cancellation')
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF] }), {
        message: `worktree target already exists: ${taskRoot}`,
      })
      await rm(join(repoE, '.agents'), { recursive: true, force: true })
      await assertClean()
      // Registered but missing sub-path target.
      const regPath = join(taskRoot, '1-repo-e')
      await run('git', ['-C', repoE, 'worktree', 'add', regPath, '-b', 'reg-probe'])
      await rm(regPath, { recursive: true, force: true })
      await rm(join(repoE, '.agents'), { recursive: true, force: true })
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF] }), {
        message: `worktree target already exists: ${regPath}`,
      })
      await run('git', ['-C', repoE, 'worktree', 'prune'])
      await run('git', ['-C', repoE, 'branch', '-D', 'reg-probe'])
      await assertClean()
      // D05: a registered root remains owned even when its disk entry is gone.
      await run('git', ['-C', repoE, 'worktree', 'add', taskRoot, '-b', 'reg-root-probe'])
      await rm(taskRoot, { recursive: true, force: true })
      const registeredRootSnapshot = await gitSnapshot(repoE)
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF] }), {
        message: `worktree target already exists: ${taskRoot}`,
      }, 'D05: registered task root must be rejected')
      assert.deepEqual(await gitSnapshot(repoE), registeredRootSnapshot, 'D05: registration is untouched')
      assert.deepEqual(await gitSnapshot(repoF), snapshotF)
      await run('git', ['-C', repoE, 'worktree', 'prune'])
      await run('git', ['-C', repoE, 'branch', '-D', 'reg-root-probe'])
      await assertClean()
      // D02: inject a competing owner after preflight, before exclusive mkdir.
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const sentinel = join(taskRoot, 'other-owner.txt')
      let switches = 0
      const raceCtx = { get: () => {
        mkdirSync(taskRoot, { recursive: true })
        writeFileSync(sentinel, 'owned by another start\n')
        return { set: async () => { switches += 1 } }
      } }
      await assert.rejects(createSquadWorktrees({ ...base, ctx: raceCtx, repos: [repoE, repoF] }), {
        message: `worktree target already exists: ${taskRoot}`,
      }, 'D02: unowned task root must not be rolled back')
      assert.equal(await readFile(sentinel, 'utf8'), 'owned by another start\n', 'D02: sentinel preserved')
      assert.equal(switches, 0, 'D02: no rollback cwd call')
      await assertClean()
      await rm(taskRoot, { recursive: true, force: true })
      // Branch already exists in the second repository.
      await run('git', ['-C', repoF, 'branch', 'squad-t9-conflict'])
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF], signal }), {
        message: `worktree branch already exists in ${repoF}: squad-t9-conflict`,
      }, 'D06: branch validation precedes cancellation')
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF] }), {
        message: `worktree branch already exists in ${repoF}: squad-t9-conflict`,
      })
      await run('git', ['-C', repoF, 'branch', '-D', 'squad-t9-conflict'])
      await assertClean()
      // Repository without commits / unknown base revision.
      const repoEmpty = join(caller, 'repo-empty')
      await mkdir(repoEmpty, { recursive: true })
      await run('git', ['-C', repoEmpty, 'init', '-q'])
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoEmpty, repoF] }), {
        message: `base revision is not a commit in ${await realpath(repoEmpty)}: HEAD`,
      })
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF], base: 'nope' }), {
        message: `base revision is not a commit in ${repoE}: nope`,
      })
      await assertClean()
      // Directory validation reuses the strict legacy messages.
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF], directory: '../bad' }), {
        message: 'worktree directory must not contain "." or ".." segments: ../bad',
      })
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF], directory: '/abs' }), {
        message: 'worktree directory must be relative to the repository: /abs',
      })
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF], directory: '.git' }), {
        message: 'worktree directory must not be inside .git',
      })
      const outside = join(root, 's2-outside')
      await mkdir(outside, { recursive: true })
      await symlink(outside, join(repoE, 'esc-link'))
      await assert.rejects(createSquadWorktrees({ ...base, repos: [repoE, repoF], directory: 'esc-link' }), {
        message: `worktree destination escapes the repository or enters .git: ${join(repoE, 'esc-link', 'squad-t9-conflict')}`,
      })
      await assertClean()

      // Invalid memoryDir for multi-repository start: refused with zero artifacts.
      const hostM = mockHost(caller, dshHome, {}, {
        workingDirectory: { get: () => currentDir, set: async (_a, d) => { currentDir = d } },
      })
      apply(hostM.ctx, { workerProbe: false, agents: BUNDLE_AGENTS, memoryDir: '../outside' })
      const toolM = (name) =>
        hostM.registered.find((entry) => entry.definition.name === name).definition
      await assert.rejects(
        toolM('squad_start').execute(
          { goal: 'x', acceptance: 'y', repos: [repoG, repoH] },
          { agent: lead, signal: undefined },
        ),
        { message: 'multi-repository memory directory must stay inside the task root: ../outside' },
      )
      await assert.rejects(stat(join(repoG, '.agents')))
      await assert.rejects(stat(join(repoH, '.agents')))
    })

    // --- rollback (PLAN §33) --------------------------------------------------
    await labeled('rollback', async () => {
      const caller = join(root, 's3-caller')
      await mkdir(caller, { recursive: true })
      const repoI = await makeGitRepo(root, 's3-i', 'base I', { 'README.md': 'seed I\n' })
      const repoJ = await makeGitRepo(root, 's3-j', 'base J', { 'README.md': 'seed J\n' })
      await writeSquadSettings(dshHome)
      const realGit = (await run('which', ['git'])).stdout.trim()
      const wrapperDir = await mkdtemp(join(tmpdir(), 'asq-git-bin-'))
      const wrapper = join(wrapperDir, 'git')
      await writeFile(
        wrapper,
        [
          '#!/bin/sh',
          'if [ "$ASQ_T09_INJECT" = "1" ] && [ "$1" = "-C" ] && [ "$2" = "__REPO_J__" ] && [ "$3" = "worktree" ] && [ "$4" = "add" ]; then',
          '  echo injected add failure >&2',
          '  exit 73',
          'fi',
          'if [ "$ASQ_T09_REMOVE_FAIL" = "1" ] && [ "$2" = "__REPO_J__" ] && [ "$3" = "worktree" ] && [ "$4" = "remove" ]; then',
          '  echo injected remove failure >&2',
          '  exit 74',
          'fi',
          'exec "__REALGIT__" "$@"',
          '',
        ]
          .join('\n')
          .replaceAll('__REPO_J__', repoJ)
          .replace('__REALGIT__', realGit),
        'utf8',
      )
      await chmod(wrapper, 0o755)
      const pathBefore = process.env.PATH
      process.env.PATH = `${wrapperDir}:${pathBefore}`
      const snapshotI = await gitSnapshot(repoI)
      const snapshotJ = await gitSnapshot(repoJ)
      const assertRolledBack = async (currentDir, caller) => {
        assert.deepEqual(await gitSnapshot(repoI), snapshotI)
        assert.deepEqual(await gitSnapshot(repoJ), snapshotJ)
        const worktreesDir = join(repoI, '.agents', 'worktrees')
        let leftovers = []
        try {
          leftovers = (await readdir(worktreesDir)).filter((name) => name.startsWith('squad-'))
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        assert.deepEqual(leftovers, [])
        assert.equal(currentDir(), caller)
        assert.equal(await readOptional(join(caller, '.agent-squad', 'current.json')), undefined)
        assert.equal(await readOptional(join(repoI, '.agent-squad', 'current.json')), undefined)
      }
      try {
        // R1: injected failure on the second repository's worktree add.
        process.env.ASQ_T09_INJECT = '1'
        let currentDir = caller
        const mkHost = (setImpl) => {
          const service = { get: () => currentDir, set: setImpl(() => currentDir, (_agent, directory) => { currentDir = directory }) }
          const h = mockHost(caller, dshHome, {}, { workingDirectory: service })
          return h
        }
        let host = mkHost((_get, set) => set)
        const { apply } = await import('../index.js')
        apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
        const tool = (name) =>
          host.registered.find((entry) => entry.definition.name === name).definition
        const lead = { id: 'lead-1', session: { id: 'session-1' } }
        const exec = { agent: lead, signal: undefined }
        await assert.rejects(
          tool('squad_start').execute(
            { goal: 'x', acceptance: 'y', repos: [repoI, repoJ] },
            exec,
          ),
          (error) => /multi-repository creation failed/.test(error.message) && error.message.includes('injected add failure'),
        )
        await assertRolledBack(() => currentDir, caller)
        delete process.env.ASQ_T09_INJECT

        // R2: the first cwd switch fails, the restore succeeds.
        host = mkHost((_get, set) => {
          let calls = 0
          return async (_agent, directory) => {
            calls += 1
            if (calls === 1) throw new Error('switch failed')
            set(_agent, directory)
          }
        })
        apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
        const toolR2 = (name) =>
          host.registered.find((entry) => entry.definition.name === name).definition
        await assert.rejects(
          toolR2('squad_start').execute(
            { goal: 'x', acceptance: 'y', repos: [repoI, repoJ] },
            exec,
          ),
          (error) => /multi-repository creation failed/.test(error.message) && error.message.includes('switch failed'),
        )
        await assertRolledBack(() => currentDir, caller)

        // R3: initialization after a successful creation fails → full cleanup
        // and byte-identical source pointers.
        host = mkHost((_get, set) => async (_agent, directory) => {
          set(_agent, directory)
          if (/squad-t-/.test(directory)) {
            await mkdir(join(directory, '.agent-squad', 'current.json'), { recursive: true })
          }
        })
        apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
        const toolR3 = (name) =>
          host.registered.find((entry) => entry.definition.name === name).definition
        await assert.rejects(
          toolR3('squad_start').execute(
            { goal: 'x', acceptance: 'y', repos: [repoI, repoJ] },
            exec,
          ),
          (error) => /multi-repository creation failed/.test(error.message) && /EISDIR/.test(error.message),
        )
        await assertRolledBack(() => currentDir, caller)

        // R4: even the cwd restore fails — fatal rollback error, but the Git
        // cleanup still runs.
        host = mkHost(() => async () => {
          throw new Error('unavailable')
        })
        apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
        const toolR4 = (name) =>
          host.registered.find((entry) => entry.definition.name === name).definition
        await assert.rejects(
          toolR4('squad_start').execute(
            { goal: 'x', acceptance: 'y', repos: [repoI, repoJ] },
            exec,
          ),
          (error) =>
            error.fatal === true &&
            /multi-repository creation failed/.test(error.message) &&
            /multi-repository rollback failed: cwd: unavailable/.test(error.message),
        )
        assert.deepEqual(await gitSnapshot(repoI), snapshotI)
        assert.deepEqual(await gitSnapshot(repoJ), snapshotJ)

        // D01: file snapshots and directory ownership are independent.
        for (const variant of ['current.json', '.gitignore', 'absent', 'existing-empty']) {
          for (const source of [repoI, caller]) {
            const memory = join(source, '.agent-squad')
            await rm(memory, { recursive: true, force: true })
            if (variant !== 'absent') await mkdir(memory)
            if (variant === 'current.json' || variant === '.gitignore') {
              await writeFile(join(memory, variant), Buffer.from([0x23, 0x20, 0xff, 0x0d, 0x0a, 0x00]))
            }
          }
          currentDir = caller
          host = mkHost((_get, set) => async (_agent, directory) => {
            set(_agent, directory)
            if (/squad-t-/.test(directory)) {
              await mkdir(join(directory, '.agent-squad', 'current.json'), { recursive: true })
            }
          })
          apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
          await assert.rejects(tool('squad_start').execute({ goal: 'D01', acceptance: 'ok', repos: [repoI, repoJ] }, exec),
            /multi-repository creation failed:.*EISDIR/, `D01: ${variant}`)
          assert.deepEqual(await gitSnapshot(repoI), snapshotI)
          assert.deepEqual(await gitSnapshot(repoJ), snapshotJ)
          assert.equal(currentDir, caller)
          for (const source of [repoI, caller]) {
            const memory = join(source, '.agent-squad')
            if (variant === 'absent') {
              await assert.rejects(stat(memory), { code: 'ENOENT' }, 'D01: new empty directory removed')
            } else {
              assert.deepEqual(await readdir(memory), variant === 'existing-empty' ? [] : [variant], 'D01: existing directory preserved')
              if (variant !== 'existing-empty') {
                assert.deepEqual(await readFile(join(memory, variant)), Buffer.from([0x23, 0x20, 0xff, 0x0d, 0x0a, 0x00]), 'D01: exact Buffer restored')
              }
            }
          }
        }

        // D07/D08: observe publication and inject source plus Git/cwd failures.
        const fsp = (await import('node:fs/promises')).default
        const { syncBuiltinESMExports } = await import('node:module')
        const originalWrite = fsp.writeFile
        for (const mode of ['publish-order', 'restore-only', 'restore-and-git']) {
          const oldBytes = Buffer.from('  {"taskId":"old-task"}\r\n')
          for (const source of [repoI, caller]) {
            await mkdir(join(source, '.agent-squad'), { recursive: true })
            await writeFile(join(source, '.agent-squad', 'current.json'), oldBytes)
            await writeFile(join(source, '.agent-squad', '.gitignore'), '*\n')
          }
          currentDir = caller
          let failedRoot
          let restoring = false
          const publications = []
          host = mkHost((_get, set) => async (_agent, directory) => {
            if (directory === caller && mode === 'restore-and-git') throw new Error('injected cwd restore failure')
            set(_agent, directory)
            if (directory !== caller) failedRoot = directory
          })
          apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
          fsp.writeFile = async (path, ...args) => {
            if (String(path).endsWith('/STATE.json') && mode !== 'publish-order') {
              restoring = true
              if (mode === 'restore-and-git') process.env.ASQ_T09_REMOVE_FAIL = '1'
              throw new Error('injected init failure')
            }
            if (path === join(caller, '.agent-squad', 'current.json') && restoring && mode !== 'publish-order') {
              throw new Error('injected source restore failure')
            }
            if (!restoring && [repoI, caller].some((source) => path === join(source, '.agent-squad', 'current.json'))) {
              const taskId = JSON.parse(args[0]).taskId
              const taskDir = join(failedRoot, '.agent-squad', taskId)
              publications.push(await Promise.all(['TASK.md', 'JOURNAL.md', 'STATE.json'].map((file) =>
                stat(join(taskDir, file)).then((info) => info.isFile(), () => false))))
            }
            if (mode === 'publish-order' && path === join(failedRoot, '.agent-squad', 'current.json')) {
              restoring = true
              throw new Error('injected publish failure')
            }
            return originalWrite(path, ...args)
          }
          syncBuiltinESMExports()
          let failure
          try {
            await tool('squad_start').execute({ goal: mode, acceptance: 'ok', repos: [repoI, repoJ] }, exec)
          } catch (error) {
            failure = error
          } finally {
            fsp.writeFile = originalWrite
            syncBuiltinESMExports()
            delete process.env.ASQ_T09_REMOVE_FAIL
          }
          assert.ok(failure, `D07/D08: ${mode} must fail`)
          if (mode === 'publish-order') {
            assert.match(failure.message, /injected publish failure/)
            assert.deepEqual(publications, [[true, true, true], [true, true, true]], 'D08: task files complete before each source publication')
          } else {
            assert.equal(failure.fatal, true, 'D07: source restoration failure is fatal')
            assert.match(failure.message, /^multi-repository creation failed: injected init failure; multi-repository rollback failed: /)
            assert.ok(failure.message.includes(`${caller}: injected source restore failure`), 'D07: actual source named')
            assert.ok(!failure.message.includes(`${repoI}: injected source restore failure`), 'D07: no wrong attribution')
            assert.deepEqual(publications, [], 'D08: no publication after failed STATE write')
            if (mode === 'restore-and-git') {
              assert.ok(failure.message.includes('cwd: injected cwd restore failure'), 'D07: cwd detail retained')
              assert.ok(failure.message.includes(`${repoJ}: `) && failure.message.includes('injected remove failure'), 'D07: Git detail retained')
              assert.equal(await gitOut(repoJ, ['branch', '--list', `squad-${failedRoot.split('squad-').at(-1)}`]) !== '', true)
            }
          }
          assert.deepEqual(await gitSnapshot(repoI), snapshotI, 'D07: other repo cleaned despite restore failure')
          for (const source of [repoI, caller]) {
            assert.deepEqual(await readFile(join(source, '.agent-squad', 'current.json')), oldBytes)
          }
          await cleanupSquadArtifacts([repoI, repoJ])
          await rm(failedRoot, { recursive: true, force: true })
          assert.deepEqual(await gitSnapshot(repoJ), snapshotJ)
        }
      } finally {
        process.env.PATH = pathBefore
        delete process.env.ASQ_T09_INJECT
        delete process.env.ASQ_T09_REMOVE_FAIL
        await rm(wrapperDir, { recursive: true, force: true })
        await cleanupSquadArtifacts([repoI, repoJ])
      }
    })

    // --- finish (PLAN §34; live-qoder §36 via ASQ_LIVE_QODER) ----------------
    await labeled('finish', async () => {
      const caller = join(root, 's4-caller')
      await mkdir(caller, { recursive: true })
      const repoK = await makeGitRepo(root, 's4-k/repo-k', 'base A', { 'hello.txt': 'before\n' })
      const repoL = await makeGitRepo(root, 's4-l/repo-l', 'base B', { 'hello.txt': 'before\n' })
      const live = process.env.ASQ_LIVE_QODER === '1'
      const stubDir = await mkdtemp(join(tmpdir(), 'asq-qoder-hello-'))
      const stubPath = join(stubDir, 'qoder-hello.cjs')
      await writeFile(
        stubPath,
        [
          '#!/usr/bin/env node',
          "const fs = require('node:fs')",
          "const path = require('node:path')",
          'const cwd = process.cwd()',
          'const slugs = fs.readdirSync(cwd, { withFileTypes: true })',
          "  .filter((entry) => entry.isDirectory() && /^\\d+-/.test(entry.name))",
          '  .map((entry) => entry.name)',
          '  .sort()',
          "fs.writeFileSync(path.join(cwd, slugs[0], 'hello.txt'), 'A\\n')",
          "fs.writeFileSync(path.join(cwd, slugs[1], 'hello.txt'), 'B\\n')",
          "process.stdout.write('two repos updated')",
          '',
        ].join('\n'),
        'utf8',
      )
      await chmod(stubPath, 0o755)
      await writeSquadSettings(dshHome, 'external')
      let currentDir = caller
      const cwdService = { get: () => currentDir, set: async (_a, d) => { currentDir = d } }
      const host = mockHost(caller, dshHome, {}, { workingDirectory: cwdService })
      const { apply } = await import('../index.js')
      apply(host.ctx, { workerProbe: false,
        agents: BUNDLE_AGENTS,
        qoderCommand: live ? (process.env.ASQ_QODER_COMMAND || 'qoderclicn') : stubPath,
      })
      const tool = (name) =>
        host.registered.find((entry) => entry.definition.name === name).definition
      const lead = { id: 'lead-1', session: { id: 'session-1' } }
      const baseA = await gitOut(repoK, ['rev-parse', 'HEAD'])
      const baseB = await gitOut(repoL, ['rev-parse', 'HEAD'])
      try {
        // Main flow: one qoder dispatch edits both hello.txt files.
        const startOutput = await tool('squad_start').execute(
          { goal: 'two repos', acceptance: 'ok', agents: ['qoder'], repos: [repoK, repoL] },
          { agent: lead, signal: undefined },
        )
        const taskId = /任务 (t-\S+) 已创建/.exec(startOutput)[1]
        const branch = `squad-${taskId}`
        const taskRoot = join(repoK, '.agents', 'worktrees', `squad-${taskId}`)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 300000)
        try {
          await tool('squad_dispatch').execute(
            {
              agent: 'qoder',
              message: '只把任务根下两个 worktree 里的 hello.txt 分别改为 A\\n（1-repo-k）与 B\\n（2-repo-l）；不要提交，不要改其他文件。',
              phase: 'implement',
              background: false, // this test asserts the files right after the run
            },
            { agent: lead, signal: controller.signal },
          )
        } finally {
          clearTimeout(timer)
        }
        assert.equal(await readFile(join(taskRoot, '1-repo-k', 'hello.txt'), 'utf8'), 'A\n')
        assert.equal(await readFile(join(taskRoot, '2-repo-l', 'hello.txt'), 'utf8'), 'B\n')
        assert.equal(host.runIds.length, 1)
        const finishOut = await tool('squad_finish').execute(
          { summary: 'two repos' },
          { agent: lead, signal: undefined },
        )
        assert.equal(await gitOut(repoK, ['rev-list', '--count', `${baseA}..${branch}`]), '1')
        assert.equal(await gitOut(repoL, ['rev-list', '--count', `${baseB}..${branch}`]), '1')
        assert.equal(await gitOut(repoK, ['log', '-1', '--format=%s', branch]), `squad(${taskId}): two repos`)
        assert.equal(await gitOut(repoL, ['log', '-1', '--format=%s', branch]), `squad(${taskId}): two repos`)
        assert.equal(await gitOut(repoK, ['rev-parse', 'HEAD']), baseA)
        assert.equal(await readFile(join(repoK, 'hello.txt'), 'utf8'), 'before\n')
        const state = JSON.parse(
          await readFile(join(taskRoot, '.agent-squad', taskId, 'STATE.json'), 'utf8'),
        )
        assert.deepEqual(
          state.commits.map((row) => [row.repo, row.status, row.commit === null]),
          [[repoK, 'committed', false], [repoL, 'committed', false]],
        )
        assert.equal(state.phase, 'done')
        assert.equal(state.commit, state.commits[0].commit)
        assert.equal(currentDir, repoK)
        const finalMd = await readFile(join(taskRoot, '.agent-squad', taskId, 'FINAL.md'), 'utf8')
        for (const text of [finishOut, finalMd]) {
          assert.ok(text.includes(`git -C '${repoK}' merge --no-ff '${branch}'`), 'quoted merge command missing')
          assert.ok(text.includes(`git -C '${repoL}' merge --no-ff '${branch}'`))
        }
        if (live) {
          console.log(
            `AC7 task=${taskId} cwd=${taskRoot} repo=${repoK} commit=${state.commits[0].commit} repo=${repoL} commit=${state.commits[1].commit}`,
          )
        }

        // Dirty + clean → committed / no-change.
        const startMixed = await tool('squad_start').execute(
          { goal: 'mixed', acceptance: 'ok', agents: ['qoder'], repos: [repoK, repoL] },
          { agent: lead, signal: undefined },
        )
        const taskMixed = /任务 (t-\S+) 已创建/.exec(startMixed)[1]
        const rootMixed = join(repoK, '.agents', 'worktrees', `squad-${taskMixed}`)
        await writeFile(join(rootMixed, '2-repo-l', 'hello.txt'), 'C\n', 'utf8')
        await tool('squad_finish').execute({ summary: 'mixed' }, { agent: lead, signal: undefined })
        const stateMixed = JSON.parse(
          await readFile(join(rootMixed, '.agent-squad', taskMixed, 'STATE.json'), 'utf8'),
        )
        assert.deepEqual(
          stateMixed.commits.map((row) => row.status),
          ['no-change', 'committed'],
        )
        assert.equal(stateMixed.phase, 'done')

        // autoCommit=false → both rows skipped, no new commits.
        const hostAC = mockHost(caller, dshHome, {}, { workingDirectory: cwdService })
        apply(hostAC.ctx, { workerProbe: false, agents: BUNDLE_AGENTS, qoderCommand: stubPath, worktreeAutoCommit: false })
        const toolAC = (name) =>
          hostAC.registered.find((entry) => entry.definition.name === name).definition
        const startAC = await toolAC('squad_start').execute(
          { goal: 'no commit', acceptance: 'ok', agents: ['qoder'], repos: [repoK, repoL] },
          { agent: lead, signal: undefined },
        )
        const taskAC = /任务 (t-\S+) 已创建/.exec(startAC)[1]
        const rootAC = join(repoK, '.agents', 'worktrees', `squad-${taskAC}`)
        const branchAC = `squad-${taskAC}`
        await writeFile(join(rootAC, '1-repo-k', 'hello.txt'), 'D\n', 'utf8')
        await writeFile(join(rootAC, '2-repo-l', 'hello.txt'), 'E\n', 'utf8')
        await toolAC('squad_finish').execute({ summary: 'skipped' }, { agent: lead, signal: undefined })
        const stateAC = JSON.parse(
          await readFile(join(rootAC, '.agent-squad', taskAC, 'STATE.json'), 'utf8'),
        )
        assert.deepEqual(stateAC.commits.map((row) => row.status), ['skipped', 'skipped'])
        assert.equal(await gitOut(repoK, ['rev-list', '--count', `HEAD..${branchAC}`]), '0')
        assert.equal(await gitOut(repoL, ['rev-list', '--count', `HEAD..${branchAC}`]), '0')

        // Pre-commit rejection in the second repo: first commits, second
        // errors, the task stays open, cwd is restored; retry completes.
        const hookPath = join(repoL, '.git', 'hooks', 'pre-commit')
        await writeFile(hookPath, '#!/bin/sh\nexit 1\n', 'utf8')
        await chmod(hookPath, 0o755)
        const startHook = await tool('squad_start').execute(
          { goal: 'hook', acceptance: 'ok', agents: ['qoder'], repos: [repoK, repoL] },
          { agent: lead, signal: undefined },
        )
        const taskHook = /任务 (t-\S+) 已创建/.exec(startHook)[1]
        const rootHook = join(repoK, '.agents', 'worktrees', `squad-${taskHook}`)
        const branchHook = `squad-${taskHook}`
        await writeFile(join(rootHook, '1-repo-k', 'hello.txt'), 'F\n', 'utf8')
        await writeFile(join(rootHook, '2-repo-l', 'hello.txt'), 'G\n', 'utf8')
        await assert.rejects(
          tool('squad_finish').execute({ summary: 'hook' }, { agent: lead, signal: undefined }),
          (error) => /multi-repository finish failed/.test(error.message) && error.message.includes(repoL),
        )
        let stateHook = JSON.parse(
          await readFile(join(rootHook, '.agent-squad', taskHook, 'STATE.json'), 'utf8'),
        )
        assert.deepEqual(
          stateHook.commits.map((row) => row.status),
          ['committed', 'error'],
        )
        assert.notEqual(stateHook.phase, 'done')
        assert.equal(currentDir, repoK)
        assert.equal(await gitOut(repoK, ['rev-list', '--count', `HEAD..${branchHook}`]), '1')
        await rm(hookPath, { force: true })
        await tool('squad_finish').execute({ summary: 'hook retry' }, { agent: lead, signal: undefined })
        stateHook = JSON.parse(
          await readFile(join(rootHook, '.agent-squad', taskHook, 'STATE.json'), 'utf8'),
        )
        assert.deepEqual(
          stateHook.commits.map((row) => row.status),
          ['no-change', 'committed'],
        )
        assert.equal(stateHook.phase, 'done')

        // D03/D04: every Git stage and both cwd failure modes keep the task open.
        const realGit = (await run('which', ['git'])).stdout.trim()
        const finishBin = join(stubDir, 'bin')
        await mkdir(finishBin)
        for (const mode of ['status', 'commit', 'head', 'diff', 'cwd-missing', 'cwd-throws']) {
          currentDir = caller
          const service = { get: () => currentDir, set: async (_a, directory) => { currentDir = directory } }
          const failureHost = mockHost(caller, dshHome, {}, { workingDirectory: service })
          apply(failureHost.ctx, { workerProbe: false, agents: BUNDLE_AGENTS, worktreeAutoCommit: mode !== 'status' })
          const failureTool = (name) => failureHost.registered.find((entry) => entry.definition.name === name).definition
          const started = await failureTool('squad_start').execute(
            { goal: mode, acceptance: 'ok', agents: ['qoder'], repos: [repoK, repoL] },
            { agent: lead, signal: undefined },
          )
          const id = /任务 (t-\S+) 已创建/.exec(started)[1]
          const workspace = currentDir
          const taskDir = join(workspace, '.agent-squad', id)
          const statePath = join(taskDir, 'STATE.json')
          const before = JSON.parse(await readFile(statePath, 'utf8'))
          before.phase = 'review'
          before.closedAt = 'unchanged-closedAt'
          before.verdict = 'changes_requested'
          await writeFile(statePath, JSON.stringify(before))
          const [first, second] = before.worktrees
          if (mode === 'commit') await writeFile(join(first.path, 'hello.txt'), 'first dirty\n')
          await writeFile(join(second.path, 'hello.txt'), 'second dirty\n')
          const callsPath = join(stubDir, `git-${mode}.jsonl`)
          await writeFile(join(finishBin, 'git'), [
            '#!/usr/bin/env node',
            "const { spawnSync } = require('node:child_process')",
            "const { appendFileSync } = require('node:fs')",
            'const args = process.argv.slice(2)',
            `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')`,
            `const mode = ${JSON.stringify(mode)}`,
            `if (args[1] === ${JSON.stringify(first.path)} && (args[2] === mode || (mode === 'head' && args[2] === 'rev-parse' && args[3] === '--short'))) {`,
            "  process.stderr.write('injected ' + mode + ' failure\\n'); process.exit(73)",
            '}',
            `const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })`,
            'process.exit(result.status ?? 1)',
            '',
          ].join('\n'))
          await chmod(join(finishBin, 'git'), 0o755)
          if (mode === 'cwd-missing') {
            const originalGet = failureHost.ctx.get
            failureHost.ctx.get = (name) => name === 'workingDirectory' ? { get: service.get } : originalGet(name)
          }
          if (mode === 'cwd-throws') service.set = async () => { throw new Error('injected finish cwd failure') }
          const originalPath = process.env.PATH
          process.env.PATH = `${finishBin}:${originalPath}`
          let failure
          try {
            await failureTool('squad_finish').execute({ summary: mode }, { agent: lead, signal: undefined })
          } catch (error) {
            failure = error
          } finally {
            process.env.PATH = originalPath
          }
          assert.ok(failure, `D03/D04: ${mode} must reject`)
          assert.match(failure.message, /^multi-repository finish failed: /)
          const after = JSON.parse(await readFile(statePath, 'utf8'))
          for (const field of ['phase', 'closedAt', 'verdict']) {
            assert.equal(after[field], before[field], `D03/D04: ${mode} preserves ${field}`)
          }
          assert.equal(after.commits.length, 2)
          const final = await readFile(join(taskDir, 'FINAL.md'), 'utf8')
          assert.ok(final.includes(second.repo) && final.includes(after.commits[1].commit), 'D03/D04: FINAL persisted for both repos')
          const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
          for (const wt of [first, second]) {
            assert.equal(calls.find((args) => args[1] === wt.path)?.[2], 'status', `D03: ${mode} status runs first in each repo`)
          }
          if (mode.startsWith('cwd-')) {
            assert.deepEqual(after.commits.map((row) => row.status), ['no-change', 'committed'])
            const message = mode === 'cwd-missing'
              ? 'workingDirectory service is unavailable; cannot enter the squad worktree'
              : 'injected finish cwd failure'
            assert.equal(failure.message, `multi-repository finish failed: cwd: ${message}`, 'D04: cwd failure aggregated')
            assert.equal(currentDir, workspace)
          } else {
            assert.deepEqual(after.commits.map((row) => row.status), ['error', mode === 'status' ? 'skipped' : 'committed'], 'D03: continue after first repo error')
            assert.ok(after.commits[0].error.includes(`injected ${mode} failure`))
            assert.equal(after.commits[1].error, null)
            assert.equal(after.commits[0].commit, mode === 'head' ? null : await gitOut(first.path, ['rev-parse', '--short', 'HEAD']))
            assert.ok(final.includes(`injected ${mode} failure`), 'D03: FINAL retains error')
            assert.equal(currentDir, repoK, 'D03: cwd restored after failure')
          }
        }
      } finally {
        await rm(stubDir, { recursive: true, force: true })
        await cleanupSquadArtifacts([repoK, repoL])
      }
    })

    // --- single-and-legacy (PLAN §35) ----------------------------------------
    await labeled('single-and-legacy', async () => {
      const caller = join(root, 's5-caller')
      await mkdir(caller, { recursive: true })
      const repoM = await makeGitRepo(root, 's5-m', 'base M', { 'README.md': 'seed M\n' })
      const repoN = await makeGitRepo(root, 's5-n', 'base N', { 'README.md': 'seed N\n' })
      const notRepo = join(caller, 'not-repo')
      await mkdir(notRepo, { recursive: true })
      await writeSquadSettings(dshHome)
      let currentDir = caller
      const cwdService = { get: () => currentDir, set: async (_a, d) => { currentDir = d } }
      const host = mockHost(caller, dshHome, {}, { workingDirectory: cwdService })
      const { apply } = await import('../index.js')
      apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
      const tool = (name) =>
        host.registered.find((entry) => entry.definition.name === name).definition
      const lead = { id: 'lead-1', session: { id: 'session-1' } }
      const exec = { agent: lead, signal: undefined }

      // Explicit single repository: no slug layer, cwd = worktree, memory
      // inside the worktree.
      const startSingle = await tool('squad_start').execute(
        { goal: 'single', acceptance: 'ok', agents: ['qoder'], repos: [repoM] },
        exec,
      )
      const singleId = /任务 (t-\S+) 已创建/.exec(startSingle)[1]
      const singleRoot = join(repoM, '.agents', 'worktrees', `squad-${singleId}`)
      let singleState = JSON.parse(
        await readFile(join(singleRoot, '.agent-squad', singleId, 'STATE.json'), 'utf8'),
      )
      assert.equal(singleState.taskRoot, singleRoot)
      assert.equal(singleState.worktree.path, singleRoot)
      assert.equal(singleState.worktrees.length, 1)
      assert.equal(singleState.worktrees[0].repo, repoM)
      assert.equal(currentDir, singleRoot)
      // New budget snapshot fields persist at start (PLAN §6).
      assert.deepEqual(
        [singleState.designLimit, singleState.reworkLimit, singleState.extensions],
        [4, 3, []],
      )
      await stat(join(singleRoot, '.agent-squad', singleId, 'TASK.md'))

      // Omitted repos in a Git directory: identical single-repository layout.
      currentDir = repoN
      const startOmitted = await tool('squad_start').execute(
        { goal: 'omitted', acceptance: 'ok', agents: ['qoder'] },
        exec,
      )
      const omittedId = /任务 (t-\S+) 已创建/.exec(startOmitted)[1]
      const omittedRoot = join(repoN, '.agents', 'worktrees', `squad-${omittedId}`)
      const omittedState = JSON.parse(
        await readFile(join(omittedRoot, '.agent-squad', omittedId, 'STATE.json'), 'utf8'),
      )
      assert.equal(omittedState.taskRoot, omittedRoot)
      assert.equal(omittedState.worktrees.length, 1)
      assert.equal(omittedState.worktrees[0].repo, repoN)
      assert.equal(currentDir, omittedRoot)
      // New budget snapshot fields persist at start (PLAN §6).
      assert.deepEqual(
        [omittedState.designLimit, omittedState.reworkLimit, omittedState.extensions],
        [4, 3, []],
      )

      // Explicit single non-Git input is refused (no in-place degrade).
      await assert.rejects(
        tool('squad_start').execute(
          { goal: 'bad', acceptance: 'ok', repos: [notRepo] },
          exec,
        ),
        { message: `not a usable Git repository: ${notRepo}` },
      )

      // Legacy STATE without worktrees/taskRoot still dispatches and finishes.
      const legacyStatePath = join(omittedRoot, '.agent-squad', omittedId, 'STATE.json')
      const legacyState = JSON.parse(await readFile(legacyStatePath, 'utf8'))
      delete legacyState.worktrees
      delete legacyState.taskRoot
      await writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2), 'utf8')
      const legacyStatus = await tool('squad_status').execute({}, exec)
      assert.ok(legacyStatus.includes(omittedRoot))
      assert.match(
        await tool('squad_dispatch').execute(
          { agent: 'qoder', message: 'legacy implement', phase: 'implement', task_id: omittedId },
          exec,
        ),
        /已创建 qoder/,
      )
      const legacyFinish = await tool('squad_finish').execute(
        { summary: 'legacy' },
        { agent: lead, signal: undefined },
      )
      assert.match(legacyFinish, /收尾/)
      assert.equal(currentDir, repoN)
      singleState = JSON.parse(await readFile(legacyStatePath, 'utf8'))
      assert.equal(singleState.phase, 'done')
      await cleanupSquadArtifacts([repoM, repoN])
    })
  } finally {
    delete process.env.DSH_HOME
    await rm(root, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T10 — budget extension: user-decision gate, squad_extend, dynamic limits (PLAN §29–§37). */
test('T10 budget extension requires user confirmation and resumes exhausted budgets', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  const labeled = async (name, fn) => {
    try {
      await fn()
    } catch (error) {
      error.message = `[${name}] ${error.message}`
      throw error
    }
  }
  try {
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'external', model: 'mock-ext', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'local', model: 'p/m1', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'team', model: '', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )
    const { apply } = await import('../index.js')
    // Mock external brain: writes a fresh PLAN.md for the current task before
    // the activation result resolves, so the dispatch-side archive sees it.
    let writes = 0
    const host = mockHost(workspace, dshHome, {
      onExternal: async () => {
        writes += 1
        const memory = join(workspace, '.agent-squad')
        const pointer = JSON.parse(await readFile(join(memory, 'current.json'), 'utf8'))
        await writeFile(
          join(pointer.memoryRoot ?? memory, pointer.taskId, 'PLAN.md'),
          `# PLAN T10-${writes}\n`,
          'utf8',
        )
      },
    })
    apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const teammate = { id: 'te-1', __membership: { role: 'teammate', name: 'zcode' } }
    const exec = { agent: lead, signal: undefined }
    await tool('squad_enable').execute({}, exec)
    const extend = (args, caller = exec) => tool('squad_extend').execute(args, caller)
    const dispatch = (args) => tool('squad_dispatch').execute(args, exec)
    const design = (message, task_id) =>
      dispatch({ agent: 'codex', message, phase: 'design', ...(task_id ? { task_id } : {}) })
    const rework = (message) => dispatch({ agent: 'zcode', message, phase: 'rework' })
    const startTask = async (goal) => {
      // No architect participant → legacy gates: T10 exercises the single
      // implement quota and the design/implement extension kinds.
      const out = await tool('squad_start').execute(
        { goal, acceptance: 'ok', agents: ['codex', 'zcode', 'qoder'] },
        exec,
      )
      return /任务 (t-\S+) 已创建/.exec(out)[1]
    }
    const readState = async (task) =>
      JSON.parse(await readFile(join(workspace, '.agent-squad', task, 'STATE.json'), 'utf8'))
    const writeState = (task, state) =>
      writeFile(join(workspace, '.agent-squad', task, 'STATE.json'), JSON.stringify(state, null, 2) + '\n', 'utf8')
    const budgetLine = (d, du, i, iu) =>
      `预算：design 上限=${d} 已用=${du} 剩余=${Math.max(0, d - du)}；implement 上限=${i} 已用=${iu} 剩余=${Math.max(0, i - iu)}`
    /** Recursive byte snapshot of one directory (files base64, dirs nested). */
    const snapDir = async (dir) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        return error?.code === 'ENOENT' ? undefined : error.code
      }
      const out = {}
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out[entry.name] = await snapDir(full)
        else if (entry.isFile()) out[entry.name] = (await readFile(full)).toString('base64')
        else out[entry.name] = 'special'
      }
      return out
    }
    /** Full side-effect snapshot: every task file/archive, the shared-root
     * current pointer, executor counters and cwd sets (§21/D3). */
    const snapshot = async (task) => ({
      files: await snapDir(join(workspace, '.agent-squad', task)),
      current: await readFile(join(workspace, '.agent-squad', 'current.json')).catch(
        (error) => error?.code ?? 'missing',
      ),
      activations: host.activations.length,
      sent: host.sent.length,
      spawned: host.spawned.length,
      runs: host.runIds.length,
      cwdSets: host.cwdCalls.filter((call) => call.op === 'set').length,
    })
    /** §21: a rejection leaves every shared file byte-identical and spawns nothing. */
    const noSide = async (task, thunk, expectedMessage) => {
      const before = await snapshot(task)
      await assert.rejects(thunk(), { message: expectedMessage })
      assert.deepEqual(await snapshot(task), before, 'rejection must leave zero side effects')
    }
    /** Root-wide snapshot: the WHOLE shared memory root (every task dir, the
     * current pointer even when it is a directory, t-nope absence) plus the
     * executor counters (D3/E9). */
    const snapshotRoot = async () => ({
      root: await snapDir(join(workspace, '.agent-squad')),
      activations: host.activations.length,
      sent: host.sent.length,
      spawned: host.spawned.length,
      runs: host.runIds.length,
      cwdSets: host.cwdCalls.filter((call) => call.op === 'set').length,
    })
    /** §16/D3: a successful extend changes ONLY the target STATE's three
     * budget fields (and nothing else on disk or in the executors). */
    const extendOnly = async (task, args) => {
      const before = await snapshot(task)
      const statePath = join(workspace, '.agent-squad', task, 'STATE.json')
      const stateBefore = JSON.parse(await readFile(statePath, 'utf8'))
      const out = await extend(args)
      const after = await snapshot(task)
      const { files, ...afterRest } = after
      const { files: filesBefore, ...beforeRest } = before
      assert.deepEqual(afterRest, beforeRest, 'extend must not touch executors or current')
      assert.deepEqual(Object.keys(files).sort(), Object.keys(filesBefore).sort())
      for (const name of Object.keys(files)) {
        if (name === 'STATE.json') continue
        assert.deepEqual(files[name], filesBefore[name], `extend must not touch ${name}`)
      }
      const stateAfter = JSON.parse(await readFile(statePath, 'utf8'))
      const strip = ({ designLimit, reworkLimit, extensions, ...rest }) => rest
      assert.deepEqual(strip(stateAfter), strip(stateBefore), 'only the three budget fields may change')
      return out
    }
    const designPause = (limit, used) =>
      `设计预算已用完：已到上限 ${limit} 次 design 派单（已用 ${used}）。先向用户说明阻塞点与已完成部分并等待决策；用户同意后调用 squad_extend(kind="design", confirmed=true, reason="用户批准的追加理由") 追加轮次，再派 design；用户拒绝或未回复时保持暂停，不得自动续跑。`
    const reworkPause = (limit, used) =>
      `返工已达上限 ${limit} 轮（已用 ${used}）。先向用户说明阻塞点与已完成部分并等待决策；用户同意后调用 squad_extend(kind="implement", confirmed=true, reason="用户批准的追加理由") 追加轮次，再派 rework；用户拒绝或未回复时保持暂停，不得自动续跑。`

    // --- T10/schema (PLAN §30) -----------------------------------------------
    await labeled('schema', async () => {
      const extendDef = tool('squad_extend')
      assert.equal(extendDef.name, 'squad_extend')
      assert.deepEqual(extendDef.parameters, {
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
      })
      assert.deepEqual(extendDef.output.schema, { type: 'string' })
      assert.deepEqual(extendDef.output.render({}, 'x'), [{ type: 'text', text: 'x' }])
      const entry = host.registered.find((row) => row.definition.name === 'squad_extend')
      assert.equal(entry.when({ agent: lead }), true)
      assert.equal(entry.when({ agent: teammate }), false)
      assert.equal(entry.when({ agent: { id: 'anon' } }), false)
      assert.deepEqual(
        host.registered.map((row) => row.definition.name).sort(),
        [
          'squad_approve_plan', 'squad_deliver', 'squad_dispatch', 'squad_enable', 'squad_extend', 'squad_failover',
          'squad_finish', 'squad_parallel_start', 'squad_report', 'squad_start', 'squad_status', 'squad_wait',
        ],
      )
    })

    // --- T10/reject (PLAN §31): E1–E10, first-error-wins, zero side effects ---
    await labeled('reject', async () => {
      const good = { kind: 'design', reason: '用户同意', confirmed: true }
      const task = await startTask('reject-main')
      // E1: no calling agent.
      await noSide(task, () => extend({ ...good }, {}), 'squad_extend requires a calling agent')
      // E2: teammate, no membership, and a membership service that throws.
      await noSide(
        task,
        () => extend({ ...good }, { agent: teammate, signal: undefined }),
        'squad_extend 仅允许 Lead 调用。',
      )
      await noSide(
        task,
        () => extend({ ...good }, { agent: { id: 'anon', session: { id: 's' } }, signal: undefined }),
        'squad_extend 仅允许 Lead 调用。',
      )
      {
        const originalRootOf = host.subagents.rootOf
        host.subagents.rootOf = () => {
          throw new Error('membership exploded')
        }
        try {
          await noSide(task, () => extend({ ...good }), 'squad_extend 仅允许 Lead 调用。')
        } finally {
          host.subagents.rootOf = originalRootOf
        }
      }
      // E3: kind missing / invalid.
      for (const kind of [undefined, 'review']) {
        await noSide(task, () => extend({ ...good, kind }), 'kind 必须是 design、tech、business 或 implement。')
      }
      // E4: rounds must be a positive safe integer.
      for (const rounds of [0, -1, 1.5, '3', null, NaN, Infinity, 9007199254740992]) {
        await noSide(task, () => extend({ ...good, rounds }), 'rounds 必须是正的安全整数。')
      }
      // E5: reason must be a non-empty string.
      for (const reason of [undefined, '', ' \n ', 7]) {
        await noSide(task, () => extend({ ...good, reason }), 'reason 必须是非空字符串。')
      }
      // E6: confirmed must be exactly true.
      for (const confirmed of [undefined, false, 'true', 1, null]) {
        await noSide(
          task,
          () => extend({ ...good, confirmed }),
          '必须先获得用户明确同意，并传入 confirmed=true 才能追加轮次。',
        )
      }
      // E7: an explicit task_id must be a non-empty string.
      for (const task_id of ['', ' ', 7, null]) {
        await noSide(task, () => extend({ ...good, task_id }), 'task_id 必须是非空字符串。')
      }
      // E9: unknown task id — the snapshot covers the WHOLE shared memory
      // root, so a stray `t-nope` directory (or any other mutation) would
      // fail the comparison, alongside the task/current/executor checks.
      {
        const rootBefore = await snapshotRoot()
        assert.equal(rootBefore.root['t-nope'], undefined, 't-nope must not exist beforehand')
        await assert.rejects(extend({ ...good, task_id: 't-nope' }), {
          message: '未知小队任务 "t-nope"。先调用 squad_start。',
        })
        assert.deepEqual(await snapshotRoot(), rootBefore, 'E9 must leave the whole root untouched')
      }
      // E10: a finished task; the rejection leaves the DONE task untouched.
      const doneStart = await tool('squad_start').execute(
        { goal: 'done task', acceptance: 'ok', agents: ['zcode', 'qoder'] },
        exec,
      )
      const doneTask = /任务 (t-\S+) 已创建/.exec(doneStart)[1]
      await tool('squad_finish').execute({ summary: 'closed', task_id: doneTask }, exec)
      assert.equal((await readState(doneTask)).phase, 'done')
      await noSide(
        doneTask,
        () => extend({ ...good, task_id: doneTask }),
        `任务 ${doneTask} 已经收尾，不能追加轮次。`,
      )
      // E8: no current pointer — snapshot AFTER the deletion, compare while
      // it is still missing (ENOENT), and restore only in finally.
      {
        const currentPath = join(workspace, '.agent-squad', 'current.json')
        const bytes = await readFile(currentPath)
        const before = await snapshot(task)
        try {
          await rm(currentPath)
          const during = await snapshot(task)
          assert.equal(during.current, 'ENOENT', 'pointer must be missing for the call')
          await assert.rejects(extend({ ...good }), {
            message: '还没有小队任务。先调用 squad_start。',
          })
          const after = await snapshot(task)
          assert.equal(after.current, 'ENOENT', 'pointer must still be missing right after the call')
          assert.deepEqual(after, during, 'rejection must not touch the missing-pointer state')
        } finally {
          await writeFile(currentPath, bytes)
        }
        assert.deepEqual(await snapshot(task), before, 'restore returns the pointer byte-for-byte')
      }
      // First-error-wins combos, each with zero side effects.
      await noSide(
        task,
        () => extend({ kind: 'review', rounds: 0, reason: '', confirmed: false }, { agent: teammate, signal: undefined }),
        'squad_extend 仅允许 Lead 调用。',
      )
      await noSide(
        task,
        () => extend({ kind: 'review', rounds: 0, reason: '', confirmed: false }),
        'kind 必须是 design、tech、business 或 implement。',
      )
      await noSide(
        task,
        () => extend({ kind: 'design', rounds: 0, reason: '', confirmed: false }),
        'rounds 必须是正的安全整数。',
      )
      await noSide(
        task,
        () => extend({ kind: 'design', rounds: 1, reason: '', confirmed: false }),
        'reason 必须是非空字符串。',
      )
      await noSide(
        task,
        () => extend({ kind: 'design', rounds: 1, reason: 'ok', confirmed: false, task_id: '' }),
        '必须先获得用户明确同意，并传入 confirmed=true 才能追加轮次。',
      )
      // D1: non-ENOENT I/O errors propagate verbatim. STATE.json as a
      // directory must surface the native EISDIR code/message, never
      // "unknown task". Snapshot after the fixture is in place, compare
      // BEFORE cleanup, and restore only in finally.
      {
        const statePath = join(workspace, '.agent-squad', task, 'STATE.json')
        const bytes = await readFile(statePath)
        const before = await snapshot(task)
        try {
          await rm(statePath)
          await mkdir(statePath)
          // Expected error captured with the native reader while the fixture
          // is in place, so code AND full message are compared verbatim.
          let native
          try {
            await readFile(statePath)
            assert.fail('readFile on a directory must throw')
          } catch (error) {
            native = error
          }
          assert.equal(native.code, 'EISDIR')
          const during = await snapshot(task)
          let failure
          try {
            await extend({ ...good, task_id: task })
            assert.fail('squad_extend must propagate the I/O error')
          } catch (error) {
            failure = error
          }
          assert.equal(failure.code, native.code, 'original code preserved')
          assert.equal(failure.message, native.message, 'original message preserved')
          assert.deepEqual(await snapshot(task), during, 'rejection leaves the fixture untouched')
        } finally {
          await rm(statePath, { recursive: true, force: true })
          await writeFile(statePath, bytes)
        }
        assert.deepEqual(await snapshot(task), before, 'STATE.json restored byte-for-byte')
      }
      // D1: a directory squatting on the shared-root current pointer also
      // propagates EISDIR. The root snapshot covers the directory's own
      // contents, not just its existence.
      {
        const currentPath = join(workspace, '.agent-squad', 'current.json')
        const bytes = await readFile(currentPath)
        try {
          await rm(currentPath)
          await mkdir(currentPath)
          await writeFile(join(currentPath, 'stray.txt'), 'not a pointer\n', 'utf8')
          const expectStray = Buffer.from('not a pointer\n').toString('base64')
          let native
          try {
            await readFile(currentPath)
            assert.fail('readFile on a directory must throw')
          } catch (error) {
            native = error
          }
          assert.equal(native.code, 'EISDIR')
          const during = await snapshotRoot()
          assert.deepEqual(during.root['current.json'], { 'stray.txt': expectStray },
            'snapshot must see inside the directory fixture')
          let failure
          try {
            await extend({ ...good })
            assert.fail('squad_extend must propagate the I/O error')
          } catch (error) {
            failure = error
          }
          assert.equal(failure.code, native.code, 'original code preserved')
          assert.equal(failure.message, native.message, 'original message preserved')
          assert.deepEqual(await snapshotRoot(), during, 'rejection leaves the fixture untouched')
        } finally {
          await rm(currentPath, { recursive: true, force: true })
          await writeFile(currentPath, bytes)
        }
        const restored = await snapshotRoot()
        assert.equal(typeof restored.root['current.json'], 'string', 'pointer file restored')
      }
    })

    // --- T10/reject-budget (PLAN §32): E11/E12 on a not-yet-exhausted task ---
    await labeled('reject-budget', async () => {
      const task = await startTask('reject-budget')
      await design('d1')
      await design('d2')
      await design('d3')
      // design 3/4 is not exhausted → E11 with the exact used/limit.
      await noSide(
        task,
        () => extend({ kind: 'design', reason: '用户同意', confirmed: true }),
        `任务 ${task} 的 design 预算尚未到上限（已用 3/4），不能追加轮次。`,
      )
      await design('d4')
      await tool('squad_approve_plan').execute({ task_id: task }, exec)
      await dispatch({ agent: 'zcode', message: 'impl', phase: 'implement' })
      await rework('rw1')
      await rework('rw2')
      // design 4/4 is exhausted; implement 2/3 is not → E11 for implement.
      await noSide(
        task,
        () => extend({ kind: 'implement', reason: '用户同意', confirmed: true }),
        `任务 ${task} 的 implement 预算尚未到上限（已用 2/3），不能追加轮次。`,
      )
      // Exhaust implement too (3/3), then E12 overflow for both kinds.
      await rework('rw3')
      await noSide(
        task,
        () => extend({ kind: 'design', rounds: 9007199254740991, reason: '用户同意', confirmed: true }),
        '追加后的预算上限超出安全整数范围。',
      )
      await noSide(
        task,
        () => extend({ kind: 'implement', rounds: 9007199254740991, reason: '用户同意', confirmed: true }),
        '追加后的预算上限超出安全整数范围。',
      )
      // Missing confirmation always refuses, even at the limit.
      await noSide(
        task,
        () => extend({ kind: 'design', reason: '用户同意' }),
        '必须先获得用户明确同意，并传入 confirmed=true 才能追加轮次。',
      )
      await noSide(
        task,
        () => extend({ kind: 'design', rounds: 9007199254740991, reason: '用户同意', confirmed: true }),
        '追加后的预算上限超出安全整数范围。',
      )
      await noSide(
        task,
        () => extend({ kind: 'implement', rounds: 9007199254740991, reason: '用户同意', confirmed: true }),
        '追加后的预算上限超出安全整数范围。',
      )
      // Missing confirmation always refuses, even at the limit.
      await noSide(
        task,
        () => extend({ kind: 'design', reason: '用户同意' }),
        '必须先获得用户明确同意，并传入 confirmed=true 才能追加轮次。',
      )
      // A boundary rounds=1 extension succeeds (4→5)…
      const out = await extendOnly(task, { kind: 'design', rounds: 1, reason: '用户同意', confirmed: true })
      assert.equal(
        out,
        `任务 ${task} 的 design 预算已扩展：上限 4 → 5，已用 4，剩余 1（追加 1 轮）。\n原因：用户同意`,
      )
      // …and an immediate repeat is E11 again (4/5), plus a missing-confirmed E6.
      await noSide(
        task,
        () => extend({ kind: 'design', reason: '用户同意', confirmed: true }),
        `任务 ${task} 的 design 预算尚未到上限（已用 4/5），不能追加轮次。`,
      )
      await noSide(
        task,
        () => extend({ kind: 'implement', reason: '用户同意' }),
        '必须先获得用户明确同意，并传入 confirmed=true 才能追加轮次。',
      )
    })

    // --- T10/design (PLAN §33): default +3 resumes an exhausted design budget -
    let designTask
    await labeled('design', async () => {
      designTask = await startTask('design-budget')
      const dir = join(workspace, '.agent-squad', designTask)
      let state = await readState(designTask)
      assert.deepEqual([state.designLimit, state.reworkLimit, state.extensions], [4, 3, []])
      for (let n = 1; n <= 4; n += 1) {
        const out = await design(`r${n}`)
        assert.match(out, new RegExp(`planRounds=${n}/4`))
        state = await readState(designTask)
        assert.equal(state.planRounds, n)
        assert.equal(state.round, 1)
        assert.equal(state.reworkRounds, 0)
        assert.ok(await stat(join(dir, `PLAN-R${n}.md`)))
      }
      // 5th dispatch: full decision-gate message, zero side effects.
      await noSide(designTask, () => design('r5'), designPause(4, 4))
      // Extend with a trimmed reason and omitted rounds (default +3).
      const before = await readState(designTask)
      const t0 = Date.now()
      const out = await extendOnly(designTask, { kind: 'design', reason: ' 用户同意设计 ', confirmed: true })
      const t1 = Date.now()
      assert.equal(
        out,
        `任务 ${designTask} 的 design 预算已扩展：上限 4 → 7，已用 4，剩余 3（追加 3 轮）。\n原因：用户同意设计`,
      )
      state = await readState(designTask)
      assert.equal(state.designLimit, 7)
      assert.equal(state.reworkLimit, 3)
      assert.equal(state.extensions.length, 1)
      const record = state.extensions[0]
      assert.equal(record.kind, 'design')
      assert.equal(record.rounds, 3)
      assert.equal(record.reason, '用户同意设计')
      const at = Date.parse(record.at)
      assert.ok(!Number.isNaN(at) && at >= t0 && at <= t1, `at must be a valid ISO time in range: ${record.at}`)
      // Only §16 fields changed: everything else is deep-equal.
      const { designLimit, extensions, ...rest } = state
      const { designLimit: bLimit, extensions: bExt, ...restBefore } = before
      assert.deepEqual(rest, restBefore)
      assert.notEqual(bLimit, designLimit)
      assert.deepEqual(bExt, [])
      // Designs 5–7 succeed; the 5th receipt reads planRounds=5/7.
      const fifth = await design('r5')
      assert.match(fifth, /planRounds=5\/7/)
      await design('r6')
      await design('r7')
      assert.equal((await readState(designTask)).planRounds, 7)
      // 8th blocked at 7/7, then a boundary +1 resumes it.
      await noSide(designTask, () => design('r8'), designPause(7, 7))
      const bump = await extendOnly(designTask, { kind: 'design', rounds: 1, reason: '用户追加一轮', confirmed: true })
      assert.equal(
        bump,
        `任务 ${designTask} 的 design 预算已扩展：上限 7 → 8，已用 7，剩余 1（追加 1 轮）。\n原因：用户追加一轮`,
      )
      const eighth = await design('r8')
      assert.match(eighth, /planRounds=8\/8/)
      assert.ok(await stat(join(dir, 'PLAN-R8.md')))
      assert.equal((await readState(designTask)).designLimit, 8)
    })

    // --- T10/implement (PLAN §34): rework budget extends independently -------
    await labeled('implement', async () => {
      const task = designTask
      const dir = join(workspace, '.agent-squad', task)
      const approveOut = await tool('squad_approve_plan').execute({ task_id: task }, exec)
      assert.match(approveOut, /已批准（第 8\/8 次设计）/)
      assert.match(await readFile(join(dir, 'JOURNAL.md'), 'utf8'), /设计轮次 8\/8/)
      const designBefore = await readState(task)
      // A plain implement does not consume the rework budget.
      await dispatch({ agent: 'zcode', message: 'impl', phase: 'implement' })
      assert.equal((await readState(task)).reworkRounds, 0)
      // Rework 1–3: same local child id, round reaches 4.
      await rework('rw1')
      const childId = host.activations.at(-1).childId
      await rework('rw2')
      await rework('rw3')
      let state = await readState(task)
      assert.equal(state.reworkRounds, 3)
      assert.equal(state.round, 4)
      for (const sent of host.sent.slice(-2)) assert.equal(sent.targetId, childId)
      // 4th rework: full decision-gate message, zero side effects.
      await noSide(task, () => rework('rw4'), reworkPause(3, 3))
      // Extend implement (default +3): design counters and approval untouched.
      const out = await extendOnly(task, { kind: 'implement', reason: '用户同意返工', confirmed: true })
      assert.equal(
        out,
        `任务 ${task} 的 implement 预算已扩展：上限 3 → 6，已用 3，剩余 3（追加 3 轮）。\n原因：用户同意返工`,
      )
      state = await readState(task)
      assert.equal(state.reworkLimit, 6)
      assert.equal(state.designLimit, 8)
      assert.equal(state.planRounds, designBefore.planRounds)
      assert.equal(state.planApproved, true)
      assert.equal(state.planApprovedAt, designBefore.planApprovedAt)
      // Rework 4–6: the 4th receipt reads rework=4/6 and its BRIEF rework=3/6.
      const fourth = await rework('rw4')
      assert.match(fourth, /rework=4\/6/)
      const brief = await readFile(join(dir, 'BRIEF.md'), 'utf8')
      assert.ok(brief.includes('rework=3/6'), 'BRIEF shows the pre-count against the new limit')
      await rework('rw5')
      await rework('rw6')
      state = await readState(task)
      assert.equal(state.reworkRounds, 6)
      assert.equal(state.round, 7)
      assert.equal(host.sent.at(-1).targetId, childId)
      // 7th blocked at 6/6, +1 resumes it, round reaches 8.
      await noSide(task, () => rework('rw7'), reworkPause(6, 6))
      await extendOnly(task, { kind: 'implement', rounds: 1, reason: '用户追加返工', confirmed: true })
      await rework('rw7')
      state = await readState(task)
      assert.equal(state.round, 8)
      assert.equal(state.reworkRounds, 7)
      assert.equal(state.planRounds, 8)
      assert.equal(state.reworkLimit, 7)
      // Approval still forbids design even though design budget was extended.
      await noSide(
        task,
        () => design('late'),
        `任务 ${task} 的 PLAN 已批准（${state.planApprovedAt}）：不能再派 design 返工，请派 architect 发布技术规格（phase="spec"）。`,
      )
    })

    // --- T10/records (PLAN §35): history, status output, cross-task task_id --
    await labeled('records', async () => {
      const task = designTask
      const state = await readState(task)
      const rows = state.extensions.map((row) => [row.kind, row.rounds, row.reason])
      assert.deepEqual(rows, [
        ['design', 3, '用户同意设计'],
        ['design', 1, '用户追加一轮'],
        ['implement', 3, '用户同意返工'],
        ['implement', 1, '用户追加返工'],
      ])
      for (const row of state.extensions) assert.ok(!Number.isNaN(Date.parse(row.at)))
      const statusOut = await tool('squad_status').execute({}, exec)
      assert.ok(statusOut.includes(budgetLine(8, 8, 7, 7)), statusOut)
      assert.ok(statusOut.includes('最近扩展（最多 6 条）：'))
      for (const row of state.extensions) {
        assert.ok(
          statusOut.includes(`- ${row.at} kind=${row.kind} rounds=${row.rounds} reason=${row.reason}`),
        )
      }
      // A second task becomes current; an explicit task_id still extends the
      // exhausted task A and touches nothing else.
      const taskB = await startTask('records-b')
      const stateBPath = join(workspace, '.agent-squad', taskB, 'STATE.json')
      const stateBBefore = await readFile(stateBPath, 'utf8')
      const currentPath = join(workspace, '.agent-squad', 'current.json')
      const currentBefore = await readFile(currentPath, 'utf8')
      const cwdSets = host.cwdCalls.filter((call) => call.op === 'set').length
      const out = await extendOnly(task, {
        kind: 'design',
        rounds: 1,
        reason: '用户同意',
        confirmed: true,
        task_id: task,
      })
      assert.equal(
        out,
        `任务 ${task} 的 design 预算已扩展：上限 8 → 9，已用 8，剩余 1（追加 1 轮）。\n原因：用户同意`,
      )
      assert.equal((await readState(task)).designLimit, 9)
      assert.equal((await readState(task)).reworkLimit, 7)
      assert.equal(await readFile(stateBPath, 'utf8'), stateBBefore)
      assert.equal(await readFile(currentPath, 'utf8'), currentBefore)
      assert.equal(host.cwdCalls.filter((call) => call.op === 'set').length, cwdSets)
    })

    // --- T10/legacy-status (PLAN §36): legacy STATE falls back to 4/3/[] -----
    await labeled('legacy-status', async () => {
      const task = await startTask('legacy-budget')
      const statePath = join(workspace, '.agent-squad', task, 'STATE.json')
      const strip = async (mutate) => {
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        delete state.designLimit
        delete state.reworkLimit
        delete state.extensions
        state.planRounds = 4
        state.reworkRounds = 3
        state.planApproved = false
        mutate?.(state)
        await writeState(task, state)
        return readFile(statePath, 'utf8')
      }
      let bytes = await strip()
      const expectLine = budgetLine(4, 4, 3, 3)
      let statusOut = await tool('squad_status').execute({}, exec)
      assert.ok(statusOut.includes(expectLine), statusOut)
      assert.ok(statusOut.includes('最近扩展：无'))
      assert.equal(await readFile(statePath, 'utf8'), bytes)
      // Null limits read the same way; status never migrates the file.
      bytes = await strip((state) => {
        state.designLimit = null
        state.reworkLimit = null
        state.extensions = null
      })
      statusOut = await tool('squad_status').execute({}, exec)
      assert.ok(statusOut.includes(expectLine))
      assert.ok(statusOut.includes('最近扩展：无'))
      assert.equal(await readFile(statePath, 'utf8'), bytes)
      // §36: restore the deleted-fields state before the dispatch/extension
      // steps below (they must run against a legacy STATE, not null fields).
      bytes = await strip()
      // Both dispatch kinds are paused at the legacy limits.
      await noSide(task, () => design('over'), designPause(4, 4))
      await noSide(task, () => rework('over'), reworkPause(3, 3))
      // Extend both budgets by 1: 5/4 persisted, two records, counters 4/3.
      await extendOnly(task, { kind: 'design', rounds: 1, reason: '用户同意设计', confirmed: true })
      await extendOnly(task, { kind: 'implement', rounds: 1, reason: '用户同意返工', confirmed: true })
      let state = await readState(task)
      assert.equal(state.designLimit, 5)
      assert.equal(state.reworkLimit, 4)
      assert.deepEqual(
        state.extensions.map((row) => [row.kind, row.rounds, row.reason]),
        [
          ['design', 1, '用户同意设计'],
          ['implement', 1, '用户同意返工'],
        ],
      )
      assert.equal(state.planRounds, 4)
      assert.equal(state.reworkRounds, 3)
      // Both kinds can continue: design (4/5) now, rework (3/4) after approval.
      await design('d5')
      assert.equal((await readState(task)).planRounds, 5)
      await tool('squad_approve_plan').execute({ task_id: task }, exec)
      await rework('rw4')
      state = await readState(task)
      assert.equal(state.reworkRounds, 4)
      assert.equal(state.round, 2)
    })

    // --- T10/status-tail (PLAN §37): over-budget STATE, last-6 extension view -
    await labeled('status-tail', async () => {
      const task = await startTask('status-tail')
      const statePath = join(workspace, '.agent-squad', task, 'STATE.json')
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      state.phase = 'design'
      state.planApproved = false
      state.designLimit = 8
      state.planRounds = 9
      state.reworkLimit = 7
      state.reworkRounds = 8
      state.extensions = Array.from({ length: 7 }, (_, i) => ({
        at: `2026-11-12T00:00:0${i + 1}.000Z`,
        kind: 'design',
        rounds: 1,
        reason: `r${i + 1}`,
      }))
      await writeState(task, state)
      const bytes = await readFile(statePath, 'utf8')
      const statusOut = await tool('squad_status').execute({}, exec)
      assert.ok(statusOut.includes(budgetLine(8, 9, 7, 8)), statusOut)
      assert.ok(statusOut.includes('最近扩展（最多 6 条）：'))
      assert.ok(!statusOut.includes('reason=r1\n') && !statusOut.endsWith('reason=r1'))
      assert.ok(!statusOut.includes('- 2026-11-12T00:00:01.000Z'))
      for (let i = 2; i <= 7; i += 1) {
        const line = `- 2026-11-12T00:00:0${i}.000Z kind=design rounds=1 reason=r${i}`
        assert.ok(statusOut.includes(line), `missing tail record line: ${line}`)
      }
      const first = statusOut.indexOf('reason=r2')
      const last = statusOut.indexOf('reason=r7')
      assert.ok(first !== -1 && last !== -1 && first < last)
      assert.equal(await readFile(statePath, 'utf8'), bytes)
      // Over-budget STATE still allows design extension (9>=8), remaining 0.
      const out = await extendOnly(task, { kind: 'design', rounds: 1, reason: '用户同意', confirmed: true })
      assert.equal(
        out,
        `任务 ${task} 的 design 预算已扩展：上限 8 → 9，已用 9，剩余 0（追加 1 轮）。\n原因：用户同意`,
      )
      // used == limit keeps design paused even after the extension.
      await noSide(task, () => design('still'), designPause(9, 9))
    })
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T11 — architect flow: opt-in squad, spec gate, dual acceptance, takeover & quotas. */
test('T11 full flow: opt-in gate, spec/tech-review pipeline, dual acceptance, takeover and budgets', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  try {
    // Roster: codex external brain, gpt local architect (pinned p/arch),
    // zcode local worker (p/m1), qoder team worker.
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'external', model: 'mock-ext', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'local', model: 'p/arch', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'local', model: 'p/m1', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'team', model: '', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )
    const { apply } = await import('../index.js')
    // The mock external brain writes PLAN.md on design rounds; nothing else.
    const host = mockHost(workspace, dshHome, {
      onExternal: async (_provider, request) => {
        const text = request.prompt.map((block) => block.text).join('')
        if (text.includes('phase=design')) {
          const dir = /共享记忆：(\S+)/.exec(text)?.[1]
          if (dir) await writeFile(join(dir, 'PLAN.md'), '# PLAN T11\n', 'utf8')
        }
      },
    })
    apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const exec = { agent: lead, signal: undefined }
    const dispatch = (args) => tool('squad_dispatch').execute(args, exec)
    const extendTool = (args) => tool('squad_extend').execute(args, exec)
    const readState = async (task) =>
      JSON.parse(await readFile(join(workspace, '.agent-squad', task, 'STATE.json'), 'utf8'))
    const writeVerdict = async (task, file, verdict) =>
      writeFile(join(workspace, '.agent-squad', task, file), `# ${file}\n\n结论如上。\n\nVERDICT: ${verdict}\n`, 'utf8')

    // --- opt-in: no squad tools and no Lead persona before squad_enable ----
    {
      const whenOf = (name) => host.registered.find((entry) => entry.definition.name === name).when
      for (const name of ['squad_start', 'squad_dispatch', 'squad_approve_plan', 'squad_extend', 'squad_status', 'squad_wait', 'squad_finish']) {
        assert.equal(whenOf(name)({ agent: lead }), false, `${name} must stay hidden before enabling`)
      }
      assert.equal(whenOf('squad_enable')({ agent: lead }), true)
      assert.equal(host.sections.length, 0, 'no Lead section before enabling')
      assert.match(await tool('squad_enable').execute({}, exec), /已为当前会话启用/)
      for (const name of ['squad_start', 'squad_dispatch', 'squad_approve_plan', 'squad_extend', 'squad_status', 'squad_wait', 'squad_finish']) {
        assert.equal(whenOf(name)({ agent: lead }), true, `${name} must appear after enabling`)
      }
      assert.equal(whenOf('squad_enable')({ agent: lead }), false)
    }

    // --- default roster seeds qoder as the frontend developer ---------------
    {
      const { createSettingsStore, DEFAULT_AGENTS } = await import('../settings.js')
      const fresh = createSettingsStore({ filePath: join(dshHome, 'seed-probe', 'settings.json') })
      const seeded = await fresh.read()
      assert.equal(seeded.agents.find((agent) => agent.id === 'gpt').role, 'architect')
      assert.equal(seeded.agents.find((agent) => agent.id === 'gpt').model, DEFAULT_AGENTS.find((agent) => agent.id === 'gpt').model)
      const qoder = seeded.agents.find((agent) => agent.id === 'qoder')
      assert.equal(qoder.role, 'worker')
      assert.match(qoder.description, /主责前端产品代码开发与自测，兼做后端代码开发/)
      const zcode = seeded.agents.find((agent) => agent.id === 'zcode')
      assert.match(zcode.description, /后端代码并自测/)
    }

    // --- task F: the full pipeline ------------------------------------------
    const startF = await tool('squad_start').execute({ goal: 'F', acceptance: 'ok' }, exec)
    const taskF = /任务 (t-\S+) 已创建/.exec(startF)[1]
    const dirF = join(workspace, '.agent-squad', taskF)
    {
      const state = await readState(taskF)
      assert.equal(state.flow, 'full')
      assert.equal(state.specRequired, true) // architect participates
      assert.equal(state.specPublished, false)
      assert.equal(state.specVersion, 0)
      assert.equal(state.codeEpoch, 0)
      assert.deepEqual(state.implementers, [])
      assert.equal(state.techReworkLimit, 3)
      assert.equal(state.businessReworkLimit, 3)
      assert.match(startF, /full（业务方案 → 技术规格 → 实现 → 技术验收 → 业务验收）/)
    }

    // design → PLAN.md (external), spec gated until the Lead approves.
    await dispatch({ agent: 'codex', message: 'plan', phase: 'design' })
    await assert.rejects(
      dispatch({ agent: 'gpt', message: 'early spec', phase: 'spec' }),
      /业务方案（PLAN\.md）尚未经 Lead 审核批准/,
    )
    await tool('squad_approve_plan').execute({ task_id: taskF }, exec)

    // spec: only the architect role; wrong roles refused with no side effects
    // (the design-round BRIEF stays byte-identical through the refusal).
    const briefAfterDesign = await readFile(join(dirF, 'BRIEF.md'), 'utf8')
    assert.match(briefAfterDesign, /phase=design/)
    await assert.rejects(dispatch({ agent: 'zcode', message: 's', phase: 'spec' }), /spec 阶段只能派 architect 角色；zcode 当前是 worker。/)
    assert.equal(await readFile(join(dirF, 'BRIEF.md'), 'utf8'), briefAfterDesign)
    // gpt is a pinned local child: first spec spawn carries the model options.
    const specOut = await dispatch({ agent: 'gpt', message: 'write SPEC', phase: 'spec' })
    assert.match(specOut, /已创建本地子代理 gpt \[architect\] model=p\/arch/)
    assert.deepEqual(host.activations.at(-1).agentOptions, { provider: 'p', model: 'arch' })
    assert.match(specOut, /specVersion=1/)
    assert.match(specOut, /不需要 Lead 再审批/)
    assert.equal((await readState(taskF)).specPublished, true)

    // implement: refused BEFORE the spec is published (fresh task proves the
    // gate), allowed right after — no extra Lead approval for the spec.
    const startG0 = await tool('squad_start').execute({ goal: 'G', acceptance: 'ok' }, exec)
    const taskG = /任务 (t-\S+) 已创建/.exec(startG0)[1]
    const dirG = join(workspace, '.agent-squad', taskG)
    await dispatch({ agent: 'codex', message: 'plan G', phase: 'design' })
    await tool('squad_approve_plan').execute({ task_id: taskG }, exec)
    await assert.rejects(
      dispatch({ agent: 'zcode', message: 'too early', phase: 'implement' }),
      /技术规格尚未交付：先派 architect（gpt）phase="spec" 发布 SPEC\.md，再派 implement；规格发布后即可派工，不需要 Lead 再审批。/,
    )
    await dispatch({ agent: 'gpt', message: 'spec G', phase: 'spec' })
    await dispatch({ agent: 'zcode', message: 'impl', phase: 'implement' })
    let stateG = await readState(taskG)
    assert.equal(stateG.codeEpoch, 1)
    assert.deepEqual(stateG.implementers, ['zcode'])

    // tech-review: needs implementation; only architect/brain; workers refused.
    await writeVerdict(taskG, 'TECH-REVIEW.md', 'APPROVED')
    await assert.rejects(dispatch({ agent: 'zcode', message: 'tr', phase: 'tech-review' }), /tech-review 只能派 architect（gpt），或由 brain（codex）在架构师接手实现后代签；zcode 当前是 worker。/)
    // business review: refused until a FRESH technical approval exists.
    await assert.rejects(dispatch({ agent: 'codex', message: 'br', phase: 'review' }), /技术验收未通过或已失效.*先派 tech-review。/s)
    // qoder is a worker: the full-flow business review is brain-only.
    await assert.rejects(dispatch({ agent: 'qoder', message: 'br', phase: 'review' }), /完整流程的业务验收只能派 brain 角色；qoder 当前是 worker。/)

    // --- task F continues: tech failure → rework → fresh gates --------------
    // (current.json now points at G, so every F dispatch passes task_id.)
    await dispatch({ agent: 'zcode', message: 'impl F', phase: 'implement', task_id: taskF })
    await writeVerdict(taskF, 'TECH-REVIEW.md', 'CHANGES_REQUESTED')
    await dispatch({ agent: 'gpt', message: 'tech 1', phase: 'tech-review', task_id: taskF })
    let stateF = await readState(taskF)
    assert.equal(stateF.lastTechVerdict, 'CHANGES_REQUESTED')
    assert.equal(stateF.techReview.codeEpoch, stateF.codeEpoch)
    assert.ok(await stat(join(dirF, 'TECH-REVIEW-R1.md'))) // round-numbered archive
    // rework kind inference: fresh failing tech → tech rework (quota shared
    // across zcode AND qoder).
    const reworkQoder = await dispatch({ agent: 'qoder', message: 'fix frontend', phase: 'rework', task_id: taskF })
    assert.match(reworkQoder, /rework: tech=1\/3 business=0\/3/)
    stateF = await readState(taskF)
    assert.equal(stateF.techReworkRounds, 1)
    assert.equal(stateF.codeEpoch, 2) // implement(1) + rework(2)
    assert.deepEqual(stateF.implementers, ['zcode', 'qoder'])
    assert.equal(stateF.dispatches.at(-1).reworkKind, 'tech')
    // business review still refused: the tech binding went stale after rework.
    await assert.rejects(dispatch({ agent: 'codex', message: 'br', phase: 'review', task_id: taskF }), /旧结论已因代码\/规格变动失效，需重新验收/)
    // no pending failing acceptance → rework refused.
    await assert.rejects(dispatch({ agent: 'zcode', message: 'nothing', phase: 'rework', task_id: taskF }), /没有待返工的验收结论/)
    // fresh tech approval → business review records its own binding.
    await writeVerdict(taskF, 'TECH-REVIEW.md', 'APPROVED')
    await dispatch({ agent: 'gpt', message: 'tech 2', phase: 'tech-review', task_id: taskF })
    await writeVerdict(taskF, 'REVIEW.md', 'CHANGES_REQUESTED')
    await dispatch({ agent: 'codex', message: 'business 1', phase: 'review', task_id: taskF })
    stateF = await readState(taskF)
    assert.equal(stateF.lastVerdict, 'CHANGES_REQUESTED')
    assert.equal(stateF.businessReview.codeEpoch, stateF.codeEpoch)
    // finish: needs BOTH acceptances; business failure blocks it.
    await assert.rejects(tool('squad_finish').execute({ summary: 'no', task_id: taskF }, exec), /CHANGES_REQUESTED/)
    // business rework: inferred from the fresh failing business acceptance.
    await dispatch({ agent: 'zcode', message: 'fix business', phase: 'rework', task_id: taskF })
    stateF = await readState(taskF)
    assert.equal(stateF.businessReworkRounds, 1)
    assert.equal(stateF.dispatches.at(-1).reworkKind, 'business')
    // business rework changed code → tech stale again → finish refused.
    await writeVerdict(taskF, 'REVIEW.md', 'APPROVED')
    await assert.rejects(tool('squad_finish').execute({ summary: 'no', task_id: taskF }, exec), /技术验收结论已失效/)
    await writeVerdict(taskF, 'TECH-REVIEW.md', 'APPROVED')
    await dispatch({ agent: 'gpt', message: 'tech 3', phase: 'tech-review', task_id: taskF })
    await dispatch({ agent: 'codex', message: 'business 2', phase: 'review', task_id: taskF })
    stateF = await readState(taskF)
    assert.equal(stateF.techReview.reviewer, 'gpt')
    assert.equal(stateF.businessReview.reviewer, 'codex')
    assert.equal(stateF.techReview.codeEpoch, stateF.codeEpoch)
    assert.equal(stateF.businessReview.codeEpoch, stateF.codeEpoch)
    assert.equal(stateF.techReworkRounds, 1)
    assert.equal(stateF.businessReworkRounds, 1)
    assert.match(await tool('squad_finish').execute({ summary: 'F done', task_id: taskF }, exec), /收尾/)

    // --- task H: architect takeover + self-sign ban + codex dual signing ----
    const startH = await tool('squad_start').execute({ goal: 'H', acceptance: 'ok' }, exec)
    const taskH = /任务 (t-\S+) 已创建/.exec(startH)[1]
    await dispatch({ agent: 'codex', message: 'plan H', phase: 'design' })
    await tool('squad_approve_plan').execute({ task_id: taskH }, exec)
    await dispatch({ agent: 'gpt', message: 'spec H', phase: 'spec' })
    // The architect may take over implementation directly.
    await dispatch({ agent: 'gpt', message: 'gpt implements', phase: 'implement' })
    stateG = await readState(taskH)
    assert.deepEqual(stateG.implementers, ['gpt'])
    assert.equal(stateG.codeEpoch, 1)
    // Self-sign ban: gpt cannot sign its own technical acceptance.
    await writeVerdict(taskH, 'TECH-REVIEW.md', 'APPROVED')
    await assert.rejects(
      dispatch({ agent: 'gpt', message: 'self sign', phase: 'tech-review' }),
      /gpt 已在本任务中写代码，不能签署自己改动的技术验收：改派 brain（codex）对照 SPEC\.md 独立代签技术验收，业务验收仍由 codex 按业务方案单独签署，两份验收独立记录。/,
    )
    // codex signs BOTH acceptances as two independent records.
    await dispatch({ agent: 'codex', message: 'tech on behalf', phase: 'tech-review' })
    stateG = await readState(taskH)
    assert.equal(stateG.techReview.reviewer, 'codex')
    await writeVerdict(taskH, 'REVIEW.md', 'APPROVED')
    await dispatch({ agent: 'codex', message: 'business', phase: 'review' })
    // H is the current task: status renders the full-flow state.
    const statusH = await tool('squad_status').execute({}, exec)
    assert.match(statusH, /flow=full/)
    assert.match(statusH, /specPublished=true  specVersion=1/)
    assert.match(statusH, /技术验收：新鲜  verdict=APPROVED  reviewer=codex（TECH-REVIEW\.md）/)
    assert.match(statusH, /业务验收：新鲜  verdict=APPROVED  reviewer=codex（REVIEW\.md）/)
    assert.match(statusH, /tech 上限=3 已用=0 剩余=3；business 上限=3 已用=0 剩余=3/)
    assert.match(statusH, /implementers=gpt/)
    assert.match(await tool('squad_finish').execute({ summary: 'H done', task_id: taskH }, exec), /收尾/)

    // --- task Q: tech quota shared, capped at 3, extended only by the user --
    const startQ = await tool('squad_start').execute({ goal: 'Q', acceptance: 'ok' }, exec)
    const taskQ = /任务 (t-\S+) 已创建/.exec(startQ)[1]
    await dispatch({ agent: 'codex', message: 'plan Q', phase: 'design' })
    await tool('squad_approve_plan').execute({ task_id: taskQ }, exec)
    await dispatch({ agent: 'gpt', message: 'spec Q', phase: 'spec' })
    await dispatch({ agent: 'zcode', message: 'impl Q', phase: 'implement' })
    for (let round = 1; round <= 3; round += 1) {
      await writeVerdict(taskQ, 'TECH-REVIEW.md', 'CHANGES_REQUESTED')
      await dispatch({ agent: 'gpt', message: `tech ${round}`, phase: 'tech-review' })
      const worker = round === 2 ? 'qoder' : 'zcode' // quota shared across workers
      await dispatch({ agent: worker, message: `fix ${round}`, phase: 'rework' })
      assert.equal((await readState(taskQ)).techReworkRounds, round)
    }
    await writeVerdict(taskQ, 'TECH-REVIEW.md', 'CHANGES_REQUESTED')
    await dispatch({ agent: 'gpt', message: 'tech 4', phase: 'tech-review' })
    const briefBefore = await readFile(join(dirG, 'BRIEF.md'), 'utf8').catch(() => undefined)
    await assert.rejects(
      dispatch({ agent: 'zcode', message: '4th rework', phase: 'rework' }),
      /技术返工已达上限 3 轮（已用 3）。先向用户说明阻塞点与已完成部分并等待决策；用户同意后调用 squad_extend\(kind="tech", confirmed=true, reason="用户批准的追加理由"\) 追加轮次，再派 rework；用户拒绝或未回复时保持暂停，不得自动续跑。/,
    )
    // Full-flow tasks have no implement budget: the kind is flow-checked.
    await assert.rejects(
      extendTool({ kind: 'implement', rounds: 1, reason: 'x', confirmed: true }),
      /走完整流程：没有 implement 返工预算。技术返工用 kind="tech"，业务返工用 kind="business"。/,
    )
    assert.equal(briefBefore, await readFile(join(dirG, 'BRIEF.md'), 'utf8').catch(() => undefined))
    // User-approved extension resumes the paused 4th rework.
    assert.match(
      await extendTool({ kind: 'tech', rounds: 1, reason: '用户同意再来一轮', confirmed: true }),
      /的 tech 预算已扩展：上限 3 → 4，已用 3，剩余 1（追加 1 轮）。/,
    )
    await dispatch({ agent: 'zcode', message: '4th rework after consent', phase: 'rework' })
    assert.equal((await readState(taskQ)).techReworkRounds, 4)

    // --- task S: simple flow skips the new gates entirely -------------------
    const startS = await tool('squad_start').execute(
      { goal: 'S', acceptance: 'ok', flow: 'simple', agents: ['codex', 'zcode'] },
      exec,
    )
    const taskS = /任务 (t-\S+) 已创建/.exec(startS)[1]
    assert.match(startS, /simple（简化：无技术规格\/双验收门禁）/)
    const stateS = await readState(taskS)
    assert.equal(stateS.flow, 'simple')
    assert.equal(stateS.specRequired, false)
    await assert.rejects(dispatch({ agent: 'gpt', message: 'no spec', phase: 'spec' }), /未启用完整流程/)
    await dispatch({ agent: 'codex', message: 'plan S', phase: 'design' })
    await tool('squad_approve_plan').execute({ task_id: taskS }, exec)
    await dispatch({ agent: 'zcode', message: 'impl S', phase: 'implement' })
    await assert.rejects(dispatch({ agent: 'gpt', message: 'no tech', phase: 'tech-review' }), /未启用完整流程/)
    await writeVerdict(taskS, 'REVIEW.md', 'APPROVED')
    await dispatch({ agent: 'codex', message: 'review S', phase: 'review' })
    // Simple tasks keep the design/implement extension kinds; tech is refused.
    await assert.rejects(
      extendTool({ kind: 'tech', rounds: 1, reason: 'x', confirmed: true }),
      /未启用完整流程（无技术\/业务返工预算）：用 kind="design" 或 kind="implement"。/,
    )
    assert.match(await tool('squad_finish').execute({ summary: 'S done', task_id: taskS }, exec), /收尾/)
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T12 — architect failover: quota auto-suspend, brain handover, recovery, persistence. */
test('T12 failover suspends a quota-exhausted architect and hands its duties to the brain', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  try {
    // All-team roster: codex brain, gpt architect, zcode worker.
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'team', model: '', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'team', model: '', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'team', model: '', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )
    const failoverPath = join(dshHome, 'agent-squad', 'failover.json')
    const { apply } = await import('../index.js')
    const host = mockHost(workspace, dshHome)
    apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const exec = { agent: lead, signal: undefined }
    await tool('squad_enable').execute({}, exec)
    const dispatch = (args) => tool('squad_dispatch').execute(args, exec)
    const failover = (args) => tool('squad_failover').execute(args, exec)
    const startTask = async (goal, agents) => {
      const out = await tool('squad_start').execute({ goal, acceptance: 'ok', agents }, exec)
      return /任务 (t-\S+) 已创建/.exec(out)[1]
    }

    // --- task F: manual suspension, handover gates, recovery ----------------
    const taskF = await startTask('F', ['codex', 'gpt', 'zcode'])
    const dirF = join(workspace, '.agent-squad', taskF)
    await dispatch({ agent: 'codex', message: 'plan', phase: 'design' })
    await writeFile(join(dirF, 'PLAN.md'), '# PLAN F\n', 'utf8')
    await tool('squad_approve_plan').execute({ task_id: taskF }, exec)

    // Before suspension the brain cannot take the spec round.
    await assert.rejects(dispatch({ agent: 'codex', message: 's', phase: 'spec' }), /spec 阶段只能派 architect 角色；codex 当前是 brain。/)
    // Failover tool validation: reason required; only architects.
    await assert.rejects(failover({ agent: 'gpt' }), /reason 必须是非空字符串/)
    await assert.rejects(failover({ agent: 'zcode', reason: 'x' }), /仅架构师支持挂起交接.*zcode 当前是 worker/)
    // Manual suspension persists and shows in status.
    const suspendOut = await failover({ agent: 'gpt', reason: '额度耗尽（手动验证）' })
    assert.match(suspendOut, /架构师 gpt 已挂起/)
    assert.match(suspendOut, /squad_dispatch\({ agent: "codex", phase: "spec" \| "tech-review", … }\)/)
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(failoverPath, 'utf8')).suspended),
      ['gpt'],
    )
    await assert.rejects(failover({ agent: 'gpt', reason: 'again' }), /已处于挂起状态/)
    const statusSuspended = await tool('squad_status').execute({}, exec)
    assert.match(statusSuspended, /挂起：gpt（自 .+；手动；原因：额度耗尽（手动验证））→ 架构师职责由 brain 代行/)
    // Suspended architect refuses dispatch with handover guidance.
    await assert.rejects(
      dispatch({ agent: 'gpt', message: 'spec', phase: 'spec' }),
      /gpt 已挂起.*架构师职责由 brain 代行：squad_dispatch\({ agent: "codex", phase: "spec" \| "tech-review", … }\).*squad_failover\({ agent: "gpt", recover: true }\)/s,
    )
    // The brain now covers the spec round (acting architect); the dispatch
    // return itself carries the acting marker for auditability.
    const specOut = await dispatch({ agent: 'codex', message: 'write spec', phase: 'spec' })
    assert.match(specOut, /已(创建|续跑) codex \[brain\]/)
    assert.match(specOut, /（代行架构师职责：架构师挂起，交付 SPEC\.md \/ TECH-REVIEW\.md）/)
    const specPrompt = host.spawned.at(-1).prompt.map((block) => block.text).join('')
    assert.match(specPrompt, /代行架构师职责/)
    assert.match(specPrompt, /SPEC\.md/)
    const stateF = JSON.parse(await readFile(join(dirF, 'STATE.json'), 'utf8'))
    assert.equal(stateF.specPublished, true)
    assert.equal(stateF.specVersion, 1)
    // tech-review to the brain stays allowed; implement first (codeEpoch).
    await dispatch({ agent: 'zcode', message: 'impl', phase: 'implement' })
    const trOut = await dispatch({ agent: 'codex', message: 'tech', phase: 'tech-review' })
    assert.match(trOut, /已续跑 codex \[brain\]/)
    assert.match(trOut, /（代行架构师职责：架构师挂起，交付 SPEC\.md \/ TECH-REVIEW\.md）/)

    // Recovery restores the architect and closes the acting gate.
    const recoverOut = await failover({ agent: 'gpt', recover: true })
    assert.match(recoverOut, /已解除挂起/)
    assert.deepEqual(JSON.parse(await readFile(failoverPath, 'utf8')).suspended, {})
    await assert.rejects(failover({ agent: 'gpt', recover: true }), /未挂起，无需恢复/)
    await assert.rejects(dispatch({ agent: 'codex', message: 's', phase: 'spec' }), /spec 阶段只能派 architect 角色；codex 当前是 brain。/)
    const gptSpecAgain = await dispatch({ agent: 'gpt', message: 'spec again', phase: 'spec' })
    assert.match(gptSpecAgain, /已创建 gpt \[architect\]/)
    assert.ok(!/代行架构师职责/.test(gptSpecAgain), 'regular architect dispatch carries no acting marker')
    const statusRestored = await tool('squad_status').execute({}, exec)
    assert.match(statusRestored, /挂起：无/)

    // --- auto-suspend: dispatch dies with a quota-like error ----------------
    const taskG = await startTask('G', ['codex', 'gpt', 'zcode'])
    const dirG = join(workspace, '.agent-squad', taskG)
    await dispatch({ agent: 'codex', message: 'plan', phase: 'design' })
    await writeFile(join(dirG, 'PLAN.md'), '# PLAN G\n', 'utf8')
    await tool('squad_approve_plan').execute({ task_id: taskG }, exec)
    const originalStart = host.subagents.startActivation
    const originalSend = host.subagents.sendMessage
    const gptMemberId = host.members.find((member) => member.name === 'gpt')?.id
    const installQuotaThrow = (message) => {
      host.subagents.startActivation = async (spec) => {
        if (spec.name === 'gpt') throw new Error(message)
        return originalStart(spec)
      }
      host.subagents.sendMessage = async (from, targetId, content) => {
        if (targetId === gptMemberId) throw new Error(message)
        return originalSend(from, targetId, content)
      }
    }
    installQuotaThrow('HTTP 429 quota exceeded：账户额度耗尽')
    try {
      await assert.rejects(
        dispatch({ agent: 'gpt', message: 'spec', phase: 'spec' }),
        (error) =>
          /额度耗尽/.test(error.message) &&
          /gpt 已因额度问题自动挂起.*squad_dispatch\({ agent: "codex", phase: "spec", … }\).*squad_failover\({ agent: "gpt", recover: true }\)/s.test(error.message),
      )
    } finally {
      host.subagents.startActivation = originalStart
      host.subagents.sendMessage = originalSend
    }
    const autoRecord = JSON.parse(await readFile(failoverPath, 'utf8')).suspended.gpt
    assert.match(autoRecord.reason, /派单失败自动挂起：HTTP 429/)
    assert.equal(autoRecord.auto, true)
    assert.match(await tool('squad_status').execute({}, exec), /挂起：gpt（自 .+；自动；/)
    // Non-quota dispatch errors do NOT suspend.
    await tool('squad_failover').execute({ agent: 'gpt', recover: true }, exec)
    installQuotaThrow('spawn crashed for unrelated reasons')
    try {
      await assert.rejects(dispatch({ agent: 'gpt', message: 'spec', phase: 'spec' }), /spawn crashed/)
      assert.equal(JSON.parse(await readFile(failoverPath, 'utf8')).suspended.gpt, undefined)
    } finally {
      host.subagents.startActivation = originalStart
      host.subagents.sendMessage = originalSend
    }

    // --- auto-suspend: the architect reports blocked with a quota summary ---
    await dispatch({ agent: 'gpt', message: 'spec', phase: 'spec' })
    const gptAgent = [...host.agentsById.values()].find((agent) => agent.__membership?.name === 'gpt')
    assert.ok(gptAgent, 'spawned gpt member exists')
    const reportOut = await tool('squad_report').execute(
      { status: 'blocked', summary: 'API 报 429 quota：模型额度已耗尽，无法继续' },
      { agent: gptAgent, signal: undefined },
    )
    assert.match(reportOut, /status=blocked/)
    assert.match(JSON.parse(await readFile(failoverPath, 'utf8')).suspended.gpt.reason, /队友报告额度耗尽/)
    await assert.rejects(dispatch({ agent: 'gpt', message: 'again', phase: 'spec' }), /已挂起/)

    // --- persistence: a fresh plugin generation keeps the suspension --------
    {
      await tool('squad_failover').execute({ agent: 'gpt', recover: true }, exec)
      await writeFile(failoverPath, JSON.stringify({ suspended: { gpt: { at: '2026-11-20T00:00:00.000Z', reason: '重启前挂起', auto: true } } }, null, 2), 'utf8')
      const host2 = mockHost(workspace, dshHome)
      apply(host2.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
      const tool2 = (name) => host2.registered.find((entry) => entry.definition.name === name).definition
      const exec2 = { agent: { id: 'lead-2', session: { id: 'session-2' }, __membership: { role: 'lead', name: 'lead' } }, signal: undefined }
      await tool2('squad_enable').execute({}, exec2)
      const out = await tool2('squad_start').execute({ goal: 'P', acceptance: 'ok', agents: ['codex', 'gpt', 'zcode'] }, exec2)
      const taskP = /任务 (t-\S+) 已创建/.exec(out)[1]
      const dirP = join(workspace, '.agent-squad', taskP)
      await tool2('squad_dispatch').execute({ agent: 'codex', message: 'plan', phase: 'design' }, exec2)
      await writeFile(join(dirP, 'PLAN.md'), '# PLAN P\n', 'utf8')
      await tool2('squad_approve_plan').execute({ task_id: taskP }, exec2)
      await assert.rejects(
        tool2('squad_dispatch').execute({ agent: 'gpt', message: 'spec', phase: 'spec' }, exec2),
        /gpt 已挂起（自 2026-11-20T00:00:00.000Z；原因：重启前挂起）/,
      )
      // And the brain may act while the persisted suspension is in force.
      assert.match(
        await tool2('squad_dispatch').execute({ agent: 'codex', message: 'acting spec', phase: 'spec' }, exec2),
        /已(创建|续跑) codex \[brain\]/,
      )
    }
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T13 — parallel by default: background external dispatch + subagent guidance. */
test('T13 background dispatch is the default for external implement and unblocks the Lead', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  try {
    // zcode external mock provider, qoder local.
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'team', model: '', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'external', model: 'mock-ext', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'local', model: 'p/fe', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )
    const { apply } = await import('../index.js')
    const host = mockHost(workspace, dshHome)
    apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const exec = { agent: lead, signal: undefined }
    await tool('squad_enable').execute({}, exec)
    const dispatch = (args) => tool('squad_dispatch').execute(args, exec)

    // No-brain task: exempt from plan/review gates so implement runs directly.
    const startOut = await tool('squad_start').execute(
      { goal: 'P', acceptance: 'ok', agents: ['zcode', 'qoder'] },
      exec,
    )
    const task = /任务 (t-\S+) 已创建/.exec(startOut)[1]

    // Validation: explicit background:true outside external implement/rework
    // is rejected; background:false is the blocking opt-out.
    await assert.rejects(
      dispatch({ agent: 'qoder', message: 'x', phase: 'implement', background: true }),
      /background 仅支持 external 执行者（一次性外部 provider）；local\/team 执行者本就不阻塞。/,
    )
    await assert.rejects(
      dispatch({ agent: 'zcode', message: 'x', phase: 'design', background: true }),
      /background 仅支持 implement\/rework 阶段；design\/spec\/review\/tech-review 需要同步读取交付物，不能后台派发。/,
    )

    // Parallel-by-default: an external implement dispatch WITHOUT any flag
    // runs in the background — no output section, delivery 'parent'.
    const bg = await dispatch({ agent: 'zcode', message: 'parallel part', phase: 'implement' })
    assert.match(bg, /已后台派发 zcode \(zcode\) \[worker\] provider=mock-ext（不阻塞，可继续派其他队友）/)
    assert.ok(!/输出：/.test(bg), 'default external implement must not block on the output')
    assert.match(bg, /结果完成时会以后台消息送达/)
    assert.equal(host.activations.at(-1).delivery, 'parent')
    let state = JSON.parse(await readFile(join(workspace, '.agent-squad', task, 'STATE.json'), 'utf8'))
    assert.equal(state.dispatches.at(-1).mode, 'external-background')
    assert.equal(state.codeEpoch, 1)
    assert.deepEqual(state.implementers, ['zcode'])
    assert.match(await readFile(join(workspace, '.agent-squad', task, 'RUNS.md'), 'utf8'), /mode=background/)

    // The Lead can immediately issue another worker while the background run
    // is in flight (qoder is local, non-blocking anyway) — the guard only
    // blocks re-dispatch of the SAME binding.
    assert.match(
      await dispatch({ agent: 'qoder', message: 'frontend part', phase: 'implement' }),
      /已创建本地子代理 qoder/,
    )

    // squad_status renders the running background executors; finish waits.
    const bgChild = host.activations.find((row) => row.provider === 'mock-ext' && row.childId)?.childId
    host.markRunning(bgChild ?? 'bg-unknown')
    const statusOut = await tool('squad_status').execute({}, exec)
    assert.match(statusOut, /后台执行器运行中：[12] 个（background 派发，结果将以消息送达；squad_finish 会等待）/)
    await assert.rejects(
      tool('squad_finish').execute({ summary: 'nope' }, exec),
      /仍有队友在运行/,
    )
    host.unmarkRunning(bgChild ?? 'bg-unknown')

    // Explicit background:false restores the blocking call with inline output.
    const blocking = await dispatch({ agent: 'zcode', message: 'serial', phase: 'implement', background: false })
    assert.match(blocking, /已外部派发 zcode/)
    assert.match(blocking, /输出：/)
    state = JSON.parse(await readFile(join(workspace, '.agent-squad', task, 'STATE.json'), 'utf8'))
    assert.equal(state.dispatches.at(-1).mode, 'external')
    assert.equal(state.codeEpoch, 3) // bg zcode + qoder + blocking zcode

    // Charter guidance: worker prompts carry the parallel-by-default hint.
    const workerPrompt = host.activations.at(-1).prompt.map((block) => block.text).join('')
    assert.match(workerPrompt, /并行默认：本轮交办包含多个独立文件\/模块时/)
    assert.match(workerPrompt, /子代理\/并行能力同时开发/)
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T14 — per-role worker capability, lead worker config and qoder's scope. */
test('T14 any role can act as a worker and the Lead has its own worker switch', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  try {
    const { createSettingsStore, validateAgentsAndWorktree } = await import('../settings.js')
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          leaderWorker: false,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'team', model: '', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'local', model: 'p/m1', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'local', model: 'p/fe', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )
    const { apply } = await import('../index.js')
    const host = mockHost(workspace, dshHome)
    apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const exec = { agent: lead, signal: undefined }
    await tool('squad_enable').execute({}, exec)
    const dispatch = (args) => tool('squad_dispatch').execute(args, exec)
    const settingsStore = createSettingsStore({ filePath: settingsPath })

    // --- validation: worker / leaderWorker must be booleans -----------------
    {
      const base = (await settingsStore.read()).agents
      const badWorker = base.map((agent) => (agent.id === 'codex' ? { ...agent, worker: 'yes' } : agent))
      const checked = validateAgentsAndWorktree(badWorker, { directory: '.agents/worktrees' })
      assert.equal(checked.ok, false)
      assert.equal(checked.fields['agents.codex.worker'], 'WORKER_INVALID')
      const badLeader = validateAgentsAndWorktree(base, { directory: '.agents/worktrees' }, 'yes')
      assert.equal(badLeader.ok, false)
      assert.equal(badLeader.fields.leaderWorker, 'WORKER_INVALID')
      assert.equal(validateAgentsAndWorktree(base, { directory: '.agents/worktrees' }, true).ok, true)
    }

    // --- leaderWorker persists through save/read ---------------------------
    {
      const before = await settingsStore.read()
      assert.equal(before.leaderWorker, false)
      const saved = await settingsStore.save({
        expectedRevision: before.revision,
        agents: before.agents,
        worktree: before.worktree,
        leaderWorker: true,
      })
      assert.equal(saved.leaderWorker, true)
      assert.equal((await settingsStore.read()).leaderWorker, true)
    }

    // --- full-flow task: brain as worker is gated by its capability --------
    const startOut = await tool('squad_start').execute({ goal: 'W', acceptance: 'ok' }, exec)
    const task = /任务 (t-\S+) 已创建/.exec(startOut)[1]
    const dir = join(workspace, '.agent-squad', task)
    await dispatch({ agent: 'codex', message: 'plan', phase: 'design' })
    await writeFile(join(dir, 'PLAN.md'), '# PLAN W\n', 'utf8')
    await tool('squad_approve_plan').execute({ task_id: task }, exec)
    await dispatch({ agent: 'gpt', message: 'spec', phase: 'spec' })

    // codex defaults to worker:false → implement refused with guidance.
    await assert.rejects(
      dispatch({ agent: 'codex', message: 'write code', phase: 'implement' }),
      /完整流程的 implement 需要 worker 能力：codex（brain）的 worker 能力未启用；在设置页开启后即可作为 worker 并行实现。/,
    )
    // Enable codex's worker capability and retry: the brain now implements.
    {
      const snap = await settingsStore.read()
      await settingsStore.save({
        expectedRevision: snap.revision,
        agents: snap.agents.map((agent) => (agent.id === 'codex' ? { ...agent, worker: true } : agent)),
        worktree: snap.worktree,
        leaderWorker: snap.leaderWorker,
      })
    }
    assert.match(await dispatch({ agent: 'codex', message: 'write code', phase: 'implement' }), /已(创建|续跑) codex \[brain\]/)
    let state = JSON.parse(await readFile(join(dir, 'STATE.json'), 'utf8'))
    assert.deepEqual(state.implementers, ['codex'])
    assert.equal(state.codeEpoch, 1)
    // Independence: the implementer cannot sign its own technical acceptance.
    await assert.rejects(
      dispatch({ agent: 'codex', message: 'self sign', phase: 'tech-review' }),
      /codex 已在本任务中写代码，不能签署自己改动的技术验收/,
    )
    // The architect (worker default true) still signs it.
    assert.match(await dispatch({ agent: 'gpt', message: 'tech', phase: 'tech-review' }), /已(创建|续跑) gpt \[architect\]/)
    state = JSON.parse(await readFile(join(dir, 'STATE.json'), 'utf8'))
    assert.equal(state.techReview.reviewer, 'gpt')

    // Worker-role agents stay unimpeded; qoder's charter covers backend too.
    assert.match(await dispatch({ agent: 'qoder', message: 'frontend impl', phase: 'implement' }), /已创建本地子代理 qoder/)
    const qoder = (await settingsStore.read()).agents.find((agent) => agent.id === 'qoder')
    assert.equal(qoder.role, 'worker')
    // Older rows omit `worker`; the runtime defaults worker-role agents to
    // capable (proven by the successful dispatch above).
    // The qoder-specific charter ships with the fallback defaults (a bundle
    // that omits per-agent charters dispatches the generic worker charter).
    const indexForQoder = await readFile(new URL('../index.js', import.meta.url), 'utf8')
    assert.match(indexForQoder, /兼职后端：可承担后端代码（接口\/脚本\/数据层）的实现与测试；前端资源竞争时前端优先。/)

    // --- policy / UI wiring carries the new switches -----------------------
    const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
    const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(indexSource, /leaderWorker/)
    assert.match(indexSource, /任何开启了 worker 能力的角色（含 codex\/gpt/)
    assert.match(clientSource, /leaderWorker/)
    assert.match(clientSource, /fieldWorker/)
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T15 — worker availability gate: probe, quota report, auto substitution. */
test('T15 worker availability probe suspends a quota-limited worker and substitutes', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  try {
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'team', model: '', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'external', model: 'mock-ext', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'external', model: 'mock-ext', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )
    let failProbeFor = 'zcode'
    let failProbeMessage = 'HTTP 429 quota exceeded：额度耗尽'
    const host = mockHost(workspace, dshHome, {
      onExternal: async (_provider, request) => {
        const label = String(request.label ?? '')
        if (label === `probe/${failProbeFor}`) throw new Error(failProbeMessage)
      },
    })
    const { apply } = await import('../index.js')
    apply(host.ctx, { workerProbe: true, agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const exec = { agent: lead, signal: undefined }
    await tool('squad_enable').execute({}, exec)
    const dispatch = (args) => tool('squad_dispatch').execute(args, exec)
    const failoverPath = join(dshHome, 'agent-squad', 'failover.json')
    const probes = () => host.activations.filter((row) => String(row.label ?? '').startsWith('probe/'))

    const startOut = await tool('squad_start').execute({ goal: 'G', acceptance: 'ok' }, exec)
    const task = /任务 (t-\S+) 已创建/.exec(startOut)[1]
    const dir = join(workspace, '.agent-squad', task)
    await dispatch({ agent: 'codex', message: 'plan', phase: 'design' })
    await writeFile(join(dir, 'PLAN.md'), '# PLAN G\n', 'utf8')
    await tool('squad_approve_plan').execute({ task_id: task }, exec)
    await dispatch({ agent: 'gpt', message: 'spec', phase: 'spec' })

    // --- zcode probe hits the quota: report, suspend, substitute qoder ------
    const out = await dispatch({ agent: 'zcode', message: 'impl', phase: 'implement', background: false })
    assert.match(
      out,
      /\[可用性门禁\] zcode 不可用（可用性探测失败：HTTP 429 quota exceeded：额度耗尽）→ 已上报，并自动改由 qoder 执行本轮任务。/,
    )
    assert.match(out, /已记录为不可用（其他轮次也会自动绕开）/)
    assert.match(out, /已外部派发 qoder/)
    const suspended = JSON.parse(await readFile(failoverPath, 'utf8')).suspended
    assert.equal(suspended.zcode.auto, true)
    assert.equal(suspended.zcode.role, 'worker')
    assert.match(suspended.zcode.reason, /可用性探测失败/)
    let state = JSON.parse(await readFile(join(dir, 'STATE.json'), 'utf8'))
    assert.deepEqual(state.dispatches.at(-1).substitutedFrom, ['zcode'])
    assert.match(state.dispatches.at(-1).substitutionReason, /可用性探测失败/)
    assert.equal(state.probes.qoder.ok, true)
    assert.equal(probes().filter((row) => row.label === 'probe/qoder').length, 1)

    // Status surfaces the worker's substitution handover.
    const statusOut = await tool('squad_status').execute({}, exec)
    assert.match(statusOut, /zcode（自 .+；自动；原因：可用性探测失败：.+）→ 派单将自动改由其他 worker 执行/)

    // A later dispatch addressed to the suspended worker auto-routes too.
    const routed = await dispatch({ agent: 'zcode', message: 'impl 2', phase: 'implement', background: false })
    assert.match(routed, /\[可用性门禁\] zcode 不可用（已挂起（自 .+；原因：可用性探测失败：.+））\s*→ 已上报，并自动改由 qoder 执行本轮任务。/)
    // Probe cache: qoder is not re-probed on the second dispatch.
    assert.equal(probes().filter((row) => row.label === 'probe/qoder').length, 1)

    // --- recovery: the worker is usable again after squad_failover ----------
    failProbeFor = 'none'
    const recoverOut = await tool('squad_failover').execute({ agent: 'zcode', recover: true }, exec)
    assert.match(recoverOut, /已解除挂起，恢复正常职责/)
    assert.match(recoverOut, /下次派单恢复由它执行/)
    const back = await dispatch({ agent: 'zcode', message: 'impl 3', phase: 'implement', background: false, probe: true })
    assert.match(back, /已外部派发 zcode/)
    assert.ok(!/\[可用性门禁\]/.test(back))

    // --- non-quota probe failure: note and continue -------------------------
    failProbeFor = 'qoder'
    failProbeMessage = 'network unreachable'
    const warned = await dispatch({ agent: 'qoder', message: 'impl 4', phase: 'implement', background: false, probe: true })
    assert.match(warned, /\[可用性门禁\] qoder 探测异常（非额度类）：network unreachable；继续按计划派发/)
    assert.match(warned, /已外部派发 qoder/)

    // --- probe:false skips the gate -----------------------------------------
    {
      const before = probes().length
      await dispatch({ agent: 'qoder', message: 'impl 5', phase: 'implement', background: false, probe: false })
      assert.equal(probes().length, before)
    }

    // --- no substitute left: the dispatch is refused with a report ----------
    {
      // Suspend both workers through their own probes.
      failProbeFor = 'zcode'
      failProbeMessage = 'HTTP 429 quota exceeded：额度耗尽'
      const subOut = await dispatch({ agent: 'zcode', message: 'x', phase: 'implement', background: false, probe: true })
      assert.match(subOut, /自动改由 qoder 执行本轮任务/)
      failProbeFor = 'qoder'
      await assert.rejects(
        dispatch({ agent: 'qoder', message: 'x', phase: 'implement', background: false, probe: true }),
        /且没有其他可用 worker 可以替代，本轮派单被拒绝/,
      )
    }
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T16 — staged parallel workflow: serial base delivery, feature worktrees, merges. */
test('T16 parallel features branch from the Base branch and merge back after delivery', async () => {
  const root = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  let repo
  try {
    repo = await makeGitRepo(root, 'parallel-repo', 'base', { 'README.md': 'seed\n' })
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'team', model: '', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'local', model: 'p/m1', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'local', model: 'p/fe', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )
    const host = mockHost(repo, dshHome)
    const { apply } = await import('../index.js')
    apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const exec = { agent: lead, signal: undefined }
    await tool('squad_enable').execute({}, exec)
    const dispatch = (args) => tool('squad_dispatch').execute(args, exec)
    const taskDirOf = (task) => join(repo, '.agents', 'worktrees', `squad-${task}`, '.agent-squad', task)
    const readState = async (task) =>
      JSON.parse(await readFile(join(taskDirOf(task), 'STATE.json'), 'utf8'))
    const writeVerdict = async (task, file, verdict) =>
      writeFile(join(taskDirOf(task), file), `# ${file}\n\nVERDICT: ${verdict}\n`, 'utf8')

    // --- serial base phase in the task worktree -----------------------------
    const startOut = await tool('squad_start').execute({ goal: 'P', acceptance: 'ok' }, exec)
    const task = /任务 (t-\S+) 已创建/.exec(startOut)[1]
    const dir = taskDirOf(task)
    let state = await readState(task)
    assert.equal(state.stage, undefined)
    assert.equal(state.worktree.sourceBranch, 'master')
    await dispatch({ agent: 'codex', message: 'plan', phase: 'design' })
    await writeFile(join(dir, 'PLAN.md'), '# PLAN\n', 'utf8')
    await tool('squad_approve_plan').execute({ task_id: task }, exec)
    await dispatch({ agent: 'gpt', message: 'spec', phase: 'spec' })
    await dispatch({ agent: 'zcode', message: 'base impl', phase: 'implement' })
    // Common code lands in the task worktree.
    await writeFile(join(state.worktree.path, 'core.js'), 'module.exports = { core: true }\n', 'utf8')
    // Parallel phase is gated until the base delivery is merged.
    await assert.rejects(
      tool('squad_parallel_start').execute({ features: [{ name: 'a' }] }, exec),
      /并行阶段前必须先交付通用功能：squad_deliver\(\{ summary \}\) 通过验收并把基础层合并到 Base 分支后，再 squad_parallel_start。/,
    )
    // Delivery requires the acceptance gates.
    await assert.rejects(tool('squad_deliver').execute({ summary: 'base' }, exec), /TECH-REVIEW\.md/)

    // --- base acceptance, then deliver to Base ------------------------------
    await writeVerdict(task, 'TECH-REVIEW.md', 'APPROVED')
    await dispatch({ agent: 'gpt', message: 'tech', phase: 'tech-review' })
    await writeVerdict(task, 'REVIEW.md', 'APPROVED')
    await dispatch({ agent: 'codex', message: 'review', phase: 'review' })
    const baseBefore = (await gitOut(repo, ['rev-parse', 'HEAD'])).trim()
    const deliverOut = await tool('squad_deliver').execute({ summary: 'base' }, exec)
    assert.match(deliverOut, /通用功能已交付并合入 Base 分支/)
    assert.match(deliverOut, /squad_parallel_start/)
    const baseAfter = (await gitOut(repo, ['rev-parse', 'HEAD'])).trim()
    assert.notEqual(baseAfter, baseBefore)
    assert.equal(await gitOut(repo, ['show', `${baseAfter}:core.js`]), 'module.exports = { core: true }')
    state = await readState(task)
    assert.equal(state.baseDelivered.summary, 'base')
    assert.equal(state.baseDelivered.commits[0].baseBranch, 'master')
    // A second base delivery is refused.
    await assert.rejects(tool('squad_deliver').execute({ summary: 'again' }, exec), /通用功能已交付合并/)

    // --- parallel phase: feature worktrees from Base -----------------------
    const parallelOut = await tool('squad_parallel_start').execute(
      { features: [{ name: 'feat-a', focus: 'api' }, { name: 'feat-b', focus: 'ui' }] },
      exec,
    )
    assert.match(parallelOut, /并行阶段已开启（Base 分支 master）/)
    assert.match(parallelOut, /feat-a：分支 squad-.*-feat-a/)
    state = await readState(task)
    assert.equal(state.features.length, 2)
    for (const feature of state.features) {
      // Branch point is exactly the delivered Base commit.
      assert.equal(feature.baseCommit, baseAfter)
      assert.ok(await stat(join(feature.path, '.agent-squad', 'current.json')))
    }
    // Feature names are unique and validated.
    await assert.rejects(
      tool('squad_parallel_start').execute({ features: [{ name: 'feat-a' }] }, exec),
      /已存在/,
    )
    await assert.rejects(
      tool('squad_parallel_start').execute({ features: [{ name: 'Bad Name' }] }, exec),
      /feature 名不合法/,
    )

    // --- implement per feature: cwd follows the feature worktree ------------
    const featureAPath = state.features.find((item) => item.name === 'feat-a').path
    const featureBPath = state.features.find((item) => item.name === 'feat-b').path
    assert.match(
      await dispatch({ agent: 'zcode', message: 'impl a', phase: 'implement', feature: 'feat-a' }),
      new RegExp(`workspace=${featureAPath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`),
    )
    assert.match(
      await dispatch({ agent: 'qoder', message: 'impl b', phase: 'implement', feature: 'feat-b' }),
      new RegExp(`workspace=${featureBPath.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`),
    )
    // Without a feature the parallel phase refuses implement.
    await assert.rejects(
      dispatch({ agent: 'zcode', message: 'stray', phase: 'implement' }),
      /并行阶段请用 feature 指定本次实现的特性/,
    )
    // Unknown/merged feature names are rejected.
    await assert.rejects(
      dispatch({ agent: 'zcode', message: 'x', phase: 'implement', feature: 'nope' }),
      /未知 feature "nope"/,
    )

    // --- progress sync: features appear in the layered PROGRESS.md ----------
    {
      const progress = await readFile(join(dir, 'PROGRESS.md'), 'utf8')
      assert.match(progress, /## 进度总览/)
      assert.match(progress, /## 分阶段进度/)
      assert.match(progress, /## 并行特性/)
      assert.match(progress, /feat-a.*zcode implement r1/s)
      assert.match(progress, /feat-b.*qoder implement r1/s)
      assert.match(progress, /## 队员进度/)
    }

    // --- feature delivery merges into Base ---------------------------------
    const featureA = state.features.find((item) => item.name === 'feat-a')
    const featureB = state.features.find((item) => item.name === 'feat-b')
    await writeFile(join(featureA.path, 'a.js'), 'module.exports = 1\n', 'utf8')
    await writeFile(join(featureB.path, 'b.js'), 'module.exports = 2\n', 'utf8')
    const deliverA = await tool('squad_deliver').execute({ feature: 'feat-a' }, exec)
    assert.match(deliverA, /特性 feat-a 已交付并合入 Base 分支 master（合并提交 /)
    assert.equal(await gitOut(repo, ['show', 'master:a.js']), 'module.exports = 1')
    await assert.rejects(
      tool('squad_deliver').execute({ feature: 'feat-a' }, exec),
      /已经交付合并/,
    )
    // finish is refused while feat-b is still unmerged.
    await assert.rejects(tool('squad_finish').execute({ summary: 'nope' }, exec), /仍有未交付合并的并行特性：feat-b/)
    const deliverB = await tool('squad_deliver').execute({ feature: 'feat-b' }, exec)
    assert.match(deliverB, /特性 feat-b 已交付并合入 Base 分支 master/)
    assert.equal(await gitOut(repo, ['show', 'master:b.js']), 'module.exports = 2')

    // --- final acceptance on the merged Base, then close --------------------
    state = await readState(task)
    assert.ok(state.features.every((item) => item.merged))
    await writeVerdict(task, 'TECH-REVIEW.md', 'APPROVED')
    const finalTech = await dispatch({ agent: 'gpt', message: 'final tech', phase: 'tech-review' })
    assert.match(finalTech, new RegExp(`workspace=${repo.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`)) // reviews run on the merged Base
    await writeVerdict(task, 'REVIEW.md', 'APPROVED')
    await dispatch({ agent: 'codex', message: 'final review', phase: 'review' })
    const statusOut = await tool('squad_status').execute({}, exec)
    assert.match(statusOut, /并行：Base 已交付（base @ .+）；特性：feat-a（已合并 .+）、feat-b（已合并 .+）/)
    const finishOut = await tool('squad_finish').execute({ summary: 'parallel done' }, exec)
    assert.match(finishOut, /通用功能已交付/)
    assert.match(finishOut, /特性：feat-a .*已合入 Base/)
    state = await readState(task)
    assert.equal(state.phase, 'done')
    // The merged Base branch carries both features and the common layer.
    assert.equal(await gitOut(repo, ['show', 'master:core.js']), 'module.exports = { core: true }')
    {
      const statusLines = (await gitOut(repo, ['status', '--porcelain']))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && line !== '?? .agents/')
      assert.deepEqual(statusLines, [])
    }
  } finally {
    delete process.env.DSH_HOME
    await cleanupSquadArtifacts([repo]).catch(() => {})
    await rm(root, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})

/** T17 — layered progress with auto-sync at meaningful moments. */
test('T17 status and PROGRESS.md show layered task and teammate progress', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  try {
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 2,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'team', model: '', description: 'b' },
            { id: 'gpt', displayName: 'gpt', role: 'architect', executor: 'team', model: '', description: 'a' },
            { id: 'zcode', displayName: 'zcode', role: 'worker', executor: 'team', model: '', description: 'w' },
            { id: 'qoder', displayName: 'qoder', role: 'worker', executor: 'team', model: '', description: 'w2' },
          ],
          worktree: { directory: '.agents/worktrees' },
        },
        null,
        2,
      ),
      'utf8',
    )
    // Non-git workspace: the task falls back to in-place development.
    const host = mockHost(workspace, dshHome)
    const { apply } = await import('../index.js')
    apply(host.ctx, { workerProbe: false, agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const exec = { agent: lead, signal: undefined }
    await tool('squad_enable').execute({}, exec)
    const dispatch = (args) => tool('squad_dispatch').execute(args, exec)

    const startOut = await tool('squad_start').execute({ goal: 'P', acceptance: 'ok' }, exec)
    const task = /任务 (t-\S+) 已创建/.exec(startOut)[1]
    const dir = join(workspace, '.agent-squad', task)
    const progressPath = join(dir, 'PROGRESS.md')
    const readProgress = () => readFile(progressPath, 'utf8')

    // Created at start: overview + phases + teammates.
    const initial = await readProgress()
    assert.match(initial, /# 任务进度 · t-/)
    assert.match(initial, /自动同步：/)
    assert.match(initial, /## 进度总览/)
    assert.match(initial, /- 阶段：串行阶段（基础层）：phase=design round=1/)
    assert.match(initial, /- 门禁：方案 待批准/)
    assert.match(initial, /## 分阶段进度/)
    assert.match(initial, /业务方案：待 Lead 批准/)
    assert.match(initial, /## 队员进度/)
    assert.match(initial, /codex \[brain\] 空闲 · 尚未派单/)
    assert.match(initial, /zcode \[worker\] 空闲 · 尚未派单/)

    // Design dispatch + approval refresh the progress.
    await dispatch({ agent: 'codex', message: 'plan', phase: 'design' })
    await writeFile(join(dir, 'PLAN.md'), '# PLAN\n', 'utf8')
    await tool('squad_approve_plan').execute({ task_id: task }, exec)
    const afterApprove = await readProgress()
    assert.match(afterApprove, /✓ 业务方案：已批准/)
    assert.match(afterApprove, /codex \[brain\] 空闲 · 最近 design r1 @ /)
    // Status carries the same layered block.
    const status = await tool('squad_status').execute({}, exec)
    assert.match(status, /## 进度总览/)
    assert.match(status, /## 分阶段进度/)
    assert.match(status, /## 队员进度/)

    // Spec + implement advance the phase checklist.
    await dispatch({ agent: 'gpt', message: 'spec', phase: 'spec' })
    assert.match(await readProgress(), /✓ 技术规格：v1（SPEC\.md）/)
    await dispatch({ agent: 'zcode', message: 'impl', phase: 'implement' })
    assert.match(await readProgress(), /✓ 基础层实现：1 轮/)

    // A teammate report syncs progress and carries a compact progress line.
    const zcodeAgent = [...host.agentsById.values()].find((agent) => agent.__membership?.name === 'zcode')
    assert.ok(zcodeAgent)
    const reportOut = await tool('squad_report').execute(
      { status: 'done', summary: 'impl done', next: 'review' },
      { agent: zcodeAgent, signal: undefined },
    )
    assert.match(reportOut, /status=done/)
    const forwarded = host.sent.filter((item) => item.targetId === 'lead-1').at(-1).content[0].text
    assert.match(forwarded, /进度同步：串行阶段（基础层）：phase=implement round=1/)
    const afterReport = await readProgress()
    assert.match(afterReport, /zcode \[worker\] 空闲 · 最近 implement r1 @ /)
    assert.match(afterReport, /自动同步：/)
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})
