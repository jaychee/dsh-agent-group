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
import { lstat, mkdir, realpath, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

// ---------------------------------------------------------------------------
// Multi-repository support (PLAN-APPROVED §12–§20)
// ---------------------------------------------------------------------------

/** Any filesystem entry — including a dangling symlink — counts as existing. */
async function existsAnyForm(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function registeredWorktreePaths(repo) {
  const out = await git(repo, ['worktree', 'list', '--porcelain'])
  return out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean)
}

async function branchExists(repo, branch) {
  try {
    await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch (error) {
    if (error.code === 1) return false
    throw error
  }
}

/** Deterministic per-repo slug: `<index>-<sanitized basename>` (PLAN §15). */
function repoSlug(index, repo) {
  const name = basename(repo)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${index}-${name || 'repo'}`
}

/**
 * Validate and canonicalize the explicit `repos` list (PLAN §12–§13).
 * Relative entries resolve against `callerSource`; sub-directory and symlink
 * entries are allowed; bare repositories and non-repositories are refused.
 * Duplicate detection uses the realpath of each repository's git-common-dir,
 * so two linked checkouts of one repository are not independent repos.
 */
async function resolveRepositories(callerSource, repos) {
  if (
    !Array.isArray(repos) ||
    repos.length === 0 ||
    repos.some((repo) => typeof repo !== 'string' || repo.trim() === '')
  ) {
    throw new Error('repos must be a non-empty array of non-empty strings')
  }
  const seenCommon = new Map()
  const entries = []
  for (const entry of repos) {
    const resolvedPath = resolve(callerSource, entry)
    let info
    try {
      info = await stat(resolvedPath)
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`repository does not exist: ${resolvedPath}`)
      throw error
    }
    if (!info.isDirectory()) {
      throw new Error(`not a usable Git repository: ${resolvedPath}`)
    }
    let bare
    let toplevel
    try {
      bare = clean(await git(resolvedPath, ['rev-parse', '--is-bare-repository'])) === 'true'
      toplevel = clean(await git(resolvedPath, ['rev-parse', '--show-toplevel']))
    } catch {
      throw new Error(`not a usable Git repository: ${resolvedPath}`)
    }
    if (bare || !toplevel) {
      throw new Error(`not a usable Git repository: ${resolvedPath}`)
    }
    const repo = await realpath(toplevel)
    let common
    try {
      common = clean(
        await git(resolvedPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      )
    } catch {
      const relative = clean(await git(resolvedPath, ['rev-parse', '--git-common-dir']))
      common = resolve(resolvedPath, relative)
    }
    const commonReal = await realpath(common)
    if (seenCommon.has(commonReal)) {
      throw new Error(`duplicate repository: ${repo}`)
    }
    seenCommon.set(commonReal, repo)
    entries.push({ repo, commonDir: commonReal })
  }
  return entries
}

/**
 * Create one squad worktree per repository under a shared task root
 * (PLAN §14–§19). A single explicit repository delegates to the legacy
 * `createSquadWorktree`; multiple repositories run a pre-validated
 * transaction: branches first (ownership is registered the moment a branch
 * exists), then `git worktree add`, and only after every repository
 * succeeded does the session move into the task root. Any mid-flight
 * failure rolls back everything this call created and rethrows with a
 * `multi-repository creation failed:` prefix — never an in-place fallback.
 *
 * @returns {Promise<{taskRoot: string, worktrees: Array<{path: string,
 *   branch: string, repositoryRoot: string, baseCommit: string,
 *   sourceDirectory: string, reused: boolean, repo: string}>}>}
 */
export async function createSquadWorktrees({
  ctx,
  lead,
  sourceDirectory,
  repos,
  taskId,
  directory,
  base = 'HEAD',
  signal,
}) {
  const entries = await resolveRepositories(sourceDirectory, repos)

  if (entries.length === 1) {
    const created = await createSquadWorktree({
      ctx,
      lead,
      sourceDirectory: entries[0].repo,
      taskId,
      directory,
      base,
      signal,
    })
    return {
      taskRoot: created.path,
      worktrees: [{ ...created, repo: entries[0].repo }],
    }
  }

  const primarySource = entries[0].repo
  const branch = `squad-${taskId}`
  const relativeDirectory = safeRelativeDirectory(directory)
  if (relativeDirectory === '.git' || relativeDirectory.startsWith('.git/')) {
    throw new Error('worktree directory must not be inside .git')
  }
  const realRoot = await realpath(primarySource)
  const taskRoot = join(primarySource, relativeDirectory, `squad-${taskId}`)
  const realParent = await realpathBestEffort(dirname(taskRoot))
  if (realParent) {
    const rel = relative(realRoot, realParent)
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep)[0] === '.git') {
      throw new Error(`worktree destination escapes the repository or enters .git: ${taskRoot}`)
    }
  }

  const rows = entries.map((entry, index) => ({
    repo: entry.repo,
    slug: repoSlug(index + 1, entry.repo),
    path: join(taskRoot, repoSlug(index + 1, entry.repo)),
    baseCommit: '',
  }))

  // Pre-checks (PLAN §16–§17): targets (disk + registration), branches, base
  // commits, directory service, cancellation — all before any mutation.
  const registered = []
  for (const entry of entries) registered.push(await registeredWorktreePaths(entry.repo))
  const registeredEverywhere = registered.flat()
  if (await existsAnyForm(taskRoot) || registeredEverywhere.includes(taskRoot)) {
    throw new Error(`worktree target already exists: ${taskRoot}`)
  }
  for (const row of rows) {
    if (await existsAnyForm(row.path) || registeredEverywhere.includes(row.path)) {
      throw new Error(`worktree target already exists: ${row.path}`)
    }
  }
  for (const row of rows) {
    if (await branchExists(row.repo, branch)) {
      throw new Error(`worktree branch already exists in ${row.repo}: ${branch}`)
    }
  }
  for (const row of rows) {
    let baseCommit = ''
    try {
      baseCommit = clean(
        await git(row.repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]),
      )
    } catch {
      throw new Error(`base revision is not a commit in ${row.repo}: ${base}`)
    }
    if (!baseCommit) throw new Error(`base revision is not a commit in ${row.repo}: ${base}`)
    row.baseCommit = baseCommit
  }
  const workingDirectory = ctx.get('workingDirectory')
  if (typeof workingDirectory?.set !== 'function') {
    throw new Error('workingDirectory service is unavailable; cannot enter the squad worktree')
  }
  if (signal?.aborted) throw new Error('worktree creation aborted')

  const owned = []
  let ownsTaskRoot = false
  try {
    await mkdir(dirname(taskRoot), { recursive: true })
    try {
      await mkdir(taskRoot)
      ownsTaskRoot = true
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`worktree target already exists: ${taskRoot}`)
      }
      throw error
    }
    for (const row of rows) {
      if (signal?.aborted) throw new Error('worktree creation aborted')
      await git(row.repo, ['branch', branch, row.baseCommit])
      owned.push(row)
      if (signal?.aborted) throw new Error('worktree creation aborted')
      await git(row.repo, ['worktree', 'add', row.path, branch])
    }
    if (signal?.aborted) throw new Error('worktree creation aborted')
    await workingDirectory.set(lead, taskRoot, signal)
  } catch (cause) {
    // A competing mkdir owns this root; rollback must never touch it.
    if (!ownsTaskRoot) throw cause
    const causeMessage = cause instanceof Error ? cause.message : String(cause)
    let rollbackError
    try {
      await rollbackSquadWorktrees({
        ctx,
        lead,
        sourceDirectory,
        taskRoot,
        worktrees: owned.map((row) => ({
          path: row.path,
          branch,
          repositoryRoot: row.repo,
          baseCommit: row.baseCommit,
          sourceDirectory: row.repo,
          reused: false,
          repo: row.repo,
        })),
      })
    } catch (error) {
      rollbackError = error
    }
    if (rollbackError) {
      const fatal = new Error(
        `multi-repository creation failed: ${causeMessage}; ${rollbackError.message}`,
      )
      fatal.fatal = true
      throw fatal
    }
    throw new Error(`multi-repository creation failed: ${causeMessage}`)
  }

  return {
    taskRoot,
    worktrees: rows.map((row) => ({
      path: row.path,
      branch,
      repositoryRoot: row.repo,
      baseCommit: row.baseCommit,
      sourceDirectory: row.repo,
      reused: false,
      repo: row.repo,
    })),
  }
}

/**
 * Roll back a failed multi-repository creation (PLAN §20). Only rows whose
 * branch this run created are passed in; the last row may still lack its
 * worktree. Order: restore the session cwd first (without a cancelled
 * signal), then per row in reverse — registered targets via
 * `git worktree remove --force`, unregistered leftovers via rm, then
 * `git branch -D`. A row whose removal failed keeps its branch; the task
 * root is removed only when every row cleaned up. Failures aggregate into a
 * fatal `multi-repository rollback failed:` error and never mask the cause.
 *
 * @returns {Promise<void>}
 */
export async function rollbackSquadWorktrees({ ctx, lead, sourceDirectory, taskRoot, worktrees }) {
  const details = []
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory?.set) {
    try {
      await workingDirectory.set(lead, sourceDirectory, undefined)
    } catch (error) {
      details.push(`cwd: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let allRowsClean = true
  for (const row of [...worktrees].reverse()) {
    try {
      const registered = await registeredWorktreePaths(row.repo)
      if (registered.includes(row.path)) {
        await git(row.repo, ['worktree', 'remove', '--force', row.path])
      } else if (await existsAnyForm(row.path)) {
        await rm(row.path, { recursive: true, force: true })
      }
      await git(row.repo, ['branch', '-D', row.branch])
    } catch (error) {
      allRowsClean = false
      details.push(`${row.repo}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (allRowsClean) {
    try {
      await rmdir(taskRoot)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        try {
          await rm(taskRoot, { recursive: true, force: true })
        } catch (removeError) {
          details.push(`root: ${removeError instanceof Error ? removeError.message : String(removeError)}`)
        }
      }
    }
  }
  if (details.length > 0) {
    const error = new Error(`multi-repository rollback failed: ${details.join('; ')}`)
    error.fatal = true
    throw error
  }
  return undefined
}
