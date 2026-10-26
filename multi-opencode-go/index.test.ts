import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import multiOpencodeGo, {
    getLogFilePath,
    loadFailoverAccount,
    loadFailoverOn,
    resolveAuthValue,
    saveFailoverOn,
} from './index.ts'

type Notices = Array<[string, string]>

function makeAgentDir(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), 'multi-opencode-go-'))
    const original = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = dir
    t.after(() => {
        if (original === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = original
        rmSync(dir, { recursive: true, force: true })
    })
    return dir
}

function writeAuth(dir: string, auth: unknown): void {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth))
}

function makeCtx(
    notices: Notices,
    model?: { provider: string },
    statuses: Map<string, string | undefined> = new Map(),
    overrides: { mode?: string; hasUI?: boolean } = {}
): ExtensionCommandContext {
    return {
        model,
        hasUI: overrides.hasUI ?? true,
        mode: overrides.mode ?? 'interactive',
        ui: {
            notify: (message: string, severity: string) => notices.push([message, severity]),
            setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
        },
    } as unknown as ExtensionCommandContext
}

interface FakePi {
    api: ExtensionAPI
    handlers: Map<string, (event: any, ctx: any) => unknown>
    commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>
    notices: Notices
}

function makePi(): FakePi {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>()
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>()
    const notices: Notices = []
    const api = {
        on(event: string, handler: (event: any, ctx: any) => unknown) {
            handlers.set(event, handler)
        },
        registerCommand(
            name: string,
            opts: { handler: (args: string, ctx: any) => Promise<void> }
        ) {
            commands.set(name, opts)
        },
    } as unknown as ExtensionAPI
    return { api, handlers, commands, notices }
}

function start(pi: FakePi, ctx?: ExtensionCommandContext): void {
    pi.handlers.get('session_start')?.({}, ctx ?? makeCtx(pi.notices))
}

function fireHeaders(pi: FakePi, headers: Record<string, string>, provider: string): void {
    pi.handlers.get('before_provider_headers')?.(
        { headers },
        makeCtx(pi.notices, { provider })
    )
}

test('resolveAuthValue resolves whole-string env refs, escapes, and literals', () => {
    process.env.MOG_TEST_KEY = 'sk-env'
    try {
        assert.equal(resolveAuthValue('$MOG_TEST_KEY'), 'sk-env')
        assert.equal(resolveAuthValue('$MOG_TEST_MISSING'), undefined)
        assert.equal(resolveAuthValue('$$literal'), '$literal')
        assert.equal(resolveAuthValue('plain-key'), 'plain-key')
    } finally {
        delete process.env.MOG_TEST_KEY
    }
})

test('resolveAuthValue rejects commands, templates, malformed refs, and empties', () => {
    process.env.MOG_TEST_EMPTY = ''
    process.env.MOG_TEST_VAR = 'sk-var'
    try {
        assert.equal(resolveAuthValue('!echo hi'), undefined)
        assert.equal(resolveAuthValue('${MOG_TEST_VAR}'), undefined)
        assert.equal(resolveAuthValue('prefix$MOG_TEST_VAR'), undefined)
        assert.equal(resolveAuthValue('$'), undefined)
        assert.equal(resolveAuthValue('$1BAD'), undefined)
        assert.equal(resolveAuthValue('$MOG_TEST_EMPTY'), undefined)
        assert.equal(resolveAuthValue(''), undefined)
        assert.equal(resolveAuthValue(42), undefined)
        assert.equal(resolveAuthValue(undefined), undefined)
    } finally {
        delete process.env.MOG_TEST_EMPTY
        delete process.env.MOG_TEST_VAR
    }
})

test('loadFailoverAccount reads a valid single-account block', t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go-failover': { label: 'second', key: 'sk-second' } })

    assert.deepEqual(loadFailoverAccount(), { label: 'second', key: 'sk-second' })
})

test('loadFailoverAccount defaults the label and resolves $ENV keys', t => {
    const dir = makeAgentDir(t)
    process.env.MOG_TEST_KEY = 'sk-indirect'
    try {
        writeAuth(dir, { 'opencode-go-failover': { key: '$MOG_TEST_KEY' } })
        assert.deepEqual(loadFailoverAccount(), { label: 'failover', key: 'sk-indirect' })
    } finally {
        delete process.env.MOG_TEST_KEY
    }
})

