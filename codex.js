/**
 * Built-in `codex-cli` external SubagentProvider.
 *
 * Wraps the locally installed `codex` CLI (codex exec) as a one-shot
 * external provider — unlike the bundled `subagent-codex` app-server
 * kernel, the CLI tracks the newest models (e.g. gpt-6.2-astra) as soon
 * as the CLI itself is updated. Every start() spawns exactly one process
 * (`codex exec --skip-git-repo-check -m <model> -c
 * model_reasoning_effort="<effort>" -s workspace-write -C <cwd> <prompt>`),
 * captures stdout, and extracts the final agent answer between the
 * `codex` marker line and the trailing `tokens used` block. dispose()
 * terminates the child (SIGTERM, escalating to SIGKILL after one second)
 * and resolves the pending result as aborted. Runs are strictly
 * one-shot: no continuation support, no parent context inheritance.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * Build the codex CLI argument vector for one invocation.
 *
 * @param {string} prompt prompt text, passed as the positional argument.
 * @param {string} cwd working directory for `-C`.
 * @param {{model?: string, reasoningEffort?: string, sandboxMode?: string}} [config]
 *   overrides; defaults are `gpt-6.2-astra`, `xhigh`, `workspace-write`.
 * @returns {string[]} exact argument vector (without the command itself).
 */
export function buildCodexArgs(prompt, cwd, config = {}) {
  const model = config.model ?? 'gpt-6.2-astra'
  const reasoningEffort = config.reasoningEffort ?? 'xhigh'
  const sandboxMode = config.sandboxMode ?? 'workspace-write'
  return [
    'exec',
    '--skip-git-repo-check',
    '-m',
    model,
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`,
    '-s',
    sandboxMode,
    '-C',
    cwd,
    prompt,
  ]
}

/**
 * Extract the final agent answer from `codex exec` stdout.
 *
 * The CLI prints a banner, the user prompt, a `codex` marker line, the
 * final answer, a `tokens used` block, and repeats the answer. The block
 * between the `codex` marker and `tokens used` is the answer; anything
 * unmatched falls back to the trimmed stdout so diagnostics stay visible.
 *
 * @param {string} stdout captured stdout.
 * @returns {string} the final answer text.
 */
export function extractCodexAnswer(stdout) {
  const match = /\ncodex\n([\s\S]*?)\ntokens used\n/.exec(stdout)
  return match !== null ? match[1].trim() : stdout.trim()
}

/** Shared diagnostic template for spawn/child errors. */
function cliErrorDiagnostic(error) {
  return `Codex CLI error: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Create the `codex-cli` SubagentProvider.
 *
 * @param {object} [options]
 * @param {string} [options.command='codex'] executable to run.
 * @param {string} [options.model='gpt-6.2-astra'] model id for `-m`.
 * @param {string} [options.reasoningEffort='xhigh'] effort for
 *   `-c model_reasoning_effort`.
 * @param {string} [options.sandboxMode='workspace-write'] sandbox for `-s`.
 * @param {Function} [options.spawnImpl=spawn] child_process.spawn-compatible
 *   test seam: `(command, args, options) -> ChildProcess`.
 * @returns {object} the provider: `{name, inheritsParentContext, capabilities, start}`.
 */
export function createCodexProvider({
  command = 'codex',
  model = 'gpt-6.2-astra',
  reasoningEffort = 'xhigh',
  sandboxMode = 'workspace-write',
  spawnImpl = spawn,
} = {}) {
  return {
    name: 'codex-cli',
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
          output: [{ type: 'text', text: extractCodexAnswer(stdout) }],
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
        else if (code !== null) settle('error', `Codex CLI exited with code ${code}${suffix}`)
        else if (signal !== null)
          settle('error', `Codex CLI terminated by signal ${signal}${suffix}`)
        else settle('error', `Codex CLI exited without status${suffix}`)
      }

      const killChild = (signalName) => {
        try {
          child.kill(signalName)
        } catch (error) {
          throw new Error(
            `Codex CLI termination failed: ${error instanceof Error ? error.message : String(error)}`,
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
      // child's own listeners are in place (same contract as qoder-cli).
      try {
        child = spawnImpl(
          command,
          buildCodexArgs(prompt, cwd, { model, reasoningEffort, sandboxMode }),
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
      if (request.signal && !settled) request.signal.addEventListener('abort', onAbort)
      // Re-check after installing the listeners to close the race with a
      // signal that fired between the initial check and the spawn.
      if (request.signal?.aborted && !settled) onAbort()

      return { id, result, dispose: runDispose }
    },
  }
}
