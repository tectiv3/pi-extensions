/**
 * Note rows: the upsert (§4), delete, search, vector writes and the full rebuild.
 *
 * Three defects this file exists to prevent, all measured in the spec:
 *
 * - `INSERT OR REPLACE` skips `notes_ad` (REPLACE's implicit delete does not fire
 *   triggers unless `recursive_triggers` is on), so the old key stays searchable
 *   while `integrity-check` reports ok. The upsert is `ON CONFLICT … DO UPDATE`
 *   with `RETURNING id`.
 * - `ON CONFLICT DO UPDATE` does not set `last_insert_rowid()`, so ids here come
 *   from `RETURNING id` only. After `upsert a/one` following `insert a/two`,
 *   `lastInsertRowid` is 2 while `a/one`'s id is 1 — using it attaches one note's
 *   embedding to another.
 * - `vec0` rejects a JS number for its primary key ("Only integers are allowed for
 *   primary key values on vec_notes"), so every id crossing into `vec_notes` goes
 *   through `toVecId()`.
 */

import type { DatabaseSync } from 'node:sqlite'

import type { Access } from '../store/frontmatter.ts'
import { normalizeKey } from '../store/keys.ts'
import type { Scope } from '../store/paths.ts'
import { type NoteFileError, readStoreFile, walkNotes } from '../store/walk.ts'

/** §4 candidate depths. Search callers should pass these, not invent their own. */
export const BM25_DEPTH = 50
export const VECTOR_K = 20

type Bind = null | number | bigint | string | Uint8Array

export interface NoteRow {
    id: number
    scope: Scope
    project: string
    key: string
    path: string
    body: string
    fm_len: number
    body_hash: string
    vec_hash: string | null
    access: Access
    mtime: number
}

export interface ScoredNote extends NoteRow {
    /** `bm25()` score: negative, more negative is a better match. */
    score: number
}

export interface NoteInput {
    scope: Scope
    /** `''`/absent for `scope=global`; required otherwise (§2). */
    project?: string
    key: string
    /** Path relative to the store root, as git sees it. */
    path: string
    /** Body **without** frontmatter (§4), so BM25 never matches `access: gated`. */
    body: string
    fmLen: number
    bodyHash: string
    access: Access
    /** `floor(stat(path).mtimeMs)`; a rebuild stamping `Date.now()` destroys recency. */
    mtime: number
}

/**
 * One tier a discovery path searches. `''` is the global scope's project, matching
 * `notes.project`; `scope: 'global'` always carries it (§2.2).
 */
export interface ScopeTarget {
    scope: Scope
    project: string
}

export interface NoteFilter {
    scope?: Scope
    project?: string
    access?: Access
    /**
     * Several tiers at once, in rank order (§5.1: project, then global). Mutually
     * exclusive with `scope`/`project`, which name a single tier.
     */
    scopes?: readonly ScopeTarget[]
}

export interface SearchOptions extends NoteFilter {
    limit?: number
}

export interface VectorHit {
    note_id: number
    distance: number
}