test('loadFailoverAccount returns null for absent, missing-key, and malformed blocks', t => {
    const dir = makeAgentDir(t)

    writeAuth(dir, { 'opencode-go': { key: 'sk-primary' } })
    assert.equal(loadFailoverAccount(), null)

    writeAuth(dir, { 'opencode-go-failover': { label: 'x' } })
    assert.equal(loadFailoverAccount(), null)

    writeAuth(dir, { 'opencode-go-failover': { label: 'x', key: '${NOT_WHOLE}' } })
    assert.equal(loadFailoverAccount(), null)
    assert.match(readFileSync(getLogFilePath(), 'utf8'), /failover key rejected/)

    writeAuth(dir, { 'opencode-go-failover': 'sk-string' })
    assert.equal(loadFailoverAccount(), null)

    writeAuth(dir, { 'opencode-go-failover': [{ label: 'a', key: 'sk-a' }] })
    assert.equal(loadFailoverAccount(), null)
})

test('loadFailoverAccount returns null when auth.json is absent or invalid', t => {
    makeAgentDir(t)
    assert.equal(loadFailoverAccount(), null)

    writeFileSync(join(process.env.PI_CODING_AGENT_DIR as string, 'auth.json'), 'not json')
    assert.equal(loadFailoverAccount(), null)
})

test('failover state persists, and missing or corrupt state reads as off', t => {
    const dir = makeAgentDir(t)

    assert.equal(loadFailoverOn(), false)

    saveFailoverOn(true)
    assert.equal(loadFailoverOn(), true)
    saveFailoverOn(false)
    assert.equal(loadFailoverOn(), false)

    writeFileSync(join(dir, 'opencode-go-active.json'), 'garbage')
    assert.equal(loadFailoverOn(), false)
})

test('session_start loads the account and restores the persisted boolean', t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go-failover': { label: 'second', key: 'sk-second' } })
    saveFailoverOn(true)

    const pi = makePi()
    multiOpencodeGo(pi.api)
    start(pi)

    const headers: Record<string, string> = {}
    fireHeaders(pi, headers, 'opencode-go')
    assert.equal(headers.Authorization, 'Bearer sk-second')
    assert.equal(headers['x-api-key'], 'sk-second')
})

test('before_provider_headers leaves headers untouched when off or off-provider', t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go-failover': { label: 'second', key: 'sk-second' } })

    const pi = makePi()
    multiOpencodeGo(pi.api)
    start(pi)

    const off = { Authorization: 'Bearer primary', 'x-api-key': 'primary' }
    fireHeaders(pi, off, 'opencode-go')
    assert.deepEqual(off, { Authorization: 'Bearer primary', 'x-api-key': 'primary' })

    saveFailoverOn(true)
    start(pi)

    const other = { Authorization: 'Bearer primary' }
    fireHeaders(pi, other, 'some-other-provider')
    assert.deepEqual(other, { Authorization: 'Bearer primary' })
})

test('/opencode-switch toggles, re-reads auth.json, and persists the boolean', async t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go-failover': { label: 'first', key: 'sk-first' } })

    const pi = makePi()
    multiOpencodeGo(pi.api)
    start(pi)
    const command = pi.commands.get('opencode-switch')
    assert.ok(command)

    await command.handler('on', makeCtx(pi.notices))
    assert.equal(loadFailoverOn(), true)
    assert.match(pi.notices.at(-1)?.[0] ?? '', /using failover \(first\)/)

    const on = { Authorization: 'Bearer primary' }
    fireHeaders(pi, on, 'opencode-go')
    assert.equal(on.Authorization, 'Bearer sk-first')
    assert.equal(on['x-api-key'], 'sk-first')

    // A mid-session edit is picked up because the command re-reads auth.json.
    writeAuth(dir, { 'opencode-go-failover': { label: 'second', key: 'sk-second' } })
    await command.handler('', makeCtx(pi.notices))
    assert.equal(loadFailoverOn(), false)
    assert.match(pi.notices.at(-1)?.[0] ?? '', /using primary/)

    await command.handler('failover', makeCtx(pi.notices))
    const reread = { Authorization: 'Bearer primary' }
    fireHeaders(pi, reread, 'opencode-go')
    assert.equal(reread.Authorization, 'Bearer sk-second')
})

