/**
 * Machine-readable run status: `<subagentsDir>/<id>.async/status.json`.
 *
 * The run directory is retention-managed: for a spawn-time background run it also
 * holds `transcript.jsonl`, the child's pi session file, so the retention sweep
 * deletes the transcript with the run instead of orphaning it.
 *
 * This is the live half of the settlement contract. External trackers (Paseo's
 * `pi-subagents` adapter) poll the file every 250 ms and publish the run as
 * working until `state` reads terminal — they have no tool result to fall back
 * on, because a background spawn tool call returned at spawn time. A run that
 * never writes this file stays "working" in those trackers forever, with no
 * error anywhere.
 *
 * The other half is the `subagent-notify` session entry (async-notice.ts): the
 * poller channel is worthless after a reload, the entry is replayed from the
 * parent transcript. Both carry the same async directory as the correlation key.
 *
 * Payload is a superset of the subset the tracker validates, deliberately tiny
 * otherwise: nothing here is read back by pi itself except the retention sweep.
 *
 * Nothing in this module imports a host package — the tests run it under
 * `node --test`, outside the pi process.
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const ASYNC_STATUS_FILE = 'status.json'
export const ASYNC_DIR_SUFFIX = '.async'
/** The child's pi session file, inside the run directory for background runs. */
export const ASYNC_TRANSCRIPT_FILE = 'transcript.jsonl'
/** rename target suffix; a renamed directory is crash residue the sweep reaps. */
export const ASYNC_DELETING_INFIX = '.deleting-'
/** What a renamed run directory starts matching after its `.async` suffix. */
const ASYNC_RESIDUE_MARKER = `${ASYNC_DIR_SUFFIX}${ASYNC_DELETING_INFIX}`

const ASYNC_DIR_MODE = 0o700
const ASYNC_FILE_MODE = 0o600

/** `<subagentsDir>/<id>.async` — the directory the retention sweep owns. */
export function asyncRunDir(subagentsDir: string, runId: string): string {
    return path.join(subagentsDir, `${runId}${ASYNC_DIR_SUFFIX}`)
}

/** Where a spawn-time background run's child writes its transcript. */
export function asyncRunTranscriptPath(subagentsDir: string, runId: string): string {
    return path.join(asyncRunDir(subagentsDir, runId), ASYNC_TRANSCRIPT_FILE)
}

/** The per-run session file used by foreground, chain, and runtime-backgrounded runs. */
export function legacyRunTranscriptPath(subagentsDir: string, runId: string): string {
    return path.join(subagentsDir, `${runId}.jsonl`)
}

function fileExists(target: string): boolean {
    try {
        return fs.existsSync(target)
    } catch {
        return false
    }
}

/**
 * The transcript a run actually wrote, for readers that only know its id: the
 * retention-directory transcript when the child created it, else the legacy
 * `<id>.jsonl` a foreground or runtime-backgrounded run used. Evidence on disk,
 * not a mode flag — the writer may be a different process or an earlier session.
 */
export function findRunTranscriptPath(
    subagentsDir: string,
    runId: string
): string | undefined {
    const inRunDir = asyncRunTranscriptPath(subagentsDir, runId)
    if (fileExists(inRunDir)) return inRunDir
    const legacy = legacyRunTranscriptPath(subagentsDir, runId)
    return fileExists(legacy) ? legacy : undefined
}

/** Resolver spelling for call sites that also use the path to name a file. */
export function resolveRunTranscriptPath(subagentsDir: string, runId: string): string {
    return (
        findRunTranscriptPath(subagentsDir, runId) ??
        legacyRunTranscriptPath(subagentsDir, runId)
    )
}

/** 30 days after the last activity of a terminal run. */
export const ASYNC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** A `*.async.deleting-*` directory older than this is leftover from a crashed sweep. */
export const ASYNC_DELETING_MAX_AGE_MS = 60 * 60 * 1000

/**
 * `state` values this extension writes. `running` is non-terminal: trackers keep
 * polling. Terminal values are exactly `complete | failed | stopped`.
 */
