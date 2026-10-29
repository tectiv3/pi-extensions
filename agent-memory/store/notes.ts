/**
 * Note CRUD — the write path of §3.4, scope resolution of §5.1 and the tool
 * semantics of §5, composed from the existing pieces.
 *
 * Three rules shape this file:
 *
 * - **One write path.** `writeNote` is the only function that writes a note file.
 *   `editNote` computes a new body and delegates; `deleteNote` removes a file that
 *   already exists. The commit/index/enqueue sequence therefore lives exactly once
 *   (`applyWriteResult`), and an `access` flip cannot take a shortcut past it.
 * - **The file is authoritative, never the index.** `access` is re-parsed from
 *   leading bytes on every operation (§5), so a note hand-gated mid-session is
 *   treated as gated immediately rather than at the next reindex.
 * - **The gate runs before disk.** A gated operation that is declined writes one
 *   log resolver and nothing else — no temp file, no index row, no commit.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
    type GateContext,
    type GateDenialCode,
    requestGatedAccess,
    resolveAttempt,
} from '../gate/gate.ts'
import type { LogOp, LogResult } from '../gate/log.ts'
import {
    deleteNote as deleteNoteRow,
    getNoteByKey,
    type NoteInput,
    type NoteRow,
    type ScopeTarget,
    upsertNote,
} from '../index/notes.ts'
import {
    type Access,
    fileHash,
    isInFrontmatter,
    parseNote,
    renderNote,
} from './frontmatter.ts'
import { commitPath, type CommitFailureClass, withRepoLock } from './git.ts'
import { normalizeKey, resolveKeyPath } from './keys.ts'
import { type Scope, scopeDir } from './paths.ts'
import {
    mergeProject,
    readProjects,
    type ResolvedProject,
    resolveProjectId,
} from './project.ts'
import { toPosix } from './walk.ts'

const GIT_TIMEOUT_MS = 10_000
/** §3.4 step 5: three attempts, 50 ms apart. */
const INDEX_RETRY_DELAYS_MS = [50, 50, 50]
/** `<new>` in a `StaleNoteError` when the file the caller read no longer exists. */
const ABSENT_HASH = 'absent'

/** §3.4 step 5's exact failure string. */
export const INDEX_FAILED_MESSAGE = 'written and committed, but not indexed; run /memory index'
/**
 * The row outlives a failed index delete. `--rebuild` names the strongest remedy; a
 * plain `/memory index` also removes the row, since the pass deletes rows whose file
 * is gone (F6).
 */
export const DELETE_INDEX_FAILED_MESSAGE =
    'deleted and committed, but still listed in the index; run /memory index --rebuild'

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** §5.1: `scope: project` from a cwd outside any work tree. */
export class NoProjectScopeError extends Error {
    constructor() {
        super('not in a git repository; no project scope')
        this.name = 'NoProjectScopeError'
    }
}

export class NoteNotFoundError extends Error {
    readonly key: string
    readonly scope: Scope
    readonly project: string
    readonly path: string
    /** Every tier searched, in order; more than one only on a discovery path. */
    readonly tried: readonly ScopeTarget[]

    constructor(
        key: string,
        scope: Scope,
        project: string,
        relPath: string,
        alsoTried: readonly ScopeTarget[] = []
    ) {
        const tried: ScopeTarget[] = [{ scope, project }, ...alsoTried]
        const where = tried.map(target => describeScope(target)).join(', ')
        super(`memory note '${key}' not found (${where})`)
        this.name = 'NoteNotFoundError'
        this.key = key
        this.scope = scope
        this.project = project
        this.path = relPath
        this.tried = tried
    }
}

function describeScope(target: ScopeTarget): string {
    return target.scope === 'global' ? 'global' : `project ${target.project}`
}

/** §5: the `baseHash` precondition. Message is the spec's, not a paraphrase. */
export class StaleNoteError extends Error {
    readonly expected: string
    readonly actual: string

    constructor(expected: string, actual: string) {
        super(`note changed since read (${expected} → ${actual}); re-read`)
        this.name = 'StaleNoteError'
        this.expected = expected
        this.actual = actual
    }
}

