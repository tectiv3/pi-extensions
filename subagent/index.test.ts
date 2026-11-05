import assert from 'node:assert/strict'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
    ASYNC_DIR_SUFFIX,
    ASYNC_RETENTION_MS,
    ASYNC_STATUS_FILE,
    sweepExpiredAsyncDirs,
} from './async-status.ts'
import { advanceSessionEpoch, currentSessionEpoch } from './session-epoch.ts'

// The extension's entry module imports the host packages that pi provides at
// runtime, so the test has to substitute them: everything here is only reached
// by renderers and the persisted-run store, neither of which a dispatch miss
// touches. `getAgentDir` follows the host's PI_CODING_AGENT_DIR override so the
// subagents dir can be pointed at a temp dir.
const HOST_STUB = `
export const CONFIG_DIR_NAME = '.pi'
export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR ?? '/nonexistent-pi-agent-dir'
export const getMarkdownTheme = () => ({})
export const parseFrontmatter = text => {
    const match = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?([\\s\\S]*)$/.exec(text)
    if (!match) return { frontmatter: {}, body: text }
    const frontmatter = {}
    for (const line of match[1].split(/\\r?\\n/)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        const key = line.slice(0, colon).trim()
        if (key) frontmatter[key] = line.slice(colon + 1).trim()
    }
    return { frontmatter, body: match[2] }
}
export const withFileMutationQueue = (_path, fn) => fn()
export const StringEnum = values => ({ type: 'string', enum: values })
export const uuidv7 = () => 'stub0000-0000-4000-8000-000000000000'
export class Container { addChild() {} }
export class Text { constructor(text) { this.text = text } }
export class Markdown { constructor(text) { this.text = text } }
export class Spacer {}
export const CURSOR_MARKER = '\\u0000'
export const decodeKittyPrintable = () => undefined
export const Key = {}
export const matchesKey = () => false
export const renderFakeCursor = () => ''
export const truncateToWidth = text => text
export const visibleWidth = text => String(text).length
export const wrapTextWithAnsi = text => [text]
export const Type = new Proxy({}, { get: () => () => ({}) })
`

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('@earendil-works/') || specifier === 'typebox') {
            return {
                url: `data:text/javascript,${encodeURIComponent(HOST_STUB)}`,
                shortCircuit: true,
            }
        }
        return nextResolve(specifier, context)
    },
})

type ToolResult = {
    content: Array<{ type: string; text?: string }>
    details?: { results: unknown[] }
    isError?: boolean
}

type SingleResult = Parameters<SubagentModule['preSpawnMissReason']>[0]

type SubagentModule = {
    default: (pi: unknown) => void
    recoverableMiss: (reason: string) => string
    preSpawnMissReason: (result: any, subject?: string) => string | undefined
    emitBackgroundSettlement: (
        id: string,
        agent: string,
        status: 'succeeded' | 'failed' | 'aborted',
        runEpoch: number
    ) => void
}

type EntryRecord = { customType: string; data: unknown }

type Tool = {
    name: string
    execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: undefined,
        onUpdate: undefined,
        ctx: unknown
    ) => Promise<ToolResult>
}

type Dispatch = {
    module: SubagentModule
    subagent: Tool
    tools: Map<string, Tool>
    entries: EntryRecord[]
    handlers: Map<string, (...args: unknown[]) => unknown>
}

let dispatch: Promise<Dispatch> | undefined

/** pi registers the tool from the factory, so the module is loaded once per process. */
function loadDispatch(): Promise<Dispatch> {
    dispatch ??= (async () => {
        const module = (await import('./index.ts')) as unknown as SubagentModule
        const tools = new Map<string, Tool>()
        const entries: EntryRecord[] = []
        const handlers = new Map<string, (...args: unknown[]) => unknown>()
        module.default({
            registerTool: (tool: Tool) => tools.set(tool.name, tool),
            registerCommand: () => {},
            registerShortcut: () => {},
            registerEntryRenderer: () => {},
            registerMarkdownTheme: () => {},
            registerToolRenderer: () => {},
            on: (event: string, handler: (...args: unknown[]) => unknown) =>
                handlers.set(event, handler),
            appendEntry: (customType: string, data: unknown) =>
                entries.push({ customType, data }),
        })
        const subagent = tools.get('subagent')
        assert.ok(subagent, 'the subagent tool was registered')
        return { module, subagent, tools, entries, handlers }
    })()
    return dispatch
}

