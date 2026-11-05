import assert from 'node:assert/strict'
import test from 'node:test'
import {
    asyncRunToken,
    buildTerminalNotice,
    emitTerminalNotice,
    type SubagentTerminalNotice,
} from './async-notice.ts'

const SUBAGENTS_DIR = '/home/u/.pi/agent/subagents'
const RUN_ID = '0195f2c4-7b1e-7c3a-9f21-8d0e6a4b2c11'
const TOKEN = `${SUBAGENTS_DIR}/${RUN_ID}.async`

// Copied from the consuming adapter (Paseo pi-subagents: `noticeStatus`), so a
// wording change here fails instead of silently stranding the run as running.
const HEADER = /^(?:Background task|Detached foreground task) (completed|failed|stopped): \*\*/
const TOKEN_LINE = /^Retention-managed async directory: (.+)$/

function trackerOutcome(notice: SubagentTerminalNotice): string | undefined {
    const lines = notice.content.split('\n')
    const outcome = lines[0]?.match(HEADER)?.[1]
    if (outcome === 'stopped') return 'canceled'
    return outcome
}

function tokenFrom(notice: SubagentTerminalNotice): string | undefined {
    for (const line of notice.content.split('\n')) {
        const match = line.match(TOKEN_LINE)
        if (match) return match[1]
    }
    return undefined
}

test('asyncRunToken derives the token from the run id alone', () => {
    assert.equal(asyncRunToken(SUBAGENTS_DIR, RUN_ID), TOKEN)
    assert.equal(asyncRunToken('/d', 'a'), '/d/a.async')
})

test('success emits the exact tracker payload', () => {
    const notice = buildTerminalNotice({
        agent: 'scout',
        status: 'succeeded',
        asyncToken: TOKEN,
    })
    assert.deepEqual(notice, {
        customType: 'subagent-notify',
        content:
            `Background task completed: **scout**\n\n` +
            `Retention-managed async directory: ${TOKEN}`,
        display: false,
    })
    assert.equal(trackerOutcome(notice), 'completed')
    assert.equal(tokenFrom(notice), TOKEN)
})

test('error emits a failed payload', () => {
    const notice = buildTerminalNotice({ agent: 'scout', status: 'failed', asyncToken: TOKEN })
    assert.equal(
        notice.content,
        `Background task failed: **scout**\n\nRetention-managed async directory: ${TOKEN}`
    )
    assert.equal(trackerOutcome(notice), 'failed')
    assert.equal(tokenFrom(notice), TOKEN)
})

test('cancellation emits a stopped payload the tracker maps to canceled', () => {
    const notice = buildTerminalNotice({
        agent: 'scout',
        status: 'aborted',
        asyncToken: TOKEN,
    })
    assert.equal(
        notice.content,
        `Background task stopped: **scout**\n\nRetention-managed async directory: ${TOKEN}`
    )
    assert.equal(trackerOutcome(notice), 'canceled')
    assert.equal(tokenFrom(notice), TOKEN)
})

test('every terminal status is emitted, unhidden, once per call', () => {
    for (const status of ['succeeded', 'failed', 'aborted'] as const) {
        const sent: Array<{ customType: string; content: string; display: boolean }> = []
        const emitted = emitTerminalNotice(
            { sendMessage: message => sent.push(message) },
            buildTerminalNotice({ agent: 'scout', status, asyncToken: TOKEN })
        )
        assert.equal(emitted, true)
        assert.equal(sent.length, 1)
        assert.equal(sent[0].customType, 'subagent-notify')
        assert.equal(sent[0].display, false)
        assert.equal(
            trackerOutcome(sent[0] as SubagentTerminalNotice),
            trackerOutcome(buildTerminalNotice({ agent: 'scout', status, asyncToken: TOKEN }))
        )
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
                sendMessage: () => {
                    throw new Error('host not ready')
                },
            },
            notice
        ),
        false
    )
})