export class AmbiguousEditError extends Error {
    readonly key: string
    readonly count: number

    constructor(key: string, count: number) {
        super(`oldText matches ${count} times in '${key}'; include more surrounding text`)
        this.name = 'AmbiguousEditError'
        this.key = key
        this.count = count
    }
}

export class FrontmatterEditError extends Error {
    readonly key: string

    constructor(key: string) {
        super(
            `oldText matches inside the frontmatter of '${key}'; frontmatter is not editable`
        )
        this.name = 'FrontmatterEditError'
        this.key = key
    }
}

export class EditNotFoundError extends Error {
    readonly key: string

    constructor(key: string) {
        super(`oldText not found in '${key}'`)
        this.name = 'EditNotFoundError'
        this.key = key
    }
}

/** §5: `reason` is required for a gated operation, and it is logged. */
export class ReasonRequiredError extends Error {
    readonly key: string

    constructor(key: string) {
        super(`gated note '${key}' requires a reason`)
        this.name = 'ReasonRequiredError'
        this.key = key
    }
}

// ---------------------------------------------------------------------------
// context and results
// ---------------------------------------------------------------------------

export type EmbedJob = {
    scope: Scope
    /** `''` for the global scope, matching `notes.project`. */
    project: string
    key: string
    bodyHash: string
}

/**
 * Everything the note operations need that is not a parameter of the operation.
 * `cwd` is where project identity is resolved from; it is not the store root.
 */
export interface NoteContext {
    root: string
    db: DatabaseSync
    cwd: string
    gate: GateContext
    /**
     * §3.4 step 7, fire-and-forget. Keyed by `(scope, project, key, bodyHash)` and
     * never by `notes.id`, which every rebuild reassigns (§8.2).
     */
    enqueueEmbed?: (job: EmbedJob) => void
}

export interface NoteSnapshot {
    key: string
    scope: Scope
    project: string
    access: Access
    body: string
    /** sha256 of the whole file including frontmatter (§2.3). */
    hash: string
    /** Absolute path of the note file. */
    path: string
    /** `floor(stat(path).mtimeMs)`, the recency source §4 orders by. */
    mtime: number
}

export interface WriteOk {
    ok: true
    id: number
    /** Unified diff of the file change; `git diff --no-index` exit 1 is success. */
    diff: string
    key: string
    scope: Scope
    project: string
    path: string
    /** Path relative to the store root, as git sees it. */
    relPath: string
    access: Access
    hash: string
}

export interface WriteDenied {
    ok: false
    code: GateDenialCode
}

export interface WriteFailed {
    ok: false
    code: 'index-failed' | `failed:${CommitFailureClass}`
    message: string
    /** The change on disk, present even when the index step failed after the commit. */
    diff: string
}

export type WriteResult = WriteOk | WriteDenied | WriteFailed

export interface DeleteOk {
    ok: true
    key: string
    scope: Scope
    project: string
    path: string
}

export interface DeleteDenied {
    ok: false
    code: GateDenialCode
}

export interface DeleteFailed {
    ok: false
    code: 'index-failed' | `failed:${CommitFailureClass}`
    message: string
}

export type DeleteResult = DeleteOk | DeleteDenied | DeleteFailed

export interface ReadNoteInput {
    key: string
    scope?: Scope
}

export interface WriteNoteInput {
    key: string
    /** Markdown **without** frontmatter; `renderNote` adds the block when gated. */
    body: string
    scope?: Scope
    /** Explicit wins; otherwise preserved on update and `open` on create (§5.1). */
    access?: Access
    baseHash?: string
    reason?: string
}

export interface EditNoteInput {
    key: string
    oldText: string
    newText: string
    /** Required: an edit without a precondition is a blind overwrite. */
    baseHash: string
    scope?: Scope
    reason?: string
}

export interface DeleteNoteInput {
    key: string
    scope?: Scope
    reason?: string
}

// ---------------------------------------------------------------------------
// scope resolution
// ---------------------------------------------------------------------------

