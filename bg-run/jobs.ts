/**
 * Background shell jobs for one pi process. No pi imports, so the lifecycle is
 * testable on its own.
 *
 * Forked from pi-bg-run (huanhc1311, MIT): the widget, panel, persistence and
 * per-project sharing are gone. Jobs live and die with the session that
 * started them; a settled job stays listed only until HISTORY_LIMIT newer ones
 * push it out.
 *
 * A job is its whole process group, not the `sh` that leads it. The leader can
 * exit while a backgrounded child keeps running, or die on SIGTERM while a child
 * ignores it, so a job stays running until the group is empty.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export type JobStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface Job {
    id: string
    label: string
    command: string
    logPath: string
    pid: number
    status: JobStatus
    /** The leader shell's exit code. */
    exitCode: number | null
    startedAt: number
    endedAt: number | null
}

export interface JobManagerOptions {
    runDir: string
    maxRunning?: number
    killTimeoutMs?: number
    /** Called once per job, after it settles. */
    onSettled?: (job: Job) => void
    /** Called after every start and settle. */
    onChange?: () => void
}

const DEFAULT_MAX_RUNNING = 10
const DEFAULT_KILL_TIMEOUT_MS = 10_000
const GROUP_POLL_MS = 100
// After SIGKILL a group still listed (a process in uninterruptible sleep) must not hang shutdown.
const FORCE_SETTLE_AFTER_KILL_MS = 5_000
const HISTORY_LIMIT = 50

export function autoLabel(command: string): string {
    const text = command.trim().replace(/\s+/g, ' ')
    return text.length > 50 ? `${text.slice(0, 47)}...` : text
}

