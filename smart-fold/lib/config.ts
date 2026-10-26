/**
 * pi-smart-fold — in-memory config defaults.
 *
 * Settings live for the current session only: the extension starts from these
 * defaults and `/fold` mutates the object in place.
 */

export type ThinkingMode = 'smart' | 'tail' | 'full' | 'off'
export type WriteCollapsedStyle = 'header' | 'preview'

export interface SmartFoldConfig {
    /** Collapse tool output at every session start. Default: true */
    toolsFold: boolean
    /**
     * Thinking display strategy:
     * - "smart": while the model thinks, show one live line with the elapsed
     *   time and the scrolling tail of the thinking text; once the message is
     *   finished, collapse to a single `Thinking… (Xs)` line. Clicking the line
     *   twice (through pi's native hidden state) reveals the full text.
     * - "tail":  always fold thinking to a single tail line (plus duration).
     * - "full":  leave finished thinking unfolded (full markdown).
     * - "off":   no thinking transformation at all.
     * Default: "smart"
     */
    thinking: ThinkingMode
    /** Append `+N -M` line-diff stats to the write tool header. Default: true */
    writeStat: boolean
    /**
     * Collapsed write tool rows:
     * - "header": only the `write <path> +N -M` line (fully collapsed).
     * - "preview": keep pi's default content preview (10 lines).
     * Default: "header"
     */
    writeCollapsed: WriteCollapsedStyle
}

export const defaultConfig: SmartFoldConfig = {
    toolsFold: true,
    thinking: 'smart',
    writeStat: true,
    writeCollapsed: 'header',
}
