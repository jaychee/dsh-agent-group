/**
 * Profile-level squad settings store.
 *
 * One JSON file per DSH profile (`$DSH_HOME/agent-squad/settings.json`) holds
 * the three-agent roster and the worktree directory. Every mutation goes
 * through an in-process serial queue for that file: read → compare revision →
 * validate → write a unique temp file in the same directory → rename. The
 * queue only serializes writers inside this process; multi-host writes to the
 * same file are explicitly not supported.
 */

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** On-disk schema version. v1: three agents; v2: +gpt architect; v3: +opencode worker;
 * v4: role ids renamed (codex→brain, gpt→tester, zcode→worker1, qoder→front1,
 * opencode→worker2) without changing roles/executors/models/reasoning/worker. */
export const SETTINGS_VERSION = 4

/** Fixed, read-only agent ids in display order. */
export const FIXED_IDS = ['brain', 'tester', 'worker1', 'front1', 'worker2']

/** v3 ids mapped to their v4 replacements (order preserved). */
export const LEGACY_IDS = {
  codex: 'brain',
  gpt: 'tester',
  zcode: 'worker1',
  qoder: 'front1',
  opencode: 'worker2',
}

/** Default display names for the v4 fixed ids. */
export const DEFAULT_DISPLAY_NAMES = {
  brain: '大脑',
  tester: '测试者',
  worker1: '后端开发者1',
  front1: '前端开发者1',
  worker2: '后端开发者2',
}

/** Reverse legacy mapping: v4 id → v3 id, for loading older files. */
const LEGACY_ID_BY_NEW = Object.fromEntries(
  Object.entries(LEGACY_IDS).map(([legacy, current]) => [current, legacy]),
)

export const EXECUTORS = ['external', 'local', 'team']

/** Roster roles: brain = business design + technical spec + dual acceptance,
 * tester = test acceptance (review/supplement test cases, run the full suite),
 * worker = implementation. Legacy files carrying 'architect' migrate to
 * 'tester' on load. */
export const ROLES = ['brain', 'tester', 'worker']

/** Reasoning levels exposed by DSH model metadata (pi-ai thinking levels). */
export const REASONING_IDS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Factory defaults: the squad the user pinned — brain/tester/worker1/front1 on
 * local models, worker2 on OpenCode Go; worker is fixed to worker1 (primary
 * backend), worker2 (backup backend) and front1 (frontend-only). */
export const DEFAULT_AGENTS = [
  {
    id: 'brain',
    displayName: '大脑',
    role: 'brain',
    executor: 'local',
    model: 'openai-codex/gpt-6.2-astra',
    reasoning: 'xhigh',
    worker: false,
    description: '业务设计与验收：给出业务方案、对外行为与验收标准，并做业务验收（本地 OpenAI Codex GPT-6.2-Astra，xhigh）。',
  },
  {
    id: 'tester',
    displayName: '测试者',
    role: 'tester',
    executor: 'local',
    model: 'openai/gpt-6.2-sol',
    worker: false,
    description: '测试验收者：依据 brain 的技术实现规格与验收方案审核 worker 的测试用例，不合格时补充测试用例并完整测试（默认不参与实现）。',
  },
  {
    id: 'worker1',
    displayName: '后端开发者1',
    role: 'worker',
    executor: 'local',
    model: 'zai-coding-cn/glm-5.3',
    reasoning: 'max',
    worker: true,
    description: '主力后端 worker：后端任务优先派发；实现后端代码并自测，自测通过后才交付（本地 GLM-5.3，max）。',
  },
  {
    id: 'front1',
    displayName: '前端开发者1',
    role: 'worker',
    executor: 'local',
    model: 'qoder/qmodel_latest',
    reasoning: 'xhigh',
    worker: true,
    description: '前端 worker：固定负责前端页面交互设计、实现与自测，不做后端（本地 Qwen4-Max，xhigh）。',
  },
  {
    id: 'worker2',
    displayName: '后端开发者2',
    role: 'worker',
    executor: 'local',
    model: 'dsh-opencode-go/deepseek-v4.1-flash',
    reasoning: 'max',
    worker: true,
    description: '备份后端 worker：worker1 不可用时接手后端实现与自测（OpenCode Go DeepSeek V4.1 Flash，max，可续跑）。',
  },
]

