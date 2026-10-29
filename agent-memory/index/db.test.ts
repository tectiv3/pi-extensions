import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'

import * as sqliteVec from 'sqlite-vec'

import type { GateContext } from '../gate/gate.ts'
import { indexPath, indexLockPath } from '../store/paths.ts'
import { reindexFromDisk } from '../store/reindex.ts'
import { openStore } from '../store/store.ts'
import {
    EMBED_DIM,
    type OpenIndexOptions,
    type VecProbe,
    getMeta,
    handleVecAvailable,
    migrate,
    openIndex,
    openIndexLocked,
    SchemaVersionError,
    setMeta,
    vecProbe,
} from './db.ts'
import {
    getNoteByKey,
    hasVecTable,
    needsEmbedding,
    upsertNote,
    type NoteInput,
    writeVector,
} from './notes.ts'

function makeRoot(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-index-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

/** The after-hook closes whichever handle the test ended up with, including one a
 *  downgrade already closed itself. */
function track<T extends DatabaseSync>(t: TestContext, db: T): T {
    t.after(() => {
        try {
            db.close()
        } catch {}
    })
    return db
}

function openTemp(
    t: TestContext,
    opts: OpenIndexOptions = {}
): { root: string; db: DatabaseSync } {
    const root = makeRoot(t)
    return { root, db: track(t, openIndex(root, opts)) }
}

function noteInput(overrides: Partial<NoteInput> = {}): NoteInput {
    const key = overrides.key ?? 'a/one'
    return {
        scope: 'global',
        key,
        path: `global/${key}.md`,
        body: `body of ${key}`,
        fmLen: 0,
        bodyHash: `hash-${key}`,
        access: 'open',
        mtime: 1_700_000_000_000,
        ...overrides,
    }
}

function hasTable(db: DatabaseSync, name: string): boolean {
    return (
        db
            .prepare(
                "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
            )
            .get(name) !== undefined
    )
}

function matchCount(db: DatabaseSync, term: string): number {
    const row = db
        .prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?')
        .get(term)
    return Number(row?.n ?? 0)
}

function countNotes(db: DatabaseSync): number {
    return Number(db.prepare('SELECT count(*) AS n FROM notes').get()?.n ?? 0)
}

function writeNoteFile(root: string, relPath: string, content: string): void {
    const target = path.join(root, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
}

test('schema creates cleanly and seeds meta', t => {
    const { root, db } = openTemp(t)

    assert.ok(hasTable(db, 'notes'))
    assert.ok(hasTable(db, 'notes_fts'))
    assert.ok(hasTable(db, 'meta'))
    assert.ok(hasTable(db, 'vec_notes'))

    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal')
    assert.equal(Number(db.prepare('PRAGMA busy_timeout').get()?.timeout), 5000)

    assert.equal(getMeta(db, 'schema_version'), '1')
    assert.equal(getMeta(db, 'embed_model'), 'nlembedding-en')
    assert.equal(getMeta(db, 'embed_dim'), '512')
    assert.equal(getMeta(db, 'vec_enabled'), 'true')

    // Reopening an existing database must not fail on the DDL.
    const reopened = track(t, openIndex(root))
    assert.equal(countNotes(reopened), 0)
})

test('the three FTS triggers keep notes_fts in step', t => {
    const { db } = openTemp(t)

    const id = upsertNote(db, noteInput({ key: 'alpha/one', body: 'quokka' }))
    assert.equal(matchCount(db, 'quokka'), 1)
    assert.equal(matchCount(db, 'alpha'), 1)

    // Update: the same row now carries a different body, so the old token must be
    // gone. `INSERT OR REPLACE` would leave it searchable with integrity_check ok.
    upsertNote(db, noteInput({ key: 'alpha/one', body: 'wombat' }))
    assert.equal(matchCount(db, 'quokka'), 0)
    assert.equal(matchCount(db, 'wombat'), 1)
    assert.equal(matchCount(db, 'alpha'), 1)

    db.prepare('DELETE FROM notes WHERE id = ?').run(id)
    assert.equal(matchCount(db, 'wombat'), 0)
    assert.equal(matchCount(db, 'alpha'), 0)
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM notes_fts').get()?.n), 0)
})

test("project = '' closes the duplicate-global hole", t => {
    const { db } = openTemp(t)

    // NULL is what the spec's UNIQUE(scope, project, key) cannot police: SQLite
    // treats NULL as distinct, so two ('global', NULL, 'a/b') rows both succeed.
    assert.throws(
        () =>
            db
                .prepare(
                    `INSERT INTO notes(scope, project, key, path, body, fm_len, body_hash, access, mtime)
VALUES ('global', NULL, 'a/b', 'global/a/b.md', 'x', 0, 'h', 'open', 1)`
                )
                .run(),
        /NOT NULL constraint failed/
    )

    const first = upsertNote(db, noteInput({ key: 'a/b' }))
    const second = upsertNote(db, noteInput({ key: 'a/b' }))
    assert.equal(second, first)
    assert.equal(countNotes(db), 1)
})

test('vecProbe reports the loaded module and its version', t => {
    const { db } = openTemp(t)
    const probe: VecProbe = vecProbe(db)
    assert.equal(probe.available, true)
    assert.match(String(probe.version), /^v?\d+\.\d+\.\d+/)
})

test('migrate is a no-op at version 1 and rejects a newer version', t => {
    const { root, db } = openTemp(t)
    migrate(db)

    setMeta(db, 'schema_version', '2')
    assert.throws(() => migrate(db), SchemaVersionError)

    db.close()
    assert.throws(() => openIndex(root), SchemaVersionError)
})

test('downgrade deletes index.db*, rebuilds vectorless, and latches', t => {
    const root = makeRoot(t)
    writeNoteFile(root, 'global/a/one.md', 'quokka note')

    const seeded = openIndex(root)
    upsertNote(seeded, noteInput({ key: 'a/one' }))
    assert.ok(hasVecTable(seeded))
    const seededIno = fs.statSync(indexPath(root)).ino
    seeded.close()

    // Next start on a machine where the module cannot load. The open, the probe and
    // the delete all happen inside `index.db.lock` (F10), which is why this is the one
    // entry point every process takes.
    const downgraded = track(t, openIndexLocked(root, { vecLoader: null }))
    assert.equal(vecProbe(downgraded).available, false)
    assert.equal(hasVecTable(downgraded), false)
    assert.equal(getMeta(downgraded, 'vec_enabled'), 'false')
    assert.equal(countNotes(downgraded), 1)
    assert.equal(matchCount(downgraded, 'quokka'), 1)
    assert.ok(fs.existsSync(indexPath(root)))
    // A rebuild recreates the file, so the inode is the evidence rather than a proxy.
    assert.notEqual(fs.statSync(indexPath(root)).ino, seededIno)
    assert.equal(fs.existsSync(indexLockPath(root)), false)
    const rebuiltIno = fs.statSync(indexPath(root)).ino

    const idsBefore = downgraded
        .prepare('SELECT id FROM notes ORDER BY id')
        .all()
        .map(row => Number(row.id))

    // Second start with the module still absent: the latch is the condition, so
    // nothing is deleted or rebuilt again (conditioning on embed_dim would rebuild
    // every session).
    const again = track(t, openIndexLocked(root, { vecLoader: null }))
    assert.equal(fs.statSync(indexPath(root)).ino, rebuiltIno, 'rebuilt a second time')
    assert.deepEqual(
        again
            .prepare('SELECT id FROM notes ORDER BY id')
            .all()
            .map(row => Number(row.id)),
        idsBefore
    )
    assert.equal(getMeta(again, 'vec_enabled'), 'false')
    assert.notEqual(again, downgraded)
    again.close()
    downgraded.close()

    // Module restored: the table was never created in the vectorless DB, so the
    // re-upgrade has to create it before the latch can flip. `openIndex` applies the
    // re-upgrade itself; the explicit call is idempotent.
    const revived = track(t, openIndex(root))
    assert.equal(vecProbe(revived).available, true)
    assert.ok(hasVecTable(revived))
    assert.equal(getMeta(revived, 'vec_enabled'), 'true')

    setMeta(revived, 'vec_enabled', 'false')
    assert.equal(handleVecAvailable(revived), true)
    assert.equal(getMeta(revived, 'vec_enabled'), 'true')
    assert.equal(handleVecAvailable(revived), false)
})

// ---------------------------------------------------------------------------
// downgrade failures and the lock that covers them (F2, F10)
// ---------------------------------------------------------------------------

test('a downgrade with unparseable frontmatter rebuilds the rest of the store', t => {
    const root = makeRoot(t)
    writeNoteFile(root, 'global/a/one.md', 'quokka note')
    writeNoteFile(root, 'global/a/broken.md', '---\naccess: someday\n---\nsecret')

    const seeded = openIndex(root)
    upsertNote(seeded, noteInput({ key: 'a/one' }))
    seeded.close()

    const downgraded = track(t, openIndexLocked(root, { vecLoader: null }))

    assert.equal(vecProbe(downgraded).available, false)
    assert.equal(
        getMeta(downgraded, 'vec_enabled'),
        'false',
        'the downgrade threw, so nothing opened'
    )
    assert.equal(countNotes(downgraded), 1, 'the good note went with the bad one')
    assert.equal(matchCount(downgraded, 'quokka'), 1)
    assert.equal(getNoteByKey(downgraded, 'global', '', 'a/broken'), null)

    // The pass that follows every open is what names the skipped file (F1).
    const pass = reindexFromDisk(root, downgraded)
    assert.deepEqual(
        pass.errors.map(error => error.path),
        ['global/a/broken.md']
    )
    assert.equal(pass.removed, 0)
})

test('a downgrade whose recreate fails leaves the store retryable', t => {
    const root = makeRoot(t)
    writeNoteFile(root, 'global/a/one.md', 'quokka note')
    const seeded = openIndex(root)
    upsertNote(seeded, noteInput({ key: 'a/one' }))
    seeded.close()
    const seededIno = fs.statSync(indexPath(root)).ino

    // The recreate is the one window no other seam reaches: by the time it runs the old
    // database has been unlinked, so what it does decides whether the store survives.
    assert.throws(
        () =>
            openIndexLocked(root, {
                vecLoader: null,
                recreate: () => {
                    throw new Error('EIO: cannot create index.db')
                },
            }),
        (err: Error) => {
            assert.match(err.message, /could not recreate index\.db/)
            assert.match(err.message, /EIO: cannot create index\.db/)
            return true
        }
    )

    // The lock is released and the notes are still on disk: the next open is a clean one.
    assert.equal(fs.existsSync(indexLockPath(root)), false)
    assert.equal(fs.existsSync(indexPath(root)), false)
    const retried = track(t, openIndexLocked(root, { vecLoader: null }))
    assert.equal(getMeta(retried, 'vec_enabled'), 'false')
    assert.equal(hasVecTable(retried), false)
    // The rows come back from the files, since the database that held them is gone.
    assert.equal(reindexFromDisk(root, retried).updated, 1)
    assert.equal(matchCount(retried, 'quokka'), 1)
    assert.notEqual(fs.statSync(indexPath(root)).ino, seededIno)
})

test('a downgrade whose repopulate fails closes the handle and names the cause', t => {
    const root = makeRoot(t)
    // A regular file where the `global/` directory belongs: ENOTDIR out of the walk,
    // the one failure the repopulate cannot absorb per file.
    fs.writeFileSync(path.join(root, 'global'), 'not a directory')
    const seeded = openIndex(root)
    upsertNote(seeded, noteInput({ key: 'a/one' }))
    seeded.close()

    assert.throws(
        () => openIndexLocked(root, { vecLoader: null }),
        (err: Error) => {
            assert.match(err.message, /could not repopulate index\.db/)
            assert.match(err.message, /ENOTDIR/)
            return true
        }
    )
    assert.equal(fs.existsSync(indexLockPath(root)), false)
    // A live connection keeps `-wal` beside the database; SQLite removes it when the
    // last handle closes cleanly, so its absence is the observable that it did.
    assert.equal(fs.existsSync(`${indexPath(root)}-wal`), false)
})

interface DowngradeRaceReport {
    rebuilt?: boolean
    vecEnabled?: string | null
    notes?: number
    error?: string
}

/** A child that opens the store exactly as a session does, on a host with no `vec0`. */
const DOWNGRADE_RACE_PROBE = `
const { pathToFileURL } = await import('node:url')
const url = p => pathToFileURL(process.env.MEM_ROOT + '/' + p).href
const db = await import(url('index/db.ts'))

let rebuilt = false
const out = {}
try {
    const handle = db.openIndexLocked(process.env.MEM_STORE_ROOT, {
        vecLoader: null,
        recreate: root => {
            rebuilt = true
            return db.openIndex(root, { vecLoader: null })
        },
    })
    out.rebuilt = rebuilt
    out.vecEnabled = db.getMeta(handle, 'vec_enabled')
    out.notes = Number(handle.prepare('SELECT count(*) AS n FROM notes').get().n)
    handle.close()
} catch (err) {
    out.error = String((err && err.stack) || err)
}
process.stdout.write(JSON.stringify(out))
`

function spawnDowngrader(host: string, storeRoot: string): Promise<DowngradeRaceReport> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                '--experimental-strip-types',
                '--no-warnings',
                '--input-type=module',
                '-e',
                DOWNGRADE_RACE_PROBE,
            ],
            {
                env: { ...process.env, MEM_ROOT: host, MEM_STORE_ROOT: storeRoot },
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => (stdout += String(chunk)))
        child.stderr.on('data', chunk => (stderr += String(chunk)))
        child.on('error', reject)
        child.on('close', () => {
            try {
                resolve(JSON.parse(stdout.trim()) as DowngradeRaceReport)
            } catch {
                reject(new Error(`downgrade race probe failed: ${stderr}${stdout}`))
            }
        })
    })
}