export interface ResolvedScope {
    scope: Scope
    /** `''` for the global scope, matching `notes.project`. */
    project: string
    /** Present iff `scope === 'project'`; carries `projects.json` metadata (§3.2). */
    info: ResolvedProject | null
}

/**
 * §5.1 verbatim: explicit wins; omitted is project when resolvable, else global.
 *
 * This is the **primary** tier. A write, edit or delete lands here, so an omitted
 * scope can never guess its way into the other tier; discovery paths use
 * `resolveScopes` and see both.
 */
export function resolveScope(cwd: string, explicit?: Scope): ResolvedScope {
    if (explicit === 'global') return { scope: 'global', project: '', info: null }
    const info = resolveProjectId(cwd)
    if (info === null) {
        if (explicit === 'project') throw new NoProjectScopeError()
        return { scope: 'global', project: '', info: null }
    }
    return { scope: 'project', project: info.id, info }
}

/**
 * Every tier a **discovery** path must search, in rank order. §5.1's "project wins"
 * rule is a fallback rule: from inside a repository an omitted scope means "project
 * first", not "project only", otherwise the global tier is write-only (F3).
 *
 * An explicit `scope` narrows this to exactly one tier, and a cwd outside a work tree
 * resolves to global alone.
 */
export function resolveScopes(cwd: string, explicit?: Scope): ResolvedScope[] {
    const primary = resolveScope(cwd, explicit)
    if (explicit !== undefined || primary.scope === 'global') return [primary]
    return [primary, { scope: 'global', project: '', info: null }]
}

