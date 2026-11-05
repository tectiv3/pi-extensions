import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { utimesSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import {
    ASYNC_DIR_SUFFIX,
    ASYNC_RETENTION_MS,
    ASYNC_STATUS_FILE,
    RUN_STATE_BY_OUTCOME,
    type RunStatusPayload,
    type RunStatusState,
    sweepExpiredAsyncDirs,
    writeRunStatus,
} from './async-status.ts'

const DAY = 24 * 60 * 60 * 1000
// Fixed clock: every age assertion below is arithmetic, not wall time.
const NOW = Date.UTC(2026, 0, 1)
const RUN_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2c11'
const OTHER_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2c12'

function runPayload(
    runId: string,
    state: RunStatusState,
    at: number,
    sessionFile?: string
): RunStatusPayload {
    return {
        runId,
        mode: 'single',
        state,
        startedAt: at - 1000,
        ...(state === 'running' ? {} : { endedAt: at }),
        lastUpdate: at,
        steps: [{ agent: 'scout', status: state, ...(sessionFile ? { sessionFile } : {}) }],
    }
}

function backdate(target: string, at: number): void {
    const when = new Date(at)
    utimesSync(target, when, when)
}

function asyncDirOf(subagentsDir: string, runId: string): string {
    return path.join(subagentsDir, `${runId}${ASYNC_DIR_SUFFIX}`)
}

/** A run directory as the extension leaves it: status.json plus backdated mtimes. */
function createRun(
    subagentsDir: string,
    runId: string,
    state: RunStatusState,
    at: number,
    opts: { backdateFiles?: boolean } = {}
): string {
    const dir = asyncDirOf(subagentsDir, runId)
    assert.ok(writeRunStatus(dir, runPayload(runId, state, at)))
    if (opts.backdateFiles !== false) {
        backdate(path.join(dir, ASYNC_STATUS_FILE), at)
        backdate(dir, at)
    }
    return dir
}

function withDir(body: (dir: string) => Promise<void> | void) {
    return async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-async-status-'))
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

test('internal outcomes map onto the terminal states a tracker settles on', () => {
    assert.deepEqual(RUN_STATE_BY_OUTCOME, {
        succeeded: 'complete',
        failed: 'failed',
        aborted: 'stopped',
    })
})

test(
    'the written payload carries exactly the documented shape',
    withDir(async dir => {
        assert.equal(
            writeRunStatus(
                path.join(dir, `${RUN_ID}.async`),
                runPayload(RUN_ID, 'complete', NOW, `/agent/subagents/${RUN_ID}.jsonl`)
            ),
            true
        )
        const raw = await readFile(
            path.join(dir, `${RUN_ID}.async`, ASYNC_STATUS_FILE),
            'utf-8'
        )
        assert.deepEqual(JSON.parse(raw), {
            runId: RUN_ID,
            mode: 'single',
            state: 'complete',
            startedAt: NOW - 1000,
            endedAt: NOW,
            lastUpdate: NOW,
            steps: [
                {
                    agent: 'scout',
                    status: 'complete',
                    sessionFile: `/agent/subagents/${RUN_ID}.jsonl`,
                },
            ],
        })
    })
)

test(
    'the write is atomic: one parseable file, no temp residue, overwrite replaces it',
    withDir(async dir => {
        const asyncDir = path.join(dir, `${RUN_ID}.async`)
        assert.equal(writeRunStatus(asyncDir, runPayload(RUN_ID, 'running', NOW)), true)
        assert.deepEqual(await names(asyncDir), [ASYNC_STATUS_FILE])
        assert.equal(writeRunStatus(asyncDir, runPayload(RUN_ID, 'failed', NOW + 5)), true)
        assert.deepEqual(await names(asyncDir), [ASYNC_STATUS_FILE])
        const parsed = JSON.parse(
            await readFile(path.join(asyncDir, ASYNC_STATUS_FILE), 'utf-8')
        )
        assert.equal(parsed.state, 'failed')
        assert.equal(parsed.lastUpdate, NOW + 5)
    })
)

test(
    'an unwritable path returns false instead of throwing into the spawn path',
    withDir(async dir => {
        const blocker = path.join(dir, 'not-a-directory')
        await writeFile(blocker, 'x')
        let result: boolean | undefined
        assert.doesNotThrow(() => {
            result = writeRunStatus(
                path.join(blocker, 'nested'),
                runPayload(RUN_ID, 'running', NOW)
            )
        })
        assert.equal(result, false)
    })
)

test(
    'sweep deletes a terminal run past the retention window',
    withDir(async dir => {
        const runDir = createRun(dir, RUN_ID, 'complete', NOW - 40 * DAY)
        assert.deepEqual(sweepExpiredAsyncDirs(dir, { now: NOW }), {
            scanned: 1,
            deleted: 1,
            kept: 0,
            reaped: 0,
        })
        assert.deepEqual(await names(dir), [])
        assert.equal(await exists(runDir), false)
    })
)

test(
    'sweep keeps a terminal run inside the retention window',
    withDir(async dir => {
        createRun(dir, RUN_ID, 'failed', NOW - 29 * DAY)
        assert.deepEqual(sweepExpiredAsyncDirs(dir, { now: NOW }), {
            scanned: 1,
            deleted: 0,
            kept: 1,
            reaped: 0,
        })
        assert.deepEqual(await names(dir), [`${RUN_ID}.async`])
    })
)

test(
    'sweep keeps a run whose files were touched more recently than it ended',
    withDir(async dir => {
        // Old outcome timestamps, fresh mtimes: the newest signal wins, so no delete.
        createRun(dir, RUN_ID, 'complete', NOW - 40 * DAY, { backdateFiles: false })
        assert.equal(sweepExpiredAsyncDirs(dir, { now: NOW }).kept, 1)
        assert.deepEqual(await names(dir), [`${RUN_ID}.async`])
    })
)

test(
    'sweep keeps a non-terminal run however old it is',
    withDir(async dir => {
        createRun(dir, RUN_ID, 'running', NOW - 400 * DAY)
        assert.deepEqual(sweepExpiredAsyncDirs(dir, { now: NOW }), {
            scanned: 1,
            deleted: 0,
            kept: 1,
            reaped: 0,
        })
        assert.deepEqual(await names(dir), [`${RUN_ID}.async`])
    })
)

test(
    'sweep keeps a run that is live in this process',
    withDir(async dir => {
        createRun(dir, RUN_ID, 'complete', NOW - 40 * DAY)
        createRun(dir, OTHER_ID, 'complete', NOW - 40 * DAY)
        const counts = sweepExpiredAsyncDirs(dir, {
            now: NOW,
            protectedRunIds: new Set([RUN_ID]),
        })
        assert.equal(counts.kept, 1)
        assert.equal(counts.deleted, 1)
        assert.deepEqual(await names(dir), [`${RUN_ID}.async`])
    })
)

test(
    'sweep keeps a directory whose status file is absent, unreadable, or foreign',
    withDir(async dir => {
        const missing = asyncDirOf(dir, RUN_ID)
        assert.ok(writeRunStatus(missing, runPayload(RUN_ID, 'complete', NOW - 40 * DAY)))
        await rm(path.join(missing, ASYNC_STATUS_FILE))
        backdate(missing, NOW - 40 * DAY)

        const unparsable = asyncDirOf(dir, OTHER_ID)
        await mkdir(unparsable, { recursive: true })
        await writeFile(path.join(unparsable, ASYNC_STATUS_FILE), '{"runId": ')
        backdate(path.join(unparsable, ASYNC_STATUS_FILE), NOW - 40 * DAY)
        backdate(unparsable, NOW - 40 * DAY)

        const foreign = path.join(dir, 'scratch.async')
        await mkdir(foreign, { recursive: true })
        await writeFile(path.join(foreign, ASYNC_STATUS_FILE), '{"state":"complete"}')
        backdate(path.join(foreign, ASYNC_STATUS_FILE), NOW - 40 * DAY)
        backdate(foreign, NOW - 40 * DAY)

        const counts = sweepExpiredAsyncDirs(dir, { now: NOW })
        assert.equal(counts.deleted, 0)
        assert.equal(counts.kept, 3)
        assert.deepEqual(await names(dir), [
            `${RUN_ID}.async`,
            `${OTHER_ID}.async`,
            'scratch.async',
        ])
    })
)

test(
    'sweep only deletes a directory named after the run its status file claims',
    withDir(async dir => {
        // The file name is the id the extension would derive; the directory is not.
        const mismatched = asyncDirOf(dir, OTHER_ID)
        assert.ok(writeRunStatus(mismatched, runPayload(RUN_ID, 'complete', NOW - 40 * DAY)))
        backdate(path.join(mismatched, ASYNC_STATUS_FILE), NOW - 40 * DAY)
        backdate(mismatched, NOW - 40 * DAY)
        assert.equal(sweepExpiredAsyncDirs(dir, { now: NOW }).kept, 1)
        assert.deepEqual(await names(dir), [`${OTHER_ID}.async`])
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
    'sweep never touches the pid/meta/session siblings or unrelated entries',
    withDir(async dir => {
        for (const suffix of ['.pid', '.meta', '.jsonl']) {
            await writeFile(path.join(dir, `${RUN_ID}${suffix}`), 'x')
        }
        createRun(dir, RUN_ID, 'complete', NOW - 40 * DAY)
        await mkdir(path.join(dir, 'downloads'), { recursive: true })
        const counts = sweepExpiredAsyncDirs(dir, { now: NOW })
        assert.equal(counts.deleted, 1)
        assert.deepEqual(await names(dir), [
            `${RUN_ID}.jsonl`,
            `${RUN_ID}.meta`,
            `${RUN_ID}.pid`,
            'downloads',
        ])
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
