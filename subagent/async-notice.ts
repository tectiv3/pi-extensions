/**
 * Settlement notice for background runs, in the format external trackers read.
 *
 * A tracker (Paseo's `pi-subagents` adapter) keeps a background run "working"
 * until it can derive a terminal status. It has two channels for that, and both
 * key on the async token this module builds:
 *
 * - live: it polls `<token>/status.json` every 250 ms and stops on a terminal
 *   `state` (written by async-status.ts at spawn and at settlement).
 * - durable: it reads this module's `subagent-notify` payload from the parent
 *   transcript, whose first line carries the outcome and whose body names the
 *   token. That survives a reload; the poller's file does not outlive its run.
 *
 * A wording or token drift in either channel silently strands the run as running
 * in those trackers, with no error anywhere.
 *
 * The notice is a session entry (`pi.appendEntry`), not a message. The host
 * turns every custom message into a user-role LLM message on the following
 * turn, while `sessionEntryToContextMessages` returns [] for `type: "custom"` —
 * so an entry is persisted for replay and never reaches the model.
 * Inspectability therefore comes from the renderer registered for
 * SUBAGENT_NOTIFY_CUSTOM_TYPE (see createTerminalNoticeRenderer).
 */

import type { Component } from '@earendil-works/pi-tui'
import type { CustomEntry, EntryRenderer, Theme } from '@earendil-works/pi-coding-agent'
import { asyncRunDir } from './async-status.ts'

export const SUBAGENT_NOTIFY_CUSTOM_TYPE = 'subagent-notify'

export type TerminalRunStatus = 'succeeded' | 'failed' | 'aborted'

/**
 * Entry payload. `content` is the tracker-facing text verbatim, so a consumer
 * matches strings in the transcript rather than a rendering of them.
 */
export interface SubagentTerminalNoticeData {
    agent: string
    status: TerminalRunStatus
    asyncToken: string
    content: string
}

export interface SubagentTerminalNotice {
    customType: typeof SUBAGENT_NOTIFY_CUSTOM_TYPE
    data: SubagentTerminalNoticeData
}

/** The minimum of pi's ExtensionAPI this module writes through: entries only. */
export interface TerminalNoticeSink {
    appendEntry<T = unknown>(customType: string, data?: T): void
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
 * live state is gone. It is a real directory holding `status.json` (see
 * async-status.ts), one of the two settlement channels; the notice below is the
 * other, for trackers that read the transcript rather than poll.
 */
export function asyncRunToken(subagentsDir: string, subagentId: string): string {
    return asyncRunDir(subagentsDir, subagentId)
}

export function buildTerminalNotice(input: TerminalNoticeInput): SubagentTerminalNotice {
    const header = `Background task ${OUTCOME_LABEL[input.status]}: **${input.agent}**`
    // The token line must stay machine-readable on its own line, unrestricted to
    // the end of the line: trackers parse the remainder as the async directory.
    const content = `${header}\n\nRetention-managed async directory: ${input.asyncToken}`
    return {
        customType: SUBAGENT_NOTIFY_CUSTOM_TYPE,
        data: {
            agent: input.agent,
            status: input.status,
            asyncToken: input.asyncToken,
            content,
        },
    }
}

/** Persists the notice; returns false when no session is attached or the host refuses it. */
export function emitTerminalNotice(
    sink: TerminalNoticeSink | undefined,
    notice: SubagentTerminalNotice
): boolean {
    if (!sink) return false
    try {
        sink.appendEntry(notice.customType, notice.data)
        return true
    } catch {
        // A tracker notice is bookkeeping: it must never break the exit path that
        // reports the run's real outcome.
        return false
    }
}

const STATUSES: ReadonlySet<string> = new Set<TerminalRunStatus>([
    'succeeded',
    'failed',
    'aborted',
])

// Session files are parsed without validation, so a replayed entry's data is
// untrusted until it passes this.
function isNoticeData(value: unknown): value is SubagentTerminalNoticeData {
    if (typeof value !== 'object' || value === null) return false
    const data = value as Partial<SubagentTerminalNoticeData>
    return (
        typeof data.agent === 'string' &&
        typeof data.status === 'string' &&
        STATUSES.has(data.status) &&
        typeof data.asyncToken === 'string' &&
        typeof data.content === 'string'
    )
}

/**
 * Builds the TUI component for already-styled lines. The host renderer contract
 * requires width-bounded output (the main screen throws on a line wider than the
 * terminal), and pi-tui's Text does that wrapping — but importing it here would
 * make this module unimportable outside the pi process, where the subagent tests
 * run. Callers therefore pass pi-tui's Text in.
 */
export type NoticeComponentFactory = (lines: string[]) => Component

/** Status and agent collapsed; the async token and the tracker payload when expanded. */
export function createTerminalNoticeRenderer(
    makeComponent: NoticeComponentFactory
): EntryRenderer<SubagentTerminalNoticeData> {
    return (entry: CustomEntry<SubagentTerminalNoticeData>, options, theme: Theme) => {
        if (!isNoticeData(entry.data)) {
            return makeComponent([
                theme.fg('dim', `subagent-notify: unreadable entry ${entry.id}`),
            ])
        }
        const data = entry.data
        const lines = [
            theme.fg('dim', `subagent-notify ${OUTCOME_LABEL[data.status]}: ${data.agent}`),
            theme.fg('dim', `async: ${data.asyncToken}`),
        ]
        if (options.expanded) {
            lines.push(...data.content.split('\n').map(line => theme.fg('dim', line)))
        }
        return makeComponent(lines)
    }
}
