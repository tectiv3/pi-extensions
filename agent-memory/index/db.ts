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
import { message } from '../store/errors.ts'
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

export interface DowngradeOptions extends OpenIndexOptions {
    /**
     * Recreate seam, used by tests to reach the one failure the delete-and-recreate
     * has no other path to — the delete succeeded and the rebuild did not.
     */
    recreate?: (root: string) => DatabaseSync
}

/**
 * Opens the index with `index.db.lock` held, downgrading to a vectorless database
 * when §11 requires it. Every session takes this, which is what makes the lock cover
 * the open it protects (F10):
 *
 * - `openIndex` runs *inside* the lock, so no process can be holding a handle on an
 *   inode another one is about to unlink, and the schema/migration cannot race.
 * - `vec_enabled` is read from the file as it is at that moment, so two processes
 *   cannot both decide to downgrade: the second one opens what the first left behind
 *   and finds the latch at 'false'.
 *
 * The downgrade destroys the database rather than rebuilding it in place because,
 * with the module absent, `DELETE`/`DROP`/`SELECT` on `vec_notes` all fail with
 * `no such module: vec0` — §4's rebuild begins `DELETE FROM vec_notes`, so it cannot
 * run in the path that invokes it.
 *
 * The cost of holding the lock on *every* open is that a lock left behind by a crash
 * makes the next open fail loudly (`LockTimeoutError`) for up to the 30 s staleness
 * window instead of silently opening a database somebody else may be replacing. That
 * is the same trade `initStore`'s repo lock already makes, and the next session opens
 * normally.
 */
export function openIndexLocked(root: string, opts: DowngradeOptions = {}): DatabaseSync {
    return withFileLock(indexLockPath(root), 'index lock', () => {
        const db = openIndex(root, opts)
        if (!needsDowngrade(db)) return db
        // Nothing may use the old handle again: its file is about to be unlinked.
        db.close()
        removeIndexFiles(root)
        return recreateVectorless(root, opts)
    })
}

/**
 * §11's conditions, and only these. `embed_dim` is deliberately not consulted: it is
 * seeded at creation, so conditioning on it would delete and rebuild the index on
 * every session start while the module is absent.
 */
function needsDowngrade(db: DatabaseSync): boolean {
    return !vecProbe(db).available && getMeta(db, 'vec_enabled') === 'true'
}

/**
 * The recreate half of the downgrade. The old database is already gone, so the two
 * failures here have to end differently than the old code's leaked handle did:
 *
 * - The recreate itself fails: the error names the cause and says the index is
 *   rebuildable, and the next open starts from a clean file.
 * - The repopulate fails: the fresh handle is closed. A live, empty index would look
 *   like a store with no notes — and be indistinguishable from one, which is the
 *   state that took the extension down (F2).
 *
 * Files the repopulate skips are not lost: the reindex pass that follows every open
 * reports them through the UI (F1).
 */
function recreateVectorless(root: string, opts: DowngradeOptions): DatabaseSync {
    const recreate = opts.recreate ?? ((target: string) => openIndex(target, opts))
    let fresh: DatabaseSync
    try {
        fresh = recreate(root)
    } catch (err) {
        throw new Error(
            `vec0 downgrade could not recreate index.db: ${message(err)}; the index is rebuilt from the notes on the next start`,
            { cause: err }
        )
    }

    try {
        // opts reproduces the failure in tests; a genuinely restored module means
        // this recreate is a normal fresh index, so leave the latch on.
        if (!vecProbe(fresh).available) setMeta(fresh, 'vec_enabled', 'false')
        transaction(fresh, () => populateFromDisk(fresh, root), { immediate: true })
    } catch (err) {
        closeQuietly(fresh)
        throw new Error(
            `vec0 downgrade could not repopulate index.db: ${message(err)}; the index is rebuilt from the notes on the next start`,
            { cause: err }
        )
    }
    return fresh
}

/** A double close is not a failure worth masking the real one with. */
function closeQuietly(db: DatabaseSync): void {
    try {
        db.close()
    } catch {}
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
