import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import type { GateContext } from '../gate/gate.ts'
import { appendLog, readLog } from '../gate/log.ts'
import { getNoteByKey } from '../index/notes.ts'
import { resolveScope } from '../store/notes.ts'
import { openStore, type Store } from '../store/store.ts'
import { AGENTS_MEMORIES_LINE, registerMemoryCommands } from './index.ts'

// ---------------------------------------------------------------------------
// host and store doubles
// ---------------------------------------------------------------------------

interface FakeCommand {
    description: string
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null
}

interface FakePi {
    api: ExtensionAPI
    commands: Map<string, FakeCommand>
}

function fakePi(): FakePi {
    const commands = new Map<string, FakeCommand>()
    const api = {
        registerCommand(name: string, options: FakeCommand) {
            commands.set(name, options)
        },
        registerTool() {},
        on() {},
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
    return { api: api as unknown as ExtensionAPI, commands }
}

interface Notices {
    entries: Array<{ message: string; severity: string | undefined }>
    messages: string[]
    confirms: number
}

function commandContext(cwd: string): { ctx: ExtensionCommandContext; notices: Notices } {
    const notices: Notices = { entries: [], messages: [], confirms: 0 }
    const ctx = {
        cwd,
        mode: 'tui',
        hasUI: true,
        sessionManager: {
            getBranch: () => [],
            getSessionId: () => 'sess-commands',
        },
        ui: {
            notify(message: string, severity?: string) {
                notices.entries.push({ message, severity })
                notices.messages.push(message)
            },
            async confirm() {
                notices.confirms++
                return true
            },
            async input() {
                return undefined
            },
            async custom() {
                return undefined
            },
            setStatus() {},
        },
        newSession: async () => ({ cancelled: true }),
        notices,
    }
    return { ctx: ctx as unknown as ExtensionCommandContext, notices }
}

function tempDir(t: TestContext, prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

function useStoreDir(t: TestContext): string {
    const dir = tempDir(t, 'pi-memory-cmd-store-')
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

function allowGate(): GateContext {
    return {
        hasUI: true,
        sessionId: 'sess-commands',
        ui: {
            async confirm() {
                return true
            },
        },
    }
}

async function setup(
    t: TestContext,
    options: { cwd?: string } = {}
): Promise<{ store: Store; pi: FakePi }> {
    useStoreDir(t)
    const store = openStore(options.cwd ?? tempDir(t, 'pi-memory-cmd-cwd-'), {
        gate: allowGate(),
    })
    t.after(() => store.close())
    const pi = fakePi()
    registerMemoryCommands(pi.api, () => store)
    return { store, pi }
}

/** Runs the registered `/memory` command and returns the single notice it emitted. */
async function run(pi: FakePi, args: string, ctx: ExtensionCommandContext): Promise<string> {
    const command = pi.commands.get('memory')
    assert.ok(command !== undefined, 'the memory command was not registered')
    await command.handler(args, ctx)
    return lastNotice(ctx)
}

function lastNotice(ctx: ExtensionCommandContext): string {
    const messages = (ctx as unknown as { notices?: Notices }).notices?.messages
    return messages?.[messages.length - 1] ?? ''
}

function makeProjectRepo(t: TestContext): string {
    const dir = tempDir(t, 'pi-memory-project-')
    const init = spawnSync('git', ['init', '--quiet'], { cwd: dir, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    return dir
}

interface Fixture {
    projectDir: string
    memories: string
}

function memoriesFixture(t: TestContext, projectDir: string, conflict?: string): Fixture {
    const memories = path.join(projectDir, '.serena', 'memories')
    fs.mkdirSync(path.join(memories, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(memories, 'alpha.md'), 'alpha note body')
    fs.writeFileSync(path.join(memories, 'sub', 'beta.md'), 'beta note body')
    fs.writeFileSync(path.join(memories, '.DS_Store'), Buffer.from([0, 1, 2]))
    fs.writeFileSync(path.join(memories, 'notes.txt'), 'not markdown')
    if (conflict !== undefined) {
        fs.writeFileSync(path.join(memories, 'conflict.md'), conflict)
    }
    return { projectDir, memories }
}

// ---------------------------------------------------------------------------
// registration and usage
// ---------------------------------------------------------------------------

test('the memory command is registered with usage and completions', async t => {
    ensureNotSubagent(t)
    const { pi } = await setup(t)
    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))

    const command = pi.commands.get('memory')
    assert.ok(command !== undefined)
    assert.ok((command.description ?? '').length > 0)
    assert.deepEqual(
        command.getArgumentCompletions?.('imp')?.map(item => item.label),
        ['import', 'import-keep']
    )

    await run(pi, '', ctx)
    assert.match(lastNotice(ctx), /\/memory index \[--rebuild\]/)
})

// ---------------------------------------------------------------------------
// /memory show
// ---------------------------------------------------------------------------

test('/memory show logs one user line and never confirms', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)
    await store.writeNote({
        key: 'secrets/api_token',
        body: 'TOKEN-9f3c is rotated by hand.',
        access: 'gated',
        reason: 'seed the fixture',
    })
    const before = readLog(store.root).length
    // §7.1: a gated write is `pending` + one resolver, never a third line.
    assert.equal(before, 2, 'the gated seed wrote more than two lines')
    assert.deepEqual(
        readLog(store.root).map(entry => entry.decision),
        ['pending', 'approved']
    )

    const { ctx, notices } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'show secrets/api_token', ctx)

    assert.equal(notices.confirms, 0, '/memory show is user-initiated and must not confirm')
    assert.match(lastNotice(ctx), /TOKEN-9f3c is rotated by hand/)

    const added = readLog(store.root).slice(before)
    assert.equal(added.length, 1, 'show is the one documented single-line encoding')
    assert.equal(added[0].op, 'show')
    assert.equal(added[0].initiator, 'user')
    assert.equal(added[0].decision, 'user')
    assert.equal(added[0].result, 'ok')
    assert.equal(added[0].key, 'secrets/api_token')
    assert.equal(added[0].reason, undefined)
    assert.match(added[0].attempt ?? '', /^[0-9a-f]{16}$/)
})

test('/memory show --gated lists keys without bodies and logs nothing', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)
    await store.writeNote({ key: 'open/note', body: 'open body text' })
    await store.writeNote({
        key: 'secrets/one',
        body: 'SECRET-ONE harvest',
        access: 'gated',
        reason: 'seed',
    })
    await store.writeNote({
        key: 'secrets/two',
        body: 'SECRET-TWO harvest',
        access: 'gated',
        reason: 'seed',
    })
    const before = readLog(store.root).length
    assert.equal(before, 4, 'two gated seeds at two lines each')

    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'show --gated', ctx)
    const text = lastNotice(ctx)

    assert.match(text, /gated notes in global \(2\)/)
    assert.match(text, /secrets\/one/)
    assert.match(text, /secrets\/two/)
    assert.ok(!text.includes('SECRET-ONE'))
    assert.ok(!text.includes('SECRET-TWO'))
    assert.ok(!text.includes('open/note'), 'the listing is gated notes only')
    assert.equal(
        readLog(store.root).length,
        before,
        'listing keys reads no body, so it logs nothing'
    )
})

