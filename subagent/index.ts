/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Runs children in RPC mode: stdout streams structured events while stdin
 * accepts JSON-line commands (initial task, steer, abort).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentToolResult, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Message } from '@earendil-works/pi-ai'
import { StringEnum, uuidv7 } from '@earendil-works/pi-ai'
import {
    CONFIG_DIR_NAME,
    type EventBus,
    type ExtensionAPI,
    type ExtensionContext,
    getAgentDir,
    getMarkdownTheme,
    withFileMutationQueue,
} from '@earendil-works/pi-coding-agent'
import {
    type Component,
    Container,
    decodeKittyPrintable,
    Key,
    Markdown,
    matchesKey,
    Spacer,
    Text,
    visibleWidth,
} from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { type AgentConfig, type AgentScope, discoverAgents } from './agents.ts'

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4
// A child turn is stdio-silent until the model emits its first token. Local
// LLM providers can take >120s to reach that token on a large context or a
// contended server, so the default is generous rather than "fast kill". Tune
// via PI_SUBAGENT_STALL_TIMEOUT_MS (ms).
const STALL_TIMEOUT_MS = Number(process.env.PI_SUBAGENT_STALL_TIMEOUT_MS ?? 300_000)
const STALL_CHECK_INTERVAL_MS = 10_000
const COLLAPSED_ITEM_COUNT = 10
const PER_TASK_OUTPUT_CAP = 50 * 1024
const SUBAGENTS_DIR_MODE = 0o700
const INSPECT_DEFAULT_LIMIT = 20
const INSPECT_TASK_PREVIEW_CHARS = 200
const INSPECT_ENTRY_PREVIEW_CHARS = 100
const INSPECT_FINAL_OUTPUT_CAP = 2000
const LIST_ID_SHORT_CHARS = 8
const LIST_TASK_PREVIEW_CHARS = 60
// /subagents resume: instruction sent when the user provides none, and how
// long the command waits for the spawned child to appear in the registry
// before reporting failure (covers pre-spawn exits inside runSingleAgent).
const RESUME_DEFAULT_INSTRUCTION = 'Continue from where you stopped.'
const RESUME_SPAWN_TIMEOUT_MS = 15_000

// /subagents attach live-view sizing and preview caps. While attached, the
// view is de-facto fullscreen: it occupies nearly all terminal rows, its own
// header and steer chrome included (spec §7 "takes over the TUI"). The
// reserved rows only guarantee the surrounding dock — status line and
// footer — survives.
const ATTACH_TASK_PREVIEW_CHARS = 60
const ATTACH_THINKING_PREVIEW_CHARS = 200
const ATTACH_TOOL_OUTPUT_PREVIEW_CHARS = 200
const ATTACH_STEER_PREVIEW_CHARS = 200
const ATTACH_RESERVED_TERMINAL_ROWS = 6
const ATTACH_MIN_VIEWPORT_LINES = 3
// The always-visible steer input row (blank separator + input line) is fixed
// height outside the scrolling transcript window.
const ATTACH_STEER_ROW_HEIGHT = 2

// Registry of live subagent children, keyed by subagent id. Populated on
// spawn, consumed by /subagents attach (live view + ring-buffer replay).
const RING_BUFFER_MAX_EVENTS = 500

// Streaming frames and transient queue state the attach view never renders.
// Excluded from the ring so late-attach replay history stays renderable and
// never replays stale queue state; live consumers still receive them via
// the emitter/eventBus.
const NON_RENDERABLE_EVENT_TYPES = new Set([
    'message_update',
    'tool_execution_update',
    'tool_execution_start',
    'queue_update',
])

// Remote-control access (see pi-extensions/rc). The structural type keeps the
// two extensions decoupled: rc is looked up on globalThis and checked, never imported.
interface RcRemote {
    askAvailable(): boolean
    ask(opts: {
        kind: 'ask_user_question'
        params: unknown
        signal?: AbortSignal
    }): Promise<
        | { id: string; value: string; label: string; wasCustom: boolean; index?: number }[]
        | 'dismissed'
        | null
    >
}

const RC_KEY = Symbol.for('pi-rc')

function rcRemote(): RcRemote | undefined {
    const rc = (globalThis as unknown as Record<symbol, unknown>)[RC_KEY]
    if (!rc) return undefined
    if (
        typeof (rc as RcRemote).ask !== 'function' ||
        typeof (rc as RcRemote).askAvailable !== 'function'
    )
        return undefined
    return rc as RcRemote
}

// FIFO mutex serializing concurrent relay calls — the user can only answer
// one relayed question at a time (TUI or phone).
const relayMutexQueue: (() => void)[] = []
let relayMutexHeld = false

async function acquireRelayMutex(): Promise<() => void> {
    if (!relayMutexHeld) {
        relayMutexHeld = true
        return () => {
            const next = relayMutexQueue.shift()
            if (next) next()
            else relayMutexHeld = false
        }
    }
    return new Promise(resolve => {
        relayMutexQueue.push(() => {
            resolve(() => {
                const next = relayMutexQueue.shift()
                if (next) next()
                else relayMutexHeld = false
            })
        })
    })
}

type RelayUiRequest = (
    event: { method: string; id: string; [key: string]: unknown },
    agentName: string,
    signal: AbortSignal
) => Promise<Record<string, unknown> | null>

function buildRelayUiRequest(ctx: ExtensionContext): RelayUiRequest {
    return async (event, agentName, relaySignal) => {
        const method = event.method
        const title = String(event.title ?? '')
        const rc = rcRemote()

        if (rc?.askAvailable()) {
            if (method === 'select') {
                const options = Array.isArray(event.options) ? event.options : []
                const answer = await rc.ask({
                    kind: 'ask_user_question',
                    params: {
                        questions: [
                            {
                                id: 'Q1',
                                label: agentName,
                                prompt: `[${agentName}] ${title}`,
                                options: options.map((o: string) => ({ label: o, value: o })),
                                allowOther: false,
                            },
                        ],
                    },
                    signal: relaySignal,
                })
                if (!answer || answer === 'dismissed') return null
                return { value: answer[0].value }
            }
            if (method === 'confirm') {
                const message = String(event.message ?? '')
                const answer = await rc.ask({
                    kind: 'ask_user_question',
                    params: {
                        questions: [
                            {
                                id: 'Q1',
                                label: agentName,
                                prompt: `[${agentName}] ${title}: ${message}`,
                                options: [
                                    { label: 'Yes', value: 'yes' },
                                    { label: 'No', value: 'no' },
                                ],
                                allowOther: false,
                            },
                        ],
                    },
                    signal: relaySignal,
                })
                if (!answer || answer === 'dismissed') return null
                return { confirmed: answer[0].value === 'yes' }
            }
            if (method === 'input') {
                const answer = await rc.ask({
                    kind: 'ask_user_question',
                    params: {
                        questions: [
                            {
                                id: 'Q1',
                                label: agentName,
                                prompt: `[${agentName}] ${title}`,
                                options: [],
                                allowOther: true,
                            },
                        ],
                    },
                    signal: relaySignal,
                })
                if (!answer || answer === 'dismissed') return null
                return { value: answer[0].label }
            }
            return null
        }

        // TUI fallback — select/input/confirm with signal support exist at runtime
        // (rpc-mode.ts) but are absent from the local type stubs.
        const ui = ctx.ui as unknown as {
            select(
                title: string,
                options: string[],
                opts?: { signal?: AbortSignal }
            ): Promise<string | undefined>
            confirm(
                title: string,
                message: string,
                opts?: { signal?: AbortSignal }
            ): Promise<boolean>
            input(
                title: string,
                defaultValue?: string,
                opts?: { signal?: AbortSignal }
            ): Promise<string | undefined>
        }

        if (method === 'select') {
            const options = Array.isArray(event.options) ? event.options : []
            const result = await ui.select(`[${agentName}] ${title}`, options as string[], {
                signal: relaySignal,
            })
            return result !== undefined ? { value: result } : null
        }
        if (method === 'confirm') {
            const message = String(event.message ?? '')
            const result = await ui.confirm(`[${agentName}] ${title}`, message, {
                signal: relaySignal,
            })
            return { confirmed: result }
        }
        if (method === 'input') {
            const placeholder = String(event.placeholder ?? '')
            const result = await ui.input(`[${agentName}] ${title}`, placeholder, {
                signal: relaySignal,
            })
            return result !== undefined ? { value: result } : null
        }

        return null
    }
}

type SubagentStreamEvent = { type: string; [key: string]: unknown }

interface ActiveSubagent {
    id: string
    agent: string
    task: string
    proc: ChildProcess
    // Spawn time (epoch ms) — drives the elapsed column in the manager view.
    startedAt: number
    eventEmitter: EventEmitter
    settled: boolean
    events: SubagentStreamEvent[]
    // Latest still-queued steer texts, replaced wholesale on every
    // queue_update frame; seeded empty at spawn, read by the attach view.
    pendingSteers: string[]
    // Steer handle for a new LLM turn; wired at spawn so the attach view can
    // reach it later.
    steer: (message: string) => void
}

const activeSubagents = new Map<string, ActiveSubagent>()

// Global cross-extension bus, handed over by the extension host in the
// default export; processLine runs in child callbacks that can only reach it
// through module scope.
let eventBus: EventBus | undefined

// Id of the pi session this extension instance serves. One pi process serves
// one session, so module scope is the single source of truth; every entry
// point that can spawn or list refreshes it from its ExtensionContext
// (mirroring the rc extension's defensive getSessionId cast). Undefined when
// the host does not expose one — spawns then omit parentSessionId and scoped
// listings hide everything rather than leak other sessions' runs.
let currentPiSessionId: string | undefined

function sessionIdFromContext(ctx: ExtensionContext): string | undefined {
    return (
        ctx?.sessionManager as { getSessionId?: () => string } | undefined
    )?.getSessionId?.()
}

function capturePiSessionId(ctx: ExtensionContext): void {
    currentPiSessionId = sessionIdFromContext(ctx)
}

function registerActiveSubagent(entry: ActiveSubagent): void {
    activeSubagents.set(entry.id, entry)
}

function unregisterActiveSubagent(id: string): void {
    activeSubagents.delete(id)
}

// Ring-buffer push: cap retained events so long-running children cannot grow
// memory unboundedly while still keeping recent history for late-attach replay.
function pushSubagentEvent(entry: ActiveSubagent, event: SubagentStreamEvent): void {
    entry.events.push(event)
    if (entry.events.length > RING_BUFFER_MAX_EVENTS) {
        entry.events.splice(0, entry.events.length - RING_BUFFER_MAX_EVENTS)
    }
}

// Zombie prevention: the parent must not leave orphaned children behind when
// it exits, so SIGTERM every live subagent. Only a best-effort signal is
// possible here — the event loop stops once 'exit' handlers return, so no
// SIGKILL escalation sweep can follow.
process.on('exit', () => {
    for (const entry of activeSubagents.values()) {
        try {
            entry.proc.kill('SIGTERM')
        } catch {
            /* already dead */
        }
    }
})

