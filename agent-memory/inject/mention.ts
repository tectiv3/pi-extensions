/**
 * §6.2's mention detection: turn the latest user message into a BM25 query and, when
 * the top hit clears the threshold, append `possibly relevant memories: <keys>` to
 * that message.
 *
 * Three host facts this file is built around:
 *
 * - The `context` hook receives a **clone** of the transcript (`runner.ts:1307`
 *   `structuredClone`s) and persistence happens on `message_end`, so rewriting a
 *   message here affects the outgoing request only. Nothing is written to the session.
 * - Handlers may edit `event.messages` in place; the host detects an edit by
 *   *element identity* (`sameMessages`, `runner.ts:280`). Mutating a message object
 *   in place keeps the identity, so the host reuses its own list unchanged — which
 *   is what keeps Pi's system-message layout (and therefore the cached prefix of
 *   every earlier turn) exactly as it was.
 * - Gated rows must be excluded **in SQL, before ranking** (§6.2, §5.2):
 *   `searchBm25` defaults to `access = 'open'`, so a gated note never occupies the
 *   top slot and its key can never be suggested.
 *
 * The threshold is a per-store tuning constant (§6.2): FTS5 IDF shifts with corpus
 * size, so every decision logs `top1`, `m10` and `n` and `F` can be retuned from the
 * log instead of from intuition.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { appendLog } from '../gate/log.ts'
import { getMeta } from '../index/db.ts'
import { type ScoredNote, searchBm25 } from '../index/notes.ts'
import type { Scope } from '../store/paths.ts'
import { resolveScope, scopeTargets } from '../store/notes.ts'
import type { Store } from '../store/store.ts'
import type { Embedder } from '../tools/definitions.ts'
import { toFtsQuery } from './fts-query.ts'

/** Candidates examined per turn. Deeper than §4's tool search would be waste: 10 is the window `m10` needs. */
export const MENTION_DEPTH = 10
/** §6.2's starting `F`, used when `meta.mention_floor` is absent or unusable. */
export const DEFAULT_MENTION_FLOOR = 2.5
/** §6.2: at most three keys per turn. */
export const MAX_MENTION_KEYS = 3
/**
 * §6.2: below this the query carries no signal. `bm25()` collapses to `-1e-6` when a
 * term appears in at least half the corpus (measured: 15 of 30 → 1e-6, 1 of 30 →
 * 2.98), so this is the IDF-clamp signature, not a "weak match" threshold.
 */
export const IDF_CLAMP = 1e-3
/** §6.2's relative guard: the best hit must beat the typical hit by this factor. */
export const RELATIVE_MARGIN = 1.5
/** …and the guard only applies once there are enough hits for a median to mean anything. */
export const MIN_N_FOR_RELATIVE = 4
/** §6.2's appended prefix, verbatim. */
export const MENTION_PREFIX = 'possibly relevant memories: '

/**
 * Why a decision came out the way it did. `injected` says what happened; `reason`
 * says which rule decided it.
 */
export type MentionReason =
    | 'injected'
    | 'no-query'
    | 'no-match'
    | 'idf-clamp'
    | 'below-floor'
    | 'relative-margin'
    | 'error'

export interface MentionResult {
    /** At most `MAX_MENTION_KEYS` open keys, best first. Empty when not injecting. */
    keys: string[]
    /** `|score|` of the best hit; `0` when there is none. */
    top1: number
    /** Median `|score|` of the top 10 (`top1` itself when `n < 2`). */
    m10: number
    /** Candidate count in the window. */
    n: number
    injected: boolean
    reason: MentionReason
}

