import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { GateContext } from '../gate/gate.ts'
import { EMBED_DIM } from '../index/db.ts'
import { getNoteByKey, needsEmbedding, upsertNote } from '../index/notes.ts'
import { fileHash } from '../store/frontmatter.ts'
import type { EmbedJob } from '../store/notes.ts'
import { openStore, type Store } from '../store/store.ts'
import { memorySearch } from '../tools/definitions.ts'
import {
    EMBED_TEXT_CHARS,
    type EmbedBatch,
    backfill,
    createEmbedWorker,
    embedText,
    truncateOnWordBoundary,
} from './worker.ts'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function tempDir(t: TestContext, prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

function useStoreDir(t: TestContext): string {
    const dir = tempDir(t, 'pi-memory-worker-')
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

function openTestStore(t: TestContext): Store {
    const store = openStore(tempDir(t, 'pi-memory-worker-cwd-'))
    t.after(() => store.close())
    return store
}

function allowGate(): GateContext {
    return {
        hasUI: true,
        ui: {
            async confirm() {
                return true
            },
        },
    }
}

/** Seeds a note row directly; the worker only needs the row, not the git write path. */
function seedNote(store: Store, key: string, body: string): EmbedJob {
    const bodyHash = fileHash(Buffer.from(body, 'utf8'))
    upsertNote(store.db, {
        scope: 'global',
        project: '',
        key,
        path: `global/${key}.md`,
        body,
        fmLen: 0,
        bodyHash,
        access: 'open',
        mtime: Date.now(),
    })
    return { scope: 'global', project: '', key, bodyHash }
}

function vector(tag: number): Float32Array {
    const values = new Float32Array(EMBED_DIM)
    values.fill(0.1)
    values[0] = tag
    return values
}

interface FakeEmbed {
    calls: string[][]
    embed: EmbedBatch
}

function fakeEmbed(options: { delayMs?: number; nullResult?: boolean } = {}): FakeEmbed {
    const calls: string[][] = []
    return {
        calls,
        async embed(texts) {
            calls.push([...texts])
            if (options.delayMs !== undefined) await delay(options.delayMs)
            if (options.nullResult === true) return null
            return texts.map((_, index) => vector(index + 1))
        },
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function vecRows(store: Store): Array<{ note_id: number }> {
    return store.db.prepare('SELECT note_id FROM vec_notes').all() as unknown as Array<{
        note_id: number
    }>
}

// ---------------------------------------------------------------------------
// the write path
// ---------------------------------------------------------------------------

test('enqueue → drain writes a vec_notes row and sets vec_hash', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)
    const fake = fakeEmbed()
    const worker = createEmbedWorker({
        store,
        embed: fake.embed,
        available: () => true,
        intervalMs: 60_000,
    })
    t.after(() => worker.stop(0))

    const job = seedNote(store, 'auth/session', 'Refresh tokens are short lived.')
    worker.enqueue(job)

    const drained = await worker.drain(2_000)
    assert.deepEqual(drained, { processed: 1, remaining: 0, timedOut: false })
    assert.equal(fake.calls.length, 1, 'one job must be one embed batch, not one per text')

    const rows = vecRows(store)
    assert.equal(rows.length, 1, 'the first vector is an INSERT, not an UPDATE of nothing')
    const row = getNoteByKey(store.db, 'global', '', 'auth/session')
    assert.equal(row?.vec_hash, job.bodyHash)
    assert.deepEqual(worker.stats(), { available: true, processed: 1, queued: 0 })
})

test('a job whose body_hash is stale is dropped', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)
    const fake = fakeEmbed()
    const worker = createEmbedWorker({
        store,
        embed: fake.embed,
        available: () => true,
        intervalMs: 60_000,
    })
    t.after(() => worker.stop(0))

    const stale = seedNote(store, 'notes/page', 'first body')
    // A later write replaces the row's hash; the queued job still names the old one.
    seedNote(store, 'notes/page', 'second body')
    worker.enqueue(stale)

    const drained = await worker.drain(2_000)
    assert.equal(drained.processed, 1)
    assert.equal(fake.calls.length, 0, 'a stale job must not even be embedded')
    assert.equal(vecRows(store).length, 0)
    assert.equal(getNoteByKey(store.db, 'global', '', 'notes/page')?.vec_hash, null)
})

