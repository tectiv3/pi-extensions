import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { GateContext } from '../gate/gate.ts'
import { EMBED_DIM } from '../index/db.ts'
import { getNoteByKey, searchBm25, writeVector } from '../index/notes.ts'
import { fileHash, parseNote } from './frontmatter.ts'
import {
    AmbiguousEditError,
    type DeleteDenied,
    type DeleteFailed,
    type DeleteOk,
    type EditNoteInput,
    type EmbedJob,
    FrontmatterEditError,
    INDEX_FAILED_MESSAGE,
    NoProjectScopeError,
    NoteNotFoundError,
    StaleNoteError,
    type WriteDenied,
    type WriteFailed,
    type WriteOk,
    type WriteResult,
} from './notes.ts'
import { openStore, type OpenStoreOptions, type Store } from './store.ts'

const GATED_PREFIX = '---\naccess: gated\n---\n'

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function tempDir(t: TestContext, prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

/** The store root comes from `PI_MEMORY_DIR` (§3.1's documented test seam). */
function useStoreDir(t: TestContext): string {
    const dir = tempDir(t, 'pi-memory-store-')
    const saved = process.env.PI_MEMORY_DIR
    process.env.PI_MEMORY_DIR = dir
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_DIR
        else process.env.PI_MEMORY_DIR = saved
    })
    return dir
}

function ensureNotSubagent(t: TestContext): void {
    const saved = process.env.PI_MEMORY_SUBAGENT
    delete process.env.PI_MEMORY_SUBAGENT
    t.after(() => {
        if (saved !== undefined) process.env.PI_MEMORY_SUBAGENT = saved
    })
}

function git(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
    return (result.stdout ?? '').trim()
}

function makeRepo(t: TestContext, remote?: string): string {
    const repo = tempDir(t, 'pi-memory-repo-')
    git(repo, ['init', '--quiet', '-b', 'main'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['config', 'user.email', 'test@localhost'])
    if (remote !== undefined) git(repo, ['remote', 'add', 'origin', remote])
    return repo
}

function makeNonRepo(t: TestContext): string {
    return tempDir(t, 'pi-memory-norepo-')
}

/** A cwd that resolves to the global scope, so omitted `scope` means global. */
function openTestStore(t: TestContext, options: OpenStoreOptions = {}): Store {
    return openStore(makeNonRepo(t), options)
}

interface ConfirmCall {
    title: string
    message: string
}

function approveGate(calls: ConfirmCall[] = []): GateContext {
    return {
        hasUI: true,
        sessionId: 'sess-notes',
        ui: {
            async confirm(title, message) {
                calls.push({ title, message })
                return true
            },
        },
    }
}

function denyGate(calls: ConfirmCall[] = []): GateContext {
    return {
        hasUI: true,
        sessionId: 'sess-notes',
        ui: {
            async confirm(title, message) {
                calls.push({ title, message })
                return false
            },
        },
    }
}

function expectOk(res: WriteResult): WriteOk {
    if (res.ok === true) return res
    throw new Error(`expected a successful write, got ${JSON.stringify(res)}`)
}

function expectDenied(res: WriteResult | DeleteDenied): WriteDenied | DeleteDenied {
    if (res.ok === false && (res.code === 'declined' || res.code === 'denied-no-ui'))
        return res
    throw new Error(`expected a gate denial, got ${JSON.stringify(res)}`)
}

function expectFailed(res: WriteResult | DeleteFailed): WriteFailed | DeleteFailed {
    if (res.ok === false && 'message' in res) return res
    throw new Error(`expected a failed write, got ${JSON.stringify(res)}`)
}

function expectDeleteOk(res: Awaited<ReturnType<Store['deleteNote']>>): DeleteOk {
    if (res.ok === true) return res
    throw new Error(`expected a successful delete, got ${JSON.stringify(res)}`)
}

function commitCount(root: string): number {
    return Number(git(root, ['rev-list', '--count', 'HEAD']))
}

function lastMessage(root: string): string {
    return git(root, ['log', '-1', '--format=%s'])
}

/** Note files plus metadata, ignoring what legitimately changes on its own. */
function treeSnapshot(root: string): string[] {
    const out: string[] = []
    const walk = (dir: string, rel: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
            if (childRel === '.git' || childRel.startsWith('index.db')) continue
            if (childRel.startsWith('access.log')) continue
            if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel)
            else out.push(childRel)
        }
    }
    walk(root, '')
    return out.sort()
}

