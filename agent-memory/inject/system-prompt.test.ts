import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { MEMORY_INDEX_SECTION, installIndexSection } from './system-prompt.ts'

interface Handler {
    (event: unknown, ctx?: unknown): unknown
}

/** The only part of `ExtensionAPI` this module touches. */
function fakePi(): {
    api: ExtensionAPI
    emit(event: string, payload: unknown): unknown
} {
    const handlers = new Map<string, Handler>()
    const api = {
        on(event: string, handler: Handler) {
            handlers.set(event, handler)
            return () => {}
        },
    } as unknown as ExtensionAPI
    return {
        api,
        emit(event, payload) {
            const handler = handlers.get(event)
            assert.ok(handler !== undefined, `no handler registered for ${event}`)
            return handler(payload)
        },
    }
}

/** A normalized options object, as `normalizeBuildSystemPromptOptions` builds it. */
function options(sections: Record<string, string> = {}): {
    systemPromptOptions: { sections: Record<string, string> }
} {
    return { systemPromptOptions: { sections } }
}

test('the section is written in place and the hook returns nothing', () => {
    const pi = fakePi()
    installIndexSection(pi.api, () => 'scope: global\nauth/session')

    const event = options()
    const result = pi.emit('before_agent_start', event)

    assert.equal(result, undefined, 'returning a result sets forceSystemPrompt')
    // Explicitly not `{ systemPrompt }`: the host turns that into `forceSystemPrompt`,
    // which discards every other extension's sections (`system-prompt.ts:203`).
    assert.equal((result as { systemPrompt?: string } | undefined)?.systemPrompt, undefined)
    assert.deepEqual(event.systemPromptOptions.sections, {
        [MEMORY_INDEX_SECTION]: 'scope: global\nauth/session',
    })
})

test('the section is added on every run, even when the options object is new', () => {
    const pi = fakePi()
    let block = 'scope: global\nfirst'
    installIndexSection(pi.api, () => block)

    const first = options()
    pi.emit('before_agent_start', first)
    assert.equal(
        first.systemPromptOptions.sections[MEMORY_INDEX_SECTION],
        'scope: global\nfirst'
    )

    // The host normalizes a fresh options object per run (`runner.ts:1431`), so a
    // section written to the previous run's object is gone by the next one.
    block = 'scope: global\nsecond'
    const second = options()
    pi.emit('before_agent_start', second)
    assert.equal(
        second.systemPromptOptions.sections[MEMORY_INDEX_SECTION],
        'scope: global\nsecond'
    )
})

test('an empty block adds no section and leaves other sections alone', () => {
    const pi = fakePi()
    let block = ''
    installIndexSection(pi.api, () => block)

    const empty = options({ preamble: 'other extension' })
    pi.emit('before_agent_start', empty)
    assert.equal(MEMORY_INDEX_SECTION in empty.systemPromptOptions.sections, false)
    assert.deepEqual(empty.systemPromptOptions.sections, { preamble: 'other extension' })

    block = 'scope: global\nauth/session'
    const filled = options({ preamble: 'other extension', skills: '<skills>\nx\n</skills>' })
    pi.emit('before_agent_start', filled)
    assert.deepEqual(filled.systemPromptOptions.sections, {
        preamble: 'other extension',
        skills: '<skills>\nx\n</skills>',
        [MEMORY_INDEX_SECTION]: 'scope: global\nauth/session',
    })
})

test('a missing sections object is skipped rather than thrown', () => {
    const pi = fakePi()
    installIndexSection(pi.api, () => 'scope: global\nauth/session')

    // A host that stops normalizing `sections` must not make another extension's turn
    // fail: this hook runs inside the shared `before_agent_start` loop.
    assert.equal(pi.emit('before_agent_start', { systemPromptOptions: {} }), undefined)
    assert.equal(pi.emit('before_agent_start', {}), undefined)
})
