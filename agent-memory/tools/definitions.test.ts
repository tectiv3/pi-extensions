import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { type GateContext, failClosedMessage } from '../gate/gate.ts'
import { readLog } from '../gate/log.ts'
import { accessLogPath } from '../store/paths.ts'
import { hasVecTable, writeVector } from '../index/notes.ts'
import type { Access } from '../store/frontmatter.ts'
import { openStore, type Store } from '../store/store.ts'
import {
    type MemoryDeps,
    memoryDelete,
    memoryEdit,
    memoryIndex,
    memoryRead,
    memorySearch,
    memoryWrite,
} from './definitions.ts'

const SECRET_KEY = 'secrets/api_token'
/** Distinctive enough that its absence from a result is evidence, not luck. */
const SECRET_TOKEN = 'SWORDFISH-9f3c'
const SECRET_BODY = `${SECRET_TOKEN} is rotated every 90 days by hand.`

interface ConfirmCall {
    title: string
    message: string
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function tempDir(t: TestContext, prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

/** The store root is `PI_MEMORY_DIR`; the cwd only decides project identity. */
function useStoreDir(t: TestContext): string {
    const dir = tempDir(t, 'pi-memory-tools-')
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

function ensureSubagent(t: TestContext): void {
    const saved = process.env.PI_MEMORY_SUBAGENT
    process.env.PI_MEMORY_SUBAGENT = '1'
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_SUBAGENT
        else process.env.PI_MEMORY_SUBAGENT = saved
    })
}

function gate(answer: boolean | Error, calls: ConfirmCall[] = []): GateContext {
    return {
        hasUI: true,
        sessionId: 'sess-tools',
        ui: {
            async confirm(title, message) {
                calls.push({ title, message })
                if (answer instanceof Error) throw answer
                return answer
            },
        },
    }
}

/**
 * One gate object per store. Production wires it exactly like this: the store captures
 * the gate by reference when it is opened, and `registerMemoryTools` refreshes that same
 * object from each call's context. A test that opened the store with one gate and passed
 * another to the tools would not exercise the mutation path at all.
 */
function openStoreWith(t: TestContext, storeGate: GateContext): Store {
    const store = openStore(tempDir(t, 'pi-memory-cwd-'), { gate: storeGate })
    t.after(() => store.close())
    return store
}

function openSeededStore(t: TestContext): Store {
    return openStoreWith(t, gate(true))
}

/** A gate whose answer can change mid-test. */
function switchGate(sw: { allow: boolean }, calls: ConfirmCall[] = []): GateContext {
    return {
        hasUI: true,
        sessionId: 'sess-tools',
        ui: {
            async confirm(title, message) {
                calls.push({ title, message })
                return sw.allow
            },
        },
    }
}

/** A non-repository cwd, so an omitted `scope` resolves to global. */
function deps(t: TestContext, store: Store, toolGate: GateContext = gate(true)): MemoryDeps {
    return {
        store,
        gate: toolGate,
        cwd: tempDir(t, 'pi-memory-toolcwd-'),
    }
}

function makeRepo(t: TestContext): string {
    const repo = tempDir(t, 'pi-memory-tools-repo-')
    const init = spawnSync('git', ['init', '--quiet', '-b', 'main'], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 10_000,
    })
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`)
    return repo
}

/** A store opened in a repository, so an omitted `scope` resolves to that project. */
function openRepoStore(t: TestContext): { store: Store; repo: string } {
    const repo = makeRepo(t)
    const store = openStore(repo, { gate: gate(true) })
    t.after(() => store.close())
    return { store, repo }
}

/** §5.1 discovery from a repository cwd: the store and the tool share the project. */
function repoDeps(
    t: TestContext,
    store: Store,
    repo: string,
    toolGate: GateContext = gate(true)
): MemoryDeps {
    return { store, gate: toolGate, cwd: repo }
}

async function seedScoped(
    store: Store,
    scope: 'project' | 'global',
    key: string,
    body: string,
    access: Access = 'open'
): Promise<void> {
    const result = await store.writeNote({
        key,
        body,
        scope,
        access,
        reason: access === 'gated' ? 'seeding the fixture' : undefined,
    })
    assert.equal(result.ok, true, `seed of ${key} (${scope}) failed`)
}

function notePath(root: string, relPath: string): string {
    return path.join(root, relPath)
}

async function seed(
    store: Store,
    key: string,
    body: string,
    access: Access = 'open'
): Promise<void> {
    const result = await store.writeNote({
        key,
        body,
        access,
        reason: access === 'gated' ? 'seeding the fixture' : undefined,
    })
    assert.equal(result.ok, true, `seed of ${key} failed`)
}

// ---------------------------------------------------------------------------
// 1–2. the read gate
// ---------------------------------------------------------------------------

test('memory_read on a gated note with the gate declined returns no body', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, SECRET_KEY, SECRET_BODY, 'gated')

    const calls: ConfirmCall[] = []
    const result = await memoryRead(deps(t, store, gate(false, calls)), {
        key: SECRET_KEY,
        reason: 'checking rotation policy',
    })

    assert.equal(result.isError, true)
    assert.ok(!result.text.includes(SECRET_TOKEN), 'the body token leaked into the text')
    assert.ok(!result.text.includes('rotated every 90 days'), 'the body leaked into the text')
    assert.equal(result.details, undefined)
    // A decline is not a missing UI: telling the user to run /memory show after they
    // just declined is the wrong instruction, and it hides what happened.
    assert.equal(result.text, `gated note '${SECRET_KEY}'; access declined`)
    // The confirmation did happen, and it was the only one.
    assert.equal(calls.length, 1)
    assert.match(calls[0].message, /checking rotation policy/)

    const log = fs.readFileSync(accessLogPath(root), 'utf8')
    assert.match(log, /"decision":"pending"/)
    assert.match(log, /"decision":"declined"/)
    const entries = readLog(root)
    // A gated write is seeded above; the declined read is the second attempt.
    assert.deepEqual(
        entries.map(entry => entry.decision),
        ['pending', 'approved', 'pending', 'declined']
    )
    assert.equal(entries.length, 4, 'two attempts, two lines each')
})

test('memory_read on a gated note whose confirmation throws reports the failure', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, SECRET_KEY, SECRET_BODY, 'gated')

    const result = await memoryRead(deps(t, store, gate(new Error('dialog exploded'))), {
        key: SECRET_KEY,
        reason: 'checking rotation policy',
    })

    assert.equal(result.isError, true)
    assert.equal(result.text, `gated note '${SECRET_KEY}'; confirmation failed`)
    assert.ok(!result.text.includes(SECRET_TOKEN))
    assert.match(fs.readFileSync(accessLogPath(root), 'utf8'), /"decision":"error"/)
    const entries = readLog(root)
    assert.equal(entries.length, 4, 'the seed plus the failed attempt, two lines each')
    assert.deepEqual(
        entries.map(entry => entry.decision),
        ['pending', 'approved', 'pending', 'error']
    )
    assert.equal(entries[3].result, undefined)
})

test('memory_read on a gated note with the gate approved returns the body only', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, SECRET_KEY, SECRET_BODY, 'gated')
    const before = readLog(store.root).length

    const result = await memoryRead(deps(t, store, gate(true)), {
        key: SECRET_KEY,
        reason: 'checking rotation policy',
    })

    assert.equal(result.isError, undefined)
    assert.equal(result.text, SECRET_BODY)
    // §2.1: the frontmatter is the store's, not the note's.
    assert.ok(!result.text.includes('access: gated'))
    assert.ok(!result.text.startsWith('---'))
    assert.equal((result.details as { access: string }).access, 'gated')

    // §12.5: an approved gated read is one `pending` and one `approved` line — the
    // gate writes the pair's first half, the reader owns the second.
    const added = readLog(store.root).slice(before)
    assert.equal(added.length, 2, 'a gated read is two lines')
    assert.deepEqual(
        added.map(entry => entry.decision),
        ['pending', 'approved']
    )
    assert.equal(added[1].result, 'ok')
    assert.equal(added[1].attempt, added[0].attempt)
})

test('memory_read on a gated note without a reason does not reach the gate', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, SECRET_KEY, SECRET_BODY, 'gated')

    const calls: ConfirmCall[] = []
    const result = await memoryRead(deps(t, store, gate(true, calls)), { key: SECRET_KEY })

    assert.equal(result.isError, true)
    assert.match(result.text, /requires a reason/)
    assert.equal(calls.length, 0)
    assert.ok(!result.text.includes(SECRET_TOKEN))
})

// ---------------------------------------------------------------------------
// 3. memory_index
// ---------------------------------------------------------------------------

test('memory_index lists open keys and hides gated ones behind a count', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, 'auth/session', 'Tokens are refreshed on every request.')
    await seed(store, 'build/flake', 'nix build .#default')
    await seed(store, SECRET_KEY, SECRET_BODY, 'gated')

    const result = memoryIndex(deps(t, store))

    assert.equal(result.isError, undefined)
    assert.match(result.text, /auth\/session: Tokens are refreshed on every request\./)
    assert.match(result.text, /build\/flake: nix build \.#default/)
    assert.match(result.text, /^gated: 1 hidden$/m)
    assert.ok(!result.text.includes(SECRET_KEY), 'a gated key was named')
    assert.ok(!result.text.includes(SECRET_TOKEN), 'a gated body leaked')
    assert.equal((result.details as { gated: number }).gated, 1)
})

test('memory_index with no notes says so and never fabricates a count', t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)

    const result = memoryIndex(deps(t, store))

    assert.equal(result.text.includes('gated:'), false)
    assert.match(result.text, /\(no notes\)/)
})

// ---------------------------------------------------------------------------
// 4. search never reaches gated content
// ---------------------------------------------------------------------------

test('memory_search excludes gated notes without an embedder', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, 'db/sqlite', 'sqlite vector search with fts5 bm25 ranking')
    await seed(store, SECRET_KEY, `sqlite ${SECRET_BODY}`, 'gated')

    const result = await memorySearch(deps(t, store), { query: 'sqlite' })

    assert.equal(result.isError, undefined)
    assert.match(result.text, /db\/sqlite/)
    assert.ok(!result.text.includes(SECRET_KEY), 'a gated key was returned')
    assert.ok(!result.text.includes(SECRET_TOKEN), 'a gated body leaked')
})

test('memory_search excludes gated notes with an embedder supplied', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, 'db/sqlite', 'sqlite vector search with fts5 bm25 ranking')
    await seed(store, SECRET_KEY, `sqlite ${SECRET_BODY}`, 'gated')

    const vector = new Float32Array(512).fill(0.1)
    // A vector that points straight at the gated note: if the SQL filter were applied
    // after `k` instead of before, this note would occupy the only candidate slot.
    if (hasVecTable(store.db)) {
        const row = store.db
            .prepare('SELECT id, body_hash FROM notes WHERE key = ?')
            .get(SECRET_KEY) as { id: number; body_hash: string }
        writeVector(store.db, row.id, vector, row.body_hash)
    }

    const embedded: string[] = []
    const result = await memorySearch(
        {
            ...deps(t, store),
            embed: async (text: string) => {
                embedded.push(text)
                return vector
            },
        },
        { query: 'sqlite' }
    )

    assert.deepEqual(embedded, ['sqlite'], 'the query was not handed to the embedder')
    assert.equal(result.isError, undefined)
    assert.ok(!result.text.includes(SECRET_KEY))
    assert.ok(!result.text.includes(SECRET_TOKEN))
    for (const hit of (result.details as { results: { key: string }[] }).results) {
        assert.notEqual(hit.key, SECRET_KEY)
    }
})

test('memory_search degrades to BM25 when the embedder returns null', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, 'db/sqlite', 'sqlite vector search with fts5 bm25 ranking')

    const result = await memorySearch(
        { ...deps(t, store), embed: async () => null },
        { query: 'sqlite' }
    )

    assert.equal(result.isError, undefined)
    assert.match(result.text, /db\/sqlite/)
})

// ---------------------------------------------------------------------------
// 5. ranking direction (§12.27)
// ---------------------------------------------------------------------------

test('memory_search ranks the strongly relevant note first', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(
        store,
        'deploy/grafana',
        'grafana grafana grafana dashboard provisioning with grafana and prometheus'
    )
    await seed(store, 'ops/legacy', 'the old grafana note is obsolete and mostly wrong')
    // Filler keeps the IDF from clamping: a term in half the corpus scores ~1e-6.
    await seed(store, 'ops/filler_a', 'nothing to do with observability')
    await seed(store, 'ops/filler_b', 'another note about release steps')
    await seed(store, 'ops/filler_c', 'meeting notes from a tuesday')
    await seed(store, 'ops/filler_d', 'a note about keyboard shortcuts')

    const result = await memorySearch(deps(t, store), { query: 'grafana' })

    assert.equal(result.isError, undefined)
    const keys = (result.details as { results: { key: string }[] }).results.map(hit => hit.key)
    assert.ok(keys.length >= 2, `expected both grafana notes, got ${keys.join(', ')}`)
    assert.equal(keys[0], 'deploy/grafana', `wrong order: ${keys.join(', ')}`)
})

test('memory_search matches plurals from the singular and refuses no words at all', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(
        store,
        'store/symlinks',
        'symlinks and symlinked parents are rejected; the leaf is never followed'
    )

    // The measured defect: the singular missed a note that only says `symlinks`.
    const singular = await memorySearch(deps(t, store), { query: 'symlink' })
    assert.equal(singular.isError, undefined)
    assert.match(singular.text, /store\/symlinks/)

    const inflected = await memorySearch(deps(t, store), { query: 'symlinked' })
    assert.equal(inflected.isError, undefined)
    assert.match(inflected.text, /store\/symlinks/)

    // §6.2's builder owns the query, so an operator-shaped query is searched, not
    // rejected as a syntax error, and a query with no usable word is refused here
    // rather than sent to `MATCH`.
    const operatorish = await memorySearch(deps(t, store), { query: '-rf' })
    assert.equal(operatorish.isError, undefined, operatorish.text)

    const empty = await memorySearch(deps(t, store), { query: '!!!' })
    assert.equal(empty.isError, true)
    assert.match(empty.text, /could not parse the query/)
})

// ---------------------------------------------------------------------------
// 6–7. gated mutations
// ---------------------------------------------------------------------------

test('memory_write of a gated note without a reason writes nothing', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openSeededStore(t)

    const result = await memoryWrite(deps(t, store), {
        key: SECRET_KEY,
        body: SECRET_BODY,
        access: 'gated',
    })

    assert.equal(result.isError, true)
    assert.match(result.text, /requires a reason/)
    assert.equal(fs.existsSync(notePath(root, `global/${SECRET_KEY}.md`)), false)
    assert.ok(!result.text.includes(SECRET_TOKEN))
})

test('memory_write reports the diff and the hash it produced', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)

    const result = await memoryWrite(deps(t, store), { key: 'notes/page', body: 'first line' })

    assert.equal(result.isError, undefined)
    assert.match(result.text, /wrote notes\/page \(global, open\)/)
    assert.match(result.text, /^hash: [0-9a-f]{64}$/m)
    assert.match(result.text, /\+first line/)
    const hash = (result.details as { hash: string }).hash
    assert.match(hash, /^[0-9a-f]{64}$/)
})

test('a stale baseHash on a gated write prompts nobody and logs nothing', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const calls: ConfirmCall[] = []
    const store = openSeededStore(t)
    await seed(store, SECRET_KEY, SECRET_BODY, 'gated')
    const before = readLog(store.root).length

    // Approval cannot make a stale precondition true, so the precondition is checked
    // first (F8). This test replaces the old ordering assertion: the gate must not be
    // entered, which is observable as zero confirmations and zero new log lines.
    const result = await memoryWrite(deps(t, store, gate(true, calls)), {
        key: SECRET_KEY,
        body: 'replacement body',
        baseHash: '0'.repeat(64),
        reason: 'replace the token note',
    })

    assert.equal(result.isError, true)
    assert.match(result.text, /re-read/)
    assert.ok(!result.text.includes(SECRET_TOKEN))
    assert.deepEqual(calls, [], 'the user was asked to approve a write that cannot happen')
    assert.equal(readLog(store.root).length, before, 'a rejected precondition logged a pair')
})

test('memory_delete on a gated note requires the gate', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const sw = { allow: true }
    const storeGate = switchGate(sw)
    const store = openStoreWith(t, storeGate)
    await seed(store, SECRET_KEY, SECRET_BODY, 'gated')
    const relPath = `global/${SECRET_KEY}.md`
    const afterSeed = readLog(store.root).length

    sw.allow = false
    const declined = await memoryDelete(deps(t, store, storeGate), {
        key: SECRET_KEY,
        reason: 'removing a stale token note',
    })
    assert.equal(declined.isError, true)
    assert.equal(fs.existsSync(notePath(root, relPath)), true, 'the note was deleted anyway')
    assert.ok(!declined.text.includes(SECRET_TOKEN))
    const declinedLines = readLog(store.root).slice(afterSeed)
    assert.equal(declinedLines.length, 2, 'a declined delete is two lines')
    assert.deepEqual(
        declinedLines.map(entry => entry.decision),
        ['pending', 'declined']
    )

    sw.allow = true
    const approved = await memoryDelete(deps(t, store, storeGate), {
        key: SECRET_KEY,
        reason: 'removing a stale token note',
    })
    assert.equal(approved.isError, undefined)
    assert.match(approved.text, /deleted secrets\/api_token \(global\)/)
    assert.equal(fs.existsSync(notePath(root, relPath)), false)
    const approvedLines = readLog(store.root).slice(afterSeed + 2)
    assert.equal(approvedLines.length, 2, 'an approved delete is two lines')
    assert.deepEqual(
        approvedLines.map(entry => entry.decision),
        ['pending', 'approved']
    )
    assert.equal(approvedLines[1].result, 'ok')
    assert.equal(approvedLines[0].op, 'delete')
})

// ---------------------------------------------------------------------------
// 8. subagent surface (§5.3)
// ---------------------------------------------------------------------------

test('PI_MEMORY_SUBAGENT=1 rejects every mutation, even on an open note', async t => {
    ensureSubagent(t)
    const root = useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, 'notes/page', 'original body')

    const write = await memoryWrite(deps(t, store), { key: 'notes/new', body: 'nope' })
    const edit = await memoryEdit(deps(t, store), {
        key: 'notes/page',
        oldText: 'original',
        newText: 'blocked',
        baseHash: 'whatever',
    })
    const remove = await memoryDelete(deps(t, store), { key: 'notes/page' })

    for (const result of [write, edit, remove]) {
        assert.equal(result.isError, true)
        assert.match(result.text, /subagent sessions have no memory write access/)
    }
    assert.equal(fs.existsSync(notePath(root, 'global/notes/new.md')), false)
    assert.equal(
        fs.readFileSync(notePath(root, 'global/notes/page.md'), 'utf8'),
        'original body'
    )
    // §5.3 layer 2 logs the block; each attempt produces pending + blocked-subagent.
    const log = fs.readFileSync(accessLogPath(root), 'utf8')
    assert.equal(log.match(/"decision":"blocked-subagent"/g)?.length, 3)
})

test('PI_MEMORY_SUBAGENT=1 fails a gated read closed and logs blocked-subagent', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, SECRET_KEY, SECRET_BODY, 'gated')

    ensureSubagent(t)
    const calls: ConfirmCall[] = []
    const result = await memoryRead(deps(t, store, gate(true, calls)), {
        key: SECRET_KEY,
        reason: 'checking rotation policy',
    })

    assert.equal(result.isError, true)
    assert.equal(result.text, failClosedMessage(SECRET_KEY))
    assert.ok(!result.text.includes(SECRET_TOKEN))
    // The UI must never be reached: `hasUI` is true in RPC mode, which is what
    // subagents use.
    assert.equal(calls.length, 0)
    const log = fs.readFileSync(accessLogPath(root), 'utf8')
    assert.match(log, /"decision":"blocked-subagent"/)
})

test('PI_MEMORY_SUBAGENT=1 still allows the index and open reads', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, 'notes/page', 'open body')

    ensureSubagent(t)
    assert.equal(memoryIndex(deps(t, store)).isError, undefined)
    const read = await memoryRead(deps(t, store), { key: 'notes/page' })
    assert.equal(read.text, 'open body')
    const search = await memorySearch(deps(t, store), { query: 'open' })
    assert.equal(search.isError, true)
    assert.match(search.text, /not available to subagents/)
})

// ---------------------------------------------------------------------------
// 9. stale baseHash
// ---------------------------------------------------------------------------

test('memory_edit with a stale baseHash is rejected with a re-read instruction', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, 'notes/page', 'alpha')

    const result = await memoryEdit(deps(t, store), {
        key: 'notes/page',
        oldText: 'alpha',
        newText: 'beta',
        baseHash: '0'.repeat(64),
    })

    assert.equal(result.isError, true)
    assert.match(result.text, /re-read/)
    assert.equal(fs.readFileSync(notePath(root, 'global/notes/page.md'), 'utf8'), 'alpha')
})

test('memory_edit with the current baseHash replaces the single match', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, 'notes/page', 'alpha beta')
    const read = await memoryRead(deps(t, store), { key: 'notes/page' })
    const hash = (read.details as { hash: string }).hash

    const result = await memoryEdit(deps(t, store), {
        key: 'notes/page',
        oldText: 'beta',
        newText: 'gamma',
        baseHash: hash,
    })

    assert.equal(result.isError, undefined)
    assert.match(result.text, /edited notes\/page/)
    assert.equal(
        fs.readFileSync(notePath(root, 'global/notes/page.md'), 'utf8'),
        'alpha gamma'
    )
})

// ---------------------------------------------------------------------------
// 10. the global fallback (§5.1, F3)
// ---------------------------------------------------------------------------

test('a global note is readable from inside a repository without an explicit scope', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const { store, repo } = openRepoStore(t)
    await seedScoped(store, 'global', 'editor-preferences', 'I use helix, never vim')

    const result = await memoryRead(repoDeps(t, store, repo), { key: 'editor-preferences' })

    assert.equal(result.isError, undefined)
    assert.equal(result.text, 'I use helix, never vim')
    assert.equal((result.details as { scope: string }).scope, 'global')
})

test('a project note shadows the global one, and an explicit scope reads the other tier', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const { store, repo } = openRepoStore(t)
    await seedScoped(store, 'global', 'deploy/flags', 'global flags')
    await seedScoped(store, 'project', 'deploy/flags', 'project flags')

    const implicit = await memoryRead(repoDeps(t, store, repo), { key: 'deploy/flags' })
    assert.equal(implicit.text, 'project flags')
    assert.equal((implicit.details as { scope: string }).scope, 'project')

    const global = await memoryRead(repoDeps(t, store, repo), {
        key: 'deploy/flags',
        scope: 'global',
    })
    assert.equal(global.text, 'global flags')
    assert.equal((global.details as { scope: string }).scope, 'global')
})

test('a read that misses in both tiers names both scopes it searched', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const { store, repo } = openRepoStore(t)

    const result = await memoryRead(repoDeps(t, store, repo), { key: 'nowhere/at/all' })

    assert.equal(result.isError, true)
    assert.match(result.text, /not found \(project \S+, global\)/)
})

test('memory_index lists project keys first under one line naming both tiers', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const { store, repo } = openRepoStore(t)
    await seedScoped(store, 'project', 'build/flags', 'nix build with --impure')
    await seedScoped(store, 'global', 'editor/prefs', 'helix, never vim')
    await seedScoped(store, 'project', 'secrets/project', 'gated project body', 'gated')
    await seedScoped(store, 'global', 'secrets/global', 'gated global body', 'gated')

    const result = memoryIndex(repoDeps(t, store, repo))
    const lines = result.text.split('\n')

    assert.match(lines[0], /^scope: project:\S+ \+ global$/)
    const projectAt = lines.findIndex(line => line.startsWith('build/flags'))
    const globalAt = lines.findIndex(line => line.startsWith('editor/prefs'))
    assert.ok(projectAt > 0, 'the project key is missing')
    assert.ok(
        globalAt > projectAt,
        'global keys must follow the project keys, even when they are newer'
    )
    // Each row names its tier: the ordering alone is not enough to pick a `scope` for a
    // later mutation.
    assert.match(lines[projectAt], /^build\/flags: nix build with --impure \(project:\S+\)$/)
    assert.equal(lines[globalAt], 'editor/prefs: helix, never vim (global)')
    assert.match(result.text, /^gated: 2 hidden$/m)
    // Gated keys are counted across both tiers, never named.
    assert.ok(!result.text.includes('secrets/'))
    assert.deepEqual((result.details as { scopes: unknown[] }).scopes.length, 2)
})

test('memory_search covers both tiers and ranks the project hit first on a tie', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const { store, repo } = openRepoStore(t)
    // Identical bodies: the BM25 scores are equal, so only the scope tiebreak decides.
    await seedScoped(store, 'project', 'ledger/project', 'zanzibar ledger entry')
    await seedScoped(store, 'global', 'ledger/global', 'zanzibar ledger entry')

    const result = await memorySearch(repoDeps(t, store, repo), { query: 'zanzibar' })
    const keys = (result.details as { results: { key: string; scope: string }[] }).results

    assert.equal(result.isError, undefined)
    assert.deepEqual(
        keys.map(hit => hit.key),
        ['ledger/project', 'ledger/global']
    )
    assert.deepEqual(
        keys.map(hit => hit.scope),
        ['project', 'global']
    )
    assert.match(result.text, /1\. ledger\/project \(project:/)
    assert.match(result.text, /2\. ledger\/global \(global\)/)
})

test('explicit scopes narrow index and search to exactly one tier', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const { store, repo } = openRepoStore(t)
    await seedScoped(store, 'project', 'ledger/project', 'zanzibar ledger entry')
    await seedScoped(store, 'global', 'ledger/global', 'zanzibar ledger entry')

    const globalIndex = memoryIndex(repoDeps(t, store, repo), { scope: 'global' })
    assert.equal(globalIndex.text.split('\n')[0], 'scope: global')
    assert.ok(!globalIndex.text.includes('ledger/project'))
    assert.match(globalIndex.text, /ledger\/global/)

    const projectIndex = memoryIndex(repoDeps(t, store, repo), { scope: 'project' })
    assert.match(projectIndex.text.split('\n')[0], /^scope: project:\S+$/)
    assert.ok(!projectIndex.text.includes('ledger/global'))

    const globalSearch = await memorySearch(repoDeps(t, store, repo), {
        query: 'zanzibar',
        scope: 'global',
    })
    assert.ok(!globalSearch.text.includes('ledger/project'))
    assert.match(globalSearch.text, /ledger\/global/)

    const projectSearch = await memorySearch(repoDeps(t, store, repo), {
        query: 'zanzibar',
        scope: 'project',
    })
    assert.ok(!projectSearch.text.includes('ledger/global'))
    assert.match(projectSearch.text, /ledger\/project/)
})

// ---------------------------------------------------------------------------
// 11. the index is a snapshot (§2.1): a hand-gated note must not leak
// ---------------------------------------------------------------------------

test('a note hand-gated mid-session leaves search and the index without a reindex', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeededStore(t)
    await seed(store, 'ops/secret', 'zanzibar token body')

    const before = await memorySearch(deps(t, store), { query: 'zanzibar' })
    assert.match(before.text, /ops\/secret/)

    // Gated by hand, exactly as §3.3 says the store is meant to be edited. No
    // reindex: the row still says `open`, which is the exposure window this pins.
    fs.writeFileSync(
        notePath(store.root, 'global/ops/secret.md'),
        '---\naccess: gated\n---\nzanzibar token body\n'
    )
    const row = store.db
        .prepare("SELECT access FROM notes WHERE key = 'ops/secret'")
        .get() as { access: string }
    assert.equal(row.access, 'open', 'the fixture did not reproduce the stale row')

    const searched = await memorySearch(deps(t, store), { query: 'zanzibar' })
    assert.ok(!searched.text.includes('ops/secret'), 'a hand-gated key was returned')
    assert.ok(!searched.text.includes('zanzibar token body'))

    const indexed = memoryIndex(deps(t, store))
    assert.ok(!indexed.text.includes('ops/secret'), 'a hand-gated key was listed')
    assert.match(indexed.text, /^gated: 1 hidden$/m)
})

test('a read that fell back to global is gated by the global note it found', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const { store, repo } = openRepoStore(t)
    await seedScoped(store, 'global', 'secrets/global', SECRET_BODY, 'gated')
    const calls: ConfirmCall[] = []

    const result = await memoryRead(repoDeps(t, store, repo, gate(true, calls)), {
        key: 'secrets/global',
        reason: 'checking the global token',
    })

    assert.equal(result.isError, undefined)
    assert.equal(result.text, SECRET_BODY)
    assert.equal((result.details as { scope: string }).scope, 'global')
    // Exactly one confirmation, and the attempt it belongs to names the tier that was
    // actually read: the project's access never governs a global note.
    assert.equal(calls.length, 1)
    assert.match(calls[0].message, /checking the global token/)
    const entries = readLog(root)
    const pending = entries.filter(entry => entry.decision === 'pending').at(-1)
    assert.equal(pending?.scope, 'global', 'the attempt named the wrong tier')
    assert.equal(entries.at(-1)?.decision, 'approved')
})
