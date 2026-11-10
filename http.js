/**
 * Loopback-only HTTP surface for the squad settings page.
 *
 * Three routes on the host web server:
 *   GET  /agent-squad/settings → {settings, defaults, warnings}
 *   PUT  /agent-squad/settings → {settings} (409 on revision conflict)
 *   GET  /agent-squad/models   → {groups, externalProviders}
 *
 * Every request must arrive over a loopback socket with a local Host and a
 * same-origin Origin (when present). Anything else gets 403 without touching
 * the store. No CORS is opened.
 */

import { isIP } from 'node:net'
import {
  SettingsError,
  validateAgentsAndWorktree as validateShape,
} from './settings.js'

export const SETTINGS_PATH = '/agent-squad/settings'
export const MODELS_PATH = '/agent-squad/models'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** Strict IPv4 loopback check with no leading-zero or range surprises. */
function isLoopbackIPv4(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (match === null) return false
  const parts = match.slice(1)
  if (parts.some((part) => part.length > 1 && part.startsWith('0'))) return false
  if (parts.some((part) => Number(part) > 255)) return false
  return Number(parts[0]) === 127
}

/**
 * Expand one IPv6 literal into its eight hextets, handling `::` compression
 * and an embedded dotted-IPv4 tail. Returns null when the literal is not a
 * complete, valid IPv6 address (R01).
 */
