/**
 * The `<subagentsDir>/<id>.async` run directory: where a spawn-time background
 * run's child writes its pi session file, and the retention unit for that file.
 *
 * It holds no live channel. Completion reaches the parent through the
 * `subagent-notify` entry (async-notice.ts), and a controller that needs a run's
 * state asks the in-process control service (index.ts) rather than reading this
 * directory itself: a child dies with the pi process that spawned it, so nothing
 * in here has to outlive that process as a status record.
 *
 * What is left on disk is the transcript, which outlives the run for
 * `subagent_inspect` and `/subagents resume`, and the pid/meta siblings next to
 * the directory.
 *
 * Nothing in this module imports a host package — the tests run it under
 * `node --test`, outside the pi process.
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const ASYNC_DIR_SUFFIX = '.async'
/** The child's pi session file, inside the run directory for background runs. */
export const ASYNC_TRANSCRIPT_FILE = 'transcript.jsonl'
/** The `<id>.pid` sibling naming the child process that owned a run. */
const PIDFILE_SUFFIX = '.pid'
/** rename target suffix; a renamed directory is crash residue the sweep reaps. */
export const ASYNC_DELETING_INFIX = '.deleting-'
/** What a renamed run directory starts matching after its `.async` suffix. */
const ASYNC_RESIDUE_MARKER = `${ASYNC_DIR_SUFFIX}${ASYNC_DELETING_INFIX}`

/** `<subagentsDir>/<id>.async` — the directory the retention sweep owns. */
export function asyncRunDir(subagentsDir: string, runId: string): string {
    return path.join(subagentsDir, `${runId}${ASYNC_DIR_SUFFIX}`)
}

/** Where a spawn-time background run's child writes its transcript. */
export function asyncRunTranscriptPath(subagentsDir: string, runId: string): string {
    return path.join(asyncRunDir(subagentsDir, runId), ASYNC_TRANSCRIPT_FILE)
}

/** The per-run session file used by foreground and runtime-backgrounded runs. */
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
    runId: string,
    /** Names already listed from `subagentsDir`, for callers that just did one readdir. */
    knownNames?: ReadonlySet<string>
): string | undefined {
    const inRunDir = asyncRunTranscriptPath(subagentsDir, runId)
    // A listing that has no `<id>.async` entry already rules the run directory out,
    // so a bulk caller pays one stat per background run instead of two per row.
    if ((knownNames?.has(`${runId}${ASYNC_DIR_SUFFIX}`) ?? true) && fileExists(inRunDir))
        return inRunDir
    const legacy = legacyRunTranscriptPath(subagentsDir, runId)
    if (knownNames && !knownNames.has(path.basename(legacy))) return undefined
    return fileExists(legacy) ? legacy : undefined
}

/** Resolver spelling for call sites that also use the path to name a file. */
export function resolveRunTranscriptPath(subagentsDir: string, runId: string): string {
    return (
        findRunTranscriptPath(subagentsDir, runId) ??
        legacyRunTranscriptPath(subagentsDir, runId)
    )
}

/** 30 days after the last activity of a finished run. */
export const ASYNC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** A `*.async.deleting-*` directory older than this is leftover from a crashed sweep. */
export const ASYNC_DELETING_MAX_AGE_MS = 60 * 60 * 1000

export interface AsyncSweepOptions {
    /** Clock override for tests. */
    now?: number
    /** Run ids live in this process; never deleted however old their leftovers are. */
    protectedRunIds?: ReadonlySet<string>
    /** Liveness probe for `<id>.pid`, overridable for tests. */
    isProcessAlive?: (pid: number) => boolean
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

function mtimeMs(target: string): number | undefined {
    try {
        return fs.statSync(target).mtimeMs
    } catch {
        return undefined
    }
}

function newestOf(candidates: (number | undefined)[]): number | undefined {
    const present = candidates.filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value)
    )
    return present.length === 0 ? undefined : Math.max(...present)
}

function defaultIsProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        // EPERM: the process exists but belongs to another user.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