test('/opencode-switch warns on a missing account and on unknown args', async t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go': { key: 'sk-primary' } })

    const pi = makePi()
    multiOpencodeGo(pi.api)
    start(pi)
    const command = pi.commands.get('opencode-switch')
    assert.ok(command)

    await command.handler('', makeCtx(pi.notices))
    assert.equal(pi.notices.at(-1)?.[1], 'warning')
    assert.match(pi.notices.at(-1)?.[0] ?? '', /No opencode-go failover account configured/)

    writeAuth(dir, { 'opencode-go-failover': { label: 'second', key: 'sk-second' } })
    await command.handler('sideways', makeCtx(pi.notices))
    assert.equal(pi.notices.at(-1)?.[1], 'warning')
    assert.match(pi.notices.at(-1)?.[0] ?? '', /Usage: \/opencode-switch/)
    assert.equal(loadFailoverOn(), false)
})

test('a stale persisted on with no failover account is forced off', t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go': { key: 'sk-primary' } })
    saveFailoverOn(true)

    const pi = makePi()
    multiOpencodeGo(pi.api)
    start(pi)

    const headers = { Authorization: 'Bearer primary' }
    fireHeaders(pi, headers, 'opencode-go')
    assert.deepEqual(headers, { Authorization: 'Bearer primary' })
})

test('session_start publishes the failover glyph and a startup notice when on', t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go-failover': { label: 'second', key: 'sk-second' } })
    saveFailoverOn(true)

    const pi = makePi()
    multiOpencodeGo(pi.api)
    const statuses = new Map<string, string | undefined>()
    start(pi, makeCtx(pi.notices, undefined, statuses))

    assert.equal(statuses.get('multi-opencode-go'), '⇄')
    assert.equal(pi.notices.length, 1)
    assert.equal(pi.notices[0][1], 'info')
    assert.match(pi.notices[0][0], /opencode-go: failover active \(second\)/)
})

test('session_start clears the status and stays quiet when failover is off', t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go-failover': { label: 'second', key: 'sk-second' } })

    const pi = makePi()
    multiOpencodeGo(pi.api)
    const statuses = new Map<string, string | undefined>([['multi-opencode-go', '⇄']])
    start(pi, makeCtx(pi.notices, undefined, statuses))

    assert.ok(statuses.has('multi-opencode-go'))
    assert.equal(statuses.get('multi-opencode-go'), undefined)
    assert.deepEqual(pi.notices, [])
})

test('/opencode-switch sets the glyph when on and clears it when off', async t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go-failover': { label: 'second', key: 'sk-second' } })

    const pi = makePi()
    multiOpencodeGo(pi.api)
    const statuses = new Map<string, string | undefined>()
    start(pi, makeCtx(pi.notices, undefined, statuses))
    const command = pi.commands.get('opencode-switch')
    assert.ok(command)

    await command.handler('on', makeCtx(pi.notices, undefined, statuses))
    assert.equal(statuses.get('multi-opencode-go'), '⇄')

    await command.handler('off', makeCtx(pi.notices, undefined, statuses))
    assert.equal(statuses.get('multi-opencode-go'), undefined)
})

test('print mode and no-UI contexts never call setStatus', t => {
    const dir = makeAgentDir(t)
    writeAuth(dir, { 'opencode-go-failover': { label: 'second', key: 'sk-second' } })
    saveFailoverOn(true)

    const pi = makePi()
    multiOpencodeGo(pi.api)

    for (const overrides of [{ mode: 'print' }, { hasUI: false }]) {
        const statuses = new Map<string, string | undefined>()
        start(pi, makeCtx(pi.notices, undefined, statuses, overrides))
        assert.equal(statuses.size, 0)
    }
})

test('session_shutdown clears the footer status', () => {
    const pi = makePi()
    multiOpencodeGo(pi.api)
    const statuses = new Map<string, string | undefined>([['multi-opencode-go', '⇄']])

    pi.handlers.get('session_shutdown')?.({}, makeCtx(pi.notices, undefined, statuses))
    assert.equal(statuses.get('multi-opencode-go'), undefined)
})
