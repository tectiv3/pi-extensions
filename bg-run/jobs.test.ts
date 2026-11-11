import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, test } from 'node:test'
import { JobManager, type Job } from './jobs.ts'

const dirs: string[] = []
const managers: JobManager[] = []

function create(overrides: Partial<ConstructorParameters<typeof JobManager>[0]> = {}) {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-run-test-'))
    dirs.push(runDir)
    const settled: Job[] = []
    let changes = 0
    const manager = new JobManager({
        runDir,
        killTimeoutMs: 300,
        onSettled: (job) => settled.push(job),
        onChange: () => {
            changes += 1
        },
        ...overrides,
    })
    managers.push(manager)
    return { manager, settled, changes: () => changes }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()))
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('a finished job records its exit code and log', async () => {
    const { manager, settled } = create()
    const job = manager.start('echo hello; exit 3', 'greeter')
    assert.equal(job.status, 'running')
    await until(() => settled.length === 1)
    assert.equal(manager.get(job.id)?.status, 'failed')
    assert.equal(manager.get(job.id)?.exitCode, 3)
    assert.match(fs.readFileSync(job.logPath, 'utf8'), /hello/)
})

test('exit code 0 is completed', async () => {
    const { manager, settled } = create()
    const job = manager.start('true')
    await until(() => settled.length === 1)
    assert.equal(manager.get(job.id)?.status, 'completed')
})

test('stop resolves after the process group exits and marks the job killed', async () => {
    const { manager, settled } = create()
    const job = manager.start('sleep 60 & sleep 60; wait')
    const stopped = await manager.stop(job.id)
    assert.equal(stopped.status, 'killed')
    assert.equal(settled.length, 1)
    assert.throws(() => process.kill(-job.pid, 0))
})

test('stop escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { manager } = create()
    const job = manager.start("trap '' TERM; while true; do sleep 1; done")
    await new Promise((resolve) => setTimeout(resolve, 100))
    const stopped = await manager.stop(job.id)
    assert.equal(stopped.status, 'killed')
})

test('stop rejects unknown and settled jobs', async () => {
    const { manager, settled } = create()
    await assert.rejects(manager.stop('bg_99'), /not found/)
    const job = manager.start('true')
    await until(() => settled.length === 1)
    await assert.rejects(manager.stop(job.id), /not running/)
})

test('concurrent stops of one job resolve together', async () => {
    const { manager } = create()
    const job = manager.start('sleep 60')
    const [a, b] = await Promise.all([manager.stop(job.id), manager.stop(job.id)])
    assert.equal(a.status, 'killed')
    assert.equal(b, a)
})

test('the running limit is enforced and freed by stopping', async () => {
    const { manager } = create({ maxRunning: 1 })
    const first = manager.start('sleep 60')
    assert.throws(() => manager.start('sleep 60'), /Max 1/)
    await manager.stop(first.id)
    manager.start('true')
})

test('empty commands are rejected', () => {
    const { manager } = create()
    assert.throws(() => manager.start('   '), /empty/)
})

test('onChange fires on start and on settle', async () => {
    const { manager, settled, changes } = create()
    manager.start('true')
    assert.equal(changes(), 1)
    await until(() => settled.length === 1)
    assert.equal(changes(), 2)
})

test('shutdown stops every running job', async () => {
    const { manager } = create()
    manager.start('sleep 60')
    manager.start('sleep 60')
    await manager.shutdown()
    assert.ok(manager.list().every((job) => job.status === 'killed'))
})