/** Isolates the agent dir (subagents store) and the cwd (project agent discovery). */
function tempAgentDir(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-index-'))
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = previous
        rmSync(dir, { recursive: true, force: true })
    })
    return dir
}

function makeCtx(cwd: string): unknown {
    return {
        cwd,
        hasUI: false,
        mode: 'rpc',
        isProjectTrusted: () => true,
        model: undefined,
        thinkingLevel: undefined,
        sessionManager: { getSessionId: () => 'test-session' },
        ui: { notify: () => {}, confirm: async () => true },
    }
}

function textOf(result: ToolResult): string {
    const [first] = result.content
    assert.equal(first?.type, 'text', 'the miss is reported as text content')
    return first.text ?? ''
}

async function execute(t: TestContext, params: Record<string, unknown>): Promise<ToolResult> {
    const { subagent } = await loadDispatch()
    const cwd = tempAgentDir(t)
    return subagent.execute('tool-call-1', params, undefined, undefined, makeCtx(cwd))
}

function spawnArtifacts(t: TestContext, subagentId: string): void {
    const dir = join(process.env.PI_CODING_AGENT_DIR ?? '', 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${subagentId}.meta`), '{}\n')
}

function failedResult(overrides: Record<string, unknown> = {}): SingleResult {
    return {
        agent: 'worker',
        agentSource: 'user',
        task: 'do it',
        subagentId: 'stub0000-0000-4000-8000-000000000001',
        sessionPath: '/nonexistent/session.jsonl',
        exitCode: 1,
        messages: [],
        stderr: '',
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
        },
        cwd: '/tmp',
        ...overrides,
    } as SingleResult
}

test('an unresolvable resume id is a failed call', async t => {
    const result = await execute(t, { agent: 'worker', task: 'continue', resume: '6d' })

    assert.equal(result.isError, true, 'the call settled with no run behind it')
    const text = textOf(result)
    assert.ok(text.startsWith('FAILED: '), text)
    assert.match(text, /No subagent found with id "6d"/)
    assert.match(text, /re-dispatch with subagent \{agent, task\} instead of resuming/)
    // A single line: the persisted-run listing stays in /subagents for humans.
    assert.equal(text.includes('\n'), false, text)
    assert.deepEqual(result.details?.results, [])

    // Same miss without an explicit agent: an unknown id is a resolution failure,
    // not the argument error about a missing agent.
    const withoutAgent = await execute(t, { task: 'continue', resume: '6d' })
    assert.equal(withoutAgent.isError, true)
    assert.match(textOf(withoutAgent), /^FAILED: .*No subagent found with id "6d"/)
})

test('an unknown agent in a background dispatch is a failed call', async t => {
    const result = await execute(t, { agent: 'ghost', task: 'do it' })

    assert.equal(result.isError, true)
    const text = textOf(result)
    assert.ok(text.startsWith('FAILED: '), text)
    assert.match(text, /^FAILED: agent "ghost" did not start: Unknown agent: "ghost"/)
})

test('an unknown agent in a foreground dispatch is a failed call', async t => {
    const result = await execute(t, { agent: 'ghost', task: 'do it', background: false })

    assert.equal(result.isError, true)
    assert.match(
        textOf(result),
        /^FAILED: agent "ghost" did not start: Unknown agent: "ghost"/
    )
})

test('request validation misses are failed calls', async t => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{}, /^FAILED: task is required, and agent is required unless resume names/],
        // A task alone still needs an agent: resume is the only source of one.
        [{ task: 'do it' }, /^FAILED: task is required, and agent is required unless resume/],
        [
            { agent: 'worker', task: 'do it', model: '  ' },
            /^FAILED: model must be a non-empty/,
        ],
    ]
    for (const [params, expected] of cases) {
        const result = await execute(t, params)
        assert.equal(result.isError, true, JSON.stringify(params))
        const text = textOf(result)
        assert.ok(text.startsWith('FAILED: '), text)
        assert.match(text, expected, JSON.stringify(params))
    }
})

test('a failed run that spawned a child stays a failed call', async t => {
    const { module } = await loadDispatch()
    tempAgentDir(t)

    // No artifacts: the call never reached a child, so it is a miss.
    assert.match(String(module.preSpawnMissReason(failedResult())), /did not start/)

    // Artifacts on disk: the child ran and failed, so the call stays an error.
    spawnArtifacts(t, 'stub0000-0000-4000-8000-000000000001')
    assert.equal(module.preSpawnMissReason(failedResult()), undefined)

    // An interrupted run keeps its artifacts too, and stays an error.
    assert.equal(
        module.preSpawnMissReason(failedResult({ aborted: true, exitCode: 1 })),
        undefined
    )

    // A successful run is not a failure at all, whether or not artifacts remain.
    assert.equal(module.preSpawnMissReason(failedResult({ exitCode: 0 })), undefined)
    assert.equal(
        module.preSpawnMissReason(
            failedResult({ subagentId: 'stub0000-0000-4000-8000-000000000002', exitCode: 0 })
        ),
        undefined
    )
})

test('recoverableMiss keeps one prefixed line', async () => {
    const { module } = await loadDispatch()
    assert.equal(module.recoverableMiss('only a reason'), 'FAILED: only a reason')
    assert.equal(
        module.recoverableMiss('reason; next step.\nlisting line\n- run 1'),
        'FAILED: reason; next step.'
    )
})

const STALE_RUN_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2c31'

function readStatus(agentDir: string, runId: string): Record<string, any> {
    return JSON.parse(
        readFileSync(
            join(agentDir, 'subagents', `${runId}${ASYNC_DIR_SUFFIX}`, ASYNC_STATUS_FILE),
            'utf-8'
        )
    )
}

// The status file is the poller channel and names a run-scoped directory, so a
// settlement that arrives after session_shutdown must still write it: without the
// terminal state the directory reads `running` forever and the retention sweep —
// which only deletes terminal runs — never reclaims it.
test('a stale-epoch settlement still writes a sweepable terminal status file', async t => {
    const agentDir = tempAgentDir(t)
    const { module, entries } = await loadDispatch()
    const staleEpoch = currentSessionEpoch()
    advanceSessionEpoch()

    const entriesBefore = entries.length
    module.emitBackgroundSettlement(STALE_RUN_ID, 'worker', 'failed', staleEpoch)

    assert.equal(entries.length, entriesBefore, 'no entry for a torn-down session')
    const payload = readStatus(agentDir, STALE_RUN_ID)
    assert.equal(payload.runId, STALE_RUN_ID)
    assert.equal(payload.state, 'failed')
    assert.equal(payload.endedAt, payload.lastUpdate)
    // No spawn time recorded in this process: the payload falls back to endedAt
    // rather than reporting a start after the end.
    assert.equal(payload.startedAt, payload.endedAt)
    assert.deepEqual(
        payload.steps.map((step: { agent: string; status: string }) => [
            step.agent,
            step.status,
        ]),
        [['worker', 'failed']]
    )

    // The whole point: the directory the bug leaked is now sweepable.
    const subagentsDir = join(agentDir, 'subagents')
    assert.deepEqual(
        sweepExpiredAsyncDirs(subagentsDir, {
            now: payload.lastUpdate + ASYNC_RETENTION_MS + 1000,
        }),
        { scanned: 1, deleted: 1, kept: 0, reaped: 0 }
    )
    assert.deepEqual(readdirSync(subagentsDir), [])
})

test('a live-epoch settlement writes both channels', async t => {
    const agentDir = tempAgentDir(t)
    const { module, entries } = await loadDispatch()

    const entriesBefore = entries.length
    module.emitBackgroundSettlement(STALE_RUN_ID, 'worker', 'aborted', currentSessionEpoch())

    const appended = entries.slice(entriesBefore)
    assert.equal(appended.length, 1, 'one entry per settlement')
    assert.equal(appended[0].customType, 'subagent-notify')
    assert.match(String((appended[0].data as { content: string }).content), /stopped/)
    assert.equal(readStatus(agentDir, STALE_RUN_ID).state, 'stopped')
})

function existsFile(target: string): boolean {
    try {
        return existsSync(target)
    } catch {
        return false
    }
}

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
    const deadline = Date.now() + 10_000
    for (;;) {
        const value = read()
        if (value !== undefined) return value
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise(resolve => setTimeout(resolve, 25))
    }
}

function seedAgent(agentDir: string, name = 'worker'): void {
    const dir = join(agentDir, 'agents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
        join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: test agent\n---\nSystem prompt.\n`
    )
}

