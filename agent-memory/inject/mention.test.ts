import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import type { LogEntry } from '../gate/log.ts'
import { setMeta } from '../index/db.ts'
import { searchBm25 } from '../index/notes.ts'
import { accessLogPath } from '../store/paths.ts'
import { openStore, type Store } from '../store/store.ts'
import {
    type ContextMessageLike,
    MENTION_PREFIX,
    detectMentions,
    installMentionHook,
} from './mention.ts'

// ---------------------------------------------------------------------------
// the fixture corpus (§6.2's numbers are corpus-dependent by construction)
// ---------------------------------------------------------------------------

/**
 * 31 notes. The three term distributions are the whole point:
 *
 * - `grafana` in one open note (three times) plus one **gated** note (ten times), so
 *   the gated note outranks every open note if the SQL gate is ever dropped;
 * - `shared` in four open notes, which gives `n ≥ 4` with a flat distribution;
 * - `common` in sixteen of thirty-one, past the point where FTS5's IDF clamps and
 *   `bm25()` collapses to 1e-6 (measured: 15 of 30 → 1e-6, 1 of 30 → 2.98).
 */
function seedCorpus(t: TestContext): { root: string; store: Store; cwd: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-mention-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const saved = process.env.PI_MEMORY_DIR
    process.env.PI_MEMORY_DIR = root
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_DIR
        else process.env.PI_MEMORY_DIR = saved
    })

    const topics = Array.from({ length: 30 }, (_, i) => `topic${String(i).padStart(2, '0')}`)
    const write = (key: string, body: string): void => {
        const file = path.join(root, 'global', `${key}.md`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, body)
    }
    const append = (key: string, text: string): void => {
        fs.appendFileSync(path.join(root, 'global', `${key}.md`), text)
    }

    for (const topic of topics)
        write(`notes/${topic}`, `notes about ${topic} in the corpus.\n`)
    for (let i = 0; i < 4; i++) append(`notes/${topics[i]}`, 'shared dashboard word.\n')
    append('notes/topic07', 'grafana grafana grafana\n')
    for (let i = 0; i < 16; i++)
        append(`notes/${topics[i]}`, 'common word used by half the corpus.\n')
    write(
        'secrets/grafana_prod',
        '---\naccess: gated\n---\ngrafana grafana grafana grafana grafana grafana grafana grafana grafana grafana\n'
    )

    // A cwd outside any git repository, so an omitted scope resolves to global (§5.1).
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-mention-cwd-'))
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
    const store = openStore(cwd)
    t.after(() => store.close())
    assert.equal(store.reindex().updated, 31)
    return { root, store, cwd }
}

function logEntries(root: string): LogEntry[] {
    let raw: string
    try {
        raw = fs.readFileSync(accessLogPath(root), 'utf8')
    } catch {
        return []
    }
    return raw
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as LogEntry)
}

