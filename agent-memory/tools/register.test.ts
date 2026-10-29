import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import type { GateContext } from '../gate/gate.ts'
import { buildIndexBlock } from '../inject/index-block.ts'
import agentMemoryExtension from '../index.ts'
import { openStore, type Store } from '../store/store.ts'
import { MEMORY_TOOL_NAMES, registerMemoryTools } from './register.ts'

const SECRET_KEY = 'secrets/api_token'
const SECRET_TOKEN = 'SWORDFISH-9f3c'
const SECRET_BODY = `${SECRET_TOKEN} is rotated every 90 days by hand.`

// ---------------------------------------------------------------------------
// host doubles
// ---------------------------------------------------------------------------

interface RegisteredTool {
    name: string
    label: string
    description: string
    parameters: unknown
    executionMode?: string
    execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext
    ): Promise<{
        content: { type: string; text: string }[]
        details?: unknown
        isError?: boolean
    }>
}

interface FakePi {
    api: ExtensionAPI
    tools: Map<string, RegisteredTool>
    handlers: Map<string, (event: unknown, ctx: unknown) => unknown>
    emit(event: string, payload?: unknown, ctx?: unknown): Promise<void>
}

function fakePi(): FakePi {
    const tools = new Map<string, RegisteredTool>()
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const api = {
        registerTool(tool: RegisteredTool) {
            tools.set(tool.name, tool)
        },
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
            handlers.set(event, handler)
        },
        registerCommand() {},
        registerShortcut() {},
        registerFlag() {},
        getFlag() {
            return undefined
        },
        events: { emit() {}, on: () => () => {} },
        getSessionName() {
            return undefined
        },
    }
    return {
        api: api as unknown as ExtensionAPI,
        tools,
        handlers,
        async emit(event, payload, ctx) {
            const handler = handlers.get(event)
            assert.ok(handler !== undefined, `no handler registered for ${event}`)
            await handler(payload, ctx)
        },
    }
}

function tempDir(t: TestContext, prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

function useStoreDir(t: TestContext): string {
    const dir = tempDir(t, 'pi-memory-register-')
    const saved = process.env.PI_MEMORY_DIR
    process.env.PI_MEMORY_DIR = dir
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_DIR
        else process.env.PI_MEMORY_DIR = saved
    })
    return dir
}

function ensureNotSubagent(t: TestContext): void {
    const saved = process.env.PI_MEMORY_SUBAGENT
    delete process.env.PI_MEMORY_SUBAGENT
    t.after(() => {
        if (saved !== undefined) process.env.PI_MEMORY_SUBAGENT = saved
    })
}

/** The slice of pi's context the tools and the gate entry point actually read. */
function toolContext(
    cwd: string,
    options: {
        hasUI?: boolean
        confirm?: boolean
        notify?: (message: string, severity?: string) => void
    } = {}
): ExtensionContext {
    return {
        cwd,
        mode: options.hasUI === true ? 'tui' : 'print',
        hasUI: options.hasUI === true,
        sessionManager: {
            getBranch: () => [],
            getSessionId: () => 'sess-register',
        },
        ui: {
            async confirm() {
                return options.confirm === true
            },
            async custom() {
                return undefined
            },
            async input() {
                return undefined
            },
            notify(message: string, severity?: string) {
                options.notify?.(message, severity)
            },
            setStatus() {},
        },
    } as unknown as ExtensionContext
}

function storeGate(answer: boolean): GateContext {
    return {
        hasUI: true,
        sessionId: 'sess-register',
        ui: {
            async confirm() {
                return answer
            },
        },
    }
}

function openSeedStore(t: TestContext): Store {
    const store = openStore(tempDir(t, 'pi-memory-cwd-'), { gate: storeGate(true) })
    t.after(() => store.close())
    return store
}

async function call(
    pi: FakePi,
    name: string,
    params: Record<string, unknown>,
    ctx: ExtensionContext
): ReturnType<RegisteredTool['execute']> {
    const tool = pi.tools.get(name)
    assert.ok(tool !== undefined, `tool ${name} was not registered`)
    return tool.execute('call-1', params, undefined, undefined, ctx)
}

// ---------------------------------------------------------------------------
// registerMemoryTools
// ---------------------------------------------------------------------------

test('registerMemoryTools registers the six §5 tools with object schemas', t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeedStore(t)
    const pi = fakePi()

    registerMemoryTools(pi.api, store)

    assert.deepEqual([...pi.tools.keys()].sort(), [...MEMORY_TOOL_NAMES].sort())
    for (const tool of pi.tools.values()) {
        assert.equal(typeof tool.parameters, 'object', `${tool.name} has no parameter schema`)
        assert.ok(tool.label.length > 0)
        assert.ok(tool.description.length > 0)
    }
    // Reads may run together; mutations must not race on the repo lock.
    assert.equal(pi.tools.get('memory_index')?.executionMode, 'parallel')
    assert.equal(pi.tools.get('memory_read')?.executionMode, 'parallel')
    assert.equal(pi.tools.get('memory_write')?.executionMode, 'sequential')
    assert.equal(pi.tools.get('memory_edit')?.executionMode, 'sequential')
    assert.equal(pi.tools.get('memory_delete')?.executionMode, 'sequential')
})

