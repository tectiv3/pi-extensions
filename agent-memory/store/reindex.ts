/**
 * Reindex from disk (§3.3, §4, §12.14) — the per-file pass that keeps the index in
 * step with hand edits without throwing the database away.
 *
 * `access` is read from each file (§2.1), which is what makes `rm index.db` lossless
 * rather than a gate bypass. Files whose hash is unchanged are skipped, so this stays
 * cheap enough for `session_start`.
 *
 * The error policy is per **file**, never per pass:
 *
 * - A filename that fails `normalizeKey` is **reported and skipped** (`walkNotes`).
 * - A file that cannot be read or whose frontmatter does not parse is **reported and
 *   its index row is dropped**. §2.1 fails closed: an unparseable `access:` must not
 *   be treated as `open`, and a row left behind would keep saying whatever it said
 *   before — including `access` — while the file says something else. Either way the
 *   pass completes, so one bad note cannot hide the store behind it.
 * - A row whose file is gone is **deleted** (F6) — but only after a complete walk,
 *   never one cut short by an unreadable directory.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { deleteNote, getNoteByKey, upsertNote } from '../index/notes.ts'
import { type NoteFileError, type StoreFile, readStoreFile, walkNotes } from './walk.ts'

export type ReindexError = NoteFileError

export interface ReindexResult {
    scanned: number
    updated: number
    skipped: number
    /** Rows deleted because their note file is no longer on disk. */
    removed: number
    errors: ReindexError[]
}

export function reindexFromDisk(root: string, db: DatabaseSync): ReindexResult {
    const result: ReindexResult = {
        scanned: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
    }
    /** Every `(scope, project, key)` whose file is still on disk, keyed by `rowKey`. */
    const seen = new Set<string>()

    for (const file of walkNotes(root, error => {
        result.errors.push(error)
        // An unnameable file is part of the pass's cost and of its report, so it
        // counts as scanned even though it never reaches the index.
        result.scanned++
    })) {
        result.scanned++
        seen.add(rowKey(file.scope, file.project, file.key))

        const read = readStoreFile(file)
        if ('error' in read) {
            result.errors.push(read.error)
            dropRow(db, file)
            continue
        }

        const existing = getNoteByKey(db, file.scope, file.project, file.key)
        if (existing !== null && existing.body_hash === read.bodyHash) {
            // Whole-file hash covers `access` too (§2.3), so an unchanged hash means
            // nothing at all needs rewriting.
            result.skipped++
            continue
        }

        upsertNote(db, {
            scope: file.scope,
            project: file.project,
            key: file.key,
            path: file.relPath,
            ...read,
        })
        result.updated++
    }

    result.removed = removeUnseen(root, db, seen)
    return result
}

/** Fail closed per note: an unparseable body must not stay searchable as it was. */
function dropRow(db: DatabaseSync, file: StoreFile): void {
    const existing = getNoteByKey(db, file.scope, file.project, file.key)
    if (existing !== null) deleteNote(db, existing.id)
}

/**
 * Rows whose note file is gone (F6). Two conditions, because one is not enough:
 *
 * - The row is not in `seen`, which only a complete walk may populate — `walkNotes`
 *   throws on an unreadable directory rather than return a short list.
 * - The file its `path` names does not exist. A row this pass did not see can simply
 *   be one another process wrote after the walk passed its directory, and deleting a
 *   live note's row would drop it from search until the next pass.
 */
function removeUnseen(root: string, db: DatabaseSync, seen: Set<string>): number {
    const rows = db.prepare('SELECT id, scope, project, key, path FROM notes').all()
    let removed = 0
    for (const row of rows) {
        const scope = String(row.scope)
        const project = String(row.project)
        const key = String(row.key)
        if (seen.has(rowKey(scope, project, key))) continue
        if (fs.existsSync(path.join(root, String(row.path)))) continue
        deleteNote(db, Number(row.id))
        removed++
    }
    return removed
}

/** NUL-joined: a key may contain `/` but never NUL, so the parts cannot collide. */
function rowKey(scope: string, project: string, key: string): string {
    return `${scope}\u0000${project}\u0000${key}`
}
