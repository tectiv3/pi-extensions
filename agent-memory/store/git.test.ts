import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import {
    commitPath,
    dirtyNotePaths,
    initStore,
    LockTimeoutError,
    sweepUncommitted,
    withRepoLock,
} from './git.ts'
import { gitignorePath, repoLockPath } from './paths.ts'

const FAST_RETRY = [1, 1, 1]
const GITIGNORE_EXPECTED = '/index.db*\n/access.log*\n/projects.json\n*.tmp\n'

interface GitOutput {
    status: number | null
    stdout: string
    stderr: string
}

function runGit(root: string, args: string[]): GitOutput {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function makeStore(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-test-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    initStore(root)
    return root
}

function writeNote(root: string, relPath: string, body: string): void {
    const target = path.join(root, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
}

function headOf(root: string): string {
    // An unborn HEAD prints "HEAD" and exits non-zero; the commit id is stdout only on success.
    const result = runGit(root, ['rev-parse', 'HEAD'])
    return result.status === 0 ? result.stdout.trim() : ''
}

function inHead(root: string, relPath: string): boolean {
    return runGit(root, ['cat-file', '-e', `HEAD:${relPath}`]).status === 0
}

function writeLockFile(root: string, content: string, ageMs = 0): string {
    const lockPath = repoLockPath(root)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, content)
    if (ageMs > 0) {
        const when = new Date(Date.now() - ageMs)
        fs.utimesSync(lockPath, when, when)
    }
    return lockPath
}

function isLockTimeout(err: unknown): boolean {
    return err instanceof LockTimeoutError
}

test('initStore is idempotent and writes the exact .gitignore', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-test-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    assert.deepEqual(initStore(root), { created: true })
    assert.deepEqual(initStore(root), { created: false })
    assert.equal(fs.readFileSync(gitignorePath(root), 'utf8'), GITIGNORE_EXPECTED)
    assert.notEqual(
        runGit(root, ['config', '--local', '--get', 'user.name']).stdout.trim(),
        ''
    )
    assert.notEqual(
        runGit(root, ['config', '--local', '--get', 'user.email']).stdout.trim(),
        ''
    )
})

test('initStore commits .gitignore so the store starts clean', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-test-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    initStore(root)
    // The §3.3 sweep only looks under global/ and projects/, so an untracked
    // .gitignore would leave the store permanently dirty.
    assert.equal(inHead(root, '.gitignore'), true)
    assert.equal(runGit(root, ['show', 'HEAD:.gitignore']).stdout, GITIGNORE_EXPECTED)
    assert.equal(runGit(root, ['status', '--porcelain']).stdout.trim(), '')
    assert.equal(fs.existsSync(repoLockPath(root)), false)

    // Idempotent: a second init adds no commit and leaves the file alone.
    const head = headOf(root)
    initStore(root)
    assert.equal(headOf(root), head)
    assert.equal(runGit(root, ['status', '--porcelain']).stdout.trim(), '')
})

test('initStore commits a .gitignore that was on disk but never tracked', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-test-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    // The bug this covers: a store whose .gitignore was written but never
    // committed, which no §3.3 sweep can recover because it only looks under
    // global/ and projects/.
    assert.equal(runGit(root, ['init', '--quiet']).status, 0)
    fs.writeFileSync(gitignorePath(root), 'stale\n')
    assert.equal(headOf(root), '')

    initStore(root)
    assert.equal(fs.readFileSync(gitignorePath(root), 'utf8'), GITIGNORE_EXPECTED)
    assert.notEqual(headOf(root), '')
    assert.equal(inHead(root, '.gitignore'), true)
    assert.equal(runGit(root, ['status', '--porcelain']).stdout.trim(), '')
    assert.equal(fs.existsSync(repoLockPath(root)), false)
})

test('initStore restores a deleted .gitignore without leaving the tree dirty', t => {
    const root = makeStore(t)
    fs.unlinkSync(gitignorePath(root))

    initStore(root)
    assert.equal(fs.readFileSync(gitignorePath(root), 'utf8'), GITIGNORE_EXPECTED)
    assert.equal(runGit(root, ['status', '--porcelain']).stdout.trim(), '')
})

test('a machine without global git identity still commits', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-test-'))
    const saved = {
        global: process.env.GIT_CONFIG_GLOBAL,
        nosystem: process.env.GIT_CONFIG_NOSYSTEM,
        home: process.env.HOME,
    }
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true })
        for (const [key, value] of [
            ['GIT_CONFIG_GLOBAL', saved.global],
            ['GIT_CONFIG_NOSYSTEM', saved.nosystem],
            ['HOME', saved.home],
        ] as const) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    })
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.HOME = root

    initStore(root)
    writeNote(root, 'global/first.md', 'body\n')
    const result = withRepoLock(root, () =>
        commitPath(root, 'global/first.md', 'memory: create')
    )
    assert.equal(result.status, 'committed')
    assert.equal(runGit(root, ['show', 'HEAD:global/first.md']).stdout, 'body\n')
})

