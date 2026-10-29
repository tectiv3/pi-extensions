import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { LockTimeoutError } from '../store/git.ts'
import { accessLogLockPath, accessLogPath, accessLogRotatedPath } from '../store/paths.ts'
import {
    type GateContext,
    type GateRequest,
    failClosedMessage,
    isSubagent,
    logUserAccess,
    requestGatedAccess,
    resolveAttempt,
} from './gate.ts'
import {
    appendLog,
    type LogEntry,
    newAttemptId,
    pairAttempts,
    readLog,
    rotateIfNeeded,
} from './log.ts'

const KEY = 'auth/session'
const PROJECT = 'pi-extensions-1a2b3c4d'
const SESSION = 'sess-1'
const PREVIEW_TOKEN = 'preview-token-9f3c'
const PREVIEW = `${PREVIEW_TOKEN} Tokens are refreshed on every request; rotate at 90 days.`

const FAST_RETRY = { retryDelaysMs: [1, 1] }

interface ConfirmCall {
    title: string
    message: string
}

function makeRoot(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-gate-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function ctxWithUI(
    answer: boolean | Error,
    calls: ConfirmCall[] = [],
    sessionId: string | undefined = SESSION
): GateContext {
    return {
        hasUI: true,
        sessionId,
        ui: {
            async confirm(title, message) {
                calls.push({ title, message })
                if (answer instanceof Error) throw answer
                return answer
            },
        },
    }
}

function ensureSubagent(t: TestContext): void {
    const saved = process.env.PI_MEMORY_SUBAGENT
    process.env.PI_MEMORY_SUBAGENT = '1'
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_SUBAGENT
        else process.env.PI_MEMORY_SUBAGENT = saved
    })
}

function gateRequest(root: string): GateRequest {
    return {
        root,
        op: 'read',
        scope: 'project',
        project: PROJECT,
        key: KEY,
        reason: 'checking token refresh policy',
        preview: PREVIEW,
    }
}

function rawLog(root: string): string {
    try {
        return fs.readFileSync(accessLogPath(root), 'utf8')
    } catch {
        return ''
    }
}

function decisions(root: string): (string | undefined)[] {
    return readLog(root).map(entry => entry.decision)
}

test('approval writes pending only; the caller owns the single resolver', async t => {
    const root = makeRoot(t)
    const calls: ConfirmCall[] = []

    const result = await requestGatedAccess(ctxWithUI(true, calls), gateRequest(root))
    const entries = readLog(root)

    // §7.1 gives the gate no way to know whether the mutation lands, so it must not
    // write `approved/ok`: that would be an optimistic claim, and a commit failure
    // would then leave two contradictory resolvers for one attempt.
    assert.equal(entries.length, 1, 'the gate wrote a resolver it cannot know')
    assert.deepEqual(
        entries.map(entry => entry.decision),
        ['pending']
    )
    const [pending] = entries
    assert.match(pending.attempt ?? '', /^[0-9a-f]{16}$/)
    assert.equal(pending.op, 'read')
    assert.equal(pending.initiator, 'agent')
    assert.equal(pending.scope, 'project')
    assert.equal(pending.project, PROJECT)
    assert.equal(pending.key, KEY)
    assert.equal(pending.session, SESSION)
    assert.equal(pending.reason, 'checking token refresh policy')
    assert.equal(typeof pending.ts, 'string')

    assert.equal(result.allowed, true)
    assert.equal(result.allowed ? result.attempt : null, pending.attempt)

    assert.equal(calls.length, 1)
    assert.ok(calls[0].message.includes(KEY))
    assert.ok(calls[0].message.includes(PREVIEW_TOKEN))
    // The preview is gated content: shown, never logged.
    assert.equal(rawLog(root).includes(PREVIEW_TOKEN), false)

    // What the caller's `finally` does; the pair is exactly two lines.
    resolveAttempt(root, pending.attempt ?? '', 'approved', 'ok')
    const resolved = readLog(root)
    assert.equal(resolved.length, 2, 'a successful gated operation is two lines')
    assert.deepEqual(
        resolved.map(entry => entry.decision),
        ['pending', 'approved']
    )
    assert.equal(resolved[1].attempt, pending.attempt)
    assert.equal(resolved[1].result, 'ok')
})

test('decline writes pending then declined and leaks no body text', async t => {
    const root = makeRoot(t)
    const calls: ConfirmCall[] = []

    const result = await requestGatedAccess(ctxWithUI(false, calls), gateRequest(root))

    assert.deepEqual(decisions(root), ['pending', 'declined'])
    assert.equal(readLog(root).length, 2, 'a declined gate attempt is two lines')
    assert.equal(result.allowed, false)
    assert.equal(result.allowed ? null : result.code, 'declined')
    assert.equal(readLog(root)[1].result, undefined)
    assert.equal(rawLog(root).includes(PREVIEW_TOKEN), false)
    assert.ok(calls[0].message.includes(PREVIEW_TOKEN))
})