// ---------------------------------------------------------------------------
// /memory log
// ---------------------------------------------------------------------------

test('/memory log renders a pending+approved pair as one row and an unresolved pending distinctly', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)

    appendLog(store.root, {
        attempt: 'aaaaaaaaaaaaaaaa',
        op: 'read',
        initiator: 'agent',
        decision: 'pending',
        scope: 'global',
        key: 'auth/session',
        reason: 'checking refresh policy',
    })
    appendLog(store.root, { attempt: 'aaaaaaaaaaaaaaaa', decision: 'approved', result: 'ok' })
    appendLog(store.root, {
        attempt: 'bbbbbbbbbbbbbbbb',
        op: 'write',
        initiator: 'agent',
        decision: 'pending',
        scope: 'global',
        key: 'notes/lost',
        reason: 'process died mid-confirm',
    })

    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'log --tail 50', ctx)
    const lines = lastNotice(ctx).split('\n')

    assert.match(lines[0], /access log: last 2 of 2 attempts/)
    // notice header + column header + separator + two rows
    assert.equal(lines.length, 5)

    const approved = lines.filter(line => line.includes('auth/session'))
    assert.equal(approved.length, 1, 'the pair must be one row, not two')
    assert.match(approved[0], /approved/)
    assert.match(approved[0], /ok/)
    assert.match(approved[0], /checking refresh policy/)
    assert.ok(!approved[0].includes('pending'))

    const unresolved = lines.filter(line => line.includes('notes/lost'))
    assert.equal(unresolved.length, 1)
    assert.match(unresolved[0], /pending \(unresolved\)/)
    assert.ok(unresolved[0].startsWith('!'), 'unresolved rows are marked, not only labelled')
})

