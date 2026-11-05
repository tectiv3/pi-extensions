import assert from 'node:assert/strict'
import test from 'node:test'
import {
    asyncRunToken,
    buildTerminalNotice,
    createTerminalNoticeRenderer,
    emitTerminalNotice,
    type SubagentTerminalNotice,
    type SubagentTerminalNoticeData,
    type TerminalNoticeSink,
    type TerminalRunStatus,
} from './async-notice.ts'

const SUBAGENTS_DIR = '/home/u/.pi/agent/subagents'
const RUN_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2c11'
const TOKEN = `${SUBAGENTS_DIR}/${RUN_ID}.async`

// Copied from the consuming adapter (Paseo pi-subagents: `noticeStatus`), so a
// wording change here fails instead of silently stranding the run as running.
const HEADER = /^(?:Background task|Detached foreground task) (completed|failed|stopped): \*\*/
const TOKEN_LINE = /^Retention-managed async directory: (.+)$/

function trackerOutcome(notice: SubagentTerminalNotice): string | undefined {
    const lines = notice.data.content.split('\n')
    const outcome = lines[0]?.match(HEADER)?.[1]
    if (outcome === 'stopped') return 'canceled'
    return outcome
}

function tokenFrom(notice: SubagentTerminalNotice): string | undefined {
    for (const line of notice.data.content.split('\n')) {
        const match = line.match(TOKEN_LINE)
        if (match) return match[1]
    }
    return undefined
}

const THEME = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
}

const RENDER_OPTIONS = {
    expanded: false,
    keyText: (keybinding: string) => keybinding,
    keyHint: (keybinding: string, description: string) => `${keybinding} ${description}`,
}

// `data` stays unknown so the degrade path can be exercised with the junk a
// hand-edited or foreign session file can hold.
function entryFor(data: unknown) {
    return {
        type: 'custom' as const,
        customType: 'subagent-notify',
        data: data as SubagentTerminalNoticeData | undefined,
        id: 'entry-1',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
    }
}

function render(data: unknown, expanded = false): string[] {
    let captured: string[] = []
    // The host passes pi-tui's Text here (it wraps to the terminal width); the
    // test records the lines the renderer hands over instead.
    const renderer = createTerminalNoticeRenderer(lines => {
        captured = lines
        return { render: () => lines, invalidate: () => {} }
    })
    const component = renderer(entryFor(data), { ...RENDER_OPTIONS, expanded }, THEME)
    assert.ok(component, 'renderer must produce a component')
    assert.ok(captured.length > 0, 'renderer must hand over at least one line')
    return component.render(80)
}

test('asyncRunToken derives the token from the run id alone', () => {
    assert.equal(asyncRunToken(SUBAGENTS_DIR, RUN_ID), TOKEN)
    assert.equal(asyncRunToken('/d', 'a'), '/d/a.async')
})

test('success writes the exact tracker payload as the entry data', () => {
    const notice = buildTerminalNotice({
        agent: 'scout',
        status: 'succeeded',
        asyncToken: TOKEN,
    })
    assert.deepEqual(notice, {
        customType: 'subagent-notify',
        data: {
            agent: 'scout',
            status: 'succeeded',
            asyncToken: TOKEN,
            content:
                `Background task completed: **scout**\n\n` +
                `Retention-managed async directory: ${TOKEN}`,
        },
    })
    assert.equal(trackerOutcome(notice), 'completed')
    assert.equal(tokenFrom(notice), TOKEN)
})

test('error writes a failed payload', () => {
    const notice = buildTerminalNotice({ agent: 'scout', status: 'failed', asyncToken: TOKEN })
    assert.equal(
        notice.data.content,
        `Background task failed: **scout**\n\nRetention-managed async directory: ${TOKEN}`
    )
    assert.equal(trackerOutcome(notice), 'failed')
    assert.equal(tokenFrom(notice), TOKEN)
})

test('cancellation writes a stopped payload the tracker maps to canceled', () => {
    const notice = buildTerminalNotice({
        agent: 'scout',
        status: 'aborted',
        asyncToken: TOKEN,
    })
    assert.equal(
        notice.data.content,
        `Background task stopped: **scout**\n\nRetention-managed async directory: ${TOKEN}`
    )
    assert.equal(trackerOutcome(notice), 'canceled')
    assert.equal(tokenFrom(notice), TOKEN)
})

