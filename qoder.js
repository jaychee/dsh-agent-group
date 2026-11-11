/**
 * Built-in `qoder-cli` external SubagentProvider.
 *
 * Wraps the locally installed `qoderclicn` executable as a one-shot external
 * provider: every start() spawns exactly one CLI process
 * (`qoderclicn -p <prompt> -w <cwd> --permission-mode <mode> [-m <model>]`),
 * captures stdout as the run output, and treats a non-zero exit as an error
 * with a diagnostic. dispose() terminates the child (SIGTERM, escalating to
 * SIGKILL after one second) and resolves the pending result as aborted.
 * Runs are strictly one-shot: there is no continuation support and no parent
 * context inheritance.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * Build the qoder CLI argument vector for one invocation.
 *
 * @param {string} prompt prompt text (joined blocks), passed through as-is.
 * @param {string} cwd working directory, passed through as-is.
 * @param {{permissionMode?: string, model?: string}} [config] optional
 *   overrides; defaults are `accept_edits` and no `-m` flag.
 * @returns {string[]} exact argument vector (without the command itself).
 */
export function buildQoderArgs(prompt, cwd, config = {}) {
  const permissionMode = config.permissionMode ?? 'accept_edits'
  const model = config.model ?? ''
  const args = ['-p', prompt, '-w', cwd, '--permission-mode', permissionMode]
  if (model !== '') args.push('-m', model)
  return args
}

/** Shared diagnostic template for spawn/child errors. */
function cliErrorDiagnostic(error) {
  return `Qoder CLI error: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Create the `qoder-cli` SubagentProvider.
 *
 * @param {object} [options]
 * @param {string} [options.command='qoderclicn'] executable to run.
 * @param {string} [options.permissionMode='accept_edits'] permission mode.
 * @param {string} [options.model=''] model id; empty omits `-m`.
 * @param {Function} [options.spawnImpl=spawn] child_process.spawn-compatible
 *   test seam: `(command, args, options) -> ChildProcess`.
 * @returns {object} the provider: `{name, inheritsParentContext, capabilities, start}`.
 */
export function createQoderProvider({
  command = 'qoderclicn',
  permissionMode = 'accept_edits',
  model = '',
  spawnImpl = spawn,
} = {}) {
  return {
    name: 'qoder-cli',
    inheritsParentContext: false,
    capabilities: {
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    },

    async start(request) {
      const id = randomUUID()
      let settleResult
      const result = new Promise((resolve) => {
        settleResult = resolve
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      let child = null
      let closed = false
      let killTimer = null
      let cleanup = null

      // First terminal state wins; later error/close events never rewrite it.
      const settle = (stopReason, diagnostic) => {
        if (settled) return
        settled = true
        if (killTimer !== null) {
          clearTimeout(killTimer)
          killTimer = null
        }
        if (request.signal) request.signal.removeEventListener('abort', onAbort)
        settleResult({
          output: [{ type: 'text', text: stdout }],
          stopReason,
          ...(diagnostic === undefined ? {} : { diagnostic }),
        })
      }

      const onAbort = () => {
        runDispose().catch(() => {})
      }

      // Kept attached even after settling so a late error never becomes an
      // unhandled 'error' event.
      const onChildError = (error) => {
        // A spawn failure without a pid means no process exists: closed.
        if (!child?.pid) closed = true
        settle('error', cliErrorDiagnostic(error))
      }

      const onClose = (code, signal) => {
        closed = true
        if (killTimer !== null) {
          clearTimeout(killTimer)
          killTimer = null
        }
        if (settled) return
        const suffix = stderr.trim() !== '' ? `: ${stderr.trim()}` : ''
        if (code === 0 && signal === null) settle('completed')
        else if (code !== null) settle('error', `Qoder CLI exited with code ${code}${suffix}`)
        else if (signal !== null) settle('error', `Qoder CLI terminated by signal ${signal}${suffix}`)
        else settle('error', `Qoder CLI exited without status${suffix}`)
      }

      const killChild = (signalName) => {
        try {
          child.kill(signalName)
        } catch (error) {
          throw new Error(
            `Qoder CLI termination failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      const runDispose = () => {
        if (cleanup !== null) return cleanup
        // Already closed (or never spawned): nothing to terminate. Cache the
        // fulfilled promise so later dispose calls reuse the same one.
        if (closed || child === null) {
          cleanup = Promise.resolve(undefined)
          return cleanup
        }
        cleanup = new Promise((resolveCleanup, rejectCleanup) => {
          const finishCleanup = () => resolveCleanup(undefined)
          try {
            // Resolve the pending result as aborted, keeping captured stdout.
            settle('aborted')
            killChild('SIGTERM')
            killTimer = setTimeout(() => {
              if (closed) return
              try {
                killChild('SIGKILL')
              } catch (error) {
                rejectCleanup(error)
              }
            }, 1000)
            if (closed) {
              finishCleanup()
              return
            }
            child.once('close', finishCleanup)
            // A spawn failure without a pid never emits close: it terminates
            // the cleanup through the same completion path — cancel the
            // escalation timer and resolve. This must not depend on `closed`,
            // which the general error listener may already have set.
            child.once('error', () => {
              if (child.pid) return
              closed = true
              if (killTimer !== null) {
                clearTimeout(killTimer)
                killTimer = null
              }
              finishCleanup()
            })
          } catch (error) {
            rejectCleanup(error)
          }
        })
        return cleanup
      }

      const prompt = request.prompt.map((block) => block.text).join('\n')
      const cwd = request.cwd

      // An already-aborted signal skips the spawn entirely.
      if (request.signal?.aborted) {
        settle('aborted')
        return { id, result, dispose: runDispose }
      }

      // The abort listener is installed only AFTER spawn returned and the
      // child's own listeners are in place. Installing it earlier would let a
      // synchronous abort (fired while spawnImpl has not returned yet) run the
      // dispose against a null child and cache an empty "nothing to clean up"
      // cleanup — the just-spawned child would then escape cancellation. The
      // post-install re-check below still catches that abort.
      try {
        child = spawnImpl(
          command,
          buildQoderArgs(prompt, cwd, { permissionMode, model }),
          { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
        )
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('error', onChildError)
        child.on('close', onClose)
      } catch (error) {
        child = null
        closed = true
        settle('error', cliErrorDiagnostic(error))
      }
      // Install the abort listener only for a run that is still live: a
      // synchronous spawn throw settles the result before this point, and a
      // terminal state must leave no abort listener behind.
      if (request.signal && !settled) request.signal.addEventListener('abort', onAbort)
      // Re-check after installing the listeners to close the race with a
      // signal that fired between the initial check and the spawn.
      if (request.signal?.aborted && !settled) onAbort()

      return { id, result, dispose: runDispose }
    },
  }
}