function notePath(root: string, relPath: string): string {
    return path.join(root, relPath)
}

// ---------------------------------------------------------------------------
// 1. create
// ---------------------------------------------------------------------------

test('create writes a bare file, one commit naming the key, and is searchable at once', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openTestStore(t)
    const body = 'SQLite FTS5 keeps the search index; the store itself is markdown.'

    const res = expectOk(await store.writeNote({ key: 'notes/alpha', body }))

    assert.equal(fs.readFileSync(notePath(root, 'global/notes/alpha.md'), 'utf8'), body)
    assert.equal(res.relPath, 'global/notes/alpha.md')
    assert.equal(res.access, 'open')
    assert.equal(res.project, '')
    assert.equal(commitCount(root), 2, 'git ignore commit plus the note commit')
    assert.equal(lastMessage(root), 'memory: write notes/alpha')

    const row = getNoteByKey(store.db, 'global', '', 'notes/alpha')
    assert.notEqual(row, null)
    assert.equal(row.body, body)
    assert.equal(row.fm_len, 0)
    assert.equal(row.access, 'open')
    assert.equal(row.path, 'global/notes/alpha.md')
    assert.equal(row.body_hash, res.hash)

    const hits = searchBm25(store.db, 'sqlite')
    assert.deepEqual(
        hits.map(hit => hit.key),
        ['notes/alpha']
    )
})

// ---------------------------------------------------------------------------
// 2. gated create, and the decline path
// ---------------------------------------------------------------------------

test('gated create writes the block, round-trips, and a decline touches nothing', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const calls: ConfirmCall[] = []
    const allowed = openStore(makeNonRepo(t), { gate: approveGate(calls) })
    t.after(() => allowed.close())

    const body = 'Tokens rotate at 90 days; refresh on every request.'
    const res = expectOk(
        await allowed.writeNote({
            key: 'auth/session',
            body,
            access: 'gated',
            reason: 'record policy',
        })
    )

    const raw = fs.readFileSync(notePath(root, 'global/auth/session.md'))
    assert.equal(raw.toString('utf8'), `${GATED_PREFIX}${body}`)
    assert.equal(res.access, 'gated')
    const parsed = parseNote(raw)
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.body, body)
    assert.equal(parsed.fmLen, GATED_PREFIX.length)

    assert.equal(calls.length, 1)
    assert.match(calls[0].title, /auth\/session/)
    assert.match(calls[0].message, /record policy/)

    // A second handle on the same store with a denying gate: the state before and
    // after must be identical apart from the log lines.
    const before = treeSnapshot(root)
    const head = git(root, ['rev-parse', 'HEAD'])
    const denying = openStore(makeNonRepo(t), { gate: denyGate() })
    t.after(() => denying.close())

    const denied = expectDenied(
        await denying.writeNote({
            key: 'auth/api_token',
            body: 'never written',
            access: 'gated',
            reason: 'attempt',
        })
    )
    assert.equal(denied.code, 'declined')

    assert.equal(fs.existsSync(notePath(root, 'global/auth/api_token.md')), false)
    assert.equal(git(root, ['rev-parse', 'HEAD']), head)
    assert.deepEqual(treeSnapshot(root), before)
    assert.equal(git(root, ['status', '--porcelain']), '')
    // The attempt is still recorded (§7.3) — that is the only change.
    assert.match(fs.readFileSync(path.join(root, 'access.log'), 'utf8'), /declined/)
})

// ---------------------------------------------------------------------------
// 3. access preservation (§12.12)
// ---------------------------------------------------------------------------