// File-only diagnostics, opt-in via the same gate as rc/debug.ts (PI_RC_DEBUG=1
// or PI_RC_DEBUG_FILE → ~/.pi/agent/rc-debug.log). console.* output lands in
// the TUI, so even lifecycle-only logging must not use it.
function subagentDebugLog(msg: string): void {
    const fromEnv = process.env.PI_RC_DEBUG_FILE?.trim()
    const target =
        fromEnv ||
        (process.env.PI_RC_DEBUG?.trim()
            ? path.join(os.homedir(), '.pi', 'agent', 'rc-debug.log')
            : null)
    if (!target) return
    try {
        fs.appendFileSync(target, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {
        // Diagnostics must never break a run
    }
}

function formatTokens(count: number): string {
    if (count < 1000) return count.toString()
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`
    if (count < 1000000) return `${Math.round(count / 1000)}k`
    return `${(count / 1000000).toFixed(1)}M`
}

function formatElapsedMs(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
    if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
    return `${seconds}s`
}

function formatUsageStats(
    usage: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        cost: number
        contextTokens?: number
        turns?: number
    },
    model?: string
): string {
    const parts: string[] = []
    if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`)
    if (usage.input) parts.push(`↑${formatTokens(usage.input)}`)
    if (usage.output) parts.push(`↓${formatTokens(usage.output)}`)
    if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
    if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
    if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`)
    if (usage.contextTokens && usage.contextTokens > 0) {
        parts.push(`ctx:${formatTokens(usage.contextTokens)}`)
    }
    if (model) parts.push(model)
    return parts.join(' ')
}

function previewText(text: string, maxChars: number): string {
    const collapsed = text.replace(/\s+/g, ' ').trim()
    return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}...` : collapsed
}

function formatToolCall(
    toolName: string,
    args: Record<string, unknown>,
    themeFg: (color: any, text: string) => string
): string {
    const shortenPath = (p: string) => {
        const home = os.homedir()
        return p.startsWith(home) ? `~${p.slice(home.length)}` : p
    }

    switch (toolName) {
        case 'bash': {
            const command = (args.command as string) || '...'
            const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command
            return themeFg('muted', '$ ') + themeFg('toolOutput', preview)
        }
        case 'read': {
            const rawPath = (args.file_path || args.path || '...') as string
            const filePath = shortenPath(rawPath)
            const offset = args.offset as number | undefined
            const limit = args.limit as number | undefined
            let text = themeFg('accent', filePath)
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1
                const endLine = limit !== undefined ? startLine + limit - 1 : ''
                text += themeFg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`)
            }
            return themeFg('muted', 'read ') + text
        }
        case 'write': {
            const rawPath = (args.file_path || args.path || '...') as string
            const filePath = shortenPath(rawPath)
            const content = (args.content || '') as string
            const lines = content.split('\n').length
            let text = themeFg('muted', 'write ') + themeFg('accent', filePath)
            if (lines > 1) text += themeFg('dim', ` (${lines} lines)`)
            return text
        }
        case 'edit': {
            const rawPath = (args.file_path || args.path || '...') as string
            return themeFg('muted', 'edit ') + themeFg('accent', shortenPath(rawPath))
        }
        case 'ls': {
            const rawPath = (args.path || '.') as string
            return themeFg('muted', 'ls ') + themeFg('accent', shortenPath(rawPath))
        }
        case 'find': {
            const pattern = (args.pattern || '*') as string
            const rawPath = (args.path || '.') as string
            return (
                themeFg('muted', 'find ') +
                themeFg('accent', pattern) +
                themeFg('dim', ` in ${shortenPath(rawPath)}`)
            )
        }
        case 'grep': {
            const pattern = (args.pattern || '') as string
            const rawPath = (args.path || '.') as string
            return (
                themeFg('muted', 'grep ') +
                themeFg('accent', `/${pattern}/`) +
                themeFg('dim', ` in ${shortenPath(rawPath)}`)
            )
        }
        default: {
            const argsStr = JSON.stringify(args)
            const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr
            return themeFg('accent', toolName) + themeFg('dim', ` ${preview}`)
        }
    }
}

interface UsageStats {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
    contextTokens: number
    turns: number
}

interface SingleResult {
    agent: string
    agentSource: 'user' | 'project' | 'unknown'
    task: string
    subagentId: string
    sessionPath: string
    exitCode: number
    messages: Message[]
    stderr: string
    usage: UsageStats
    model?: string
    stopReason?: string
    aborted?: boolean
    resumeNote?: string
    errorMessage?: string
    step?: number
}

interface SubagentDetails {
    mode: 'single' | 'parallel' | 'chain'
    agentScope: AgentScope
    projectAgentsDir: string | null
    results: SingleResult[]
}

interface SubagentMeta {
    agent: string
    task: string
    model?: string
    thinkingLevel?: ThinkingLevel
    startedAt: string
    promptHash: string
    // Pi session that spawned (or last resumed) the run. Listing surfaces
    // scope to the current session's id; runs without the field (pre-scoping
    // metas) stay resolvable by explicit full id.
    parentSessionId?: string
    resumedCount?: number
    status?: 'succeeded' | 'failed' | 'aborted'
    stopReason?: string
    exitCode?: number
    sessionHeaderId?: string
}

interface ResumeTarget {
    id: string
    meta: SubagentMeta
}

function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'assistant') {
            for (const part of msg.content) {
                if (part.type === 'text') return part.text
            }
        }
    }
    return ''
}

function isFailedResult(result: SingleResult): boolean {
    return (
        result.aborted === true ||
        result.exitCode !== 0 ||
        result.stopReason === 'error' ||
        result.stopReason === 'aborted'
    )
}

function getResultOutput(result: SingleResult): string {
    if (isFailedResult(result)) {
        return (
            result.errorMessage ||
            result.stderr ||
            getFinalOutput(result.messages) ||
            '(no output)'
        )
    }
    return getFinalOutput(result.messages) || '(no output)'
}

function sessionArtifactsPersisted(result: SingleResult): boolean {
    if (!result.subagentId) return false
    const { session, meta } = getSubagentFilePaths(result.subagentId)
    return fs.existsSync(session) || fs.existsSync(meta)
}

function formatResumeHint(result: SingleResult): string | null {
    // Resume is only meaningful when spawn artifacts exist; pre-spawn failures
    // (e.g. unknown agent) leave nothing to inspect or resume.
    if (!sessionArtifactsPersisted(result)) return null
    return [
        `Subagent ID: ${result.subagentId}`,
        `Inspect with subagent_inspect; continue with subagent ` +
            `{agent: "${result.agent}", task: "<continuation instruction>", resume: "${result.subagentId}"}.`,
    ].join('\n')
}

function formatFailureReport(result: SingleResult): string {
    const outcome = result.aborted
        ? 'aborted'
        : `failed${result.stopReason && result.stopReason !== 'end' ? ` (${result.stopReason})` : ''}`
    const lines: string[] = [`Agent "${result.agent}" ${outcome}.`]
    const diagnostic = result.errorMessage || result.stderr.trim()
    if (diagnostic) lines.push(diagnostic)
    const partialOutput = getFinalOutput(result.messages)
    if (partialOutput) lines.push(`Partial output:\n${partialOutput}`)
    else if (result.aborted) lines.push('No partial output was persisted before interruption.')
    const hint = formatResumeHint(result)
    if (hint) lines.push(hint)
    return lines.join('\n\n')
}

function truncateParallelOutput(output: string): string {
    const byteLength = Buffer.byteLength(output, 'utf8')
    if (byteLength <= PER_TASK_OUTPUT_CAP) return output

    let truncated = output.slice(0, PER_TASK_OUTPUT_CAP)
    while (Buffer.byteLength(truncated, 'utf8') > PER_TASK_OUTPUT_CAP) {
        truncated = truncated.slice(0, -1)
    }
    return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, 'utf8')} bytes omitted. Full output preserved in tool details.]`
}

type DisplayItem =
    | { type: 'text'; text: string }
    | { type: 'toolCall'; name: string; args: Record<string, any> }

function getDisplayItems(messages: Message[]): DisplayItem[] {
    const items: DisplayItem[] = []
    for (const msg of messages) {
        if (msg.role === 'assistant') {
            for (const part of msg.content) {
                if (part.type === 'text') items.push({ type: 'text', text: part.text })
                else if (part.type === 'toolCall')
                    items.push({ type: 'toolCall', name: part.name, args: part.arguments })
            }
        }
    }
    return items
}

async function mapWithConcurrencyLimit<TIn, TOut>(
    items: TIn[],
    concurrency: number,
    fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
    if (items.length === 0) return []
    const limit = Math.max(1, Math.min(concurrency, items.length))
    const results: TOut[] = new Array(items.length)
    let nextIndex = 0
    const workers = new Array(limit).fill(null).map(async () => {
        while (true) {
            const current = nextIndex++
            if (current >= items.length) return
            results[current] = await fn(items[current], current)
        }
    })
    await Promise.all(workers)
    return results
}

async function writePromptToTempFile(
    agentName: string,
    prompt: string
): Promise<{ dir: string; filePath: string }> {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-'))
    const safeName = agentName.replace(/[^\w.-]+/g, '_')
    const filePath = path.join(tmpDir, `prompt-${safeName}.md`)
    await withFileMutationQueue(filePath, async () => {
        await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 })
    })
    return { dir: tmpDir, filePath }
}

function getSubagentsDir(): string {
    return path.join(getAgentDir(), 'subagents')
}

function getSubagentFilePaths(subagentId: string): {
    session: string
    pid: string
    meta: string
} {
    return {
        session: path.join(getSubagentsDir(), `${subagentId}.jsonl`),
        pid: path.join(getSubagentsDir(), `${subagentId}.pid`),
        meta: path.join(getSubagentsDir(), `${subagentId}.meta`),
    }
}

function ensureSubagentsDir(): void {
    try {
        fs.mkdirSync(getSubagentsDir(), { recursive: true, mode: SUBAGENTS_DIR_MODE })
        // mkdir's mode is masked by the process umask; enforce the private mode explicitly.
        fs.chmodSync(getSubagentsDir(), SUBAGENTS_DIR_MODE)
    } catch {
        /* persistence setup failures must not crash the delegation; the child run surfaces them */
    }
}

function writeSubagentMetaFile(metaPath: string, meta: SubagentMeta): void {
    try {
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, '\t'), {
            encoding: 'utf-8',
            mode: 0o600,
        })
    } catch {
        /* ignore */
    }
}

function readSessionHeaderId(sessionPath: string): string | undefined {
    try {
        const firstLine = fs.readFileSync(sessionPath, 'utf-8').split('\n', 1)[0]
        const entry = JSON.parse(firstLine)
        if (entry?.type === 'session' && typeof entry.id === 'string') return entry.id
    } catch {
        /* missing session file, torn first line, or unparsable header */
    }
    return undefined
}

function removeSubagentFile(filePath: string): void {
    try {
        fs.rmSync(filePath, { force: true })
    } catch {
        /* ignore */
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        // ESRCH means the pid is gone; EPERM means the process exists but is owned by another user.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
}

interface PersistedSubagentEntry {
    id: string
    meta?: SubagentMeta
}

function listPersistedSubagents(): PersistedSubagentEntry[] {
    const dir = getSubagentsDir()
    let metaFiles: string[]
    try {
        metaFiles = fs.readdirSync(dir).filter(file => file.endsWith('.meta'))
    } catch {
        return []
    }
    return metaFiles
        .map(file => {
            const id = file.slice(0, -'.meta'.length)
            try {
                return {
                    id,
                    meta: JSON.parse(
                        fs.readFileSync(path.join(dir, file), 'utf-8')
                    ) as SubagentMeta,
                }
            } catch {
                return { id }
            }
        })
        .sort((a, b) => a.id.localeCompare(b.id))
}

// Session-scoped view of the persisted runs: only metas whose parentSessionId
// matches the current session. Runs without the field (pre-scoping metas, and
// anything spawned while the session id was unavailable) are hidden from all
// listing surfaces but stay resolvable by explicit full id — explicit id is
// explicit intent, and the live-pid guard already refuses other sessions'
// running children.
function listSessionPersistedSubagents(): PersistedSubagentEntry[] {
    const sessionId = currentPiSessionId
    if (!sessionId) return []
    return listPersistedSubagents().filter(entry => entry.meta?.parentSessionId === sessionId)
}

// Resumable persisted runs of the current session: readable meta, not owned
// by a live process (this session's running children are registry entries,
// another session's by a live pidfile). Powers /subagents resume id omission
// and the manager view's PERSISTED section (§11).
function listSessionResumableSubagents(): PersistedSubagentEntry[] {
    return listSessionPersistedSubagents().filter(
        entry =>
            entry.meta !== undefined &&
            deriveSubagentRunStatus(entry.id, entry.meta).status !== 'running'
    )
}

function formatPersistedSubagentsList(entries: PersistedSubagentEntry[]): string[] {
    return entries.map(entry => {
        if (!entry.meta) return `- ${entry.id} — (meta sidecar unreadable)`
        return `- ${entry.id} — agent: ${entry.meta.agent}, status: ${
            entry.meta.status ?? 'unknown'
        }, task: ${previewText(entry.meta.task, LIST_TASK_PREVIEW_CHARS)}`
    })
}

function formatAvailableSubagentsError(resumeId: string): string {
    const entries = listSessionPersistedSubagents()
    if (entries.length === 0) {
        return (
            `No subagent found with id "${resumeId}" (completed runs are cleaned up). ` +
            `No persisted subagent runs from this session in ${getSubagentsDir()} ` +
            '(runs from other pi sessions are hidden — reference one by its full id).'
        )
    }
    return [
        `No subagent found with id "${resumeId}" (completed runs are cleaned up). ` +
            'Persisted runs from this session:',
        ...formatPersistedSubagentsList(entries),
        'Runs from other pi sessions are hidden; reference one by its full id.',
    ].join('\n')
}

function formatSessionFileSize(sessionPath: string): string {
    try {
        const bytes = fs.statSync(sessionPath).size
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    } catch {
        // pi creates the session file at the first message_end, so runs interrupted
        // before that point have no file yet.
        return 'no file yet'
    }
}

function buildSubagentsListReport(): string {
    // Successful runs are cleaned up, so every persisted entry is running, interrupted, or failed.
    // Missing-meta entries fall back to the uuidv7 id, which embeds a creation timestamp.
    // Scoped to the current session (§11): other sessions' runs are hidden from
    // listings but stay reachable by explicit full id.
    const entries = [...listSessionPersistedSubagents()].sort((a, b) =>
        (b.meta?.startedAt ?? b.id).localeCompare(a.meta?.startedAt ?? a.id)
    )
    if (entries.length === 0) return 'No persisted subagent runs from this session.'

    const dir = getSubagentsDir()
    const lines = entries.map(entry => {
        const status = formatSubagentStatus(deriveSubagentRunStatus(entry.id, entry.meta))
        const agent = entry.meta?.agent ?? 'unknown'
        const task = entry.meta
            ? previewText(entry.meta.task, LIST_TASK_PREVIEW_CHARS)
            : '(meta sidecar unreadable)'
        const size = formatSessionFileSize(getSubagentFilePaths(entry.id).session)
        return `- ${entry.id.slice(0, LIST_ID_SHORT_CHARS)} — agent: ${agent}, status: ${status}, size: ${size}, task: ${task}`
    })
    return [
        ...lines,
        `${entries.length} persisted subagent run${entries.length === 1 ? '' : 's'} from this session in ${dir}`,
        `session: ${currentPiSessionId ?? 'unknown'}`,
        `runs from other pi sessions are hidden — inspect/resume them by full id; ` +
            `inspect: subagent_inspect <id>; resume: /subagents resume <id>`,
    ].join('\n')
}

function formatRunningSubagentsList(entries: ActiveSubagent[]): string[] {
    return entries.map(
        entry =>
            `- ${entry.id.slice(0, LIST_ID_SHORT_CHARS)} — agent: ${entry.agent}, task: ${previewText(
                entry.task,
                LIST_TASK_PREVIEW_CHARS
            )}`
    )
}

function resolveAttachTarget(id?: string): ActiveSubagent | string {
    // Settled children are on their way out of the registry (proc 'close'
    // removes them); attaching would auto-detach instantly, so they are not
    // offered as targets.
    const running = [...activeSubagents.values()].filter(entry => !entry.settled)

    if (id) {
        const exact = running.find(entry => entry.id === id)
        if (exact) return exact
        const matches = running.filter(entry => entry.id.startsWith(id))
        if (matches.length === 1) return matches[0]
        if (matches.length > 1) {
            return [
                `Ambiguous subagent id "${id}" matches ${matches.length} running subagents:`,
                ...formatRunningSubagentsList(matches),
                'Use more characters or the full id.',
            ].join('\n')
        }
        if (running.length === 0) {
            return `No running subagent matches "${id}". Start one with the subagent tool first.`
        }
        return [
            `No running subagent matches "${id}". Running subagents:`,
            ...formatRunningSubagentsList(running),
        ].join('\n')
    }

    if (running.length === 0) {
        return (
            'No running subagents. Delegate a task with the subagent tool and run ' +
            '/subagents attach while it is still running.'
        )
    }
    if (running.length === 1) return running[0]
    return [
        `${running.length} subagents are running:`,
        ...formatRunningSubagentsList(running),
        'Attach with: /subagents attach <id>',
    ].join('\n')
}

// Steer text extraction from typed terminal input. Bracketed pastes are
// handled separately in the attach view's handleInput; this covers single
// keys and raw multi-char reads. Legacy mode delivers printable text as-is;
// kitty-protocol terminals encode it in CSI-u sequences
// (decodeKittyPrintable). Anything with an escape prefix or control codes is
// not steer input.
function decodeSteerText(data: string): string | undefined {
    const decoded = decodeKittyPrintable(data)
    if (decoded) return decoded
    if (data.length === 0 || data.startsWith('\x1b')) return undefined
    // Raw multi-char reads (terminals that deliver a paste without bracketed
    // markers) normalize embedded \r/\n/\t to spaces so the read is not
    // rejected wholesale. Lone keys stay strict.
    const text = data.length > 1 ? data.replace(/[\r\n\t]+/g, ' ') : data
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0
        if (code < 0x20 || code === 0x7f) return undefined
    }
    return text
}

