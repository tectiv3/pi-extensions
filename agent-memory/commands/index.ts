/**
 * §10's slash commands. One host command (`memory`) with seven verbs.
 *
 * Three decisions shape this file:
 *
 * - **Output goes through `ctx.ui.notify`**, once per invocation. The host's
 *   `console` is not a UI channel inside pi, and consecutive status notifications
 *   replace each other (`showStatus` reuses the last status row), so a table must be
 *   one message.
 * - **A command is user-initiated.** `/memory show` therefore does not confirm and
 *   logs exactly one `initiator: "user"` line; the same encoding covers `/memory diff`
 *   of a gated note. Confirmations are for an agent reaching for content the user did
 *   not ask for (§7.3).
 * - **Import reuses `Store.writeNote`.** One atomic write, one explicit-path commit,
 *   one index upsert and one embedding job per source file. There is no second write
 *   path and no `git add -A`; an interrupted import leaves a coherent prefix, and a
 *   source file is only deleted after its note landed.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import type { GateContext } from '../gate/gate.ts'
import { logUserAccess } from '../gate/gate.ts'
import { pairAttempts, readLog, type LogEntry, type PairedAttempt } from '../gate/log.ts'
import { cacheIndexBlock } from '../inject/index-block.ts'
import { listNotes, rebuildIndex } from '../index/notes.ts'
import { parseNote } from '../store/frontmatter.ts'
import { withFileLock } from '../store/git.ts'
import { normalizeKey } from '../store/keys.ts'
import { resolveScope } from '../store/notes.ts'
import { repoLockPath } from '../store/paths.ts'
import type { Store } from '../store/store.ts'
import {
    type Embedder,
    type MemoryDeps,
    memorySearch,
    scopeLabel,
    scopeOverview,
} from '../tools/definitions.ts'

/** The exact AGENTS.md line `/memory import` tells the user to remove (§1, §10). */
export const AGENTS_MEMORIES_LINE =
    '- start session by loading relevant to the task project memories from cwd/.serena/memories dir'

/** `/memory log`'s default window; the table is for reading, not for dumping 10 MB. */
export const DEFAULT_LOG_TAIL = 50
/** A diff is a review aid; beyond this the user wants `git log` itself. */
export const MAX_DIFF_LINES = 300

const VERBS = ['index', 'show', 'search', 'log', 'diff', 'import', 'import-keep'] as const

const USAGE = [
    'usage:',
    '  /memory index [--rebuild] [--force-unlock]',
    '  /memory show <key> [--gated]',
    '  /memory search <query>',
    '  /memory log [--tail N]',
    '  /memory diff <key>',
    '  /memory import | /memory import-keep',
].join('\n')

export interface MemoryCommandOptions {
    /** U9's embedder; absent → `/memory search` is BM25-only (§12.10). */
    embed?: Embedder
    /**
     * The session gate object. Commands never confirm, but `memorySearch` receives a
     * `GateContext`; the fail-closed default keeps that honest if one is forgotten.
     */
    gate?: GateContext
}

const FAIL_CLOSED_GATE: GateContext = {
    hasUI: false,
    ui: {
        async confirm() {
            return false
        },
    },
}

/**
 * Registers `/memory`. Called once at extension load, not per session: `on`/`register*`
 * append, so a per-session registration would stack handlers and duplicate the command.
 */
export function registerMemoryCommands(
    pi: ExtensionAPI,
    getStore: () => Store | undefined,
    options: MemoryCommandOptions = {}
): void {
    pi.registerCommand('memory', {
        description:
            'Manage the local memory store: index, show, search, log, diff, import .serena/memories',
        getArgumentCompletions(argumentPrefix) {
            const prefix = argumentPrefix.trim()
            if (prefix.includes(' ')) return null
            return VERBS.filter(verb => verb.startsWith(prefix)).map(verb => ({
                value: `${verb} `,
                label: verb,
            }))
        },
        handler: async (args, ctx) => {
            const trimmed = args.trim()
            if (trimmed === '') {
                ctx.ui.notify(USAGE, 'info')
                return
            }
            const space = trimmed.indexOf(' ')
            const verb = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
            const rest = space === -1 ? '' : trimmed.slice(space + 1).trim()

            const store = getStore()
            if (store === undefined) {
                ctx.ui.notify(
                    'memory store is not available in this session; see the pi startup warning',
                    'error'
                )
                return
            }

            try {
                switch (verb) {
                    case 'index':
                        ctx.ui.notify(await runIndex(store, ctx, rest), 'info')
                        return
                    case 'show':
                        ctx.ui.notify(await runShow(store, ctx, rest), 'info')
                        return
                    case 'search':
                        ctx.ui.notify(await runSearch(store, ctx, rest, options), 'info')
                        return
                    case 'log':
                        ctx.ui.notify(runLog(store, rest), 'info')
                        return
                    case 'diff':
                        ctx.ui.notify(await runDiff(store, ctx, rest), 'info')
                        return
                    case 'import':
                        ctx.ui.notify(await runImport(store, ctx, false), 'info')
                        return
                    case 'import-keep':
                        ctx.ui.notify(await runImport(store, ctx, true), 'info')
                        return
                    default:
                        ctx.ui.notify(`unknown subcommand "${verb}"\n${USAGE}`, 'warning')
                }
            } catch (err) {
                ctx.ui.notify(`/memory ${verb} failed: ${message(err)}`, 'error')
            }
        },
    })
}