export type RunStatusState = 'running' | 'complete' | 'failed' | 'stopped'

/** The extension's internal outcome vocabulary, for the mapping below. */
export type RunOutcome = 'succeeded' | 'failed' | 'aborted'

/**
 * Internal outcome → tracker state. Trackers (and their per-step status
 * vocabulary) do not know `succeeded`/`aborted`; `aborted` reads as a cancel.
 */
export const RUN_STATE_BY_OUTCOME: Readonly<Record<RunOutcome, RunStatusState>> = {
    succeeded: 'complete',
    failed: 'failed',
    aborted: 'stopped',
}

/** Terminal states a sweep may delete on. `rejected` is upstream's spawn-refusal state. */
const SWEEPABLE_STATES: ReadonlySet<string> = new Set([
    'complete',
    'failed',
    'stopped',
    'rejected',
])

export interface RunStatusStep {
    /** Non-empty: the tracker rejects the whole payload otherwise. */
    agent: string
    status?: RunStatusState
    sessionFile?: string
}

export interface RunStatusPayload {
    runId: string
    mode: 'single'
    state: RunStatusState
    /** Epoch ms. */
    startedAt: number
    /** Epoch ms; terminal payloads only. */
    endedAt?: number
    /** Epoch ms; refreshed on every write so a stale live run is still recognisable. */
    lastUpdate: number
    steps: RunStatusStep[]
}

export interface AsyncSweepOptions {
    /** Clock override for tests. */
    now?: number
    /** Run ids live in this process; never deleted however old their leftovers are. */
    protectedRunIds?: ReadonlySet<string>
    retentionMs?: number
    deletingMaxAgeMs?: number
}

export interface AsyncSweepCounts {
    /** `*.async` directories (and crash residue) that were considered. */
    scanned: number
    deleted: number
    kept: number
    /** Leftover `*.async.deleting-*` directories removed. */
    reaped: number
}

/**
 * Writes the status file atomically: temp file in the same directory, then
 * rename, so the poller can never parse a half-written payload. Returns false
 * instead of throwing — a tracker file must never break the spawn/exit path it
 * is written from.
 */
export function writeRunStatus(asyncDir: string, payload: RunStatusPayload): boolean {
    let tmp: string | undefined
    try {
        fs.mkdirSync(asyncDir, { recursive: true, mode: ASYNC_DIR_MODE })
        tmp = path.join(asyncDir, `${ASYNC_STATUS_FILE}.${randomUUID()}.tmp`)
        fs.writeFileSync(tmp, JSON.stringify(payload), {
            encoding: 'utf-8',
            mode: ASYNC_FILE_MODE,
        })
        fs.renameSync(tmp, path.join(asyncDir, ASYNC_STATUS_FILE))
        return true
    } catch {
        if (tmp) {
            try {
                fs.rmSync(tmp, { force: true })
            } catch {
                // Best effort: a stray temp file inside the run directory is
                // swept with the directory, not separately.
            }
        }
        return false
    }
}

interface ParsedStatusFile {
    runId: string
    state: string
    endedAt?: number
    lastUpdate?: number
}

/** The sweep trusts nothing it reads: a foreign or half-written file must not license a delete. */
function parseStatusFile(raw: string): ParsedStatusFile | undefined {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        return undefined
    }
    if (typeof value !== 'object' || value === null) return undefined
    const status = value as Partial<ParsedStatusFile>
    if (typeof status.runId !== 'string' || typeof status.state !== 'string') return undefined
    return {
        runId: status.runId,
        state: status.state,
        endedAt: typeof status.endedAt === 'number' ? status.endedAt : undefined,
        lastUpdate: typeof status.lastUpdate === 'number' ? status.lastUpdate : undefined,
    }
}

function mtimeMs(target: string): number | undefined {
    try {
        return fs.statSync(target).mtimeMs
    } catch {
        return undefined
    }
}