test('commits a new file in a repo with no prior commit', t => {
    const root = makeStore(t)
    // initStore commits .gitignore, so recreate the unborn-HEAD state the first
    // write after a fresh clone-less store actually sees.
    assert.equal(runGit(root, ['update-ref', '-d', 'HEAD']).status, 0)
    assert.equal(headOf(root), '')
    writeNote(root, 'global/newdir/new.md', 'fresh\n')

    const result = withRepoLock(root, () =>
        commitPath(root, 'global/newdir/new.md', 'memory: create')
    )
    assert.equal(result.status, 'committed')
    assert.notEqual(headOf(root), '')
    assert.equal(inHead(root, 'global/newdir/new.md'), true)
})

test('commits a modified file and a deleted file', t => {
    const root = makeStore(t)
    writeNote(root, 'global/doc.md', 'v1\n')
    withRepoLock(root, () => {
        assert.equal(
            commitPath(root, 'global/doc.md', 'memory: create doc').status,
            'committed'
        )
    })

    fs.writeFileSync(path.join(root, 'global/doc.md'), 'v2\n')
    const modified = withRepoLock(root, () =>
        commitPath(root, 'global/doc.md', 'memory: update doc')
    )
    assert.equal(modified.status, 'committed')
    assert.equal(runGit(root, ['show', 'HEAD:global/doc.md']).stdout, 'v2\n')

    fs.unlinkSync(path.join(root, 'global/doc.md'))
    const deleted = withRepoLock(root, () =>
        commitPath(root, 'global/doc.md', 'memory: delete doc')
    )
    assert.equal(deleted.status, 'committed')
    assert.equal(inHead(root, 'global/doc.md'), false)

    // Retrying a delete that already landed is a success, and only the note's own
    // history distinguishes it from a path that was never there.
    const retried = withRepoLock(root, () =>
        commitPath(root, 'global/doc.md', 'memory: delete doc')
    )
    assert.equal(retried.status, 'already-committed')
})

test('a dirty tree with foreign staged work still reports already-committed', t => {
    const root = makeStore(t)
    writeNote(root, 'global/a.md', 'A\n')
    withRepoLock(root, () => {
        assert.equal(commitPath(root, 'global/a.md', 'memory: create a').status, 'committed')
    })

    writeNote(root, 'other.txt', 'foreign\n')
    assert.equal(runGit(root, ['add', '--', 'other.txt']).status, 0)
    const headBefore = headOf(root)

    const result = withRepoLock(root, () =>
        commitPath(root, 'global/a.md', 'memory: update a')
    )
    assert.equal(result.status, 'already-committed')
    assert.equal(result.class, undefined)
    assert.equal(headOf(root), headBefore)
    // The foreign staged file must survive: it is not ours to commit.
    assert.match(runGit(root, ['status', '--porcelain']).stdout, /^A {2}other\.txt$/m)

    // Why the classification cannot read git's message: a phrase check here sees
    // "no changes added to commit", not "nothing to commit".
    const probe = runGit(root, ['commit', '-m', 'probe', '--', 'global/a.md'])
    assert.notEqual(probe.status, 0)
    assert.doesNotMatch(probe.stderr, /nothing to commit, working tree clean/)
    assert.equal(headOf(root), headBefore)
})

test('a path that never existed is not certified by git diff --quiet', t => {
    const root = makeStore(t)
    writeNote(root, 'global/a.md', 'A\n')
    withRepoLock(root, () => commitPath(root, 'global/a.md', 'memory: create a'))
    assert.equal(runGit(root, ['diff', '--quiet', 'HEAD', '--', 'global/never.md']).status, 0)

    const result = withRepoLock(root, () =>
        commitPath(root, 'global/never.md', 'memory: update')
    )
    assert.equal(result.status, 'failed')
    assert.equal(result.class, 'other')
})

test('sequential lock acquisitions work and release', t => {
    const root = makeStore(t)
    assert.equal(
        withRepoLock(root, () => 1),
        1
    )
    assert.equal(
        withRepoLock(root, () => 2),
        2
    )
    assert.equal(fs.existsSync(repoLockPath(root)), false)
})

test('a lock held by a dead pid is taken over', t => {
    const root = makeStore(t)
    const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid
    assert.equal(typeof dead, 'number')
    assert.throws(
        () => process.kill(dead as number, 0),
        (err: NodeJS.ErrnoException) => err.code === 'ESRCH'
    )

    writeLockFile(root, `${dead} ${Date.now()}\n`)
    assert.equal(
        withRepoLock(root, () => 'took over'),
        'took over'
    )
    assert.equal(fs.existsSync(repoLockPath(root)), false)
})

test('unparsable lock content is held, never read as pid 0', t => {
    const root = makeStore(t)
    // A blank/partial file must not look like pid 0: process.kill(0, 0) succeeds.
    writeLockFile(root, '')
    assert.throws(
        () => withRepoLock(root, () => 'x', { retryDelaysMs: FAST_RETRY }),
        isLockTimeout
    )
    assert.equal(fs.existsSync(repoLockPath(root)), true)

    writeLockFile(root, 'part')
    assert.throws(
        () => withRepoLock(root, () => 'x', { retryDelaysMs: FAST_RETRY }),
        isLockTimeout
    )
})

