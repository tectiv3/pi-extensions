import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'

import { EMBED_DIM, openIndex } from './db.ts'
import {
    deleteNote,
    getNoteByKey,
    hasVecTable,
    listNotes,
    needsEmbedding,
    type NoteInput,
    rebuildIndex,
    searchBm25,
    searchVector,
    upsertNote,
    writeVector,
} from './notes.ts'

function makeRoot(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-notes-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function openTemp(t: TestContext): { root: string; db: DatabaseSync } {
    const root = makeRoot(t)
    const db = openIndex(root)
    t.after(() => {
        try {
            db.close()
        } catch {}
    })
    return { root, db }
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

/** The body hash `noteInput` gives a key; `writeVector` takes the expected one (F7). */
function hashOf(key: string): string {
    return `hash-${key}`
}

/** A 512-dim basis vector; `writeVector` normalises it, so length stays 1. */
function vectorFor(index: number): number[] {
    const values = new Array<number>(EMBED_DIM).fill(0)
    values[index] = 1
    return values
}

/** A unit-ish vector a small angle away from `vectorFor(0)`. */
function nearVector(tilt: number): number[] {
    const values = new Array<number>(EMBED_DIM).fill(0)
    values[0] = 1
    values[1] = tilt
    return values
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

function vectorIds(db: DatabaseSync): number[] {
    return db
        .prepare('SELECT note_id FROM vec_notes ORDER BY note_id')
        .all()
        .map(row => Number(row.note_id))
}

function writeNoteFile(root: string, relPath: string, content: string): void {
    const target = path.join(root, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
}

test('upsertNote returns the updated row id, not lastInsertRowid', t => {
    const { db } = openTemp(t)

    const one = upsertNote(db, noteInput({ key: 'a/one' }))
    const two = upsertNote(db, noteInput({ key: 'a/two' }))
    assert.equal(one, 1)
    assert.equal(two, 2)

    const updated = upsertNote(db, noteInput({ key: 'a/one', body: 'changed' }))
    assert.equal(updated, one)

    // The trap the RETURNING form exists for: the update does not move
    // last_insert_rowid(), so it still names the row inserted after `a/one`.
    const trap = Number(db.prepare('SELECT last_insert_rowid() AS id').get()?.id)
    assert.equal(trap, two)
    assert.notEqual(trap, updated)
})

test('an update never leaves the old body searchable', t => {
    const { db } = openTemp(t)

    upsertNote(db, noteInput({ key: 'a/one', body: 'quokka sightings' }))
    assert.equal(matchCount(db, 'quokka'), 1)

    upsertNote(db, noteInput({ key: 'a/one', body: 'wombat sightings' }))
    assert.equal(matchCount(db, 'quokka'), 0)
    assert.equal(matchCount(db, 'wombat'), 1)
    assert.equal(countNotes(db), 1)
})

test('delete removes notes, fts and vec rows, and ids are never reused', t => {
    const { db } = openTemp(t)
    assert.ok(hasVecTable(db))

    const first = upsertNote(db, noteInput({ key: 'a/one', body: 'quokka' }))
    writeVector(db, first, vectorFor(0), hashOf('a/one'))
    assert.deepEqual(vectorIds(db), [first])

    deleteNote(db, first)
    assert.equal(countNotes(db), 0)
    assert.equal(matchCount(db, 'quokka'), 0)
    assert.deepEqual(vectorIds(db), [])

    const next = upsertNote(db, noteInput({ key: 'a/one', body: 'quokka' }))
    assert.equal(next, first + 1)
    // AUTOINCREMENT is the reason a new note cannot inherit the deleted note's vector.
    assert.deepEqual(vectorIds(db), [])
})

test('writeVector inserts when absent and updates when present', t => {
    const { db } = openTemp(t)
    const id = upsertNote(db, noteInput({ key: 'a/one' }))

    writeVector(db, id, vectorFor(0), hashOf('a/one'))
    assert.deepEqual(vectorIds(db), [id])
    const first = searchVector(db, vectorFor(0), { limit: 1 })
    assert.ok(first[0].distance < 1e-6)
    assert.equal(getNoteByKey(db, 'global', '', 'a/one')?.vec_hash, 'hash-a/one')

    // Calling twice is the reproduced insert-after-insert race: the second call must
    // not throw on `UNIQUE constraint failed`.
    writeVector(db, id, vectorFor(1), hashOf('a/one'))
    assert.deepEqual(vectorIds(db), [id])
    const second = searchVector(db, vectorFor(1), { limit: 1 })
    assert.ok(second[0].distance < 1e-6)
    const stale = searchVector(db, vectorFor(0), { limit: 1 })
    assert.ok(stale[0].distance > 0.5)
})

test('searchBm25 returns best first', t => {
    const { db } = openTemp(t)

    upsertNote(
        db,
        noteInput({ key: 'strong', body: 'sqlite sqlite sqlite sqlite indexing internals' })
    )
    upsertNote(
        db,
        noteInput({
            key: 'weak',
            body: 'a long note about gardening, cooking, travel, weather, music, and sqlite once',
        })
    )

    const hits = searchBm25(db, 'sqlite')
    assert.equal(hits.length, 2)
    assert.ok(
        hits.every(hit => hit.score < 0),
        'bm25 scores are negative'
    )
    assert.equal(hits[0].key, 'strong')
    assert.ok(hits[0].score < hits[1].score, 'more negative is a better match')

    // Gated rows are excluded in SQL by default: §5.2 leaves no parameter that could
    // return one, so the exclusion cannot live in the caller.
    upsertNote(
        db,
        noteInput({
            key: 'hidden',
            access: 'gated',
            body: 'sqlite sqlite sqlite sqlite sqlite',
        })
    )
    assert.deepEqual(
        searchBm25(db, 'sqlite').map(hit => hit.key),
        ['strong', 'weak']
    )
    assert.deepEqual(
        searchBm25(db, 'sqlite', { access: 'gated' }).map(hit => hit.key),
        ['hidden']
    )
    assert.deepEqual(searchBm25(db, 'sqlite', { access: 'open', scope: 'project' }), [])

    deleteNote(db, hits[0].id)
    assert.equal(searchBm25(db, 'sqlite').length, 1)
})

test('searchVector filters gated notes before k', t => {
    const { db } = openTemp(t)

    const open = upsertNote(db, noteInput({ key: 'open/one', access: 'open' }))
    writeVector(db, open, vectorFor(2), hashOf('open/one'))
    const gated: number[] = []
    for (const [i, key] of ['gated/one', 'gated/two', 'gated/three'].entries()) {
        const id = upsertNote(db, noteInput({ key, access: 'gated' }))
        writeVector(db, id, nearVector(0.02 * (i + 1)), hashOf(key))
        gated.push(id)
    }

    // Without the filter, k=2 selects two gated rows (they are much closer to the
    // query) and a post-k filter would return nothing.
    const hits = searchVector(db, vectorFor(0), { limit: 2 })
    assert.ok(hits.length >= 1)
    assert.deepEqual(
        hits.map(hit => hit.note_id),
        [open]
    )

    // The same filter applies to scope/project narrowing.
    assert.deepEqual(searchVector(db, vectorFor(0), { scope: 'project' }), [])
    assert.deepEqual(
        searchVector(db, vectorFor(0), { scope: 'global', limit: 5 }).map(hit => hit.note_id),
        [open]
    )
})

test('writeVector stamps vec_hash only for the body the vector was built from (F7)', t => {
    const { db } = openTemp(t)
    const id = upsertNote(db, noteInput({ key: 'a/one', bodyHash: 'H1' }))

    // The body moved on after the vector was computed: the stale write must not claim
    // it describes H2, or the re-enqueue predicate would never see the mismatch.
    upsertNote(db, noteInput({ key: 'a/one', body: 'new body', bodyHash: 'H2' }))
    assert.equal(writeVector(db, id, vectorFor(0), 'H1'), false)

    const row = getNoteByKey(db, 'global', '', 'a/one')
    assert.equal(row?.body_hash, 'H2')
    assert.equal(row?.vec_hash, null, 'a stale vector stamped the current body hash')
    assert.deepEqual(
        needsEmbedding(db).map(stale => stale.key),
        ['a/one']
    )

    // The matching write is accepted and pins the pair.
    assert.equal(writeVector(db, id, vectorFor(0), 'H2'), true)
    assert.equal(getNoteByKey(db, 'global', '', 'a/one')?.vec_hash, 'H2')
    assert.deepEqual(needsEmbedding(db), [])
})

test('needsEmbedding selects NULL and stale vec_hash only', t => {
    const { db } = openTemp(t)

    const id = upsertNote(db, noteInput({ key: 'a/one', bodyHash: 'v1' }))
    assert.deepEqual(
        needsEmbedding(db).map(row => row.key),
        ['a/one']
    )

    writeVector(db, id, vectorFor(0), 'v1')
    assert.deepEqual(needsEmbedding(db), [])

    // The upsert leaves vec_hash stale on purpose: it records the body the stored
    // vector came from.
    upsertNote(db, noteInput({ key: 'a/one', body: 'new body', bodyHash: 'v2' }))
    assert.deepEqual(
        needsEmbedding(db).map(row => row.key),
        ['a/one']
    )
})

test('rebuildIndex repopulates from disk and skips a bad file', t => {
    const { root, db } = openTemp(t)

    writeNoteFile(root, 'global/a/one.md', 'quokka body')
    writeNoteFile(
        root,
        'projects/proj-1a2b3c4d/auth/session.md',
        '---\naccess: gated\n---\nsecret body'
    )
    assert.equal(rebuildIndex(root, db).indexed, 2)

    const global = getNoteByKey(db, 'global', '', 'a/one')
    const gated = getNoteByKey(db, 'project', 'proj-1a2b3c4d', 'auth/session')
    assert.ok(global !== null && gated !== null)
    assert.equal(global.access, 'open')
    assert.equal(global.path, 'global/a/one.md')
    assert.equal(
        global.mtime,
        Math.floor(fs.statSync(path.join(root, 'global/a/one.md')).mtimeMs)
    )
    assert.equal(gated.access, 'gated')
    assert.equal(gated.body, 'secret body')
    assert.equal(gated.fm_len, Buffer.byteLength('---\naccess: gated\n---\n'))
    assert.equal(gated.path, 'projects/proj-1a2b3c4d/auth/session.md')
    assert.equal(matchCount(db, 'quokka'), 1)
    assert.equal(matchCount(db, 'gated'), 0)

    const idsBefore = listNotes(db)
        .map(row => row.id)
        .sort((a, b) => a - b)

    // An unparseable `access:` is never indexed as `open` (§2.1), and never aborts the
    // rebuild either: the same function is §11's downgrade body, where a throw would
    // leave a freshly recreated index empty and take the extension down (F2).
    writeNoteFile(root, 'global/a/broken.md', '---\naccess: hidden\n---\nsecret')
    const rebuilt = rebuildIndex(root, db)
    assert.equal(rebuilt.indexed, 2)
    assert.deepEqual(
        rebuilt.errors.map(error => error.path),
        ['global/a/broken.md']
    )
    assert.equal(getNoteByKey(db, 'global', '', 'a/broken'), null)
    assert.equal(matchCount(db, 'quokka'), 1)
    assert.equal(matchCount(db, 'hidden'), 0)
    // A rebuild reassigns ids; embedding jobs are keyed by (scope, project, key,
    // body_hash) for exactly this reason (§8.2).
    assert.ok(
        listNotes(db).every(row => !idsBefore.includes(row.id)),
        'rebuild must reassign ids'
    )
})

test('rebuildIndex rolls back when the walk itself fails', t => {
    const { root, db } = openTemp(t)

    writeNoteFile(root, 'global/a/one.md', 'quokka body')
    assert.equal(rebuildIndex(root, db).indexed, 1)
    const idsBefore = listNotes(db)
        .map(row => row.id)
        .sort((a, b) => a - b)

    // A regular file where the `global/` directory belongs is ENOTDIR out of the walk:
    // the one failure a rebuild cannot absorb per file, because a short walk would look
    // like a store whose notes were deleted.
    const global = path.join(root, 'global')
    fs.rmSync(global, { recursive: true, force: true })
    fs.writeFileSync(global, 'not a directory')

    assert.throws(() => rebuildIndex(root, db), /ENOTDIR/)
    assert.deepEqual(
        listNotes(db)
            .map(row => row.id)
            .sort((a, b) => a - b),
        idsBefore
    )
    assert.equal(matchCount(db, 'quokka'), 1)
    // The ROLLBACK is what makes this observable: a leaked BEGIN IMMEDIATE would
    // leave every later write failing after busy_timeout.
    upsertNote(db, noteInput({ key: 'a/after-rollback' }))
})