export interface MentionOptions {
    /**
     * Scope resolution follows §5.1 from here; the store root would name the store's
     * own repo instead of the caller's project (§3.2).
     */
    cwd?: string
    /**
     * Overrides `meta.mention_floor`. Present for tests and for a store that wants a
     * different constant per machine; the durable home of the value is the meta row.
     */
    floor?: number
    /**
     * U9's seam. §6.2's rule is BM25-only, so this is carried for the vector half of
     * detection when it lands and deliberately unused today.
     */
    embed?: Embedder
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

export function detectMentions(
    store: Store,
    userText: string,
    options: MentionOptions = {}
): MentionResult {
    const where: { scope?: Scope; project?: string } = {}
    const result = detect(store, userText, options, where)
    logDecision(store, where, result)
    return result
}

/**
 * The rule itself. Everything that can fail fails to "inject nothing" with a reason:
 * a bad `MATCH`, a missing scope or a locked index must not break the caller's turn,
 * and a turn without suggestions is a normal turn.
 *
 * `where` is filled in as a side effect with the **primary** tier, so the log line still
 * carries the scope the decision was resolved in when the search itself failed. Both
 * tiers are searched (§5.1, F3); the primary one is what `projects.json` and the log
 * call the session's scope.
 */
function detect(
    store: Store,
    userText: string,
    options: MentionOptions,
    where: { scope?: Scope; project?: string }
): MentionResult {
    const query = toFtsQuery(userText)
    if (query === null) return skipped('no-query')

    let hits: ScoredNote[]
    try {
        const targets = scopeTargets(options.cwd ?? process.cwd())
        // The primary tier names the decision in the log; both tiers are searched
        // (§5.1, F3), so a cross-cutting global note can still be suggested.
        where.scope = targets[0]?.scope
        where.project = targets[0]?.project
        hits = searchBm25(store.db, query, {
            scopes: targets,
            limit: MENTION_DEPTH,
        })
    } catch {
        return skipped('error')
    }

    const scores = hits.map(hit => Math.abs(hit.score))
    const top1 = scores[0] ?? 0
    const m10 = median(scores.slice(0, MENTION_DEPTH))
    const n = hits.length

    if (n === 0) return { ...skipped('no-match'), top1, m10, n }
    if (top1 < IDF_CLAMP) return { ...skipped('idf-clamp'), top1, m10, n }
    if (top1 < floorFor(store, options.floor))
        return { ...skipped('below-floor'), top1, m10, n }
    // §6.2: the relative guard applies only once `n ≥ 4`; below that the floor alone
    // decides, which is deliberate — with `n < 4` a flat score distribution is what a
    // small store looks like, not a weak match.
    if (n >= MIN_N_FOR_RELATIVE && top1 < RELATIVE_MARGIN * m10) {
        return { ...skipped('relative-margin'), top1, m10, n }
    }

    return {
        keys: hits.slice(0, MAX_MENTION_KEYS).map(hit => hit.key),
        top1,
        m10,
        n,
        injected: true,
        reason: 'injected',
    }
}

function skipped(reason: MentionReason): MentionResult {
    return { keys: [], top1: 0, m10: 0, n: 0, injected: false, reason }
}

/** `F`: the per-store tuning constant (§6.2), defaulting to 2.5. */
function floorFor(store: Store, override?: number): number {
    if (override !== undefined && Number.isFinite(override) && override > 0) return override
    const raw = getMeta(store.db, 'mention_floor')
    const parsed = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MENTION_FLOOR
}

/** Median, not mean: one strong hit must not drag the typical score up with it. */
function median(values: readonly number[]): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * §6.2's rule is telemetry, not consent: it writes **one** terminal line per decision
 * with `op: 'mention'` and `decision: 'inject' | 'skip'`. There is no `pending` line and
 * no attempt id, because nothing is waiting on a user — `approved`/`declined` would
 * report a consent decision that never happened (§7.1).
 */
function logDecision(
    store: Store,
    where: { scope?: Scope; project?: string },
    result: MentionResult
): void {
    const entry = {
        op: 'mention' as const,
        initiator: 'agent' as const,
        decision: result.injected ? ('inject' as const) : ('skip' as const),
        scope: where.scope,
        project: where.project,
        top1: round(result.top1),
        m10: round(result.m10),
        n: result.n,
        reason: result.reason,
        ...(result.injected ? { keys: result.keys } : {}),
    }
    try {
        appendLog(store.root, entry)
    } catch {
        // A read-only or full disk must not cost the user their turn; the injection
        // itself is unaffected by a missing log line.
    }
}

/** Four decimals is the precision `F` is tuned at; more is log noise. */
function round(value: number): number {
    return Math.round(value * 1e4) / 1e4
}

// ---------------------------------------------------------------------------
// the context hook
// ---------------------------------------------------------------------------

/** The `context` event's shape (`types.ts:885`); only `messages` is used. */
export interface ContextEventLike {
    messages?: ContextMessageLike[]
}

export interface ContextMessageLike {
    role?: string
    content?: string | ContentBlockLike[]
}

export interface ContentBlockLike {
    type?: string
    text?: string
}

/**
 * `store` may be a getter: the host has one extension instance per process and
 * `session_start` fires again for every new/resumed session, so the hook is installed
 * **once** and the store is looked up per event. Registering a handler per session
 * would stack handlers and inject the block twice.
 */
export type StoreSource = Store | (() => Store | undefined)

export function installMentionHook(
    pi: ExtensionAPI,
    store: StoreSource,
    options: MentionOptions = {}
): void {
    const storeOf = typeof store === 'function' ? store : (): Store | undefined => store
    // One decision per distinct user message: the `context` hook runs before *every*
    // LLM request, so a 15-request turn would otherwise repeat the same detection and
    // the same log pair 15 times, drowning the numbers §6.2 wants to tune `F` with.
    let lastKey: string | undefined
    let lastResult: MentionResult | undefined

    pi.on('context', (event: ContextEventLike, ctx: { cwd?: string }) => {
        const messages = event?.messages
        if (!Array.isArray(messages)) return
        const index = lastUserMessage(messages)
        if (index < 0) return
        const message = messages[index]
        const text = textOf(message.content)
        if (text.trim() === '') return

        const active = storeOf()
        if (active === undefined) return

        const cwd = options.cwd ?? ctx?.cwd
        // The scope is part of the key, not just the text: `session_start` fires again
        // for a new session, and the same first message ("continue") from a different
        // project must not reuse the previous project's keys (F12).
        const key = cacheKey(cwd, text)
        let result: MentionResult
        if (key === lastKey && lastResult !== undefined) {
            result = lastResult
        } else {
            result = detectMentions(active, text, { ...options, cwd })
            lastKey = key
            lastResult = result
        }
        if (!result.injected || result.keys.length === 0) return

        appendMention(message, result.keys)
        // Returning nothing is deliberate: the message object was mutated in place, so
        // the host sees its own array unchanged and keeps the existing system messages.
    })
}

/**
 * The memoisation key: the message text **and** the tier it was resolved in, because
 * `session_start` fires again for a new session and the same first message ("continue")
 * from a different project must not reuse the previous project's keys (F12).
 *
 * NUL-joined: neither part can contain NUL, so text and scope cannot collide.
 */
function cacheKey(cwd: string | undefined, text: string): string {
    const resolved = resolveScope(cwd ?? process.cwd())
    return `${resolved.scope}\u0000${resolved.project}\u0000${text}`
}

/** The latest user turn, or `-1`. Tool results and assistant turns are never touched. */
function lastUserMessage(messages: readonly ContextMessageLike[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === 'user') return index
    }
    return -1
}

/** The detachable text of a message: a string, or the text blocks of a content array. */
function textOf(content: ContextMessageLike['content']): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
        .filter(block => typeof block?.text === 'string')
        .map(block => block.text ?? '')
        .join('\n')
}

/**
 * Append to the user message's own content: a string gains the line, a block array
 * gains one text block. Images and other blocks are left alone, and no other message
 * in the array is touched.
 */
function appendMention(message: ContextMessageLike, keys: readonly string[]): void {
    const line = `${MENTION_PREFIX}${keys.join(', ')}`
    if (typeof message.content === 'string') {
        message.content = `${message.content}\n\n${line}`
        return
    }
    if (Array.isArray(message.content)) {
        message.content = [...message.content, { type: 'text', text: `\n\n${line}` }]
    }
}