test('a registered tool returns text content, not a thrown error', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeedStore(t)
    const pi = fakePi()
    registerMemoryTools(pi.api, store)
    const ctx = toolContext(tempDir(t, 'pi-memory-ctx-'))

    const written = await call(
        pi,
        'memory_write',
        { key: 'notes/page', body: 'first line' },
        ctx
    )
    assert.equal(written.isError, undefined)
    assert.equal(written.content[0].type, 'text')
    assert.match(written.content[0].text, /wrote notes\/page/)

    const read = await call(pi, 'memory_read', { key: 'notes/page' }, ctx)
    assert.equal(read.content[0].text, 'first line')

    const missing = await call(pi, 'memory_read', { key: 'notes/absent' }, ctx)
    assert.equal(missing.isError, true)
    assert.match(missing.content[0].text, /not found/)
})

test('the per-call context supplies hasUI, so a print session fails a gated read closed', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openSeedStore(t)
    await store.writeNote({
        key: SECRET_KEY,
        body: SECRET_BODY,
        access: 'gated',
        reason: 'seeding the fixture',
    })
    const pi = fakePi()
    registerMemoryTools(pi.api, store)

    const result = await call(
        pi,
        'memory_read',
        { key: SECRET_KEY, reason: 'checking rotation policy' },
        toolContext(tempDir(t, 'pi-memory-ctx-'), { hasUI: false })
    )

    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /no UI available to confirm/)
    assert.ok(!result.content[0].text.includes(SECRET_TOKEN))
    assert.match(fs.readFileSync(path.join(root, 'access.log'), 'utf8'), /denied-no-ui/)
})

// ---------------------------------------------------------------------------
// the extension entry point
// ---------------------------------------------------------------------------

test('the entry point registers six tools on session_start and caches the index block', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    // The store must exist before the session starts: `session_start` opens, sweeps and
    // reindexes; it does not invent notes.
    const seeded = openSeedStore(t)
    await seeded.writeNote({ key: 'auth/session', body: 'Tokens are refreshed on request.' })
    await seeded.writeNote({
        key: SECRET_KEY,
        body: SECRET_BODY,
        access: 'gated',
        reason: 'seeding the fixture',
    })
    seeded.close()

    const pi = fakePi()
    const handle = agentMemoryExtension(pi.api)
    assert.equal(handle.indexBlock(), '')

    await pi.emit(
        'session_start',
        { reason: 'startup' },
        toolContext(tempDir(t, 'pi-memory-ctx-'))
    )

    assert.deepEqual([...pi.tools.keys()].sort(), [...MEMORY_TOOL_NAMES].sort())
    const block = handle.indexBlock()
    assert.match(block, /^scope: global$/m)
    assert.match(block, /auth\/session/)
    assert.match(block, /^gated: 1 hidden \(ask for one by name\)$/m)
    assert.ok(!block.includes(SECRET_KEY), 'the injected block named a gated key')
    assert.ok(!block.includes(SECRET_TOKEN))

    await pi.emit('session_shutdown', { reason: 'quit' })
    assert.equal(handle.indexBlock(), '')
    assert.equal(handle.store(), undefined)
})

test('the entry point logs one warning and registers nothing when the store cannot open', async t => {
    ensureNotSubagent(t)
    const dir = tempDir(t, 'pi-memory-broken-')
    const notADirectory = path.join(dir, 'store')
    // A regular file where the store root must be: mkdirSync(recursive) fails with EEXIST.
    fs.writeFileSync(notADirectory, 'not a directory')
    const saved = process.env.PI_MEMORY_DIR
    process.env.PI_MEMORY_DIR = notADirectory
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_DIR
        else process.env.PI_MEMORY_DIR = saved
    })

    const warnings: string[] = []
    const savedWarn = console.warn
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(arg => String(arg)).join(' '))
    }
    t.after(() => {
        console.warn = savedWarn
    })

    const pi = fakePi()
    const handle = agentMemoryExtension(pi.api)
    await pi.emit(
        'session_start',
        { reason: 'startup' },
        toolContext(tempDir(t, 'pi-memory-ctx-'))
    )

    assert.equal(pi.tools.size, 0, 'tools were registered without a store')
    assert.equal(handle.store(), undefined)
    assert.equal(handle.indexBlock(), '')
    assert.equal(warnings.length, 1, warnings.join('\n'))
    assert.match(warnings[0], /^agent-memory: memory store unavailable/)

    // A second session start must not repeat the warning.
    await pi.emit(
        'session_start',
        { reason: 'startup' },
        toolContext(tempDir(t, 'pi-memory-ctx-'))
    )
    assert.equal(warnings.length, 1)
})

