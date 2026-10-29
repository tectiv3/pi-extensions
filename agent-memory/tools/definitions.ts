/**
 * The six memory tools of §5, as functions over a `Store`.
 *
 * Three boundaries are deliberate:
 *
 * - **The read gate lives here, not in the store.** `Store.readNote` returns the body
 *   either way, because §5 requires the gate decision to read the *file* at operation
 *   time and the store cannot know whether its caller is an agent. `memoryRead` is
 *   therefore the only function that confirms before a gated body is handed back, and
 *   a refusal never carries the body, a preview of it, or a diff.
 * - **Nothing here throws.** A stale `baseHash`, a rejected key or a missing project
 *   scope becomes `{ isError: true, text }`: a tool result carries its message to the
 *   model, a thrown error carries a stack to nobody.
 * - **Gated work goes through the gate with a reason.** `write`/`edit`/`delete` are
 *   gated inside the store (they touch disk), so a missing reason surfaces as
 *   `ReasonRequiredError`'s message instead of an unattended prompt.
 */

import {
    type GateContext,
    type GateDenialCode,
    failClosedMessage,
    isSubagent,
    requestGatedAccess,
    resolveAttempt,
} from '../gate/gate.ts'
import type { LogOp } from '../gate/log.ts'
import {
    BM25_DEPTH,
    VECTOR_K,
    type NoteRow,
    type ScoredNote,
    type VectorHit,
    getNoteById,
    listNotes,
    searchBm25,
    searchVector,
} from '../index/notes.ts'
import { DEFAULT_LIMIT, fuse } from '../index/rrf.ts'
import { MIN_TOKEN_CHARS, toFtsQuery } from '../inject/fts-query.ts'
import { message } from '../store/errors.ts'
import type { Access } from '../store/frontmatter.ts'
import {
    ReasonRequiredError,
    type NoteSnapshot,
    resolveRowAccess,
    resolveScope,
    resolveScopes,
    scopeTargets,
} from '../store/notes.ts'
import type { Scope } from '../store/paths.ts'
import type { Store } from '../store/store.ts'

/**
 * U9's seam. Returns `null` when no embedding could be produced (embedder absent,
 * non-darwin host, non-English text); search then degrades to BM25 only (§12.10).
 */
export type Embedder = (text: string) => Promise<Float32Array | null>

export interface MemoryDeps {
    store: Store
    /** §7.3's decision point. `hasUI` false and `PI_MEMORY_SUBAGENT` set both deny. */
    gate: GateContext
    /**
     * Project identity is resolved from here, never from the store root: the store is
     * one repo in the home directory and would name every project after itself (§3.2).
     */
    cwd: string
    embed?: Embedder
}

export interface ToolResult {
    text: string
    isError?: boolean
    details?: Record<string, unknown>
}

export interface IndexInput {
    scope?: Scope
}

export interface SearchInput {
    query: string
    scope?: Scope
    limit?: number
}

export interface ReadInput {
    key: string
    scope?: Scope
    reason?: string
}

export interface WriteInput {
    key: string
    body: string
    scope?: Scope
    access?: Access
    /** Optional on create; a supplied stale hash is rejected as `memory_edit` is (§5). */
    baseHash?: string
    reason?: string
}

export interface EditInput {
    key: string
    oldText: string
    newText: string
    baseHash: string
    scope?: Scope
    reason?: string
}

export interface DeleteInput {
    key: string
    scope?: Scope
    reason?: string
}

/** A search that asks for more than this is a search that wants `memory_index`. */
const MAX_SEARCH_LIMIT = 50
/** §6.1 shows the first line of the body, not an essay, next to a key. */
const SUMMARY_CHARS = 120

// ---------------------------------------------------------------------------
// memory_index
// ---------------------------------------------------------------------------

export interface NoteSummary {
    key: string
    /** First line of the body, trimmed; empty when the body starts blank. */
    firstLine: string
}

export interface ScopeOverview {
    scope: Scope
    /** `''` for the global scope. */
    project: string
    /** Open notes only: a gated key is not reachable without a confirmation (§5.2). */
    open: NoteSummary[]
    /** Counted, never named. */
    gated: number
}

/**
 * One tier's listing: open keys, newest first, plus how many gated notes were withheld.
 *
 * `access` is re-checked against the file for every row that claims to be open, so a
 * note hand-gated mid-session drops out of the listing immediately instead of at the
 * next reindex (see `resolveRowAccess`).
 */
