import assert from 'node:assert/strict'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
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
import { ASYNC_DIR_SUFFIX, ASYNC_RETENTION_MS, sweepExpiredAsyncDirs } from './run-storage.ts'
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
    deletePersistedRunArtifacts: (subagentId: string) => string | undefined
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

// A settlement that arrives after session_shutdown belongs to a run whose
// transcript is gone: it must not write a notice into the replacement session.
test('a stale-epoch settlement writes no notice entry', async () => {
    const { module, entries } = await loadDispatch()
    const staleEpoch = currentSessionEpoch()
    advanceSessionEpoch()

    const entriesBefore = entries.length
    module.emitBackgroundSettlement(STALE_RUN_ID, 'worker', 'failed', staleEpoch)

    assert.equal(entries.length, entriesBefore, 'no entry for a torn-down session')
})

test('a live-epoch settlement writes the notice entry', async () => {
    const { module, entries } = await loadDispatch()

    const entriesBefore = entries.length
    module.emitBackgroundSettlement(STALE_RUN_ID, 'worker', 'aborted', currentSessionEpoch())

    const appended = entries.slice(entriesBefore)
    assert.equal(appended.length, 1, 'one entry per settlement')
    assert.equal(appended[0].customType, 'subagent-notify')
    assert.match(String((appended[0].data as { content: string }).content), /stopped/)
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
if (process.env.FAKE_PI_HOLD) {
    // Settled but not exited: the parent sees agent_settled while the process lives.
    process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
    const deadline = Date.now() + 5000
    while (!existsSync(process.env.FAKE_PI_HOLD) && Date.now() < deadline) {
        await sleep(10)
    }
}
process.exit(Number(process.env.FAKE_PI_EXIT_CODE ?? 0))
`

interface FakePi {
    /** Records the `--session` path the child was spawned with. */
    spawnLog: string
    /** Lets a waiting child write its transcript and exit. */
    release: () => void
    /** Makes the next spawn wait for another release. */
    rearm: () => void
    /** With holdAfterSettle: lets a settled child exit. */
    releaseExit: () => void
}

/** Points getPiInvocation at the stand-in. */
function useFakePi(
    t: TestContext,
    agentDir: string,
    opts: { waitForRelease?: boolean; holdAfterSettle?: boolean; exitCode?: number } = {}
): FakePi {
    const script = join(agentDir, 'fake-pi.mjs')
    const spawnLog = join(agentDir, 'spawn-session.log')
    const waitPath = join(agentDir, 'fake-pi-go')
    const holdPath = join(agentDir, 'fake-pi-exit')
    writeFileSync(script, FAKE_PI_SOURCE)
    const previousArgv1 = process.argv[1]
    const previousLog = process.env.FAKE_PI_LOG
    const previousWait = process.env.FAKE_PI_WAIT
    const previousHold = process.env.FAKE_PI_HOLD
    const previousExitCode = process.env.FAKE_PI_EXIT_CODE
    process.argv[1] = script
    process.env.FAKE_PI_LOG = spawnLog
    if (opts.waitForRelease) process.env.FAKE_PI_WAIT = waitPath
    else delete process.env.FAKE_PI_WAIT
    if (opts.holdAfterSettle) process.env.FAKE_PI_HOLD = holdPath
    else delete process.env.FAKE_PI_HOLD
    if (opts.exitCode !== undefined) process.env.FAKE_PI_EXIT_CODE = String(opts.exitCode)
    else delete process.env.FAKE_PI_EXIT_CODE
    const releaseExit = () => {
        try {
            writeFileSync(holdPath, 'go')
        } catch {
            // Temp dir already cleaned up; the child's deadline ends the hold.
        }
    }
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
        releaseExit()
        process.argv[1] = previousArgv1
        if (previousLog === undefined) delete process.env.FAKE_PI_LOG
        else process.env.FAKE_PI_LOG = previousLog
        if (previousWait === undefined) delete process.env.FAKE_PI_WAIT
        else process.env.FAKE_PI_WAIT = previousWait
        if (previousHold === undefined) delete process.env.FAKE_PI_HOLD
        else process.env.FAKE_PI_HOLD = previousHold
        if (previousExitCode === undefined) delete process.env.FAKE_PI_EXIT_CODE
        else process.env.FAKE_PI_EXIT_CODE = previousExitCode
    })
    const rearm = () => rmSync(waitPath, { force: true })
    return { spawnLog, release, rearm, releaseExit }
}

function spawnedSession(log: string): string | undefined {
    if (!existsFile(log)) return undefined
    const value = readFileSync(log, 'utf-8').trim()
    return value.length > 0 ? value : undefined
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
    const details = result.details as {
        asyncId?: string
        asyncDir?: string
        asyncSessionFile?: string
    }
    assert.ok(details.asyncId, 'the spawn reported an async id')
    assert.ok(details.asyncDir, 'the spawn reported an async dir')

    const asyncDir = details.asyncDir
    const transcript = join(asyncDir, 'transcript.jsonl')
    assert.equal(
        details.asyncSessionFile,
        transcript,
        'the spawn names the transcript to follow'
    )
    assert.equal(transcript.startsWith(asyncDir), true)
    assert.equal(existsFile(transcript), false, 'the child has not written it yet')

    // The child's own `--session` is the file the run directory advertises.
    assert.equal(
        await waitFor(() => spawnedSession(fake.spawnLog), 'the child spawn'),
        transcript
    )
    fake.release()
    await waitFor(
        () =>
            existsFile(join(agentDir, 'subagents', `${details.asyncId}.pid`))
                ? undefined
                : true,
        'the child exit'
    )

    // Retention owns the transcript and the meta, which now records the outcome.
    assert.equal(existsFile(transcript), true)
    const metaPath = join(agentDir, 'subagents', `${details.asyncId}.meta`)
    assert.equal(
        (JSON.parse(readFileSync(metaPath, 'utf-8')) as { status?: string }).status,
        'succeeded'
    )
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
    const transcript = join(runDir, 'transcript.jsonl')
    writeFileSync(transcript, '{}\n')
    const old = Date.now() - ASYNC_RETENTION_MS - 60_000
    for (const target of [transcript, runDir]) {
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

test('a foreground resume of a background run keeps its transcript', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    useFakePi(t, agentDir)
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    const runDir = join(subagentsDir, `${RESUME_ID}${ASYNC_DIR_SUFFIX}`)
    const transcript = join(runDir, 'transcript.jsonl')
    mkdirSync(runDir)
    writeFileSync(transcript, JSON.stringify({ type: 'session', id: 'earlier' }) + '\n')
    const { module, subagent, tools } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'worker', task: 'continue', resume: RESUME_ID, background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    assert.equal(result.isError, undefined, textOf(result))
    assert.equal(existsFile(transcript), true, 'retention still owns the transcript')
    const meta = JSON.parse(
        readFileSync(join(subagentsDir, `${RESUME_ID}.meta`), 'utf-8')
    ) as {
        status?: string
    }
    assert.equal(meta.status, 'succeeded', 'the kept meta records the outcome')

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

    // Listings show what needs attention; the success stays out of the report.
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined
    module.default({
        ...(stubExtensionApi() as Record<string, unknown>),
        registerCommand: (
            name: string,
            command: { handler: (args: string, ctx: unknown) => Promise<void> }
        ) => {
            if (name === 'subagents') handler = command.handler
        },
    })
    assert.ok(handler, 'the /subagents command was registered')
    const notices: string[] = []
    await handler('', {
        ...(makeCtx(agentDir) as Record<string, unknown>),
        ui: { notify: (message: string) => notices.push(message) },
    })
    assert.deepEqual(notices, ['No persisted subagent runs from this session.'])
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
    // The meta sidecar supplied the agent: the spawn result names it, and the
    // child was started on the run's own transcript.
    assert.match(textOf(result), /agent: worker/)
    assert.equal(await waitFor(() => spawnedSession(fake.spawnLog), 'the child spawn'), legacy)

    // The next test resumes the same id, which is refused while this run is
    // still registered: wait for the child to settle.
    fake.release()
    await waitFor(
        () => (existsFile(join(subagentsDir, `${RESUME_ID}.pid`)) ? undefined : true),
        'the child exit'
    )
})

test('a resume with an empty agent string infers the recorded agent', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const fake = useFakePi(t, agentDir)
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    const legacy = join(subagentsDir, `${RESUME_ID}.jsonl`)
    writeFileSync(legacy, JSON.stringify({ type: 'session', id: 'earlier' }) + '\n')
    const { subagent } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { agent: '', task: 'continue', resume: RESUME_ID, background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    assert.equal(result.isError, undefined, textOf(result))
    assert.equal(await waitFor(() => spawnedSession(fake.spawnLog), 'the child spawn'), legacy)
})

test('a resume naming a different agent than the run recorded is a failed call', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    seedAgent(agentDir, 'other')
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    writeFileSync(join(subagentsDir, `${RESUME_ID}.jsonl`), '{}\n')
    const { subagent } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'other', task: 'continue', resume: RESUME_ID },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    assert.equal(result.isError, true)
    assert.match(textOf(result), /^FAILED: .*the original run used agent "worker"/)
    assert.deepEqual((result.details as { results: unknown[] }).results, [])
})

test('a resume whose meta records no agent reports that, not a changed definition', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    writeFileSync(join(subagentsDir, `${RESUME_ID}.meta`), JSON.stringify({ task: 'do it' }))
    writeFileSync(join(subagentsDir, `${RESUME_ID}.jsonl`), '{}\n')
    const { subagent } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { task: 'continue', resume: RESUME_ID },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    assert.equal(result.isError, true)
    assert.match(textOf(result), /meta sidecar records no agent/)
})

test('a resume of a project agent under user scope names the scope', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(join(agentDir, '.pi'))
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    writeFileSync(join(subagentsDir, `${RESUME_ID}.jsonl`), '{}\n')
    const { subagent } = await loadDispatch()

    const result = await subagent.execute(
        'tool-call-1',
        { task: 'continue', resume: RESUME_ID },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    assert.equal(result.isError, true)
    assert.match(textOf(result), /not available in agentScope "user"/)
})

function untrustedCtx(cwd: string, answer: boolean, asked: string[]): unknown {
    const base = makeCtx(cwd) as Record<string, unknown>
    return {
        ...base,
        hasUI: true,
        isProjectTrusted: () => false,
        ui: {
            notify: () => {},
            confirm: async (_title: string, body: string) => {
                asked.push(body)
                return answer
            },
        },
    }
}

test('declining the project-agent confirm is a failed call', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(join(agentDir, '.pi'))
    const { subagent } = await loadDispatch()
    const asked: string[] = []

    const result = await subagent.execute(
        'tool-call-1',
        { agent: 'worker', task: 'do it', agentScope: 'both' },
        undefined,
        undefined,
        untrustedCtx(agentDir, false, asked)
    )
    assert.equal(asked.length, 1)
    assert.equal(result.isError, true)
    assert.equal(textOf(result), 'Canceled: project-local agents not approved.')
    assert.deepEqual((result.details as { results: unknown[] }).results, [])
})

test('an inferred project agent on resume still goes through the trust gate', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(join(agentDir, '.pi'))
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    writeFileSync(join(subagentsDir, `${RESUME_ID}.jsonl`), '{}\n')
    const { subagent } = await loadDispatch()
    const asked: string[] = []

    const result = await subagent.execute(
        'tool-call-1',
        { task: 'continue', resume: RESUME_ID, agentScope: 'both' },
        undefined,
        undefined,
        untrustedCtx(agentDir, false, asked)
    )
    assert.equal(asked.length, 1)
    assert.match(asked[0], /Agents: worker/)
    assert.equal(result.isError, true)
})

test('a resume re-checks liveness after the trust confirm', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(join(agentDir, '.pi'))
    const subagentsDir = seedFailedRun(agentDir, RESUME_ID)
    writeFileSync(join(subagentsDir, `${RESUME_ID}.jsonl`), '{}\n')
    const { subagent } = await loadDispatch()
    const base = untrustedCtx(agentDir, true, []) as { ui: Record<string, unknown> }
    // A parallel resume of the same run spawned its child while this confirm was open.
    base.ui.confirm = async () => {
        writeFileSync(join(subagentsDir, `${RESUME_ID}.pid`), `${process.pid}\n`)
        return true
    }

    const result = await subagent.execute(
        'tool-call-1',
        { task: 'continue', resume: RESUME_ID, agentScope: 'both' },
        undefined,
        undefined,
        base
    )
    assert.equal(result.isError, true)
    assert.match(textOf(result), /is still running \(pid \d+\)/)
})

// ── Programmatic control service ─────────────────────────────────────
//
// Paseo's in-process bridge reads this off globalThis. These tests pin the
// contract key, the capabilities derived from state, and fail-closed behavior.

const CONTROL_KEY = 'pi-extensions:subagent:control'

interface ControlInfo {
    id: string
    agent?: string
    status: string
    background: boolean
    capabilities: string[]
    sessionFile?: string
    title?: string
}

interface ControlResult {
    ok: boolean
    id: string
    status?: string
    reason?: string
}

interface ControlService {
    version: number
    list(): ControlInfo[]
    stop(id: string): Promise<ControlResult>
    background(id: string): Promise<ControlResult>
}

function controlService(): ControlService {
    const service = (globalThis as unknown as Record<symbol, ControlService | undefined>)[
        Symbol.for(CONTROL_KEY)
    ]
    assert.ok(service, 'extension init published the control service')
    return service
}

/** The extension factory runs once per load and again on reload. */
function stubExtensionApi(): unknown {
    return {
        registerTool: () => {},
        registerCommand: () => {},
        registerShortcut: () => {},
        registerEntryRenderer: () => {},
        registerMarkdownTheme: () => {},
        registerToolRenderer: () => {},
        on: () => {},
        appendEntry: () => {},
    }
}

/** A fresh init whose lifecycle handlers the test drives itself. */
function initWithHandlers(
    module: SubagentModule
): Map<string, (...args: unknown[]) => unknown> {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    module.default({
        ...(stubExtensionApi() as Record<string, unknown>),
        on: (event: string, handler: (...args: unknown[]) => unknown) =>
            handlers.set(event, handler),
    })
    return handlers
}

const CONTROL_ABORTED_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2caa'
const CONTROL_FOREIGN_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2cac'
const CONTROL_OTHER_SESSION_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2cad'
const CONTROL_UNSCOPED_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2cae'
const CONTROL_UNPARSABLE_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2caf'

function seedControlStore(agentDir: string): string {
    const dir = join(agentDir, 'subagents')
    mkdirSync(dir, { recursive: true })

    // Aborted run: meta survives, transcript on the legacy path.
    writeFileSync(
        join(dir, `${CONTROL_ABORTED_ID}.meta`),
        JSON.stringify({
            agent: 'worker',
            task: 'resume\nme',
            startedAt: new Date().toISOString(),
            promptHash: PROMPT_HASH,
            parentSessionId: 'test-session',
            status: 'aborted',
        })
    )
    writeFileSync(join(dir, `${CONTROL_ABORTED_ID}.jsonl`), '{}\n')

    // Another process's live child: status derives to running, but this
    // process has no entry to abort or background.
    writeFileSync(
        join(dir, `${CONTROL_FOREIGN_ID}.meta`),
        JSON.stringify({
            agent: 'worker',
            task: 'elsewhere',
            startedAt: new Date().toISOString(),
            promptHash: PROMPT_HASH,
            parentSessionId: 'test-session',
        })
    )
    writeFileSync(join(dir, `${CONTROL_FOREIGN_ID}.pid`), `${process.pid}\n`)

    // None of these belong to this session's listing.
    const excluded = {
        agent: 'worker',
        task: 'not mine',
        startedAt: new Date().toISOString(),
        promptHash: PROMPT_HASH,
        status: 'failed',
    }
    writeFileSync(
        join(dir, `${CONTROL_OTHER_SESSION_ID}.meta`),
        JSON.stringify({ ...excluded, parentSessionId: 'other-session' })
    )
    writeFileSync(join(dir, `${CONTROL_UNSCOPED_ID}.meta`), JSON.stringify(excluded))
    writeFileSync(join(dir, `${CONTROL_UNPARSABLE_ID}.meta`), '{not json')
    return dir
}

test('init publishes the control service under the contract symbol and re-init replaces it', async () => {
    const { module } = await loadDispatch()
    const first = controlService()

    assert.equal(first.version, 1)
    assert.deepEqual(Object.keys(first).sort(), ['background', 'list', 'stop', 'version'])

    module.default(stubExtensionApi())
    const second = controlService()
    assert.notEqual(second, first, 'a re-init publishes a fresh service')
    assert.equal(second.version, 1)
})

test('list exposes active and persisted rows with state-derived capabilities', async t => {
    const agentDir = tempAgentDir(t)
    seedControlStore(agentDir)
    const { subagent } = await loadDispatch()
    // The persisted rows are session-scoped; this is the capture point.
    await subagent.execute(
        'capture-session',
        { agent: 'ghost', task: 'noop' },
        undefined,
        undefined,
        makeCtx(agentDir)
    )

    const infos = controlService().list()
    const byId = new Map(infos.map(info => [info.id, info]))
    // Another session's meta, a meta without parentSessionId, and an unparsable
    // meta are all out of scope.
    assert.deepEqual([...byId.keys()].sort(), [CONTROL_ABORTED_ID, CONTROL_FOREIGN_ID].sort())

    const aborted = byId.get(CONTROL_ABORTED_ID)
    assert.ok(aborted)
    assert.equal(aborted.status, 'canceled')
    assert.equal(aborted.agent, 'worker')
    assert.equal(aborted.title, 'resume me')
    assert.equal(
        aborted.sessionFile,
        join(agentDir, 'subagents', `${CONTROL_ABORTED_ID}.jsonl`)
    )
    assert.equal(aborted.background, false)
    // Nothing live to abort or convert: capabilities come from the registry.
    assert.deepEqual(aborted.capabilities, [])

    const foreign = byId.get(CONTROL_FOREIGN_ID)
    assert.ok(foreign)
    assert.equal(foreign.status, 'running', 'a live pidfile in another process')
    assert.deepEqual(foreign.capabilities, [])

    // Running rows first, mirroring the manager's RUNNING section.
    assert.equal(infos[0].id, CONTROL_FOREIGN_ID)
})

test('control operations fail closed instead of throwing', async t => {
    tempAgentDir(t)
    await loadDispatch()
    const service = controlService()
    const unknownId = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2cff'

    const stop = await service.stop(unknownId)
    assert.equal(stop.ok, false)
    assert.equal(stop.id, unknownId)
    assert.match(stop.reason ?? '', /no running subagent with id/)

    const background = await service.background(unknownId)
    assert.equal(background.ok, false)
    assert.equal(background.id, unknownId)
    assert.match(background.reason ?? '', /no running subagent with id/)

    assert.deepEqual(service.list(), [], 'an empty store lists nothing')
})

test('a live foreground run advertises background and stop, and both drive it', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    useFakePi(t, agentDir, { waitForRelease: true })
    const { subagent } = await loadDispatch()
    const service = controlService()

    const pending = subagent.execute(
        'tool-call-control',
        { agent: 'worker', task: 'watch me', background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )

    const live = await waitFor(
        () => service.list().find(info => info.status === 'running'),
        'the live registry row'
    )
    assert.equal(live.background, false)
    assert.deepEqual([...live.capabilities].sort(), ['background', 'stop'])
    assert.equal(live.title, 'watch me')

    // Exact ids only: with one run live, an empty id or a unique suffix must not
    // resolve to it the way the human-facing commands do.
    const empty = await service.stop('')
    assert.equal(empty.ok, false)
    assert.match(empty.reason ?? '', /id is required/)
    const suffix = await service.stop(live.id.slice(-8))
    assert.equal(suffix.ok, false)
    assert.match(suffix.reason ?? '', /no running subagent with id/)
    const suffixBackground = await service.background(live.id.slice(-8))
    assert.equal(suffixBackground.ok, false)
    assert.equal(
        service.list().find(info => info.id === live.id)?.status,
        'running',
        'the refused calls left the run alone'
    )

    const converted = await service.background(live.id)
    assert.equal(converted.ok, true)
    assert.equal(converted.id, live.id)

    const after = service.list().find(info => info.id === live.id)
    assert.ok(after)
    assert.equal(after.background, true)
    // One-shot conversion: the manager's refusals apply unchanged.
    assert.deepEqual(after.capabilities, ['stop'])
    const again = await service.background(live.id)
    assert.equal(again.ok, false)
    assert.match(again.reason ?? '', /already backgrounded$/)

    // Conversion is what returns the awaiting tool call; the child keeps running.
    assert.match(textOf(await pending), /sent to the background by the user/)

    const stopped = await service.stop(live.id)
    assert.equal(stopped.ok, true)
    assert.equal(stopped.id, live.id)
    const settled = await waitFor(
        () => service.list().find(info => info.id === live.id && info.status === 'canceled'),
        'the aborted row'
    )
    assert.deepEqual(settled.capabilities, [])
    assert.equal(settled.background, false, 'not running any more')
})

test('a spawn-time background run is background with only stop', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const fake = useFakePi(t, agentDir, { waitForRelease: true })
    const { subagent } = await loadDispatch()
    const service = controlService()

    const result = await subagent.execute(
        'tool-call-background',
        { agent: 'worker', task: 'detached' },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const { asyncId } = result.details as { asyncId?: string }
    assert.ok(asyncId)

    const info = await waitFor(
        () => service.list().find(row => row.id === asyncId),
        'the background row'
    )
    assert.equal(info.status, 'running')
    assert.equal(info.background, true)
    assert.deepEqual(info.capabilities, ['stop'])

    const stopped = await service.stop(asyncId)
    assert.equal(stopped.ok, true)
    fake.release()
    await waitFor(
        () => service.list().find(row => row.id === asyncId && row.status === 'canceled'),
        'the stopped background row'
    )
})

test('stop replies running, never a terminal status it did not observe', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    useFakePi(t, agentDir, { waitForRelease: true })
    const { subagent } = await loadDispatch()
    const service = controlService()

    const pending = subagent.execute(
        'tool-call-stop-measure',
        { agent: 'worker', task: 'measure me', background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const live = await waitFor(
        () => service.list().find(info => info.status === 'running'),
        'the live registry row'
    )

    const stopped = await service.stop(live.id)
    assert.equal(stopped.ok, true)
    // The registry still holds the row while the reply is built — unregistration
    // runs on the child's 'close' — so the reply carries that measurement and not
    // the settlement it has not seen. Any terminal value here would be a guess:
    // the run may end as canceled, failed, or (racing an exit) completed.
    assert.equal(stopped.status, 'running')

    // The settlement arrives after the reply, which is exactly why the reply must
    // not pre-empt it.
    await pending
    await waitFor(
        () => service.list().find(info => info.id === live.id && info.status === 'canceled'),
        'the aborted row'
    )
})

test('session shutdown retires the control service instead of serving the dead session', async t => {
    const agentDir = tempAgentDir(t)
    seedControlStore(agentDir)
    const { module } = await loadDispatch()
    const handlers = initWithHandlers(module)
    const start = handlers.get('session_start')
    assert.ok(start, 'the extension registered a session_start handler')
    // session_start alone scopes the listing; no tool call is needed.
    start({ type: 'session_start' }, makeCtx(agentDir))
    const live = controlService()
    assert.equal(live.list().length, 2, 'the session-scoped rows are listed while it lives')

    const shutdown = handlers.get('session_shutdown')
    assert.ok(shutdown, 'the extension registered a session_shutdown handler')
    shutdown()

    // Replaced, not deleted: the symbol string is the published contract, so a
    // version-1 service answers instead of the adapter reporting the extension
    // as unloaded.
    const retired = controlService()
    assert.notEqual(retired, live)
    assert.equal(retired.version, 1)
    assert.deepEqual(retired.list(), [], 'no row of the dead session survives')

    const stopped = await retired.stop(CONTROL_ABORTED_ID)
    assert.equal(stopped.ok, false)
    assert.equal(stopped.id, CONTROL_ABORTED_ID)
    assert.match(stopped.reason ?? '', /session is shut down/)

    const background = await retired.background(CONTROL_FOREIGN_ID)
    assert.equal(background.ok, false)
    assert.match(background.reason ?? '', /session is shut down/)

    // The replacement session lists its own rows as soon as it starts.
    const next = initWithHandlers(module)
    assert.deepEqual(controlService().list(), [], 'no session captured before session_start')
    next.get('session_start')?.({ type: 'session_start' }, makeCtx(agentDir))
    assert.equal(controlService().list().length, 2)
})

test("an older session shutdown does not retire a newer init's service", async t => {
    tempAgentDir(t)
    const { module } = await loadDispatch()
    const older = initWithHandlers(module)
    initWithHandlers(module)
    const newer = controlService()

    older.get('session_shutdown')?.()
    assert.equal(controlService(), newer, 'the newer registration survives')
})

test('a successful run lists as completed after it exits', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    useFakePi(t, agentDir)
    const { subagent } = await loadDispatch()
    const service = controlService()

    const result = await subagent.execute(
        'tool-call-control-success',
        { agent: 'worker', task: 'finish me', background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    assert.notEqual(result.isError, true)
    // Outcomes are scoped to this test's store, so the title identifies the run.
    const rows = service.list().filter(info => info.title === 'finish me')
    assert.equal(rows.length, 1)
    const [row] = rows
    assert.ok(row, 'the success is still listed although its meta is gone')
    assert.equal(row.status, 'completed')
    assert.deepEqual(row.capabilities, [])
    assert.equal(row.agent, 'worker')
})

test('a resume clears the previous outcome while the run is live again', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const fake = useFakePi(t, agentDir, { waitForRelease: true })
    const { subagent } = await loadDispatch()
    const service = controlService()

    const spawned = await subagent.execute(
        'tool-call-resume-outcome',
        { agent: 'worker', task: 'first pass' },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const { asyncId } = spawned.details as { asyncId?: string }
    assert.ok(asyncId)
    fake.release()
    await waitFor(
        () => service.list().find(row => row.id === asyncId && row.status === 'completed'),
        'the completed first run'
    )

    fake.rearm()
    const pending = subagent.execute(
        'tool-call-resume-outcome-2',
        { agent: 'worker', task: 'second pass', resume: asyncId, background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const live = await waitFor(
        () => service.list().find(row => row.id === asyncId && row.status === 'running'),
        'the resumed run listed as running, not as its old outcome'
    )
    assert.ok(live.capabilities.includes('stop'))
    fake.release()
    assert.notEqual((await pending).isError, true)
})

test('a settled run that has not exited lists as running with no capabilities', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    const fake = useFakePi(t, agentDir, { holdAfterSettle: true })
    const { subagent } = await loadDispatch()
    const service = controlService()

    const result = await subagent.execute(
        'tool-call-settled-hold',
        { agent: 'worker', task: 'settle then linger' },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const { asyncId } = result.details as { asyncId?: string }
    assert.ok(asyncId)
    const settled = await waitFor(
        () => service.list().find(row => row.id === asyncId && row.capabilities.length === 0),
        'the settled row'
    )
    assert.equal(settled.status, 'running', 'no outcome until the process exits')
    const stop = await service.stop(asyncId)
    assert.equal(stop.ok, false, 'a settled run is not operable')

    fake.releaseExit()
    await waitFor(
        () => service.list().find(row => row.id === asyncId && row.status === 'completed'),
        'the outcome once the process exits'
    )
})

test('outcomes survive a reload of the same session and go with a different one', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    useFakePi(t, agentDir)
    const { module, subagent } = await loadDispatch()
    await subagent.execute(
        'tool-call-reload-outcome',
        { agent: 'worker', task: 'before reload', background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const completed = () =>
        controlService()
            .list()
            .filter(row => row.title === 'before reload' && row.status === 'completed')
    assert.equal(completed().length, 1)

    // /reload: shutdown, a fresh init, and session_start with the same session id.
    const reloaded = initWithHandlers(module)
    reloaded.get('session_start')?.({ type: 'session_start' }, makeCtx(agentDir))
    assert.equal(
        completed().length,
        1,
        'a foreground success has no meta; the outcome is its record'
    )

    const switched = initWithHandlers(module)
    switched.get('session_start')?.(
        { type: 'session_start' },
        {
            ...(makeCtx(agentDir) as Record<string, unknown>),
            sessionManager: { getSessionId: () => 'other-session' },
        }
    )
    switched.get('session_start')?.({ type: 'session_start' }, makeCtx(agentDir))
    assert.equal(completed().length, 0, 'switching sessions pruned the outcome')
})

test('deleting a persisted run drops its recorded outcome', async t => {
    const agentDir = tempAgentDir(t)
    seedAgent(agentDir)
    useFakePi(t, agentDir, { exitCode: 1 })
    const { module, subagent } = await loadDispatch()
    const result = await subagent.execute(
        'tool-call-delete-outcome',
        { agent: 'worker', task: 'fail then delete', background: false },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const { results } = result.details as { results: Array<{ subagentId: string }> }
    const id = results[0].subagentId
    assert.equal(
        controlService()
            .list()
            .find(row => row.id === id)?.status,
        'failed'
    )

    assert.equal(module.deletePersistedRunArtifacts(id), undefined)
    assert.equal(
        controlService()
            .list()
            .find(row => row.id === id),
        undefined,
        'no row for a run whose files are gone'
    )
})

test('a changed meta is re-read between polls', async t => {
    const agentDir = tempAgentDir(t)
    const dir = join(agentDir, 'subagents')
    mkdirSync(dir, { recursive: true })
    const metaPath = join(dir, `${CONTROL_ABORTED_ID}.meta`)
    const meta = {
        agent: 'worker',
        task: 'changing',
        startedAt: new Date().toISOString(),
        promptHash: PROMPT_HASH,
        parentSessionId: 'test-session',
    }
    writeFileSync(metaPath, JSON.stringify(meta))
    const { subagent } = await loadDispatch()
    await subagent.execute(
        'capture-session',
        { agent: 'ghost', task: 'noop' },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const status = () =>
        controlService()
            .list()
            .find(row => row.id === CONTROL_ABORTED_ID)?.status
    assert.equal(status(), 'canceled', 'no outcome recorded yet')

    writeFileSync(metaPath, JSON.stringify({ ...meta, status: 'failed' }))
    assert.equal(status(), 'failed')
})

test('a disk row is background only while a live owner runs it from a run directory', async t => {
    const agentDir = tempAgentDir(t)
    const dir = seedControlStore(agentDir)
    const { subagent } = await loadDispatch()
    await subagent.execute(
        'capture-session',
        { agent: 'ghost', task: 'noop' },
        undefined,
        undefined,
        makeCtx(agentDir)
    )
    const foreign = () =>
        controlService()
            .list()
            .find(row => row.id === CONTROL_FOREIGN_ID)
    assert.equal(foreign()?.background, false, 'live, but no run directory')

    mkdirSync(join(dir, `${CONTROL_FOREIGN_ID}${ASYNC_DIR_SUFFIX}`))
    assert.equal(foreign()?.background, true)

    // A run directory without a live owner is a finished run, not a background one.
    mkdirSync(join(dir, `${CONTROL_ABORTED_ID}${ASYNC_DIR_SUFFIX}`))
    assert.equal(
        controlService()
            .list()
            .find(row => row.id === CONTROL_ABORTED_ID)?.background,
        false
    )
})

test('list never deletes a stale pidfile; the retention sweep owns that cleanup', async t => {
    const agentDir = tempAgentDir(t)
    const dir = seedControlStore(agentDir)
    // A crashed parent's leftover: the pid names no process (macOS caps pids at 99999).
    const stalePid = join(dir, `${CONTROL_ABORTED_ID}.pid`)
    writeFileSync(stalePid, '999999\n')
    const { subagent } = await loadDispatch()
    await subagent.execute(
        'capture-session',
        { agent: 'ghost', task: 'noop' },
        undefined,
        undefined,
        makeCtx(agentDir)
    )

    const aborted = controlService()
        .list()
        .find(info => info.id === CONTROL_ABORTED_ID)
    assert.equal(aborted?.status, 'canceled', 'the dead pid does not make the run live')
    assert.ok(existsSync(stalePid), 'a read path must not delete')

    // The sweep is where stale pidfiles go.
    sweepExpiredAsyncDirs(dir, { isProcessAlive: () => false })
    assert.equal(existsSync(stalePid), false)
})
