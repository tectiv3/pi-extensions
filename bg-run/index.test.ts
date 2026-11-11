import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { afterEach, test } from 'node:test'
import type { BgRunControlService } from './index.ts'

// pi provides typebox at runtime; the tools' schemas are not under test.
const HOST_STUB = 'export const Type = new Proxy({}, { get: () => () => ({}) })'

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'typebox') {
            return {
                url: `data:text/javascript,${encodeURIComponent(HOST_STUB)}`,
                shortCircuit: true,
            }
        }
        return nextResolve(specifier, context)
    },
})

// Loaded after the hook is in place; a static import would resolve typebox first.
const loadExtension = () => import('./index.ts')
const BG_RUN_CONTROL_KEY = Symbol.for('pi-extensions:bg-run:control')

interface RegisteredTool {
    name: string
    execute(id: string, params: Record<string, any>): Promise<{ content: Array<{ text: string }> }>
}

async function createPi() {
    // Node resolves this module as ESM; tsc, under CommonJS, types the default one level deeper.
    const bgRun = (await loadExtension()).default as unknown as (pi: never) => void
    const tools = new Map<string, RegisteredTool>()
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const sent: string[] = []
    const pi = {
        registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
        registerCommand: () => undefined,
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
            handlers.set(event, handler),
        sendUserMessage: (text: string) => sent.push(text),
    }
    bgRun(pi as never)
    const service = (globalThis as Record<symbol, unknown>)[
        BG_RUN_CONTROL_KEY
    ] as BgRunControlService
    return {
        tools,
        sent,
        service,
        start: () => handlers.get('session_start')?.({}, {}),
        shutdown: () => handlers.get('session_shutdown')?.({}, {}),
        run: (command: string, label?: string) =>
            tools.get('bg_run')!.execute('call', { command, label }),
    }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

const sessions: Array<Awaited<ReturnType<typeof createPi>>> = []
afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.shutdown()))
    delete (globalThis as Record<symbol, unknown>)[BG_RUN_CONTROL_KEY]
})

async function session() {
    const created = await createPi()
    sessions.push(created)
    return created
}

test('the service lists this session’s jobs and notifies subscribers', async () => {
    const pi = await session()
    assert.deepEqual(pi.service.list(), [])
    await pi.start()
    let changes = 0
    const unsubscribe = pi.service.subscribe(() => {
        changes += 1
    })
    await pi.run('sleep 60', 'napper')

    const [job] = pi.service.list()
    assert.equal(job.id, 'bg_1')
    assert.equal(job.label, 'napper')
    assert.equal(job.command, 'sleep 60')
    assert.equal(job.status, 'running')
    assert.deepEqual(job.capabilities, ['stop'])
    assert.equal(changes, 1)

    const stopped = await pi.service.stop('bg_1')
    assert.deepEqual(stopped, { ok: true, id: 'bg_1', status: 'killed' })
    assert.equal(pi.service.list()[0].capabilities.length, 0)
    unsubscribe()
    assert.equal(changes, 2)
})

test('a throwing subscriber does not break job bookkeeping', async () => {
    const pi = await session()
    await pi.start()
    pi.service.subscribe(() => {
        throw new Error('bad subscriber')
    })
    await pi.run('true')
    await until(() => pi.service.list()[0]?.status === 'completed')
})

test('jobs that finish together wake the agent once; killed jobs do not wake it', async () => {
    const pi = await session()
    await pi.start()
    await pi.run('true', 'one')
    await pi.run('exit 2', 'two')
    await pi.run('sleep 60', 'victim')
    await until(() => pi.sent.length === 1)
    assert.match(pi.sent[0], /2 background jobs finished/)
    assert.match(pi.sent[0], /one/)
    assert.match(pi.sent[0], /exit 2/)

    await pi.service.stop('bg_3')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(pi.sent.length, 1)
})

test('after session_shutdown the jobs are stopped, the list is empty and stop is refused', async () => {
    const pi = await session()
    await pi.start()
    await pi.run('sleep 60')
    await pi.shutdown()
    assert.deepEqual(pi.service.list(), [])
    const refused = await pi.service.stop('bg_1')
    assert.equal(refused.ok, false)
    assert.equal(pi.sent.length, 0)
})

test('a new session starts with fresh ids and no inherited jobs', async () => {
    const pi = await session()
    await pi.start()
    await pi.run('sleep 60')
    await pi.shutdown()
    await pi.start()
    assert.deepEqual(pi.service.list(), [])
    const started = await pi.run('true')
    assert.match(started.content[0].text, /bg_1/)
})

test('re-running the extension factory does not add exit listeners', async () => {
    const before = process.listenerCount('exit')
    await session()
    const after = process.listenerCount('exit')
    await session()
    await session()
    assert.equal(process.listenerCount('exit'), after)
    assert.ok(after - before <= 1)
})

test('bg_kill reports an unknown job as an error', async () => {
    const pi = await session()
    await pi.start()
    await assert.rejects(pi.tools.get('bg_kill')!.execute('call', { job_id: 'bg_9' }), /not found/)
})