function readPidfile(pidPath: string): number | undefined {
    let raw: string
    try {
        raw = fs.readFileSync(pidPath, 'utf-8').trim()
    } catch {
        return undefined
    }
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

function pidfileIsLive(pidPath: string, isAlive: (pid: number) => boolean): boolean {
    const pid = readPidfile(pidPath)
    return pid !== undefined && isAlive(pid)
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
 * Deletes finished run directories older than the retention window, plus crash
 * residue from an interrupted delete.
 *
 * Scope is `<subagentsDir>/*.async` directories and `*.async.deleting-*`
 * residue. A directory is finished when nothing can still be writing to it: no
 * registry entry in this process, and no `<id>.pid` naming a live process
 * (another pi resuming the run). That is liveness, not a recorded outcome — a
 * hard-killed pi leaves no terminal state anywhere, and its orphaned directory
 * still has to go.
 *
 * Deleting a run deletes all of it: once its directory is gone, the `<id>.meta`,
 * `<id>.pid`, and `<id>.jsonl` siblings go too, so no meta survives to list a
 * run as resumable after its transcript was removed.
 *
 * It also reaps `<id>.pid` files whose process is gone, for kept runs as well.
 * That cleanup belongs here and nowhere else: removing it from the read paths
 * (list, inspect, the status tile) is what keeps them free of writes. An
 * unparsable pidfile is left in place — nothing can say which run it names.
 */
export function sweepExpiredAsyncDirs(
    subagentsDir: string,
    opts: AsyncSweepOptions = {}
): AsyncSweepCounts {
    const now = opts.now ?? Date.now()
    const retentionMs = opts.retentionMs ?? ASYNC_RETENTION_MS
    const deletingMaxAgeMs = opts.deletingMaxAgeMs ?? ASYNC_DELETING_MAX_AGE_MS
    const protectedRunIds = opts.protectedRunIds
    const isAlive = opts.isProcessAlive ?? defaultIsProcessAlive
    const counts: AsyncSweepCounts = { scanned: 0, deleted: 0, kept: 0, reaped: 0 }
    // Each pid is probed once however many times it is asked about; the pidfile
    // pass and the directory loop below share these answers.
    const pidLiveness = new Map<number, boolean>()
    const probe = (pid: number): boolean => {
        const known = pidLiveness.get(pid)
        if (known !== undefined) return known
        const alive = isAlive(pid)
        pidLiveness.set(pid, alive)
        return alive
    }

    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(subagentsDir, { withFileTypes: true })
    } catch {
        // No subagents directory yet: nothing to sweep.
        return counts
    }

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(PIDFILE_SUFFIX)) continue
        const runId = entry.name.slice(0, -PIDFILE_SUFFIX.length)
        if (!runId || protectedRunIds?.has(runId)) continue
        const pidPath = path.join(subagentsDir, entry.name)
        const pid = readPidfile(pidPath)
        if (pid === undefined || probe(pid)) continue
        try {
            fs.rmSync(pidPath, { force: true })
        } catch {
            // Left in place; the next sweep retries.
        }
    }

    for (const entry of entries) {
        const dir = path.join(subagentsDir, entry.name)
        if (entry.name.includes(ASYNC_RESIDUE_MARKER)) {
            if (!entry.isDirectory()) continue
            counts.scanned++
            const mtime = mtimeMs(dir)
            if (typeof mtime !== 'number' || now - mtime < deletingMaxAgeMs) {
                counts.kept++
                continue
            }
            if (removeDir(dir)) counts.reaped++
            else counts.kept++
            continue
        }
        if (!entry.name.endsWith(ASYNC_DIR_SUFFIX) || !entry.isDirectory()) continue

        counts.scanned++
        const runId = entry.name.slice(0, -ASYNC_DIR_SUFFIX.length)
        if (!runId || protectedRunIds?.has(runId)) {
            counts.kept++
            continue
        }
        const pidPath = path.join(subagentsDir, `${runId}${PIDFILE_SUFFIX}`)
        if (pidfileIsLive(pidPath, probe)) {
            counts.kept++
            continue
        }
        const legacyTranscript = legacyRunTranscriptPath(subagentsDir, runId)
        const lastActivity = newestOf([
            mtimeMs(dir),
            mtimeMs(path.join(dir, ASYNC_TRANSCRIPT_FILE)),
            mtimeMs(legacyTranscript),
        ])
        if (lastActivity === undefined || lastActivity >= now - retentionMs) {
            counts.kept++
            continue
        }
        if (!removeDir(dir)) {
            counts.kept++
            continue
        }
        counts.deleted++
        for (const sibling of [
            path.join(subagentsDir, `${runId}.meta`),
            legacyTranscript,
            pidPath,
        ]) {
            try {
                fs.rmSync(sibling, { force: true })
            } catch {
                // A leftover meta without a transcript is refused at resume time.
            }
        }
    }

    return counts
}