test('the parent notification rides along without touching the tracker payload', () => {
    const notification = {
        shortId: 'a4b2c11',
        text:
            'Background subagent a4b2c11 (scout) finished.\n\nReport body.\n\n' +
            'Call subagent_collect { id: "a4b2c11" } for the full result.',
    }
    const notice = buildTerminalNotice({
        agent: 'scout',
        status: 'succeeded',
        asyncToken: TOKEN,
        notification,
    })
    assert.deepEqual(notice.data.notification, notification)
    // The tracker payload is untouched: trackers match it verbatim.
    assert.equal(
        notice.data.content,
        `Background task completed: **scout**\n\nRetention-managed async directory: ${TOKEN}`
    )
    // Without it the payload is identical to what earlier hosts wrote.
    assert.equal(
        'notification' in
            buildTerminalNotice({ agent: 'scout', status: 'succeeded', asyncToken: TOKEN })
                .data,
        false
    )
})

test('a malformed notification makes the entry unreadable rather than misleading', () => {
    const lines = render({
        ...buildTerminalNotice({ agent: 'scout', status: 'succeeded', asyncToken: TOKEN })
            .data,
        notification: { shortId: 42 },
    })
    assert.match(lines.join('\n'), /unreadable entry entry-1/)
})

// Compile-time half of the off-context proof: a sink that gained sendMessage
// (or any other context-writing member) would flip this to true and fail tsc.
type SinkWritesContext = 'sendMessage' extends keyof TerminalNoticeSink ? true : false
const sinkWritesContext: SinkWritesContext = false

test('every terminal status is persisted, appendEntry-only, once per call', () => {
    assert.equal(sinkWritesContext, false)
    for (const status of ['succeeded', 'failed', 'aborted'] as const) {
        const notice = buildTerminalNotice({ agent: 'scout', status, asyncToken: TOKEN })
        const written: Array<{ customType: string; data: unknown }> = []
        const sink: TerminalNoticeSink = {
            appendEntry: (customType: string, data?: unknown) =>
                written.push({ customType, data }),
        }
        // The sink is structurally entry-only: there is no sendMessage to call.
        assert.deepEqual(Object.keys(sink), ['appendEntry'])
        assert.equal('sendMessage' in sink, false)

        assert.equal(emitTerminalNotice(sink, notice), true)
        assert.equal(written.length, 1)
        assert.equal(written[0].customType, 'subagent-notify')
        assert.deepEqual(written[0].data, notice.data)
    }
})

test('an absent or rejecting host never throws out of the emit', () => {
    const notice = buildTerminalNotice({
        agent: 'scout',
        status: 'succeeded',
        asyncToken: TOKEN,
    })
    assert.equal(emitTerminalNotice(undefined, notice), false)
    assert.equal(
        emitTerminalNotice(
            {
                appendEntry: () => {
                    throw new Error('host not ready')
                },
            },
            notice
        ),
        false
    )
})

test('the renderer draws the status, the agent and the token for every status', () => {
    const expectedOutcome: Record<TerminalRunStatus, string> = {
        succeeded: 'completed',
        failed: 'failed',
        aborted: 'stopped',
    }
    for (const status of ['succeeded', 'failed', 'aborted'] as const) {
        const data: SubagentTerminalNoticeData = buildTerminalNotice({
            agent: 'scout',
            status,
            asyncToken: TOKEN,
        }).data

        const collapsed = render(data)
        assert.ok(collapsed.length > 0)
        const joined = collapsed.join('\n')
        assert.match(joined, new RegExp(`subagent-notify ${expectedOutcome[status]}: scout`))
        assert.match(joined, new RegExp(`async: ${TOKEN.replace(/\./g, '\\.')}`))

        const expanded = render(data, true)
        assert.ok(expanded.length > collapsed.length, 'expanded adds the tracker payload')
        assert.ok(expanded.join('\n').includes(data.content))
    }
})

test('the renderer degrades instead of throwing on unreadable entry data', () => {
    for (const data of [undefined, null, {}, { agent: 'scout' }, 'garbage']) {
        const lines = render(data)
        assert.ok(lines.length > 0)
        assert.match(lines.join('\n'), /unreadable entry entry-1/)
    }
})
