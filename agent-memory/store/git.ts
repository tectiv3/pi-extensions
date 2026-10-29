/**
 * Store git plumbing: repo init (§3.1), the advisory repo lock (§3.5) and the
 * commit path (§3.4 step 4).
 *
 * Everything here is synchronous: the write path is synchronous, git is spawned
 * with spawnSync, and the lock needs blocking backoff sleeps anyway.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { gitignorePath, repoLockPath } from './paths.ts'

const GIT_TIMEOUT_MS = 10_000
const DEFAULT_STALE_LOCK_MS = 30_000
/** 6 acquisitions: the first, then one after each backoff. */
const DEFAULT_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600]
const SWEEP_COMMIT_MESSAGE = 'memory: recover uncommitted'
const GITIGNORE_COMMIT_MESSAGE = 'memory: init store'
const GITIGNORE_NAME = '.gitignore'
/** `*.tmp` is deliberately unanchored: temp files are written next to notes (§3.1). */
const GITIGNORE_CONTENT = ['/index.db*', '/access.log*', '/projects.json', '*.tmp', ''].join(
    '\n'
)
const GIT_IDENTITY = { name: 'pi memory', email: 'pi-memory@localhost' }
/**
 * Status codes worth recovering. `A ` is the crash-between-add-and-commit state
 * (§3.3); renames are dropped because both sides of a rename are note paths and
 * the extra NUL token complicates nothing we need.
 */
const DIRTY_CODES = new Set(['??', ' M', 'M ', 'A ', ' A', 'D '])
const NOTE_SCOPE_PREFIXES = ['global/', 'projects/'] as const

export class LockTimeoutError extends Error {
    readonly lockFile: string
    readonly holder: string | undefined

    constructor(lockFile: string, holder?: string, label = 'repo lock') {
        const by = holder && holder.trim() !== '' ? ` (held by ${holder.trim()})` : ''
        super(`timed out waiting for ${label} ${lockFile}${by}`)
        this.name = 'LockTimeoutError'
        this.lockFile = lockFile
        this.holder = holder
    }
}

export interface RepoLock {
    readonly path: string
    readonly pid: number
    /** Pushes the staleness window forward; call it while the critical section runs. */
    heartbeat(): void
}

export interface RepoLockOptions {
    /** `/memory index --force-unlock`: drop whatever lock is there, even a live one. */
    force?: boolean
    staleMs?: number
    retryDelaysMs?: readonly number[]
}

export type CommitStatus = 'committed' | 'already-committed' | 'failed'
export type CommitFailureClass = 'lock' | 'signing' | 'identity' | 'other'

export interface CommitResult {
    status: CommitStatus
    class?: CommitFailureClass
    stderr?: string
}

// ---------------------------------------------------------------------------
// git invocation
// ---------------------------------------------------------------------------

interface GitResult {
    status: number
    stdout: string
    stderr: string
}

function runGit(cwd: string, args: string[]): GitResult {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const stderr =
        result.stderr || (result.error ? `spawn failed: ${result.error.message}` : '')
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr }
}