test('/memory log renders a mention decision as one row and never as a consent outcome', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)

    appendLog(store.root, {
        ts: '2026-10-29T10:00:00.000Z',
        op: 'mention',
        initiator: 'agent',
        decision: 'inject',
        scope: 'global',
        top1: 3.56,
        m10: 1.55,
        n: 5,
        reason: 'injected',
        keys: ['notes/a', 'notes/b'],
    })
    appendLog(store.root, {
        ts: '2026-10-29T10:00:01.000Z',
        op: 'mention',
        initiator: 'agent',
        decision: 'skip',
        scope: 'global',
        top1: 1e-6,
        m10: 1e-6,
        n: 3,
        reason: 'idf-clamp',
    })
    // A real declined gated read, so the consent encoding is checked alongside: it must
    // still pair into one `declined` row, not disappear or turn into `skip`.
    appendLog(store.root, {
        ts: '2026-10-29T10:00:02.000Z',
        attempt: 'dddddddddddddddd',
        op: 'read',
        initiator: 'agent',
        decision: 'pending',
        scope: 'global',
        key: 'secrets/api_token',
        reason: 'checking rotation',
    })
    appendLog(store.root, { attempt: 'dddddddddddddddd', decision: 'declined' })

    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'log --tail 50', ctx)
    const lines = lastNotice(ctx).split('\n')

    assert.match(lines[0], /access log: last 3 of 3 attempts/)
    // notice header + column header + separator + three rows
    assert.equal(lines.length, 6)

    const injected = lines.filter(line => line.includes('notes/a'))
    assert.equal(injected.length, 1, 'a mention line is one row, not a pair')
    assert.match(injected[0], /mention/)
    assert.match(injected[0], /inject/)
    assert.match(injected[0], /notes\/a, notes\/b/)
    assert.match(injected[0], /injected/)
    assert.ok(!injected[0].includes('pending'))

    const skipped = lines.filter(line => line.includes('idf-clamp'))
    assert.equal(skipped.length, 1)
    assert.match(skipped[0], /skip/)
    assert.ok(!skipped[0].includes('pending'))

    const declined = lines.filter(line => line.includes('secrets/api_token'))
    assert.equal(declined.length, 1, 'the declined pair must stay one row')
    assert.match(declined[0], /read/)
    assert.match(declined[0], /declined/)
    assert.match(declined[0], /checking rotation/)
    assert.ok(!declined[0].includes('pending'))
})

test('/memory log applies --tail after concatenating .1 and the live file', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)

    const userLine = (attempt: string, key: string, ts: string): void => {
        appendLog(store.root, {
            ts,
            attempt,
            op: 'show',
            initiator: 'user',
            decision: 'user',
            result: 'ok',
            key,
        })
    }

    userLine('1111111111111111', 'filler/one', '2026-10-29T10:00:00.000Z')
    // The pending line lands in the generation that is about to be rotated away.
    appendLog(store.root, {
        ts: '2026-10-29T10:00:01.000Z',
        attempt: 'cccccccccccccccc',
        op: 'read',
        initiator: 'agent',
        decision: 'pending',
        key: 'pair/across-rotation',
        reason: 'why',
    })
    userLine('2222222222222222', 'filler/two', '2026-10-29T10:00:02.000Z')

    // rotate: access.log → access.log.1
    fs.renameSync(path.join(store.root, 'access.log'), path.join(store.root, 'access.log.1'))

    userLine('3333333333333333', 'filler/three', '2026-10-29T10:00:03.000Z')
    // The resolver lands in the live file.
    appendLog(store.root, { attempt: 'cccccccccccccccc', decision: 'approved', result: 'ok' })

    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'log --tail 1', ctx)
    const lines = lastNotice(ctx).split('\n')

    assert.match(lines[0], /last 1 of 4 attempts/)
    // header + column header + separator + exactly one row
    assert.equal(lines.length, 4, '--tail 1 must yield one row, not up to 2N lines')
    assert.match(lines[3], /pair\/across-rotation/)
    assert.match(lines[3], /approved/)
    assert.ok(
        !lines[3].includes('unresolved'),
        'the pending in .1 paired with the live resolver'
    )
})