test('queued jobs are deduped by (scope, project, key), newest hash wins', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)
    const fake = fakeEmbed()
    const worker = createEmbedWorker({
        store,
        embed: fake.embed,
        available: () => true,
        intervalMs: 60_000,
    })
    t.after(() => worker.stop(0))

    const first = seedNote(store, 'notes/page', 'first body')
    const second = seedNote(store, 'notes/page', 'second body')
    worker.enqueue(first)
    worker.enqueue(second)
    assert.equal(worker.stats().queued, 1)

    await worker.drain(2_000)
    assert.equal(fake.calls.length, 1)
    assert.equal(getNoteByKey(store.db, 'global', '', 'notes/page')?.vec_hash, second.bodyHash)
})

test('drain respects its timeout with a slow embedder', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)
    const fake = fakeEmbed({ delayMs: 60 })
    const worker = createEmbedWorker({
        store,
        embed: fake.embed,
        available: () => true,
        batchSize: 1,
        intervalMs: 60_000,
    })
    t.after(() => worker.stop(0))

    for (let index = 0; index < 10; index++) {
        worker.enqueue(seedNote(store, `notes/${index}`, `body ${index}`))
    }

    const started = Date.now()
    const drained = await worker.drain(20)
    const elapsed = Date.now() - started

    assert.equal(drained.processed, 1, 'the batch in flight finishes, then the deadline stops')
    assert.equal(drained.remaining, 9)
    assert.equal(drained.timedOut, true)
    // The deadline stops new batches; it does not abandon the one running.
    assert.ok(
        elapsed >= 50,
        `drain returned in ${elapsed} ms, before the in-flight batch ended`
    )
    assert.ok(elapsed < 1_000, `drain ran for ${elapsed} ms`)
})

test('stop terminates the interval and stops accepting work', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)
    const fake = fakeEmbed()
    const worker = createEmbedWorker({
        store,
        embed: fake.embed,
        available: () => true,
        intervalMs: 25,
    })

    const stopped = await worker.stop(100)
    assert.deepEqual(stopped, { processed: 0, remaining: 0, timedOut: false })

    worker.enqueue(seedNote(store, 'notes/late', 'written after shutdown'))
    await delay(120)
    assert.equal(fake.calls.length, 0, 'a stopped worker must not embed anything')
    assert.equal(worker.stats().queued, 0)
    assert.equal(worker.stats().processed, 0)
})

test('stop(2000) stays within its budget while an interval tick is draining (F4)', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)
    // Slow on purpose (§8.1 budgets for a slow machine): 20 batches of 150 ms is 3 s of
    // work, so an unbounded tick cannot be waited out inside the 2.5 s assertion below.
    const fake = fakeEmbed({ delayMs: 150 })
    const worker = createEmbedWorker({
        store,
        embed: fake.embed,
        available: () => true,
        batchSize: 2,
        intervalMs: 10,
    })
    t.after(() => worker.stop(0))

    for (let index = 0; index < 40; index++) {
        worker.enqueue(seedNote(store, `notes/${index}`, `body ${index}`))
    }

    // Let the interval start a run, then prove it really is in flight.
    const tickDeadline = Date.now() + 1_000
    while (fake.calls.length === 0 && Date.now() < tickDeadline) await delay(10)
    assert.ok(fake.calls.length >= 1, 'the interval tick never started a run')

    const started = Date.now()
    const stopped = await worker.stop(2_000)
    const elapsed = Date.now() - started

    assert.ok(elapsed < 2_500, `stop(2000) took ${elapsed} ms`)
    // Bounded, not complete: the interval tick's own deadline stopped it early, and the
    // shutdown drain stopped at its deadline too.
    assert.equal(stopped.timedOut, true)
    assert.ok(stopped.remaining > 0, 'the 3 s of queued work cannot have drained')
    assert.ok(stopped.processed < 40)
})

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

