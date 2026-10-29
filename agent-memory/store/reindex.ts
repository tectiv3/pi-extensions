/**
 * Reindex from disk (§3.3, §4, §12.14) — the per-file pass that keeps the index in
 * step with hand edits without throwing the database away.
 *
 * `access` is read from each file (§2.1), which is what makes `rm index.db` lossless
 * rather than a gate bypass. Files whose hash is unchanged are skipped, so this stays
 * cheap enough for `session_start`.
 *
 * The error policy is deliberately asymmetric:
 *
 * - A filename that fails `normalizeKey` is **reported, not thrown**. The store is
 *   hand-editable markdown; one stray `Bad Name.md` must not brick reindex for the
 *   hundreds of valid notes beside it.
 * - An unparseable `access:` **is** thrown. §2.1 fails closed: skipping a gated note
 *   as if it were open would both un-gate it and leave `access: gated` in the body,
 *   where it becomes searchable. A loud failure is the only safe outcome.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { getNoteByKey, type NoteInput, upsertNote } from '../index/notes.ts'
import { fileHash, parseNote } from './frontmatter.ts'
import { normalizeKey } from './keys.ts'
import type { Scope } from './paths.ts'

export interface ReindexError {
    /** Path relative to the store root, in posix form. */
    path: string
    reason: string
}

export interface ReindexResult {
    scanned: number
    updated: number
    skipped: number
    errors: ReindexError[]
}

export function reindexFromDisk(root: string, db: DatabaseSync): ReindexResult {
    const result: ReindexResult = { scanned: 0, updated: 0, skipped: 0, errors: [] }

    for (const file of noteFiles(root)) {
        result.scanned++

        let key: string
        try {
            key = normalizeKey(toPosix(path.relative(file.scopeRoot, file.absPath)))
        } catch (err) {
            result.errors.push({ path: file.relPath, reason: reasonOf(err) })
            continue
        }

        // `parseNote` throws here, by design: see the module comment.
        const raw = fs.readFileSync(file.absPath)
        const parsed = parseNote(raw)
        const bodyHash = fileHash(raw)

        const existing = getNoteByKey(db, file.scope, file.project, key)
        if (existing !== null && existing.body_hash === bodyHash) {
            // Whole-file hash covers `access` too (§2.3), so an unchanged hash means
            // nothing at all needs rewriting.
            result.skipped++
            continue
        }

        const row: NoteInput = {
            scope: file.scope,
            project: file.project,
            key,
            path: file.relPath,
            body: parsed.body,
            fmLen: parsed.fmLen,
            bodyHash,
            access: parsed.access,
            mtime: Math.floor(fs.statSync(file.absPath).mtimeMs),
        }
        upsertNote(db, row)
        result.updated++
    }

    return result
}

interface DiskFile {
    scope: Scope
    /** `''` for the global scope. */
    project: string
    scopeRoot: string
    absPath: string
    relPath: string
}

function noteFiles(root: string): DiskFile[] {
    const files: DiskFile[] = []
    collect(root, 'global', '', path.join(root, 'global'), files)
    const projectsRoot = path.join(root, 'projects')
    for (const project of directoryNames(projectsRoot)) {
        // A project directory name is used verbatim: it is the id `projects.json`
        // records, and the id — not the checkout path — is what identity resolves to.
        collect(root, 'project', project, path.join(projectsRoot, project), files)
    }
    return files
}

function collect(
    root: string,
    scope: Scope,
    project: string,
    scopeRoot: string,
    files: DiskFile[]
): void {
    const walk = (dir: string): void => {
        for (const name of directoryNames(dir)) walk(path.join(dir, name))
        for (const name of fileNames(dir)) {
            if (!name.endsWith('.md')) continue
            const absPath = path.join(dir, name)
            files.push({
                scope,
                project,
                scopeRoot,
                absPath,
                relPath: toPosix(path.relative(root, absPath)),
            })
        }
    }
    walk(scopeRoot)
}

function directoryNames(dir: string): string[] {
    return entries(dir)
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
}

function fileNames(dir: string): string[] {
    return entries(dir)
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
}

/** A missing `global/` or `projects/` directory is an empty one, not an error. */
function entries(dir: string): fs.Dirent[] {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .slice()
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
    }
}

function reasonOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function toPosix(relPath: string): string {
    return relPath.split(path.sep).join('/')
}
