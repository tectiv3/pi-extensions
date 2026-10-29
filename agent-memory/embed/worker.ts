/**
 * U9's queue (§8): one in-process worker that drains embedding jobs off the write
 * path and writes §4's insert-or-update vectors.
 *
 * The shape is dictated by §3.4 step 7 and §8.1:
 *
 * - The write path never waits. `enqueue` is synchronous, dedupes by
 *   `(scope, project, key)` and keeps only `(scope, project, key, body_hash)` — never
 *   `notes.id`, which every rebuild reassigns.
 * - A job is re-resolved at vector-write time and dropped when its `body_hash` no
 *   longer matches. Without that re-check a queued job would stamp a stale body's
 *   vector onto the current body and set `vec_hash = body_hash`, so §4's re-enqueue
 *   predicate would never notice.
 * - `drain`/`stop` are **self-bounded**. The host awaits shutdown handlers with no
 *   timeout (`runner.ts:262-274`), so an unbounded drain hangs pi. The deadline stops
 *   new batches; the batch already in flight finishes.
 * - A missing embedder is not an error: the probe reports unavailable, the queue is
 *   dropped, and §4's reindex predicate re-enqueues next session. `backfill` is that
 *   same predicate at session start.
 */

import {
    getNoteByKey,
    hasVecTable,
    needsEmbedding,
    transaction,
    writeVector,
} from '../index/notes.ts'
import type { EmbedJob } from '../store/notes.ts'
import type { Store } from '../store/store.ts'
import { embedderAvailable } from './cli.ts'

/** §8.2: `key + "\n" + first 1024 characters of body`, truncated on a word boundary. */
export const EMBED_TEXT_CHARS = 1024
export const DEFAULT_BATCH_SIZE = 16
export const DEFAULT_INTERVAL_MS = 250
/** §8.1's shutdown bound: the host will wait forever, so the worker will not. */
export const DEFAULT_DRAIN_MS = 2_000

/**
 * Batch seam. `null` means the batch produced no vectors at all (binary missing,
 * timeout); `null` inside the array means that one text could not be embedded.
 */
export type EmbedBatch = (
    texts: readonly string[]
) => Promise<ReadonlyArray<Float32Array | null> | null>

export interface EmbedWorkerOptions {
    store: Store
    embed: EmbedBatch
    batchSize?: number
    intervalMs?: number
    /**
     * Availability probe, defaults to the real `embedderAvailable()`. Injected by
     * tests so the worker's behaviour does not depend on a built binary.
     */
    available?: () => boolean
    onWarning?: (message: string) => void
}

export interface DrainResult {
    /** Jobs consumed by this drain (written, dropped as stale, or failed). */
    processed: number
    /** Jobs still queued when the deadline or an unavailable embedder stopped it. */
    remaining: number
    /** `true` when work was still queued because the deadline was reached. */
    timedOut: boolean
}

export interface WorkerStats {
    available: boolean
    /** Cumulative jobs consumed since the worker was created. */
    processed: number
    queued: number
    lastError?: string
}

export interface EmbedWorker {
    /** Fire-and-forget (§3.4 step 7). Deduped by `(scope, project, key)`. */
    enqueue(job: EmbedJob): void
    /** Process the queue now, bounded by `timeoutMs`. */
    drain(timeoutMs: number): Promise<DrainResult>
    /** Stop the interval, then drain with the same bound. */
    stop(timeoutMs?: number): Promise<DrainResult>
    stats(): WorkerStats
}

interface Prepared {
    job: EmbedJob
    key: string
    body: string
}

