/**
 * Background shell jobs for one pi process. No pi imports, so the lifecycle is
 * testable on its own.
 *
 * Forked from pi-bg-run (huanhc1311, MIT): the widget, panel, persistence and
 * per-project sharing are gone. Jobs live and die with the session that
 * started them; a settled job stays listed only until HISTORY_LIMIT newer ones
 * push it out.
 */
import { spawn, type ChildProcess } from 'node:child_process'
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

function signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal)
    } catch {
        try {
            process.kill(pid, signal)
        } catch {
            // already gone
        }
    }
}

export class JobManager {
    private readonly jobs = new Map<string, Job>()
    private readonly children = new Map<string, ChildProcess>()
    private readonly stopRequested = new Set<string>()
    private readonly waiters = new Map<string, Array<(job: Job) => void>>()
    private nextId = 1

    private readonly options: JobManagerOptions

    constructor(options: JobManagerOptions) {
        this.options = options
    }

    start(command: string, label?: string): Job {
        if (!command.trim()) throw new Error('Command cannot be empty')
        const max = this.options.maxRunning ?? DEFAULT_MAX_RUNNING
        if (this.list().filter((job) => job.status === 'running').length >= max) {
            throw new Error(`Max ${max} concurrent jobs. Use bg_kill to free a slot.`)
        }

        fs.mkdirSync(this.options.runDir, { recursive: true })
        const id = `bg_${this.nextId++}`
        const logPath = path.join(this.options.runDir, `${id}.log`)
        const logFd = fs.openSync(logPath, 'w')
        let child: ChildProcess
        try {
            child = spawn('sh', ['-c', command], {
                detached: true,
                stdio: ['ignore', logFd, logFd],
            })
        } finally {
            fs.closeSync(logFd)
        }

        const job: Job = {
            id,
            label: label?.trim() || autoLabel(command),
            command,
            logPath,
            pid: child.pid ?? 0,
            status: 'running',
            exitCode: null,
            startedAt: Date.now(),
            endedAt: null,
        }
        this.jobs.set(id, job)
        this.children.set(id, child)
        child.once('error', () => this.settle(id, 1))
        child.once('close', (code) => this.settle(id, code))
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

    /** SIGTERM the job's process group, SIGKILL after the timeout. Resolves once it has exited. */
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
            const escalate = setTimeout(
                () => signalGroup(job.pid, 'SIGKILL'),
                this.options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS
            )
            escalate.unref()
            void settled.then(() => clearTimeout(escalate))
        }
        return settled
    }

    /** Stop every running job; the session is ending. */
    async shutdown(): Promise<void> {
        const running = this.list().filter((job) => job.status === 'running')
        await Promise.all(running.map((job) => this.stop(job.id).catch(() => undefined)))
    }

    private settle(id: string, code: number | null): void {
        const job = this.jobs.get(id)
        if (!job || job.status !== 'running') return
        this.children.delete(id)
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