// The real child would be a pi process. This stand-in records the `--session`
// path it was spawned with, optionally waits for a release file, then writes that
// session file and exits cleanly. The wait lets a test observe the spawn payload
// before the child creates the transcript, which is the point of advertising a
// deterministic path.
const FAKE_PI_SOURCE = `
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const args = process.argv.slice(2)
const sessionIndex = args.indexOf('--session')
if (sessionIndex !== -1) {
    const session = args[sessionIndex + 1]
    writeFileSync(process.env.FAKE_PI_LOG, session + '\\n')
    if (process.env.FAKE_PI_WAIT) {
        const deadline = Date.now() + 5000
        while (!existsSync(process.env.FAKE_PI_WAIT) && Date.now() < deadline) {
            await sleep(10)
        }
    }
    writeFileSync(session, JSON.stringify({ type: 'session', id: 'fake-session' }) + '\\n')
}
process.exit(0)
`

interface FakePi {
    /** Records the `--session` path the child was spawned with. */
    spawnLog: string
    /** Lets a waiting child write its transcript and exit. */
    release: () => void
}

/** Points getPiInvocation at the stand-in. */
function useFakePi(
    t: TestContext,
    agentDir: string,
    opts: { waitForRelease?: boolean } = {}
): FakePi {
    const script = join(agentDir, 'fake-pi.mjs')
    const spawnLog = join(agentDir, 'spawn-session.log')
    const waitPath = join(agentDir, 'fake-pi-go')
    writeFileSync(script, FAKE_PI_SOURCE)
    const previousArgv1 = process.argv[1]
    const previousLog = process.env.FAKE_PI_LOG
    const previousWait = process.env.FAKE_PI_WAIT
    process.argv[1] = script
    process.env.FAKE_PI_LOG = spawnLog
    if (opts.waitForRelease) process.env.FAKE_PI_WAIT = waitPath
    else delete process.env.FAKE_PI_WAIT
    const release = () => {
        try {
            writeFileSync(waitPath, 'go')
        } catch {
            // The temp dir's cleanup may already have run; the child's own
            // deadline then ends the wait.
        }
    }
    t.after(() => {
        // Never leave a waiting child behind when an assertion failed first.
        release()
        process.argv[1] = previousArgv1
        if (previousLog === undefined) delete process.env.FAKE_PI_LOG
        else process.env.FAKE_PI_LOG = previousLog
        if (previousWait === undefined) delete process.env.FAKE_PI_WAIT
        else process.env.FAKE_PI_WAIT = previousWait
    })
    return { spawnLog, release }
}

