/**
 * Completion notice for background runs, in the format external trackers read.
 *
 * A tracker (Paseo's `pi-subagents` adapter) keeps a background run "working"
 * until it can derive a terminal status. Its only durable source is a
 * `subagent-notify` custom message in the parent transcript whose first line
 * carries the outcome and whose body names the async token the spawn tool call
 * reported as `details.asyncDir`. Both halves therefore live here: a wording or
 * token drift silently strands the run as running in those trackers, with no
 * error anywhere.
 *
 * The message is `display: false` — it is bookkeeping, not something the user
 * or the model reads.
 */

import * as path from 'node:path'

export const SUBAGENT_NOTIFY_CUSTOM_TYPE = 'subagent-notify'

export type TerminalRunStatus = 'succeeded' | 'failed' | 'aborted'

export interface SubagentTerminalNotice {
    customType: typeof SUBAGENT_NOTIFY_CUSTOM_TYPE
    content: string
    display: false
}

/** The minimum of pi's ExtensionAPI this module sends through. */
export interface TerminalNoticeSink {
    sendMessage(message: { customType: string; content: string; display: boolean }): void
}

export interface TerminalNoticeInput {
    agent: string
    status: TerminalRunStatus
    asyncToken: string
}

// Trackers match `/^(?:Background task|Detached foreground task) (completed|failed|stopped): \*\*/`
// and map `stopped` to their own canceled state.
const OUTCOME_LABEL: Record<TerminalRunStatus, string> = {
    succeeded: 'completed',
    failed: 'failed',
    aborted: 'stopped',
}

/**
 * Correlation token reported as the spawn call's `details.asyncDir` and echoed in
 * the notice. Trackers key on the exact string, so it must be derivable from the
 * run id alone: replay rebuilds both sides from the transcript, long after any
 * live state is gone. Nothing is written at this path.
 */
export function asyncRunToken(subagentsDir: string, subagentId: string): string {
    return path.join(subagentsDir, `${subagentId}.async`)
}

export function buildTerminalNotice(input: TerminalNoticeInput): SubagentTerminalNotice {
    const header = `Background task ${OUTCOME_LABEL[input.status]}: **${input.agent}**`
    // The token line must stay machine-readable on its own line, unrestricted to
    // the end of the line: trackers parse the remainder as the async directory.
    return {
        customType: SUBAGENT_NOTIFY_CUSTOM_TYPE,
        content: `${header}\n\nRetention-managed async directory: ${input.asyncToken}`,
        display: false,
    }
}

/** Sends the notice; returns false when no session is attached or the host refuses it. */
export function emitTerminalNotice(
    sink: TerminalNoticeSink | undefined,
    notice: SubagentTerminalNotice
): boolean {
    if (!sink) return false
    try {
        sink.sendMessage(notice)
        return true
    } catch {
        // A tracker notice is bookkeeping: it must never break the exit path that
        // reports the run's real outcome.
        return false
    }
}
