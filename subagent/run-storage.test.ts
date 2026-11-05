import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { utimesSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import {
    ASYNC_DIR_SUFFIX,
    ASYNC_RETENTION_MS,
    ASYNC_TRANSCRIPT_FILE,
    asyncRunDir,
    asyncRunTranscriptPath,
    legacyRunTranscriptPath,
    resolveRunTranscriptPath,
    sweepExpiredAsyncDirs,
} from './run-storage.ts'

const DAY = 24 * 60 * 60 * 1000
// Fixed clock: every age assertion below is arithmetic, not wall time.
const NOW = Date.UTC(2026, 0, 1)
const RUN_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2c11'
const OTHER_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2c12'

function backdate(target: string, at: number): void {
    const when = new Date(at)
    utimesSync(target, when, when)
}

function asyncDirOf(subagentsDir: string, runId: string): string {
    return path.join(subagentsDir, `${runId}${ASYNC_DIR_SUFFIX}`)
}

/**
 * A run directory as the extension leaves it. `settled` decides whether the
 * child's transcript is in it — the only file the extension still writes there.
 */
async function createRun(
    subagentsDir: string,
    runId: string,
    at: number,
    opts: { transcript?: boolean } = {}
): Promise<string> {
    const dir = asyncDirOf(subagentsDir, runId)
    await mkdir(dir, { recursive: true })
    if (opts.transcript !== false) {
        const transcript = path.join(dir, ASYNC_TRANSCRIPT_FILE)
        await writeFile(transcript, '{"type":"session","id":"x"}\n')
        backdate(transcript, at)
    }
    backdate(dir, at)
    return dir
}

function withDir(body: (dir: string) => Promise<void> | void) {
    return async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-run-storage-'))
        try {
            await body(dir)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

async function exists(target: string): Promise<boolean> {
    try {
        await access(target)
        return true
    } catch {
        return false
    }
}

async function names(dir: string): Promise<string[]> {
    return (await readdir(dir)).sort()
}

test(
    'sweep deletes a finished run past the retention window',
    withDir(async dir => {
        const runDir = await createRun(dir, RUN_ID, NOW - 40 * DAY)
        const transcript = path.join(runDir, ASYNC_TRANSCRIPT_FILE)
        assert.deepEqual(sweepExpiredAsyncDirs(dir, { now: NOW }), {
            scanned: 1,
            deleted: 1,
            kept: 0,
            reaped: 0,
        })
        assert.deepEqual(await names(dir), [])
        assert.equal(await exists(runDir), false)
        assert.equal(await exists(transcript), false)
    })
)

test(
    'sweep keeps a run inside the retention window',
    withDir(async dir => {
        await createRun(dir, RUN_ID, NOW - 29 * DAY)
        assert.deepEqual(sweepExpiredAsyncDirs(dir, { now: NOW }), {
            scanned: 1,
            deleted: 0,
            kept: 1,
            reaped: 0,
        })
        assert.deepEqual(await names(dir), [`${RUN_ID}${ASYNC_DIR_SUFFIX}`])
    })
)

test(
    'sweep keeps a run whose transcript was appended to more recently than its directory',
    withDir(async dir => {
        // Old directory, fresh transcript: the newest signal wins, so no delete.
        const runDir = await createRun(dir, RUN_ID, NOW - 40 * DAY)
        backdate(path.join(runDir, ASYNC_TRANSCRIPT_FILE), NOW - DAY)
        assert.equal(sweepExpiredAsyncDirs(dir, { now: NOW }).kept, 1)
        assert.deepEqual(await names(dir), [`${RUN_ID}${ASYNC_DIR_SUFFIX}`])
    })
)

test(
    'sweep deletes a run whose settlement never happened, however recently it died',
    withDir(async dir => {
        // A SIGKILLed pi writes nothing anywhere. The pidfile names a dead
        // process, which is the whole liveness fact the sweep needs.
        await createRun(dir, RUN_ID, NOW - 40 * DAY)
        await writeFile(path.join(dir, `${RUN_ID}.pid`), '999999\n')
        const counts = sweepExpiredAsyncDirs(dir, { now: NOW, isProcessAlive: () => false })
        assert.equal(counts.deleted, 1)
        assert.deepEqual(await names(dir), [])
    })
)

test(
    'sweep keeps a run that is live in this process',
    withDir(async dir => {
        await createRun(dir, RUN_ID, NOW - 40 * DAY)
        await createRun(dir, OTHER_ID, NOW - 40 * DAY)
        const counts = sweepExpiredAsyncDirs(dir, {
            now: NOW,
            protectedRunIds: new Set([RUN_ID]),
        })
        assert.equal(counts.kept, 1)
        assert.equal(counts.deleted, 1)
        assert.deepEqual(await names(dir), [`${RUN_ID}${ASYNC_DIR_SUFFIX}`])
    })
)

test(
    'sweep reaps crash residue from an interrupted delete and keeps a fresh one',
    withDir(async dir => {
        const stale = path.join(dir, `${RUN_ID}${ASYNC_DIR_SUFFIX}.deleting-abc123`)
        const fresh = path.join(dir, `${OTHER_ID}${ASYNC_DIR_SUFFIX}.deleting-def456`)
        for (const target of [stale, fresh]) {
            await mkdir(target, { recursive: true })
            await writeFile(path.join(target, 'leftover'), 'x')
        }
        backdate(stale, NOW - 2 * 60 * 60 * 1000)
        backdate(fresh, NOW - 5 * 60 * 1000)
        const counts = sweepExpiredAsyncDirs(dir, { now: NOW })
        assert.equal(counts.reaped, 1)
        assert.equal(counts.kept, 1)
        assert.deepEqual(await names(dir), [`${OTHER_ID}${ASYNC_DIR_SUFFIX}.deleting-def456`])
    })
)

test(
    'sweep deletes a run with its pid/meta/session siblings and nothing unrelated',
    withDir(async dir => {
        for (const id of [RUN_ID, OTHER_ID]) {
            for (const suffix of ['.pid', '.meta', '.jsonl']) {
                const file = path.join(dir, `${id}${suffix}`)
                await writeFile(file, 'x')
                backdate(file, NOW - 40 * DAY)
            }
        }
        await createRun(dir, RUN_ID, NOW - 40 * DAY)
        await mkdir(path.join(dir, 'downloads'), { recursive: true })
        const counts = sweepExpiredAsyncDirs(dir, { now: NOW, isProcessAlive: () => false })
        assert.equal(counts.deleted, 1)
        assert.deepEqual(await names(dir), [
            `${OTHER_ID}.jsonl`,
            `${OTHER_ID}.meta`,
            `${OTHER_ID}.pid`,
            'downloads',
        ])
    })
)

test(
    'a run whose pidfile names a live process is kept however old it looks',
    withDir(async dir => {
        await createRun(dir, RUN_ID, NOW - 40 * DAY)
        const pidPath = path.join(dir, `${RUN_ID}.pid`)
        await writeFile(pidPath, '4242\n')
        backdate(pidPath, NOW - 40 * DAY)
        const probed: number[] = []
        const counts = sweepExpiredAsyncDirs(dir, {
            now: NOW,
            isProcessAlive: pid => {
                probed.push(pid)
                return true
            },
        })
        assert.deepEqual(probed, [4242])
        assert.equal(counts.deleted, 0)
        assert.ok(await exists(asyncDirOf(dir, RUN_ID)))
        assert.ok(await exists(pidPath))
    })
)

test(
    'a recent append to the legacy transcript keeps an old run directory',
    withDir(async dir => {
        await createRun(dir, RUN_ID, NOW - 40 * DAY)
        const legacy = legacyRunTranscriptPath(dir, RUN_ID)
        await writeFile(legacy, '{}\n')
        backdate(legacy, NOW - DAY)
        const counts = sweepExpiredAsyncDirs(dir, { now: NOW, isProcessAlive: () => false })
        assert.equal(counts.deleted, 0)
        assert.ok(await exists(legacy))
    })
)

test(
    'an absent subagents directory sweeps nothing and throws nothing',
    withDir(async dir => {
        assert.deepEqual(sweepExpiredAsyncDirs(path.join(dir, 'missing'), { now: NOW }), {
            scanned: 0,
            deleted: 0,
            kept: 0,
            reaped: 0,
        })
    })
)

test('the default retention window is 30 days', () => {
    assert.equal(ASYNC_RETENTION_MS, 30 * DAY)
})

test(
    'the transcript resolver prefers the run directory and falls back to the legacy file',
    withDir(async dir => {
        const legacy = legacyRunTranscriptPath(dir, RUN_ID)
        const inRunDir = asyncRunTranscriptPath(dir, RUN_ID)

        // Neither exists: callers still need a path to name (size, cleanup).
        assert.equal(resolveRunTranscriptPath(dir, RUN_ID), legacy)

        await writeFile(legacy, 'x')
        assert.equal(resolveRunTranscriptPath(dir, RUN_ID), legacy)

        // A runtime-backgrounded run has the run directory but no transcript in
        // it; the legacy file it was spawned with wins.
        await mkdir(asyncRunDir(dir, RUN_ID), { recursive: true })
        assert.equal(resolveRunTranscriptPath(dir, RUN_ID), legacy)

        await writeFile(inRunDir, 'x')
        assert.equal(resolveRunTranscriptPath(dir, RUN_ID), inRunDir)
    })
)

test(
    'the pidfile pass reaps an unprotected dead pidfile and leaves protected ones alone',
    withDir(async dir => {
        // No `.async` directory for either: the pidfile pass covers foreground runs too.
        const protectedPid = path.join(dir, `${RUN_ID}.pid`)
        const deadPid = path.join(dir, `${OTHER_ID}.pid`)
        await writeFile(protectedPid, '999999\n')
        await writeFile(deadPid, '999998\n')
        sweepExpiredAsyncDirs(dir, {
            now: NOW,
            protectedRunIds: new Set([RUN_ID]),
            isProcessAlive: () => false,
        })
        assert.ok(
            await exists(protectedPid),
            'a run registered in this process keeps its pidfile'
        )
        assert.equal(await exists(deadPid), false)
    })
)

test(
    'an unparsable pidfile is left in place',
    withDir(async dir => {
        const pidPath = path.join(dir, `${RUN_ID}.pid`)
        await writeFile(pidPath, 'not a pid\n')
        const probed: number[] = []
        sweepExpiredAsyncDirs(dir, {
            now: NOW,
            isProcessAlive: pid => {
                probed.push(pid)
                return false
            },
        })
        assert.ok(await exists(pidPath))
        assert.deepEqual(probed, [], 'nothing to probe')
    })
)
