/**
 * The access log (§7.1, §7.2): append-only JSONL at `<store>/access.log` with one
 * rotated generation at `access.log.1`.
 *
 * Two rules drive the shape of this module:
 *
 * - Writers open the file **by path, per write**. A writer holding an fd follows
 *   the inode through a rotation into `.1` forever, and the next rotation deletes
 *   the generation it kept writing to.
 * - An attempt is two lines sharing a 16-hex id, because JSONL cannot be
 *   back-filled: `pending` before the confirmation, the resolver after it.
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'

import { type CommitFailureClass, type RepoLockOptions, withFileLock } from '../store/git.ts'
import {
    accessLogLockPath,
    accessLogPath,
    accessLogRotatedPath,
    type Scope,
} from '../store/paths.ts'

export type LogOp =
    'read' | 'write' | 'edit' | 'delete' | 'show' | 'search' | 'diff' | 'rotate'
export type LogInitiator = 'agent' | 'user'
export type LogDecision =
    | 'pending'
    | 'approved'
    | 'declined'
    | 'denied-no-ui'
    | 'blocked-subagent'
    | 'error'
    | 'user'
export type LogResult = 'ok' | `failed:${CommitFailureClass}`

/**
 * One log line. Three shapes share this type — the `pending` line (everything
 * set), the resolver line (`attempt`/`decision`/`result` only) and the rotate
 * marker (`op` only) — so every field except the line's own shape is optional.
 */
export interface LogEntry {
    ts?: string
    /** 16 hex chars; absent on the rotate marker. */
    attempt?: string
    op?: LogOp
    initiator?: LogInitiator
    decision?: LogDecision
    result?: LogResult
    scope?: Scope
    project?: string
    key?: string
    session?: string
    reason?: string
}

/** §5: the tool parameter is capped at 500 chars. */
export const MAX_REASON_CHARS = 500
export const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024

const LOG_LOCK_LABEL = 'log lock'
const ROTATE_MARKER = JSON.stringify({ op: 'rotate' })

/** 8 bytes is the spec's 16 hex chars (4 hex would collide at ~300 attempts). */
export function newAttemptId(): string {
    return randomBytes(8).toString('hex')
}

/**
 * Append one line. The reason is truncated to §5's cap here rather than at each
 * call site, so a tool cannot log 4 KB of justification per attempt.
 */
export function appendLog(root: string, entry: LogEntry): void {
    const { ts, ...rest } = entry
    const line: LogEntry = { ts: ts ?? new Date().toISOString(), ...rest }
    if (line.reason !== undefined) {
        line.reason =
            line.reason.length > MAX_REASON_CHARS
                ? line.reason.slice(0, MAX_REASON_CHARS)
                : line.reason
    }
    fs.mkdirSync(root, { recursive: true })
    appendLine(accessLogPath(root), JSON.stringify(line))
}

/** Every append opens the file by path; see the module comment. */
function appendLine(target: string, line: string): void {
    fs.appendFileSync(target, `${line}\n`)
}

/**
 * Rotate `access.log` to `access.log.1` when it exceeds the cap (§7.2).
 *
 * Takes `.access.log.lock` with the §3.5 rules — including takeover, without
 * which one SIGKILL bricks rotation permanently — and re-checks the size under
 * the lock, since another process may have rotated while we waited.
 *
 * Returns whether a rotation happened. Throws `LockTimeoutError` when the lock
 * cannot be taken; the caller decides whether that is fatal (session start is
 * expected to continue).
 */
export function rotateIfNeeded(
    root: string,
    maxBytes = DEFAULT_MAX_LOG_BYTES,
    lockOpts: RepoLockOptions = {}
): boolean {
    if (!logExceeds(root, maxBytes)) return false
    return withFileLock(
        accessLogLockPath(root),
        LOG_LOCK_LABEL,
        () => {
            if (!logExceeds(root, maxBytes)) return false
            // rename(2) replaces an existing `.1`, so one generation is all that
            // survives — which is what §7.2 specifies.
            fs.renameSync(accessLogPath(root), accessLogRotatedPath(root))
            // Appended, not required to be first: an appender that opened by path
            // between the rename and this write can land ahead of the marker.
            appendLine(accessLogPath(root), ROTATE_MARKER)
            return true
        },
        lockOpts
    )
}

function logExceeds(root: string, maxBytes: number): boolean {
    try {
        return fs.statSync(accessLogPath(root)).size > maxBytes
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
    }
}

/**
 * `access.log.1` then `access.log`, `tail` applied **after** concatenation
 * (§7.2). Applying `--tail` per file would return up to 2N lines.
 */
export function readLog(root: string, tail?: number): LogEntry[] {
    const entries = [
        ...readLogFile(accessLogRotatedPath(root)),
        ...readLogFile(accessLogPath(root)),
    ]
    if (tail === undefined || !Number.isFinite(tail)) return entries
    const limit = Math.floor(tail)
    if (limit <= 0) return entries
    return entries.slice(-limit)
}

function readLogFile(target: string): LogEntry[] {
    let raw: string
    try {
        raw = fs.readFileSync(target, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
    }
    const entries: LogEntry[] = []
    for (const line of raw.split('\n')) {
        const text = line.trim()
        if (text === '') continue
        let parsed: unknown
        try {
            parsed = JSON.parse(text)
        } catch {
            // A killed appender can leave half a line. One bad line must not hide
            // every entry after it.
            continue
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        entries.push(parsed as LogEntry)
    }
    return entries
}

export interface PairedAttempt {
    /** `null` for a line that carries no attempt (the rotate marker). */
    attempt: string | null
    pending: LogEntry | null
    /**
     * The last terminal line for this attempt. An approved mutation that then
     * failed appends a second resolver, and the later line is the true outcome.
     */
    resolver: LogEntry | null
    /** A `pending` with no resolver: the process died mid-confirm (§7.1). */
    unresolved: boolean
    /** Every line carrying this attempt, in log order. */
    lines: LogEntry[]
}

/** Groups log lines by attempt for `/memory log` rendering (§7.1, §10). */
export function pairAttempts(entries: readonly LogEntry[]): PairedAttempt[] {
    const rows: PairedAttempt[] = []
    const byAttempt = new Map<string, PairedAttempt>()

    for (const entry of entries) {
        const attempt = entry.attempt
        if (attempt === undefined || attempt === '') {
            // A rotate marker or any other attempt-less line is its own row.
            rows.push({
                attempt: null,
                pending: null,
                resolver: null,
                unresolved: false,
                lines: [entry],
            })
            continue
        }
        let row = byAttempt.get(attempt)
        if (row === undefined) {
            row = { attempt, pending: null, resolver: null, unresolved: false, lines: [] }
            byAttempt.set(attempt, row)
            rows.push(row)
        }
        row.lines.push(entry)
        if (entry.decision === 'pending') {
            if (row.pending === null) row.pending = entry
        } else {
            row.resolver = entry
        }
    }

    for (const row of rows) row.unresolved = row.pending !== null && row.resolver === null
    return rows
}