export const DEFAULT_WORKTREE = { directory: '.agents/worktrees' }

/** Error carrying an HTTP-mappable code, status and field paths. */
export class SettingsError extends Error {
  constructor(code, message, { status = 400, fields = {}, current } = {}) {
    super(message)
    this.name = 'SettingsError'
    this.code = code
    this.status = status
    this.fields = fields
    /** Current settings snapshot carried by REVISION_CONFLICT (409 responses). */
    this.current = current
  }
}

/**
 * Per-file write queues, shared process-wide by normalized path so two store
 * instances over the same file serialize against each other (R03).
 */
const fileQueues = new Map()

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * Validate a worktree directory: non-empty, repo-relative, no absolute path,
 * drive letter, UNC prefix, NUL byte, `.`/`..` segments or backslashes.
 * @returns {null | {code, message}} the error, or null when valid.
 */
export function validateDirectory(value) {
  if (!isNonEmptyString(value)) {
    return { code: 'DIRECTORY_REQUIRED', message: 'worktree directory must be a non-empty string' }
  }
  if (value.includes('\0')) {
    return { code: 'DIRECTORY_INVALID', message: 'worktree directory must not contain NUL bytes' }
  }
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    return { code: 'DIRECTORY_ABSOLUTE', message: 'worktree directory must be relative to the repository' }
  }
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return {
        code: 'DIRECTORY_TRAVERSAL',
        message: 'worktree directory must not contain empty, "." or ".." segments',
      }
    }
  }
  return null
}

/**
 * Structural validation of a full settings value (version/revision excluded).
 * @param {unknown} agents
 * @param {unknown} worktree
 * @returns {{ok: boolean, fields: Record<string, string>, message: string}}
 */
export function validateAgentsAndWorktree(agents, worktree, leaderWorker) {
  const fields = {}
  if (leaderWorker !== undefined && typeof leaderWorker !== 'boolean') {
    fields['leaderWorker'] = 'WORKER_INVALID'
  }
  if (!Array.isArray(agents) || agents.length !== FIXED_IDS.length) {
    return {
      ok: false,
      fields: { agents: 'AGENT_COUNT' },
      message: `agents must be exactly ${FIXED_IDS.length} entries`,
    }
  }
  // Older rosters are structurally invalid for the current version (missing
  // fixed ids); migrateSettings pads every missing id before validation runs.
  const names = []
  for (let index = 0; index < agents.length; index += 1) {
    const entry = agents[index]
    const prefix = `agents.${FIXED_IDS[index]}`
    if (!isPlainObject(entry)) {
      fields[prefix] = 'INVALID_TYPE'
      continue
    }
    const unknown = Object.keys(entry).filter(
      (key) =>
        !['id', 'displayName', 'role', 'executor', 'model', 'reasoning', 'worker', 'description'].includes(
          key,
        ),
    )
    if (unknown.length > 0) fields[prefix] = 'UNKNOWN_FIELD'
    if (entry.id !== FIXED_IDS[index]) fields[`${prefix}.id`] = 'ID_READONLY'
    if (!isNonEmptyString(entry.displayName)) fields[`${prefix}.displayName`] = 'NAME_REQUIRED'
    else names.push(entry.displayName.trim().toLowerCase())
    if (!ROLES.includes(entry.role)) fields[`${prefix}.role`] = 'ROLE_INVALID'
    if (!EXECUTORS.includes(entry.executor)) fields[`${prefix}.executor`] = 'EXECUTOR_INVALID'
    if (typeof entry.model !== 'string') fields[`${prefix}.model`] = 'MODEL_INVALID'
    else if (entry.executor === 'local' && entry.model.split('/').length !== 2) {
      fields[`${prefix}.model`] = 'MODEL_INVALID'
    } else if (entry.executor === 'external' && entry.model.trim() === '') {
      fields[`${prefix}.model`] = 'MODEL_REQUIRED'
    } else if (entry.executor === 'team' && entry.model !== '') {
      fields[`${prefix}.model`] = 'MODEL_MUST_BE_EMPTY'
    }
    if (
      entry.reasoning !== undefined &&
      !['', ...REASONING_IDS].includes(entry.reasoning)
    ) {
      fields[`${prefix}.reasoning`] = 'REASONING_INVALID'
    }
    if (entry.worker !== undefined && typeof entry.worker !== 'boolean') {
      fields[`${prefix}.worker`] = 'WORKER_INVALID'
    }
    if (typeof entry.description !== 'string') fields[`${prefix}.description`] = 'DESCRIPTION_INVALID'
  }
  const seen = new Set()
  for (const name of names) {
    if (seen.has(name)) {
      // Attach the duplicate to whichever row carries it now.
      for (let index = 0; index < agents.length; index += 1) {
        const entry = agents[index]
        if (isPlainObject(entry) && String(entry.displayName ?? '').trim().toLowerCase() === name) {
          fields[`agents.${FIXED_IDS[index]}.displayName`] = 'NAME_DUPLICATE'
        }
      }
    }
    seen.add(name)
  }
  if (
    !names.length ||
    !Array.isArray(agents) ||
    !agents.some(
      (entry) => isPlainObject(entry) && entry.role === 'brain' && isNonEmptyString(entry.displayName),
    )
  ) {
    fields.agents = 'BRAIN_REQUIRED'
  }
  if (!isPlainObject(worktree) || Object.keys(worktree).length !== 1) {
    fields['worktree.directory'] = 'DIRECTORY_REQUIRED'
  } else {
    const error = validateDirectory(worktree.directory)
    if (error) fields['worktree.directory'] = error.code
  }
  const ok = Object.keys(fields).length === 0
  return { ok, fields, message: ok ? '' : 'invalid squad settings' }
}

