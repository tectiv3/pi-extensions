/**
 * Settlement notice for background runs, in the format their consumers read.
 *
 * A background spawn returns at spawn time, so this entry is the only record of
 * how the run ended: the outcome on its first line, the async token naming the
 * run directory in its body. Nothing else on disk is a settlement channel.
 *
 * A wording or token drift silently strands the run as running in a consumer
 * that matches on it, with no error anywhere.
 *
 * The notice is a session entry (`pi.appendEntry`), not a message. The host
 * turns every custom message into a user-role LLM message on the following
 * turn, while `sessionEntryToContextMessages` returns [] for `type: "custom"` —
 * so an entry is persisted for replay and never reaches the model.
 * Inspectability therefore comes from the renderer registered for
 * SUBAGENT_NOTIFY_CUSTOM_TYPE (see createTerminalNoticeRenderer), and the
 * `notification` field carries this run's block of the parent's notification so a host can show
 * the settlement as a row rather than the user-role message that mirrors it.
 */

import type { Component } from '@earendil-works/pi-tui'
import type { CustomEntry, EntryRenderer, Theme } from '@earendil-works/pi-coding-agent'
import { asyncRunDir } from './run-storage.ts'

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
    /**
     * What the parent was told, for hosts that render settlement as a row instead
     * of the mirrored user message. Optional: transcripts written before this
     * field exist replay without it.
     */
    notification?: SubagentNoticeSummary
}

/**
 * The parent-facing half of a settlement. `text` is this run's notification
 * block as built at settlement, so a host derives the row from the words the
 * parent is sent; the call-to-action lines in it are the host's to drop. It is
 * not a delivery receipt: the parent's notification batches blocks settled
 * together, and drops one whose result was collected or superseded by a resume
 * before the batch went out. `shortId` is the id that notification
 * names, and the only stable key between the two channels: the tracker text
 * carries the async directory, which is not the id the parent was shown.
 */
export interface SubagentNoticeSummary {
    shortId: string
    text: string
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
    notification?: SubagentNoticeSummary
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
 * the notice. Consumers key on the exact string, so it must be derivable from the
 * run id alone: a replay rebuilds it from the transcript, long after the process
 * that spawned the run is gone. It is a real directory holding the run's
 * transcript (see run-storage.ts).
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
            ...(input.notification ? { notification: input.notification } : {}),
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
        typeof data.content === 'string' &&
        (data.notification === undefined || isNoticeSummary(data.notification))
    )
}

function isNoticeSummary(value: unknown): value is SubagentNoticeSummary {
    if (typeof value !== 'object' || value === null) return false
    const summary = value as Partial<SubagentNoticeSummary>
    return typeof summary.shortId === 'string' && typeof summary.text === 'string'
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
