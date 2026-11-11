import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, test } from 'node:test'
import { JobManager, terminateAllJobs, type Job } from './jobs.ts'

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

function groupExists(pid: number): boolean {
    try {
        process.kill(-pid, 0)
        return true
    } catch {
        return false
    }
}

test('stop keeps escalating when a child ignores SIGTERM after the shell is gone', async () => {
    const { manager } = create({ killTimeoutMs: 300 })
    const job = manager.start(
        `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"; echo done`
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    const stopped = await manager.stop(job.id)
    assert.equal(stopped.status, 'killed')
    assert.equal(groupExists(job.pid), false)
})

test('a backgrounded child keeps the job running after the shell exits', async () => {
    const { manager, settled } = create()
    const job = manager.start('sleep 60 & echo started')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(manager.get(job.id)?.status, 'running')
    assert.equal(settled.length, 0)
    const stopped = await manager.stop(job.id)
    assert.equal(stopped.status, 'killed')
    assert.equal(groupExists(job.pid), false)
})

test('a job whose shell and children exit on their own settles by the leader exit code', async () => {
    const { manager, settled } = create()
    const job = manager.start('sleep 0.2 & wait; exit 4')
    await until(() => settled.length === 1)
    assert.equal(manager.get(job.id)?.status, 'failed')
    assert.equal(manager.get(job.id)?.exitCode, 4)
})

test('backgrounded children count toward the running limit and are stopped at shutdown', async () => {
    const { manager } = create({ maxRunning: 1 })
    const job = manager.start('sleep 60 & echo started')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.throws(() => manager.start('true'), /Max 1/)
    await manager.shutdown()
    assert.equal(groupExists(job.pid), false)
})

test('settled history keeps the newest 50 and never drops a running job', async () => {
    const { manager, settled } = create({ maxRunning: 100 })
    const running = manager.start('sleep 60')
    for (let index = 0; index < 55; index += 1) manager.start('true')
    await until(() => settled.length === 55)
    manager.start('true')
    const ids = manager.list().map((job) => job.id)
    assert.ok(ids.includes(running.id))
    assert.equal(manager.list().filter((job) => job.status !== 'running').length <= 51, true)
    assert.equal(ids.includes('bg_2'), false)
})

test('logs are private', () => {
    const { manager } = create()
    const job = manager.start('true')
    assert.equal(fs.statSync(job.logPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(job.logPath)).mode & 0o777, 0o700)
})

test('a pre-planted log path is refused instead of followed', () => {
    const { manager } = create()
    const runDir = dirs.at(-1)!
    const target = path.join(runDir, 'victim.txt')
    fs.writeFileSync(target, 'keep')
    fs.symlinkSync(target, path.join(runDir, 'bg_1.log'))
    assert.throws(() => manager.start('echo overwritten'), /EEXIST/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep')
})

test('terminateAllJobs signals every running group once', async () => {
    const { manager } = create()
    const job = manager.start('sleep 60')
    terminateAllJobs()
    await until(() => manager.get(job.id)?.status !== 'running', 3000).catch(() => undefined)
    assert.equal(groupExists(job.pid), false)
})
