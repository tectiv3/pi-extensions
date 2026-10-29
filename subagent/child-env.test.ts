import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'
import { childEnv, MEMORY_SUBAGENT_ENV, spawnChild } from './child-env.ts'

/** The marker is process-global; a test that leaves it set changes later tests' gate. */
function withoutMarker<T>(fn: () => T): T {
    const saved = process.env[MEMORY_SUBAGENT_ENV]
    delete process.env[MEMORY_SUBAGENT_ENV]
    try {
        return fn()
    } finally {
        if (saved !== undefined) process.env[MEMORY_SUBAGENT_ENV] = saved
    }
}

function collected(proc: ChildProcess): Promise<{ stdout: string; code: number | null }> {
    let stdout = ''
    proc.stdout?.on('data', chunk => (stdout += String(chunk)))
    return new Promise((resolve, reject) => {
        proc.on('error', reject)
        proc.on('close', code => resolve({ stdout, code }))
    })
}

test('childEnv marks the child and copies the parent environment', () => {
    withoutMarker(() => {
        const env = childEnv()
        assert.equal(env[MEMORY_SUBAGENT_ENV], '1')
        for (const key of Object.keys(process.env)) assert.equal(env[key], process.env[key])
    })
})

test('childEnv mutates neither the environment it was given nor the parent process', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/bin', PI_MEMORY_DIR: '/tmp/store' }
    const env = childEnv(source)
    assert.deepEqual(source, { PATH: '/bin', PI_MEMORY_DIR: '/tmp/store' })
    assert.equal(env.PATH, '/bin')
    assert.equal(env.PI_MEMORY_DIR, '/tmp/store')
    withoutMarker(() => assert.equal(process.env[MEMORY_SUBAGENT_ENV], undefined))
})

test('spawnChild hands the marker to a real child process', async () => {
    const saved = process.env[MEMORY_SUBAGENT_ENV]
    delete process.env[MEMORY_SUBAGENT_ENV]
    try {
        const script = `process.stdout.write(String(process.env.${MEMORY_SUBAGENT_ENV}))`
        const { stdout, code } = await collected(
            spawnChild(process.execPath, ['-e', script], process.cwd())
        )
        assert.equal(code, 0)
        // '1', not 'undefined': the parent had no marker, so only spawnChild can have set it.
        assert.equal(stdout, '1')
    } finally {
        if (saved === undefined) delete process.env[MEMORY_SUBAGENT_ENV]
        else process.env[MEMORY_SUBAGENT_ENV] = saved
    }
})

test('spawnChild forwards argv verbatim and keeps stdio piped', async () => {
    const args = ['--mode', 'rpc', '--model', 'a b', '--session', '/tmp/x.jsonl']
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'
    // `--` ends node's own option parsing so the child sees the argv pi would get.
    const proc = spawnChild(process.execPath, ['-e', script, '--', ...args], process.cwd())
    const { stdout, code } = await collected(proc)
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), args)
    assert.ok(proc.stdin, 'stdin must stay piped: rpc children take newline-delimited JSON')
    assert.ok(proc.stderr, 'stderr must stay piped: it carries the child diagnostics')
})

test('a marked parent produces a marked child, not a doubled marker', () => {
    const saved = process.env[MEMORY_SUBAGENT_ENV]
    process.env[MEMORY_SUBAGENT_ENV] = '1'
    try {
        assert.equal(childEnv()[MEMORY_SUBAGENT_ENV], '1')
    } finally {
        if (saved === undefined) delete process.env[MEMORY_SUBAGENT_ENV]
        else process.env[MEMORY_SUBAGENT_ENV] = saved
    }
})