test('two concurrent downgrades rebuild the index once (F10)', async t => {
    const root = makeRoot(t)
    writeNoteFile(root, 'global/a/one.md', 'quokka note')
    const seeded = openIndex(root)
    upsertNote(seeded, noteInput({ key: 'a/one' }))
    seeded.close()

    // A lock file this (live) pid holds keeps both children at the acquire step, so
    // they arrive at the open together. Without it they queue up on process start and
    // the race would go unexercised; with it, the only thing serialising them is the
    // lock under test.
    const lockFile = indexLockPath(root)
    fs.writeFileSync(lockFile, `${process.pid} ${Date.now()}\n`)

    const first = spawnDowngrader(moduleRoot(), root)
    const second = spawnDowngrader(moduleRoot(), root)
    await new Promise(resolve => setTimeout(resolve, 300))
    fs.rmSync(lockFile)

    const reports = await Promise.all([first, second])
    for (const report of reports) assert.equal(report.error, undefined, report.error)
    assert.deepEqual(
        reports.map(report => report.rebuilt).sort(),
        [false, true],
        'both processes deleted and rebuilt the index'
    )
    for (const report of reports) {
        assert.equal(report.vecEnabled, 'false')
        assert.equal(report.notes, 1)
    }
})

// ---------------------------------------------------------------------------
// §12.24 end to end: the module genuinely cannot be loaded
// ---------------------------------------------------------------------------

