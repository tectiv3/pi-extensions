import assert from 'node:assert/strict'
import test from 'node:test'
import {
    askWithDeadline,
    DEFAULT_TIMEOUT_MS,
    formatDuration,
    recommendedAnswers,
    startDeadline,
    subagentQuestionTimeoutMs,
    TYPE_SOMETHING_LABEL,
    type PromptAnswer,
    type PromptQuestion,
    type PromptUi,
} from './timeout.ts'

function question(id: string, labels: string[], allowOther = false): PromptQuestion {
    return {
        id,
        prompt: `prompt ${id}`,
        options: labels.map(label => ({ label, value: label.toLowerCase() })),
        allowOther,
    }
}

interface DialogCall {
    title: string
    options: string[]
    signal?: AbortSignal
    timeout?: number
}

/** A ui whose dialogs resolve through the caller's `answer` callback. */
function fakeUi(
    answer: (
        call: DialogCall,
        kind: 'select' | 'input'
    ) => Promise<string | undefined> | string | undefined
): { ui: PromptUi; calls: DialogCall[] } {
    const calls: DialogCall[] = []
    return {
        ui: {
            select: async (title, options, opts) => {
                const call = { title, options, signal: opts?.signal, timeout: opts?.timeout }
                calls.push(call)
                return answer(call, 'select')
            },
            input: async (title, _defaultValue, opts) => {
                const call = {
                    title,
                    options: [],
                    signal: opts?.signal,
                    timeout: opts?.timeout,
                }
                calls.push(call)
                return answer(call, 'input')
            },
        },
        calls,
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('the budget is only applied to subagent-origin processes', () => {
    assert.equal(subagentQuestionTimeoutMs({}), undefined)
    assert.equal(subagentQuestionTimeoutMs({ PI_SUBAGENT: '0' }), undefined)
    assert.equal(subagentQuestionTimeoutMs({ PI_SUBAGENT: '1' }), DEFAULT_TIMEOUT_MS)
    assert.equal(DEFAULT_TIMEOUT_MS, 300_000)
})

test('the env budget can shorten, lengthen, or disable the default', () => {
    assert.equal(
        subagentQuestionTimeoutMs({
            PI_SUBAGENT: '1',
            PI_SUBAGENT_QUESTION_TIMEOUT_MS: '1500',
        }),
        1500
    )
    assert.equal(
        subagentQuestionTimeoutMs({
            PI_SUBAGENT: '1',
            PI_SUBAGENT_QUESTION_TIMEOUT_MS: '900000',
        }),
        900_000
    )
    assert.equal(
        subagentQuestionTimeoutMs({ PI_SUBAGENT: '1', PI_SUBAGENT_QUESTION_TIMEOUT_MS: '0' }),
        undefined
    )
    assert.equal(
        subagentQuestionTimeoutMs({ PI_SUBAGENT: '1', PI_SUBAGENT_QUESTION_TIMEOUT_MS: '-5' }),
        undefined
    )
    assert.equal(
        subagentQuestionTimeoutMs({
            PI_SUBAGENT: '1',
            PI_SUBAGENT_QUESTION_TIMEOUT_MS: 'abc',
        }),
        undefined
    )
    assert.equal(
        subagentQuestionTimeoutMs({ PI_SUBAGENT: '1', PI_SUBAGENT_QUESTION_TIMEOUT_MS: '' }),
        undefined
    )
})

test('the deadline fires once and reports elapsed', async () => {
    let fired = 0
    const deadline = startDeadline(20, () => {
        fired++
    })
    assert.ok(deadline)
    assert.equal(deadline.elapsed(), false)
    await sleep(80)
    assert.equal(fired, 1)
    assert.equal(deadline.elapsed(), true)
    deadline.clear()
})

test('clearing the deadline stops it firing', async () => {
    let fired = 0
    const deadline = startDeadline(20, () => {
        fired++
    })
    assert.ok(deadline)
    deadline.clear()
    await sleep(80)
    assert.equal(fired, 0)
    assert.equal(deadline.elapsed(), false)
})

test('no budget means no deadline', () => {
    assert.equal(
        startDeadline(undefined, () => {}),
        undefined
    )
})

test('recommended answers keep real answers and tag only the filled ones', () => {
    const questions = [
        question('Q1', ['a', 'b']),
        question('Q2', ['x', 'y']),
        question('Q3', []),
    ]
    const real: PromptAnswer[] = [
        { id: 'Q2', value: 'y', label: 'y', wasCustom: false, index: 2 },
    ]
    const merged = recommendedAnswers(questions, real)
    assert.deepEqual(merged, [
        { id: 'Q1', value: 'a', label: 'a', wasCustom: false, index: 1, autoAccepted: true },
        { id: 'Q2', value: 'y', label: 'y', wasCustom: false, index: 2 },
    ])
    assert.equal(merged[1].autoAccepted, undefined)
})

test('without a budget the prompt loop behaves as before and passes no timeout', async () => {
    const { ui, calls } = fakeUi(() => 'b')
    const outcome = await askWithDeadline({
        questions: [question('Q1', ['a', 'b'])],
        ui,
        timeoutMs: undefined,
    })
    assert.equal(outcome.kind, 'answered')
    assert.deepEqual(outcome.answers, [
        { id: 'Q1', value: 'b', label: 'b', wasCustom: false, index: 2 },
    ])
    assert.equal(calls[0].timeout, undefined)
    assert.ok(calls[0].signal, 'the run abort signal is still wired')
})

test('the remaining budget is what each dialog is given', async () => {
    const { ui, calls } = fakeUi(() => 'a')
    await askWithDeadline({
        questions: [question('Q1', ['a', 'b']), question('Q2', ['c', 'd'])],
        ui,
        timeoutMs: 60_000,
    })
    assert.equal(calls.length, 2)
    for (const call of calls) {
        assert.ok(
            call.timeout !== undefined && call.timeout > 59_000 && call.timeout <= 60_000,
            `unexpected per-dialog timeout: ${call.timeout}`
        )
    }
})

test('a prompt-wide timeout fills the unanswered questions and aborts the dialog', async () => {
    const answered: DialogCall[] = []
    const { ui } = fakeUi(call => {
        answered.push(call)
        if (call.options.includes('more')) {
            // Second question hangs like an unanswered relayed dialog.
            return new Promise<string | undefined>(resolve => {
                call.signal?.addEventListener('abort', () => resolve(undefined), {
                    once: true,
                })
            })
        }
        return 'yes'
    })

    const started = Date.now()
    const outcome = await askWithDeadline({
        questions: [question('Q1', ['yes', 'no']), question('Q2', ['more', 'less'])],
        ui,
        timeoutMs: 40,
    })
    const elapsed = Date.now() - started

    assert.equal(outcome.kind, 'timed-out')
    assert.ok(elapsed < 5000, `timeout took ${elapsed}ms`)
    assert.deepEqual(outcome.answers, [
        { id: 'Q1', value: 'yes', label: 'yes', wasCustom: false, index: 1 },
        {
            id: 'Q2',
            value: 'more',
            label: 'more',
            wasCustom: false,
            index: 1,
            autoAccepted: true,
        },
    ])
    assert.equal(
        outcome.answers[0].autoAccepted,
        undefined,
        'a real answer must not be tagged'
    )
    assert.equal(answered.length, 2)
    assert.equal(answered[1].signal?.aborted, true)
})

test('an allowOther dialog that times out accepts the first option, not free text', async () => {
    const { ui } = fakeUi(
        call =>
            new Promise<string | undefined>(resolve => {
                call.signal?.addEventListener('abort', () => resolve(undefined), {
                    once: true,
                })
            })
    )
    const outcome = await askWithDeadline({
        questions: [question('Q1', ['first', 'second'], true)],
        ui,
        timeoutMs: 30,
    })
    assert.equal(outcome.kind, 'timed-out')
    assert.deepEqual(outcome.answers, [
        {
            id: 'Q1',
            value: 'first',
            label: 'first',
            wasCustom: false,
            index: 1,
            autoAccepted: true,
        },
    ])
})

test('free text still works through the timeout-enabled loop', async () => {
    const { ui, calls } = fakeUi((_call, kind) =>
        kind === 'select' ? TYPE_SOMETHING_LABEL : 'typed answer'
    )
    const outcome = await askWithDeadline({
        questions: [question('Q1', ['a'], true)],
        ui,
        timeoutMs: 60_000,
    })
    assert.equal(outcome.kind, 'answered')
    assert.deepEqual(outcome.answers, [
        { id: 'Q1', value: 'typed answer', label: 'typed answer', wasCustom: true },
    ])
    assert.equal(calls.length, 2)
    assert.ok(calls[0].options.includes(TYPE_SOMETHING_LABEL))
})

test('a user cancel before the deadline stays a cancel', async () => {
    const { ui } = fakeUi(() => undefined)
    const outcome = await askWithDeadline({
        questions: [question('Q1', ['a'])],
        ui,
        timeoutMs: 60_000,
    })
    assert.equal(outcome.kind, 'cancelled')
})

test('the run abort signal cancels a hanging dialog', async () => {
    const runAbort = new AbortController()
    const { ui } = fakeUi(
        call =>
            new Promise<string | undefined>(resolve => {
                call.signal?.addEventListener('abort', () => resolve(undefined), {
                    once: true,
                })
            })
    )
    setTimeout(() => runAbort.abort(), 20)
    const started = Date.now()
    const outcome = await askWithDeadline({
        questions: [question('Q1', ['a'])],
        ui,
        timeoutMs: 60_000,
        signal: runAbort.signal,
    })
    assert.equal(outcome.kind, 'cancelled')
    assert.ok(Date.now() - started < 5000)
})

test('an already aborted run does not open a dialog', async () => {
    const runAbort = new AbortController()
    runAbort.abort()
    const { ui, calls } = fakeUi(() => 'a')
    const outcome = await askWithDeadline({
        questions: [question('Q1', ['a'])],
        ui,
        timeoutMs: 60_000,
        signal: runAbort.signal,
    })
    assert.equal(outcome.kind, 'cancelled')
    assert.equal(calls.length, 0)
})

test('durations render as the visible note expects', () => {
    assert.equal(formatDuration(300_000), '5m')
    assert.equal(formatDuration(120_000), '2m')
    assert.equal(formatDuration(90_000), '90s')
    assert.equal(formatDuration(750), '750ms')
})