// Transcript items for the attach view. Only *_end events render, by
// design: live streaming partials (message_update) are skipped deliberately
// — the completed message_end supersedes them — and onEvent's
// renderable-type check gates cache invalidation, so skipped frames never
// trigger a rebuild. User-role message_end frames (the initial task prompt
// and steered messages) render as ‹you› marker lines. A steer's message_end
// is emitted only at delivery — the next LLM request boundary, possibly
// minutes after acceptance — so acceptance alone is invisible; queued
// texts render as ‹pending› lines in the attach view's render(), driven by
// queue_update frames, until delivery swaps them for the ‹you› line.
function buildAttachItems(
    events: SubagentStreamEvent[],
    themeFg: (color: any, text: string) => string
): Component[] {
    const items: Component[] = []

    const pushToolResult = (msg: Message) => {
        for (const part of msg.content) {
            if (part.type === 'text' && part.text.trim()) {
                items.push(
                    new Text(
                        themeFg(
                            'toolOutput',
                            previewText(part.text, ATTACH_TOOL_OUTPUT_PREVIEW_CHARS)
                        ),
                        0,
                        0
                    )
                )
                return
            }
        }
    }

    for (const event of events) {
        if (event.type === 'steer_error') {
            items.push(
                new Text(
                    themeFg(
                        'error',
                        `‹err› ${previewText(String(event.error ?? 'steer rejected'), ATTACH_STEER_PREVIEW_CHARS)}`
                    ),
                    0,
                    0
                )
            )
            continue
        }
        if (event.type !== 'message_end' && event.type !== 'tool_result_end') continue
        const msg = event.message as Message | undefined
        if (!msg) continue
        if (msg.role === 'toolResult') {
            pushToolResult(msg)
        } else if (msg.role === 'user') {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text.trim()) {
                    items.push(
                        new Text(
                            themeFg('muted', '‹you› ') +
                                themeFg(
                                    'dim',
                                    previewText(part.text, ATTACH_STEER_PREVIEW_CHARS)
                                ),
                            0,
                            0
                        )
                    )
                }
            }
        } else if (msg.role === 'assistant') {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text.trim()) {
                    items.push(new Markdown(part.text, 0, 0, getMarkdownTheme()))
                } else if (part.type === 'thinking' && part.thinking.trim()) {
                    items.push(
                        new Text(
                            themeFg(
                                'dim',
                                previewText(part.thinking, ATTACH_THINKING_PREVIEW_CHARS)
                            ),
                            0,
                            0
                        )
                    )
                } else if (part.type === 'toolCall') {
                    items.push(
                        new Text(
                            themeFg('muted', '→ ') +
                                formatToolCall(part.name, part.arguments, themeFg),
                            0,
                            0
                        )
                    )
                }
            }
        }
    }
    return items
}

async function attachToSubagent(ctx: ExtensionContext, entry: ActiveSubagent): Promise<void> {
    const shortId = entry.id.slice(0, LIST_ID_SHORT_CHARS)

    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        let finished = false
        let followEnd = true
        let scrollTop = 0
        let cachedWidth = -1
        let cachedLines: string[] | undefined
        let steerBuffer = ''
        // Still-queued steers: seeded from the registry snapshot (late
        // attach sees texts queued before the view opened), then replaced
        // wholesale on queue_update — the authoritative stream drops a text
        // at delivery, when it starts rendering as a ‹you› line via the
        // child's user-role message_end.
        let pendingSteers: string[] = [...entry.pendingSteers]
        // Steer rejections arrive emitter-only (parent-side metadata, not
        // child transcript, so the ring stays free of them); collected here
        // for as long as this view is open.
        const steerErrors: SubagentStreamEvent[] = []

        // The custom component lives in the editor dock, outside the layout
        // engine's reach — a nested ScrollView cannot scroll there (no
        // bounded viewport, no scroll translation; verified against
        // pi-tui's layout walk). Scrolling is manual: render every
        // transcript line, slice a window, and clamp the total height so the
        // de-facto fullscreen view still leaves the dock chrome (status,
        // footer) on screen.
        const maxViewportLines = () =>
            Math.max(
                ATTACH_MIN_VIEWPORT_LINES,
                tui.terminal.rows -
                    ATTACH_RESERVED_TERMINAL_ROWS -
                    ATTACH_STEER_ROW_HEIGHT -
                    pendingSteers.length
            )

        function rebuild(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines
            const items = buildAttachItems(
                [...entry.events, ...steerErrors],
                theme.fg.bind(theme)
            )
            const lines: string[] = []
            for (let i = 0; i < items.length; i++) {
                if (i > 0) lines.push('')
                lines.push(...items[i].render(width))
            }
            cachedLines = lines
            cachedWidth = width
            return lines
        }

        function finish(): void {
            if (finished) return
            finished = true
            entry.eventEmitter.off('event', onEvent)
            entry.proc.removeListener('close', finish)
            done()
        }

        function onEvent(event: SubagentStreamEvent): void {
            if (event.type === 'agent_settled') {
                finish()
                return
            }
            if (event.type === 'queue_update') {
                // Replacement only — delivered texts are dropped by the
                // child's dequeue re-emission, so no matching against
                // transcript messages is needed. Pending lines render
                // outside the cached transcript, so no cache invalidation.
                if (Array.isArray(event.steering)) {
                    pendingSteers = event.steering.map(String)
                }
                tui.requestRender()
                return
            }
            // Only event types the view renders invalidate the line cache;
            // streaming frames (message_update, tool_execution_*) would
            // force a full rebuild per token.
            if (
                event.type !== 'message_end' &&
                event.type !== 'tool_result_end' &&
                event.type !== 'steer_error'
            ) {
                return
            }
            if (event.type === 'steer_error') steerErrors.push(event)
            cachedLines = undefined
            tui.requestRender()
        }

        entry.eventEmitter.on('event', onEvent)
        // Safety net: the child can die without an agent_settled frame
        // (watchdog kill, crash) — detach instead of showing a frozen view.
        entry.proc.once('close', finish)

        function render(width: number): string[] {
            const lines = rebuild(width)
            const viewportHeight = Math.min(lines.length, maxViewportLines())
            const maxScrollTop = Math.max(0, lines.length - viewportHeight)
            // followEnd pins the window to the newest output; scrolling up
            // suspends the pin until the user jumps back with End.
            scrollTop = followEnd ? maxScrollTop : Math.min(scrollTop, maxScrollTop)

            const header = [
                theme.fg('toolTitle', theme.bold('attach ')) +
                    theme.fg('accent', entry.agent) +
                    theme.fg('muted', ` ${shortId}`),
                theme.fg('dim', previewText(entry.task, ATTACH_TASK_PREVIEW_CHARS)),
                followEnd
                    ? theme.fg('dim', 'type to steer · Esc detach · live')
                    : theme.fg('dim', `↑${scrollTop} above · End → live · Esc detach`),
            ]
            // Single-line input row: when the buffer outgrows the row, keep
            // its tail so the caret stays visible (terminal-input behavior).
            const prompt = '› '
            const caret = '▌'
            const budget = Math.max(0, width - visibleWidth(prompt) - visibleWidth(caret))
            const chars = Array.from(steerBuffer)
            let start = chars.length
            let used = 0
            while (start > 0) {
                const charWidth = visibleWidth(chars[start - 1])
                if (used + charWidth > budget) break
                used += charWidth
                start--
            }
            const steerRow =
                theme.fg('dim', prompt) +
                theme.fg('muted', chars.slice(start).join('')) +
                theme.fg('dim', caret)
            // Pending steers render after the transcript window, before the
            // steer row — appended here, not in rebuild(), so queue updates
            // never invalidate the cached transcript lines.
            const pendingLines = pendingSteers.map(
                text =>
                    theme.fg('dim', '‹pending› ') +
                    theme.fg('dim', previewText(text, ATTACH_STEER_PREVIEW_CHARS))
            )
            return [
                ...header,
                '',
                ...lines.slice(scrollTop, scrollTop + viewportHeight),
                ...pendingLines,
                '',
                steerRow,
            ]
        }

        function handleInput(data: string): void {
            if (matchesKey(data, Key.escape)) {
                finish()
                return
            }
            // Steering input is consumed before the scroll keys so printable
            // characters never scroll the view. Enter on an empty buffer and
            // backspace on an empty buffer are no-ops, still consumed.
            if (matchesKey(data, Key.enter)) {
                if (steerBuffer.length > 0) {
                    const message = steerBuffer
                    steerBuffer = ''
                    entry.steer(message)
                    // The ‹you› echo arrives when the child forwards its
                    // user-role message_end; jump to live so the follow-up
                    // response is visible as it streams.
                    followEnd = true
                    tui.requestRender()
                }
                return
            }
            if (matchesKey(data, Key.backspace)) {
                if (steerBuffer.length > 0) {
                    steerBuffer = Array.from(steerBuffer).slice(0, -1).join('')
                    tui.requestRender()
                }
                return
            }
            // Bracketed paste (pi's TUI wraps pastes in \x1b[200~…\x1b[201~):
            // strip both markers, flatten newlines/tabs to spaces, and
            // append the remainder to the steer buffer.
            if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
                const pasted = data.slice('\x1b[200~'.length, -'\x1b[201~'.length)
                if (pasted) {
                    steerBuffer += pasted.replace(/[\r\n\t]+/g, ' ')
                    tui.requestRender()
                }
                return
            }
            const steerText = decodeSteerText(data)
            if (steerText !== undefined) {
                steerBuffer += steerText
                tui.requestRender()
                return
            }
            if (!cachedLines) return
            const viewportHeight = Math.min(cachedLines.length, maxViewportLines())
            const maxScrollTop = Math.max(0, cachedLines.length - viewportHeight)
            if (matchesKey(data, Key.up)) {
                scrollTop = Math.max(0, scrollTop - 1)
                followEnd = false
            } else if (matchesKey(data, Key.down)) {
                scrollTop = Math.min(maxScrollTop, scrollTop + 1)
                followEnd = scrollTop >= maxScrollTop
            } else if (matchesKey(data, Key.pageUp)) {
                scrollTop = Math.max(0, scrollTop - viewportHeight)
                followEnd = false
            } else if (matchesKey(data, Key.pageDown)) {
                scrollTop = Math.min(maxScrollTop, scrollTop + viewportHeight)
                followEnd = scrollTop >= maxScrollTop
            } else if (matchesKey(data, Key.home)) {
                scrollTop = 0
                followEnd = false
            } else if (matchesKey(data, Key.end)) {
                followEnd = true
            } else {
                return
            }
            tui.requestRender()
        }

        return {
            render,
            invalidate: () => {
                cachedLines = undefined
            },
            handleInput,
            dispose: () => finish(),
        }
    })

    // custom() resolving means finish() ran (Esc, settled, or proc close)
    // and the parent editor is restored — a notify is safe here.
    ctx.ui.notify(`Detached from subagent ${shortId}.`, 'info')
}

function resolveResumeTarget(
    resumeId: string,
    agentName: string,
    agents: AgentConfig[]
): ResumeTarget | string {
    const {
        session: sessionPath,
        pid: pidPath,
        meta: metaPath,
    } = getSubagentFilePaths(resumeId)

    if (!fs.existsSync(sessionPath)) return formatAvailableSubagentsError(resumeId)

    if (fs.existsSync(pidPath)) {
        const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
        if (pid > 0 && isProcessAlive(pid)) {
            return (
                `Subagent "${resumeId}" is still running (pid ${pid}). ` +
                'Wait for it to finish or inspect it with subagent_inspect instead of resuming.'
            )
        }
        // Stale pidfile: the parent died before cleanup. Unlock and treat the run as interrupted.
        removeSubagentFile(pidPath)
    }

    let meta: SubagentMeta
    try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SubagentMeta
    } catch {
        return `Cannot resume "${resumeId}": its meta sidecar is missing or unreadable. Start a fresh delegation instead.`
    }

    if (meta.agent !== agentName) {
        return (
            `Cannot resume "${resumeId}" with agent "${agentName}": the original run used agent "${meta.agent}". ` +
            'Resuming under a different agent changes the system prompt and toolset; use the original agent.'
        )
    }

    const agent = agents.find(a => a.name === agentName)
    const currentPromptHash = agent
        ? createHash('sha256').update(agent.systemPrompt).digest('hex')
        : undefined
    if (!agent || currentPromptHash !== meta.promptHash) {
        return `Cannot resume "${resumeId}": the "${agentName}" agent definition changed since the original run; start a fresh delegation instead.`
    }

    return { id: resumeId, meta }
}

type InspectTarget = { id: string } | { error: string }

function resolveInspectTarget(requestedId: string): InspectTarget {
    // An exact id is honored even when its meta sidecar is missing (jsonl-only runs)
    // and even when the run belongs to another session — explicit id is
    // explicit intent. Prefix candidates are scoped to this session.
    const { session, pid, meta } = getSubagentFilePaths(requestedId)
    if (fs.existsSync(session) || fs.existsSync(pid) || fs.existsSync(meta))
        return { id: requestedId }

    const matches = listSessionPersistedSubagents().filter(entry =>
        entry.id.startsWith(requestedId)
    )
    if (matches.length === 1) return { id: matches[0].id }
    if (matches.length > 1) {
        return {
            error: [
                `Ambiguous subagent id "${requestedId}" matches ${matches.length} persisted runs from this session:`,
                ...formatPersistedSubagentsList(matches),
            ].join('\n'),
        }
    }
    return {
        error:
            formatAvailableSubagentsError(requestedId) +
            '\n' +
            'A bare id with no artifacts is indistinguishable from a successfully completed run ' +
            "(artifacts are deleted on success); its output is in the parent session's tool result.",
    }
}

// Id resolution for /subagents resume: exact or unique prefix against
// persisted runs that have a readable meta sidecar (the agent name and
// prompt hash needed to relaunch the run live there). Meta reading is
// shared with the other resolution helpers via listPersistedSubagents.
// Exact ids resolve across sessions; prefix candidates are scoped to this
// session (§11).
type PersistedResumeResolution = { id: string; meta: SubagentMeta } | { error: string }

