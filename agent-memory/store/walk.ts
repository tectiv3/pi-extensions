/**
 * The one walk of the note tree.
 *
 * `reindexFromDisk` (the per-file startup pass) and `populateFromDisk` (a rebuild and
 * §11's downgrade) both read the store's files through this, so the two cannot
 * disagree about which files count or what a bad file costs. They did: one walker
 * had no error policy and threw the whole pass away, the other reported per file.
 *
 * Both trees are covered — `global/` and `projects/<id>/` — which is what lets the
 * reindex deletion pass trust "not seen" to mean "not on disk".
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { message } from './errors.ts'
import { type Access, fileHash, parseNote } from './frontmatter.ts'
import { normalizeKey } from './keys.ts'
import type { Scope } from './paths.ts'

export interface NoteFileError {
    /** Path relative to the store root, in posix form. */
    path: string
    reason: string
}

export interface StoreFile {
    scope: Scope
    /** `''` for the global scope. */
    project: string
    /** Normalised (§2.2): `.md` stripped, lowercased. */
    key: string
    /** Path relative to the store root, in posix form — the path git and the index store. */
    relPath: string
    absPath: string
}

/**
 * The store's note files, in a stable order.
 *
 * `onError` is mandatory: a filename that fails `normalizeKey` is reported and
 * skipped, never thrown. The store is hand-editable markdown, so one stray
 * `Bad Name.md` must not hide the hundreds of valid notes beside it.
 *
 * An unreadable *directory* still throws. It is the one failure that cannot be
 * reported per file: a partially walked tree must not be mistaken for "every file I
 * did not see is gone", which is exactly what the reindex deletion pass (F6) would
 * conclude from it.
 */
export function* walkNotes(
    root: string,
    onError: (error: NoteFileError) => void
): Generator<StoreFile> {
    yield* walkScope(root, 'global', '', path.join(root, 'global'), onError)
    const projectsRoot = path.join(root, 'projects')
    for (const project of directoryNames(projectsRoot)) {
        // A project directory name is used verbatim: it is the id `projects.json`
        // records, and the id — not the checkout path — is what identity resolves to.
        yield* walkScope(root, 'project', project, path.join(projectsRoot, project), onError)
    }
}

function* walkScope(
    root: string,
    scope: Scope,
    project: string,
    scopeRoot: string,
    onError: (error: NoteFileError) => void
): Generator<StoreFile> {
    for (const absPath of noteFilePaths(root, scopeRoot, onError)) {
        const relPath = toPosix(path.relative(root, absPath))
        let key: string
        try {
            key = normalizeKey(toPosix(path.relative(scopeRoot, absPath)))
        } catch (err) {
            onError({ path: relPath, reason: message(err) })
            continue
        }
        yield { scope, project, key, relPath, absPath }
    }
}

/**
 * Depth-first, directories before files, both sorted: the order is what makes ids
 * reproducible across a rebuild of unchanged files, which keeps index diffs and test
 * failures readable.
 *
 * An entry that is neither a regular file nor a regular directory — a symlink, a
 * fifo, a socket — is **reported**, never silently dropped: a symlinked note used to
 * look like a note that was never there, with no `skipped`/`conflicts` entry to say
 * why (§2.2 step 6 refuses to follow one).
 */
function* noteFilePaths(
    root: string,
    dir: string,
    onError: (error: NoteFileError) => void
): Generator<string> {
    const all = entries(dir)
    for (const name of all.filter(entry => entry.isDirectory()).map(entry => entry.name)) {
        yield* noteFilePaths(root, path.join(dir, name), onError)
    }
    for (const entry of all) {
        const absPath = path.join(dir, entry.name)
        if (entry.isFile()) {
            if (entry.name.endsWith('.md')) yield absPath
            continue
        }
        if (entry.isDirectory()) continue
        onError({
            path: toPosix(path.relative(root, absPath)),
            reason: 'not a regular file or directory; symlinks are not followed',
        })
    }
}

function directoryNames(dir: string): string[] {
    return entries(dir)
        .filter(entry => entry.isDirectory())
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

export interface StoreFileContent {
    access: Access
    /** Body without frontmatter (§4), so BM25 never matches `access: gated`. */
    body: string
    fmLen: number
    /** Hash of the whole file, frontmatter included (§2.3). */
    bodyHash: string
    mtime: number
}

/**
 * Reads and parses one file the walk yielded. Read failures and frontmatter errors are
 * the same event to a caller: this note cannot be indexed, and the row it may already
 * have cannot be trusted to say what the file says — `access` included (§2.1).
 *
 * Single-sourced because both passes over the store need exactly this, and a second
 * copy is how the two acquired different error policies in the first place (F11).
 */
export function readStoreFile(file: StoreFile): StoreFileContent | { error: NoteFileError } {
    try {
        const buf = fs.readFileSync(file.absPath)
        const parsed = parseNote(buf)
        return {
            access: parsed.access,
            body: parsed.body,
            fmLen: parsed.fmLen,
            bodyHash: fileHash(buf),
            mtime: Math.floor(fs.statSync(file.absPath).mtimeMs),
        }
    } catch (err) {
        return { error: { path: file.relPath, reason: message(err) } }
    }
}

export function toPosix(relPath: string): string {
    return relPath.split(path.sep).join('/')
}

/**
 * A `writeFileAtomic` temp file cannot survive a crash, and nothing used to remove the
 * leftovers: they are gitignored, so they accumulated in the store forever.
 *
 * Age is the safety margin. A live writer's temp file is seconds old, so an hour is long
 * enough that a concurrent session's in-flight write is never touched, and the function
 * only ever removes `<name>.md.tmp` under the two note trees. Unreadable directories are
 * skipped rather than fatal: this runs on the session-start path, where a stray
 * permission problem must not cost the user the store.
 */
export const STALE_TEMP_MS = 60 * 60 * 1000

export function removeStaleTemps(root: string, maxAgeMs = STALE_TEMP_MS): number {
    const now = Date.now()
    let removed = 0

    const scan = (dir: string): void => {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            const absPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                scan(absPath)
                continue
            }
            if (!entry.isFile() || !entry.name.endsWith('.md.tmp')) continue
            try {
                if (now - fs.statSync(absPath).mtimeMs <= maxAgeMs) continue
                fs.unlinkSync(absPath)
                removed++
            } catch {
                // Another process may have renamed or removed it first.
            }
        }
    }

    scan(path.join(root, 'global'))
    const projectsRoot = path.join(root, 'projects')
    for (const project of directoryNames(projectsRoot)) {
        scan(path.join(projectsRoot, project))
    }
    return removed
}