test('backfill enqueues exactly the notes needsEmbedding reports', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)
    const fake = fakeEmbed()
    const worker = createEmbedWorker({
        store,
        embed: fake.embed,
        available: () => true,
        intervalMs: 60_000,
    })
    t.after(() => worker.stop(0))

    seedNote(store, 'notes/one', 'one')
    seedNote(store, 'notes/two', 'two')
    seedNote(store, 'notes/three', 'three')
    // Already embedded: vec_hash matches body_hash.
    store.db.prepare("UPDATE notes SET vec_hash = body_hash WHERE key = 'notes/two'").run()

    const expected = needsEmbedding(store.db).length
    assert.equal(expected, 2)

    const queued = backfill(store, worker)
    assert.equal(queued, expected)
    assert.equal(worker.stats().queued, expected)

    await worker.drain(2_000)
    assert.equal(fake.calls.length, 1, 'two jobs, batchSize 16 → one embed call')
    assert.equal(fake.calls[0].length, 2)
    assert.equal(vecRows(store).length, 2)
})

// ---------------------------------------------------------------------------
// degradation (§12.10)
// ---------------------------------------------------------------------------

test('a missing embedder is not an error: unavailable, queue dropped, BM25 still works', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t)
    const fake = fakeEmbed()
    const worker = createEmbedWorker({
        store,
        embed: fake.embed,
        available: () => false,
        intervalMs: 60_000,
    })
    t.after(() => worker.stop(0))

    seedNote(store, 'deploy/grafana', 'The grafana dashboard lives on port 3000.')
    const job: EmbedJob = {
        scope: 'global',
        project: '',
        key: 'deploy/grafana',
        bodyHash: getNoteByKey(store.db, 'global', '', 'deploy/grafana')?.body_hash ?? '',
    }
    worker.enqueue(job)

    assert.equal(worker.stats().available, false)
    const drained = await worker.drain(1_000)
    assert.equal(drained.processed, 0)
    assert.equal(drained.remaining, 0, 'the queue is dropped, not retried forever')
    assert.equal(fake.calls.length, 0, 'no embedder means no spawn attempt')
    assert.equal(vecRows(store).length, 0)

    // The documented fallback: the same search path with a null embedder.
    const result = await memorySearch(
        {
            store,
            gate: allowGate(),
            cwd: tempDir(t, 'pi-memory-worker-ctx-'),
            embed: async () => null,
        },
        { query: 'grafana' }
    )
    assert.equal(result.isError, undefined)
    assert.match(result.text, /deploy\/grafana/)
})

// ---------------------------------------------------------------------------
// embed text (§8.2)
// ---------------------------------------------------------------------------

test('the embed text is the key plus the first 1024 body characters', () => {
    const body = `${'word '.repeat(400)}tail`
    const text = embedText('auth/session', body)
    assert.ok(text.startsWith('auth/session\n'))
    const embedded = text.slice('auth/session\n'.length)
    assert.ok(embedded.length <= EMBED_TEXT_CHARS)
    assert.ok(embedded.endsWith('word'), 'truncation must not leave a partial word')
    assert.equal(embedText('a/b', 'short body'), 'a/b\nshort body')
})

test('truncateOnWordBoundary keeps a single long token intact', () => {
    const token = 'x'.repeat(EMBED_TEXT_CHARS + 50)
    assert.equal(truncateOnWordBoundary(token, EMBED_TEXT_CHARS).length, EMBED_TEXT_CHARS)
    assert.equal(truncateOnWordBoundary('short', EMBED_TEXT_CHARS), 'short')
})