// ---------------------------------------------------------------------------
// /memory index
// ---------------------------------------------------------------------------

interface IndexReport {
    scanned: number
    updated: number
    skipped: number
    errors: Array<{ path: string; reason: string }>
}

async function runIndex(
    store: Store,
    ctx: ExtensionCommandContext,
    rest: string
): Promise<string> {
    const rebuild = hasFlag(rest, '--rebuild')
    const forceUnlock = hasFlag(rest, '--force-unlock')
    const lines: string[] = []

    if (forceUnlock) {
        const cleared = clearRepoLock(store.root)
        lines.push(
            cleared === null
                ? 'force-unlock: no repo lock was present'
                : `force-unlock: cleared ${cleared}`
        )
    }

    const report: IndexReport = rebuild ? rebuildReport(store) : store.reindex()

    // §6.1: `/memory index` is the explicit refresh of the cached injection block.
    try {
        cacheIndexBlock({ store, cwd: ctx.cwd })
    } catch (err) {
        lines.push(`index block not refreshed: ${message(err)}`)
    }

    const verb = rebuild ? 'rebuilt' : 'indexed'
    lines.push(
        `${verb}: scanned ${report.scanned}, updated ${report.updated}, skipped ${report.skipped}, errors ${report.errors.length}`
    )
    for (const error of report.errors) lines.push(`  ${error.path}: ${error.reason}`)
    return lines.join('\n')
}

function rebuildReport(store: Store): IndexReport {
    const scanned = rebuildIndex(store.root, store.db)
    return { scanned, updated: scanned, skipped: 0, errors: [] }
}

/**
 * §3.5's escape hatch: a live but wedged pid must not block the store forever. The
 * force option removes the lock inside the same acquisition code every writer uses,
 * so there is one lock implementation, and the release leaves no file behind.
 */
function clearRepoLock(root: string): string | null {
    const lockFile = repoLockPath(root)
    let held: string
    try {
        held = fs.readFileSync(lockFile, 'utf8').trim()
    } catch {
        return null
    }
    withFileLock(lockFile, 'repo lock', () => {}, { force: true })
    return held === '' ? '(unparsable lock file)' : `lock held by ${held}`
}

// ---------------------------------------------------------------------------
// /memory show
// ---------------------------------------------------------------------------

async function runShow(
    store: Store,
    ctx: ExtensionCommandContext,
    rest: string
): Promise<string> {
    const gatedOnly = hasFlag(rest, '--gated')
    const key = stripFlags(rest)[0] ?? ''

    if (gatedOnly && key === '') {
        const resolved = resolveScope(ctx.cwd)
        const rows = listNotes(store.db, {
            scope: resolved.scope,
            project: resolved.project,
            access: 'gated',
        })
        const where = scopeLabel(resolved.scope, resolved.project)
        if (rows.length === 0) return `no gated notes in ${where}`
        // Keys only: listing a gated note's body without asking is what §10's
        // "without bodies" rules out.
        return `gated notes in ${where} (${rows.length}):\n${rows
            .map(row => row.key)
            .join('\n')}`
    }
    if (key === '') return `show requires a key\n${USAGE}`

    const snapshot = store.readNote({ key })
    // §10: one line, no `pending` predecessor and no `reason`; nobody approved
    // their own keystroke, so `approved` would be a false statement.
    logUserAccess(store.root, {
        op: 'show',
        scope: snapshot.scope,
        project: snapshot.project,
        key: snapshot.key,
        session: sessionId(ctx),
    })
    const header = `${snapshot.key} (${scopeLabel(snapshot.scope, snapshot.project)}, ${snapshot.access})`
    return snapshot.body === '' ? `${header}\n(empty note)` : `${header}\n${snapshot.body}`
}