/** The store root is `PI_MEMORY_DIR`; the cwd only decides project identity. */
function useStoreDir(t: TestContext): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-db-store-'))
    const saved = process.env.PI_MEMORY_DIR
    process.env.PI_MEMORY_DIR = dir
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_DIR
        else process.env.PI_MEMORY_DIR = saved
        fs.rmSync(dir, { recursive: true, force: true })
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

/**
 * A throwaway host tree: these sources copied verbatim, plus a `node_modules` that
 * contains `sqlite-vec` and its platform package **without the `.dylib`**.
 *
 * Running the child from it is what makes "the module cannot be loaded" real: the
 * failure comes from `sqlite-vec`'s own `getLoadablePath()` resolving a file that is
 * not there, which is the same throw `loadVec` catches for an absent or
 * wrong-architecture install. It is a private tree because the alternative — making
 * the repository's install unreadable — would be visible to every other test file,
 * which runs in a parallel process against the same files.
 */
function makeVectorlessHost(t: TestContext): string {
    const host = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-no-vec-'))
    t.after(() => fs.rmSync(host, { recursive: true, force: true }))

    fs.cpSync(moduleRoot(), host, {
        recursive: true,
        filter: src =>
            !src.split(path.sep).some(part => part === 'node_modules' || part === '.git'),
    })

    const requireFrom = createRequire(path.join(moduleRoot(), 'resolve.cjs'))
    const packageDir = path.dirname(requireFrom.resolve('sqlite-vec'))
    fs.cpSync(packageDir, path.join(host, 'node_modules', 'sqlite-vec'), {
        recursive: true,
    })

    const platformDir = path.dirname(sqliteVec.getLoadablePath())
    const stub = path.join(host, 'node_modules', path.basename(platformDir))
    fs.mkdirSync(stub, { recursive: true })
    fs.copyFileSync(path.join(platformDir, 'package.json'), path.join(stub, 'package.json'))
    return host
}