function spawnedSession(log: string): string | undefined {
    if (!existsFile(log)) return undefined
    const value = readFileSync(log, 'utf-8').trim()
    return value.length > 0 ? value : undefined
}

function terminalStatus(asyncDir: string): Record<string, any> | undefined {
    try {
        const payload = JSON.parse(readFileSync(join(asyncDir, ASYNC_STATUS_FILE), 'utf-8'))
        return payload.state === 'running' ? undefined : payload
    } catch {
        return undefined
    }
}

test('a background spawn writes its transcript inside the run directory and keeps it on success', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const fake = useFakePi(t, agentDir, { waitForRelease: true })
    const { subagent } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'worker', task: 'do it' },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const details = result.details as { asyncId?: string; asyncDir?: string }
    assert.ok(details.asyncId, 'the spawn reported an async id')
    assert.ok(details.asyncDir, 'the spawn reported an async dir')

    const asyncDir = details.asyncDir
    const transcript = join(asyncDir, 'transcript.jsonl')
    assert.equal(transcript.startsWith(asyncDir), true)

    // The first poll already names the transcript, before the child has created
    // it: the tracker retries a missing file, so waiting for an existsSync gate
    // would only lose the live half of the run.
    const spawnPayload = readStatus(agentDir, details.asyncId)
    assert.equal(spawnPayload.state, 'running')
    assert.equal(spawnPayload.steps[0].sessionFile, transcript)
    assert.equal(existsFile(transcript), false)

    // `--session` and the status step name the same file, so a tracker that
    // registers the step follows the transcript the child actually writes.
    assert.equal(
        await waitFor(() => spawnedSession(fake.spawnLog), 'the child spawn'),
        transcript
    )
    fake.release()
    const payload = await waitFor(() => terminalStatus(asyncDir), 'the terminal status')
    assert.equal(payload.state, 'complete')
    assert.equal(payload.steps[0].sessionFile, transcript)

    // Success cleanup: retention owns the transcript, the meta-driven list is not
    // left pointing at nothing.
    assert.equal(existsFile(transcript), true)
    assert.equal(existsFile(join(agentDir, 'subagents', `${details.asyncId}.meta`)), false)
})