// ---------------------------------------------------------------------------
// /memory search
// ---------------------------------------------------------------------------

async function runSearch(
    store: Store,
    ctx: ExtensionCommandContext,
    query: string,
    options: MemoryCommandOptions
): Promise<string> {
    if (query === '') return `search requires a query\n${USAGE}`
    const deps: MemoryDeps = {
        store,
        gate: options.gate ?? FAIL_CLOSED_GATE,
        cwd: ctx.cwd,
        embed: options.embed,
    }
    // Same path as the tool (§4): gated rows are excluded in SQL before ranking, so
    // there is no gated result for a command to gate afterwards.
    const result = await memorySearch(deps, { query })
    const overview = scopeOverview(deps)
    if (overview.gated === 0) return result.text
    const note = `${overview.gated} gated note${overview.gated === 1 ? '' : 's'} withheld; /memory show --gated lists them`
    return `${result.text}\n(${note})`
}

// ---------------------------------------------------------------------------
// /memory log
// ---------------------------------------------------------------------------

const LOG_COLUMNS = ['time', 'op', 'initiator', 'key', 'decision', 'result', 'reason'] as const

interface LogRow {
    cells: string[]
}

function runLog(store: Store, rest: string): string {
    const tail = parseTail(rest)
    const pairs = pairAttempts(readLog(store.root))
    if (pairs.length === 0) return '(no access log entries)'
    // Tail the **paired rows**, not the raw lines: slicing lines can cut a `pending`
    // away from its resolver and render a completed attempt as unresolved, which is
    // the one claim the log must never make falsely (§7.1). Rows are ordered by the
    // timestamp of their final line, so "last N" means the N latest outcomes.
    const ordered = orderByLastLine(pairs)
    const shown = ordered.slice(Math.max(0, ordered.length - tail))
    const rows = shown.map(toLogRow)
    const header = `access log: last ${shown.length} of ${pairs.length} attempts (--tail N for more)`
    return `${header}\n${renderTable(rows)}`
}

function orderByLastLine(pairs: readonly PairedAttempt[]): PairedAttempt[] {
    return pairs
        .map((pair, index) => ({ pair, index, ts: lastTimestamp(pair) }))
        .sort((a, b) => a.ts - b.ts || a.index - b.index)
        .map(entry => entry.pair)
}

function lastTimestamp(pair: PairedAttempt): number {
    for (let index = pair.lines.length - 1; index >= 0; index--) {
        const ts = pair.lines[index]?.ts
        if (ts === undefined) continue
        const parsed = Date.parse(ts)
        if (!Number.isNaN(parsed)) return parsed
    }
    return 0
}

function toLogRow(pair: PairedAttempt): LogRow {
    const first: LogEntry = pair.pending ?? pair.lines[0] ?? { op: 'rotate' }
    const resolver = pair.resolver
    const decision = pair.unresolved
        ? 'pending (unresolved)'
        : (resolver?.decision ?? first.decision ?? '-')
    const result = pair.unresolved ? '-' : (resolver?.result ?? first.result ?? '-')
    const time = shortTime(first.ts)
    return {
        // The marker column is what makes an unresolved attempt distinguishable at a
        // glance, not only by reading the decision text.
        cells: [
            pair.unresolved ? `!${time}` : time,
            first.op ?? '-',
            first.initiator ?? '-',
            first.key ?? (first.op === 'rotate' ? '(rotated)' : '-'),
            String(decision),
            String(result),
            truncate(first.reason ?? '-', 40),
        ],
    }
}

function renderTable(rows: readonly LogRow[]): string {
    const widths = LOG_COLUMNS.map((column, index) =>
        Math.max(column.length, ...rows.map(row => row.cells[index].length))
    )
    const line = (cells: readonly string[]): string =>
        cells
            .map((cell, index) =>
                index === cells.length - 1 ? cell : cell.padEnd(widths[index])
            )
            .join('  ')
            .trimEnd()
    return [
        line(LOG_COLUMNS),
        line(widths.map(width => '-'.repeat(width))),
        ...rows.map(row => line(row.cells)),
    ].join('\n')
}