test('no UI fails closed as denied-no-ui', async t => {
    const root = makeRoot(t)
    let confirmed = false
    const ctx: GateContext = {
        hasUI: false,
        sessionId: SESSION,
        ui: {
            async confirm() {
                confirmed = true
                return true
            },
        },
    }

    const result = await requestGatedAccess(ctx, gateRequest(root))

    assert.deepEqual(decisions(root), ['pending', 'denied-no-ui'])
    assert.equal(readLog(root).length, 2, 'a fail-closed attempt is two lines')
    assert.equal(result.allowed, false)
    assert.equal(result.allowed ? null : result.code, 'denied-no-ui')
    assert.equal(confirmed, false)
    // §7.3 verbatim, em dash included.
    assert.equal(
        failClosedMessage(KEY),
        "gated note 'auth/session'; no UI available to confirm — use /memory show"
    )
})

test('subagent is blocked before hasUI is consulted', async t => {
    const root = makeRoot(t)
    ensureSubagent(t)
    assert.equal(isSubagent(), true)

    // hasUI is true in RPC mode, which is what subagents use (§5.3); a confirm
    // reaching this stub would prove the ordering wrong.
    let confirmed = false
    const ctx: GateContext = {
        hasUI: true,
        sessionId: SESSION,
        ui: {
            async confirm() {
                confirmed = true
                return true
            },
        },
    }

    const result = await requestGatedAccess(ctx, gateRequest(root))

    assert.deepEqual(decisions(root), ['pending', 'blocked-subagent'])
    assert.equal(readLog(root).length, 2, 'a subagent block is two lines')
    assert.equal(result.allowed, false)
    assert.equal(result.allowed ? null : result.code, 'blocked-subagent')
    assert.equal(confirmed, false)
})

test('a throwing confirm is logged as error, not declined', async t => {
    const root = makeRoot(t)

    const result = await requestGatedAccess(
        ctxWithUI(new Error('prompt closed')),
        gateRequest(root)
    )

    assert.deepEqual(decisions(root), ['pending', 'error'])
    assert.equal(readLog(root).length, 2, 'a failed confirmation is two lines')
    assert.equal(result.allowed, false)
    assert.equal(result.allowed ? null : result.code, 'error')
    assert.equal(readLog(root)[1].result, undefined)
})

test('an approved-but-failed mutation is pending + approved/failed, never an ok', async t => {
    const root = makeRoot(t)
    const result = await requestGatedAccess(ctxWithUI(true), gateRequest(root))
    assert.equal(result.allowed, true)
    const attempt = result.allowed ? result.attempt : ''

    // §3.4 step 6: the resolver written in the caller's finally is the honest outcome,
    // and it is the only one — there is no optimistic `ok` in front of it.
    resolveAttempt(root, attempt, 'approved', 'failed:other')

    const entries = readLog(root)
    assert.equal(entries.length, 2, 'a failed post-approval mutation is still two lines')
    assert.deepEqual(
        entries.map(entry => entry.decision),
        ['pending', 'approved']
    )
    assert.equal(entries[1].result, 'failed:other')
    assert.equal(
        entries.some(entry => entry.result === 'ok'),
        false,
        'an optimistic ok survived the fix'
    )

    const rows = pairAttempts(entries)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].attempt, attempt)
    assert.equal(rows[0].unresolved, false)
    assert.equal(rows[0].resolver?.result, 'failed:other')
})

test('logUserAccess writes one user line with no reason and no pending', t => {
    const root = makeRoot(t)

    logUserAccess(root, {
        op: 'show',
        scope: 'project',
        project: PROJECT,
        key: KEY,
        session: SESSION,
    })

    assert.equal(rawLog(root).trim().split('\n').length, 1)
    const entries = readLog(root)
    assert.equal(entries.length, 1)
    const [entry] = entries
    assert.equal(entry.initiator, 'user')
    assert.equal(entry.decision, 'user')
    assert.equal(entry.result, 'ok')
    assert.equal(entry.op, 'show')
    assert.equal(entry.key, KEY)
    assert.equal(entry.session, SESSION)
    assert.equal('reason' in (JSON.parse(rawLog(root).trim()) as LogEntry), false)
    assert.equal(
        entries.some(candidate => candidate.decision === 'pending'),
        false
    )
})