function overviewFor(
    deps: Pick<MemoryDeps, 'store' | 'cwd'>,
    scope: Scope,
    project: string
): ScopeOverview {
    const rows = listNotes(deps.store.db, { scope, project })
    const open: NoteSummary[] = []
    let gated = 0
    for (const row of rows) {
        if (resolveRowAccess(deps.store.root, row) === 'gated') {
            gated++
            continue
        }
        open.push({ key: row.key, firstLine: firstLine(row.body) })
    }
    return { scope, project, open, gated }
}

/**
 * Every tier a discovery path covers, in rank order (§5.1, F3): the project's notes
 * first, then the global ones, with the gated counts summed. An explicit `scope`
 * narrows this to exactly one entry, and a cwd outside a work tree yields global only.
 */
export interface ScopesOverview {
    /** Per-tier listings, primary first. */
    overviews: ScopeOverview[]
    /** Open summaries from every tier, in the same order. */
    open: NoteSummary[]
    /** Gated notes withheld across every tier. */
    gated: number
}

export function scopesOverview(
    deps: Pick<MemoryDeps, 'store' | 'cwd'>,
    scope?: Scope
): ScopesOverview {
    const overviews = resolveScopes(deps.cwd, scope).map(resolved =>
        overviewFor(deps, resolved.scope, resolved.project)
    )
    return {
        overviews,
        open: overviews.flatMap(overview => overview.open),
        gated: overviews.reduce((sum, overview) => sum + overview.gated, 0),
    }
}

/** `project:<id> + global` when both tiers were searched; one label otherwise. */
export function scopesLabel(overviews: readonly ScopeOverview[]): string {
    return overviews.map(overview => scopeLabel(overview.scope, overview.project)).join(' + ')
}

/**
 * `memory_index`'s text: one header naming every tier searched, the keys in rank order,
 * and the summed gated count. With more than one tier each row also carries its own
 * label — ordering alone would make "which tier is this key in" a guess, and the caller
 * needs the answer to name a `scope` on a later mutation.
 */
export function memoryIndex(deps: MemoryDeps, input: IndexInput = {}): ToolResult {
    let overview: ScopesOverview
    try {
        overview = scopesOverview(deps, input.scope)
    } catch (err) {
        return fail(err)
    }
    const primary = overview.overviews[0]

    const lines = [`scope: ${scopesLabel(overview.overviews)}`]
    if (overview.open.length === 0 && overview.gated === 0) {
        lines.push('(no notes)')
    }
    const multi = overview.overviews.length > 1
    for (const entry of overview.overviews) {
        for (const summary of entry.open) {
            const line =
                summary.firstLine === '' ? summary.key : `${summary.key}: ${summary.firstLine}`
            lines.push(multi ? `${line} (${scopeLabel(entry.scope, entry.project)})` : line)
        }
    }
    if (overview.gated > 0) lines.push(`gated: ${overview.gated} hidden`)

    return {
        text: lines.join('\n'),
        details: {
            scope: primary.scope,
            project: primary.project,
            scopes: overview.overviews.map(entry => ({
                scope: entry.scope,
                project: entry.project,
            })),
            keys: overview.open.map(summary => summary.key),
            gated: overview.gated,
        },
    }
}

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

export async function memorySearch(deps: MemoryDeps, input: SearchInput): Promise<ToolResult> {
    // §5.3: subagents get the injected index and open reads, nothing else.
    if (isSubagent()) {
        return {
            text: 'memory_search is not available to subagents; use the memory index, or memory_read by key',
            isError: true,
        }
    }
    const query = input.query.trim()
    if (query === '') return { text: 'memory_search requires a query', isError: true }
    // §6.2's builder is not mention-detection-only: the same text reaching `MATCH` raw
    // is a syntax error (`-rf`, `foo:bar`) and, with `unicode61` and no stemming, it
    // missed every plural of a word it did find. One builder, one query language.
    const match = toFtsQuery(query)
    if (match === null) {
        return {
            text: `memory_search could not parse the query: no word of at least ${MIN_TOKEN_CHARS} characters in "${query}"`,
            isError: true,
        }
    }

    const limit = normalizeLimit(input.limit)
    let targets: { scope: Scope; project: string }[]
    try {
        // §5.1 with the global fallback (F3): every tier is searched, project hits
        // rank first on ties, and an explicit `scope` narrows to exactly one.
        targets = scopeTargets(deps.cwd, input.scope)
    } catch (err) {
        return fail(err)
    }
    const filter = { scopes: targets }

    let bm25: ScoredNote[]
    try {
        // §4: depth 50, gated rows excluded in SQL before ranking (`searchBm25`'s
        // default access filter), so a gated row never occupies a candidate slot.
        bm25 = searchBm25(deps.store.db, match, { ...filter, limit: BM25_DEPTH })
    } catch (err) {
        // `match` is built by `toFtsQuery`, so it cannot be a syntax error: a throw here
        // is the index failing, not the user's query.
        return fail(err)
    }

    const rows = new Map<number, NoteRow>(bm25.map(row => [row.id, row]))
    const vectorRows: NoteRow[] = []
    for (const hit of await queryVector(deps, query, targets)) {
        const seen = rows.get(hit.note_id)
        if (seen !== undefined) {
            vectorRows.push(seen)
            continue
        }
        const row = getNoteById(deps.store.db, hit.note_id)
        // `searchVector` already filters to open notes; the check is the gate's last
        // line of defence, not a duplicate of it.
        if (row === null || row.access !== 'open') continue
        rows.set(row.id, row)
        vectorRows.push(row)
    }

    const fused = fuse(bm25, vectorRows, { limit }).filter(
        entry => resolveRowAccess(deps.store.root, entry.item) === 'open'
    )
    if (fused.length === 0) {
        return { text: `no memory notes matched "${query}"`, details: { query, count: 0 } }
    }
    return {
        text: fused.map((entry, index) => formatHit(entry.item, index)).join('\n'),
        details: {
            query,
            count: fused.length,
            results: fused.map(entry => ({
                key: entry.item.key,
                scope: entry.item.scope,
                project: entry.item.project,
                score: Number(entry.score.toFixed(6)),
            })),
        },
    }
}