function resolvePersistedResumeTarget(requestedId: string): PersistedResumeResolution {
    const exact = listPersistedSubagents().find(entry => entry.id === requestedId)
    if (exact) {
        if (!exact.meta) {
            return {
                error: `Cannot resume "${requestedId}": its meta sidecar is missing or unreadable. Start a fresh delegation instead.`,
            }
        }
        return { id: exact.id, meta: exact.meta }
    }

    const resumable = listSessionPersistedSubagents().filter(
        (entry): entry is PersistedSubagentEntry & { meta: SubagentMeta } =>
            entry.meta !== undefined
    )
    const matches = resumable.filter(entry => entry.id.startsWith(requestedId))
    if (matches.length === 1) return { id: matches[0].id, meta: matches[0].meta }
    if (matches.length > 1) {
        return {
            error: [
                `Ambiguous subagent id "${requestedId}" matches ${matches.length} persisted runs from this session:`,
                ...formatPersistedSubagentsList(matches),
            ].join('\n'),
        }
    }
    return { error: formatAvailableSubagentsError(requestedId) }
}

function readSubagentPid(pidPath: string): number | undefined {
    try {
        const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10)
        return Number.isNaN(pid) || pid <= 0 ? undefined : pid
    } catch {
        return undefined
    }
}

// Manager-view delete (§11): remove a persisted run's artifacts
// (.jsonl/.meta/.pid). Refuses ids owned by a live child — this session's
// registry or another session's live pidfile — and returns the refusal
// reason; undefined means the artifacts were removed.
//
// Not atomic: a concurrent session could resume this id between the
// isProcessAlive check and the file removal, orphaning the child.
// Acceptable because resume + delete of the same id requires deliberate
// user action in two sessions simultaneously, and Node is single-threaded
// so in-process races are impossible.
function deletePersistedRunArtifacts(subagentId: string): string | undefined {
    if (activeSubagents.has(subagentId)) {
        return `Refused: ${subagentId.slice(0, LIST_ID_SHORT_CHARS)} is running in this session — abort it first.`
    }
    const { session, pid, meta } = getSubagentFilePaths(subagentId)
    const livePid = readSubagentPid(pid)
    if (livePid !== undefined && isProcessAlive(livePid)) {
        return `Refused: pid ${livePid} is live — another session's child owns this run.`
    }
    removeSubagentFile(session)
    removeSubagentFile(pid)
    removeSubagentFile(meta)
    return undefined
}

interface SubagentRunStatus {
    status: string
    runningPid?: number
}

function deriveSubagentRunStatus(
    subagentId: string,
    meta: SubagentMeta | undefined
): SubagentRunStatus {
    const { pid: pidPath } = getSubagentFilePaths(subagentId)
    const pid = readSubagentPid(pidPath)
    if (pid !== undefined && isProcessAlive(pid)) return { status: 'running', runningPid: pid }
    // Stale pidfile (parent crashed before cleanup): unlock so the run stays resumable.
    if (pid !== undefined) removeSubagentFile(pidPath)
    return { status: meta?.status ?? 'unknown' }
}

function formatSubagentStatus(runStatus: SubagentRunStatus): string {
    return runStatus.runningPid !== undefined
        ? `${runStatus.status} (pid ${runStatus.runningPid})`
        : runStatus.status
}

function parseSubagentTranscript(sessionPath: string): Message[] {
    let content: string
    try {
        content = fs.readFileSync(sessionPath, 'utf-8')
    } catch {
        return []
    }
    const messages: Message[] = []
    for (const line of content.split('\n')) {
        if (!line.trim()) continue
        let entry: any
        try {
            entry = JSON.parse(line)
        } catch {
            // Torn lines (child killed mid-append) and unknown/future entry types
            // (session, model_change, thinking_level_change, compaction, ...) are skipped.
            continue
        }
        if (entry?.type === 'message' && entry.message) messages.push(entry.message as Message)
    }
    return messages
}

function computeTranscriptUsage(messages: Message[]): {
    usage: UsageStats
    model: string | undefined
} {
    const usage: UsageStats = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
    }
    let model: string | undefined
    for (const msg of messages) {
        if (msg.role !== 'assistant') continue
        usage.turns++
        // Mirrors runSingleAgent's stdout accounting so inspect totals match live results.
        if (msg.usage) {
            usage.input += msg.usage.input || 0
            usage.output += msg.usage.output || 0
            usage.cacheRead += msg.usage.cacheRead || 0
            usage.cacheWrite += msg.usage.cacheWrite || 0
            usage.cost += msg.usage.cost?.total || 0
            usage.contextTokens = msg.usage.totalTokens || 0
        }
        if (!model && msg.model) model = msg.model
    }
    return { usage, model }
}

// formatToolCall renders with theme colors for the TUI; model-facing tool-result text must stay plain.
function plainThemeFg(_color: any, text: string): string {
    return text
}

function buildSubagentInspectReport(subagentId: string, limit: number): string {
    const { session: sessionPath, meta: metaPath } = getSubagentFilePaths(subagentId)

    let meta: SubagentMeta | undefined
    try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SubagentMeta
    } catch {
        /* absent or unreadable sidecar */
    }

    const runStatus = deriveSubagentRunStatus(subagentId, meta)
    const status = runStatus.status

    const lines: string[] = [`Subagent: ${subagentId}`]
    lines.push(`Status: ${formatSubagentStatus(runStatus)}`)
    if (meta) {
        lines.push(`Agent: ${meta.agent}`)
        lines.push(`Task: ${previewText(meta.task, INSPECT_TASK_PREVIEW_CHARS)}`)
        if (meta.model) lines.push(`Model: ${meta.model}`)
        lines.push(`Started: ${meta.startedAt}`)
        if ((meta.resumedCount ?? 0) > 0) {
            lines.push(
                `Resumed: ${meta.resumedCount} time${meta.resumedCount === 1 ? '' : 's'}`
            )
        }
        if (status === 'failed' || status === 'aborted') {
            if (meta.stopReason) lines.push(`Stop reason: ${meta.stopReason}`)
            if (meta.exitCode !== undefined) lines.push(`Exit code: ${meta.exitCode}`)
        }
    } else {
        lines.push('Meta: missing (agent, task, and model unknown)')
    }

    const messages = parseSubagentTranscript(sessionPath)
    if (messages.length === 0) {
        // pi creates the session file at the first message_end, so runs interrupted
        // before that point have nothing to tail.
        lines.push('No transcript persisted yet.')
        return lines.join('\n')
    }

    const { usage, model } = computeTranscriptUsage(messages)
    const usageStr = formatUsageStats(usage, model ?? meta?.model)
    if (usageStr) lines.push(`Usage: ${usageStr}`)

    const items = getDisplayItems(messages)
    const tail = items.slice(-limit)
    lines.push(`--- Transcript: last ${tail.length} of ${items.length} entries ---`)
    for (const item of tail) {
        if (item.type === 'text') {
            const preview = item.text.replace(/\s+/g, ' ').trim()
            lines.push(
                preview.length > INSPECT_ENTRY_PREVIEW_CHARS
                    ? `${preview.slice(0, INSPECT_ENTRY_PREVIEW_CHARS)}...`
                    : preview
            )
        } else {
            lines.push(formatToolCall(item.name, item.args, plainThemeFg))
        }
    }

    const finalOutput = getFinalOutput(messages)
    if (finalOutput) {
        lines.push('--- Final output ---')
        lines.push(
            finalOutput.length > INSPECT_FINAL_OUTPUT_CAP
                ? `${finalOutput.slice(0, INSPECT_FINAL_OUTPUT_CAP)}...`
                : finalOutput
        )
    }

    if ((status === 'failed' || status === 'aborted') && meta) {
        lines.push(
            `Resume with subagent {agent: "${meta.agent}", task: "<continuation instruction>", resume: "${subagentId}"}.`
        )
    }

    return lines.join('\n')
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1]
    const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] }
    }

    const execName = path.basename(process.execPath).toLowerCase()
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
    if (!isGenericRuntime) {
        return { command: process.execPath, args }
    }

    return { command: 'pi', args }
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void

interface DispatchDefaults {
    model?: string
    thinkingLevel?: ThinkingLevel
}