test('rotation keeps one generation and readLog concatenates both files', async t => {
    const root = makeRoot(t)

    for (let i = 0; i < 5; i++) {
        appendLog(root, {
            attempt: newAttemptId(),
            op: 'read',
            initiator: 'agent',
            decision: 'pending',
            key: `old/k${i}`,
        })
    }
    const size = fs.statSync(accessLogPath(root)).size

    // Not over the cap: no rotation, no lock.
    assert.equal(rotateIfNeeded(root, size + 1), false)
    assert.equal(fs.existsSync(accessLogRotatedPath(root)), false)

    assert.equal(rotateIfNeeded(root, size - 1), true)
    assert.equal(fs.existsSync(accessLogRotatedPath(root)), true)
    const live = rawLog(root)
    assert.ok(live.includes('{"op":"rotate"}'), 'rotate marker in the live file')

    for (let i = 0; i < 3; i++) {
        appendLog(root, {
            attempt: newAttemptId(),
            op: 'read',
            initiator: 'agent',
            decision: 'pending',
            key: `new/k${i}`,
        })
    }

    const all = readLog(root)
    // 5 rotated + marker + 3 live.
    assert.equal(all.length, 9)
    assert.equal(all[0].key, 'old/k0')
    assert.equal(all[5].op, 'rotate')
    assert.equal(all[8].key, 'new/k2')

    // tail is applied after concatenation, so it spans both files.
    const tail = readLog(root, 7)
    assert.deepEqual(tail, all.slice(-7))
    assert.ok(tail.some(entry => entry.key === 'old/k2'))
    assert.ok(tail.some(entry => entry.key === 'new/k0'))
    assert.ok(readLog(root, 10).length <= 10)
})

test('a pending line in .1 pairs with its resolver in the live file', t => {
    const root = makeRoot(t)
    const attempt = newAttemptId()

    appendLog(root, {
        attempt,
        op: 'read',
        initiator: 'agent',
        decision: 'pending',
        scope: 'global',
        key: KEY,
    })
    const size = fs.statSync(accessLogPath(root)).size
    assert.equal(rotateIfNeeded(root, size - 1), true)
    assert.equal(fs.existsSync(accessLogRotatedPath(root)), true)

    resolveAttempt(root, attempt, 'approved', 'ok')

    const rows = pairAttempts(readLog(root))
    const row = rows.find(candidate => candidate.attempt === attempt)
    assert.ok(row, 'attempt is visible across the rotation boundary')
    assert.equal(row.pending?.key, KEY)
    assert.equal(row.resolver?.decision, 'approved')
    assert.equal(row.unresolved, false)
})

test('the rotation lock takes over a dead pid and treats garbage as held', t => {
    const root = makeRoot(t)
    appendLog(root, { attempt: newAttemptId(), decision: 'pending', op: 'read', key: KEY })
    const size = fs.statSync(accessLogPath(root)).size

    const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid
    assert.equal(typeof dead, 'number')
    assert.throws(
        () => process.kill(dead as number, 0),
        (err: NodeJS.ErrnoException) => err.code === 'ESRCH'
    )
    fs.writeFileSync(accessLogLockPath(root), `${dead} ${Date.now()}\n`)

    assert.equal(rotateIfNeeded(root, size - 1), true)
    assert.equal(fs.existsSync(accessLogLockPath(root)), false)

    const garbageRoot = makeRoot(t)
    appendLog(garbageRoot, {
        attempt: newAttemptId(),
        decision: 'pending',
        op: 'read',
        key: KEY,
    })
    const garbageSize = fs.statSync(accessLogPath(garbageRoot)).size
    fs.writeFileSync(accessLogLockPath(garbageRoot), 'part')

    assert.throws(
        () => rotateIfNeeded(garbageRoot, garbageSize - 1, FAST_RETRY),
        (err: unknown) => err instanceof LockTimeoutError
    )
    assert.equal(fs.existsSync(accessLogRotatedPath(garbageRoot)), false)
    // Held, never stolen: unparsable content must not read as pid 0 (§3.5).
    assert.equal(fs.readFileSync(accessLogLockPath(garbageRoot), 'utf8'), 'part')
})

test('unparsable lines are skipped in both files', t => {
    const root = makeRoot(t)
    const attempt = newAttemptId()

    fs.writeFileSync(
        accessLogRotatedPath(root),
        `${JSON.stringify({ attempt, decision: 'pending', op: 'read' })}\nnot json\n{ half\n`
    )
    appendLog(root, { attempt, decision: 'approved', result: 'ok' })
    fs.appendFileSync(accessLogPath(root), 'garbage after a real line\n')

    const entries = readLog(root)
    assert.deepEqual(
        entries.map(entry => entry.decision),
        ['pending', 'approved']
    )
    assert.equal(pairAttempts(entries)[0].unresolved, false)
})

test('reason is truncated at 500 chars in the log', async t => {
    const root = makeRoot(t)
    const long = 'r'.repeat(800)

    await requestGatedAccess(ctxWithUI(false), { ...gateRequest(root), reason: long })

    assert.equal(readLog(root)[0].reason, 'r'.repeat(500))
})

test('an unresolved pending is reported as such', t => {
    const root = makeRoot(t)
    const dangling = newAttemptId()
    const resolved = newAttemptId()

    appendLog(root, { attempt: dangling, decision: 'pending', op: 'read', key: 'a' })
    appendLog(root, { attempt: resolved, decision: 'pending', op: 'read', key: 'b' })
    resolveAttempt(root, resolved, 'declined')

    const rows = pairAttempts(readLog(root))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].unresolved, true)
    assert.equal(rows[0].resolver, null)
    assert.equal(rows[0].pending?.key, 'a')
    assert.equal(rows[1].unresolved, false)
    assert.equal(rows[1].resolver?.decision, 'declined')
})
