/**
 * The `nle-embed` CLI boundary (§8): one process per **batch**, newline-delimited
 * texts on stdin, one JSON object per line on stdout.
 *
 * Three facts about the CLI's real interface drive this file:
 *
 * - Process startup plus model load costs ~20–30 ms even for one text, and the model
 *   is loaded per process. So the batch is the unit of work: an embed call never
 *   spawns once per text, and the worker hands it up to `batchSize` texts at a time.
 * - stdin is newline-delimited and blank lines are **dropped**, so a text containing
 *   a newline (the worker's `key + "\n" + body`) would split into two inputs and
 *   shift every later vector. Newlines are collapsed before the wire.
 * - A language mismatch exits `2` *after* writing all output, so a non-zero exit is
 *   not by itself a batch failure. The per-line `langCheck` field carries the CLI's
 *   own §8.2 verdict; a hard mismatch drops that one vector and warns instead of
 *   silently embedding garbage.
 *
 * The runner and the probe are injectable so tests can count spawns and supply
 * canned JSONL without a built binary.
 */

import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { EMBED_DIM } from '../index/db.ts'
import type { Embedder } from '../tools/definitions.ts'

export const EMBED_TIMEOUT_MS = 10_000
/** §8.2: the model is English; French emits 640 dims and cannot be stored in `vec0`. */
export const EMBED_LANG = 'en'

export interface EmbedRunRequest {
    bin: string
    args: string[]
    input: string
    timeoutMs: number
}

export interface EmbedRunResult {
    status: number | null
    stdout: string
    stderr: string
    /** `ENOENT` and friends: the binary is missing or not executable. */
    error?: NodeJS.ErrnoException
    timedOut?: boolean
}

export type EmbedRunner = (request: EmbedRunRequest) => Promise<EmbedRunResult>
export type EmbedProbeRunner = (request: EmbedRunRequest) => EmbedRunResult

export interface EmbedOptions {
    /** Explicit binary; otherwise the packaged location, then the prototype. */
    binPath?: string
    timeoutMs?: number
    /** Batch runner seam (async). */
    runner?: EmbedRunner
    /** Synchronous probe seam, used by `embedderAvailable`. */
    probeRunner?: EmbedProbeRunner
    /**
     * Receives CLI warnings and this module's own diagnostics. Never the embedded
     * text: a note body is what §5's gate protects.
     */
    onWarning?: (message: string) => void
}

/** One slot per input text; `null` means that text produced no usable vector. */
export type EmbedVector = Float32Array | null

export interface EmbedLine {
    i?: unknown
    lang?: unknown
    langConfidence?: unknown
    langCheck?: unknown
    dim?: unknown
    vector?: unknown
}

// ---------------------------------------------------------------------------
// binary resolution
// ---------------------------------------------------------------------------

const EXTENSION_DIR: string | null =
    typeof __dirname === 'string' ? path.dirname(__dirname) : null

/**
 * Where the binary may live, in preference order: the env override, the packaged
 * `agent-memory/bin/nle-embed` (U12), then the prototype's build directory so U9
 * works before packaging lands.
 *
 * The anchor is `__dirname`, not `import.meta.url`: pi loads extensions through jiti,
 * which transpiles them to CommonJS and provides `__dirname`. Under Node's native ESM
 * loader (the `node --test` runner) it is absent and there is no directory to anchor
 * on, so `nle-embed` is left to PATH — tests always inject a bin path or a runner.
 */
export function embedBinCandidates(): string[] {
    const override = process.env.PI_MEMORY_EMBED_BIN
    const candidates: Array<string | null> = [
        override !== undefined && override.trim() !== '' ? path.resolve(override) : null,
    ]
    if (EXTENSION_DIR !== null) {
        candidates.push(
            path.join(EXTENSION_DIR, 'bin', 'nle-embed'),
            path.join(EXTENSION_DIR, '..', 'experiments', 'embed', 'bin', 'nle-embed')
        )
    }
    return candidates.filter((candidate): candidate is string => candidate !== null)
}

/** The first existing candidate, or the packaged path so an ENOENT names it. */
export function resolveEmbedBin(explicit?: string): string {
    if (explicit !== undefined && explicit.trim() !== '') return explicit
    const candidates = embedBinCandidates()
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate
    }
    return candidates[0] ?? 'nle-embed'
}

// ---------------------------------------------------------------------------
// process runners
// ---------------------------------------------------------------------------