/** Deep structural check used when loading a file (version included). */
function validateFileShape(value) {
  if (!isPlainObject(value)) return { ok: false, fields: {}, message: 'settings must be an object' }
  if (value.version !== SETTINGS_VERSION) {
    return { ok: false, fields: {}, message: `unknown settings version ${String(value.version)}` }
  }
  const checked = validateAgentsAndWorktree(value.agents, value.worktree, value.leaderWorker)
  return { ...checked, unknownVersion: false }
}

/**
 * Seed the settings shape from the bundle config rows.
 * A pinned `provider/model` wins, then a non-empty external provider, else team.
 * @returns {{agents: Array, worktree: {directory: string}, fallback: boolean}}
 */
export function seedFromBundle(bundleAgents, worktreeDir) {
  const rows = new Map()
  for (const entry of Array.isArray(bundleAgents) ? bundleAgents : []) {
    if (isPlainObject(entry) && FIXED_IDS.includes(entry.name)) {
      rows.set(entry.name, {
        displayName: isNonEmptyString(entry.displayName) ? entry.displayName.trim() : undefined,
        role: ROLES.includes(entry.role) ? entry.role : 'worker',
        worker: typeof entry.worker === 'boolean' ? entry.worker : undefined,
        description: typeof entry.description === 'string' ? entry.description : '',
        provider: String(entry?.provider ?? ''),
        model: String(entry?.model ?? ''),
        reasoning: REASONING_IDS.includes(entry?.reasoning)
          ? entry.reasoning
          : undefined,
      })
    }
  }
  const agents = FIXED_IDS.map((id) => {
    const row = rows.get(id)
    const fallback = DEFAULT_AGENTS.find((agent) => agent.id === id)
    if (!row) return { ...fallback }
    const pinned = row.model.includes('/') && row.model.split('/').length === 2
    const external = !pinned && row.provider !== '' && row.provider !== 'spawn' && row.provider !== 'fork'
    return {
      id,
      displayName: isNonEmptyString(row.displayName)
        ? row.displayName
        : DEFAULT_DISPLAY_NAMES[id] ?? id,
      role: row.role,
      executor: pinned ? 'local' : external ? 'external' : 'team',
      model: pinned ? row.model : external ? row.provider : '',
      worker: row.worker === undefined ? row.role === 'worker' : row.worker,
      ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning }),
      description: row.description,
    }
  })
  const directory = isNonEmptyString(worktreeDir) ? worktreeDir.trim() : DEFAULT_WORKTREE.directory
  const worktree = { directory }
  const checked = validateAgentsAndWorktree(agents, worktree)
  if (!checked.ok) {
    return {
      agents: DEFAULT_AGENTS.map((agent) => ({ ...agent })),
      worktree: { directory: DEFAULT_WORKTREE.directory },
      leaderWorker: false,
      fallback: true,
    }
  }
  return { agents, worktree, leaderWorker: false, fallback: false }
}