/** Git work done while holding the lock must refresh the lock's mtime (§3.5). */
function runLockedGit(root: string, args: string[]): GitResult {
    const result = runGit(root, args)
    heldLocks.get(rootKey(root))?.heartbeat()
    return result
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export function initStore(root: string): { created: boolean } {
    fs.mkdirSync(root, { recursive: true })
    const created = !fs.existsSync(path.join(root, '.git'))
    if (created) {
        const init = runGit(root, ['init', '--quiet'])
        if (init.status !== 0) {
            throw new Error(`git init failed in ${root}: ${init.stderr.trim()}`)
        }
    }
    ensureLocalIdentity(root)
    commitGitignore(root)
    return { created }
}

/**
 * The identity failure class is removed by construction: a machine with no
 * global user.name/user.email still commits because the values live in this
 * repo's config. An identity the user already configured is never overwritten.
 */
function ensureLocalIdentity(root: string): void {
    const wanted: [string, string][] = [
        ['user.name', GIT_IDENTITY.name],
        ['user.email', GIT_IDENTITY.email],
    ]
    for (const [key, value] of wanted) {
        if (runGit(root, ['config', '--local', '--get', key]).status === 0) continue
        const set = runGit(root, ['config', '--local', key, value])
        if (set.status !== 0) {
            throw new Error(
                `git config --local ${key} failed in ${root}: ${set.stderr.trim()}`
            )
        }
    }
}

/**
 * `.gitignore` gets its own commit: the §3.3 sweep only looks under `global/`
 * and `projects/`, so an untracked `.gitignore` would leave the store permanently
 * dirty and invisible to recovery. Idempotent through the content check.
 */
function commitGitignore(root: string): void {
    if (!writeGitignore(root)) return
    withRepoLock(root, () => {
        commitPath(root, GITIGNORE_NAME, GITIGNORE_COMMIT_MESSAGE)
    })
}

/** `true` when the file on disk had to be (re)written. */
function writeGitignore(root: string): boolean {
    const target = gitignorePath(root)
    let current = ''
    try {
        current = fs.readFileSync(target, 'utf8')
    } catch {
        // First run: no .gitignore yet, so it is written below.
    }
    if (current === GITIGNORE_CONTENT) return false
    fs.writeFileSync(target, GITIGNORE_CONTENT)
    return true
}

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

/** Root path → live handle, so commitPath can prove it runs inside the lock. */
const heldLocks = new Map<string, RepoLock>()

function rootKey(root: string): string {
    return path.resolve(root)
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

interface LockSnapshot {
    pid: number | null
    content: string
    mtimeMs: number
}

function removeFile(target: string): void {
    try {
        fs.unlinkSync(target)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
}

function readLock(lockPath: string): LockSnapshot | null {
    let content: string
    let mtimeMs: number
    try {
        content = fs.readFileSync(lockPath, 'utf8')
        mtimeMs = fs.statSync(lockPath).mtimeMs
    } catch {
        return null
    }
    return { pid: parseLockPid(content), content, mtimeMs }
}

/**
 * `null` (not 0) for anything unparsable. `Number('') === 0` and
 * `process.kill(0, 0)` signals our own process group, so a blank or partial
 * lock file would read as "held by a live pid" forever — and as "our own pid"
 * on release, which would let a victim delete a thief's lock.
 */
function parseLockPid(content: string): number | null {
    const match = /^\s*(\d+)\b/.exec(content)
    if (!match) return null
    const pid = Number(match[1])
    return Number.isInteger(pid) && pid > 0 ? pid : null
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        // EPERM means the process exists under another user; anything but ESRCH is "alive".
        return (err as NodeJS.ErrnoException).code !== 'ESRCH'
    }
}

function isStale(snapshot: LockSnapshot, staleMs: number, now: number): boolean {
    if (snapshot.pid !== null && !pidAlive(snapshot.pid)) return true
    return now - snapshot.mtimeMs > staleMs
}

function createLock(lockPath: string, content: string): boolean {
    let fd: number
    try {
        fd = fs.openSync(lockPath, 'wx')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw err
    }
    try {
        fs.writeSync(fd, content)
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
    return true
}

/**
 * Takeover is not atomic and does not claim to be (§3.5): re-reading only
 * narrows the window in which we could unlink a lock somebody just recreated.
 */
function takeOver(lockPath: string, stale: LockSnapshot): boolean {
    const current = readLock(lockPath)
    if (current === null) return true
    if (current.content !== stale.content || current.mtimeMs !== stale.mtimeMs) return false
    removeFile(lockPath)
    return true
}

function acquireLock(
    lockPath: string,
    content: string,
    opts: RepoLockOptions,
    label: string
): void {
    const staleMs = opts.staleMs ?? DEFAULT_STALE_LOCK_MS
    const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    let last: LockSnapshot | null = null
    for (let attempt = 0; attempt < delays.length + 1; attempt++) {
        if (attempt === 0 && opts.force) removeFile(lockPath)
        if (createLock(lockPath, content)) return
        const snapshot = readLock(lockPath)
        if (snapshot === null) continue
        last = snapshot
        if (isStale(snapshot, staleMs, Date.now()) && takeOver(lockPath, snapshot)) continue
        if (attempt < delays.length) sleepSync(delays[attempt])
    }
    throw new LockTimeoutError(lockPath, last?.content, label)
}

function lockBelongsTo(lockPath: string, pid: number): boolean {
    return readLock(lockPath)?.pid === pid
}

/**
 * Advisory lock over an arbitrary path, using the §3.5 rules verbatim.
 *
 * Parameterised rather than duplicated: `.access.log.lock` (§7.2) needs the same
 * O_EXCL/pid+ts/30 s-staleness/takeover behaviour, and two implementations would
 * drift. `label` only names the lock in `LockTimeoutError`.
 */
export function withFileLock<T>(
    lockPath: string,
    label: string,
    fn: (lock: RepoLock) => T,
    opts: RepoLockOptions = {}
): T {
    const lockDir = path.dirname(lockPath)
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true })

    const pid = process.pid
    acquireLock(lockPath, `${pid} ${Date.now()}\n`, opts, label)

    const lock: RepoLock = {
        path: lockPath,
        pid,
        heartbeat() {
            // Refreshing a lock we lost would extend the thief's staleness window,
            // and a stolen lock must be left alone entirely.
            if (!lockBelongsTo(lockPath, pid)) return
            try {
                const now = new Date()
                fs.utimesSync(lockPath, now, now)
            } catch {}
        },
    }
    try {
        return fn(lock)
    } finally {
        // Only our own lock is ours to remove; the lock may have been taken over.
        if (lockBelongsTo(lockPath, pid)) removeFile(lockPath)
    }
}

export function withRepoLock<T>(
    root: string,
    fn: (lock: RepoLock) => T,
    opts: RepoLockOptions = {}
): T {
    const key = rootKey(root)
    return withFileLock(
        repoLockPath(root),
        'repo lock',
        lock => {
            // Registered for this root only while held: `commitPath` proves it runs
            // inside the lock, and `runLockedGit` heartbeats the repo lock alone.
            heldLocks.set(key, lock)
            try {
                return fn(lock)
            } finally {
                heldLocks.delete(key)
            }
        },
        opts
    )
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

export function commitPath(root: string, relPath: string, message: string): CommitResult {
    if (!heldLocks.has(rootKey(root))) {
        throw new Error(
            `commitPath(${relPath}) called without the repo lock; wrap it in withRepoLock()`
        )
    }
    return commitPaths(root, [relPath], message)
}

function commitPaths(root: string, relPaths: string[], message: string): CommitResult {
    const headBefore = revParseHead(root)
    // The add is required: a pathspec-only commit cannot commit an untracked file
    // (measured: "pathspec ... did not match any file(s) known to git").
    const add = runLockedGit(root, ['add', '--', ...relPaths])
    const commit = runLockedGit(root, ['commit', '-m', message, '--', ...relPaths])
    return classifyCommit(root, relPaths, headBefore, add, commit)
}

function revParseHead(root: string): string {
    const result = runLockedGit(root, ['rev-parse', 'HEAD'])
    return result.status === 0 ? result.stdout.trim() : ''
}

/**
 * Classification reads repository state, never git's message: with any other
 * uncommitted change in the tree, identical content prints "no changes added to
 * commit" instead of "nothing to commit", and the store is most likely dirty
 * exactly when a concurrent writer exists.
 */
function classifyCommit(
    root: string,
    relPaths: string[],
    headBefore: string,
    add: GitResult,
    commit: GitResult
): CommitResult {
    const headAfter = revParseHead(root)
    if (headAfter !== '' && headAfter !== headBefore) return { status: 'committed' }
    if (relPaths.every(relPath => pathSettled(root, relPath))) {
        return { status: 'already-committed' }
    }
    const stderr = [add.stderr, commit.stderr]
        .map(text => text.trim())
        .filter(text => text !== '')
        .join('\n')
    return { status: 'failed', class: classifyFailure(stderr), stderr }
}

function pathSettled(root: string, relPath: string): boolean {
    const inHead = runLockedGit(root, ['cat-file', '-e', `HEAD:${relPath}`]).status === 0
    if (inHead) {
        // `git diff --quiet` is unsound on its own: it exits 0 for an untracked
        // path and for a path that never existed. Paired with cat-file it means
        // the worktree content matches HEAD.
        return runLockedGit(root, ['diff', '--quiet', 'HEAD', '--', relPath]).status === 0
    }
    if (fs.existsSync(path.join(root, relPath))) return false
    // Absent from HEAD and from the worktree: a landed delete — or a path that
    // never existed, which is not a success. History separates the two.
    return runLockedGit(root, ['log', '-1', '--format=%H', '--', relPath]).stdout.trim() !== ''
}

function classifyFailure(stderr: string): CommitFailureClass {
    const text = stderr.toLowerCase()
    if (/index\.lock|another git process|unable to create .*\.lock/.test(text)) return 'lock'
    if (/author identity unknown|unable to auto-detect email|tell me who you are/.test(text)) {
        return 'identity'
    }
    if (/gpg|signing|secret key/.test(text)) return 'signing'
    return 'other'
}

// ---------------------------------------------------------------------------
// dirty tree
// ---------------------------------------------------------------------------

interface StatusEntry {
    code: string
    path: string
}

function parsePorcelainZ(raw: string): StatusEntry[] {
    const entries: StatusEntry[] = []
    const tokens = raw.split('\0')
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (token.length < 4) continue
        const code = token.slice(0, 2)
        const entryPath = token.slice(3)
        // A rename/copy carries the original path as the next NUL token.
        if (code.startsWith('R') || code.startsWith('C')) i++
        entries.push({ code, path: entryPath })
    }
    return entries
}

export function dirtyNotePaths(root: string): string[] {
    const result = runLockedGit(root, ['status', '--porcelain', '-z'])
    if (result.status !== 0) {
        throw new Error(`git status failed in ${root}: ${result.stderr.trim()}`)
    }
    const dirty: string[] = []
    const seen = new Set<string>()
    for (const entry of parsePorcelainZ(result.stdout)) {
        if (!DIRTY_CODES.has(entry.code)) continue
        if (!NOTE_SCOPE_PREFIXES.some(prefix => entry.path.startsWith(prefix))) continue
        if (seen.has(entry.path)) continue
        seen.add(entry.path)
        dirty.push(entry.path)
    }
    return dirty
}

/**
 * Startup sweep (§3.3). Takes the same lock as the write path: without it the
 * sweep and a writer race on git's shared index, which commits the writer's
 * staged note under the sweep's message.
 *
 * Throws LockTimeoutError when the lock cannot be acquired; the caller decides
 * whether that is fatal (startup skips the sweep instead).
 */
export function sweepUncommitted(root: string): { committed: string[] } {
    if (dirtyNotePaths(root).length === 0) return { committed: [] }
    return withRepoLock(root, lock => {
        lock.heartbeat()
        // Re-read under the lock: a writer may have committed while we waited.
        const pending = dirtyNotePaths(root)
        if (pending.length === 0) return { committed: [] }
        const result = commitPaths(root, pending, SWEEP_COMMIT_MESSAGE)
        return { committed: result.status === 'failed' ? [] : pending }
    })
}