/**
 * The vector half of §4's hybrid search. Absent or failing embedder, missing module
 * and an empty vector table all degrade to "no vector hits" rather than to an error:
 * BM25 is the documented fallback (§12.10).
 */
async function queryVector(
    deps: MemoryDeps,
    query: string,
    targets: readonly { scope: Scope; project: string }[]
): Promise<VectorHit[]> {
    if (deps.embed === undefined) return []
    let embedding: Float32Array | null
    try {
        embedding = await deps.embed(query)
    } catch {
        return []
    }
    if (embedding === null || embedding.length === 0) return []
    try {
        return searchVector(deps.store.db, embedding, { scopes: targets, limit: VECTOR_K })
    } catch {
        return []
    }
}

function formatHit(row: NoteRow, index: number): string {
    const line = firstLine(row.body)
    const where = scopeLabel(row.scope, row.project)
    const summary = line === '' ? '' : `: ${line}`
    return `${index + 1}. ${row.key} (${where})${summary}`
}

// ---------------------------------------------------------------------------
// memory_read
// ---------------------------------------------------------------------------

export async function memoryRead(deps: MemoryDeps, input: ReadInput): Promise<ToolResult> {
    let snapshot: NoteSnapshot
    try {
        snapshot = deps.store.readNote({ key: input.key, scope: input.scope })
    } catch (err) {
        return fail(err)
    }

    if (snapshot.access === 'gated') {
        // Subagent first: §5.3 wants a `blocked-subagent` line even when no reason was
        // supplied, and the gate checks the env var before the UI anyway.
        if (!isSubagent() && (input.reason ?? '').trim() === '') {
            return fail(new ReasonRequiredError(snapshot.key))
        }
        const decision = await requestGatedAccess(deps.gate, {
            root: deps.store.root,
            op: 'read',
            scope: snapshot.scope,
            project: snapshot.project,
            key: snapshot.key,
            reason: input.reason ?? '',
            // The gate truncates to ~200 chars; the body itself never enters a log.
            preview: snapshot.body,
        })
        if (decision.allowed === false) {
            // Per-code text: `denied-no-ui`/`blocked-subagent` name the way in (§7.3),
            // while a decline or a failed confirmation says what actually happened —
            // telling a user who just declined to "use /memory show" is nonsense.
            return { text: denialText(snapshot.key, decision.code), isError: true }
        }
        // §7.1: the gate writes no resolver on approval, so the caller owns it. A read
        // has already succeeded by construction — the body is in memory and returning
        // it cannot fail — so `ok` is a statement of fact here, not a prediction.
        resolveAttempt(deps.store.root, decision.attempt, 'approved', 'ok')
    }

    return {
        text: snapshot.body,
        details: {
            key: snapshot.key,
            scope: snapshot.scope,
            project: snapshot.project,
            access: snapshot.access,
            hash: snapshot.hash,
        },
    }
}

// ---------------------------------------------------------------------------
// memory_write / memory_edit / memory_delete
// ---------------------------------------------------------------------------

export async function memoryWrite(deps: MemoryDeps, input: WriteInput): Promise<ToolResult> {
    if (isSubagent()) return blockForSubagent(deps, 'write', input)
    try {
        const result = await deps.store.writeNote({
            key: input.key,
            body: input.body,
            scope: input.scope,
            access: input.access,
            baseHash: input.baseHash,
            reason: input.reason,
        })
        return writeResult(result, 'wrote', input.key)
    } catch (err) {
        return fail(err)
    }
}