test('a live pid with a fresh mtime times out', t => {
    const root = makeStore(t)
    writeLockFile(root, `${process.pid} ${Date.now()}\n`)
    assert.throws(
        () => withRepoLock(root, () => 'x', { retryDelaysMs: FAST_RETRY }),
        isLockTimeout
    )
    assert.equal(fs.existsSync(repoLockPath(root)), true)
})

test('a lock with an old mtime is taken over', t => {
    const root = makeStore(t)
    writeLockFile(root, `${process.pid} ${Date.now()}\n`, 60_000)
    assert.equal(
        withRepoLock(root, () => 'took over'),
        'took over'
    )
})

test('release does not unlink a lock that now holds a different pid', t => {
    const root = makeStore(t)
    const stolen = '4242 1700000000000\n'
    const pid = withRepoLock(root, lock => {
        fs.writeFileSync(lock.path, stolen)
        return lock.pid
    })
    assert.equal(pid, process.pid)
    assert.equal(fs.readFileSync(repoLockPath(root), 'utf8'), stolen)
})

test('force removes a live lock', t => {
    const root = makeStore(t)
    writeLockFile(root, `${process.pid} ${Date.now()}\n`)
    assert.equal(
        withRepoLock(root, () => 'forced', { force: true }),
        'forced'
    )
    assert.equal(fs.existsSync(repoLockPath(root)), false)
})

test('commitPath throws when called without the lock', t => {
    const root = makeStore(t)
    writeNote(root, 'global/x.md', 'x\n')
    assert.throws(
        () => commitPath(root, 'global/x.md', 'memory: create x'),
        /without the repo lock/
    )
})

test('dirtyNotePaths finds note states and ignores store artefacts', t => {
    const root = makeStore(t)
    writeNote(root, 'global/mod.md', 'v1\n')
    writeNote(root, 'global/gone.md', 'v1\n')
    withRepoLock(root, () => {
        assert.equal(
            commitPath(root, 'global/mod.md', 'memory: create mod').status,
            'committed'
        )
        assert.equal(
            commitPath(root, 'global/gone.md', 'memory: create gone').status,
            'committed'
        )
    })

    fs.writeFileSync(path.join(root, 'global/mod.md'), 'v2\n')
    assert.equal(runGit(root, ['rm', '-q', '--', 'global/gone.md']).status, 0)
    writeNote(root, 'global/untracked.md', 'new\n')
    writeNote(root, 'projects/p1/staged.md', 'new\n')
    assert.equal(runGit(root, ['add', '--', 'projects/p1/staged.md']).status, 0)

    writeNote(root, 'index.db', 'x')
    writeNote(root, 'access.log', 'x')
    writeNote(root, 'projects.json', 'x')
    writeNote(root, 'global/notes.tmp', 'x')
    writeNote(root, 'projects/p1/sub/notes.tmp', 'x')
    writeNote(root, 'global/note.md.tmp', 'x')

    const porcelain = runGit(root, ['status', '--porcelain']).stdout
    assert.match(porcelain, /^ M global\/mod\.md$/m)
    assert.match(porcelain, /^D {2}global\/gone\.md$/m)
    assert.match(porcelain, /^\?\? global\/untracked\.md$/m)
    assert.match(porcelain, /^A {2}projects\/p1\/staged\.md$/m)

    assert.deepEqual(dirtyNotePaths(root).sort(), [
        'global/gone.md',
        'global/mod.md',
        'global/untracked.md',
        'projects/p1/staged.md',
    ])
})

test('sweepUncommitted commits leftover notes once, then no-ops', t => {
    const root = makeStore(t)
    assert.deepEqual(sweepUncommitted(root), { committed: [] })

    writeNote(root, 'global/left.md', 'left over\n')
    assert.deepEqual(sweepUncommitted(root), { committed: ['global/left.md'] })
    assert.equal(
        runGit(root, ['log', '-1', '--pretty=%s']).stdout.trim(),
        'memory: recover uncommitted'
    )
    assert.equal(fs.existsSync(repoLockPath(root)), false)

    assert.deepEqual(sweepUncommitted(root), { committed: [] })
})

test('a note key named notes.tmp is not swallowed by the gitignore', t => {
    const root = makeStore(t)
    writeNote(root, 'global/notes.tmp.md', 'a real note\n')
    writeNote(root, 'global/notes.tmp', 'a temp file\n')

    assert.equal(runGit(root, ['check-ignore', '-q', '--', 'global/notes.tmp.md']).status, 1)
    assert.equal(runGit(root, ['check-ignore', '-q', '--', 'global/notes.tmp']).status, 0)
    assert.deepEqual(dirtyNotePaths(root), ['global/notes.tmp.md'])
})