test('session_start names a note it could not index through the UI (F1)', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const seeded = openSeedStore(t)
    await seeded.writeNote({ key: 'notes/good', body: 'kept' })
    seeded.close()
    // A hand edit the parser refuses: `access: someday` is not a value §2.1 accepts, so
    // the note must be skipped — and the file has to be named somewhere the user sees.
    fs.writeFileSync(
        path.join(root, 'global', 'notes', 'broken.md'),
        '---\naccess: someday\n---\nsecret\n'
    )

    const notices: Array<{ message: string; severity?: string }> = []
    const pi = fakePi()
    const handle = agentMemoryExtension(pi.api)
    await pi.emit(
        'session_start',
        { reason: 'startup' },
        toolContext(tempDir(t, 'pi-memory-ctx-'), {
            notify: (message, severity) => notices.push({ message, severity }),
        })
    )
    t.after(async () => {
        await pi.emit('session_shutdown', { reason: 'quit' })
    })

    // The pass completed: the good note is indexed and the tools are registered.
    assert.deepEqual([...pi.tools.keys()].sort(), [...MEMORY_TOOL_NAMES].sort())
    assert.match(handle.indexBlock(), /notes\/good/)
    assert.equal(notices.length, 1, notices.map(entry => entry.message).join('\n'))
    assert.equal(notices[0].severity, 'warning')
    assert.match(notices[0].message, /1 note\(s\) not indexed/)
    assert.match(notices[0].message, /global\/notes\/broken\.md/)
    assert.match(notices[0].message, /unparseable frontmatter access value/)
})

test('session_start with reason reload skips the sweep and rotation', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const seeded = openSeedStore(t)
    await seeded.writeNote({ key: 'notes/page', body: 'body' })
    seeded.close()

    const pi = fakePi()
    agentMemoryExtension(pi.api)
    await pi.emit(
        'session_start',
        { reason: 'reload' },
        toolContext(tempDir(t, 'pi-memory-ctx-'))
    )

    assert.deepEqual([...pi.tools.keys()].sort(), [...MEMORY_TOOL_NAMES].sort())
    await pi.emit('session_shutdown', { reason: 'reload' })
})

// ---------------------------------------------------------------------------
// §6.1 block
// ---------------------------------------------------------------------------

test('buildIndexBlock caps the key list and keeps the newest notes', t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openSeedStore(t)
    // Written as files and reindexed rather than through `writeNote`: 205 notes through
    // the write path is 205 git commits, and this test is about the cap, not the commit.
    const base = Date.now() - 1_000_000
    fs.mkdirSync(path.join(root, 'global', 'bulk'), { recursive: true })
    for (let index = 0; index < 205; index++) {
        const file = path.join(
            root,
            'global',
            'bulk',
            `note_${String(index).padStart(3, '0')}.md`
        )
        fs.writeFileSync(file, `body ${index}`)
        const stamp = new Date(base + index * 1000)
        fs.utimesSync(file, stamp, stamp)
    }
    const reindexed = store.reindex()
    assert.equal(reindexed.updated, 205)

    const block = buildIndexBlock({ store, cwd: tempDir(t, 'pi-memory-ctx-') })
    const keysLine = block.split('\n')[1]

    assert.equal(keysLine.split(', ').length, 201, 'more or fewer than 200 keys were emitted')
    assert.match(keysLine, /\+5 more \(recent first\)$/)
    // mtime DESC: the last note written is in the block, the first is not.
    assert.ok(keysLine.includes('bulk/note_204'))
    assert.ok(!keysLine.includes('bulk/note_000'))
    assert.ok(block.length <= 4800 + 64, `block is ${block.length} chars`)
})

test('buildIndexBlock caps the rendered length of long keys', t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openSeedStore(t)
    // Three long segments: one 1.2 KB filename would exceed NAME_MAX (255 bytes).
    const filler = 'a'.repeat(240)
    const dir = path.join(root, 'global', 'long', filler, filler)
    fs.mkdirSync(dir, { recursive: true })
    for (let index = 0; index < 7; index++) {
        fs.writeFileSync(path.join(dir, `${filler}_${index}.md`), 'body')
    }
    assert.equal(store.reindex().updated, 7)

    const block = buildIndexBlock({ store, cwd: tempDir(t, 'pi-memory-ctx-') })

    assert.ok(block.length <= 4800 + 64, `block is ${block.length} chars`)
    assert.match(block, /\+\d+ more \(recent first\)/)
})

test('buildIndexBlock is empty for an empty store', t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openSeedStore(t)
    assert.equal(buildIndexBlock({ store, cwd: tempDir(t, 'pi-memory-ctx-') }), '')
})
