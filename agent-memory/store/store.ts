/**
 * `openStore` — the single object the extension entry point holds (U4's boundary).
 *
 * It owns the store root, the index handle and the path arithmetic, and re-exports the
 * note operations bound to that root. Nothing above this layer opens a database or
 * computes a note path, so a test can drive the whole write path through one object.
 *
 * The default gate context has no UI and therefore denies every gated operation
 * (§7.3): forgetting to pass a context fails closed instead of silently writing gated
 * content.
 */

import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import type { GateContext } from '../gate/gate.ts'
import { openIndexLocked } from '../index/db.ts'
import { initStore, sweepUncommitted } from './git.ts'
import { normalizeKey } from './keys.ts'
import {
    deleteNote,
    editNote,
    type DeleteNoteInput,
    type DeleteResult,
    type EditNoteInput,
    type EmbedJob,
    type NoteContext,
    type NoteSnapshot,
    type ReadNoteInput,
    readNote,
    type WriteNoteInput,
    type WriteResult,
    writeNote,
} from './notes.ts'
import {
    accessLogPath,
    indexPath,
    projectsJsonPath,
    type Scope,
    scopeDir,
    storeRoot,
} from './paths.ts'
import { type ReindexResult, reindexFromDisk } from './reindex.ts'
import { removeStaleTemps } from './walk.ts'

export interface StorePaths {
    root: string
    /** `index.db`, gitignored and rebuildable (§3.1). */
    indexDb: string
    accessLog: string
    projectsJson: string
    /** Directory holding one scope's notes. */
    scopeDir(scope: Scope, project?: string): string
    /**
     * Path arithmetic only — `resolveKeyPath` is the checked form that refuses
     * symlinks (§2.2 step 6).
     */
    noteFile(scope: Scope, project: string, key: string): string
}

export interface Store {
    root: string
    db: DatabaseSync
    paths: StorePaths
    readNote(input: ReadNoteInput): NoteSnapshot
    writeNote(input: WriteNoteInput): Promise<WriteResult>
    editNote(input: EditNoteInput): Promise<WriteResult>
    deleteNote(input: DeleteNoteInput): Promise<DeleteResult>
    /** §4's per-file pass; authoritative for `access`, skips unchanged files. */
    reindex(): ReindexResult
    /** §3.3 startup sweep — commits leftover note changes as one recovery commit. */
    sweep(): { committed: string[] }
    close(): void
}

export interface OpenStoreOptions {
    /**
     * pi's extension context slice (§7). Absent means "no UI", so every gated
     * operation is denied and logged.
     */
    gate?: GateContext
    /** §3.4 step 7, fire-and-forget embedding queue. */
    enqueueEmbed?: (job: EmbedJob) => void
}

const FAIL_CLOSED_GATE: GateContext = {
    hasUI: false,
    ui: {
        async confirm() {
            return false
        },
    },
}

/**
 * Creates the store repo on first use (§3.1), opens the index and returns the bound
 * operations. Synchronous: everything before the first gated operation is file and
 * git plumbing, and the tools await the operations themselves.
 */
export function openStore(cwd: string, options: OpenStoreOptions = {}): Store {
    const root = storeRoot()
    // Identity is resolved from the caller's cwd, never from the store root: the store
    // is a single repo in the home directory and would name every project after itself.
    const resolvedCwd = path.resolve(cwd)

    initStore(root)
    // A crashed `writeFileAtomic` leaves `<note>.md.tmp` behind; it is gitignored, so
    // nothing else would ever remove it.
    removeStaleTemps(root)
    // §11: the probe result only exists after the load attempt, and a host that cannot
    // load `sqlite-vec` must not keep a database whose `vec_notes` can no longer be
    // dropped — so the open that every session takes also owns the downgrade, and
    // holds `index.db.lock` across both (F10).
    const db = openIndexLocked(root)
    const ctx: NoteContext = {
        root,
        db,
        cwd: resolvedCwd,
        gate: options.gate ?? FAIL_CLOSED_GATE,
        enqueueEmbed: options.enqueueEmbed,
    }

    return {
        root,
        db,
        paths: storePaths(root),
        readNote: input => readNote(ctx, input),
        writeNote: input => writeNote(ctx, input),
        editNote: input => editNote(ctx, input),
        deleteNote: input => deleteNote(ctx, input),
        reindex: () => reindexFromDisk(root, db),
        sweep: () => sweepUncommitted(root),
        close: () => {
            try {
                db.close()
            } catch {
                // A double close is not a failure worth surfacing to a shutdown path.
            }
        },
    }
}

function storePaths(root: string): StorePaths {
    return {
        root,
        indexDb: indexPath(root),
        accessLog: accessLogPath(root),
        projectsJson: projectsJsonPath(root),
        scopeDir: (scope, project = '') => scopeDir(root, scope, project),
        noteFile: (scope, project, key) =>
            path.join(scopeDir(root, scope, project), `${normalizeKey(key)}.md`),
    }
}