function shortTime(ts: string | undefined): string {
    // ISO `2026-10-29T12:34:56.789Z` → `12:34:56`; a missing timestamp is not an error.
    if (typeof ts !== 'string' || ts.length < 19) return '-'
    return ts.slice(11, 19)
}

// ---------------------------------------------------------------------------
// /memory diff
// ---------------------------------------------------------------------------

async function runDiff(
    store: Store,
    ctx: ExtensionCommandContext,
    rest: string
): Promise<string> {
    const key = stripFlags(rest)[0] ?? ''
    if (key === '') return `diff requires a key\n${USAGE}`

    const resolved = resolveScope(ctx.cwd)
    const absPath = store.paths.noteFile(resolved.scope, resolved.project, key)
    const relPath = toPosix(path.relative(store.root, absPath))

    // The file is authoritative for `access` (§5). A deleted note still has history,
    // so a missing file is not an error here — it just has no body to gate.
    let access: 'open' | 'gated' = 'open'
    try {
        const snapshot = store.readNote({ key })
        access = snapshot.access
    } catch (err) {
        if (!/not found/.test(message(err))) throw err
    }
    if (access === 'gated') {
        // §10 applies the same encoding as `/memory show` for user-initiated access:
        // one `user` line, no confirmation.
        logUserAccess(store.root, {
            op: 'diff',
            scope: resolved.scope,
            project: resolved.project,
            key: normalizeKey(key),
            session: sessionId(ctx),
        })
    }

    const log = gitLog(store.root, relPath)
    return log === '' ? `no history for ${normalizeKey(key)}` : compactDiff(log)
}

function gitLog(root: string, relPath: string): string {
    const result = spawnSync(
        'git',
        [
            '-c',
            'commit.gpgsign=false',
            'log',
            '-p',
            '--no-color',
            '--no-ext-diff',
            '--format=commit %h %s',
            '--',
            relPath,
        ],
        {
            cwd: root,
            encoding: 'utf8',
            timeout: 10_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }
    )
    if (result.status !== 0) {
        const detail = (result.stderr ?? '').trim()
        if (detail === '') return ''
        throw new Error(`git log failed: ${detail}`)
    }
    return result.stdout ?? ''
}

/**
 * `git log -p` rendered for reading: commit subject, hunk headers and the changed
 * lines. File headers and `index` lines are noise when there is one file per commit.
 */
export function compactDiff(raw: string, maxLines = MAX_DIFF_LINES): string {
    const kept: string[] = []
    for (const line of raw.split('\n')) {
        if (
            /^(diff --git|index |--- a\/|\+\+\+ b\/|new file mode|deleted file mode|similarity index|rename (from|to))/.test(
                line
            )
        ) {
            continue
        }
        if (/^(Author|Date|AuthorDate|CommitDate):/.test(line)) continue
        if (line === '' && kept[kept.length - 1] === '') continue
        kept.push(line)
    }
    const trimmed = kept.join('\n').trim()
    if (trimmed === '') return ''
    const lines = trimmed.split('\n')
    if (lines.length <= maxLines) return trimmed
    return `${lines.slice(0, maxLines).join('\n')}\n… ${lines.length - maxLines} more lines`
}

// ---------------------------------------------------------------------------
// /memory import
// ---------------------------------------------------------------------------

interface ImportConflict {
    path: string
    reason: string
}

interface ImportReport {
    imported: string[]
    skipped: ImportConflict[]
    conflicts: ImportConflict[]
    deleted: number
    removedDirs: number
    kept: boolean
}

async function runImport(
    store: Store,
    ctx: ExtensionCommandContext,
    keep: boolean
): Promise<string> {
    const memoriesDir = path.join(ctx.cwd, '.serena', 'memories')
    if (!isDirectory(memoriesDir)) {
        return `no .serena/memories directory in ${ctx.cwd}`
    }
    // Import is project-scoped by definition (§10); a cwd outside a repository has no
    // project to import into, and `writeNote` would fail per file with the same error.
    const resolved = resolveScope(ctx.cwd, 'project')
    const report = await importMemories(store, memoriesDir, resolved.project, keep)
    return formatImportReport(report, resolved.project)
}