/**
 * Migrate a parsed v1/v2/v3 file to the v4 shape: map the old fixed ids to
 * their v4 names, restore the display name for migrated rows (the user asked
 * for the new labels), insert any missing fixed rows from the defaults, and
 * preserve every other user edit and the revision.
 *
 * v1 omitted tester, v2 added it as the architect, v3 added worker2. The same
 * id map covers all three generations, so one pass rebuilds the fixed order.
 */
export function migrateSettings(parsed, defaults) {
  const byId = new Map(
    (Array.isArray(parsed.agents) ? parsed.agents : [])
      .filter((entry) => isPlainObject(entry))
      .map((entry) => [entry.id, entry]),
  )
  const defaultAgent = (id) => defaults?.agents?.find((agent) => agent?.id === id)
  const agents = FIXED_IDS.map((id) => {
    const direct = byId.get(id)
    if (direct !== undefined) {
      // A v4-shaped row already carries the current id: keep its display name
      // (tests and hand-authored files may use custom labels). Legacy rows
      // below get the renamed default label.
      return { ...direct, displayName: isNonEmptyString(direct.displayName) ? direct.displayName : DEFAULT_DISPLAY_NAMES[id] ?? id }
    }
    const legacyId = LEGACY_ID_BY_NEW[id]
    const legacy = legacyId === undefined ? undefined : byId.get(legacyId)
    if (legacy !== undefined) {
      return { ...legacy, id, displayName: DEFAULT_DISPLAY_NAMES[id] ?? legacy.displayName ?? id }
    }
    return { ...defaultAgent(id) }
  }).filter((entry) => entry !== undefined)
  if (agents.length !== FIXED_IDS.length) return undefined
  return { ...parsed, version: SETTINGS_VERSION, agents }
}

/** Default settings file path, honoring $DSH_HOME. */
export function defaultSettingsPath(root) {
  const home = root ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'agent-squad', 'settings.json')
}

function cloneSettings(settings) {
  return JSON.parse(
    JSON.stringify({
      version: settings.version,
      revision: settings.revision,
      agents: settings.agents,
      worktree: settings.worktree,
      leaderWorker: settings.leaderWorker === true,
    }),
  )
}

/**
 * Create (or attach to) the settings store for one file path.
 * @param {object} [options]
 * @param {string} [options.filePath] explicit file path (tests).
 * @param {string} [options.root] DSH home override (tests).
 * @param {object} [options.seed] `{agents, worktree}` from the bundle config.
 * @param {Console} [options.logger] warning sink.
 * @param {() => number} [options.now] clock for corrupt-backup names.
 */