test('a full-body replace without access keeps a gated note gated', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openStore(makeNonRepo(t), { gate: approveGate() })
    t.after(() => store.close())

    expectOk(await store.writeNote({ key: 'notes/page', body: 'first' }))
    expectOk(
        await store.writeNote({
            key: 'notes/page',
            body: 'second',
            access: 'gated',
            reason: 'flip to gated',
        })
    )
    const replaced = expectOk(
        await store.writeNote({ key: 'notes/page', body: 'third', reason: 'replace body' })
    )

    assert.equal(replaced.access, 'gated')
    const parsed = parseNote(fs.readFileSync(notePath(root, 'global/notes/page.md')))
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.body, 'third')
    assert.equal(getNoteByKey(store.db, 'global', '', 'notes/page').access, 'gated')
})

// ---------------------------------------------------------------------------
// 4. baseHash
// ---------------------------------------------------------------------------

test('a stale baseHash is rejected and leaves the file alone', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openTestStore(t)

    expectOk(await store.writeNote({ key: 'notes/hash', body: 'v1' }))
    const snapshot = store.readNote({ key: 'notes/hash' })
    const commits = commitCount(root)

    await assert.rejects(
        store.writeNote({ key: 'notes/hash', body: 'v2', baseHash: 'deadbeef' }),
        (err: unknown) =>
            err instanceof StaleNoteError &&
            err.expected === 'deadbeef' &&
            err.actual === snapshot.hash &&
            err.message === `note changed since read (deadbeef → ${snapshot.hash}); re-read`
    )

    assert.equal(fs.readFileSync(notePath(root, 'global/notes/hash.md'), 'utf8'), 'v1')
    assert.equal(commitCount(root), commits)

    // The precondition is a comparison, not a refusal to update.
    const updated = expectOk(
        await store.writeNote({ key: 'notes/hash', body: 'v2', baseHash: snapshot.hash })
    )
    assert.notEqual(updated.hash, snapshot.hash)
})

// ---------------------------------------------------------------------------
// 5–7. edit
// ---------------------------------------------------------------------------

test('edit rejects an oldText that matches twice and leaves the file alone', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openTestStore(t)

    expectOk(await store.writeNote({ key: 'notes/dup', body: 'alpha beta alpha' }))
    const snapshot = store.readNote({ key: 'notes/dup' })
    const commits = commitCount(root)

    const input: EditNoteInput = {
        key: 'notes/dup',
        oldText: 'alpha',
        newText: 'gamma',
        baseHash: snapshot.hash,
    }
    await assert.rejects(
        store.editNote(input),
        (err: unknown) => err instanceof AmbiguousEditError && err.count === 2
    )
    assert.equal(
        fs.readFileSync(notePath(root, 'global/notes/dup.md'), 'utf8'),
        'alpha beta alpha'
    )
    assert.equal(commitCount(root), commits)
})

test('edit rejects a match inside the frontmatter', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openStore(makeNonRepo(t), { gate: approveGate() })
    t.after(() => store.close())

    expectOk(
        await store.writeNote({
            key: 'notes/fm',
            body: 'body only',
            access: 'gated',
            reason: 'gated fixture',
        })
    )
    const snapshot = store.readNote({ key: 'notes/fm' })
    assert.equal(snapshot.access, 'gated')

    await assert.rejects(
        store.editNote({
            key: 'notes/fm',
            oldText: 'access: gated',
            newText: 'access: open',
            baseHash: snapshot.hash,
        }),
        (err: unknown) => err instanceof FrontmatterEditError
    )
    assert.equal(
        fs.readFileSync(notePath(root, 'global/notes/fm.md'), 'utf8'),
        `${GATED_PREFIX}body only`
    )
})

test('edit commits once, changes the body and preserves access', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openStore(makeNonRepo(t), { gate: approveGate() })
    t.after(() => store.close())

    expectOk(
        await store.writeNote({
            key: 'notes/rotate',
            body: 'tokens rotate every 90 days',
            access: 'gated',
            reason: 'gated fixture',
        })
    )
    const snapshot = store.readNote({ key: 'notes/rotate' })
    const commits = commitCount(root)

    const res = expectOk(
        await store.editNote({
            key: 'notes/rotate',
            oldText: '90 days',
            newText: '60 days',
            baseHash: snapshot.hash,
            reason: 'policy change',
        })
    )

    assert.equal(commitCount(root), commits + 1)
    assert.equal(lastMessage(root), 'memory: edit notes/rotate')
    assert.equal(res.access, 'gated')
    const parsed = parseNote(fs.readFileSync(notePath(root, 'global/notes/rotate.md')))
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.body, 'tokens rotate every 60 days')
    assert.equal(getNoteByKey(store.db, 'global', '', 'notes/rotate').access, 'gated')
})