/** The `pending` lines of mention decisions, with their resolvers paired by attempt. */
function searchDecisions(root: string): { pending: LogEntry; resolver?: LogEntry }[] {
    const entries = logEntries(root)
    const pending = entries.filter(entry => entry.op === 'search')
    return pending.map(line => ({
        pending: line,
        resolver: entries.find(
            entry => entry.attempt === line.attempt && entry.decision !== 'pending'
        ),
    }))
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

test('a distinctive query injects at most three keys', t => {
    const { store, cwd } = seedCorpus(t)

    const result = detectMentions(store, 'grafana shared widget', { cwd })

    assert.equal(result.injected, true)
    assert.equal(result.reason, 'injected')
    assert.ok(result.n >= 5, `n was ${result.n}`)
    // Ties among the four "shared" notes are not ordered by BM25, so only the winner
    // and the breadth are asserted.
    assert.equal(result.keys.length, 3)
    assert.equal(result.keys[0], 'notes/topic07')
    assert.ok(result.keys.length <= 3)
    // §6.2's relative guard: 3.56 against a 1.55 median clears 1.5×.
    assert.ok(result.top1 >= 1.5 * result.m10, `top1 ${result.top1} vs m10 ${result.m10}`)
})

test('a query whose term is in half the corpus is skipped as the IDF clamp', t => {
    const { store, cwd } = seedCorpus(t)

    const result = detectMentions(store, 'common', { cwd })

    assert.equal(result.injected, false)
    assert.equal(result.reason, 'idf-clamp')
    assert.deepEqual(result.keys, [])
    // The clamp signature, measured on the response rather than assumed: the scores
    // really did collapse, so nothing below could have discriminated.
    assert.ok(Math.abs(result.top1) < 1e-3, `top1 was ${result.top1}`)
    assert.ok(result.n >= 2)
})

test('a single hit above the floor injects even though n < 4', t => {
    const { store, cwd } = seedCorpus(t)

    const result = detectMentions(store, 'grafana', { cwd })

    assert.equal(result.n, 1, 'the gated note must not be a candidate')
    assert.equal(result.injected, true)
    assert.deepEqual(result.keys, ['notes/topic07'])
    assert.ok(result.top1 >= 2.5, `top1 was ${result.top1}`)
})

test('a weak top1 with n < 4 injects nothing', t => {
    const { store, cwd } = seedCorpus(t)
    // "Weak" is defined by the logged number against the configured floor, not by an
    // adjective (§12.17): the store is tuned to F = 6 here, above this query's 3.56.
    setMeta(store.db, 'mention_floor', '6')

    const result = detectMentions(store, 'grafana', { cwd })

    assert.equal(result.n, 1)
    assert.equal(result.injected, false)
    assert.equal(result.reason, 'below-floor')
    assert.deepEqual(result.keys, [])
    assert.ok(result.top1 < 6, `top1 was ${result.top1}`)
})

test('a flat multi-hit distribution is skipped by the relative guard', t => {
    const { store, cwd } = seedCorpus(t)

    const result = detectMentions(store, 'topic00 topic01 topic02 topic03 topic04 topic05', {
        cwd,
    })

    assert.ok(result.n >= 4, `n was ${result.n}`)
    assert.ok(result.top1 >= 2.5, `top1 was ${result.top1}`)
    assert.ok(result.top1 < 1.5 * result.m10, `top1 ${result.top1} vs m10 ${result.m10}`)
    assert.equal(result.injected, false)
    assert.equal(result.reason, 'relative-margin')
})

test('a gated note is never suggested, even when it is the best match', t => {
    const { store, cwd } = seedCorpus(t)
    // Proof that exclusion is what kept it out: searched as gated, it outranks every
    // open note, so without `access = 'open'` in SQL it would have been the top hit.
    const gated = searchBm25(store.db, '"grafana"', { limit: 10, access: 'gated' })
    assert.equal(gated[0]?.key, 'secrets/grafana_prod')
    assert.ok(Math.abs(gated[0].score) > 3.5)

    const result = detectMentions(store, 'grafana grafana grafana', { cwd })

    assert.ok(!result.keys.includes('secrets/grafana_prod'))
    assert.deepEqual(result.keys, ['notes/topic07'])
    // §12.5: no gated key and no gated body token may reach the message either.
    assert.ok(!JSON.stringify(result).includes('secrets/'))
})

test('a message with no searchable words runs no query at all', t => {
    const { root, store, cwd } = seedCorpus(t)

    const result = detectMentions(store, '?!', { cwd })

    assert.equal(result.injected, false)
    assert.equal(result.reason, 'no-query')
    assert.equal(result.n, 0)
    const logged = searchDecisions(root)
    assert.equal(logged.length, 1, 'the skip was not logged')
    assert.equal(logged[0].resolver?.decision, 'declined')
})

test('a query that matches nothing is logged as no-match with n = 0', t => {
    const { store, cwd } = seedCorpus(t)

    const result = detectMentions(store, 'zebrafish quokka', { cwd })

    assert.equal(result.reason, 'no-match')
    assert.equal(result.n, 0)
    assert.equal(result.injected, false)
})

// ---------------------------------------------------------------------------
// logging (§6.2: "so F can be retuned from data")
// ---------------------------------------------------------------------------

test('every decision is logged with top1, m10, n and an outcome', t => {
    const { root, store, cwd } = seedCorpus(t)

    const inject = detectMentions(store, 'grafana', { cwd })
    const skip = detectMentions(store, 'common', { cwd })

    // Two lines per decision: pending (the inputs) and a resolver (the outcome).
    const pairs = searchDecisions(root)
    assert.equal(pairs.length, 2)
    assert.equal(logEntries(root).length, 4)
    for (const { pending: line } of pairs) {
        assert.equal(line.initiator, 'agent')
        assert.equal(typeof line.top1, 'number')
        assert.equal(typeof line.m10, 'number')
        assert.equal(typeof line.n, 'number')
        assert.equal(typeof line.injected, 'boolean')
        assert.equal(typeof line.reason, 'string')
        assert.equal(line.scope, 'global')
    }
    const [first, second] = pairs
    assert.equal(first.pending.top1, Math.round(inject.top1 * 1e4) / 1e4)
    assert.equal(first.pending.m10, Math.round(inject.m10 * 1e4) / 1e4)
    assert.equal(first.pending.n, inject.n)
    assert.equal(first.pending.injected, true)
    assert.equal(first.pending.reason, 'injected')
    assert.equal(second.pending.injected, false)
    assert.equal(second.pending.reason, 'idf-clamp')

    // The resolver shares the attempt id and records the outcome.
    assert.equal(first.resolver?.decision, 'approved')
    assert.equal(first.resolver?.result, 'ok')
    assert.equal(second.resolver?.decision, 'declined')
    assert.equal(second.resolver?.result, undefined, 'nothing was attempted on a skip')
    assert.equal(skip.reason, 'idf-clamp')
})

// ---------------------------------------------------------------------------
// the context hook
// ---------------------------------------------------------------------------

interface RegisteredHandler {
    (event: unknown, ctx?: unknown): unknown
}

function fakePi(): {
    api: ExtensionAPI
    emit(event: string, payload: unknown, ctx?: unknown): unknown
} {
    const handlers = new Map<string, RegisteredHandler>()
    const api = {
        on(event: string, handler: RegisteredHandler) {
            handlers.set(event, handler)
            return () => {}
        },
    } as unknown as ExtensionAPI
    return {
        api,
        emit(event, payload, ctx) {
            const handler = handlers.get(event)
            assert.ok(handler !== undefined, `no handler registered for ${event}`)
            return handler(payload, ctx)
        },
    }
}

function conversation(latest: string): ContextMessageLike[] {
    return [
        { role: 'user', content: 'an earlier question about nothing in particular' },
        { role: 'assistant', content: [{ type: 'text', text: 'an earlier answer' }] },
        { role: 'user', content: latest },
        { role: 'toolResult', content: [{ type: 'text', text: 'a tool said something' }] },
    ]
}

test('the hook appends only to the latest user message', t => {
    const { store, cwd } = seedCorpus(t)
    const pi = fakePi()
    installMentionHook(pi.api, store)

    const messages = conversation('grafana shared widget')
    const before = structuredClone(messages)
    const target = messages[2]
    const result = pi.emit('context', { type: 'context', messages }, { cwd })

    assert.equal(result, undefined, 'the hook must not replace the message list')
    // Untouched: every other message is deep-equal to the snapshot.
    assert.deepEqual(messages[0], before[0])
    assert.deepEqual(messages[1], before[1])
    assert.deepEqual(messages[3], before[3], 'the tool result was rewritten')
    // The latest user message gained the line and nothing else changed in it.
    assert.equal(
        messages[2].content,
        `${before[2].content}\n\n${MENTION_PREFIX}notes/topic07, notes/topic00, notes/topic01`
    )
    // The message object is the same one the host passed: keeping its identity is how
    // the hook avoids making the host rebuild its system-message layout.
    assert.equal(messages[2], target)
})

test('the hook leaves the conversation untouched when nothing clears the floor', t => {
    const { store, cwd } = seedCorpus(t)
    const pi = fakePi()
    installMentionHook(pi.api, store)

    const messages = conversation('common')
    const before = structuredClone(messages)
    pi.emit('context', { type: 'context', messages }, { cwd })

    assert.deepEqual(messages, before)
})

test('the hook never appends to a non-user message', t => {
    const { store, cwd } = seedCorpus(t)
    const pi = fakePi()
    installMentionHook(pi.api, store)

    // No user turn at all: nothing may be rewritten.
    const onlyAssistant: ContextMessageLike[] = [
        { role: 'assistant', content: [{ type: 'text', text: 'grafana grafana' }] },
        { role: 'toolResult', content: 'grafana grafana' },
    ]
    const before = structuredClone(onlyAssistant)
    pi.emit('context', { type: 'context', messages: onlyAssistant }, { cwd })
    assert.deepEqual(onlyAssistant, before)
})

test('a content-block user message gains one text block', t => {
    const { store, cwd } = seedCorpus(t)
    const pi = fakePi()
    installMentionHook(pi.api, store)

    const messages: ContextMessageLike[] = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'look at the grafana shared widget' },
                { type: 'image', text: undefined },
            ],
        },
    ]
    const before = structuredClone(messages)
    pi.emit('context', { type: 'context', messages }, { cwd })

    const content = messages[0].content
    assert.ok(Array.isArray(content))
    assert.equal(content.length, 3)
    assert.deepEqual(
        content[0],
        (before[0].content as unknown[])[0],
        'the original block changed'
    )
    assert.deepEqual(
        content[1],
        (before[0].content as unknown[])[1],
        'the image block changed'
    )
    assert.deepEqual(content[2], {
        type: 'text',
        text: `\n\n${MENTION_PREFIX}notes/topic07, notes/topic00, notes/topic01`,
    })
})

test('the same message is detected and logged once per distinct text', t => {
    const { root, store, cwd } = seedCorpus(t)
    const pi = fakePi()
    installMentionHook(pi.api, store)

    // The `context` hook fires before every LLM request, so a long turn asks the same
    // question many times; the decision (and its two log lines) must not repeat.
    pi.emit('context', { type: 'context', messages: conversation('grafana') }, { cwd })
    pi.emit('context', { type: 'context', messages: conversation('grafana') }, { cwd })
    assert.equal(searchDecisions(root).length, 1, 'the repeated request was logged again')

    pi.emit(
        'context',
        { type: 'context', messages: conversation('grafana shared widget') },
        { cwd }
    )
    assert.equal(searchDecisions(root).length, 2)
})

test('the hook tolerates a store that has not opened yet', () => {
    const pi = fakePi()
    installMentionHook(pi.api, () => undefined)

    const messages = conversation('grafana')
    const before = structuredClone(messages)
    assert.equal(
        pi.emit('context', { type: 'context', messages }, { cwd: os.tmpdir() }),
        undefined
    )
    assert.deepEqual(messages, before)
})
