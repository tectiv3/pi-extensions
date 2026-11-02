/**
 * §6.1's key index: the block **content** that the system prompt section
 * `memory-index` carries, and the process-level cache of it.
 *
 * The content holds no tags: the host's section API wraps it as
 * `<memory-index>\n…\n</memory-index>` and cannot render attributes, so the scope
 * goes in the body.
 *
 * The block is computed **once per session** and cached. Re-reading the store per
 * turn would change the system prompt every turn and invalidate the provider's
 * prompt cache from the first section onward (§6.1). It is still re-inserted on
 * every `before_agent_start` because the host hands that hook a freshly normalized
 * options object each run (`runner.ts:1431`), not because the string changes.
 */

import type { Scope } from '../store/paths.ts'
import {
    type MemoryDeps,
    type ScopeOverview,
    scopesLabel,
    scopesOverview,
} from '../tools/definitions.ts'

/** §6.1: 200 keys or 4,800 characters, whichever comes first. */
export const MAX_INDEX_KEYS = 200
export const MAX_INDEX_CHARS = 4800

/**
 * The tail of both caps (~10%) is the global tier's reservation. Without it a project
 * with `MAX_INDEX_KEYS` open notes fills the block on its own and the tier appended
 * after it is erased — the list is `project… global…`, so only the cap can prevent it.
 */
export const GLOBAL_TIER_RESERVED_KEYS = 20
export const GLOBAL_TIER_RESERVED_CHARS = 480

/**
 * The scan reads a scope-resolved listing, so it needs the caller's cwd: project
 * identity is resolved there, never from the store root (§3.2).
 */
export type IndexBlockSource = Pick<MemoryDeps, 'store' | 'cwd'>

let cachedBlock = ''

/**
 * Compute the block and hold it. Replaces any previous value, including with `''`
 * — an empty store must clear a stale session's block rather than keep it.
 */
export function cacheIndexBlock(source: IndexBlockSource, scope?: Scope): string {
    cachedBlock = buildIndexBlock(source, scope)
    return cachedBlock
}

/** The current session's block, `''` before `session_start` and after shutdown. */
export function getCachedIndexBlock(): string {
    return cachedBlock
}

/** `/memory index` (§6.1) refreshes through `cacheIndexBlock`; this is the reset. */
export function clearIndexBlockCache(): void {
    cachedBlock = ''
}

/**
 * §6.1's block content: scope, open keys newest-first per tier, gated keys by name.
 *
 * Every tier a discovery path covers is named and listed (§5.1, F3): project keys
 * first, then global ones, under one `scope:` line (`project:<id> + global`). Ordering
 * is per tier, and so is the cap: each tier but the last may use only the budget minus
 * the global reservation, so a large project cannot starve the tier appended after it.
 * The reservation is withheld when that appended tier has nothing to render, so an
 * empty global tier never taxes the project for room it does not use.
 *
 * Gated notes contribute their **keys only** — never a first line, never a body (§5.2).
 * A name is what `memory_read` needs; naming it is not consent to read it.
 *
 * Returns `''` for an empty store — an empty section only costs tokens, and an
 * empty section is also how U8's hook knows not to add one at all.
 */
export function buildIndexBlock(source: IndexBlockSource, scope?: Scope): string {
    const overview = scopesOverview(source, scope)
    if (overview.open.length === 0 && overview.gated === 0) return ''

    const multi = overview.overviews.length > 1
    const budget: KeyBudget = { keys: 0, chars: 0 }
    const keyParts: string[] = []
    const gatedParts: string[] = []
    const lastTier = overview.overviews.length - 1
    const reserved = trailingReservation(overview.overviews)
    for (const [tier, entry] of overview.overviews.entries()) {
        const ceiling = tierCeiling(tier, lastTier, reserved)
        // The overflow marker sits at the cut, so it is never ambiguous which tier it
        // belongs to even before its label is read.
        const keys: string[] = []
        const hidden = takeKeys(
            entry.open.map(summary => summary.key),
            budget,
            keys,
            ceiling
        )
        keyParts.push(...keys)
        if (hidden > 0) keyParts.push(overflow(hidden, 'recent first', entry, multi))

        const gated: string[] = []
        const gatedHidden = takeKeys(entry.gatedKeys, budget, gated, ceiling)
        gatedParts.push(...gated)
        if (gatedHidden > 0) gatedParts.push(overflow(gatedHidden, '', entry, multi))
    }

    const lines = [`scope: ${scopesLabel(overview.overviews)}`]
    if (keyParts.length > 0) lines.push(keyParts.join(', '))
    if (gatedParts.length > 0) {
        lines.push(`gated: ${gatedParts.join(', ')} — ${GATED_HINT}`)
    }
    return lines.join('\n')
}

/**
 * What the gated line says: the names are there to be asked for, and the `reason` is
 * the audit trail rather than a precondition. Exported so the wording has one home.
 */
export const GATED_HINT = 'names only; memory_read asks the user by key and logs `reason`'

/**
 * The rendered-text budget, shared by open keys and gated names across every tier.
 * `chars` counts separators too, so it matches the joined text length.
 */
interface KeyBudget {
    keys: number
    chars: number
}

/**
 * What the preceding tiers must leave for the trailing one. Only a trailing tier that
 * will actually render something (open or gated) gets the reservation: charging it for
 * an empty tier shrinks the block and hides keys nothing else needed. A single tier is
 * always the trailing one, so it never reserves against itself.
 */
function trailingReservation(overviews: readonly ScopeOverview[]): {
    keys: number
    chars: number
} {
    const trailing = overviews[overviews.length - 1]
    const renders =
        trailing !== undefined && trailing.open.length + trailing.gatedKeys.length > 0
    return overviews.length > 1 && renders
        ? { keys: GLOBAL_TIER_RESERVED_KEYS, chars: GLOBAL_TIER_RESERVED_CHARS }
        : { keys: 0, chars: 0 }
}

/** Ceilings are cumulative: `budget` already holds every earlier tier's text. */
function tierCeiling(
    tier: number,
    lastTier: number,
    reserved: { keys: number; chars: number }
): { keys: number; chars: number } {
    return tier < lastTier
        ? { keys: MAX_INDEX_KEYS - reserved.keys, chars: MAX_INDEX_CHARS - reserved.chars }
        : { keys: MAX_INDEX_KEYS, chars: MAX_INDEX_CHARS }
}

/**
 * Take as many keys as the ceilings leave room for, appending to `taken`, and report how
 * many were left out. A key is never split: the separator is charged before it, so the
 * budget can only stop between keys. The overflow marker is not charged, because its
 * length depends on the count it reports.
 */
function takeKeys(
    keys: readonly string[],
    budget: KeyBudget,
    taken: string[],
    ceiling: { keys: number; chars: number }
): number {
    const before = taken.length
    for (const key of keys) {
        if (budget.keys >= ceiling.keys) break
        const next = budget.chars + (budget.keys === 0 ? 0 : 2) + key.length
        if (next > ceiling.chars) break
        budget.keys++
        budget.chars = next
        taken.push(key)
    }
    return keys.length - (taken.length - before)
}

/**
 * `+N more (recent first, project)` names the tier as soon as more than one is listed:
 * a bare count would leave the reader guessing which tier lost the keys.
 */
function overflow(
    hidden: number,
    reason: string,
    entry: ScopeOverview,
    multi: boolean
): string {
    const details = multi ? [reason, entry.scope] : [reason]
    const suffix = details.filter(part => part !== '').join(', ')
    return `+${hidden} more${suffix === '' ? '' : ` (${suffix})`}`
}