async function runSingleAgent(
    defaultCwd: string,
    dispatchDefaults: DispatchDefaults,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: (results: SingleResult[]) => SubagentDetails,
    resume?: ResumeTarget,
    onSpawned?: (entry: ActiveSubagent) => void,
    relayUiRequest?: RelayUiRequest
): Promise<SingleResult> {
    const subagentId = resume?.id ?? uuidv7()
    const {
        session: sessionPath,
        pid: pidPath,
        meta: metaPath,
    } = getSubagentFilePaths(subagentId)
    const agent = agents.find(a => a.name === agentName)

    if (!agent) {
        const available = agents.map(a => `"${a.name}"`).join(', ') || 'none'
        return {
            agent: agentName,
            agentSource: 'unknown',
            task,
            subagentId,
            sessionPath,
            exitCode: 1,
            messages: [],
            stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
            },
            step,
        }
    }

    const args: string[] = ['--mode', 'rpc', '--session', sessionPath]
    // Resumes re-pass the recorded model/thinking because they reflect the original run;
    // continuity matters more than the current dispatch defaults.
    let model: string | undefined
    let thinkingLevel: ThinkingLevel | undefined
    let resumeNote: string | undefined
    if (resume) {
        model = resume.meta.model
        thinkingLevel = resume.meta.thinkingLevel
        if (!model) {
            model = dispatchDefaults.model
            resumeNote = model
                ? `Resumed with the current dispatch model (${model}); the original run recorded none.`
                : 'Resumed without a recorded model; the child used its own default model.'
        }
    } else {
        model = agent.model ?? dispatchDefaults.model
        // Only agents without a pinned model inherit the dispatch thinking level.
        if (!agent.model) thinkingLevel = dispatchDefaults.thinkingLevel
    }
    if (model) args.push('--model', model)
    if (thinkingLevel) args.push('--thinking', thinkingLevel)
    if (agent.tools && agent.tools.length > 0) args.push('--tools', agent.tools.join(','))

    let tmpPromptDir: string | null = null
    let tmpPromptPath: string | null = null

    const currentResult: SingleResult = {
        agent: agentName,
        agentSource: agent.source,
        task,
        subagentId,
        sessionPath,
        exitCode: 0,
        messages: [],
        stderr: '',
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
        },
        model,
        step,
        resumeNote,
    }

    const emitUpdate = () => {
        if (onUpdate) {
            onUpdate({
                content: [
                    {
                        type: 'text',
                        text: getFinalOutput(currentResult.messages) || '(running...)',
                    },
                ],
                details: makeDetails([currentResult]),
            })
        }
    }

    try {
        if (agent.systemPrompt.trim()) {
            const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt)
            tmpPromptDir = tmp.dir
            tmpPromptPath = tmp.filePath
            args.push('--append-system-prompt', tmpPromptPath)
        }

        let wasAborted = false

        ensureSubagentsDir()
        const spawnMeta: SubagentMeta = {
            agent: agentName,
            task,
            model,
            thinkingLevel,
            startedAt: new Date().toISOString(),
            promptHash: createHash('sha256').update(agent.systemPrompt).digest('hex'),
            // Omitted (undefined) when the session id was unavailable at spawn.
            parentSessionId: currentPiSessionId,
            resumedCount: resume ? (resume.meta.resumedCount ?? 0) + 1 : undefined,
        }
        writeSubagentMetaFile(metaPath, spawnMeta)

        const tag = subagentId.slice(0, 8)
        const debug = (msg: string) => subagentDebugLog(`[subagent:${tag}] ${msg}`)

        const exitCode = await new Promise<number>(resolve => {
            const invocation = getPiInvocation(args)
            debug(`spawn: ${invocation.command} ${invocation.args.join(' ')}`)
            const proc = spawn(invocation.command, invocation.args, {
                cwd: cwd ?? defaultCwd,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
            })
            debug(`pid: ${proc.pid ?? 'none'}`)
            if (proc.pid !== undefined) {
                try {
                    fs.writeFileSync(pidPath, `${proc.pid}\n`, {
                        encoding: 'utf-8',
                        mode: 0o600,
                    })
                } catch {
                    /* ignore */
                }
            }
            let buffer = ''
            let resolved = false
            let lastActivityTime = Date.now()
            let relayPending = false
            let eventCount = 0
            let lastEventType = ''
            let stdinClosed = false

            const safeResolve = (code: number, source: string) => {
                if (resolved) {
                    debug(`safeResolve (${source}): already resolved, ignoring code=${code}`)
                    return
                }
                resolved = true
                debug(
                    `safeResolve (${source}): code=${code}, events=${eventCount}, last=${lastEventType}`
                )
                clearInterval(stallWatchdog)
                resolve(code)
            }

            const drainBuffer = () => {
                try {
                    if (buffer.trim()) processLine(buffer)
                } catch {
                    /* final-line parse must not prevent resolve */
                }
                buffer = ''
            }

            // rpc-mode children take newline-terminated JSON commands on stdin.
            // Writes return false when the kernel buffer is full — Node still
            // queues them, so a false return is logged, not treated as failure
            // (steers are small/rare).
            const writeChildStdin = (command: Record<string, unknown>) => {
                try {
                    const ok = proc.stdin.write(`${JSON.stringify(command)}\n`)
                    if (ok === false)
                        debug(`stdin backpressure after ${String(command.type)} write`)
                } catch (err) {
                    debug(
                        `stdin write failed (${String(command.type)}): ${
                            err instanceof Error ? err.message : String(err)
                        }`
                    )
                }
            }

            const handleExtensionUiRequest = async (event: any) => {
                const method = String(event.method ?? '')
                const id = event.id

                // Relay select/confirm/input to the user when a callback is available.
                if (
                    relayUiRequest &&
                    (method === 'select' || method === 'confirm' || method === 'input')
                ) {
                    const release = await acquireRelayMutex()
                    relayPending = true
                    const controller = new AbortController()
                    const onRunAbort = () => controller.abort()
                    signal?.addEventListener('abort', onRunAbort, { once: true })
                    try {
                        const response = await relayUiRequest(
                            event,
                            agentName,
                            controller.signal
                        )
                        if (response) {
                            writeChildStdin({ type: 'extension_ui_response', id, ...response })
                            debug(`extension_ui: ${method} → relayed`)
                        } else {
                            writeChildStdin({
                                type: 'extension_ui_response',
                                id,
                                cancelled: true,
                            })
                            debug(`extension_ui: ${method} → relay cancelled`)
                        }
                    } catch (err) {
                        writeChildStdin({ type: 'extension_ui_response', id, cancelled: true })
                        debug(
                            `extension_ui: ${method} relay error: ${err instanceof Error ? err.message : String(err)}`
                        )
                    } finally {
                        relayPending = false
                        lastActivityTime = Date.now()
                        signal?.removeEventListener('abort', onRunAbort)
                        release()
                    }
                    return
                }

                // Fallback auto-responder when no relay callback is available:
                // reply with conservative defaults so the child doesn't hang.
                switch (method) {
                    case 'confirm':
                        writeChildStdin({
                            type: 'extension_ui_response',
                            id,
                            confirmed: false,
                        })
                        debug('extension_ui: confirm → denied')
                        break
                    case 'select': {
                        const options = Array.isArray(event.options) ? event.options : []
                        if (options.length > 0) {
                            writeChildStdin({
                                type: 'extension_ui_response',
                                id,
                                value: options[0],
                            })
                            debug(`extension_ui: select → first of ${options.length} options`)
                        } else {
                            writeChildStdin({
                                type: 'extension_ui_response',
                                id,
                                cancelled: true,
                            })
                            debug('extension_ui: select → cancelled (no options)')
                        }
                        break
                    }
                    case 'input':
                    case 'editor':
                        writeChildStdin({ type: 'extension_ui_response', id, cancelled: true })
                        debug(`extension_ui: ${method} → cancelled`)
                        break
                    case 'notify':
                    case 'setStatus':
                    case 'setWidget':
                    case 'setTitle':
                    case 'set_editor_text':
                        debug(`extension_ui: ${method} → fire-and-forget`)
                        break
                    default:
                        debug(`extension_ui: unknown method "${method}" → no reply`)
                }
            }

            // A steer starts a new LLM turn that can be legitimately silent
            // for longer than the stall timeout during prefill; resetting the
            // activity timer keeps the watchdog from killing a healthy child.
            const steerFn = (message: string) => {
                writeChildStdin({ type: 'steer', message })
                lastActivityTime = Date.now()
            }

            // rpc mode ignores positional CLI args, so the task travels as the
            // first stdin prompt.
            writeChildStdin({ type: 'prompt', message: `Task: ${task}` })

            const entry: ActiveSubagent = {
                id: subagentId,
                agent: agentName,
                task,
                proc,
                startedAt: Date.now(),
                eventEmitter: new EventEmitter(),
                settled: false,
                events: [],
                pendingSteers: [],
                steer: steerFn,
            }
            registerActiveSubagent(entry)
            // Fires before any child output can arrive (stdout events are
            // async; the awaiting caller resumes first), so callers can
            // attach immediately — /subagents resume relies on this.
            onSpawned?.(entry)

            const processLine = (line: string) => {
                if (!line.trim()) return
                let event: any
                try {
                    event = JSON.parse(line)
                } catch {
                    return
                }
                lastActivityTime = Date.now()
                const type = event.type ?? 'unknown'

                // rpc-mode-only frames (verified against
                // packages/coding-agent/src/modes/rpc/rpc-mode.ts). They sit
                // after the watchdog reset so a frame flood counts as genuine
                // stdout activity, but before eventCount so command acks and
                // control frames stay out of transcript accounting.
                if (type === 'response') {
                    // Command ack, not a transcript event — but a failed ack
                    // must not vanish silently: rpc-mode replies
                    // {success:false, error} when a command is rejected.
                    if (event.success === false) {
                        const command = String(event.command ?? 'unknown')
                        const error = String(event.error ?? 'unknown error')
                        debug(`response: ${command} rejected: ${error}`)
                        if (command === 'steer') {
                            // Emitter-only so an open attach view renders it:
                            // parent-side metadata, not child transcript, so
                            // the replay ring is not polluted with it.
                            entry.eventEmitter.emit('event', {
                                type: 'steer_error',
                                error: event.error ?? 'steer rejected',
                            })
                        } else if (command === 'prompt' && eventCount === 0) {
                            // Initial prompt rejected preflight: the child
                            // sits idle forever. Fail fast instead of waiting
                            // for the stall watchdog; safeResolve alone leaves
                            // the child running, so kill it too.
                            currentResult.stderr = currentResult.stderr
                                ? `${currentResult.stderr}\n${error}`
                                : error
                            currentResult.errorMessage = error
                            safeResolve(1, 'prompt-rejected')
                            proc.kill('SIGTERM')
                        }
                    }
                    return
                }
                if (type === 'extension_error') {
                    debug(
                        `extension_error: ${String(event.extensionPath ?? '?')} ${String(event.error ?? '')}`
                    )
                    return
                }
                if (type === 'extension_ui_request') {
                    handleExtensionUiRequest(event).catch(err => {
                        debug(
                            `extension_ui relay error: ${err instanceof Error ? err.message : String(err)}`
                        )
                        writeChildStdin({
                            type: 'extension_ui_response',
                            id: event.id,
                            cancelled: true,
                        })
                    })
                    return
                }

                eventCount++
                lastEventType = type

                // Forward before the dispatch chain so events that also hit
                // message_end / tool_result_end are forwarded too. The ring
                // holds only renderable events (late-attach replay history):
                // high-frequency streaming frames would evict real history
                // from the capped ring without ever being rendered. The
                // emitter and eventBus still carry the full live stream.
                const renderable = !NON_RENDERABLE_EVENT_TYPES.has(type)
                if (renderable) pushSubagentEvent(entry, event)
                entry.eventEmitter.emit('event', event)
                eventBus?.emit('subagent:event', { subagentId, agent: agentName, event })

                // Whole-list replacement: the child re-emits queue_update
                // without a text once it is dequeued for delivery, so the
                // latest frame is the authoritative pending set.
                if (type === 'queue_update' && Array.isArray(event.steering)) {
                    entry.pendingSteers = event.steering.map(String)
                }

                if (type === 'agent_settled') {
                    // Normal lifecycle end, never an error. Closing stdin makes
                    // the rpc child exit via its stdin-'end' → shutdown() path;
                    // guarded so the first frame is the only close attempt.
                    entry.settled = true
                    if (!stdinClosed) {
                        stdinClosed = true
                        try {
                            proc.stdin.end()
                        } catch {
                            /* stream already destroyed */
                        }
                        debug('agent_settled: stdin closed for clean child shutdown')
                    }
                } else if (event.type === 'message_end' && event.message) {
                    const msg = event.message as Message
                    currentResult.messages.push(msg)
                    debug(`message_end: role=${msg.role} stopReason=${msg.stopReason ?? '-'}`)

                    if (msg.role === 'assistant') {
                        currentResult.usage.turns++
                        const usage = msg.usage
                        if (usage) {
                            currentResult.usage.input += usage.input || 0
                            currentResult.usage.output += usage.output || 0
                            currentResult.usage.cacheRead += usage.cacheRead || 0
                            currentResult.usage.cacheWrite += usage.cacheWrite || 0
                            currentResult.usage.cost += usage.cost?.total || 0
                            currentResult.usage.contextTokens = usage.totalTokens || 0
                        }
                        if (!currentResult.model && msg.model) currentResult.model = msg.model
                        if (msg.stopReason) currentResult.stopReason = msg.stopReason
                        if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage
                    }
                    emitUpdate()
                } else if (event.type === 'tool_result_end' && event.message) {
                    currentResult.messages.push(event.message as Message)
                    debug(`tool_result_end`)
                    emitUpdate()
                } else if (
                    type !== 'unknown' &&
                    type !== 'message_update' &&
                    type !== 'tool_execution_update'
                ) {
                    // Per-event logging is for low-rate lifecycle events only:
                    // message_update / tool_execution_update fire per streaming
                    // chunk and would spam the parent TUI. The activity tracking
                    // above still records them for the stall diagnostic.
                    debug(`event: ${type}`)
                }
            }

            proc.stdout.on('data', data => {
                lastActivityTime = Date.now()
                buffer += data.toString()
                const lines = buffer.split('\n')
                buffer = lines.pop() || ''
                for (const line of lines) processLine(line)
            })

            proc.stderr.on('data', data => {
                lastActivityTime = Date.now()
                currentResult.stderr += data.toString()
            })

            proc.on('close', (code, killSignal) => {
                debug(`close: code=${code} signal=${killSignal ?? '-'}`)
                // 'close' fires after 'exit' and also after 'error' (spawn
                // failures emit 'error' then 'close'), so this single
                // unregister point covers every exit path.
                unregisterActiveSubagent(subagentId)
                drainBuffer()
                safeResolve(killSignal ? 1 : (code ?? 0), 'close')
            })

            // `close` waits for stdio streams to end, which hangs when a
            // grandchild (e.g. a backgrounded bash tool) inherited the pipe.
            // Fall back to resolving shortly after the process itself exits.
            proc.on('exit', (code, killSignal) => {
                debug(`exit: code=${code} signal=${killSignal ?? '-'}`)
                const exitValue = killSignal ? 1 : (code ?? 0)
                const fallback = setTimeout(() => {
                    // The timer fires even when close already resolved; without
                    // this check every run logged a false "close did not fire".
                    if (resolved) return
                    debug('exit fallback: close did not fire in 3s, destroying streams')
                    proc.stdout?.destroy()
                    proc.stderr?.destroy()
                    drainBuffer()
                    safeResolve(exitValue, 'exit-fallback')
                }, 3000)
                fallback.unref()
            })

            proc.on('error', err => {
                debug(`error: ${err.message}`)
                safeResolve(1, 'error')
            })

            // Watchdog: kill the child if stdout+stderr go silent for too long.
            // Legitimate long operations (bash tools) still produce stderr
            // progress; true silence means the child is stuck.
            const stallWatchdog = setInterval(() => {
                if (relayPending) return
                const silentMs = Date.now() - lastActivityTime
                if (silentMs >= STALL_TIMEOUT_MS) {
                    debug(
                        `stall watchdog: no activity for ${Math.round(silentMs / 1000)}s, ` +
                            `events=${eventCount}, last=${lastEventType}, killing child`
                    )
                    clearInterval(stallWatchdog)
                    proc.kill('SIGTERM')
                    setTimeout(() => {
                        try {
                            if (!proc.killed) proc.kill('SIGKILL')
                        } catch {
                            /* ignore */
                        }
                    }, 5000)
                }
            }, STALL_CHECK_INTERVAL_MS)
            stallWatchdog.unref()

            if (signal) {
                const killProc = () => {
                    wasAborted = true
                    debug('abort signal received, killing child')
                    proc.kill('SIGTERM')
                    setTimeout(() => {
                        if (!proc.killed) proc.kill('SIGKILL')
                    }, 5000)
                }
                if (signal.aborted) killProc()
                else signal.addEventListener('abort', killProc, { once: true })
            }
        })
        debug(`promise resolved: exitCode=${exitCode}`)

        currentResult.exitCode = exitCode
        if (wasAborted) {
            currentResult.aborted = true
            currentResult.stopReason = 'aborted'
        }

        const status = wasAborted
            ? 'aborted'
            : isFailedResult(currentResult)
              ? 'failed'
              : 'succeeded'
        removeSubagentFile(pidPath)
        if (status === 'succeeded') {
            removeSubagentFile(sessionPath)
            removeSubagentFile(metaPath)
        } else {
            writeSubagentMetaFile(metaPath, {
                ...spawnMeta,
                status,
                stopReason: currentResult.stopReason,
                exitCode,
                sessionHeaderId: readSessionHeaderId(sessionPath),
            })
        }

        debug(`returning: status=${status} stopReason=${currentResult.stopReason ?? '-'}`)
        return currentResult
    } finally {
        if (tmpPromptPath)
            try {
                fs.unlinkSync(tmpPromptPath)
            } catch {
                /* ignore */
            }
        if (tmpPromptDir)
            try {
                fs.rmdirSync(tmpPromptDir)
            } catch {
                /* ignore */
            }
    }
}

// Command-level notices: print mode has no UI, so stdout replaces notify
// (json/no-ui modes keep notify, a no-op there — same contract as the
// pre-existing branches this consolidates).
function emitCommandNotice(
    ctx: ExtensionContext,
    message: string,
    severity: 'info' | 'warning' | 'error'
): void {
    if (ctx.mode === 'print') {
        console.log(message)
        return
    }
    ctx.ui.notify(message, severity)
}