interface SqlFragment {
    sql: string
    params: Bind[]
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

function allRows<T>(db: DatabaseSync, sql: string, params: Bind[] = []): T[] {
    return db.prepare(sql).all(...params) as unknown as T[]
}

function oneRow<T>(db: DatabaseSync, sql: string, params: Bind[] = []): T | null {
    const row = db.prepare(sql).get(...params)
    return row === undefined ? null : (row as unknown as T)
}

/**
 * SQLite's own rollback after a fatal error leaves no transaction to roll back, and
 * a `ROLLBACK` that throws there would mask the original error — which is the one
 * worth reporting.
 */
export function transaction<T>(
    db: DatabaseSync,
    fn: () => T,
    opts: { immediate?: boolean } = {}
): T {
    db.exec(opts.immediate === true ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try {
        const result = fn()
        db.exec('COMMIT')
        return result
    } catch (err) {
        try {
            db.exec('ROLLBACK')
        } catch {}
        throw err
    }
}

/** A `vec0` table cannot be touched while the module is absent: `no such module: vec0`. */
export function hasVecTable(db: DatabaseSync): boolean {
    return (
        oneRow(
            db,
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'vec_notes'"
        ) !== null
    )
}

/**
 * The one place a note id becomes a vector id. `1` raises "Only integers are
 * allowed for primary key values on vec_notes"; `1n` is the only accepted form.
 */
export function toVecId(noteId: number): bigint {
    if (!Number.isSafeInteger(noteId) || noteId <= 0) {
        throw new Error(`vec_notes.note_id must be a positive integer, got ${noteId}`)
    }
    return BigInt(noteId)
}

// ---------------------------------------------------------------------------
// upsert / delete
// ---------------------------------------------------------------------------

/**
 * §4's upsert verbatim. `RETURNING id` is the only id source: `last_insert_rowid()`
 * is wrong after an update, and REPLACE's implicit delete does not fire the FTS
 * delete trigger.
 *
 * `vec_hash` is deliberately absent from the `DO UPDATE` set: it records which body
 * the *stored vector* came from, so an upsert must leave it stale until the vector
 * is rebuilt.
 */
export function upsertNote(db: DatabaseSync, note: NoteInput): number {
    const scope = note.scope
    const project = resolveProject(scope, note.project)
    const row = oneRow<{ id: number }>(
        db,
        `INSERT INTO notes(scope, project, key, path, body, fm_len, body_hash, vec_hash, access, mtime)
VALUES (?,?,?,?,?,?,?,NULL,?,?)
ON CONFLICT(scope, project, key) DO UPDATE SET
  path = excluded.path, body = excluded.body, fm_len = excluded.fm_len,
  body_hash = excluded.body_hash, access = excluded.access, mtime = excluded.mtime
RETURNING id`,
        [
            scope,
            project,
            normalizeKey(note.key),
            note.path,
            note.body,
            note.fmLen,
            note.bodyHash,
            note.access,
            note.mtime,
        ]
    )
    if (row === null)
        throw new Error(`upsert of ${scope}/${project}/${note.key} returned no id`)
    return row.id
}

export function deleteNote(db: DatabaseSync, id: number): void {
    transaction(db, () => {
        db.prepare('DELETE FROM notes WHERE id = ?').run(id)
        if (hasVecTable(db)) {
            db.prepare('DELETE FROM vec_notes WHERE note_id = ?').run(toVecId(id))
        }
    })
}

export function getNoteByKey(
    db: DatabaseSync,
    scope: Scope,
    project: string | undefined,
    key: string
): NoteRow | null {
    return oneRow<NoteRow>(
        db,
        'SELECT * FROM notes WHERE scope = ? AND project = ? AND key = ?',
        [scope, resolveProject(scope, project), normalizeKey(key)]
    )
}

export function getNoteById(db: DatabaseSync, id: number): NoteRow | null {
    return oneRow<NoteRow>(db, 'SELECT * FROM notes WHERE id = ?', [id])
}

export function listNotes(db: DatabaseSync, filter: NoteFilter = {}): NoteRow[] {
    const where = filterSql('', filter)
    return allRows<NoteRow>(
        db,
        `SELECT * FROM notes WHERE 1 = 1${where.sql} ORDER BY mtime DESC, id DESC`,
        where.params
    )
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * `bm25()` is negative and more negative is better, so the ranking is `ASC`. `DESC`
 * selects the worst hit — on a 30-note store the two directions pick opposite notes.
 *
 * Gated rows are excluded in SQL unless `access` names them explicitly (§5): a search
 * that returned a gated row would be a gate bypass, and §5.2 leaves no parameter for
 * one. Filtering here rather than after the fact is also what keeps the candidate
 * depth meaningful.
 */
export function searchBm25(
    db: DatabaseSync,
    query: string,
    options: SearchOptions = {}
): ScoredNote[] {
    const filter = filterSql('n.', { ...options, access: options.access ?? 'open' })
    // §5.1's "project wins" is a ranking rule, not only a read rule: with two tiers
    // in one query, equal `bm25()` scores must put the project note first. A global
    // note that scores strictly better still ranks above, which is what keeps the
    // fallback tier useful.
    const tieBreak = isMultiScope(options) ? ", n.scope = 'global' ASC" : ''
    const sql = `SELECT n.*, bm25(notes_fts) AS score
FROM notes_fts
JOIN notes n ON n.id = notes_fts.rowid
WHERE notes_fts MATCH ?${filter.sql}
ORDER BY bm25(notes_fts) ASC${tieBreak}
LIMIT ?`
    return allRows<ScoredNote>(db, sql, [query, ...filter.params, options.limit ?? BM25_DEPTH])
}

function isMultiScope(filter: NoteFilter): boolean {
    return filter.scopes !== undefined && filter.scopes.length > 1
}

/**
 * KNN with the gate applied **before** `k`. A `JOIN` applies it after, and silently
 * loses recall — measured: 1 row returned where 3 were expected, because gated rows
 * occupied the `k` slots and were then discarded.
 *
 * Gated notes are excluded unconditionally: §5.2 gives no tool parameter a path into
 * gated content, and the vector list never carried an access filter of its own.
 */
export function searchVector(
    db: DatabaseSync,
    embedding: ArrayLike<number>,
    options: Omit<SearchOptions, 'access'> = {}
): VectorHit[] {
    if (!hasVecTable(db)) return []
    const filter = filterSql('', { ...options, access: 'open' })
    const params: Bind[] = [vecBlob(embedding), options.limit ?? VECTOR_K, ...filter.params]
    const rows = allRows<{ note_id: number | bigint; distance: number }>(
        db,
        `SELECT note_id, distance FROM vec_notes
WHERE embedding MATCH ? AND k = ? AND note_id IN (SELECT id FROM notes WHERE 1 = 1${filter.sql})
ORDER BY distance`,
        params
    )
    return rows.map(row => ({ note_id: Number(row.note_id), distance: Number(row.distance) }))
}

/** The §4 re-enqueue predicate: without it nothing is ever re-embedded. */
export function needsEmbedding(db: DatabaseSync): NoteRow[] {
    return allRows<NoteRow>(
        db,
        'SELECT * FROM notes WHERE vec_hash IS NULL OR vec_hash <> body_hash ORDER BY mtime DESC, id DESC'
    )
}

// ---------------------------------------------------------------------------
// vectors
// ---------------------------------------------------------------------------

/**
 * §4's insert-or-update sequence. `UPDATE` on a missing row returns `{changes: 0}`,
 * so a spec that only says "re-embed is an UPDATE" never lands a note's first vector.
 * The `UNIQUE` retry is not paranoia: the vec table lives outside the repo lock, so
 * another process really can insert between our `UPDATE` and our `INSERT`.
 *
 * Vectors are unit-normalised first. `NLEmbedding` norms are 6.2–9.3, and `vec0`
 * ranks by L2 distance, so raw vectors rank by magnitude instead of similarity.
 */
export function writeVector(
    db: DatabaseSync,
    noteId: number,
    embedding: ArrayLike<number>,
    bodyHash: string
): boolean {
    const vecId = toVecId(noteId)
    if (!hasVecTable(db)) throw new Error('writeVector: vec_notes is unavailable')
    if (oneRow(db, 'SELECT 1 AS present FROM notes WHERE id = ?', [noteId]) === null) {
        // An orphan vector row is unreachable and would outlive its note.
        throw new Error(`writeVector: no note with id ${noteId}`)
    }

    const blob = vecBlob(embedding)
    const update = db.prepare('UPDATE vec_notes SET embedding = ? WHERE note_id = ?')
    if (Number(update.run(blob, vecId).changes) === 0) {
        try {
            db.prepare('INSERT INTO vec_notes(note_id, embedding) VALUES (?, ?)').run(
                vecId,
                blob
            )
        } catch (err) {
            if (!isUniqueViolation(err)) throw err
            if (Number(update.run(blob, vecId).changes) === 0) {
                throw new Error(
                    `writeVector: vec_notes lost note ${noteId} during the insert`,
                    { cause: err }
                )
            }
        }
    }
    // `bodyHash` is the body the *vector* was built from, not whatever the row says
    // now. Stamping the row's current hash would make a stale vector look fresh and
    // silently disable §4's re-enqueue predicate, so the stamp is conditional and a
    // mismatch discards it — the vector stays written, `vec_hash` stays stale, and the
    // next backfill rebuilds it.
    const stamped = db
        .prepare('UPDATE notes SET vec_hash = ? WHERE id = ? AND body_hash = ?')
        .run(bodyHash, noteId, bodyHash)
    return Number(stamped.changes) > 0
}

function vecBlob(embedding: ArrayLike<number>): Buffer {
    const floats = Float32Array.from(embedding)
    const norm = Math.hypot(...floats)
    if (norm === 0 || !Number.isFinite(norm)) {
        throw new Error('writeVector: embedding has no magnitude and cannot be normalised')
    }
    for (let i = 0; i < floats.length; i++) floats[i] = floats[i] / norm
    return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength)
}

function isUniqueViolation(err: unknown): boolean {
    // `vec0` reports "UNIQUE constraint failed on vec_notes primary key", not the
    // table-qualified SQLite message, so only the prefix is stable.
    return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

/**
 * §4's full rebuild: one transaction on the existing database, never a second file
 * and a rename. A stale `index.db-wal` from a concurrent writer is replayed over the
 * new main file, the rebuild is lost, `integrity_check` reports ok, and the live
 * writer fails with `no such table`.
 *
 * Without the `ROLLBACK`, a mid-repopulate throw leaves an open `BEGIN IMMEDIATE`
 * and every later write fails after `busy_timeout`.
 *
 * Ids are reassigned by a rebuild: `AUTOINCREMENT` never reuses one, so nothing may
 * carry `notes.id` across a rebuild. Embedding jobs are keyed by
 * `(scope, project, key, body_hash)` (§8.2).
 */
export function rebuildIndex(root: string, db: DatabaseSync): PopulateResult {
    return transaction(
        db,
        () => {
            db.exec('DELETE FROM notes')
            // Guarded rather than unconditional: §11's downgrade path runs with the
            // module absent, where `DELETE FROM vec_notes` is `no such module: vec0`.
            if (hasVecTable(db)) db.exec('DELETE FROM vec_notes')
            return populateFromDisk(db, root)
        },
        { immediate: true }
    )
}

export interface PopulateResult {
    /** Notes written into the index. */
    indexed: number
    /** Files that could not be indexed, each named by path. */
    errors: NoteFileError[]
}

/**
 * Reads every note file under `global/` and `projects/*` into `notes`. The caller
 * owns the transaction; this is also §11's downgrade body, where the database is
 * freshly recreated and must not touch `vec_notes` at all.
 *
 * `parseNote` is authoritative for `access` (§2.1) and for `fm_len`, so a note it
 * refuses is **left out** of the index and reported, never stored as `open`. The
 * skip is per file: this function is on the downgrade path, where throwing would
 * leave the recreated database empty and take the extension down with it (F2).
 */
export function populateFromDisk(db: DatabaseSync, root: string): PopulateResult {
    const result: PopulateResult = { indexed: 0, errors: [] }
    for (const file of walkNotes(root, error => result.errors.push(error))) {
        const read = readStoreFile(file)
        if ('error' in read) {
            result.errors.push(read.error)
            continue
        }
        upsertNote(db, {
            scope: file.scope,
            project: file.project,
            key: file.key,
            path: file.relPath,
            ...read,
        })
        result.indexed++
    }
    return result
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

function filterSql(prefix: string, filter: NoteFilter): SqlFragment {
    const clauses: string[] = []
    const params: Bind[] = []
    if (filter.scopes !== undefined && filter.scopes.length > 0) {
        // One OR group per tier, ANDed with the access filter so a gated row is still
        // excluded before ranking in every tier.
        const tiers = filter.scopes.map(() => `(${prefix}scope = ? AND ${prefix}project = ?)`)
        clauses.push(`(${tiers.join(' OR ')})`)
        for (const target of filter.scopes) params.push(target.scope, target.project)
    } else {
        if (filter.scope !== undefined) {
            clauses.push(`${prefix}scope = ?`)
            params.push(filter.scope)
        }
        if (filter.project !== undefined) {
            clauses.push(`${prefix}project = ?`)
            params.push(filter.project)
        }
    }
    if (filter.access !== undefined) {
        clauses.push(`${prefix}access = ?`)
        params.push(filter.access)
    }
    return { sql: clauses.map(clause => ` AND ${clause}`).join(''), params }
}

/**
 * Normalising here rather than trusting callers: a `NULL` project on a global note
 * reopens the duplicate-row hole the `''` default closes, and an empty project on a
 * project-scoped note would collapse every project into one row.
 */
function resolveProject(scope: Scope, project: string | undefined): string {
    const value = project ?? ''
    if (scope === 'global') {
        if (value !== '') throw new Error(`global note cannot carry project "${value}"`)
        return ''
    }
    if (value === '') throw new Error('project-scoped note requires a project id')
    return value
}