function denyGate(): GateContext {
    return {
        hasUI: true,
        sessionId: 'sess-downgrade',
        ui: {
            async confirm() {
                return false
            },
        },
    }
}

function vecRowCount(db: DatabaseSync): number {
    return Number(db.prepare('SELECT count(*) AS n FROM vec_notes').get()?.n ?? 0)
}

/**
 * The child's whole job: open the store while `sqlite-vec` is genuinely unreadable,
 * exercise every tool, and report what it observed as JSON. A fresh process is what
 * makes the unavailability real — see the test's comment.
 */
const DOWNGRADE_PROBE = `
const { pathToFileURL } = await import('node:url')
const fs = await import('node:fs')
const url = p => pathToFileURL(process.env.MEM_ROOT + '/' + p).href
const { openStore } = await import(url('store/store.ts'))
const db = await import(url('index/db.ts'))
const notes = await import(url('index/notes.ts'))
const tools = await import(url('tools/definitions.ts'))

const gate = { hasUI: false, ui: { async confirm() { return false } } }
const cwd = process.env.MEM_CWD
const indexFile = process.env.PI_MEMORY_DIR + '/index.db'
const out = {}
try {
    const store = openStore(cwd, { gate })
    out.probe = db.vecProbe(store.db).available
    out.hasVec = notes.hasVecTable(store.db)
    out.vecEnabled = db.getMeta(store.db, 'vec_enabled')
    out.notes = Number(store.db.prepare('SELECT count(*) AS n FROM notes').get().n)
    out.fts = Number(
        store.db
            .prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?')
            .get('"sqlite"*').n
    )
    out.indexExists = fs.existsSync(indexFile)
    out.lockExists = fs.existsSync(indexFile + '.lock')

    const deps = { store, gate, cwd }
    out.indexText = tools.memoryIndex(deps).text
    const search = await tools.memorySearch(deps, { query: 'sqlite' })
    out.searchError = search.isError ?? null
    out.searchText = search.text
    out.readText = (await tools.memoryRead(deps, { key: 'db/sqlite' })).text
    const wrote = await tools.memoryWrite(deps, {
        key: 'db/fts5',
        body: 'fts5 keeps the keyword index',
    })
    out.writeError = wrote.isError ?? null
    const edited = await tools.memoryEdit(deps, {
        key: 'db/fts5',
        oldText: 'keyword',
        newText: 'bm25',
        // The tool layer no longer returns the hash, so the read is its only source.
        baseHash: (await tools.memoryRead(deps, { key: 'db/fts5' })).details.hash,
    })
    out.editError = edited.isError ?? null
    out.deleteError = (await tools.memoryDelete(deps, { key: 'db/fts5' })).isError ?? null

    out.ino = fs.statSync(indexFile).ino
    out.ids = store.db.prepare('SELECT id FROM notes ORDER BY id').all().map(r => Number(r.id))
    store.close()

    const again = openStore(cwd, { gate })
    out.probeSecond = db.vecProbe(again.db).available
    out.hasVecSecond = notes.hasVecTable(again.db)
    out.vecEnabledSecond = db.getMeta(again.db, 'vec_enabled')
    out.inoSecond = fs.statSync(indexFile).ino
    out.idsSecond = again.db
        .prepare('SELECT id FROM notes ORDER BY id')
        .all()
        .map(r => Number(r.id))
    again.close()
} catch (err) {
    out.error = String((err && err.stack) || err)
}
process.stdout.write(JSON.stringify(out))
`