const defaultRunner: EmbedRunner = request =>
    new Promise<EmbedRunResult>(resolve => {
        const child = spawn(request.bin, request.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false

        const finish = (result: EmbedRunResult): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
        }
        // SIGKILL rather than SIGTERM: the model may be mid-call and the bound matters.
        const timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
        }, request.timeoutMs)

        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', chunk => {
            stdout += chunk
        })
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', chunk => {
            stderr += chunk
        })
        child.on('error', err => {
            finish({ status: null, stdout, stderr, error: err as NodeJS.ErrnoException })
        })
        // EPIPE when the child dies before reading stdin; the close handler decides.
        child.stdin?.on('error', () => {})
        child.stdin?.end(request.input)
        child.on('close', status => {
            finish({ status, stdout, stderr, timedOut })
        })
    })

const defaultProbeRunner: EmbedProbeRunner = request => {
    const result = spawnSync(request.bin, request.args, {
        input: request.input,
        encoding: 'utf8',
        timeout: request.timeoutMs,
        env: { ...process.env },
    })
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.error === undefined
            ? {}
            : { error: result.error as NodeJS.ErrnoException }),
        timedOut: result.signal !== null && result.signal !== undefined,
    }
}

// ---------------------------------------------------------------------------
// availability probe
// ---------------------------------------------------------------------------

const probeCache = new Map<string, boolean>()

/** Clears the per-process probe cache; tests and a rebuilt binary need this. */
export function resetEmbedderProbe(): void {
    probeCache.clear()
}

/**
 * Whether embeddings can be produced at all (§8.1, §12.10). Cached per binary path
 * for the process lifetime, so the worker's per-job check never spawns: without the
 * cache the probe alone would pay the ~20–30 ms process floor on every batch.
 *
 * `fs.access` alone is not enough — a wrong-architecture or broken binary is
 * executable and exits non-zero — so the probe embeds one short text and requires a
 * parseable line with the right dimension.
 */
export function embedderAvailable(options: EmbedOptions = {}): boolean {
    const bin = resolveEmbedBin(options.binPath)
    const cached = probeCache.get(bin)
    if (cached !== undefined) return cached

    const available = probe(bin, options)
    probeCache.set(bin, available)
    return available
}

function probe(bin: string, options: EmbedOptions): boolean {
    // NLEmbedding is an Apple framework; an x86_64 or Linux host has no artefact.
    if (process.platform !== 'darwin') return false
    try {
        fs.accessSync(bin, fs.constants.X_OK)
    } catch {
        return false
    }
    const runner = options.probeRunner ?? defaultProbeRunner
    let result: EmbedRunResult
    try {
        result = runner({
            bin,
            args: ['embed', '--lang', EMBED_LANG],
            input: 'the embedding model is ready\n',
            timeoutMs: options.timeoutMs ?? EMBED_TIMEOUT_MS,
        })
    } catch {
        return false
    }
    if (result.error !== undefined || result.timedOut === true) return false
    // Exit 2 is acceptable here only with a usable line (the mismatch exit is
    // post-output); the vector is what the probe is really after.
    if (result.status !== 0 && result.status !== 2) return false
    return parseLines(result.stdout).some(line => vectorOf(line) !== null)
}

// ---------------------------------------------------------------------------
// batch embedding
// ---------------------------------------------------------------------------

/**
 * Embeds `texts` in one process. Returns an array aligned to `texts`, or `null`
 * when no vector at all could be produced (binary missing, spawn failure, timeout,
 * unusable exit). A per-line failure — garbage JSON, a hard language mismatch, a
 * wrong dimension — yields `null` in that slot only, so alignment survives a partial
 * batch.
 */