// /subagents resume <id> [instruction...] — relaunch a persisted failed or
// aborted run in this session and attach to it. Unlike the subagent tool's
// resume path, no tool result consumes the run: runSingleAgent is fired and
// forgotten, the handler returns when the attach view closes, and the
// child's outcome lands in the persisted meta/session files.
async function handleSubagentsResume(ctx: ExtensionContext, rest: string[]): Promise<void> {
    capturePiSessionId(ctx)

    // Id omission (§11): exactly one session-scoped resumable candidate
    // resumes with the default instruction. The zero-case names the
    // cross-session escape hatch — explicit full ids keep resolving globally.
    let requestedId = rest[0]
    if (!requestedId) {
        const candidates = listSessionResumableSubagents()
        if (candidates.length === 0) {
            emitCommandNotice(
                ctx,
                'No resumable subagent runs from this session. Runs from other pi sessions are hidden — ' +
                    'resume one with its full id: /subagents resume <id>.',
                'info'
            )
            return
        }
        if (candidates.length > 1) {
            emitCommandNotice(
                ctx,
                [
                    `${candidates.length} resumable runs from this session — pick one:`,
                    ...formatPersistedSubagentsList(candidates),
                ].join('\n'),
                'warning'
            )
            return
        }
        requestedId = candidates[0].id
    }

    // The command grammar carries no quoting: whitespace-split words are
    // re-joined with single spaces. When the id came from the omission
    // path, rest is empty and the default instruction applies.
    const instruction = rest.slice(1).join(' ') || RESUME_DEFAULT_INSTRUCTION

    const resolved = resolvePersistedResumeTarget(requestedId)
    if ('error' in resolved) {
        emitCommandNotice(ctx, resolved.error, 'warning')
        return
    }
    const shortId = resolved.id.slice(0, LIST_ID_SHORT_CHARS)

    // Resume needs the interactive attach view; checked after id handling so
    // the omission/resolution notices stay observable in print/rpc modes.
    if (ctx.mode !== 'tui') {
        emitCommandNotice(ctx, 'resume requires an interactive session', 'warning')
        return
    }

    if (activeSubagents.has(resolved.id)) {
        ctx.ui.notify(
            `Subagent ${shortId} is already running in this session — attach with /subagents attach instead of resuming.`,
            'warning'
        )
        return
    }

    // Scope "both": the run's agent may be project-local, and a user-typed
    // command needs no project-trust confirm (that gate protects
    // model-initiated tool calls, not direct user intent).
    const discovery = discoverAgents(ctx.cwd, 'both')
    const agents = discovery.agents
    if (!agents.some(a => a.name === resolved.meta.agent)) {
        const available = agents.map(a => `"${a.name}"`).join(', ') || 'none'
        ctx.ui.notify(
            `Cannot resume ${shortId}: agent "${resolved.meta.agent}" from the original run is no longer among the loaded agents (${available}).`,
            'warning'
        )
        return
    }

    // Shared gate with the subagent tool's resume parameter: session file
    // exists, pidfile not live (another pi session's child), prompt hash
    // unchanged.
    const resumeTarget = resolveResumeTarget(resolved.id, resolved.meta.agent, agents)
    if (typeof resumeTarget === 'string') {
        ctx.ui.notify(resumeTarget, 'warning')
        return
    }

    const makeDetails = (results: SingleResult[]): SubagentDetails => ({
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: discovery.projectAgentsDir,
        results,
    })

    // The registry entry only exists once runSingleAgent spawns the child;
    // onSpawned bridges it out so the handler can attach without awaiting
    // the full run. Pre-spawn exits (early return or rejection) resolve
    // undefined via the settlement handlers below so the timeout message is
    // not stacked on top of the real failure.
    let deliverEntry!: (entry: ActiveSubagent | undefined) => void
    const entryPromise = new Promise<ActiveSubagent | undefined>(resolve => {
        deliverEntry = resolve
    })
    const spawnTimeout = setTimeout(() => deliverEntry(undefined), RESUME_SPAWN_TIMEOUT_MS)
    let failureNotified = false
    const relayUiRequest = buildRelayUiRequest(ctx)

    void runSingleAgent(
        ctx.cwd,
        {}, // Resume takes model/thinking from the meta sidecar; no dispatch defaults.
        agents,
        resolved.meta.agent,
        instruction,
        undefined,
        undefined,
        undefined,
        undefined,
        makeDetails,
        resumeTarget,
        entry => deliverEntry(entry),
        relayUiRequest
    ).then(
        () => deliverEntry(undefined),
        err => {
            failureNotified = true
            deliverEntry(undefined)
            ctx.ui.notify(
                `Resuming subagent ${shortId} failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
                'error'
            )
        }
    )

    const entry = await entryPromise
    clearTimeout(spawnTimeout)
    if (!entry) {
        if (!failureNotified) {
            ctx.ui.notify(
                `Resuming subagent ${shortId} failed: it did not start within ${Math.round(RESUME_SPAWN_TIMEOUT_MS / 1000)}s.`,
                'error'
            )
        }
        return
    }

    await attachToSubagent(ctx, entry)
    // Settled → the view closed on agent_settled; a non-null exit code or
    // signal covers watchdog kills and crashes that close the view via proc
    // close without a settle frame. Anything else means the user detached.
    if (entry.settled || entry.proc.exitCode !== null || entry.proc.signalCode !== null) {
        ctx.ui.notify(`Subagent ${shortId} finished.`, 'info')
    } else {
        ctx.ui.notify(
            `Subagent ${shortId} keeps running — reattach with /subagents attach.`,
            'info'
        )
    }
}

// ── /subagents manager view (§11) ───────────────────────────────────

type ManagerRow =
    | {
          kind: 'running'
          id: string
          agent: string
          task: string
          startedAt: number
          entry: ActiveSubagent
      }
    | {
          kind: 'persisted'
          id: string
          agent: string
          task: string
          status: string
      }

// Actions that close the manager (done() first, then the flow runs — no
// auto-return to the manager).
type ManagerAction =
    | { type: 'attach'; entry: ActiveSubagent }
    | { type: 'resume'; id: string }
    | { type: 'inspect'; id: string }

// Rows are re-scanned on every render: RUNNING children that settle while the
// view is open drop out on the next redraw, and fresh PERSISTED failures
// appear. Registry children get a close hook so a settle/abort/kill without a
// keypress still triggers the re-scan render.
async function openSubagentsManager(ctx: ExtensionContext): Promise<void> {
    const action = await ctx.ui.custom<ManagerAction | undefined>((tui, theme, _kb, done) => {
        let finished = false
        let selected = 0
        let message: string | undefined
        let messageIsError = false
        let cachedRows: ManagerRow[] | undefined
        const hookedProcs = new Set<ChildProcess>()
        const onProcClose = () => {
            if (!finished) {
                cachedRows = undefined
                tui.requestRender()
            }
        }

        const finish = (result: ManagerAction | undefined): void => {
            if (finished) return
            finished = true
            for (const proc of hookedProcs) proc.removeListener('close', onProcClose)
            done(result)
        }

        function scanRows(): ManagerRow[] {
            if (cachedRows) return cachedRows
            const running: ManagerRow[] = [...activeSubagents.values()]
                .filter(entry => !entry.settled)
                .sort((a, b) => a.startedAt - b.startedAt)
                .map(entry => {
                    if (!hookedProcs.has(entry.proc)) {
                        hookedProcs.add(entry.proc)
                        entry.proc.once('close', onProcClose)
                    }
                    return {
                        kind: 'running' as const,
                        id: entry.id,
                        agent: entry.agent,
                        task: entry.task,
                        startedAt: entry.startedAt,
                        entry,
                    }
                })
            const persisted: ManagerRow[] = listSessionResumableSubagents()
                .filter(entry => !activeSubagents.has(entry.id))
                .sort((a, b) =>
                    (b.meta!.startedAt ?? b.id).localeCompare(a.meta!.startedAt ?? a.id)
                )
                .map(entry => ({
                    kind: 'persisted' as const,
                    id: entry.id,
                    agent: entry.meta!.agent,
                    task: entry.meta!.task,
                    status: deriveSubagentRunStatus(entry.id, entry.meta).status,
                }))
            cachedRows = [...running, ...persisted]
            return cachedRows
        }

        function rowLine(row: ManagerRow, isSelected: boolean): string {
            const marker = isSelected ? theme.fg('accent', '▸ ') : '  '
            const preview = previewText(row.task, ATTACH_TASK_PREVIEW_CHARS)
            if (row.kind === 'running') {
                return (
                    marker +
                    theme.fg('accent', row.id.slice(0, LIST_ID_SHORT_CHARS)) +
                    ' ' +
                    theme.fg('toolTitle', row.agent) +
                    ' ' +
                    theme.fg('muted', formatElapsedMs(Date.now() - row.startedAt)) +
                    ' ' +
                    theme.fg('dim', preview)
                )
            }
            const statusColor =
                row.status === 'failed'
                    ? 'error'
                    : row.status === 'aborted'
                      ? 'warning'
                      : 'dim'
            return (
                marker +
                theme.fg(statusColor, row.status) +
                ' ' +
                theme.fg('toolTitle', row.agent) +
                ' ' +
                theme.fg('accent', row.id.slice(0, LIST_ID_SHORT_CHARS)) +
                ' ' +
                theme.fg('dim', preview)
            )
        }

        function footerLegend(row: ManagerRow | undefined): string {
            if (!row) return theme.fg('dim', 'no subagents · Esc/q close')
            const nav = theme.fg('dim', '↑↓/jk select · ')
            if (row.kind === 'running')
                return (
                    nav + theme.fg('dim', 'Enter/a attach · x abort · i inspect · Esc/q close')
                )
            return nav + theme.fg('dim', 'Enter/r resume · d delete · i inspect · Esc/q close')
        }

        function render(_width: number): string[] {
            const rows = scanRows()
            if (selected >= rows.length) selected = Math.max(0, rows.length - 1)
            const selectedRow: ManagerRow | undefined = rows[selected]

            const lines: string[] = [
                theme.fg('toolTitle', theme.bold('subagents ')) +
                    theme.fg(
                        'muted',
                        `session ${currentPiSessionId?.slice(0, LIST_ID_SHORT_CHARS) ?? '?'}`
                    ),
                '',
                theme.fg('toolTitle', 'RUNNING'),
            ]
            const runningCount = rows.filter(row => row.kind === 'running').length
            if (runningCount === 0) lines.push(theme.fg('dim', '  (none)'))
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].kind === 'running') lines.push(rowLine(rows[i], i === selected))
            }

            lines.push(
                '',
                theme.fg('toolTitle', 'PERSISTED ') + theme.fg('muted', 'this session')
            )
            const persistedCount = rows.length - runningCount
            if (persistedCount === 0) lines.push(theme.fg('dim', '  (none)'))
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].kind === 'persisted') lines.push(rowLine(rows[i], i === selected))
            }

            if (message) {
                lines.push('', theme.fg(messageIsError ? 'error' : 'dim', message))
            }
            lines.push('', footerLegend(selectedRow))
            return lines
        }

        function handleInput(data: string): void {
            cachedRows = undefined
            if (matchesKey(data, Key.escape)) {
                finish(undefined)
                return
            }
            // j/k and the action letters arrive as raw chars on legacy
            // terminals and CSI-u sequences on kitty-protocol ones;
            // decodeSteerText covers both and rejects escape-prefixed input.
            const ch = decodeSteerText(data)
            if (ch === 'q') {
                finish(undefined)
                return
            }

            const rows = scanRows()
            if (selected >= rows.length) selected = Math.max(0, rows.length - 1)
            const row: ManagerRow | undefined = rows[selected]
            const showNotice = (text: string, isError = false): void => {
                message = text
                messageIsError = isError
                tui.requestRender()
            }

            if (matchesKey(data, Key.up) || ch === 'k') {
                selected = Math.max(0, selected - 1)
                message = undefined
                tui.requestRender()
                return
            }
            if (matchesKey(data, Key.down) || ch === 'j') {
                selected = Math.min(rows.length - 1, selected + 1)
                message = undefined
                tui.requestRender()
                return
            }
            if (!row) return

            if (matchesKey(data, Key.enter) || ch === 'a') {
                if (row.kind === 'running') {
                    finish({ type: 'attach', entry: row.entry })
                } else if (ch === 'a') {
                    showNotice('attach applies to running rows only', true)
                } else {
                    finish({ type: 'resume', id: row.id })
                }
                return
            }
            if (ch === 'x') {
                if (row.kind !== 'running') {
                    showNotice('abort applies to running rows only', true)
                    return
                }
                try {
                    // SIGTERM through the same proc.kill path the abort signal
                    // and watchdog use; registry cleanup and any pending
                    // tool-call result settle through the existing handlers.
                    row.entry.proc.kill('SIGTERM')
                    showNotice(
                        `Aborting ${row.id.slice(0, LIST_ID_SHORT_CHARS)} — SIGTERM sent; the row drops out when the child exits.`
                    )
                } catch {
                    showNotice(
                        `Abort failed: child of ${row.id.slice(0, LIST_ID_SHORT_CHARS)} is already dead`,
                        true
                    )
                }
                return
            }
            if (ch === 'r') {
                if (row.kind !== 'persisted') {
                    showNotice('resume applies to persisted rows only', true)
                    return
                }
                finish({ type: 'resume', id: row.id })
                return
            }
            if (ch === 'd') {
                if (row.kind !== 'persisted') {
                    showNotice('delete applies to persisted rows only', true)
                    return
                }
                const refusal = deletePersistedRunArtifacts(row.id)
                if (refusal) showNotice(refusal, true)
                else
                    showNotice(
                        `Deleted ${row.id.slice(0, LIST_ID_SHORT_CHARS)} artifacts (.jsonl/.meta/.pid).`
                    )
                return
            }
            if (ch === 'i') {
                finish({ type: 'inspect', id: row.id })
            }
        }

        return {
            render,
            invalidate: () => {
                // Nothing caches across renders — every render re-scans.
            },
            handleInput,
            dispose: () => finish(undefined),
        }
    })

    if (!action) return
    if (action.type === 'attach') {
        await attachToSubagent(ctx, action.entry)
        return
    }
    if (action.type === 'resume') {
        await handleSubagentsResume(ctx, [action.id])
        return
    }
    await openSubagentInspectView(ctx, action.id)
}

// Manager inspect action (§11): buildSubagentInspectReport rendered in a
// minimal scrollable text view using the attach view's manual scroll pattern
// (the layout engine cannot scroll inside ui.custom). Esc closes; the
// manager is not restored afterwards.
async function openSubagentInspectView(
    ctx: ExtensionContext,
    subagentId: string
): Promise<void> {
    const reportLines = buildSubagentInspectReport(subagentId, INSPECT_DEFAULT_LIMIT).split(
        '\n'
    )
    const shortId = subagentId.slice(0, LIST_ID_SHORT_CHARS)
    // Header + footer rows on top of the attach view's dock reservation.
    const INSPECT_CHROME_ROWS = 2

    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let finished = false
        let scrollTop = 0
        let cachedWidth = -1
        let cachedLines: string[] | undefined
        // Scroll bounds from the last render; handleInput has no width.
        let lastLineCount = 0
        let lastViewportHeight = ATTACH_MIN_VIEWPORT_LINES

        const finish = () => {
            if (finished) return
            finished = true
            done()
        }

        const viewportLines = () =>
            Math.max(
                ATTACH_MIN_VIEWPORT_LINES,
                tui.terminal.rows - ATTACH_RESERVED_TERMINAL_ROWS - INSPECT_CHROME_ROWS
            )

        // The report is plain text; overlong lines hard-wrap at the width.
        const wrapped = (width: number): string[] => {
            if (cachedLines && cachedWidth === width) return cachedLines
            const out: string[] = []
            for (const line of reportLines) {
                if (line.length <= width) out.push(line)
                else
                    for (let i = 0; i < line.length; i += width)
                        out.push(line.slice(i, i + width))
            }
            cachedLines = out
            cachedWidth = width
            return out
        }

        function render(width: number): string[] {
            const lines = wrapped(width)
            lastLineCount = lines.length
            const height = Math.min(lines.length, viewportLines())
            lastViewportHeight = height
            const maxScrollTop = Math.max(0, lines.length - height)
            scrollTop = Math.min(scrollTop, maxScrollTop)
            return [
                theme.fg('toolTitle', theme.bold('inspect ')) + theme.fg('accent', shortId),
                '',
                ...lines.slice(scrollTop, scrollTop + height),
                '',
                theme.fg('dim', '↑↓/jk PgUp/PgDn Home/End scroll · Esc/q close'),
            ]
        }

        function handleInput(data: string): void {
            if (matchesKey(data, Key.escape)) {
                finish()
                return
            }
            const ch = decodeSteerText(data)
            if (ch === 'q') {
                finish()
                return
            }
            const maxScrollTop = Math.max(0, lastLineCount - lastViewportHeight)
            if (matchesKey(data, Key.up) || ch === 'k') {
                scrollTop = Math.max(0, scrollTop - 1)
            } else if (matchesKey(data, Key.down) || ch === 'j') {
                scrollTop = Math.min(maxScrollTop, scrollTop + 1)
            } else if (matchesKey(data, Key.pageUp)) {
                scrollTop = Math.max(0, scrollTop - lastViewportHeight)
            } else if (matchesKey(data, Key.pageDown)) {
                scrollTop = Math.min(maxScrollTop, scrollTop + lastViewportHeight)
            } else if (matchesKey(data, Key.home)) {
                scrollTop = 0
            } else if (matchesKey(data, Key.end)) {
                scrollTop = maxScrollTop
            } else {
                return
            }
            tui.requestRender()
        }

        return {
            render,
            invalidate: () => {
                cachedLines = undefined
            },
            handleInput,
            dispose: () => finish(),
        }
    })
}

const TaskItem = Type.Object({
    agent: Type.String({ description: 'Name of the agent to invoke' }),
    task: Type.String({ description: 'Task to delegate to the agent' }),
    cwd: Type.Optional(
        Type.String({ description: 'Working directory for the agent process' })
    ),
})

const ChainItem = Type.Object({
    agent: Type.String({ description: 'Name of the agent to invoke' }),
    task: Type.String({
        description: 'Task with optional {previous} placeholder for prior output',
    }),
    cwd: Type.Optional(
        Type.String({ description: 'Working directory for the agent process' })
    ),
})

const AgentScopeSchema = StringEnum(['user', 'project', 'both'] as const, {
    description:
        'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
    default: 'user',
})

const SubagentParams = Type.Object({
    agent: Type.Optional(
        Type.String({ description: 'Name of the agent to invoke (for single mode)' })
    ),
    task: Type.Optional(Type.String({ description: 'Task to delegate (for single mode)' })),
    resume: Type.Optional(
        Type.String({
            description: 'Id of a persisted subagent run to resume (single mode only)',
        })
    ),
    tasks: Type.Optional(
        Type.Array(TaskItem, { description: 'Array of {agent, task} for parallel execution' })
    ),
    chain: Type.Optional(
        Type.Array(ChainItem, {
            description: 'Array of {agent, task} for sequential execution',
        })
    ),
    agentScope: Type.Optional(AgentScopeSchema),
    confirmProjectAgents: Type.Optional(
        Type.Boolean({
            description: 'Prompt before running project-local agents. Default: true.',
            default: true,
        })
    ),
    cwd: Type.Optional(
        Type.String({ description: 'Working directory for the agent process (single mode)' })
    ),
})

const SubagentInspectParams = Type.Object({
    id: Type.String({ description: 'Subagent id (exact filename id or unique prefix)' }),
    limit: Type.Optional(
        Type.Number({
            description: 'Number of transcript entries to show from the end',
            minimum: 1,
        })
    ),
})

export default function (pi: ExtensionAPI) {
    eventBus = pi.events

    pi.registerTool({
        name: 'subagent',
        label: 'Subagent',
        description: [
            'Delegate tasks to specialized subagents with isolated context.',
            'Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).',
            'Resume: in single mode pass resume: <subagentId> to continue a persisted interrupted/failed run ' +
                '(agent must match the original run).',
            `Default agent scope is "user" (from ${path.join(getAgentDir(), 'agents')}).`,
            `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
        ].join(' '),
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            capturePiSessionId(ctx)
            const agentScope: AgentScope = params.agentScope ?? 'user'
            const dispatchDefaults: DispatchDefaults = {
                model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
                thinkingLevel: ctx.thinkingLevel,
            }
            const discovery = discoverAgents(ctx.cwd, agentScope)
            const agents = discovery.agents
            const confirmProjectAgents = params.confirmProjectAgents ?? true

            const hasChain = (params.chain?.length ?? 0) > 0
            const hasTasks = (params.tasks?.length ?? 0) > 0
            const hasSingle = Boolean(params.agent && params.task)
            const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle)

            const makeDetails =
                (mode: 'single' | 'parallel' | 'chain') =>
                (results: SingleResult[]): SubagentDetails => ({
                    mode,
                    agentScope,
                    projectAgentsDir: discovery.projectAgentsDir,
                    results,
                })

            if (modeCount !== 1) {
                const available =
                    agents.map(a => `${a.name} (${a.source})`).join(', ') || 'none'
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
                        },
                    ],
                    details: makeDetails('single')([]),
                }
            }

            if (params.resume && (hasChain || hasTasks)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text:
                                'Invalid parameters: "resume" is single-mode only ({agent, task, resume}). ' +
                                'Remove "resume" or restructure as a single delegation.',
                        },
                    ],
                    details: makeDetails('single')([]),
                }
            }

            if (
                (agentScope === 'project' || agentScope === 'both') &&
                confirmProjectAgents &&
                ctx.hasUI &&
                !ctx.isProjectTrusted()
            ) {
                const requestedAgentNames = new Set<string>()
                if (params.chain)
                    for (const step of params.chain) requestedAgentNames.add(step.agent)
                if (params.tasks)
                    for (const t of params.tasks) requestedAgentNames.add(t.agent)
                if (params.agent) requestedAgentNames.add(params.agent)

                const projectAgentsRequested = Array.from(requestedAgentNames)
                    .map(name => agents.find(a => a.name === name))
                    .filter((a): a is AgentConfig => a?.source === 'project')

                if (projectAgentsRequested.length > 0) {
                    const names = projectAgentsRequested.map(a => a.name).join(', ')
                    const dir = discovery.projectAgentsDir ?? '(unknown)'
                    const ok = await ctx.ui.confirm(
                        'Run project-local agents?',
                        `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`
                    )
                    if (!ok)
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: 'Canceled: project-local agents not approved.',
                                },
                            ],
                            details: makeDetails(
                                hasChain ? 'chain' : hasTasks ? 'parallel' : 'single'
                            )([]),
                        }
                }
            }

            const relayUiRequest = buildRelayUiRequest(ctx)

            if (params.chain && params.chain.length > 0) {
                const results: SingleResult[] = []
                let previousOutput = ''

                for (let i = 0; i < params.chain.length; i++) {
                    const step = params.chain[i]
                    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput)

                    // Create update callback that includes all previous results
                    const chainUpdate: OnUpdateCallback | undefined = onUpdate
                        ? partial => {
                              // Combine completed results with current streaming result
                              const currentResult = partial.details?.results[0]
                              if (currentResult) {
                                  const allResults = [...results, currentResult]
                                  onUpdate({
                                      content: partial.content,
                                      details: makeDetails('chain')(allResults),
                                  })
                              }
                          }
                        : undefined

                    const result = await runSingleAgent(
                        ctx.cwd,
                        dispatchDefaults,
                        agents,
                        step.agent,
                        taskWithContext,
                        step.cwd,
                        i + 1,
                        signal,
                        chainUpdate,
                        makeDetails('chain'),
                        undefined,
                        undefined,
                        relayUiRequest
                    )
                    results.push(result)

                    const isError = isFailedResult(result)
                    if (isError) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: `Chain stopped at step ${i + 1} (${step.agent}):\n\n${formatFailureReport(result)}`,
                                },
                            ],
                            details: makeDetails('chain')(results),
                            isError: true,
                        }
                    }
                    previousOutput = getFinalOutput(result.messages)
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text:
                                getFinalOutput(results[results.length - 1].messages) ||
                                '(no output)',
                        },
                    ],
                    details: makeDetails('chain')(results),
                }
            }

            if (params.tasks && params.tasks.length > 0) {
                if (params.tasks.length > MAX_PARALLEL_TASKS)
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                            },
                        ],
                        details: makeDetails('parallel')([]),
                    }

                // Track all results for streaming updates
                const allResults: SingleResult[] = new Array(params.tasks.length)

                // Initialize placeholder results
                for (let i = 0; i < params.tasks.length; i++) {
                    allResults[i] = {
                        agent: params.tasks[i].agent,
                        agentSource: 'unknown',
                        task: params.tasks[i].task,
                        subagentId: '',
                        sessionPath: '',
                        exitCode: -1, // -1 = still running
                        messages: [],
                        stderr: '',
                        usage: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            cost: 0,
                            contextTokens: 0,
                            turns: 0,
                        },
                    }
                }

                const emitParallelUpdate = () => {
                    if (onUpdate) {
                        const running = allResults.filter(r => r.exitCode === -1).length
                        const done = allResults.filter(r => r.exitCode !== -1).length
                        onUpdate({
                            content: [
                                {
                                    type: 'text',
                                    text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
                                },
                            ],
                            details: makeDetails('parallel')([...allResults]),
                        })
                    }
                }

                const results = await mapWithConcurrencyLimit(
                    params.tasks,
                    MAX_CONCURRENCY,
                    async (t, index) => {
                        const result = await runSingleAgent(
                            ctx.cwd,
                            dispatchDefaults,
                            agents,
                            t.agent,
                            t.task,
                            t.cwd,
                            undefined,
                            signal,
                            // Per-task update callback
                            partial => {
                                if (partial.details?.results[0]) {
                                    allResults[index] = partial.details.results[0]
                                    emitParallelUpdate()
                                }
                            },
                            makeDetails('parallel'),
                            undefined,
                            undefined,
                            relayUiRequest
                        )
                        allResults[index] = result
                        emitParallelUpdate()
                        return result
                    }
                )

                const successCount = results.filter(r => !isFailedResult(r)).length
                const abortedCount = results.filter(r => r.aborted === true).length
                const headerText =
                    `Parallel: ${successCount}/${results.length} succeeded` +
                    (abortedCount > 0 ? `, ${abortedCount} aborted` : '')
                const summaries = results.map(r => {
                    const output = truncateParallelOutput(getResultOutput(r))
                    const status = r.aborted
                        ? 'aborted'
                        : isFailedResult(r)
                          ? `failed${r.stopReason && r.stopReason !== 'end' ? ` (${r.stopReason})` : ''}`
                          : 'completed'
                    const hint = isFailedResult(r) ? formatResumeHint(r) : null
                    return `### [${r.agent}] ${status}\n\n${output}${hint ? `\n\n${hint}` : ''}`
                })
                return {
                    content: [
                        {
                            type: 'text',
                            text: `${headerText}\n\n${summaries.join('\n\n---\n\n')}`,
                        },
                    ],
                    details: makeDetails('parallel')(results),
                }
            }

            if (params.agent && params.task) {
                let resume: ResumeTarget | undefined
                if (params.resume) {
                    const resolved = resolveResumeTarget(params.resume, params.agent, agents)
                    if (typeof resolved === 'string') {
                        return {
                            content: [{ type: 'text', text: resolved }],
                            details: makeDetails('single')([]),
                            isError: true,
                        }
                    }
                    resume = resolved
                }
                const result = await runSingleAgent(
                    ctx.cwd,
                    dispatchDefaults,
                    agents,
                    params.agent,
                    params.task,
                    params.cwd,
                    undefined,
                    signal,
                    onUpdate,
                    makeDetails('single'),
                    resume,
                    undefined,
                    relayUiRequest
                )
                const isError = isFailedResult(result)
                if (isError) {
                    return {
                        content: [{ type: 'text', text: formatFailureReport(result) }],
                        details: makeDetails('single')([result]),
                        isError: true,
                    }
                }
                const finalOutput = getFinalOutput(result.messages) || '(no output)'
                return {
                    content: [
                        {
                            type: 'text',
                            text: result.resumeNote
                                ? `${finalOutput}\n\n${result.resumeNote}`
                                : finalOutput,
                        },
                    ],
                    details: makeDetails('single')([result]),
                }
            }

            const available = agents.map(a => `${a.name} (${a.source})`).join(', ') || 'none'
            return {
                content: [
                    {
                        type: 'text',
                        text: `Invalid parameters. Available agents: ${available}`,
                    },
                ],
                details: makeDetails('single')([]),
            }
        },

        renderCall(args, theme, _context) {
            const scope: AgentScope = args.agentScope ?? 'user'
            if (args.chain && args.chain.length > 0) {
                let text =
                    theme.fg('toolTitle', theme.bold('subagent ')) +
                    theme.fg('accent', `chain (${args.chain.length} steps)`) +
                    theme.fg('muted', ` [${scope}]`)
                for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
                    const step = args.chain[i]
                    // Clean up {previous} placeholder for display
                    const cleanTask = step.task.replace(/\{previous\}/g, '').trim()
                    const preview =
                        cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask
                    text +=
                        '\n  ' +
                        theme.fg('muted', `${i + 1}.`) +
                        ' ' +
                        theme.fg('accent', step.agent) +
                        theme.fg('dim', ` ${preview}`)
                }
                if (args.chain.length > 3)
                    text += `\n  ${theme.fg('muted', `... +${args.chain.length - 3} more`)}`
                return new Text(text, 0, 0)
            }
            if (args.tasks && args.tasks.length > 0) {
                let text =
                    theme.fg('toolTitle', theme.bold('subagent ')) +
                    theme.fg('accent', `parallel (${args.tasks.length} tasks)`) +
                    theme.fg('muted', ` [${scope}]`)
                for (const t of args.tasks.slice(0, 3)) {
                    const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task
                    text += `\n  ${theme.fg('accent', t.agent)}${theme.fg('dim', ` ${preview}`)}`
                }
                if (args.tasks.length > 3)
                    text += `\n  ${theme.fg('muted', `... +${args.tasks.length - 3} more`)}`
                return new Text(text, 0, 0)
            }
            const agentName = args.agent || '...'
            const preview = args.task
                ? args.task.length > 60
                    ? `${args.task.slice(0, 60)}...`
                    : args.task
                : '...'
            let text =
                theme.fg('toolTitle', theme.bold('subagent ')) +
                theme.fg('accent', agentName) +
                theme.fg('muted', ` [${scope}]`)
            text += `\n  ${theme.fg('dim', preview)}`
            return new Text(text, 0, 0)
        },

        renderResult(result, { expanded }, theme, _context) {
            const details = result.details as SubagentDetails | undefined
            if (!details || details.results.length === 0) {
                const text = result.content[0]
                return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0)
            }

            const mdTheme = getMarkdownTheme()

            const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
                const toShow = limit ? items.slice(-limit) : items
                const skipped = limit && items.length > limit ? items.length - limit : 0
                let text = ''
                if (skipped > 0) text += theme.fg('muted', `... ${skipped} earlier items\n`)
                for (const item of toShow) {
                    if (item.type === 'text') {
                        const preview = expanded
                            ? item.text
                            : item.text.split('\n').slice(0, 3).join('\n')
                        text += `${theme.fg('toolOutput', preview)}\n`
                    } else {
                        text += `${theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`
                    }
                }
                return text.trimEnd()
            }

            if (details.mode === 'single' && details.results.length === 1) {
                const r = details.results[0]
                const isError = isFailedResult(r)
                const icon = isError ? theme.fg('error', '✗') : theme.fg('success', '✓')
                const displayItems = getDisplayItems(r.messages)
                const finalOutput = getFinalOutput(r.messages)

                if (expanded) {
                    const container = new Container()
                    let header = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${theme.fg('muted', ` (${r.agentSource})`)}`
                    if (isError && r.stopReason)
                        header += ` ${theme.fg('error', `[${r.stopReason}]`)}`
                    container.addChild(new Text(header, 0, 0))
                    if (isError && r.errorMessage)
                        container.addChild(
                            new Text(theme.fg('error', `Error: ${r.errorMessage}`), 0, 0)
                        )
                    container.addChild(new Spacer(1))
                    container.addChild(new Text(theme.fg('muted', '─── Task ───'), 0, 0))
                    container.addChild(new Text(theme.fg('dim', r.task), 0, 0))
                    container.addChild(new Spacer(1))
                    container.addChild(new Text(theme.fg('muted', '─── Output ───'), 0, 0))
                    if (displayItems.length === 0 && !finalOutput) {
                        container.addChild(new Text(theme.fg('muted', '(no output)'), 0, 0))
                    } else {
                        for (const item of displayItems) {
                            if (item.type === 'toolCall')
                                container.addChild(
                                    new Text(
                                        theme.fg('muted', '→ ') +
                                            formatToolCall(
                                                item.name,
                                                item.args,
                                                theme.fg.bind(theme)
                                            ),
                                        0,
                                        0
                                    )
                                )
                        }
                        if (finalOutput) {
                            container.addChild(new Spacer(1))
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
                        }
                    }
                    const usageStr = formatUsageStats(r.usage, r.model)
                    if (usageStr) {
                        container.addChild(new Spacer(1))
                        container.addChild(new Text(theme.fg('dim', usageStr), 0, 0))
                    }
                    return container
                }

                let text = `${icon} ${theme.fg('toolTitle', theme.bold(r.agent))}${theme.fg('muted', ` (${r.agentSource})`)}`
                if (isError && r.stopReason)
                    text += ` ${theme.fg('error', `[${r.stopReason}]`)}`
                if (isError && r.errorMessage)
                    text += `\n${theme.fg('error', `Error: ${r.errorMessage}`)}`
                else if (displayItems.length === 0)
                    text += `\n${theme.fg('muted', '(no output)')}`
                else {
                    text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`
                    if (displayItems.length > COLLAPSED_ITEM_COUNT)
                        text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
                }
                const usageStr = formatUsageStats(r.usage, r.model)
                if (usageStr) text += `\n${theme.fg('dim', usageStr)}`
                return new Text(text, 0, 0)
            }

            const aggregateUsage = (results: SingleResult[]) => {
                const total = {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: 0,
                    turns: 0,
                }
                for (const r of results) {
                    total.input += r.usage.input
                    total.output += r.usage.output
                    total.cacheRead += r.usage.cacheRead
                    total.cacheWrite += r.usage.cacheWrite
                    total.cost += r.usage.cost
                    total.turns += r.usage.turns
                }
                return total
            }

            if (details.mode === 'chain') {
                const successCount = details.results.filter(r => r.exitCode === 0).length
                const icon =
                    successCount === details.results.length
                        ? theme.fg('success', '✓')
                        : theme.fg('error', '✗')

                if (expanded) {
                    const container = new Container()
                    container.addChild(
                        new Text(
                            icon +
                                ' ' +
                                theme.fg('toolTitle', theme.bold('chain ')) +
                                theme.fg(
                                    'accent',
                                    `${successCount}/${details.results.length} steps`
                                ),
                            0,
                            0
                        )
                    )

                    for (const r of details.results) {
                        const rIcon =
                            r.exitCode === 0
                                ? theme.fg('success', '✓')
                                : theme.fg('error', '✗')
                        const displayItems = getDisplayItems(r.messages)
                        const finalOutput = getFinalOutput(r.messages)

                        container.addChild(new Spacer(1))
                        container.addChild(
                            new Text(
                                `${theme.fg('muted', `─── Step ${r.step}: `) + theme.fg('accent', r.agent)} ${rIcon}`,
                                0,
                                0
                            )
                        )
                        container.addChild(
                            new Text(
                                theme.fg('muted', 'Task: ') + theme.fg('dim', r.task),
                                0,
                                0
                            )
                        )

                        // Show tool calls
                        for (const item of displayItems) {
                            if (item.type === 'toolCall') {
                                container.addChild(
                                    new Text(
                                        theme.fg('muted', '→ ') +
                                            formatToolCall(
                                                item.name,
                                                item.args,
                                                theme.fg.bind(theme)
                                            ),
                                        0,
                                        0
                                    )
                                )
                            }
                        }

                        // Show final output as markdown
                        if (finalOutput) {
                            container.addChild(new Spacer(1))
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
                        }

                        const stepUsage = formatUsageStats(r.usage, r.model)
                        if (stepUsage)
                            container.addChild(new Text(theme.fg('dim', stepUsage), 0, 0))
                    }

                    const usageStr = formatUsageStats(aggregateUsage(details.results))
                    if (usageStr) {
                        container.addChild(new Spacer(1))
                        container.addChild(
                            new Text(theme.fg('dim', `Total: ${usageStr}`), 0, 0)
                        )
                    }
                    return container
                }

                // Collapsed view
                let text =
                    icon +
                    ' ' +
                    theme.fg('toolTitle', theme.bold('chain ')) +
                    theme.fg('accent', `${successCount}/${details.results.length} steps`)
                for (const r of details.results) {
                    const rIcon =
                        r.exitCode === 0 ? theme.fg('success', '✓') : theme.fg('error', '✗')
                    const displayItems = getDisplayItems(r.messages)
                    text += `\n\n${theme.fg('muted', `─── Step ${r.step}: `)}${theme.fg('accent', r.agent)} ${rIcon}`
                    if (displayItems.length === 0)
                        text += `\n${theme.fg('muted', '(no output)')}`
                    else text += `\n${renderDisplayItems(displayItems, 5)}`
                }
                const usageStr = formatUsageStats(aggregateUsage(details.results))
                if (usageStr) text += `\n\n${theme.fg('dim', `Total: ${usageStr}`)}`
                text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
                return new Text(text, 0, 0)
            }

            if (details.mode === 'parallel') {
                const running = details.results.filter(r => r.exitCode === -1).length
                const successCount = details.results.filter(
                    r => r.exitCode !== -1 && !isFailedResult(r)
                ).length
                const failCount = details.results.filter(
                    r => r.exitCode !== -1 && isFailedResult(r)
                ).length
                const isRunning = running > 0
                const icon = isRunning
                    ? theme.fg('warning', '⏳')
                    : failCount > 0
                      ? theme.fg('warning', '◐')
                      : theme.fg('success', '✓')
                const status = isRunning
                    ? `${successCount + failCount}/${details.results.length} done, ${running} running`
                    : `${successCount}/${details.results.length} tasks`

                if (expanded && !isRunning) {
                    const container = new Container()
                    container.addChild(
                        new Text(
                            `${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${theme.fg('accent', status)}`,
                            0,
                            0
                        )
                    )

                    for (const r of details.results) {
                        const rIcon = isFailedResult(r)
                            ? theme.fg('error', '✗')
                            : theme.fg('success', '✓')
                        const displayItems = getDisplayItems(r.messages)
                        const finalOutput = getFinalOutput(r.messages)

                        container.addChild(new Spacer(1))
                        container.addChild(
                            new Text(
                                `${theme.fg('muted', '─── ') + theme.fg('accent', r.agent)} ${rIcon}`,
                                0,
                                0
                            )
                        )
                        container.addChild(
                            new Text(
                                theme.fg('muted', 'Task: ') + theme.fg('dim', r.task),
                                0,
                                0
                            )
                        )

                        // Show tool calls
                        for (const item of displayItems) {
                            if (item.type === 'toolCall') {
                                container.addChild(
                                    new Text(
                                        theme.fg('muted', '→ ') +
                                            formatToolCall(
                                                item.name,
                                                item.args,
                                                theme.fg.bind(theme)
                                            ),
                                        0,
                                        0
                                    )
                                )
                            }
                        }

                        // Show final output as markdown
                        if (finalOutput) {
                            container.addChild(new Spacer(1))
                            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme))
                        }

                        const taskUsage = formatUsageStats(r.usage, r.model)
                        if (taskUsage)
                            container.addChild(new Text(theme.fg('dim', taskUsage), 0, 0))
                    }

                    const usageStr = formatUsageStats(aggregateUsage(details.results))
                    if (usageStr) {
                        container.addChild(new Spacer(1))
                        container.addChild(
                            new Text(theme.fg('dim', `Total: ${usageStr}`), 0, 0)
                        )
                    }
                    return container
                }

                // Collapsed view (or still running)
                let text = `${icon} ${theme.fg('toolTitle', theme.bold('parallel '))}${theme.fg('accent', status)}`
                for (const r of details.results) {
                    const rIcon =
                        r.exitCode === -1
                            ? theme.fg('warning', '⏳')
                            : isFailedResult(r)
                              ? theme.fg('error', '✗')
                              : theme.fg('success', '✓')
                    const displayItems = getDisplayItems(r.messages)
                    text += `\n\n${theme.fg('muted', '─── ')}${theme.fg('accent', r.agent)} ${rIcon}`
                    if (displayItems.length === 0)
                        text += `\n${theme.fg('muted', r.exitCode === -1 ? '(running...)' : '(no output)')}`
                    else text += `\n${renderDisplayItems(displayItems, 5)}`
                }
                if (!isRunning) {
                    const usageStr = formatUsageStats(aggregateUsage(details.results))
                    if (usageStr) text += `\n\n${theme.fg('dim', `Total: ${usageStr}`)}`
                }
                if (!expanded) text += `\n${theme.fg('muted', '(Ctrl+O to expand)')}`
                return new Text(text, 0, 0)
            }

            const text = result.content[0]
            return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0)
        },
    })

    pi.registerTool({
        name: 'subagent_inspect',
        label: 'Subagent Inspect',
        description: [
            'Inspect a persisted subagent run by id (exact or unique prefix): status, agent, task, usage,',
            'and the tail of its transcript. Works on running subagents (e.g. debugging stuck runs).',
            'Failed and aborted runs persist until resumed; successful runs are cleaned up on completion,',
            "so their output is only in the parent session's tool result.",
        ].join(' '),
        parameters: SubagentInspectParams,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            capturePiSessionId(ctx)
            const limit = Math.max(1, Math.floor(params.limit ?? INSPECT_DEFAULT_LIMIT))
            const resolved = resolveInspectTarget(params.id)
            if ('error' in resolved) {
                return {
                    content: [{ type: 'text', text: resolved.error }],
                    details: undefined,
                    isError: true,
                }
            }
            return {
                content: [
                    { type: 'text', text: buildSubagentInspectReport(resolved.id, limit) },
                ],
                details: undefined,
            }
        },

        renderCall(args, theme, _context) {
            const preview = args.id.length > 40 ? `${args.id.slice(0, 40)}...` : args.id
            let text =
                theme.fg('toolTitle', theme.bold('subagent_inspect ')) +
                theme.fg('accent', preview)
            if (args.limit !== undefined) text += theme.fg('muted', ` (last ${args.limit})`)
            return new Text(text, 0, 0)
        },

        renderResult(result, _options, _theme, _context) {
            const text = result.content[0]
            return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0)
        },
    })

    pi.registerCommand('subagents', {
        description:
            'Manage subagents: bare = interactive manager view (TUI) or session-scoped text report (print); ' +
            'attach to a running one (/subagents attach [id]); resume a persisted one (/subagents resume [id] [instruction...]); ' +
            'abort a running one (/subagents abort [id])',
        handler: async (args, ctx) => {
            capturePiSessionId(ctx)
            const [sub, ...rest] = args.trim().split(/\s+/)
            if (sub === 'attach') {
                const resolved = resolveAttachTarget(rest[0])
                if (typeof resolved === 'string') {
                    emitCommandNotice(ctx, resolved, 'warning')
                    return
                }
                if (ctx.mode !== 'tui') {
                    emitCommandNotice(ctx, 'attach requires an interactive session', 'warning')
                    return
                }
                await attachToSubagent(ctx, resolved)
                return
            }
            if (sub === 'abort') {
                // Registry-resolved like attach (exact/unique prefix/single-entry
                // default); SIGTERMs the child and lets the existing close
                // handlers settle the registry and any pending tool result.
                const resolved = resolveAttachTarget(rest[0])
                if (typeof resolved === 'string') {
                    emitCommandNotice(ctx, resolved, 'warning')
                    return
                }
                try {
                    resolved.proc.kill('SIGTERM')
                } catch {
                    /* already dead — the close handler settles the registry */
                }
                emitCommandNotice(
                    ctx,
                    `Aborting subagent ${resolved.id.slice(0, LIST_ID_SHORT_CHARS)} (SIGTERM sent).`,
                    'info'
                )
                return
            }
            if (sub === 'resume') {
                await handleSubagentsResume(ctx, rest)
                return
            }
            if (!sub) {
                // Bare command (§11): TUI opens the manager view; print mode
                // keeps the text report; other modes fall back to notify.
                if (ctx.mode === 'tui') {
                    await openSubagentsManager(ctx)
                    return
                }
                const report = buildSubagentsListReport()
                // ctx.ui.notify is a no-op without a UI (pi -p / --mode json); print mode writes to stdout instead.
                if (ctx.mode === 'print') console.log(report)
                else ctx.ui.notify(report, 'info')
                return
            }
            emitCommandNotice(
                ctx,
                `Unknown subcommand "${sub}". Usage: /subagents [attach [id] | resume [id] [instruction...] | abort [id]]`,
                'warning'
            )
        },
    })
}
