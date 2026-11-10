/**
 * Plugin-owned squad worktree creation.
 *
 * `git worktree add -b squad-<taskId> <repo>/<directory>/squad-<taskId> <base>`
 * run with Node argument arrays (never a shell string), then the calling
 * session's working directory moves into the checkout. The configured
 * directory is always repo-relative; absolute paths, `..` segments and `.git`
 * targets are refused before Git runs, and the resolved destination is
 * re-checked (through realpath) to stay inside the repository.
 */

import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

async function git(directory, args) {
  const { stdout } = await runFile('git', ['-C', directory, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

const clean = (text) => String(text ?? '').replace(/\r?\n$/, '')

/** A relative directory without traversal, absolute, drive or UNC forms. */
function safeRelativeDirectory(directory) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new Error('worktree directory must be a non-empty relative path')
  }
  const normalized = directory.replace(/\\/g, '/')
  if (
    isAbsolute(normalized) ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith('//') ||
    normalized.includes('\0')
  ) {
    throw new Error(`worktree directory must be relative to the repository: ${directory}`)
  }
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`worktree directory must not contain "." or ".." segments: ${directory}`)
    }
  }
  return normalized
}

/**
 * Create (or re-enter) the squad worktree for one task.
 *
 * When the session already sits inside a linked worktree, that checkout is
 * reused as-is. Otherwise a fresh branch `squad-<taskId>` is created at `base`
 * under `<repo>/<directory>/` and the session moves in. Failures leave any
 * Git artifacts in place (no deletion) and the session stays in its source
 * directory.
 *
 * @param {object} request
 * @param {object} request.ctx host plugin context (workingDirectory service).
 * @param {object} request.lead the calling Lead agent.
 * @param {string} request.sourceDirectory current session directory.
 * @param {string} request.taskId squad task id.
 * @param {string} request.directory configured repo-relative directory.
 * @param {string} [request.base] base revision (default HEAD).
 * @param {AbortSignal} [request.signal] cancellation.
 * @returns {Promise<{path: string, branch: string, repositoryRoot: string,
 *   baseCommit: string, sourceDirectory: string, reused: boolean}>}
 */
export async function createSquadWorktree({
  ctx,
  lead,
  sourceDirectory,
  taskId,
  directory,
  base = 'HEAD',
  signal,
}) {
  if (signal?.aborted) throw new Error('worktree creation aborted')
  const relativeDirectory = safeRelativeDirectory(directory)
  if (relativeDirectory === '.git' || relativeDirectory.startsWith(`.git/`)) {
    throw new Error('worktree directory must not be inside .git')
  }

  let toplevel
  let commonDir
  try {
    toplevel = clean(await git(sourceDirectory, ['rev-parse', '--show-toplevel']))
    const gitDir = clean(
      await git(sourceDirectory, ['rev-parse', '--path-format=absolute', '--absolute-git-dir']),
    )
    let common
    try {
      common = clean(await git(sourceDirectory, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    } catch {
      const relative = clean(await git(sourceDirectory, ['rev-parse', '--git-common-dir']))
      common = resolve(sourceDirectory, relative)
    }
    commonDir = common
    const alreadyLinked = gitDir !== common
    if (alreadyLinked) {
      const branch = clean(await git(sourceDirectory, ['rev-parse', '--abbrev-ref', 'HEAD']))
      const commit = clean(await git(sourceDirectory, ['rev-parse', 'HEAD']))
      return {
        path: toplevel,
        branch,
        repositoryRoot: dirname(commonDir),
        baseCommit: commit,
        sourceDirectory,
        reused: true,
      }
    }
  } catch (error) {
    throw new Error(`not a usable Git repository (${sourceDirectory}): ${error.message}`)
  }

  const repositoryRoot = toplevel
  const realRoot = await realpath(repositoryRoot)
  const destination = join(repositoryRoot, relativeDirectory, `squad-${taskId}`)
  const destinationRoot = dirname(destination)

  // Refuse symlinked escapes and .git targets by comparing real parents.
  const realParent = await realpathBestEffort(destinationRoot)
  if (realParent) {
    const rel = relative(realRoot, realParent)
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep)[0] === '.git') {
      throw new Error(`worktree destination escapes the repository or enters .git: ${destination}`)
    }
  }
  try {
    const info = await lstat(destination)
    if (info) throw new Error(`worktree target already exists: ${destination}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const baseCommit = clean(
    await git(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]),
  )
  if (!baseCommit) throw new Error(`base revision is not a commit: ${base}`)
  const branch = `squad-${taskId}`
  const branchTaken =
    clean(
      await git(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(
        () => 'yes',
        (error) => (error.code === 1 ? 'no' : Promise.reject(error)),
      ),
    ) === 'yes'
  if (branchTaken) throw new Error(`worktree branch already exists: ${branch}`)

  // The directory service must be available before any Git artifacts are
  // created: without it we could not enter the checkout and would leave an
  // unrecorded worktree behind (R10).
  const workingDirectory = ctx.get('workingDirectory')
  if (!workingDirectory?.set) {
    throw new Error('workingDirectory service is unavailable; cannot enter the squad worktree')
  }

  await git(repositoryRoot, ['worktree', 'add', '-b', branch, destination, baseCommit])

  try {
    await workingDirectory.set(lead, destination, signal)
  } catch (error) {
    // Move failed: restore the source directory; if that also fails the error
    // is fatal so the caller stops instead of degrading silently (R10).
    try {
      await workingDirectory.set(lead, sourceDirectory, signal)
    } catch (restoreError) {
      const fatal = new Error(
        `worktree cwd switch failed (${error.message}) and the source directory could not be restored (${restoreError.message}); session state is inconsistent`,
      )
      fatal.fatal = true
      throw fatal
    }
    throw new Error(
      `worktree created at ${destination} but the session directory could not move: ${error.message}`,
    )
  }
  return {
    path: destination,
    branch,
    repositoryRoot,
    baseCommit,
    sourceDirectory,
    reused: false,
  }
}

async function realpathBestEffort(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      const parent = dirname(path)
      if (parent === path) return undefined
      return realpathBestEffort(parent)
    }
    throw error
  }
}