interface DowngradeReport {
    probe: boolean
    hasVec: boolean
    vecEnabled: string | null
    notes: number
    fts: number
    indexExists: boolean
    lockExists: boolean
    indexText: string
    searchError: string | null
    searchText: string
    readText: string
    writeError: string | null
    editError: string | null
    deleteError: string | null
    ino: number
    ids: number[]
    probeSecond: boolean
    hasVecSecond: boolean
    vecEnabledSecond: string | null
    inoSecond: number
    idsSecond: number[]
    error?: string
}

/**
 * The child needs absolute specifiers, and `import.meta` is rejected by this repo's
 * CommonJS type-checking config. The test script runs from either the repository root
 * or this directory, so both are tried and the first one holding the sources wins.
 */
function moduleRoot(): string {
    const candidates = [
        path.resolve(process.cwd(), 'agent-memory'),
        path.resolve(process.cwd()),
    ]
    return (
        candidates.find(dir => fs.existsSync(path.join(dir, 'store', 'store.ts'))) ??
        candidates[0]
    )
}

function openStoreInChild(host: string, root: string, cwd: string): DowngradeReport {
    const result = spawnSync(
        process.execPath,
        [
            '--experimental-strip-types',
            '--no-warnings',
            '--input-type=module',
            '-e',
            DOWNGRADE_PROBE,
        ],
        {
            encoding: 'utf8',
            timeout: 60_000,
            env: {
                ...process.env,
                PI_MEMORY_DIR: root,
                MEM_ROOT: host,
                MEM_CWD: cwd,
            },
        }
    )
    assert.equal(result.status, 0, `downgrade probe failed: ${result.stderr}`)
    return JSON.parse(result.stdout.trim()) as DowngradeReport
}

