/**
 * Settings-page test suite — exactly seven top-level tests (T01–T07).
 * Run: node --test dsh-agent-squad/test/settings.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const BUNDLE_AGENTS = [
  { name: 'codex', role: 'brain', provider: 'mock-ext', context: 'fresh', description: 'brain' },
  { name: 'zcode', role: 'worker', provider: '', model: 'zai-coding-cn/glm-5.3', context: 'fresh', description: 'worker' },
  { name: 'qoder', role: 'worker', provider: '', model: 'zai-coding-cn/glm-5.3', context: 'fresh', description: 'worker2' },
]

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
  assert.equal(first.version, 1)
  assert.equal(first.revision, 1)
  assert.equal(first.agents.length, 3)
  assert.deepEqual(
    first.agents.map((agent) => [agent.id, agent.executor, agent.model]),
    [
      ['codex', 'external', 'mock-ext'],
      ['zcode', 'local', 'zai-coding-cn/glm-5.3'],
      ['qoder', 'local', 'zai-coding-cn/glm-5.3'],
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

  // Corrupt file → backed up, effective seed (not static defaults) restored (R05).
  await writeFile(filePath, '{ this is not json', 'utf8')
  const recovered = await store.read()
  assert.equal(recovered.revision, 1)
  assert.equal(recovered.agents[0].executor, 'external')
  assert.equal(recovered.agents[1].executor, 'local')
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
    subagents: { list: () => ['spawn', 'codex', 'zcode-cli', 'fork'] },
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
    ['codex', 'zcode-cli'],
  )
})

/** Mock host for T03/T07: minimal surface the plugin's apply() touches. */
function mockHost(workspace, dshHome, hooks = {}) {
  // Tool registrations keep their `when` visibility condition so tests can
  // assert Lead-only registration (squad_approve_plan).
  const registered = []
  const activations = []
  const sent = []
  const spawned = []
  const sections = []
  const members = []
  const createdHandlers = []
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
  const ctx = {
    agentTeams: {
      listMembers: () => members.map((member) => ({ ...member })),
      tryMembership: (agent) => agent.__membership,
      spawnTeammate: async (_lead, request) => {
        spawned.push(request)
        const member = makeAgent(`team-${spawned.length}`, { role: 'teammate', name: request.name })
        members.push({ id: member.id, name: request.name, status: 'inactive' })
        // Host lifecycle: agent/created fires before spawnTeammate resolves.
        for (const handler of createdHandlers) handler({ agent: member })
        return { member }
      },
      sendMessage: async (_lead, message) => {
        sent.push(message)
      },
    },
    agents: {
      list: () => [...agentsById.values()],
      get: (id) => agentsById.get(id),
    },
    tools: { register: (definition, options) => registered.push({ definition, when: options?.when }) },
    get: (name) => {
      if (name === 'workingDirectory') {
        return { get: () => workspace, set: async () => {} }
      }
      if (name === 'subagents') {
        return {
          startActivation: async ({ provider, childId, request }) => {
            childSeq += 1
            const id = childId ?? request?.childId ?? `child-${childSeq}`
            activations.push({ provider, childId: id, request })
            // Test hook: external activations run before the (already
            // resolved) result is awaited, so the mock "agent" can produce
            // PLAN.md synchronously — exactly what an external brain does.
            if (provider !== 'spawn' && hooks.onExternal) {
              await hooks.onExternal(provider, request)
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
          sendMessage: async (_from, childId, content) => {
            sent.push({ childId, content })
          },
        }
      }
      return undefined
    },
    on: (event, handler) => {
      if (event === 'agent/created') createdHandlers.push(handler)
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
  }
  return { ctx, registered, activations, sent, spawned, sections, members, agentsById, makeAgent, dshHome }
}

/** T03 — start/dispatch re-read settings; three executors; live children keep their binding. */
test('T03 dispatch reads fresh settings and routes external/local/team executors', async () => {
  const workspace = await tempRoot()
  const dshHome = await tempRoot()
  process.env.DSH_HOME = dshHome
  try {
    // Pre-write a legal settings file: codex→external(mock-ext), zcode→local(p/m), qoder→team.
    const settingsPath = join(dshHome, 'agent-squad', 'settings.json')
    await mkdir(join(dshHome, 'agent-squad'), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 1,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'external', model: 'mock-ext', description: 'b' },
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
    // The mock external brain writes PLAN.md before its activation resolves.
    const host = mockHost(workspace, dshHome, {
      onExternal: async (_provider, request) => {
        const text = request.prompt.map((block) => block.text).join('')
        const dir = /共享记忆：(\S+)/.exec(text)?.[1]
        if (dir) await writeFile(join(dir, 'PLAN.md'), '# PLAN (mock)\n', 'utf8')
      },
    })
    apply(host.ctx, { agents: BUNDLE_AGENTS })
    const tool = (name) =>
      host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' } }
    const exec = { agent: lead, signal: undefined }

    const startOutput = await tool('squad_start').execute(
      { goal: 'g', acceptance: 'a' },
      exec,
    )
    assert.match(startOutput, /任务 .+ 已创建/)
    assert.match(startOutput, /原地开发/)
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
    assert.deepEqual(host.activations.at(-1).request.agentOptions, { provider: 'p', model: 'm1' })

    // Same binding → resume the same child id.
    const local2 = await tool('squad_dispatch').execute(
      { agent: 'zcode', message: 'rework', phase: 'rework' },
      exec,
    )
    assert.match(local2, /已续跑本地子代理 zcode/)
    assert.equal(host.sent.at(-1).childId, firstChild)

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
    // The spawned member's identity section follows the dispatch snapshot
    // (R08), including the section installed by agent/created firing before
    // spawnTeammate resolved.
    assert.match(host.sections.at(-1), /qoder.*brain 角色/s)
    const qoderBrainSections = host.sections.filter((text) => text.includes('"qoder"'))
    assert.ok(qoderBrainSections.length >= 1)
    for (const text of qoderBrainSections) assert.match(text, /brain 角色/)
    // squad_report uses the same snapshot role, not the current roster (R08).
    const qoderAgent = [...host.agentsById.values()].find((agent) => agent.id.startsWith('team-'))
    const reportOutput = await tool('squad_report').execute(
      { status: 'done', summary: 'ok' },
      { agent: qoderAgent, signal: undefined },
    )
    assert.match(reportOutput, /status=done/)
    assert.match(
      host.sent.filter((item) => item.target === 'lead').at(-1).content[0].text,
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
    host.agentsById.set(firstChild, { id: firstChild, status: 'running' })
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
    host.agentsById.delete(firstChild)

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
    const startB = await tool('squad_start').execute({ goal: 'gB', acceptance: 'aB' }, exec)
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
    host.agentsById.set(firstChild, { id: firstChild, status: 'running' })
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
    host.agentsById.delete(firstChild)
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
    const reportAfterResume = await tool('squad_report').execute(
      { status: 'done', summary: 'ok2' },
      { agent: qoderAgent, signal: undefined },
    )
    assert.match(reportAfterResume, /status=done/)
    assert.match(
      host.sent.filter((item) => item.target === 'lead').at(-1).content[0].text,
      /role=worker/,
    )

    // Idle + changed binding → next dispatch uses the new binding (new child).
    const local3 = await tool('squad_dispatch').execute(
      { agent: 'zcode', message: 'next', phase: 'implement' },
      exec,
    )
    assert.match(local3, /已外部派发/)

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
  const valid = (agents, worktree = { directory: '.agents/worktrees' }) =>
    validateAgentsAndWorktree(agents, worktree)

  assert.equal(valid([validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder')]).ok, true)

  const cases = [
    {
      name: 'wrong count',
      agents: [validAgent('codex', { role: 'brain' }), validAgent('zcode')],
      field: 'agents',
      code: 'AGENT_COUNT',
    },
    {
      name: 'duplicate names',
      agents: [
        validAgent('codex', { role: 'brain', displayName: 'Same' }),
        validAgent('zcode', { displayName: 'same' }),
        validAgent('qoder'),
      ],
      field: 'agents.zcode.displayName',
      code: 'NAME_DUPLICATE',
    },
    {
      name: 'no brain',
      agents: [validAgent('codex'), validAgent('zcode'), validAgent('qoder')],
      field: 'agents',
      code: 'BRAIN_REQUIRED',
    },
    {
      name: 'bad executor',
      agents: [validAgent('codex', { role: 'brain', executor: 'magic' }), validAgent('zcode'), validAgent('qoder')],
      field: 'agents.codex.executor',
      code: 'EXECUTOR_INVALID',
    },
    {
      name: 'local model without provider',
      agents: [validAgent('codex', { role: 'brain' }), validAgent('zcode', { executor: 'local', model: 'nomodel' }), validAgent('qoder')],
      field: 'agents.zcode.model',
      code: 'MODEL_INVALID',
    },
    {
      name: 'changed id',
      agents: [validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('other')],
      field: 'agents.qoder.id',
      code: 'ID_READONLY',
    },
    {
      name: 'absolute directory',
      agents: [validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder')],
      worktree: { directory: '/abs' },
      field: 'worktree.directory',
      code: 'DIRECTORY_ABSOLUTE',
    },
    {
      name: 'traversal directory',
      agents: [validAgent('codex', { role: 'brain' }), validAgent('zcode'), validAgent('qoder')],
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
      agents: [validAgent('codex', { role: 'brain', displayName: 'x' }), validAgent('zcode', { displayName: 'x' }), validAgent('qoder')],
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
          version: 1,
          revision: 1,
          agents: [
            { id: 'codex', displayName: 'codex', role: 'brain', executor: 'external', model: 'mock-ext', description: 'b' },
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
    apply(host.ctx, { agents: BUNDLE_AGENTS })
    const tool = (name) => host.registered.find((entry) => entry.definition.name === name).definition
    const lead = { id: 'lead-1', session: { id: 'session-1' }, __membership: { role: 'lead', name: 'lead' } }
    const teammate = { id: 'te-1', __membership: { role: 'teammate', name: 'zcode' } }
    const exec = { agent: lead, signal: undefined }

    // --- AC3: registration and Lead-only visibility -------------------------
    const names = host.registered.map((entry) => entry.definition.name).sort()
    assert.deepEqual(names, [
      'squad_approve_plan', 'squad_dispatch', 'squad_finish', 'squad_report', 'squad_start', 'squad_status', 'squad_wait',
    ])
    const approveEntry = host.registered.find((entry) => entry.definition.name === 'squad_approve_plan')
    assert.equal(approveEntry.when({ agent: lead }), true)
    assert.equal(approveEntry.when({ agent: teammate }), false)

    // --- AC1: snapshot initialization ---------------------------------------
    const startA = await tool('squad_start').execute({ goal: 'g', acceptance: 'a' }, exec)
    const taskA = /任务 (t-\S+) 已创建/.exec(startA)[1]
    const dirA = join(workspace, '.agent-squad', taskA)
    const readState = async (task) =>
      JSON.parse(await readFile(join(workspace, '.agent-squad', task, 'STATE.json'), 'utf8'))
    const stateA = await readState(taskA)
    assert.equal(stateA.planRequired, true)
    assert.equal(stateA.planRounds, 0)
    assert.equal(stateA.planApproved, false)
    assert.equal(stateA.planApprovedAt, null)
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

    // --- AC4: independence after approval ------------------------------------
    assert.match(await dispatch({ agent: 'zcode', message: 'impl', phase: 'implement' }), /本地子代理 zcode/)
    assert.match(await dispatch({ agent: 'zcode', message: 'fix', phase: 'rework' }), /本地子代理 zcode/)
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
    assert.match(taskMd, /4 次 design 派单，第 5 次被拒绝/)
    assert.match(taskMd, /实现验收只有 `brain` 能批准/)
    assert.match(taskMd, /最多 3 轮、第 4 次被拒绝/)

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
    assert.match(indexSource, /两种批准相互独立/)
    assert.match(clientSource, /flowPlanReview/)
    assert.match(clientSource, /flowPlanLoop/)
    assert.match(clientSource, /flowApprove/)
    assert.match(clientSource, /settings\.section/)
    assert.match(readme, /先审方案再实现|Lead 审核 PLAN/)
    assert.match(readme, /第 4 次/)
    assert.ok(!/6 轮返工|第 7 次/.test(readme))
  } finally {
    delete process.env.DSH_HOME
    await rm(workspace, { recursive: true, force: true })
    await rm(dshHome, { recursive: true, force: true })
  }
})