// ---------------------------------------------------------------------------
// 8. delete
// ---------------------------------------------------------------------------

test('delete removes the file, commits, and clears notes, notes_fts and vec_notes', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openTestStore(t)

    const created = expectOk(
        await store.writeNote({ key: 'notes/gone', body: 'zanzibar token body' })
    )
    const embedding = new Array<number>(EMBED_DIM).fill(0)
    embedding[0] = 1
    writeVector(store.db, created.id, embedding)
    assert.equal(countRows(store, 'vec_notes'), 1)

    const commits = commitCount(root)
    const res = expectDeleteOk(await store.deleteNote({ key: 'notes/gone' }))

    assert.equal(res.key, 'notes/gone')
    assert.equal(fs.existsSync(notePath(root, 'global/notes/gone.md')), false)
    assert.equal(commitCount(root), commits + 1)
    assert.equal(lastMessage(root), 'memory: delete notes/gone')
    assert.equal(countRows(store, 'notes'), 0)
    assert.equal(countRows(store, 'vec_notes'), 0)
    assert.equal(
        Number(
            store.db
                .prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?')
                .get('zanzibar').n
        ),
        0
    )
})

function countRows(store: Store, table: string): number {
    return Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)
}

// ---------------------------------------------------------------------------
// 9. scope resolution
// ---------------------------------------------------------------------------

test('scope resolution follows §5.1', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const repo = makeRepo(t, 'git@github.com:Owner/Repo.git')
    const store = openStore(repo, { gate: approveGate() })
    t.after(() => store.close())

    const project = expectOk(
        await store.writeNote({ key: 'notes/scoped', body: 'project body' })
    )
    assert.equal(project.scope, 'project')
    assert.match(project.project, /^repo-[0-9a-f]{8}$/)
    assert.equal(project.relPath, `projects/${project.project}/notes/scoped.md`)

    // §3.4 step 1a: first use registers the project.
    const projectsJson = JSON.parse(
        fs.readFileSync(path.join(store.root, 'projects.json'), 'utf8')
    )
    assert.equal(projectsJson[project.project].name, 'repo')
    assert.equal(projectsJson[project.project].path, fs.realpathSync(repo))
    assert.equal(projectsJson[project.project].remote, 'github.com/owner/repo')

    // The same key in both scopes: from a repository, the project note wins.
    const global = expectOk(
        await store.writeNote({ key: 'notes/scoped', body: 'global body', scope: 'global' })
    )
    assert.equal(global.scope, 'global')
    assert.equal(store.readNote({ key: 'notes/scoped' }).body, 'project body')
    assert.equal(store.readNote({ key: 'notes/scoped', scope: 'global' }).body, 'global body')

    // A cwd outside any work tree has no project scope (§5.1, exact message).
    const outside = openStore(makeNonRepo(t), { gate: approveGate() })
    t.after(() => outside.close())
    await assert.rejects(
        outside.writeNote({ key: 'notes/scoped', body: 'x', scope: 'project' }),
        (err: unknown) =>
            err instanceof NoProjectScopeError &&
            err.message === 'not in a git repository; no project scope'
    )
    assert.throws(
        () => outside.readNote({ key: 'nope', scope: 'project' }),
        NoProjectScopeError
    )

    // …and global still works there.
    const globalOnly = expectOk(
        await outside.writeNote({ key: 'notes/global_only', body: 'fine', scope: 'global' })
    )
    assert.equal(globalOnly.scope, 'global')
})

// ---------------------------------------------------------------------------
// 10. embedding jobs
// ---------------------------------------------------------------------------