async function importMemories(
    store: Store,
    memoriesDir: string,
    project: string,
    keep: boolean
): Promise<ImportReport> {
    const report: ImportReport = {
        imported: [],
        skipped: [],
        conflicts: [],
        deleted: 0,
        removedDirs: 0,
        kept: keep,
    }

    for (const absPath of listFiles(memoriesDir)) {
        const relPath = toPosix(path.relative(memoriesDir, absPath))
        if (!absPath.endsWith('.md')) {
            report.skipped.push({ path: relPath, reason: 'not a .md file' })
            continue
        }

        let key: string
        try {
            key = normalizeKey(relPath)
        } catch (err) {
            report.conflicts.push({ path: relPath, reason: message(err) })
            continue
        }

        const target = store.paths.noteFile('project', project, key)
        if (fs.existsSync(target)) {
            // Never overwrite: the store is the newer source of truth and the import
            // is not a sync.
            report.conflicts.push({ path: relPath, reason: 'already exists in the store' })
            continue
        }

        let body: string
        try {
            // A source `access:` block is stripped rather than imported as body text:
            // §10 imports every note as `open`.
            body = parseNote(fs.readFileSync(absPath)).body
        } catch (err) {
            report.conflicts.push({ path: relPath, reason: message(err) })
            continue
        }

        const written = await store.writeNote({ key, body, scope: 'project' })
        if (written.ok === false) {
            const reason =
                'message' in written ? written.message : `denied: ${String(written.code)}`
            report.conflicts.push({ path: relPath, reason })
            continue
        }
        report.imported.push(relPath)
    }

    if (!keep) {
        for (const relPath of report.imported) {
            const absPath = path.join(memoriesDir, ...relPath.split('/'))
            try {
                fs.unlinkSync(absPath)
                report.deleted++
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
            }
        }
        report.removedDirs = removeEmptyDirs(memoriesDir)
    }
    return report
}

function formatImportReport(report: ImportReport, project: string): string {
    const lines: string[] = []
    lines.push(
        `imported ${report.imported.length} note${report.imported.length === 1 ? '' : 's'} into project:${project}`
    )
    for (const entry of report.imported) lines.push(`  ${entry}`)
    if (report.skipped.length > 0) {
        lines.push(
            `skipped ${report.skipped.length} non-.md file${report.skipped.length === 1 ? '' : 's'}:`
        )
        for (const entry of report.skipped) lines.push(`  ${entry.path} (${entry.reason})`)
    }
    if (report.conflicts.length > 0) {
        lines.push(
            `left ${report.conflicts.length} file${report.conflicts.length === 1 ? '' : 's'} in place:`
        )
        for (const entry of report.conflicts) lines.push(`  ${entry.path}: ${entry.reason}`)
    }
    if (report.kept) {
        lines.push('import-keep: source files and directories were not touched')
    } else {
        lines.push(
            `deleted ${report.deleted} imported source file${report.deleted === 1 ? '' : 's'}, removed ${report.removedDirs} empty director${report.removedDirs === 1 ? 'y' : 'ies'}`
        )
    }
    // Only worth printing once something actually replaced `.serena/memories`: on a
    // failed or empty import, removing the line would delete the only injection path.
    if (report.imported.length > 0) {
        lines.push('remove this line from AGENTS.md:', `  ${AGENTS_MEMORIES_LINE}`)
    }
    return lines.join('\n')
}

function listFiles(root: string): string[] {
    const files: string[] = []
    const walk = (dir: string): void => {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).slice()
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of entries) {
            const absPath = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(absPath)
            else if (entry.isFile()) files.push(absPath)
        }
    }
    walk(root)
    return files
}

/** Bottom-up so a parent becomes empty only after its children are gone. */
function removeEmptyDirs(root: string): number {
    let removed = 0
    const walk = (dir: string): void => {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.isDirectory()) walk(path.join(dir, entry.name))
        }
        try {
            if (fs.readdirSync(dir).length === 0) {
                fs.rmdirSync(dir)
                removed++
            }
        } catch {}
    }
    walk(root)
    return removed
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hasFlag(text: string, flag: string): boolean {
    return text.split(/\s+/).includes(flag)
}

function stripFlags(text: string): string[] {
    return text.split(/\s+/).filter(token => token !== '' && !token.startsWith('--'))
}

function parseTail(rest: string): number {
    const match = /--tail\s+(\d+)/.exec(rest)
    if (match === null) return DEFAULT_LOG_TAIL
    const value = Number(match[1])
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_LOG_TAIL
}

function sessionId(ctx: ExtensionCommandContext): string | undefined {
    return ctx.sessionManager?.getSessionId?.()
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory()
    } catch {
        return false
    }
}

function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text
    return `${text.slice(0, limit - 1)}…`
}

function toPosix(relPath: string): string {
    return relPath.split(path.sep).join('/')
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