// ---------------------------------------------------------------------------
// /memory diff
// ---------------------------------------------------------------------------

test('/memory diff renders history compactly and logs a gated diff as one user line', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)

    const first = await store.writeNote({ key: 'notes/page', body: 'first line\n' })
    assert.equal(first.ok, true)
    if (first.ok !== true) return
    await store.writeNote({
        key: 'notes/page',
        body: 'first line\nsecond line\n',
        baseHash: first.hash,
    })

    const { ctx, notices } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    const logBefore = readLog(store.root).length
    await run(pi, 'diff notes/page', ctx)
    const text = lastNotice(ctx)
    assert.match(text, /commit [0-9a-f]{7,} memory: write notes\/page/)
    assert.match(text, /\+second line/)
    assert.ok(!/^index [0-9a-f]+/m.test(text), 'file headers and index lines are noise')
    assert.ok(!text.includes('Author:'))
    assert.equal(notices.confirms, 0)

    // An open note's diff is not an access-log event.
    assert.equal(readLog(store.root).length, logBefore)

    await store.writeNote({
        key: 'secrets/api',
        body: 'gated body',
        access: 'gated',
        reason: 'seed',
    })
    const before = readLog(store.root).length
    await run(pi, 'diff secrets/api', ctx)
    const added = readLog(store.root).slice(before)
    assert.equal(added.length, 1, 'a gated diff is user-initiated: one line, no confirm')
    assert.equal(added[0].op, 'diff')
    assert.equal(added[0].initiator, 'user')
    assert.equal(added[0].decision, 'user')
    assert.equal(added[0].key, 'secrets/api')
    assert.equal(notices.confirms, 0)
})

test('/memory diff reports a key with no history instead of failing', async t => {
    ensureNotSubagent(t)
    const { pi } = await setup(t)
    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'diff notes/never-written', ctx)
    assert.match(lastNotice(ctx), /no history for notes\/never-written/)
})

// ---------------------------------------------------------------------------
// /memory index
// ---------------------------------------------------------------------------

test('/memory index --force-unlock clears a live-pid lock', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)
    const lockFile = path.join(store.root, '.git', 'pi-memory.lock')
    // Our own pid: alive by definition, so only the force option can clear this.
    fs.writeFileSync(lockFile, `${process.pid} ${Date.now()}\n`)

    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'index --force-unlock', ctx)
    const text = lastNotice(ctx)

    assert.match(text, /force-unlock: cleared lock held by/)
    assert.equal(fs.existsSync(lockFile), false)
    assert.match(text, /indexed: scanned \d+, updated \d+, skipped \d+, errors \d+/)
})

test('/memory index reports the row of a hand-deleted note as removed', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)
    await store.writeNote({ key: 'notes/gone', body: 'deleted by hand later' })
    await store.writeNote({ key: 'notes/kept', body: 'stays' })
    fs.rmSync(path.join(store.root, 'global', 'notes', 'gone.md'))

    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'index', ctx)
    const text = lastNotice(ctx)

    assert.match(text, /indexed: scanned 1, updated 0, skipped 1, errors 0, removed 1/)
    assert.equal(getNoteByKey(store.db, 'global', '', 'notes/gone'), null)
})

test('/memory index --rebuild reports the rebuilt note count', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)
    await store.writeNote({ key: 'notes/one', body: 'one' })
    await store.writeNote({ key: 'notes/two', body: 'two' })

    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'index --rebuild', ctx)
    assert.match(lastNotice(ctx), /rebuilt: scanned 2, updated 2, skipped 0, errors 0/)
})

// ---------------------------------------------------------------------------
// /memory search
// ---------------------------------------------------------------------------

test('/memory search is the tool path plus a gated count, never a gated result', async t => {
    ensureNotSubagent(t)
    const { store, pi } = await setup(t)
    await store.writeNote({
        key: 'deploy/grafana',
        body: 'The grafana dashboard runs on port 3000.',
    })
    await store.writeNote({
        key: 'secrets/grafana_token',
        body: 'GRAFANA-SECRET-4b2a',
        access: 'gated',
        reason: 'seed',
    })

    const { ctx } = commandContext(tempDir(t, 'pi-memory-cmd-ctx-'))
    await run(pi, 'search grafana', ctx)
    const text = lastNotice(ctx)

    assert.match(text, /deploy\/grafana/)
    assert.ok(!text.includes('GRAFANA-SECRET-4b2a'))
    assert.match(text, /1 gated note withheld; \/memory show --gated lists them/)
})