export async function embedBatch(
    texts: readonly string[],
    options: EmbedOptions = {}
): Promise<EmbedVector[] | null> {
    if (texts.length === 0) return []
    const warn = options.onWarning ?? (() => {})

    // Index → wire text. Blank texts cannot survive the CLI's blank-line drop, so
    // they are never sent and their slots stay null.
    const payload: Array<{ index: number; text: string }> = []
    texts.forEach((text, index) => {
        const wire = toWireText(text)
        if (wire !== '') payload.push({ index, text: wire })
    })
    const vectors: EmbedVector[] = texts.map(() => null)
    if (payload.length === 0) return vectors

    const bin = resolveEmbedBin(options.binPath)
    const runner = options.runner ?? defaultRunner
    let result: EmbedRunResult
    try {
        result = await runner({
            bin,
            args: ['embed', '--lang', EMBED_LANG],
            input: payload.map(entry => entry.text).join('\n') + '\n',
            timeoutMs: options.timeoutMs ?? EMBED_TIMEOUT_MS,
        })
    } catch (err) {
        warn(`embedder failed to start: ${message(err)}`)
        return null
    }

    if (result.error !== undefined) {
        // ENOENT is the documented BM25-only case, not an error to shout about.
        if (result.error.code !== 'ENOENT') {
            warn(`embedder failed: ${result.error.message}`)
        }
        return null
    }
    if (result.timedOut === true) {
        warn(`embedder timed out after ${options.timeoutMs ?? EMBED_TIMEOUT_MS} ms`)
        return null
    }
    for (const line of warningLines(result.stderr)) warn(line)

    const lines = parseLines(result.stdout)
    // Exit 2 is the CLI's post-output language verdict, so its output is still valid.
    if (result.status !== 0 && result.status !== 2) {
        warn(`embedder exited ${result.status ?? 'without a status'}`)
        return null
    }
    if (lines.length === 0) {
        // Nothing parsed at all: no model, a crash before the first line, or exit 2
        // without output. Any of these is "no embedder", not an empty batch.
        warn('embedder produced no vectors')
        return null
    }

    const parsedByIndex = new Map<number, EmbedLine>()
    let indexed = false
    for (const line of lines) {
        if (typeof line.i !== 'number') continue
        indexed = true
        parsedByIndex.set(line.i, line)
    }

    let failed = 0
    payload.forEach((entry, position) => {
        // `i` is the position among the texts the CLI actually embedded. When every
        // line carries one it is the only safe lookup: a garbage line in the middle
        // must not hand the next line's vector to the wrong text. Positional order is
        // used only for a binary that omits `i` altogether.
        const line = indexed ? parsedByIndex.get(position) : lines[position]
        if (line === undefined) {
            failed++
            return
        }
        const vector = vectorOf(line)
        if (vector === null) {
            failed++
            return
        }
        if (isHardMismatch(line, entry.text)) {
            warn(
                `text ${position} detected as '${String(line.lang)}' (p=${typeof line.langConfidence === 'number' ? line.langConfidence.toFixed(3) : '?'}); the '${EMBED_LANG}' model would produce noise, so it was not embedded`
            )
            return
        }
        vectors[entry.index] = vector
    })

    if (failed > 0) {
        warn(`embedder returned ${payload.length - failed} of ${payload.length} vectors`)
    }
    // A batch where nothing parsed as a vector is the same as no embedder at all.
    return vectors.some(vector => vector !== null) ? vectors : null
}

/**
 * §8.2's guard, applied to the CLI's own verdict. The CLI already implements the
 * exact thresholds (top hypothesis ≥ 0.40, `en` < 0.15, ≥ 3 tokens); this honours
 * `langCheck === 'mismatch'` and falls back to the numeric rule only when an older
 * binary omits the field (where `en`'s own probability is not available, so the
 * ≥ 0.40 top-hypothesis test is the closest available approximation).
 */
export function isHardMismatch(line: EmbedLine, text: string): boolean {
    if (line.langCheck === 'mismatch') return true
    if (typeof line.langCheck === 'string') return false
    if (typeof line.lang !== 'string') return false
    if (line.lang.split('-')[0].toLowerCase() === EMBED_LANG) return false
    if (typeof line.langConfidence !== 'number' || line.langConfidence < 0.4) return false
    return tokenCount(text) >= 3
}

function tokenCount(text: string): number {
    return text.split(/\s+/).filter(token => token !== '').length
}

/**
 * One text per line, and the CLI trims each line, so newlines and tabs inside a text
 * are collapsed to a single space. Without this the worker's `key\nbody` separator
 * would become a second input.
 */
export function toWireText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function vectorOf(line: EmbedLine): Float32Array | null {
    const raw = line.vector
    if (!Array.isArray(raw) || raw.length === 0) return null
    if (typeof line.dim === 'number' && line.dim !== raw.length) return null
    if (raw.length !== EMBED_DIM) return null
    const values = raw.map(value => (typeof value === 'number' ? value : Number.NaN))
    if (values.some(value => !Number.isFinite(value))) return null
    return Float32Array.from(values)
}

function parseLines(stdout: string): EmbedLine[] {
    const parsed: EmbedLine[] = []
    for (const raw of stdout.split('\n')) {
        const text = raw.trim()
        if (text === '') continue
        try {
            const value: unknown = JSON.parse(text)
            if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
            parsed.push(value as EmbedLine)
        } catch {
            // A truncated final line is a partial batch, not a fatal error.
            continue
        }
    }
    return parsed
}

function warningLines(stderr: string): string[] {
    return stderr
        .split('\n')
        .map(line => line.trim())
        .filter(line => /warning:/i.test(line))
        .map(line => line.replace(/^\[nle-embed\]\s*/i, ''))
}

/**
 * The `Embedder` seam (§5's `memory_search` half). One text per call here is a
 * search query, not note content: the batch-per-process rule exists to keep the
 * worker's queue from paying startup per note, and a query has no queue.
 */
export function createEmbedder(options: EmbedOptions = {}): Embedder {
    return async (text: string) => {
        const vectors = await embedBatch([text], options)
        return vectors === null ? null : (vectors[0] ?? null)
    }
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