/** The filter form of `resolveScopes`, for the index's multi-tier queries. */
export function scopeTargets(cwd: string, explicit?: Scope): ScopeTarget[] {
    return resolveScopes(cwd, explicit).map(({ scope, project }) => ({ scope, project }))
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

interface NoteLocation {
    key: string
    scope: Scope
    project: string
    absPath: string
    relPath: string
}

interface NoteFile extends NoteSnapshot {
    relPath: string
    fmLen: number
    /** The bytes read, kept so an edit can diff against them without re-reading. */
    raw: Buffer
}

function locate(root: string, key: string, resolved: ResolvedScope): NoteLocation {
    const normalized = normalizeKey(key)
    // `resolveKeyPath` applies §2.2 step 6: a symlinked leaf or parent is refused
    // before anything is written through it.
    const absPath = resolveKeyPath(
        scopeDir(root, resolved.scope, resolved.project),
        normalized
    )
    return {
        key: normalized,
        scope: resolved.scope,
        project: resolved.project,
        absPath,
        relPath: toPosix(path.relative(root, absPath)),
    }
}

function readNoteFile(loc: NoteLocation): NoteFile | null {
    let raw: Buffer
    let mtimeMs: number
    try {
        raw = fs.readFileSync(loc.absPath)
        mtimeMs = fs.statSync(loc.absPath).mtimeMs
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
    }
    const parsed = parseNote(raw)
    return {
        key: loc.key,
        scope: loc.scope,
        project: loc.project,
        access: parsed.access,
        body: parsed.body,
        hash: fileHash(raw),
        path: loc.absPath,
        relPath: loc.relPath,
        mtime: Math.floor(mtimeMs),
        fmLen: parsed.fmLen,
        raw,
    }
}

/**
 * Reads a note from disk. The index is not consulted: §5's gate decision must reflect
 * the file at operation time, and a hand-edited `access:` is invisible to the index.
 *
 * With `scope` omitted the tiers are tried in order — project, then global (F3) — so a
 * global note is reachable from inside a repository. The gate is decided from the
 * file that was found: only the fallback target's `access` can govern it.
 *
 * Mutations deliberately do not fall back: a write, edit or delete must name the tier
 * it is mutating rather than land in whichever one happens to hold the key. The read
 * result carries `scope`, which is what a caller needs to name it.
 *
 * Gating is the *caller's* step — `memory_read` confirms (§5) and `/memory show` logs
 * a user line (§10) — so this function deliberately returns the body either way.
 */
export function readNote(ctx: NoteContext, input: ReadNoteInput): NoteSnapshot {
    const targets = resolveScopes(ctx.cwd, input.scope)
    const misses: NoteLocation[] = []
    for (const target of targets) {
        const loc = locate(ctx.root, input.key, target)
        const file = readNoteFile(loc)
        if (file !== null) {
            return {
                key: file.key,
                scope: file.scope,
                project: file.project,
                access: file.access,
                body: file.body,
                hash: file.hash,
                path: file.path,
                mtime: file.mtime,
            }
        }
        misses.push(loc)
    }
    const [first, ...rest] = misses
    throw new NoteNotFoundError(
        first.key,
        first.scope,
        first.project,
        first.relPath,
        rest.map(loc => ({ scope: loc.scope, project: loc.project }))
    )
}

/**
 * The index's `access` is a snapshot of the last reindex, while §2.1 makes the file
 * authoritative. A note hand-gated mid-session is therefore still `access = 'open'` in
 * `notes`, and a listing or search that trusts the row would name its key and print its
 * first line (§5.2 exposure window). Discovery paths call this before showing anything:
 * a row the file now marks gated is reported as gated, never named.
 *
 * An unreadable file keeps the row's value. That direction is fail-closed at the point
 * it matters — `memory_read` re-parses the file and refuses to return a gated body —
 * and it keeps a merely unreadable note listed rather than silently deleted.
 */
export function resolveRowAccess(root: string, row: Pick<NoteRow, 'path' | 'access'>): Access {
    if (row.access === 'gated') return 'gated'
    try {
        return parseNote(fs.readFileSync(path.join(root, row.path))).access
    } catch {
        return row.access
    }
}

// ---------------------------------------------------------------------------
// write / edit / delete
// ---------------------------------------------------------------------------

export async function writeNote(
    ctx: NoteContext,
    input: WriteNoteInput
): Promise<WriteResult> {
    return persistNote(ctx, input, 'write')
}

/**
 * Exact-text replacement (§5). Rejects a stale `baseHash`, a multi-match `oldText`
 * and any match inside the frontmatter, then hands the new body to `writeNote` so
 * there is exactly one persist/commit/index path.
 */
export async function editNote(ctx: NoteContext, input: EditNoteInput): Promise<WriteResult> {
    if (typeof input.baseHash !== 'string' || input.baseHash === '') {
        throw new Error('editNote requires baseHash')
    }
    const resolved = resolveScope(ctx.cwd, input.scope)
    const loc = locate(ctx.root, input.key, resolved)
    const file = readNoteFile(loc)
    if (file === null) {
        throw new NoteNotFoundError(loc.key, loc.scope, loc.project, loc.relPath)
    }
    // Checked here as well as in `persistNote`: failing before the gate keeps a stale
    // edit from prompting the user for a write that cannot happen.
    if (file.hash !== input.baseHash) throw new StaleNoteError(input.baseHash, file.hash)

    const body = replaceOnce(file, input.oldText, input.newText)
    return persistNote(
        ctx,
        {
            key: loc.key,
            body,
            scope: resolved.scope,
            // `access` is not passed: §5.1 preserves it, and an edit must not flip it.
            baseHash: input.baseHash,
            reason: input.reason,
        },
        'edit'
    )
}

export async function deleteNote(
    ctx: NoteContext,
    input: DeleteNoteInput
): Promise<DeleteResult> {
    const resolved = resolveScope(ctx.cwd, input.scope)
    const loc = locate(ctx.root, input.key, resolved)
    const file = readNoteFile(loc)
    if (file === null) {
        throw new NoteNotFoundError(loc.key, loc.scope, loc.project, loc.relPath)
    }
    if (resolved.info !== null) registerProject(ctx.root, resolved.info)

    let attempt: string | null = null
    if (file.access === 'gated') {
        const decision = await gate(ctx, 'delete', loc, input.reason, file.body)
        if (decision.ok === false) return decision
        attempt = decision.attempt
    }

    let outcome: LogResult = 'ok'
    try {
        fs.unlinkSync(loc.absPath)
        const applied = applyDeleteResult(ctx, loc)
        if (applied.ok === false) {
            outcome = applied.result
            return { ok: false, code: applied.code, message: applied.message }
        }
        return {
            ok: true,
            key: loc.key,
            scope: loc.scope,
            project: loc.project,
            path: loc.absPath,
        }
    } catch (err) {
        outcome = 'failed:other'
        throw err
    } finally {
        if (attempt !== null) resolveAttempt(ctx.root, attempt, 'approved', outcome)
    }
}

async function persistNote(
    ctx: NoteContext,
    input: WriteNoteInput,
    op: 'write' | 'edit'
): Promise<WriteResult> {
    // 1. resolve: key, path, scope, access.
    const resolved = resolveScope(ctx.cwd, input.scope)
    const loc = locate(ctx.root, input.key, resolved)
    const existing = readNoteFile(loc)
    // 1a. register the project on first use (§3.1, §3.4 step 1a).
    if (resolved.info !== null) registerProject(ctx.root, resolved.info)

    // §5.1: explicit wins, then the note's current access, then `open` on create.
    const access: Access = input.access ?? existing?.access ?? 'open'
    // "Touches a gated note" covers both directions: un-gating a gated note reads
    // the body it is about to release, and gating one publishes a body that was open.
    const touchesGated = access === 'gated' || existing?.access === 'gated'

    // 2. baseHash precondition, when supplied (§5). Before the gate on purpose (F8):
    // a stale precondition must not spend an approval on a write that cannot happen.
    // A rejection here writes **no** log pair — the gate never ran, so there is no
    // attempt to resolve and no consent decision is invented.
    if (input.baseHash !== undefined) {
        const actual = existing === null ? ABSENT_HASH : existing.hash
        if (input.baseHash !== actual) throw new StaleNoteError(input.baseHash, actual)
    }

    // 3. gate, before anything is created or replaced.
    let attempt: string | null = null
    if (touchesGated) {
        const decision = await gate(ctx, op, loc, input.reason, input.body)
        if (decision.ok === false) return decision
        attempt = decision.attempt
    }

    let outcome: LogResult = 'ok'
    try {
        const content = renderNote(access, input.body)
        // The diff is computed from the two buffers rather than from the worktree, so
        // a git failure here aborts before the file is touched.
        const diff = diffNote(loc.relPath, existing?.raw ?? null, Buffer.from(content, 'utf8'))

        // 4. `path.tmp` in the note's own directory → fsync → rename.
        writeFileAtomic(loc.absPath, content)

        // 5–7. commit under the lock, index, enqueue.
        const applied = applyWriteResult(ctx, loc, op)
        if (applied.ok === false) {
            outcome = applied.result
            return { ok: false, code: applied.code, message: applied.message, diff }
        }
        const buf = fs.readFileSync(loc.absPath)
        return {
            ok: true,
            id: applied.id,
            diff,
            key: loc.key,
            scope: loc.scope,
            project: loc.project,
            path: loc.absPath,
            relPath: loc.relPath,
            // The parsed value, not the requested one (F9): a body that opens its own
            // frontmatter block becomes the file's frontmatter, and the tool result
            // must describe the note that is on disk.
            access: applied.access,
            hash: fileHash(buf),
        }
    } catch (err) {
        outcome = 'failed:other'
        throw err
    } finally {
        // §3.4 step 6: the resolver runs even when the mutation failed after approval.
        if (attempt !== null) resolveAttempt(ctx.root, attempt, 'approved', outcome)
    }
}

type GateOutcome = { ok: true; attempt: string } | WriteDenied

async function gate(
    ctx: NoteContext,
    op: LogOp,
    loc: NoteLocation,
    reason: string | undefined,
    body: string
): Promise<GateOutcome> {
    if (reason === undefined || reason.trim() === '') throw new ReasonRequiredError(loc.key)
    const decision = await requestGatedAccess(ctx.gate, {
        root: ctx.root,
        op,
        scope: loc.scope,
        project: loc.project,
        key: loc.key,
        reason,
        preview: body,
    })
    if (decision.allowed === false) return { ok: false, code: decision.code }
    return { ok: true, attempt: decision.attempt }
}

// ---------------------------------------------------------------------------
// persist steps 5–7, shared by write, edit and delete
// ---------------------------------------------------------------------------

interface Applied {
    ok: true
    id: number
    /** `access` as the written file parses, which is what §2.1 makes authoritative. */
    access: Access
}

interface ApplyFailed {
    ok: false
    code: 'index-failed' | `failed:${CommitFailureClass}`
    message: string
    /** The `result` the gate resolver must record (§7.1). */
    result: LogResult
}

function applyWriteResult(
    ctx: NoteContext,
    loc: NoteLocation,
    op: 'write' | 'edit'
): Applied | ApplyFailed {
    const commit = withRepoLock(ctx.root, () =>
        commitPath(ctx.root, loc.relPath, `memory: ${op} ${loc.key}`)
    )
    if (commit.status === 'failed') {
        const cls = commit.class ?? 'other'
        return {
            ok: false,
            code: `failed:${cls}`,
            message: describeCommitFailure(cls, commit.stderr),
            result: `failed:${cls}`,
        }
    }

    // Step 5 indexes what is on disk, not what we intended to write: `fm_len` and
    // `body_hash` must describe the bytes a reindex would read.
    let row: NoteInput
    let access: Access
    try {
        const raw = fs.readFileSync(loc.absPath)
        const parsed = parseNote(raw)
        access = parsed.access
        row = {
            scope: loc.scope,
            project: loc.project,
            key: loc.key,
            path: loc.relPath,
            body: parsed.body,
            fmLen: parsed.fmLen,
            bodyHash: fileHash(raw),
            access: parsed.access,
            mtime: Math.floor(fs.statSync(loc.absPath).mtimeMs),
        }
    } catch {
        return {
            ok: false,
            code: 'index-failed',
            message: INDEX_FAILED_MESSAGE,
            result: 'failed:other',
        }
    }

    let id: number
    try {
        id = upsertWithRetry(ctx.db, row)
    } catch {
        return {
            ok: false,
            code: 'index-failed',
            message: INDEX_FAILED_MESSAGE,
            result: 'failed:other',
        }
    }

    // Step 7 is fire-and-forget: a throwing queue must not turn a landed write into
    // a reported failure.
    try {
        ctx.enqueueEmbed?.({
            scope: row.scope,
            project: row.project ?? '',
            key: row.key,
            bodyHash: row.bodyHash,
        })
    } catch {}
    return { ok: true, id, access }
}

function applyDeleteResult(ctx: NoteContext, loc: NoteLocation): { ok: true } | ApplyFailed {
    const commit = withRepoLock(ctx.root, () =>
        commitPath(ctx.root, loc.relPath, `memory: delete ${loc.key}`)
    )
    if (commit.status === 'failed') {
        const cls = commit.class ?? 'other'
        return {
            ok: false,
            code: `failed:${cls}`,
            // The file is already gone, so a bare "commit failed" reads as "the
            // delete did not happen". It did; §3.3's sweep commits it (§3.4 step 6).
            message: `${describeCommitFailure(cls, commit.stderr)}; the note file is already removed, so the next startup sweep commits the deletion`,
            result: `failed:${cls}`,
        }
    }
    try {
        const row = getNoteByKey(ctx.db, loc.scope, loc.project, loc.key)
        if (row !== null) deleteNoteRow(ctx.db, row.id)
    } catch {
        return {
            ok: false,
            code: 'index-failed',
            message: DELETE_INDEX_FAILED_MESSAGE,
            result: 'failed:other',
        }
    }
    return { ok: true }
}

function describeCommitFailure(cls: CommitFailureClass, stderr: string | undefined): string {
    const detail = stderr === undefined ? '' : stderr.trim()
    return detail === '' ? `commit failed (${cls})` : `commit failed (${cls}): ${detail}`
}

function upsertWithRetry(db: DatabaseSync, row: NoteInput): number {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= INDEX_RETRY_DELAYS_MS.length; attempt++) {
        try {
            return upsertNote(db, row)
        } catch (err) {
            lastError = err
            if (attempt < INDEX_RETRY_DELAYS_MS.length)
                sleepSync(INDEX_RETRY_DELAYS_MS[attempt])
        }
    }
    throw lastError
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function registerProject(root: string, info: ResolvedProject): void {
    // Read-before-lock is only a fast path; `mergeProject` re-reads under the lock.
    if (readProjects(root)[info.id] !== undefined) return
    mergeProject(root, { id: info.id, name: info.name, path: info.root, remote: info.remote })
}

// ---------------------------------------------------------------------------
// edit matching
// ---------------------------------------------------------------------------

/**
 * Replaces the single body occurrence of `oldText`.
 *
 * Matching happens in latin-1 space so string indices are byte offsets: `fm_len` is a
 * byte offset, and a multi-byte character before the match would otherwise shift it.
 * The round-trip is exact because latin-1 decoding is a 1:1 byte↔char map.
 *
 * A match is counted by scanning the **whole file**, frontmatter included: that is
 * what lets a match inside the frontmatter be rejected rather than ignored.
 */
function replaceOnce(file: NoteFile, oldText: string, newText: string): string {
    if (oldText === '') throw new Error('editNote: oldText must not be empty')
    const haystack = file.raw.toString('latin1')
    const needle = Buffer.from(oldText, 'utf8').toString('latin1')
    const offsets = matchOffsets(haystack, needle)

    if (offsets.length === 0) throw new EditNotFoundError(file.key)
    if (offsets.length > 1) throw new AmbiguousEditError(file.key, offsets.length)
    if (isInFrontmatter(file.fmLen, offsets[0])) throw new FrontmatterEditError(file.key)

    const replacement = Buffer.from(newText, 'utf8').toString('latin1')
    const at = offsets[0]
    const next = haystack.slice(0, at) + replacement + haystack.slice(at + needle.length)
    // The frontmatter is untouched, so `fmLen` still marks the body boundary.
    return Buffer.from(next.slice(file.fmLen), 'latin1').toString('utf8')
}

/** Overlapping occurrences count: `aa` matches twice in `aaa`. */
function matchOffsets(haystack: string, needle: string): number[] {
    const offsets: number[] = []
    let from = 0
    for (;;) {
        const at = haystack.indexOf(needle, from)
        if (at === -1) return offsets
        offsets.push(at)
        from = at + 1
    }
}

// ---------------------------------------------------------------------------
// file plumbing
// ---------------------------------------------------------------------------

function writeFileAtomic(absPath: string, content: string): void {
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    // §3.4 step 3: the temp file lives beside the note, and the unanchored `*.tmp`
    // ignore rule is what keeps a crashed temp out of `git status` (§3.1).
    const tmp = `${absPath}.tmp`
    const fd = fs.openSync(tmp, 'w')
    try {
        fs.writeFileSync(fd, content)
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
    fs.renameSync(tmp, absPath)
}

/**
 * §5: the diff comes from `git diff --no-index`, which **exits 1 when the files
 * differ** — that is success; only higher codes are failures.
 *
 * The temp tree has directories literally named `a` and `b`, so with `--no-prefix`
 * git prints the real note path (`a/global/x.md` / `b/global/x.md`) instead of a
 * temp path, and no header rewriting is needed.
 */
function diffNote(relPath: string, before: Buffer | null, after: Buffer | null): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-diff-'))
    try {
        writeMaybe(path.join(tmp, 'a', relPath), before)
        writeMaybe(path.join(tmp, 'b', relPath), after)
        const result = spawnSync(
            'git',
            [
                'diff',
                '--no-index',
                '--no-prefix',
                '--no-ext-diff',
                '--no-color',
                '--',
                `a/${relPath}`,
                `b/${relPath}`,
            ],
            {
                cwd: tmp,
                encoding: 'utf8',
                timeout: GIT_TIMEOUT_MS,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            }
        )
        if (result.status === 0) return ''
        if (result.status === 1) return result.stdout ?? ''
        const detail = (result.stderr ?? '').trim()
        throw new Error(
            `git diff --no-index failed: ${detail === '' ? `exit ${result.status}` : detail}`
        )
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
    }
}

/** An absent side is an empty file: git then reports a creation/deletion hunk. */
function writeMaybe(target: string, content: Buffer | null): void {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content ?? Buffer.alloc(0))
}