test('enqueueEmbed receives (scope, project, key, body_hash) and never an id', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const jobs: EmbedJob[] = []
    const store = openTestStore(t, { enqueueEmbed: job => jobs.push(job) })

    const created = expectOk(await store.writeNote({ key: 'notes/embed', body: 'first body' }))
    assert.equal(jobs.length, 1)
    assert.deepEqual(Object.keys(jobs[0]).sort(), ['bodyHash', 'key', 'project', 'scope'])
    assert.equal(jobs[0].scope, 'global')
    assert.equal(jobs[0].project, '')
    assert.equal(jobs[0].key, 'notes/embed')
    assert.equal(jobs[0].bodyHash.length, 64)
    assert.equal(
        jobs[0].bodyHash,
        fileHash(fs.readFileSync(notePath(store.root, 'global/notes/embed.md')))
    )
    assert.notEqual(jobs[0].bodyHash, String(created.id))

    const edited = expectOk(await store.writeNote({ key: 'notes/embed', body: 'second body' }))
    assert.equal(jobs.length, 2)
    assert.notEqual(jobs[1].bodyHash, jobs[0].bodyHash)
    assert.equal(
        jobs[1].bodyHash,
        fileHash(fs.readFileSync(notePath(store.root, 'global/notes/embed.md')))
    )
    assert.equal(edited.id, created.id, 'an update keeps the row id')
})

// ---------------------------------------------------------------------------
// 12. index failure
// ---------------------------------------------------------------------------

test('a failed index upsert returns the §3.4 step 5 error, not success', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)
    const body = 'committed but unindexed'

    // Closing the handle poisons the upsert while leaving file and git intact.
    store.db.close()
    const failed = expectFailed(await store.writeNote({ key: 'notes/unindexed', body }))

    assert.equal(failed.code, 'index-failed')
    assert.equal(failed.message, INDEX_FAILED_MESSAGE)
    assert.equal(
        fs.readFileSync(notePath(store.root, 'global/notes/unindexed.md'), 'utf8'),
        body
    )
    assert.equal(lastMessage(store.root), 'memory: write notes/unindexed')
})

// ---------------------------------------------------------------------------
// 13. sweep
// ---------------------------------------------------------------------------

test('sweep commits a leftover untracked note', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)

    const leftover = notePath(store.root, 'global/leftover.md')
    fs.mkdirSync(path.dirname(leftover), { recursive: true })
    fs.writeFileSync(leftover, 'written by a crashed process')

    assert.deepEqual(store.sweep(), { committed: ['global/leftover.md'] })
    assert.equal(lastMessage(store.root), 'memory: recover uncommitted')
    assert.equal(git(store.root, ['status', '--porcelain']), '')
    assert.deepEqual(store.sweep(), { committed: [] })
})

// ---------------------------------------------------------------------------
// 14. diff
// ---------------------------------------------------------------------------

test('the write result carries the diff and treats git exit 1 as success', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)

    const created = expectOk(
        await store.writeNote({ key: 'notes/diffed', body: 'old line\n' })
    )
    assert.match(
        created.diff,
        /^diff --git a\/global\/notes\/diffed\.md b\/global\/notes\/diffed\.md/
    )
    assert.match(created.diff, /^\+old line$/m)

    const updated = expectOk(
        await store.writeNote({
            key: 'notes/diffed',
            body: 'new line\n',
            baseHash: created.hash,
        })
    )
    assert.match(updated.diff, /^-old line$/m)
    assert.match(updated.diff, /^\+new line$/m)

    // Identical content is exit 0 from `git diff --no-index`: no diff, still a success.
    const unchanged = expectOk(
        await store.writeNote({
            key: 'notes/diffed',
            body: 'new line\n',
            baseHash: updated.hash,
        })
    )
    assert.equal(unchanged.diff, '')
})

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

test('readNote reports the file and a missing note is a typed error', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openTestStore(t)

    assert.throws(() => store.readNote({ key: 'notes/absent' }), NoteNotFoundError)

    const created = expectOk(await store.writeNote({ key: 'notes/read', body: 'body text' }))
    const snapshot = store.readNote({ key: 'notes/read' })
    assert.deepEqual(snapshot, {
        key: 'notes/read',
        scope: 'global',
        project: '',
        access: 'open',
        body: 'body text',
        hash: created.hash,
        path: notePath(root, 'global/notes/read.md'),
        mtime: snapshot.mtime,
    })
    assert.ok(Number.isInteger(snapshot.mtime))
})