function expandIPv6(value) {
  let text = value.toLowerCase()
  let tail = null
  const dotted = /^(.*?)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (dotted !== null && dotted[1].endsWith(':')) {
    const parts = dotted[2].split('.')
    if (parts.some((part) => part.length > 1 && part.startsWith('0'))) return null
    if (parts.some((part) => Number(part) > 255)) return null
    const [a, b, c, d] = parts.map(Number)
    tail = [(a << 8) | b, (c << 8) | d]
    text = `${dotted[1]}${tail[0].toString(16)}:${tail[1].toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parseGroups = (part) =>
    part === '' ? [] : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))
  const head = halves.length === 2 ? parseGroups(halves[0]) : parseGroups(text)
  const rest = halves.length === 2 ? parseGroups(halves[1]) : []
  if (head.some(Number.isNaN) || rest.some(Number.isNaN)) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const missing = 8 - head.length - rest.length
  if (missing < 1) return null
  return [...head, ...new Array(missing).fill(0), ...rest]
}

/**
 * Whether an address is loopback: `localhost`, an IPv4 127/8 literal, IPv6
 * `::1` (any equivalent spelling, e.g. `0:0:0:0:0:0:0:0001`), or a valid
 * IPv4-mapped loopback (`::ffff:127.0.0.1`, `::ffff:7f00:1`,
 * `0:0:0:0:0:ffff:7f00:1`). Everything else — including
 * `2001:db8::127.0.0.1` — is refused (R01).
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  let value = address.trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value === 'localhost') return true
  const family = isIP(value)
  if (family === 4) return isLoopbackIPv4(value)
  if (family === 6) {
    const hextets = expandIPv6(value)
    if (hextets === null) return false
    if (hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1) return true
    if (
      hextets.slice(0, 5).every((hextet) => hextet === 0) &&
      hextets[5] === 0xffff
    ) {
      // IPv4-mapped: the last two hextets are the IPv4 bytes.
      return (hextets[6] >> 8) === 127
    }
    return false
  }
  return false
}

/** Strip IPv6 brackets and lowercase one hostname for comparison. */
function normalizeHostname(hostname) {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return host
}

/**
 * Canonical comparison form for a hostname. IPv6 spellings are expanded to
 * eight hextets so `::1`, `0:0:0:0:0:0:0:1` and `0:0:0:0:0:0:0:0001` compare
 * equal; IPv4 and names stay as-is (R01).
 */
function canonicalHostname(hostname) {
  const host = normalizeHostname(hostname)
  if (isIP(host) === 6) {
    const hextets = expandIPv6(host)
    if (hextets !== null) return hextets.map((hextet) => hextet.toString(16)).join(':')
  }
  return host
}

/**
 * Parse one authority header into `{hostname, port}`. `hostname` is
 * normalized (lowercase, no IPv6 brackets); `port` is null when absent.
 * Returns null on malformed input such as `localhost:bad` or a trailing
 * colon (R01).
 */
function parseAuthority(header) {
  if (typeof header !== 'string' || header.trim() === '') return null
  const value = header.trim()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1) return null
    const hostname = value.slice(1, end)
    const rest = value.slice(end + 1)
    if (rest === '') return { hostname: normalizeHostname(hostname), port: null }
    if (!rest.startsWith(':') || rest.length === 1) return null
    return { hostname: normalizeHostname(hostname), port: rest.slice(1) }
  }
  const colon = value.lastIndexOf(':')
  if (colon === -1) return { hostname: normalizeHostname(value), port: null }
  // A bare unbracketed IPv6 literal is not a valid authority host here.
  if (value.indexOf(':') !== colon && isIP(value) === 6) return null
  const hostname = value.slice(0, colon)
  const port = value.slice(colon + 1)
  if (hostname === '') return null
  return { hostname: normalizeHostname(hostname), port }
}

const isValidPort = (port) => /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535

/**
 * Whether one hostname is a local authority: `localhost` or an IP literal
 * that is loopback. Names like `127.attacker.example` are refused (R01).
 */
function isLocalHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false
  const host = normalizeHostname(hostname)
  if (host === 'localhost') return true
  return isIP(host) !== 0 && isLoopbackAddress(host)
}

/**
 * Validate the Host authority against the request: local hostname, a
 * well-formed port, and — when the socket exposes it — an effective port
 * equal to the actually listening port. An omitted Host port resolves to the
 * scheme default (80/443) before the comparison (R01).
 */
function hostMatchesListener(authority, scheme, localPort) {
  if (authority === null) return false
  if (!isLocalHostname(authority.hostname)) return false
  const effective =
    authority.port !== null
      ? isValidPort(authority.port)
        ? Number(authority.port)
        : NaN
      : scheme === 'https:'
        ? 443
        : 80
  if (Number.isNaN(effective)) return false
  if (localPort !== undefined && localPort !== null && effective !== localPort) return false
  return true
}

/**
 * Same-origin check (R01): an Origin header, when present, must be a pure
 * origin (no userinfo, path, query or fragment) whose scheme, hostname and
 * effective port all match the Host authority and the listening socket.
 * `null` origins and different hostnames (`localhost` vs `127.0.0.1`) are
 * rejected.
 */
function isSameOrigin(originHeader, authority, scheme, localPort) {
  if (originHeader === undefined || originHeader === null) return true
  if (originHeader === 'null') return false
  const raw = originHeader.trim()
  // A pure origin is exactly scheme://authority: no userinfo, path, query or
  // fragment. Check the raw header before URL normalization can hide them.
  if (!/^https?:\/\/[^/?#@]+$/i.test(raw)) return false
  let origin
  try {
    origin = new URL(raw)
  } catch {
    return false
  }
  if (origin.protocol !== scheme) return false
  if (origin.username !== '' || origin.password !== '') return false
  if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') return false
  const originHostname = normalizeHostname(origin.hostname)
  if (!isLocalHostname(originHostname)) return false
  if (canonicalHostname(originHostname) !== canonicalHostname(authority.hostname)) return false
  const originPort =
    origin.port !== ''
      ? isValidPort(origin.port)
        ? Number(origin.port)
        : NaN
      : scheme === 'https:'
        ? 443
        : 80
  if (Number.isNaN(originPort)) return false
  const authorityPort =
    authority.port !== null && isValidPort(authority.port)
      ? Number(authority.port)
      : scheme === 'https:'
        ? 443
        : 80
  if (originPort !== authorityPort) return false
  if (localPort !== undefined && localPort !== null && originPort !== localPort) return false
  return true
}

/** Guard + dispatch one request; exported for tests with mock req/res. */
export function createRequestHandler({ store, models }) {
  return async function handle(req, res) {
    const send = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, JSON_HEADERS)
      res.end(text)
    }
    const fail = (status, error) => send(status, { error })

    const remote = req.socket?.remoteAddress
    const localPort = req.socket?.localPort
    const scheme = req.socket?.encrypted ? 'https:' : 'http:'
    const authority = parseAuthority(req.headers?.host)
    const origin = req.headers?.origin
    if (
      !isLoopbackAddress(remote) ||
      !hostMatchesListener(authority, scheme, localPort) ||
      !isSameOrigin(origin, authority, scheme, localPort)
    ) {
      send(403, { error: { code: 'FORBIDDEN', message: 'loopback same-origin requests only', fields: {} } })
      return
    }

    const pathname = (req.url ?? '/').split('?')[0]
    if (pathname === SETTINGS_PATH) {
      if (req.method === 'GET') {
        try {
          const settings = await store.read()
          send(200, {
            settings,
            defaults: store.defaults ? store.defaults() : undefined,
            warnings: [],
          })
        } catch (error) {
          fail(errorStatus(error), errorBody(error))
        }
        return
      }
      if (req.method === 'PUT') {
        let text = ''
        try {
          text = await readBody(req)
        } catch {
          fail(400, { code: 'INVALID_JSON', message: 'request body could not be read', fields: {} })
          return
        }
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          fail(400, { code: 'INVALID_JSON', message: 'request body is not valid JSON', fields: {} })
          return
        }
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !Number.isSafeInteger(parsed.expectedRevision) ||
          parsed.expectedRevision < 1
        ) {
          fail(400, { code: 'REVISION_INVALID', message: 'expectedRevision must be a positive integer', fields: {} })
          return
        }
        try {
          await validateDynamic(parsed.agents, parsed.worktree, models)
          const settings = await store.save({
            expectedRevision: parsed.expectedRevision,
            agents: parsed.agents,
            worktree: parsed.worktree,
          })
          send(200, { settings })
        } catch (error) {
          if (error instanceof SettingsError && error.code === 'REVISION_CONFLICT') {
            send(409, {
              error: { code: 'REVISION_CONFLICT', message: error.message, fields: {} },
              settings: error.current,
            })
            return
          }
          fail(errorStatus(error), errorBody(error))
        }
        return
      }
      send(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET or PUT', fields: {} } })
      return
    }
    if (pathname === MODELS_PATH) {
      if (req.method !== 'GET') {
        send(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET', fields: {} } })
        return
      }
      try {
        send(200, await collectModels(models))
      } catch (error) {
        fail(errorStatus(error), errorBody(error))
      }
      return
    }
    send(404, { error: { code: 'NOT_FOUND', message: 'unknown route', fields: {} } })
  }
}

function errorStatus(error) {
  if (error instanceof SettingsError) return error.status
  if (error?.code === 'CATALOG_UNAVAILABLE') return 503
  return 500
}

function errorBody(error) {
  if (error instanceof SettingsError) {
    return { code: error.code, message: error.message, fields: error.fields ?? {} }
  }
  return { code: error?.code ?? 'INTERNAL', message: error?.message ?? String(error), fields: {} }
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Aggregate the model catalog by provider. One provider's failure keeps the
 * other groups and records the error on that group.
 * @param {object} models `{llm, subagents}` host services.
 */
export async function collectModels(models) {
  const llm = models?.llm
  const subagents = models?.subagents
  if (!llm || typeof llm.listProviders !== 'function') {
    const error = new Error('model directory is not available')
    error.code = 'CATALOG_UNAVAILABLE'
    throw error
  }
  let providers
  try {
    providers = llm.listProviders()
  } catch (cause) {
    const error = new Error(`model directory is not available: ${cause.message}`)
    error.code = 'CATALOG_UNAVAILABLE'
    throw error
  }
  const groups = await Promise.all(
    providers.map(async (provider) => {
      const id = provider.id
      const group = { provider: id, label: provider.name ?? id, models: [] }
      try {
        const listed = await llm.listModels(id)
        group.models = listed.map((model) => ({
          value: `${id}/${model.id}`,
          id: model.id,
          label: model.name ?? model.id,
        }))
      } catch (cause) {
        group.error = cause?.message ?? String(cause)
      }
      return group
    }),
  )
  let externalProviders = []
  if (subagents && typeof subagents.list === 'function') {
    try {
      externalProviders = subagents
        .list()
        .filter((name) => name !== 'spawn' && name !== 'fork')
        .map((name) => ({ id: name, label: name }))
    } catch (cause) {
      const error = new Error(`subagent directory is not available: ${cause.message}`)
      error.code = 'CATALOG_UNAVAILABLE'
      throw error
    }
  }
  return { groups, externalProviders }
}

/** Server-side second-pass validation of dynamic catalog membership. */
async function validateDynamic(agents, worktree, models) {
  const structural = validateStatic(agents, worktree)
  if (structural) throw structural
  const catalog = await collectModels(models)
  for (const agent of agents) {
    if (agent.executor !== 'local' && agent.executor !== 'external') continue
    const field = `agents.${agent.id}.model`
    if (agent.executor === 'local') {
      const group = catalog.groups.find((entry) => entry.provider === agent.model.split('/')[0])
      if (group?.error) {
        // Provider listing failed: a directory fault, not a config error (R12).
        const error = new Error(`model directory for "${group.provider}" is unavailable: ${group.error}`)
        error.code = 'CATALOG_UNAVAILABLE'
        throw error
      }
      if (!group || !group.models.some((model) => model.value === agent.model)) {
        throw new SettingsError('VALIDATION_FAILED', `model "${agent.model}" is not in the catalog`, {
          fields: { [field]: 'MODEL_NOT_FOUND' },
        })
      }
    } else if (!catalog.externalProviders.some((entry) => entry.id === agent.model)) {
      throw new SettingsError('VALIDATION_FAILED', `external provider "${agent.model}" is not registered`, {
        fields: { [field]: 'PROVIDER_NOT_REGISTERED' },
      })
    }
  }
}

function validateStatic(agents, worktree) {
  const checked = validateShape(agents, worktree)
  if (checked.ok) return undefined
  return new SettingsError('VALIDATION_FAILED', checked.message, { fields: checked.fields })
}

/**
 * Register the three routes on the host web server (when mounted).
 * @returns a disposer removing the routes, or undefined when unavailable.
 */
export function registerRoutes({ ctx, store, models }) {
  const webServer = ctx.get('webServer')
  if (!webServer?.register) return undefined
  const handler = createRequestHandler({ store, models })
  const routes = [
    { kind: 'exact', path: SETTINGS_PATH, handler },
    { kind: 'exact', path: MODELS_PATH, handler },
  ]
  // `register()` returns the only disposer; the service has no `unregister`.
  // A previous plugin generation may have leaked these exact routes because an
  // older build discarded the disposer. Keep that handler (it serves the same
  // paths and store) instead of failing activation; a restart clears it.
  const disposers = []
  for (const route of routes) {
    try {
      disposers.push(webServer.register(route))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('duplicate exact route')) {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {}
        }
        throw error
      }
      ctx.logger?.('agent-squad')?.warn?.(
        `route ${route.path} already registered by a previous generation; reusing it`,
      )
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  }
}