test('a foreground spawn keeps the legacy path and deletes transcript and meta on success', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const fake = useFakePi(t, agentDir)
    const { subagent } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'worker', task: 'do it', background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const details = result.details as {
        asyncId?: string
        results: Array<{ subagentId: string }>
    }
    assert.equal(details.asyncId, undefined, 'a foreground run has no async dir')
    const id = details.results[0].subagentId
    const legacy = join(agentDir, 'subagents', `${id}.jsonl`)

    assert.equal(await waitFor(() => spawnedSession(fake.spawnLog), 'the child spawn'), legacy)
    assert.equal(existsFile(legacy), false)
    assert.equal(existsFile(join(agentDir, 'subagents', `${id}.meta`)), false)
    assert.equal(existsFile(join(agentDir, 'subagents', `${id}.async`)), false)
})

const PROMPT_HASH = createHash('sha256').update('System prompt.\n').digest('hex')
const RESUME_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2c99'

function seedFailedRun(agentDir: string, id: string): string {
    const dir = join(agentDir, 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
        join(dir, `${id}.meta`),
        JSON.stringify({
            agent: 'worker',
            task: 'do it',
            startedAt: new Date().toISOString(),
            promptHash: PROMPT_HASH,
            status: 'failed',
        })
    )
    return dir
}

function statusOf(asyncDir: string): Record<string, any> | undefined {
    try {
        return JSON.parse(readFileSync(join(asyncDir, ASYNC_STATUS_FILE), 'utf-8'))
    } catch {
        return undefined
    }
}

// A quit disposes the runtime and exits in the same turn, so the killed child's
// close event never drives a settlement: the shutdown handler itself has to leave
// the tracker a terminal state.
test('session shutdown marks an in-flight background run stopped before any child event', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const fake = useFakePi(t, agentDir, { waitForRelease: true })
    const { subagent, handlers } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'worker', task: 'do it' },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const asyncDir = (result.details as { asyncDir?: string }).asyncDir
    assert.ok(asyncDir)
    assert.equal(statusOf(asyncDir)?.state, 'running')

    const shutdown = handlers.get('session_shutdown')
    assert.ok(shutdown, 'the shutdown handler is registered')
    shutdown()
    const payload = statusOf(asyncDir)
    assert.equal(payload?.state, 'stopped', 'written synchronously inside the handler')
    assert.equal(payload?.endedAt, payload?.lastUpdate)
    assert.ok(payload?.startedAt <= payload?.endedAt)
    assert.equal(payload?.steps[0].sessionFile, join(asyncDir, 'transcript.jsonl'))

    fake.release()
    // The killed child's own settlement still lands, and stays terminal.
    await waitFor(
        () =>
            existsFile(join(agentDir, 'subagents', 'stub0000-0000-4000-8000-000000000000.pid'))
                ? undefined
                : true,
        'the child exit'
    )
    assert.notEqual(statusOf(asyncDir)?.state, 'running')
})

test('resume refuses a run whose transcript is gone', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    seedFailedRun(agentDir, RESUME_ID)
    const { subagent } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'worker', task: 'continue', resume: RESUME_ID, background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const text = textOf(result)
    assert.equal(result.isError, true)
    assert.match(text, /^FAILED: Cannot resume ".+": no transcript was persisted/)
})

test('resume refuses a run the retention sweep deleted', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    const runDir = join(subagentsDir, `${RESUME_ID}${ASYNC_DIR_SUFFIX}`)
    mkdirSync(runDir)
    writeFileSync(join(runDir, 'transcript.jsonl'), '{}\n')
    const old = Date.now() - ASYNC_RETENTION_MS - 60_000
    writeFileSync(
        join(runDir, ASYNC_STATUS_FILE),
        JSON.stringify({ runId: RESUME_ID, state: 'failed', endedAt: old, lastUpdate: old })
    )
    for (const target of [
        join(runDir, 'transcript.jsonl'),
        join(runDir, ASYNC_STATUS_FILE),
        join(subagentsDir, `${RESUME_ID}.meta`),
        runDir,
    ]) {
        utimesSync(target, new Date(old), new Date(old))
    }

    assert.equal(sweepExpiredAsyncDirs(subagentsDir).deleted, 1)
    assert.equal(existsFile(join(subagentsDir, `${RESUME_ID}.meta`)), false)

    const { subagent } = await loadDispatch()
    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'worker', task: 'continue', resume: RESUME_ID, background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    assert.match(textOf(result), /^FAILED: .*No subagent found/)
    assert.equal(result.isError, true)
})