test('§12.24: a store with vectors downgrades when sqlite-vec cannot load and re-upgrades', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-db-cwd-'))
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
    const gate = denyGate()

    // 1. A store that really has a vector row.
    const seeded = openStore(cwd, { gate })
    t.after(() => seeded.close())
    const wrote = await seeded.writeNote({
        key: 'db/sqlite',
        body: 'sqlite vec0 stores the embeddings for the index',
    })
    assert.equal(wrote.ok, true)
    assert.equal(hasVecTable(seeded.db), true)
    const seededRow = seeded.db
        .prepare('SELECT id, body_hash FROM notes WHERE key = ?')
        .get('db/sqlite') as { id: number; body_hash: string }
    const vector = new Array<number>(EMBED_DIM).fill(0)
    vector[0] = 1
    writeVector(seeded.db, Number(seededRow.id), vector, seededRow.body_hash)
    assert.equal(vecRowCount(seeded.db), 1)
    seeded.close()

    // 2. A fresh process on a host where the platform binary is absent. It has to be
    // a separate process: this one has already mapped the real `.dylib`, and the
    // tools' vectorless behaviour is exactly what the criterion is about.
    const report = openStoreInChild(makeVectorlessHost(t), root, cwd)

    assert.equal(report.error, undefined, report.error)
    assert.equal(report.probe, false, 'the module loaded anyway')
    assert.equal(report.hasVec, false, 'vec_notes survived the downgrade')
    assert.equal(report.vecEnabled, 'false')
    assert.equal(report.notes, 1, 'the rebuild lost the note')
    assert.equal(report.fts, 1, 'the rebuilt FTS index did not find the note')
    assert.equal(report.indexExists, true, 'index.db was not recreated')
    assert.equal(report.lockExists, false, 'the index lock was left behind')
    // Every tool, on the vectorless index.
    assert.match(report.indexText, /db\/sqlite/)
    assert.equal(report.searchError, null, report.searchText)
    assert.match(report.searchText, /db\/sqlite/)
    assert.match(report.readText, /sqlite vec0 stores the embeddings/)
    assert.equal(report.writeError, null)
    assert.equal(report.editError, null)
    assert.equal(report.deleteError, null)

    // A second open must not delete and rebuild again (conditioning on `embed_dim`
    // instead of the latch would). A rebuild recreates the file, so its inode is the
    // evidence rather than a proxy; ids are the second witness.
    assert.equal(report.probeSecond, false)
    assert.equal(report.hasVecSecond, false)
    assert.equal(report.vecEnabledSecond, 'false')
    assert.equal(report.inoSecond, report.ino, 'the index was rebuilt a second time')
    assert.deepEqual(report.idsSecond, report.ids)

    // 3. Availability restored: this process re-opens the same database with the real
    // install — `vec_notes` is created, the latch returns to 'true', and the rebuild's
    // dropped `vec_hash` is what the backfill picks up.
    const revived = openStore(cwd, { gate })
    t.after(() => revived.close())
    assert.equal(vecProbe(revived.db).available, true)
    assert.equal(hasVecTable(revived.db), true, 'vec_notes was not re-created')
    assert.equal(getMeta(revived.db, 'vec_enabled'), 'true')
    const pending = needsEmbedding(revived.db)
    assert.equal(
        pending.some(row => row.key === 'db/sqlite'),
        true,
        'the re-upgrade left nothing for the backfill to pick up'
    )
    const revivedRow = revived.db
        .prepare('SELECT id, body_hash FROM notes WHERE key = ?')
        .get('db/sqlite') as { id: number; body_hash: string }
    const emb = new Array<number>(EMBED_DIM).fill(0)
    emb[1] = 1
    writeVector(revived.db, Number(revivedRow.id), emb, revivedRow.body_hash)
    assert.equal(vecRowCount(revived.db), 1)
})