function isFiniteNumber(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

/** Last activity of a run: the newest of its own timestamps and its files' mtimes. */
function effectiveAgeMs(
    status: ParsedStatusFile,
    dirMtime: number | undefined,
    statusMtime: number | undefined
): number | undefined {
    const candidates = [status.endedAt, status.lastUpdate, dirMtime, statusMtime].filter(
        isFiniteNumber
    )
    if (candidates.length === 0) return undefined
    return Math.max(...candidates)
}

/** rename-then-rm, so a concurrent reader sees either the directory or nothing. */
function removeDir(dir: string): boolean {
    try {
        const doomed = `${dir}${ASYNC_DELETING_INFIX}${randomUUID()}`
        fs.renameSync(dir, doomed)
        fs.rmSync(doomed, { recursive: true, force: true })
        return true
    } catch {
        // ENOENT (already gone) and any other failure leave the directory in
        // place, which the next sweep retries.
        return false
    }
}

/**
 * Deletes terminal runs whose last activity is older than the retention window,
 * plus crash residue from an interrupted delete.
 *
 * Scope is exactly `<subagentsDir>/*.async` directories and `*.async.deleting-*`
 * residue; the same directory holds `<id>.pid` / `<id>.meta` / `<id>.jsonl`
 * siblings, which are never touched. Anything unreadable, non-terminal, live in
 * this process, or unrecognised is kept.
 */
export function sweepExpiredAsyncDirs(
    subagentsDir: string,
    opts: AsyncSweepOptions = {}
): AsyncSweepCounts {
    const now = opts.now ?? Date.now()
    const retentionMs = opts.retentionMs ?? ASYNC_RETENTION_MS
    const deletingMaxAgeMs = opts.deletingMaxAgeMs ?? ASYNC_DELETING_MAX_AGE_MS
    const protectedRunIds = opts.protectedRunIds
    const counts: AsyncSweepCounts = { scanned: 0, deleted: 0, kept: 0, reaped: 0 }

    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(subagentsDir, { withFileTypes: true })
    } catch {
        // No subagents directory yet: nothing to sweep.
        return counts
    }

    for (const entry of entries) {
        const dir = path.join(subagentsDir, entry.name)
        if (entry.name.includes(ASYNC_RESIDUE_MARKER)) {
            if (!entry.isDirectory()) continue
            counts.scanned++
            const mtime = mtimeMs(dir)
            if (!isFiniteNumber(mtime) || now - mtime < deletingMaxAgeMs) {
                counts.kept++
                continue
            }
            if (removeDir(dir)) counts.reaped++
            else counts.kept++
            continue
        }
        if (!entry.name.endsWith(ASYNC_DIR_SUFFIX) || !entry.isDirectory()) continue

        counts.scanned++
        let status: ParsedStatusFile | undefined
        try {
            status = parseStatusFile(
                fs.readFileSync(path.join(dir, ASYNC_STATUS_FILE), 'utf-8')
            )
        } catch {
            // Absent or unreadable status file: keep. This is the rule that
            // protects directories a future version of this extension might use
            // for something other than a run.
            status = undefined
        }
        if (!status) {
            counts.kept++
            continue
        }
        // Identity, not just naming: the directory must name the run the file
        // claims, so a copied or reused directory cannot delete someone else's.
        if (entry.name !== `${status.runId}${ASYNC_DIR_SUFFIX}`) {
            counts.kept++
            continue
        }
        if (!SWEEPABLE_STATES.has(status.state)) {
            counts.kept++
            continue
        }
        if (protectedRunIds?.has(status.runId)) {
            counts.kept++
            continue
        }
        const effective = effectiveAgeMs(
            status,
            mtimeMs(dir),
            mtimeMs(path.join(dir, ASYNC_STATUS_FILE))
        )
        if (!isFiniteNumber(effective) || effective >= now - retentionMs) {
            counts.kept++
            continue
        }
        if (removeDir(dir)) counts.deleted++
        else counts.kept++
    }

    return counts
}