test('a foreground resume of a background run keeps its transcript and refreshes its status', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    useFakePi(t, agentDir)
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    const runDir = join(subagentsDir, `${RESUME_ID}${ASYNC_DIR_SUFFIX}`)
    const transcript = join(runDir, 'transcript.jsonl')
    mkdirSync(runDir)
    writeFileSync(transcript, JSON.stringify({ type: 'session', id: 'earlier' }) + '\n')
    writeFileSync(
        join(runDir, ASYNC_STATUS_FILE),
        JSON.stringify({
            runId: RESUME_ID,
            mode: 'single',
            state: 'failed',
            startedAt: 1,
            endedAt: 2,
            lastUpdate: 2,
            steps: [{ agent: 'worker', status: 'failed', sessionFile: transcript }],
        })
    )
    const { subagent, tools } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'worker', task: 'continue', resume: RESUME_ID, background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    assert.equal(result.isError, undefined, textOf(result))
    assert.equal(existsFile(transcript), true, 'retention still owns the transcript')
    assert.equal(existsFile(join(subagentsDir, `${RESUME_ID}.meta`)), false)
    const payload = statusOf(runDir)
    assert.equal(payload?.state, 'complete')
    assert.equal(payload?.steps[0].sessionFile, transcript)

    const inspect = tools.get('subagent_inspect')
    assert.ok(inspect)
    const report = textOf(
        await inspect.execute(
            'tool-call-2',
            { id: RESUME_ID },
            undefined,
            undefined,
            makeCtx(agentDir)
        )
    )
    assert.match(report, /Status: succeeded/)
    assert.match(report, /Agent: worker/)
})

test('a background resume of a legacy-transcript run advertises no sessionFile', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const fake = useFakePi(t, agentDir, { waitForRelease: true })
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    const legacy = join(subagentsDir, `${RESUME_ID}.jsonl`)
    writeFileSync(legacy, JSON.stringify({ type: 'session', id: 'earlier' }) + '\n')
    const { subagent } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'worker', task: 'continue', resume: RESUME_ID },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const asyncDir = (result.details as { asyncDir?: string }).asyncDir
    assert.ok(asyncDir, textOf(result))
    assert.equal(statusOf(asyncDir)?.state, 'running')
    assert.equal(statusOf(asyncDir)?.steps[0].sessionFile, undefined)
    assert.equal(await waitFor(() => spawnedSession(fake.spawnLog), 'the child spawn'), legacy)

    fake.release()
    const payload = await waitFor(() => terminalStatus(asyncDir), 'the terminal status')
    assert.equal(payload.state, 'complete')
    assert.equal(payload.steps[0].sessionFile, undefined)
    assert.equal(existsFile(legacy), false, 'a legacy transcript keeps the success cleanup')
})

test('a resume without an agent continues as the agent the run recorded', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const fake = useFakePi(t, agentDir, { waitForRelease: true })
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    const legacy = join(subagentsDir, `${RESUME_ID}.jsonl`)
    writeFileSync(legacy, JSON.stringify({ type: 'session', id: 'earlier' }) + '\n')
    const { subagent } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { task: 'continue', resume: RESUME_ID },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const asyncDir = (result.details as { asyncDir?: string }).asyncDir
    assert.ok(asyncDir, textOf(result))
    assert.equal(result.isError, undefined, textOf(result))
    // The meta sidecar supplied the agent: the spawn payload names it, and the
    // child was started on the run's own transcript.
    assert.equal(statusOf(asyncDir)?.steps[0].agent, 'worker')
    assert.equal(await waitFor(() => spawnedSession(fake.spawnLog), 'the child spawn'), legacy)

    fake.release()
    const payload = await waitFor(() => terminalStatus(asyncDir), 'the terminal status')
    assert.equal(payload.state, 'complete')
    assert.equal(payload.steps[0].agent, 'worker')
})