export function formatElapsed(job: Job, now = Date.now()): string {
    const seconds = Math.floor(((job.endedAt ?? now) - job.startedAt) / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// Never signal pid <= 0: kill(-0) is kill(0), which hits pi's own process group.
function signalGroup(pid: number, signal: NodeJS.Signals): void {
    if (pid <= 0) return
    try {
        process.kill(-pid, signal)
    } catch {
        // The group is already gone; falling back to the bare pid could hit a reused one.
    }
}

function groupAlive(pid: number): boolean {
    if (pid <= 0) return false
    try {
        process.kill(-pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

interface JobTimers {
    poll?: ReturnType<typeof setInterval>
    escalate?: ReturnType<typeof setTimeout>
    force?: ReturnType<typeof setTimeout>
}

// pi's crash path exits without session_shutdown, and the jobs are detached
// process groups, so they would outlive it. One hook for the process, however
// many times pi re-runs the extension factory. Best effort: no SIGKILL can follow.
const liveManagers = new Set<JobManager>()
let exitHookInstalled = false

export function terminateAllJobs(): void {
    for (const manager of liveManagers) {
        for (const job of manager.list()) {
            if (job.status === 'running') signalGroup(job.pid, 'SIGTERM')
        }
    }
}

export class JobManager {
    private readonly options: JobManagerOptions
    private readonly jobs = new Map<string, Job>()
    private readonly timers = new Map<string, JobTimers>()
    private readonly leaderExit = new Map<string, number | null>()
    private readonly stopRequested = new Set<string>()
    private readonly waiters = new Map<string, Array<(job: Job) => void>>()
    private nextId = 1

    constructor(options: JobManagerOptions) {
        this.options = options
        liveManagers.add(this)
        if (!exitHookInstalled) {
            exitHookInstalled = true
            process.on('exit', terminateAllJobs)
        }
    }

    start(command: string, label?: string): Job {
        if (!command.trim()) throw new Error('Command cannot be empty')
        const max = this.options.maxRunning ?? DEFAULT_MAX_RUNNING
        if (this.list().filter((job) => job.status === 'running').length >= max) {
            throw new Error(`Max ${max} concurrent jobs. Use bg_kill to free a slot.`)
        }

        fs.mkdirSync(this.options.runDir, { recursive: true, mode: 0o700 })
        const id = `bg_${this.nextId++}`
        const logPath = path.join(this.options.runDir, `${id}.log`)
        // Exclusive and private: the output can carry secrets, and 'w' would follow a planted symlink.
        const logFd = fs.openSync(logPath, 'wx', 0o600)
        let child: ReturnType<typeof spawn>
        try {
            child = spawn('sh', ['-c', command], {
                detached: true,
                stdio: ['ignore', logFd, logFd],
            })
        } finally {
            fs.closeSync(logFd)
        }
        // A failed spawn reports on 'error' a tick later and leaves pid undefined.
        child.once('error', () => undefined)
        if (child.pid === undefined) throw new Error(`Failed to start: ${command}`)

        const job: Job = {
            id,
            label: label?.trim() || autoLabel(command),
            command,
            logPath,
            pid: child.pid,
            status: 'running',
            exitCode: null,
            startedAt: Date.now(),
            endedAt: null,
        }
        this.jobs.set(id, job)
        this.timers.set(id, {})
        child.once('close', (code) => this.onLeaderExit(id, code))
        this.trimHistory()
        this.options.onChange?.()
        return job
    }

    get(id: string): Job | undefined {
        return this.jobs.get(id)
    }

    list(): Job[] {
        return [...this.jobs.values()]
    }

    /**
     * SIGTERM the job's process group, SIGKILL after the timeout. Resolves once the
     * whole group has exited, or when the post-SIGKILL grace runs out.
     */
    stop(id: string): Promise<Job> {
        const job = this.jobs.get(id)
        if (!job) return Promise.reject(new Error(`Job ${id} not found`))
        if (job.status !== 'running') {
            return Promise.reject(new Error(`Job ${id} is not running (${job.status})`))
        }
        const settled = new Promise<Job>((resolve) => {
            const waiting = this.waiters.get(id) ?? []
            waiting.push(resolve)
            this.waiters.set(id, waiting)
        })
        if (!this.stopRequested.has(id)) {
            this.stopRequested.add(id)
            signalGroup(job.pid, 'SIGTERM')
            const timers = this.timers.get(id)
            if (timers) {
                timers.escalate = setTimeout(() => {
                    signalGroup(job.pid, 'SIGKILL')
                    timers.force = setTimeout(() => this.settle(id), FORCE_SETTLE_AFTER_KILL_MS)
                    timers.force.unref()
                }, this.options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS)
                timers.escalate.unref()
            }
            this.pollGroup(id)
        }
        return settled
    }

    /** Stop every running job; the session is ending. */
    async shutdown(): Promise<void> {
        const running = this.list().filter((job) => job.status === 'running')
        await Promise.all(running.map((job) => this.stop(job.id).catch(() => undefined)))
        liveManagers.delete(this)
    }

    private onLeaderExit(id: string, code: number | null): void {
        this.leaderExit.set(id, code)
        this.pollGroup(id)
    }

    // The leader's exit does not end the job: children may outlive it.
    private pollGroup(id: string): void {
        const job = this.jobs.get(id)
        const timers = this.timers.get(id)
        if (!job || !timers || job.status !== 'running') return
        if (!groupAlive(job.pid)) {
            this.settle(id)
            return
        }
        // Only watch once something has asked for it: a live leader reports through 'close'.
        if (!timers.poll && (this.leaderExit.has(id) || this.stopRequested.has(id))) {
            timers.poll = setInterval(() => this.pollGroup(id), GROUP_POLL_MS)
            timers.poll.unref()
        }
    }

    private settle(id: string): void {
        const job = this.jobs.get(id)
        if (!job || job.status !== 'running') return
        const timers = this.timers.get(id)
        if (timers) {
            clearInterval(timers.poll)
            clearTimeout(timers.escalate)
            clearTimeout(timers.force)
        }
        this.timers.delete(id)
        const code = this.leaderExit.get(id) ?? null
        this.leaderExit.delete(id)
        job.exitCode = code
        job.endedAt = Date.now()
        if (this.stopRequested.delete(id)) job.status = 'killed'
        else job.status = code === 0 ? 'completed' : 'failed'
        for (const resolve of this.waiters.get(id) ?? []) resolve(job)
        this.waiters.delete(id)
        this.options.onSettled?.(job)
        this.options.onChange?.()
    }

    private trimHistory(): void {
        const settled = this.list().filter((job) => job.status !== 'running')
        for (const job of settled.slice(0, Math.max(0, settled.length - HISTORY_LIMIT))) {
            this.jobs.delete(job.id)
        }
    }
}
