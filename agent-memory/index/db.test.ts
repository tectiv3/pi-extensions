import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'

import { indexLockPath } from '../store/paths.ts'
import {
    type OpenIndexOptions,
    type VecProbe,
    getMeta,
    handleVecAvailable,
    handleVecUnavailable,
    migrate,
    openIndex,
    SchemaVersionError,
    setMeta,
    vecProbe,
} from './db.ts'
import { hasVecTable, upsertNote, type NoteInput } from './notes.ts'

function makeRoot(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-index-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

/** The after-hook closes whichever handle the test ended up with, including one
 *  that `handleVecUnavailable` already closed itself. */
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
    seeded.close()

    // Next start on a machine where the module cannot load.
    const vectorless = track(t, openIndex(root, { vecLoader: null }))
    assert.equal(vecProbe(vectorless).available, false)
    assert.equal(getMeta(vectorless, 'vec_enabled'), 'true')

    const downgraded = track(t, handleVecUnavailable(root, vectorless, { vecLoader: null }))
    assert.notEqual(downgraded, vectorless)
    assert.equal(vecProbe(downgraded).available, false)
    assert.equal(hasVecTable(downgraded), false)
    assert.equal(getMeta(downgraded, 'vec_enabled'), 'false')
    assert.equal(countNotes(downgraded), 1)
    assert.equal(matchCount(downgraded, 'quokka'), 1)
    assert.ok(fs.existsSync(path.join(root, 'index.db')))
    assert.equal(fs.existsSync(indexLockPath(root)), false)

    const idsBefore = downgraded
        .prepare('SELECT id FROM notes ORDER BY id')
        .all()
        .map(row => Number(row.id))

    // Second start with the module still absent: the latch is the condition, so
    // nothing is deleted or rebuilt again (conditioning on embed_dim would rebuild
    // every session).
    const again = handleVecUnavailable(root, downgraded, { vecLoader: null })
    assert.equal(again, downgraded)
    const idsAfter = downgraded
        .prepare('SELECT id FROM notes ORDER BY id')
        .all()
        .map(row => Number(row.id))
    assert.deepEqual(idsAfter, idsBefore)
    assert.equal(getMeta(downgraded, 'vec_enabled'), 'false')
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