// ---------------------------------------------------------------------------
// /memory import
// ---------------------------------------------------------------------------

test('/memory import imports .md files, reports skips and a conflict, and deletes only what landed', async t => {
    ensureNotSubagent(t)
    const projectDir = makeProjectRepo(t)
    const fixture = memoriesFixture(t, projectDir, 'source conflict body')
    const { store, pi } = await setup(t, { cwd: projectDir })
    const project = resolveScope(projectDir, 'project').project

    // An existing note with the same key: import must not overwrite it.
    const seeded = await store.writeNote({
        key: 'conflict',
        body: 'existing store body',
        scope: 'project',
    })
    assert.equal(seeded.ok, true)

    const { ctx } = commandContext(projectDir)
    await run(pi, 'import', ctx)
    const text = lastNotice(ctx)

    assert.match(text, /imported 2 notes into project:/)
    assert.match(text, /skipped 2 non-\.md files:/)
    assert.match(text, /\.DS_Store \(not a \.md file\)/)
    assert.match(text, /notes\.txt \(not a \.md file\)/)
    assert.match(text, /left 1 file in place:/)
    assert.match(text, /conflict\.md: already exists in the store/)
    assert.match(text, /deleted 2 imported source files/)
    assert.match(text, new RegExp(AGENTS_MEMORIES_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    assert.equal(getNoteByKey(store.db, 'project', project, 'alpha')?.body, 'alpha note body')
    assert.equal(
        getNoteByKey(store.db, 'project', project, 'sub/beta')?.body,
        'beta note body'
    )
    assert.equal(
        getNoteByKey(store.db, 'project', project, 'conflict')?.body,
        'existing store body'
    )

    // Only imported files are deleted; the conflict and non-.md files stay.
    assert.equal(fs.existsSync(path.join(fixture.memories, 'alpha.md')), false)
    assert.equal(fs.existsSync(path.join(fixture.memories, 'sub', 'beta.md')), false)
    assert.equal(
        fs.existsSync(path.join(fixture.memories, 'sub')),
        false,
        'empty subdir removed'
    )
    assert.equal(fs.existsSync(path.join(fixture.memories, 'conflict.md')), true)
    assert.equal(fs.existsSync(path.join(fixture.memories, '.DS_Store')), true)
    assert.equal(
        fs.existsSync(fixture.memories),
        true,
        'the directory is not empty, so it stays'
    )

    // Every imported note is a project-scoped commit with its own path, not `add -A`.
    const log = spawnSync('git', ['log', '--format=%s'], { cwd: store.root, encoding: 'utf8' })
    assert.match(log.stdout, /memory: write alpha/)
    assert.match(log.stdout, /memory: write sub\/beta/)
})

test('/memory import-keep imports without deleting anything', async t => {
    ensureNotSubagent(t)
    const projectDir = makeProjectRepo(t)
    const fixture = memoriesFixture(t, projectDir)
    const { store, pi } = await setup(t, { cwd: projectDir })
    const project = resolveScope(projectDir, 'project').project

    const { ctx } = commandContext(projectDir)
    await run(pi, 'import-keep', ctx)
    const text = lastNotice(ctx)

    assert.match(text, /imported 2 notes into project:/)
    assert.match(text, /import-keep: source files and directories were not touched/)
    assert.equal(fs.existsSync(path.join(fixture.memories, 'alpha.md')), true)
    assert.equal(fs.existsSync(path.join(fixture.memories, 'sub', 'beta.md')), true)
    assert.equal(getNoteByKey(store.db, 'project', project, 'alpha')?.body, 'alpha note body')
})

test('/memory import reports a missing project scope instead of writing globally', async t => {
    ensureNotSubagent(t)
    // A cwd that is not a git repository: §10 imports into `scope=project`, so there is
    // nowhere to put the notes.
    const plainDir = tempDir(t, 'pi-memory-no-repo-')
    memoriesFixture(t, plainDir)
    const { pi } = await setup(t, { cwd: plainDir })

    const { ctx, notices } = commandContext(plainDir)
    await run(pi, 'import', ctx)

    assert.match(lastNotice(ctx), /not in a git repository; no project scope/)
    assert.equal(notices.entries.at(-1)?.severity, 'error')
    assert.equal(fs.existsSync(path.join(plainDir, '.serena', 'memories', 'alpha.md')), true)
})
