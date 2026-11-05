import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

// The extension's entry module imports the host packages that pi provides at
// runtime, so the test has to substitute them: everything here is only reached
// by renderers and the persisted-run store, neither of which a dispatch miss
// touches. `getAgentDir` follows the host's PI_CODING_AGENT_DIR override so the
// subagents dir can be pointed at a temp dir.
const HOST_STUB = `
export const CONFIG_DIR_NAME = '.pi'
export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR ?? '/nonexistent-pi-agent-dir'
export const getMarkdownTheme = () => ({})
export const parseFrontmatter = () => ({ frontmatter: {}, body: '' })
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
}

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

type Dispatch = { module: SubagentModule; subagent: Tool }

let dispatch: Promise<Dispatch> | undefined

/** pi registers the tool from the factory, so the module is loaded once per process. */
function loadDispatch(): Promise<Dispatch> {
    dispatch ??= (async () => {
        const module = (await import('./index.ts')) as unknown as SubagentModule
        const tools = new Map<string, Tool>()
        module.default({
            registerTool: (tool: Tool) => tools.set(tool.name, tool),
            registerCommand: () => {},
            registerShortcut: () => {},
            registerEntryRenderer: () => {},
            registerMarkdownTheme: () => {},
            registerToolRenderer: () => {},
            on: () => {},
            appendEntry: () => {},
        })
        const subagent = tools.get('subagent')
        assert.ok(subagent, 'the subagent tool was registered')
        return { module, subagent }
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

test('an unresolvable resume id is content, not a failed call', async t => {
    const result = await execute(t, { agent: 'worker', task: 'continue', resume: '6d' })

    assert.equal(result.isError, undefined, 'the call did not fail')
    const text = textOf(result)
    assert.ok(text.startsWith('FAILED: '), text)
    assert.match(text, /No subagent found with id "6d"/)
    assert.match(text, /re-dispatch with subagent \{agent, task\} instead of resuming/)
    // A single line: the persisted-run listing stays in /subagents for humans.
    assert.equal(text.includes('\n'), false, text)
    assert.deepEqual(result.details?.results, [])
})

test('an unknown agent in a background dispatch is content, not a failed call', async t => {
    const result = await execute(t, { agent: 'ghost', task: 'do it' })

    assert.equal(result.isError, undefined)
    const text = textOf(result)
    assert.ok(text.startsWith('FAILED: '), text)
    assert.match(text, /^FAILED: agent "ghost" did not start: Unknown agent: "ghost"/)
})

test('an unknown agent in a foreground dispatch is content, not a failed call', async t => {
    const result = await execute(t, { agent: 'ghost', task: 'do it', background: false })

    assert.equal(result.isError, undefined)
    assert.match(
        textOf(result),
        /^FAILED: agent "ghost" did not start: Unknown agent: "ghost"/
    )
})

test('a chain step that never spawned is content, not a failed call', async t => {
    const result = await execute(t, { chain: [{ agent: 'ghost', task: 'do it' }] })

    assert.equal(result.isError, undefined)
    assert.match(
        textOf(result),
        /^FAILED: step 1 \(ghost\) did not start: Unknown agent: "ghost"/
    )
})

test('request validation misses are content, not failed calls', async t => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{}, /^FAILED: provide exactly one mode/],
        [
            { agent: 'worker', task: 'do it', model: '  ' },
            /^FAILED: model must be a non-empty/,
        ],
        [
            { chain: [{ agent: 'worker', task: 'do it' }], model: 'p/m' },
            /^FAILED: model is single-mode only/,
        ],
        [
            { chain: [{ agent: 'worker', task: 'do it' }], resume: '6d' },
            /^FAILED: "resume" is single-mode only/,
        ],
    ]
    for (const [params, expected] of cases) {
        const result = await execute(t, params)
        assert.equal(result.isError, undefined, JSON.stringify(params))
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