export async function memoryEdit(deps: MemoryDeps, input: EditInput): Promise<ToolResult> {
    if (isSubagent()) return blockForSubagent(deps, 'edit', input)
    if ((input.baseHash ?? '').trim() === '') {
        return { text: 'memory_edit requires baseHash; re-read the note first', isError: true }
    }
    try {
        const result = await deps.store.editNote({
            key: input.key,
            oldText: input.oldText,
            newText: input.newText,
            baseHash: input.baseHash,
            scope: input.scope,
            reason: input.reason,
        })
        return writeResult(result, 'edited', input.key)
    } catch (err) {
        return fail(err)
    }
}

export async function memoryDelete(deps: MemoryDeps, input: DeleteInput): Promise<ToolResult> {
    if (isSubagent()) return blockForSubagent(deps, 'delete', input)
    try {
        const result = await deps.store.deleteNote({
            key: input.key,
            scope: input.scope,
            reason: input.reason,
        })
        if (result.ok === false) {
            if ('message' in result) {
                return {
                    text: result.message,
                    isError: true,
                    details: { key: input.key, code: result.code },
                }
            }
            return {
                text: denialText(input.key, result.code),
                isError: true,
                details: { code: result.code },
            }
        }
        return {
            text: `deleted ${result.key} (${scopeLabel(result.scope, result.project)})`,
            details: { key: result.key, scope: result.scope, project: result.project },
        }
    } catch (err) {
        return fail(err)
    }
}

function writeResult(
    result: Awaited<ReturnType<Store['writeNote']>>,
    verb: 'wrote' | 'edited',
    key: string
): ToolResult {
    if (result.ok === true) {
        const header = `${verb} ${result.key} (${scopeLabel(result.scope, result.project)}, ${result.access})`
        return {
            text: `${header}\n${result.diff === '' ? '(no change)' : result.diff}`,
            details: {
                key: result.key,
                scope: result.scope,
                project: result.project,
                access: result.access,
                diff: result.diff,
            },
        }
    }
    if ('message' in result) {
        // The diff is present only when the change landed and something after it
        // failed (commit or index). It is never produced before the gate is passed.
        const diff = result.diff === '' ? '' : `\n${result.diff}`
        return {
            text: `${result.message}${diff}`,
            isError: true,
            details: { code: result.code },
        }
    }
    return {
        text: denialText(key, result.code),
        isError: true,
        details: { code: result.code },
    }
}

/**
 * §5.3 layer 2: a subagent may not mutate anything, gated or not. Logged through the
 * gate so the attempt produces §7.1's `pending` + `blocked-subagent` pair; the gate
 * checks the env var before `hasUI`, so this can never open a dialog.
 */
async function blockForSubagent(
    deps: MemoryDeps,
    op: LogOp,
    input: { key: string; scope?: Scope; reason?: string }
): Promise<ToolResult> {
    const where = safeLocation(deps, input.scope)
    await requestGatedAccess(deps.gate, {
        root: deps.store.root,
        op,
        scope: where.scope,
        project: where.project,
        key: input.key,
        reason: input.reason ?? 'subagents have no memory write access',
        preview: '',
    })
    return {
        text: `memory_${op} of '${input.key}' blocked: subagent sessions have no memory write access`,
        isError: true,
    }
}

function safeLocation(
    deps: MemoryDeps,
    scope: Scope | undefined
): { scope?: Scope; project?: string } {
    try {
        const resolved = resolveScope(deps.cwd, scope)
        return { scope: resolved.scope, project: resolved.project }
    } catch {
        // An unresolvable scope must not stop the block from being logged.
        return {}
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** §7.1 logs a refusal; the tool text must be actionable and body-free. */
function denialText(key: string, code: GateDenialCode): string {
    switch (code) {
        case 'denied-no-ui':
        case 'blocked-subagent':
            // §7.3's exact string: there was no confirmation path at all.
            return failClosedMessage(key)
        case 'declined':
            return `gated note '${key}'; access declined`
        case 'error':
            return `gated note '${key}'; confirmation failed`
    }
}

function fail(err: unknown): ToolResult {
    return { text: message(err), isError: true }
}

export function scopeLabel(scope: Scope, project: string): string {
    return scope === 'global' ? 'global' : `project:${project}`
}

export function firstLine(body: string): string {
    const line = body.split('\n')[0].trim()
    return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS)}…` : line
}

function normalizeLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
    const value = Math.floor(limit)
    if (value <= 0) return DEFAULT_LIMIT
    return Math.min(value, MAX_SEARCH_LIMIT)
}
