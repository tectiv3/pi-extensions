/**
 * `index.db` — schema, pragmas, the `vec0` probe and the §11 downgrade path.
 *
 * The index is disposable (§3.3): everything here may throw the database away and
 * repopulate it from the markdown files. Two properties are load-bearing and are
 * the reason most of this file exists:
 *
 * - `allowExtension` is a construction-time flag. A handle opened without it can
 *   never load `vec0`, so a database opened while the module was absent could not
 *   be re-upgraded in place. It is therefore always set.
 * - `vec_enabled` is the downgrade latch, and it is the *only* condition. Seeding
 *   `embed_dim` at creation means conditioning on it would delete and rebuild the
 *   index on every session start while the module is absent.
 */

import * as fs from 'node:fs'

import { DatabaseSync } from 'node:sqlite'
import * as sqliteVec from 'sqlite-vec'

import { withFileLock } from '../store/git.ts'
import { indexLockPath, indexPath, indexPathSidecars } from '../store/paths.ts'
import { populateFromDisk, transaction } from './notes.ts'

export const SCHEMA_VERSION = 1
export const EMBED_MODEL = 'nlembedding-en'
export const EMBED_DIM = 512

/**
 * §4 verbatim, plus `IF NOT EXISTS` so reopening an existing database is free.
 *
 * The three triggers are not optional: an external-content FTS5 table does not
 * index itself, so without them `notes_fts` has rows and every `MATCH` returns
 * nothing (measured).
 *
 * `project` is `''` and never `NULL`: SQLite treats `NULL` as distinct in a
 * `UNIQUE` index, so a nullable `project` permits unlimited duplicate global rows
 * for one key, and makes the `ON CONFLICT` target inexpressible.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  project    TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  path       TEXT NOT NULL,
  body       TEXT NOT NULL,
  fm_len     INTEGER NOT NULL,
  body_hash  TEXT NOT NULL,
  vec_hash   TEXT,
  access     TEXT NOT NULL,
  mtime      INTEGER NOT NULL,
  UNIQUE(scope, project, key)
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  key, body, content='notes', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, key, body) VALUES (new.id, new.key, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, key, body) VALUES('delete', old.id, old.key, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, key, body) VALUES('delete', old.id, old.key, old.body);
  INSERT INTO notes_fts(rowid, key, body) VALUES (new.id, new.key, new.body);
END;

CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`

/** §11: created with `IF NOT EXISTS` so a successful probe can backfill a vectorless DB. */
const VEC_SCHEMA_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS vec_notes USING vec0(
  note_id INTEGER PRIMARY KEY, embedding FLOAT[512]
);`

export interface VecProbe {
    available: boolean
    /** `vec_version()`'s own string, e.g. `v0.1.9`. */
    version: string | null
}

export type VecLoader = (db: DatabaseSync) => void

export interface OpenIndexOptions {
    /**
     * Loading seam, used by tests to simulate a host whose native module cannot be
     * loaded — the only way to reach the downgrade path without uninstalling
     * `sqlite-vec`. `null` disables loading entirely.
     */
    vecLoader?: VecLoader | null
}

export class SchemaVersionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SchemaVersionError'
    }
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

/**
 * Opens (creating it when missing) the index for `root`.
 *
 * Order matters: the extension has to load before the schema can contain
 * `vec_notes`, because `CREATE VIRTUAL TABLE … USING vec0` raises
 * `no such module: vec0` while the module is absent.
 */
export function openIndex(root: string, opts: OpenIndexOptions = {}): DatabaseSync {
    fs.mkdirSync(root, { recursive: true })
    const db = new DatabaseSync(indexPath(root), { allowExtension: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')

    const probe = loadVec(db, opts)
    createSchema(db, probe.available)
    migrate(db)
    seedMeta(db, probe.available)
    // The re-upgrade half of §11 is safe in place (no lock, nothing destroyed) and
    // doing it here means a restored module cannot be left waiting on a caller that
    // forgot: without the table, `vec_enabled='true'` alone lets the backfill write
    // nowhere.
    handleVecAvailable(db)
    return db
}

/**
 * A loader failure is not an error here: it is the condition §11 handles. The
 * probe below decides, and a failing probe is what makes the DB vectorless.
 */
function loadVec(db: DatabaseSync, opts: OpenIndexOptions): VecProbe {
    const loader = opts.vecLoader === undefined ? loadSqliteVec : opts.vecLoader
    if (loader === null) return { available: false, version: null }
    try {
        loader(db)
    } catch {
        return { available: false, version: null }
    }
    return vecProbe(db)
}

function loadSqliteVec(db: DatabaseSync): void {
    sqliteVec.load(db)
}

export function vecProbe(db: DatabaseSync): VecProbe {
    try {
        const row = db.prepare('SELECT vec_version() AS version').get()
        const version = row?.version
        return {
            available: true,
            version: typeof version === 'string' ? version : null,
        }
    } catch {
        return { available: false, version: null }
    }
}

function createSchema(db: DatabaseSync, vecAvailable: boolean): void {
    db.exec(SCHEMA_SQL)
    if (vecAvailable) ensureVecTable(db)
}

export function ensureVecTable(db: DatabaseSync): void {
    db.exec(VEC_SCHEMA_SQL)
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export function getMeta(db: DatabaseSync, key: string): string | null {
    const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key)
    const value = row?.v
    return typeof value === 'string' ? value : null
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
    db.prepare(
        'INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
    ).run(key, value)
}

/**
 * Seeds only absent keys: `vec_enabled` is the downgrade latch and must survive a
 * restart, and `embed_dim` is seeded at creation so a vectorless DB still records
 * the dimension its vectors will have once the module returns.
 */
function seedMeta(db: DatabaseSync, vecAvailable: boolean): void {
    const insert = db.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)')
    insert.run('schema_version', String(SCHEMA_VERSION))
    insert.run('embed_model', EMBED_MODEL)
    insert.run('embed_dim', String(EMBED_DIM))
    insert.run('vec_enabled', vecAvailable ? 'true' : 'false')
}

/**
 * A no-op at the current version. An unknown *newer* version is an error rather
 * than a best-effort open: running an old extension against a newer schema could
 * corrupt rows it does not understand, and the index is rebuildable, so the honest
 * answer is "delete index.db or upgrade".
 */
export function migrate(db: DatabaseSync): void {
    const raw = getMeta(db, 'schema_version')
    if (raw === null) {
        setMeta(db, 'schema_version', String(SCHEMA_VERSION))
        return
    }
    const version = Number(raw)
    if (!Number.isInteger(version)) {
        throw new SchemaVersionError(
            `index.db schema_version "${raw}" is not an integer; delete index.db to reindex`
        )
    }
    if (version > SCHEMA_VERSION) {
        throw new SchemaVersionError(
            `index.db schema version ${version} is newer than this extension supports (${SCHEMA_VERSION}); upgrade the extension or delete index.db`
        )
    }
    if (version < SCHEMA_VERSION) {
        throw new SchemaVersionError(
            `no migration path from index.db schema version ${version} to ${SCHEMA_VERSION}`
        )
    }
}

// ---------------------------------------------------------------------------
// vec0 downgrade / re-upgrade (§11)
// ---------------------------------------------------------------------------

/**
 * §11's downgrade. When the probe fails and the latch says vectors were on, the
 * database is deleted and recreated without `vec_notes`, then repopulated from the
 * files and marked `vec_enabled='false'`.
 *
 * The reason the database is destroyed rather than rebuilt in place: with the module
 * absent, `DELETE`/`DROP`/`SELECT` on `vec_notes` all fail with `no such module:
 * vec0`, so §4's rebuild — which begins `DELETE FROM vec_notes` — cannot run in the
 * path that invokes it.
 *
 * Deletion happens under `index.db.lock`: the repo lock does not cover a database
 * shared across scopes, and deleting a live database is the hazard §4 measured.
 *
 * Returns the handle to use. It is a *new* handle when a rebuild happened, and the
 * argument when the call was a no-op.
 */
export function handleVecUnavailable(
    root: string,
    db: DatabaseSync,
    opts: OpenIndexOptions = {}
): DatabaseSync {
    if (vecProbe(db).available) return db
    // The latch, never `embed_dim`: see the file header.
    if (getMeta(db, 'vec_enabled') !== 'true') return db

    return withFileLock(indexLockPath(root), 'index lock', () => {
        // Another process may have downgraded while we waited for the lock.
        if (vecProbe(db).available) return db
        if (getMeta(db, 'vec_enabled') !== 'true') return db

        db.close()
        removeIndexFiles(root)

        const fresh = openIndex(root, opts)
        // opts reproduces the failure in tests; a genuinely restored module means
        // this recreate is a normal fresh index, so leave the latch on.
        if (!vecProbe(fresh).available) setMeta(fresh, 'vec_enabled', 'false')
        transaction(fresh, () => populateFromDisk(fresh, root), { immediate: true })
        return fresh
    })
}

/**
 * §11's re-upgrade. The table was never created in a vectorless DB, so
 * `vec_enabled='true'` alone would leave the backfill with nowhere to write.
 * Returns `true` when this call flipped the latch. `openIndex` calls it on every
 * open, so the exported form exists for callers holding their own handle.
 */
export function handleVecAvailable(db: DatabaseSync): boolean {
    if (!vecProbe(db).available) return false
    if (getMeta(db, 'vec_enabled') === 'true') return false
    ensureVecTable(db)
    setMeta(db, 'vec_enabled', 'true')
    return true
}

function removeIndexFiles(root: string): void {
    for (const file of indexPathSidecars(root)) {
        try {
            fs.unlinkSync(file)
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
    }
}
