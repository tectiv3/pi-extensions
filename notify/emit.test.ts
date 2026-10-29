import assert from 'node:assert/strict'
import test from 'node:test'
import { emitNotification, formatNotification, resolveBackend } from './emit.ts'

function fakeStdout(isTTY = true) {
    const chunks: string[] = []
    return {
        chunks,
        stream: {
            isTTY,
            write(chunk: string) {
                chunks.push(chunk)
                return true
            },
        },
    }
}

test('resolveBackend maps ghostty to OSC 777', () => {
    assert.equal(resolveBackend({ TERM_PROGRAM: 'ghostty' }), 'osc777')
})

test('resolveBackend maps documented OSC 9 terminals', () => {
    for (const program of ['iTerm.app', 'WezTerm']) {
        assert.equal(resolveBackend({ TERM_PROGRAM: program }), 'osc9', program)
    }
})

test('resolveBackend refuses unknown, dumb, and CI terminals', () => {
    assert.equal(resolveBackend({}), 'none')
    assert.equal(resolveBackend({ TERM_PROGRAM: 'Apple_Terminal' }), 'none')
    assert.equal(resolveBackend({ TERM_PROGRAM: 'dumb' }), 'none')
    assert.equal(resolveBackend({ TERM: 'xterm-256color', CI: 'true' }), 'none')
})

test('resolveBackend honours PI_NOTIFY_BACKEND over TERM_PROGRAM', () => {
    assert.equal(
        resolveBackend({ TERM_PROGRAM: 'ghostty', PI_NOTIFY_BACKEND: 'osc9' }),
        'osc9'
    )
    assert.equal(
        resolveBackend({ TERM_PROGRAM: 'ghostty', PI_NOTIFY_BACKEND: 'none' }),
        'none'
    )
    assert.equal(
        resolveBackend({ TERM_PROGRAM: 'dumb', PI_NOTIFY_BACKEND: 'osc777' }),
        'osc777'
    )
    assert.equal(resolveBackend({ TERM_PROGRAM: 'dumb', PI_NOTIFY_BACKEND: 'bogus' }), 'none')
})

test('OSC 777 formats title and body', () => {
    assert.equal(
        formatNotification('osc777', { title: 'pi · work', body: 'Done', tmux: false }),
        '\x1b]777;notify;pi · work;Done\x07'
    )
})

test('OSC 777 replaces semicolons in the title but keeps them in the body', () => {
    assert.equal(
        formatNotification('osc777', { title: 'a;b;c', body: 'x;y', tmux: false }),
        '\x1b]777;notify;a,b,c;x;y\x07'
    )
})

test('OSC 777 strips control characters and collapses whitespace', () => {
    assert.equal(
        formatNotification('osc777', {
            title: 'line\x1bone\nline\x07two',
            body: 'a \x1b  b',
            tmux: false,
        }),
        '\x1b]777;notify;line one line two;a b\x07'
    )
})

test('OSC 777 truncates title and body with an ellipsis', () => {
    const title = 'x'.repeat(100)
    const body = 'y'.repeat(250)
    const sequence = formatNotification('osc777', { title, body, tmux: false })
    assert.ok(sequence)
    assert.ok(sequence.includes(`${'x'.repeat(80)}…`))
    assert.ok(sequence.includes(`${'y'.repeat(200)}…`))
    assert.ok(!sequence.includes('x'.repeat(81)))
    assert.ok(!sequence.includes('y'.repeat(201)))
})

test('OSC 9 joins title and body into one line', () => {
    assert.equal(
        formatNotification('osc9', { title: 'pi', body: 'Done', tmux: false }),
        '\x1b]9;pi: Done\x07'
    )
    assert.equal(
        formatNotification('osc9', { title: 'pi', body: '', tmux: false }),
        '\x1b]9;pi\x07'
    )
    assert.equal(
        formatNotification('osc9', { title: 'pi', body: 'line one\nline two', tmux: false }),
        '\x1b]9;pi: line one line two\x07'
    )
})

test('tmux wraps the sequence in DCS passthrough with doubled ESCs', () => {
    assert.equal(
        formatNotification('osc777', { title: 'pi', body: 'Done', tmux: true }),
        '\x1bPtmux;\x1b\x1b]777;notify;pi;Done\x07\x1b\\'
    )
    assert.equal(
        formatNotification('osc9', { title: 'pi', body: 'Done', tmux: true }),
        '\x1bPtmux;\x1b\x1b]9;pi: Done\x07\x1b\\'
    )
})

test('none backend produces nothing', () => {
    assert.equal(
        formatNotification('none', { title: 'pi', body: 'Done', tmux: false }),
        undefined
    )
    assert.equal(
        formatNotification('none', { title: 'pi', body: 'Done', tmux: true }),
        undefined
    )
})

test('emitNotification writes exactly one chunk', () => {
    const { chunks, stream } = fakeStdout()
    emitNotification(
        { title: 'pi', body: 'Done' },
        { env: { TERM_PROGRAM: 'ghostty' }, stdout: stream }
    )
    assert.deepEqual(chunks, ['\x1b]777;notify;pi;Done\x07'])
})

test('emitNotification defaults isTTY from stdout', () => {
    const tty = fakeStdout(true)
    emitNotification(
        { title: 'pi', body: 'Done' },
        { env: { TERM_PROGRAM: 'ghostty' }, stdout: tty.stream }
    )
    assert.equal(tty.chunks.length, 1)

    const pipe = fakeStdout(false)
    emitNotification(
        { title: 'pi', body: 'Done' },
        { env: { TERM_PROGRAM: 'ghostty' }, stdout: pipe.stream }
    )
    assert.equal(pipe.chunks.length, 0)
})

test('emitNotification writes nothing when not a TTY', () => {
    const { chunks, stream } = fakeStdout(true)
    emitNotification(
        { title: 'pi', body: 'Done' },
        { env: { TERM_PROGRAM: 'ghostty' }, stdout: stream, isTTY: false }
    )
    assert.equal(chunks.length, 0)
})

test('emitNotification writes nothing when PI_NOTIFY=0', () => {
    const { chunks, stream } = fakeStdout(true)
    emitNotification(
        { title: 'pi', body: 'Done' },
        { env: { TERM_PROGRAM: 'ghostty', PI_NOTIFY: '0' }, stdout: stream, isTTY: true }
    )
    assert.equal(chunks.length, 0)
})

test('emitNotification writes nothing for an unsupported terminal', () => {
    const { chunks, stream } = fakeStdout(true)
    emitNotification(
        { title: 'pi', body: 'Done' },
        { env: { TERM_PROGRAM: 'Apple_Terminal' }, stdout: stream, isTTY: true }
    )
    assert.equal(chunks.length, 0)
})

test('emitNotification uses tmux passthrough when TMUX is set', () => {
    const { chunks, stream } = fakeStdout(true)
    emitNotification(
        { title: 'pi', body: 'Done' },
        { env: { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-501/default,1,0' }, stdout: stream }
    )
    assert.deepEqual(chunks, ['\x1bPtmux;\x1b\x1b]777;notify;pi;Done\x07\x1b\\'])
})

test('emitNotification omits the body when none is given', () => {
    const { chunks, stream } = fakeStdout(true)
    emitNotification({ title: 'pi' }, { env: { TERM_PROGRAM: 'ghostty' }, stdout: stream })
    assert.deepEqual(chunks, ['\x1b]777;notify;pi;\x07'])
})
