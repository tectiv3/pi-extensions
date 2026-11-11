/**
 * Background shell jobs: `bg_run`, `bg_list`, `bg_kill`, and a completion
 * message that wakes the agent.
 *
 * Forked from pi-bg-run (huanhc1311, MIT) as a starting point. Jobs belong to
 * the session that started them and are stopped when it ends.
 *
 * Paseo's runtime bridge reads a control service from
 * globalThis[Symbol.for('pi-extensions:bg-run:control')] (version 1) to show
 * and stop jobs without an LLM turn. The symbol string is the contract.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { JobManager, formatElapsed, type Job, type JobStatus } from './jobs.ts'

export const BG_RUN_CONTROL_SYMBOL = Symbol.for('pi-extensions:bg-run:control')

export type BgRunCapability = 'stop'

export interface BgRunControlInfo {
    id: string
    label: string
    command: string
    status: JobStatus
    /** Epoch milliseconds. */
    startedAt: number
    capabilities: BgRunCapability[]
}

export type BgRunControlResult =
    | { ok: true; id: string; status: JobStatus }
    | { ok: false; id: string; reason: string }

export interface BgRunControlService {
    version: 1
    /** This session's jobs, running first-class and recently settled ones. */
    list(): BgRunControlInfo[]
    /** Resolves after the job has exited. */
    stop(id: string): Promise<BgRunControlResult>
    /** Fires after every job start and settle; returns an unsubscribe. */
    subscribe(listener: () => void): () => void
}

const NOTIFY_BATCH_MS = 50

const BgRunParams = Type.Object({
    command: Type.String({ description: 'Shell command to run in the background' }),
    label: Type.Optional(Type.String({ description: 'Short human-readable label' })),
})

const BgKillParams = Type.Object({
    job_id: Type.String({ description: 'Job id, e.g. bg_1' }),
})

function textResult(text: string, details?: unknown) {
    return { content: [{ type: 'text', text }], details }
}

function describeJob(job: Job): string {
    const outcome =
        job.status === 'running'
            ? 'running'
            : job.status === 'killed'
              ? 'killed'
              : `${job.status} (exit ${job.exitCode})`
    return `[${job.id}] ${job.label} — ${outcome}, ${formatElapsed(job)}\n    log: ${job.logPath}`
}

function describeJobs(jobs: Job[]): string {
    if (jobs.length === 0) return 'No background jobs. Use bg_run to start one.'
    return jobs.map(describeJob).join('\n')
}

function completionMessage(jobs: Job[]): string {
    const lines = jobs.map((job) => describeJob(job))
    const head =
        jobs.length === 1
            ? 'Background job finished:'
            : `${jobs.length} background jobs finished:`
    return `${head}\n${lines.join('\n')}\n\nRead the log to see the output.`
}

export default function bgRun(pi: ExtensionAPI) {
    let manager: JobManager | undefined
    // The dead session's jobs settle while it shuts down; they must not wake the new one.
    let quiet = false
    let pendingNotify: Job[] = []
    let notifyTimer: ReturnType<typeof setTimeout> | undefined
    const listeners = new Set<() => void>()

    const flushNotifications = () => {
        notifyTimer = undefined
        const jobs = pendingNotify
        pendingNotify = []
        if (jobs.length === 0) return
        try {
            pi.sendUserMessage(completionMessage(jobs), { deliverAs: 'steer' })
        } catch {
            // The session may be ending.
        }
    }

    const createManager = () =>
        new JobManager({
            runDir: path.join(os.tmpdir(), 'bg-run', String(process.pid), String(Date.now())),
            onSettled: (job) => {
                if (quiet || job.status === 'killed') return
                pendingNotify.push(job)
                notifyTimer ??= setTimeout(flushNotifications, NOTIFY_BATCH_MS)
            },
            onChange: () => {
                for (const listener of [...listeners]) {
                    try {
                        listener()
                    } catch {
                        // A bad subscriber must not break job bookkeeping.
                    }
                }
            },
        })

    const requireManager = (): JobManager => {
        if (!manager) throw new Error('bg-run: no active session')
        return manager
    }

    const service: BgRunControlService = {
        version: 1,
        list: () =>
            (manager?.list() ?? []).map((job) => ({
                id: job.id,
                label: job.label,
                command: job.command,
                status: job.status,
                startedAt: job.startedAt,
                capabilities: job.status === 'running' ? ['stop'] : [],
            })),
        async stop(id) {
            try {
                const job = await requireManager().stop(id)
                return { ok: true, id, status: job.status }
            } catch (error) {
                return { ok: false, id, reason: error instanceof Error ? error.message : String(error) }
            }
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
    ;(globalThis as Record<symbol, unknown>)[BG_RUN_CONTROL_SYMBOL] = service

    // pi's crash path exits without session_shutdown, and the jobs are detached
    // process groups, so they would outlive it. Best effort: no SIGKILL can follow.
    process.on('exit', () => {
        for (const job of manager?.list() ?? []) {
            if (job.status !== 'running') continue
            try {
                process.kill(-job.pid, 'SIGTERM')
            } catch {
                // already gone
            }
        }
    })

    pi.registerTool({
        name: 'bg_run',
        label: 'Background Run',
        description:
            'Run a shell command in the background and return immediately with a job id and log path. ' +
            'You are woken with a message when it finishes, so do not poll. Use bg_list to check status and bg_kill to stop it.',
        parameters: BgRunParams,
        async execute(_id, params) {
            const job = requireManager().start(params.command, params.label)
            return textResult(
                `Started ${job.id}: ${job.label}\nCommand: ${job.command}\nLog: ${job.logPath}`,
                { jobId: job.id, logPath: job.logPath }
            )
        },
    })

    pi.registerTool({
        name: 'bg_list',
        label: 'Background List',
        description: 'List background jobs with status, elapsed time and log path.',
        parameters: Type.Object({}),
        async execute() {
            return textResult(describeJobs(requireManager().list()))
        },
    })

    pi.registerTool({
        name: 'bg_kill',
        label: 'Background Kill',
        description:
            'Stop a running background job: SIGTERM, then SIGKILL after 10 seconds. Returns once the job has exited.',
        parameters: BgKillParams,
        async execute(_id, params) {
            const job = await requireManager().stop(params.job_id)
            return textResult(`Stopped ${job.id}: ${job.label}`, { jobId: job.id })
        },
    })

    pi.registerCommand('bg', {
        description: 'List background jobs',
        handler: async (_args, ctx) => {
            ctx.ui.notify(describeJobs(manager?.list() ?? []), 'info')
        },
    })

    pi.on('session_start', () => {
        quiet = false
        manager = createManager()
    })

    pi.on('session_shutdown', async () => {
        const ending = manager
        manager = undefined
        quiet = true
        if (notifyTimer) clearTimeout(notifyTimer)
        notifyTimer = undefined
        pendingNotify = []
        await ending?.shutdown()
    })
}