export function createEmbedWorker(options: EmbedWorkerOptions): EmbedWorker {
    const { store, embed } = options
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE))
    const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS))
    const probe = options.available ?? (() => embedderAvailable())
    const warn = options.onWarning ?? (() => {})

    /** Insertion-ordered, so the queue is FIFO after a dedupe. */
    const queue = new Map<string, EmbedJob>()
    let processed = 0
    let lastError: string | undefined
    let probed = false
    let unavailable = false
    let stopped = false
    let deadlineHit = false
    /** Serialises interval ticks against an explicit drain. */
    let chain: Promise<void> = Promise.resolve()
    let tickQueued = false

    const timer = setInterval(() => {
        if (stopped || tickQueued || queue.size === 0) return
        tickQueued = true
        void enqueueRun().finally(() => {
            tickQueued = false
        })
    }, intervalMs)
    // A worker must never be the reason a process stays alive; `stop` is explicit.
    timer.unref?.()

    function clearTimer(): void {
        clearInterval(timer)
    }

    function isAvailable(): boolean {
        if (unavailable) return false
        if (probed) return true
        probed = true
        let ok: boolean
        try {
            ok = probe()
        } catch {
            ok = false
        }
        if (!ok) {
            unavailable = true
            clearTimer()
            warn('embeddings unavailable (nle-embed missing or unusable); search is BM25-only')
        }
        return ok
    }

    function takeBatch(): EmbedJob[] {
        const jobs: EmbedJob[] = []
        for (const [id, job] of queue) {
            jobs.push(job)
            queue.delete(id)
            if (jobs.length >= batchSize) break
        }
        return jobs
    }

    /** Serialised so an interval tick and a drain never touch the same queue twice. */
    function enqueueRun(deadline?: number): Promise<void> {
        // A tick that was already queued when `stop` landed must not start a fresh
        // unbounded run behind the bounded drain: that would double the shutdown bound.
        if (stopped && deadline === undefined) return chain
        const run = chain.then(() => processQueue(deadline))
        chain = run.then(
            () => undefined,
            () => undefined
        )
        return run
    }

    async function processQueue(deadline?: number): Promise<void> {
        while (queue.size > 0) {
            if (deadline !== undefined && Date.now() >= deadline) {
                deadlineHit = true
                return
            }
            if (!hasVecTableSafe()) {
                // §11's vectorless database: nothing can store a vector, so keep the
                // jobs out of the way until the re-upgrade backfills them.
                queue.clear()
                return
            }
            if (!isAvailable()) {
                queue.clear()
                return
            }
            await runBatch(takeBatch())
        }
    }

    function hasVecTableSafe(): boolean {
        try {
            return hasVecTable(store.db)
        } catch (err) {
            lastError = message(err)
            return false
        }
    }

    /**
     * Re-resolve, re-check, embed the batch once, write each vector under the same
     * hash check. A job is consumed even when it is dropped: the queue is not a
     * retry log, and §4's predicate is what brings a note back.
     */
    async function runBatch(jobs: EmbedJob[]): Promise<void> {
        const prepared: Prepared[] = []
        for (const job of jobs) {
            processed++
            let row
            try {
                row = getNoteByKey(store.db, job.scope, job.project, job.key)
            } catch (err) {
                lastError = message(err)
                continue
            }
            if (row === null) continue
            if (row.body_hash !== job.bodyHash) continue
            prepared.push({ job, key: row.key, body: row.body })
        }
        if (prepared.length === 0) return

        let vectors: ReadonlyArray<Float32Array | null> | null
        try {
            vectors = await embed(prepared.map(entry => embedText(entry.key, entry.body)))
        } catch (err) {
            lastError = message(err)
            warn(`embedding batch failed: ${lastError}`)
            return
        }
        if (vectors === null) {
            lastError = 'embedder returned no vectors'
            return
        }

        prepared.forEach((entry, index) => {
            const vector = vectors?.[index] ?? null
            if (vector === null || vector.length === 0) return
            try {
                // The re-read and the vector write share a transaction, so a body
                // written between the batch read and this write cannot be stamped
                // with the older body's vector.
                transaction(store.db, () => {
                    const current = getNoteByKey(
                        store.db,
                        entry.job.scope,
                        entry.job.project,
                        entry.job.key
                    )
                    if (current === null || current.body_hash !== entry.job.bodyHash) return
                    writeVector(store.db, current.id, vector)
                })
            } catch (err) {
                lastError = message(err)
            }
        })
    }

    function currentStats(): WorkerStats {
        return {
            available: unavailable ? false : probed ? true : isAvailable(),
            processed,
            queued: queue.size,
            ...(lastError === undefined ? {} : { lastError }),
        }
    }

    function drain(timeoutMs: number): Promise<DrainResult> {
        const started = processed
        const deadline = Date.now() + Math.max(0, Math.floor(timeoutMs))
        deadlineHit = false
        return enqueueRun(deadline).then(() => ({
            processed: processed - started,
            remaining: queue.size,
            timedOut: deadlineHit && queue.size > 0,
        }))
    }

    return {
        enqueue(job) {
            if (stopped) return
            queue.set(`${job.scope}\u0000${job.project}\u0000${job.key}`, {
                scope: job.scope,
                project: job.project,
                key: job.key,
                bodyHash: job.bodyHash,
            })
            // Deliberately not started here: a run with no deadline would outlive any
            // `drain(timeoutMs)` that arrives while it is in flight, which is exactly
            // the unbounded shutdown §8.1 forbids. The interval bounds the latency.
        },
        drain,
        async stop(timeoutMs = DEFAULT_DRAIN_MS) {
            stopped = true
            clearTimer()
            return drain(timeoutMs)
        },
        stats() {
            return currentStats()
        },
    }
}

/**
 * §8.2's embed text: the key (a strong topical signal on its own) followed by the
 * note's opening. Truncating at 1024 characters on a word boundary keeps a partial
 * word out of the vector; a body with no whitespace in the window keeps the hard cut
 * because there is no boundary to find.
 */
export function embedText(key: string, body: string): string {
    return `${key}\n${truncateOnWordBoundary(body, EMBED_TEXT_CHARS)}`
}

export function truncateOnWordBoundary(text: string, limit: number): string {
    if (text.length <= limit) return text
    const window = text.slice(0, limit)
    const boundary = Math.max(
        window.lastIndexOf(' '),
        window.lastIndexOf('\n'),
        window.lastIndexOf('\t')
    )
    return boundary > 0 ? window.slice(0, boundary) : window
}

/**
 * Session-start backfill (§4): every note whose vector is absent or built from a
 * different body. Returns how many jobs were enqueued.
 *
 * Skipped entirely when `vec_notes` does not exist: §11's vectorless database cannot
 * store a vector, and enqueueing would spend an embedder spawn to watch every write
 * fail. The re-upgrade path creates the table and calls this next session.
 */
export function backfill(store: Store, worker: EmbedWorker): number {
    if (!hasVecTable(store.db)) return 0
    const rows = needsEmbedding(store.db)
    for (const row of rows) {
        worker.enqueue({
            scope: row.scope,
            project: row.project,
            key: row.key,
            bodyHash: row.body_hash,
        })
    }
    return rows.length
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
