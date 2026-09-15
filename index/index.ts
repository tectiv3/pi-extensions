/**
 * Index Tool - maki-style code skeleton via the `idx` binary
 *
 * Registers an `index` tool that spawns the shared `idx` binary and returns
 * a compact skeleton of a source file (imports, types, signatures with line
 * ranges) or a directory listing, so the model can read with offset/limit
 * only the sections it needs instead of whole files.
 *
 * Binary resolution (once, at extension load): `IDX_BIN` env override, then
 * `idx` on PATH, then `~/.local/bin/idx`. When absent, execute throws an
 * error with install hints and no system-prompt nudge is added.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

// Schema
const IndexParams = Type.Object({
    path: Type.String({
        description:
            'File or directory path to index (absolute or relative to the working directory)',
    }),
})

// Tool description — verbatim from maki `plugins/index/init.lua` (via idx PLAN.md).
const DESCRIPTION = `Return a compact overview of a source file: imports, type definitions, function signatures, and structure with their line numbers surrounded by []. ~70-90% more efficient than reading the full file.

- Use this FIRST to understand file structure before using read with offset/limit.
- Supports source files in different programming languages and markdown.
- Falls back with an error on unsupported languages. Use read instead.`

const PROMPT_NUDGE =
    '\nUse the index tool first on individual files to get their skeleton, then use read with offset/limit for the specific section you need.'

function fileExists(p: string): boolean {
    try {
        fs.accessSync(p, fs.constants.F_OK)
        return true
    } catch {
        return false
    }
}

function findIdxBinary(): string | undefined {
    const candidates: string[] = []
    const envBin = process.env.IDX_BIN
    if (envBin) candidates.push(envBin)
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (dir) candidates.push(path.join(dir, 'idx'))
    }
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'idx'))
    for (const candidate of candidates) {
        if (fileExists(candidate)) return candidate
    }
    return undefined
}

// Probed once at extension load; both the tool and the prompt nudge branch on it.
const IDX_BIN = findIdxBinary()

// Mirrors pi's read tool path resolution (utils/paths.js resolvePath): expand
// `~`, then resolve against the session cwd — NOT process cwd, which can drift.
function resolveTarget(input: string, cwd: string): string {
    let p = input
    const home = os.homedir()
    if (p === '~') {
        p = home
    } else if (p.startsWith('~/')) {
        p = path.join(home, p.slice(2))
    }
    return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p)
}

interface IdxRun {
    code: number | null
    stdout: string
    stderr: string
    spawnError?: Error
}

function runIdx(
    binary: string,
    target: string,
    signal: AbortSignal | undefined
): Promise<IdxRun> {
    return new Promise<IdxRun>(resolveRun => {
        let child: ChildProcess
        try {
            child = spawn(binary, [target], { stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (err) {
            resolveRun({ code: null, stdout: '', stderr: '', spawnError: err as Error })
            return
        }

        let stdout = ''
        let stderr = ''
        let settled = false
        const finish = (result: IdxRun) => {
            if (settled) return
            settled = true
            signal?.removeEventListener('abort', onAbort)
            resolveRun(result)
        }
        // Resolve immediately on abort rather than waiting for 'close': the
        // child is SIGKILLed first, but a grandchild inheriting the stdio pipes
        // would otherwise hold 'close' open long after the direct child died.
        const onAbort = () => {
            child.kill('SIGKILL')
            finish({ code: null, stdout, stderr })
        }

        // Decode via StringDecoder so a multibyte UTF-8 sequence split across
        // a chunk boundary isn't re-decoded per chunk (string += Buffer is).
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', chunk => {
            stdout += chunk
        })
        child.stderr?.on('data', chunk => {
            stderr += chunk
        })
        // Covers ENOENT/EACCES (no 'close' fires) and post-spawn IPC failures.
        child.on('error', err => {
            finish({ code: null, stdout, stderr, spawnError: err })
        })
        child.on('close', code => {
            finish({ code, stdout, stderr })
        })
        if (signal) {
            if (signal.aborted) child.kill('SIGKILL')
            else signal.addEventListener('abort', onAbort, { once: true })
        }
    })
}

function errorText(text: string): { content: { type: 'text'; text: string }[] } {
    return { content: [{ type: 'text', text }] }
}

export default function indexTool(pi: ExtensionAPI) {
    pi.registerTool({
        name: 'index',
        label: 'Index',
        description: DESCRIPTION,
        // Read-only and independent per call, so it may run concurrently with
        // other tool calls (pi-agent-core ToolExecutionMode).
        executionMode: 'parallel',
        parameters: IndexParams,

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (!IDX_BIN) {
                throw new Error(
                    'idx binary not found. Install it as ~/.local/bin/idx (and ensure it is on PATH), or point the IDX_BIN environment variable at the binary, then restart pi.'
                )
            }
            const target = resolveTarget(params.path, ctx.cwd)
            const run = await runIdx(IDX_BIN, target, signal)
            if (run.spawnError) {
                throw new Error(
                    `Failed to run idx at ${IDX_BIN}: ${run.spawnError.message}. Set IDX_BIN to override the binary location.`
                )
            }
            if (signal?.aborted) {
                return errorText('Indexing aborted.')
            }
            if (run.code === 0) {
                return { content: [{ type: 'text', text: run.stdout }] }
            }
            // idx errors already carry guidance ("Use the read tool instead.").
            return errorText(run.stderr.trim() || `idx exited with code ${run.code}.`)
        },
    })

    pi.on('before_agent_start', event => {
        if (!IDX_BIN) return
        const selectedTools = event.systemPromptOptions?.selectedTools as string[] | undefined
        if (!selectedTools?.includes('index')) return
        return { systemPrompt: event.systemPrompt + PROMPT_NUDGE }
    })
}
