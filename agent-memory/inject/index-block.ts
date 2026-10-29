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
    type NoteSummary,
    scopesLabel,
    scopesOverview,
} from '../tools/definitions.ts'

/** §6.1: 200 keys or 4,800 characters, whichever comes first. */
export const MAX_INDEX_KEYS = 200
export const MAX_INDEX_CHARS = 4800

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
 * §6.1's block content: scope, open keys newest-first, gated count.
 *
 * Every tier a discovery path covers is named and listed (§5.1, F3): project keys
 * first, then global ones, under one `scope:` line (`project:<id> + global`). The caps
 * apply to the combined list, so a large project cannot starve the global tier out of
 * the block — it is appended, not competing for the same first 200 slots.
 *
 * Returns `''` for an empty store — an empty section only costs tokens, and an
 * empty section is also how U8's hook knows not to add one at all.
 */
export function buildIndexBlock(source: IndexBlockSource, scope?: Scope): string {
    const overview = scopesOverview(source, scope)
    if (overview.open.length === 0 && overview.gated === 0) return ''

    const lines = [`scope: ${scopesLabel(overview.overviews)}`]
    const { text, hidden } = cappedKeys(overview.open)
    if (hidden > 0) {
        // An overflow line on its own is still information: cap, nothing else.
        lines.push(`${text === '' ? '' : `${text}, `}+${hidden} more (recent first)`)
    } else if (text !== '') {
        lines.push(text)
    }
    if (overview.gated > 0) lines.push(`gated: ${overview.gated} hidden (ask for one by name)`)
    return lines.join('\n')
}

/**
 * Keys arrive already ranked — project tier first, each tier `mtime DESC, id DESC` —
 * from `scopesOverview`, so the cap keeps the most recent notes and never lets the
 * global tier displace the project's. Gated keys are not in the list at all —
 * `scopesOverview` counts them, never names them (§5.2).
 */
function cappedKeys(summaries: readonly NoteSummary[]): { text: string; hidden: number } {
    let text = ''
    let taken = 0
    for (const summary of summaries) {
        if (taken >= MAX_INDEX_KEYS) break
        const next = text === '' ? summary.key : `${text}, ${summary.key}`
        if (next.length > MAX_INDEX_CHARS) break
        text = next
        taken++
    }
    return { text, hidden: summaries.length - taken }
}