export function createSettingsStore(options = {}) {
  // The file-queue key is the resolved path so different spellings of one file
  // still share the same serial chain (R03).
  const queueKey = resolve(options.filePath ?? defaultSettingsPath(options.root))
  const filePath = options.filePath ?? defaultSettingsPath(options.root)
  const seed = options.seed ?? {
    agents: DEFAULT_AGENTS.map((agent) => ({ ...agent })),
    worktree: { ...DEFAULT_WORKTREE },
  }
  const logger = options.logger
  const now = options.now ?? Date.now

  // The file-queue key is the resolved path so different spellings of one file
  // still share the same serial chain (R03).

  // Effective factory defaults = the validated bundle seed; only an invalid
  // seed falls back to the static all-team roster (R05). Shared by first-seed,
  // corrupt recovery and the HTTP GET defaults payload.
  const seedChecked = validateAgentsAndWorktree(seed.agents, seed.worktree)
  const effectiveDefaults = seedChecked.ok
    ? {
        agents: seed.agents.map((agent) => ({ ...agent })),
        worktree: { directory: seed.worktree.directory },
        leaderWorker: seed.leaderWorker === true,
      }
    : {
        agents: DEFAULT_AGENTS.map((agent) => ({ ...agent })),
        worktree: { directory: DEFAULT_WORKTREE.directory },
        leaderWorker: false,
      }
  const defaultsInvalid = !seedChecked.ok

  const warn = (message) => {
    if (logger?.warn) logger.warn(`agent-squad: ${message}`)
  }

  const readRaw = async () => {
    const text = await readFile(filePath, 'utf8')
    return JSON.parse(text)
  }

  const writeAtomic = async (settings) => {
    const temp = `${filePath}.tmp-${randomUUID()}`
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await rename(temp, filePath)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw new SettingsError('IO_ERROR', `failed to write settings: ${error.message}`, { status: 500 })
    }
  }

  /**
   * Back up a corrupt file before recovery. Backup failure is fatal for the
   * recovery: the original is preserved and an IO_ERROR is raised (R04).
   */
  const backupCorrupt = async () => {
    let backup = `${filePath}.corrupt-${now()}`
    while (true) {
      const taken = await stat(backup).then(
        () => true,
        (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)),
      )
      if (!taken) break
      backup = `${filePath}.corrupt-${now()}-${randomUUID().slice(0, 8)}`
    }
    try {
      await copyFile(filePath, backup)
    } catch (error) {
      throw new SettingsError(
        'IO_ERROR',
        `failed to back up corrupt settings to ${backup}: ${error.message}; original left in place`,
        { status: 500 },
      )
    }
    return backup
  }

  const restoreDefaults = async () => {
    const backup = await backupCorrupt()
    warn(`settings file corrupt; backed up to ${backup} and restored defaults`)
    const fresh = {
      version: SETTINGS_VERSION,
      revision: 1,
      agents: effectiveDefaults.agents,
      worktree: effectiveDefaults.worktree,
      leaderWorker: effectiveDefaults.leaderWorker,
    }
    await writeAtomic(fresh)
    return fresh
  }

  /** Read + repair one file inside the queue. */
  const loadCurrent = async () => {
    let exists
    try {
      exists = await stat(filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new SettingsError('IO_ERROR', `failed to read settings: ${error.message}`, { status: 500 })
      }
      exists = undefined
    }
    if (!exists) {
      if (defaultsInvalid) warn('bundle seed invalid; using factory defaults')
      const fresh = { version: SETTINGS_VERSION, revision: 1, ...cloneable(effectiveDefaults) }
      await writeAtomic(fresh)
      return fresh
    }
    let parsed
    try {
      parsed = await readRaw()
    } catch (error) {
      if (error instanceof SyntaxError) return restoreDefaults()
      throw new SettingsError('IO_ERROR', `cannot read settings: ${error.message}`, { status: 500 })
    }
    if (!isPlainObject(parsed)) {
      throw new SettingsError(
        'UNKNOWN_VERSION',
        `settings version ${String(parsed?.version)} is not supported; file left untouched`,
        { status: 500 },
      )
    }
    // Role migration: the architect role retired (its spec/tech-review duties
    // moved to brain); the tester agent now owns it. Normalize in memory so
    // old files keep validating; the next save persists 'tester'.
    if (Array.isArray(parsed.agents)) {
      let roleChanged = false
      const agents = parsed.agents.map((agent) => {
        if (isPlainObject(agent) && agent.role === 'architect') {
          roleChanged = true
          return { ...agent, role: 'tester' }
        }
        return agent
      })
      if (roleChanged) parsed = { ...parsed, agents }
    }
    if (parsed.version !== SETTINGS_VERSION) {
      // Older files migrate in place: map the renamed fixed ids, insert any
      // missing fixed rows, keep every user edit and the revision, then
      // converge the file to the current version.
      if (![1, 2, 3].includes(parsed.version)) {
        throw new SettingsError(
          'UNKNOWN_VERSION',
          `settings version ${String(parsed?.version)} is not supported; file left untouched`,
          { status: 500 },
        )
      }
      const migrated = migrateSettings(parsed, effectiveDefaults)
      const revisionOk = Number.isSafeInteger(migrated?.revision) && migrated.revision >= 1
      const shapeOk = migrated ? validateAgentsAndWorktree(migrated.agents, migrated.worktree).ok : false
      if (!migrated || !revisionOk || !shapeOk) return restoreDefaults()
      const saved = {
        version: SETTINGS_VERSION,
        revision: migrated.revision,
        agents: migrated.agents.map((agent) => ({ ...agent })),
        worktree: migrated.worktree,
        leaderWorker: effectiveDefaults.leaderWorker,
      }
      await writeAtomic(saved)
      warn(`settings v${parsed.version} migrated to v${SETTINGS_VERSION}: renamed fixed ids and inserted missing rows`)
      return saved
    }
    const checked = validateAgentsAndWorktree(parsed.agents, parsed.worktree, parsed.leaderWorker)
    if (!checked.ok) return restoreDefaults()
    if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 1) return restoreDefaults()
    return {
      version: SETTINGS_VERSION,
      revision: parsed.revision,
      agents: parsed.agents,
      worktree: parsed.worktree,
      leaderWorker: parsed.leaderWorker === true,
    }
  }

  /**
   * Enqueue one store operation on the shared per-file chain (R03). The chain
   * is looked up from the module map at call time so every store instance over
   * this file joins the same tail.
   */
  const enqueue = (operation) => {
    const previous = fileQueues.get(queueKey) ?? Promise.resolve()
    const run = previous.then(operation, operation)
    fileQueues.set(queueKey, run.catch(() => {}))
    return run
  }

  return {
    path: filePath,
    /** Effective factory defaults (validated bundle seed; see R05). */
    defaults: () =>
      JSON.parse(
        JSON.stringify({
          agents: effectiveDefaults.agents,
          worktree: effectiveDefaults.worktree,
          leaderWorker: effectiveDefaults.leaderWorker,
        }),
      ),
    /** Current settings (seeding the file on first read). */
    read: () => enqueue(async () => cloneSettings(await loadCurrent())),
    /**
     * Validate and persist a new roster/directory.
     * @param {object} request `{expectedRevision, agents, worktree}`
     * @returns the saved settings (revision incremented by exactly one).
     */
    save: ({ expectedRevision, agents, worktree, leaderWorker }) =>
      enqueue(async () => {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
          throw new SettingsError('REVISION_INVALID', 'expectedRevision must be a positive integer')
        }
        const checked = validateAgentsAndWorktree(agents, worktree, leaderWorker)
        if (!checked.ok) {
          throw new SettingsError('VALIDATION_FAILED', checked.message || 'invalid settings', {
            fields: checked.fields,
          })
        }
        const current = await loadCurrent()
        if (current.revision !== expectedRevision) {
          throw new SettingsError('REVISION_CONFLICT', 'settings were changed by another writer', {
            status: 409,
            current: cloneSettings(current),
          })
        }
        const saved = {
          version: SETTINGS_VERSION,
          revision: current.revision + 1,
          agents,
          worktree,
          leaderWorker: leaderWorker === true,
        }
        await writeAtomic(saved)
        return cloneSettings(saved)
      }),
    /** Structural validation, exposed for the HTTP layer. */
    validate: validateAgentsAndWorktree,
  }
}

function cloneable({ agents, worktree, leaderWorker }) {
  return { agents, worktree, leaderWorker: leaderWorker === true }
}
