/**
 * §6.1's injection point: the cached key index as the system prompt section
 * `memory-index`.
 *
 * The section is written into **`event.systemPromptOptions.sections`**, which the
 * host hands to every handler as one shared, mutable object per run
 * (`runner.ts:1431-1476`). Returning `{ systemPrompt }` instead would set
 * `forceSystemPrompt`, and `buildSystemPromptState` then returns `{ content }` with
 * *no* sections at all (`system-prompt.ts:203`) — discarding the sections, context
 * files and skills that every other extension contributed. So this hook returns
 * nothing and mutates in place.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/** The tag the host derives from the key: `<memory-index>…</memory-index>`. */
export const MEMORY_INDEX_SECTION = 'memory-index'

/**
 * A slice of the host's `BeforeAgentStartEvent`. The options are mutable and shared,
 * which is the only part of the shape this hook depends on.
 */
export interface BeforeAgentStartLike {
    systemPromptOptions?: {
        sections?: Record<string, string>
    }
}

/**
 * Adds (or refreshes) the section on every `before_agent_start`. Written on every
 * run rather than once, because the host normalizes a fresh options object per run:
 * a section set on the previous run's object is gone.
 *
 * An empty block adds no section at all — an empty `<memory-index>` pair is tokens
 * spent on nothing, and it would render as a section the model is told to consult.
 */
export function installIndexSection(pi: ExtensionAPI, getBlock: () => string): void {
    pi.on('before_agent_start', (event: BeforeAgentStartLike) => {
        const block = getBlock()
        if (block === '') return
        const sections = event?.systemPromptOptions?.sections
        // The host always normalizes `sections` in; the guard is for a host that
        // stops doing so, where throwing here would fail another extension's turn.
        if (sections === undefined) return
        sections[MEMORY_INDEX_SECTION] = block
    })
}
