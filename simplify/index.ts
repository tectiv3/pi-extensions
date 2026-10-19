/**
 * Simplify command — review recently changed code within its changed line ranges.
 *
 * Adapted from MattDevy/pi-extensions `packages/pi-simplify` (MIT). See LICENSE
 * in this directory. The port keeps the upstream prompt principles and the
 * line-range scope model, and adds explicit base resolution, untracked files,
 * ignore filtering, argument completion, and a file cap.
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

export interface LineRange {
    readonly start: number
    readonly end: number
}

export type FileStatus = 'modified' | 'added' | 'renamed' | 'copied'
export type BaseSource = 'upstream' | 'ref' | 'head' | 'none'

export interface ChangedFile {
    readonly path: string
    readonly status: FileStatus
    readonly changedLines?: readonly LineRange[]
    readonly oldPath?: string
    readonly explicit?: boolean
}

export interface SimplifyOptions {
    readonly files: readonly string[]
    readonly ref?: string
    readonly staged: boolean
}

export interface BaseInfo {
    readonly base?: string
    readonly name: string
    readonly label: string
    readonly source: Exclude<BaseSource, 'none'>
}

export interface SimplifyMeta {
    readonly baseLabel: string
    readonly source: BaseSource
    readonly staged: boolean
    readonly skippedCount: number
    readonly omittedCount: number
}

export interface ChangedFilesResult {
    readonly files: readonly ChangedFile[]
    readonly base: BaseInfo
    readonly skippedCount: number
    readonly omittedCount: number
}

export type ExecApi = Pick<ExtensionAPI, 'exec'>

export const COMMAND_NAME = 'simplify'
const MAX_FILES = 100
const SHORT_SHA_LENGTH = 7

const STATUS_MAP: Record<string, FileStatus> = {
    M: 'modified',
    A: 'added',
    R: 'renamed',
    C: 'copied',
}

const IGNORED_SEGMENTS = new Set([
    'node_modules',
    'dist',
    'build',
    'out',
    'target',
    'vendor',
    '.next',
    '.nuxt',
    '__pycache__',
    '.venv',
])

const IGNORED_BASENAMES = new Set([
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'Cargo.lock',
    'poetry.lock',
    'uv.lock',
    'composer.lock',
    'Gemfile.lock',
    'go.sum',
    'flake.lock',
    'deno.lock',
    'Pipfile.lock',
    'pubspec.lock',
])

const GENERATED_FILE =
    /(?:\.min\.(?:js|mjs|css)|\.pb\.go|_pb2\.py|\.g\.dart|\.generated\.[^/]+|\.gen\.[^/]+)$/
const BINARY_FILE =
    /\.(?:png|jpg|jpeg|gif|webp|bmp|ico|pdf|zip|tar|gz|tgz|bz2|xz|7z|rar|woff|woff2|ttf|otf|eot|mp3|mp4|mov|avi|webm|wav|flac|ogg|wasm|so|dylib|dll|exe|bin|class|jar|pyc|o|a|sqlite|db)$/

let cachedChangedFiles: readonly string[] = []

/** Split a command argument string into tokens, keeping quoted spans together. */
export function tokenizeArgs(input: string): string[] {
    const tokens: string[] = []
    let current = ''
    let quote: '"' | "'" | null = null
    let hasContent = false

    for (const char of input) {
        if (quote) {
            if (char === quote) quote = null
            else current += char
        } else if (char === '"' || char === "'") {
            quote = char
            hasContent = true
        } else if (/\s/.test(char)) {
            if (hasContent) {
                tokens.push(current)
                current = ''
                hasContent = false
            }
        } else {
            current += char
            hasContent = true
        }
    }
    if (hasContent) tokens.push(current)
    return tokens
}

/**
 * Parse `/simplify` arguments.
 *
 * Ref values beginning with `-` are rejected with an Error because they can be
 * mistaken for git options, and unknown `--options` are rejected so a typo is
 * not silently treated as a file path. The command handler turns Errors into a
 * notify.
 */
export function parseArgs(args: string): SimplifyOptions {
    const files: string[] = []
    let ref: string | undefined
    let staged = false

    for (const token of tokenizeArgs(args)) {
        if (token === '--staged') {
            staged = true
        } else if (token.startsWith('--ref=')) {
            const value = token.slice('--ref='.length)
            if (!value) throw new Error('Missing value for --ref.')
            if (value.startsWith('-')) throw new Error(`Invalid git ref: ${value}`)
            ref = value
        } else if (token.startsWith('--')) {
            throw new Error(`Unknown option: ${token}`)
        } else {
            files.push(token)
        }
    }

    return ref === undefined ? { files, staged } : { files, ref, staged }
}

async function mergeBaseOrRef(
    pi: ExecApi,
    cwd: string,
    ref: string
): Promise<string | undefined> {
    const mergeBase = await pi.exec('git', ['merge-base', 'HEAD', ref], { cwd })
    if (mergeBase.code === 0 && mergeBase.stdout.trim()) return mergeBase.stdout.trim()

    // Unrelated histories share no merge base; diff directly against the ref.
    const commit = await pi.exec('git', ['rev-parse', `${ref}^{commit}`], { cwd })
    return commit.code === 0 ? commit.stdout.trim() || undefined : undefined
}

function labelFor(name: string, base: string | undefined): string {
    return base ? `${name} (${base.slice(0, SHORT_SHA_LENGTH)})` : name
}

/** Resolve the diff base and a human-readable label for notifications and prompts. */
export async function resolveBase(pi: ExecApi, cwd: string, ref?: string): Promise<BaseInfo> {
    const inside = await pi.exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
        throw new Error('Not a git repository.')
    }

    if (ref !== undefined) {
        const verify = await pi.exec(
            'git',
            ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
            { cwd }
        )
        if (verify.code !== 0 || !verify.stdout.trim())
            throw new Error(`Unknown git ref: ${ref}`)

        const base = await mergeBaseOrRef(pi, cwd, ref)
        return { base, name: ref, label: labelFor(ref, base), source: 'ref' }
    }

    const upstream = await pi.exec(
        'git',
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        { cwd }
    )
    const upstreamName = upstream.code === 0 ? upstream.stdout.trim() : ''
    if (upstreamName) {
        const base = await mergeBaseOrRef(pi, cwd, upstreamName)
        return {
            base,
            name: upstreamName,
            label: labelFor(upstreamName, base),
            source: 'upstream',
        }
    }

    const head = await pi.exec('git', ['rev-parse', 'HEAD'], { cwd })
    const base = head.code === 0 ? head.stdout.trim() || undefined : undefined
    return { base, name: 'HEAD', label: 'HEAD', source: 'head' }
}

/**
 * Parse `git diff --name-status -z` output. Rename/copy records carry the old
 * path first and the new path second; deletions are skipped because there is
 * nothing left to simplify.
 */
export function parseNameStatus(stdout: string): ChangedFile[] {
    const parts = stdout.split('\0')
    const files: ChangedFile[] = []
    let index = 0

    while (index < parts.length) {
        const token = parts[index++]
        if (!token) continue

        const code = token[0]
        if (code === 'D') {
            index += 1
            continue
        }

        if (code === 'R' || code === 'C') {
            const oldPath = parts[index++]
            const newPath = parts[index++]
            if (newPath) {
                files.push({
                    path: newPath,
                    status: STATUS_MAP[code],
                    oldPath,
                })
            }
            continue
        }

        const path = parts[index++]
        const status = STATUS_MAP[code]
        if (path && status) files.push({ path, status })
    }

    return files
}

/** Parse unified-diff hunk headers into new-file line ranges, merging adjacent hunks. */
export function parseChangedLines(stdout: string): LineRange[] {
    const ranges: LineRange[] = []

    for (const line of stdout.split('\n')) {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (!match?.[1]) continue

        const start = Number(match[1])
        const count = match[2] === undefined ? 1 : Number(match[2])
        if (count === 0) continue

        const end = start + count - 1
        const previous = ranges[ranges.length - 1]
        if (previous && start <= previous.end + 1) {
            ranges[ranges.length - 1] = {
                start: previous.start,
                end: Math.max(previous.end, end),
            }
        } else {
            ranges.push({ start, end })
        }
    }

    return ranges
}

/** Whether an auto-discovered path should be skipped as generated, vendored, or binary. */
export function shouldIgnore(path: string): boolean {
    const segments = path.split('/')
    if (segments.some(segment => IGNORED_SEGMENTS.has(segment))) return true

    const basename = segments[segments.length - 1]
    if (IGNORED_BASENAMES.has(basename)) return true
    return GENERATED_FILE.test(basename) || BINARY_FILE.test(basename)
}

function formatRanges(ranges: readonly LineRange[]): string {
    return ranges
        .map(({ start, end }) => (start === end ? `${start}` : `${start}-${end}`))
        .join(', ')
}

function formatFile(file: ChangedFile): string {
    if (file.status === 'added') return `- ${file.path} (added; entire file in scope)`
    if (file.explicit) return `- ${file.path} (explicitly requested; entire file in scope)`

    const unavailable = 'changed lines unavailable — inspect git diff before editing'
    const relation =
        file.status === 'renamed' || file.status === 'copied'
            ? `${file.status} from ${file.oldPath}`
            : undefined

    if (file.changedLines === undefined) {
        return `- ${file.path} (${relation ?? file.status}; ${unavailable})`
    }
    if (relation) {
        const detail =
            file.changedLines.length === 0
                ? 'no content changes'
                : `changed lines: ${formatRanges(file.changedLines)}`
        return `- ${file.path} (${relation}; ${detail})`
    }
    if (file.changedLines.length === 0) {
        return `- ${file.path} (${file.status}; deletions only)`
    }
    return `- ${file.path} (${file.status}; changed lines: ${formatRanges(file.changedLines)})`
}

function promptOpening(meta: SimplifyMeta): string {
    switch (meta.source) {
        case 'upstream':
            return `Review the code changed relative to ${meta.baseLabel}: all unpushed commits plus uncommitted and untracked changes.`
        case 'ref':
            return `Review the code changed relative to ${meta.baseLabel}.`
        case 'head':
            return `Review the code changed relative to ${meta.baseLabel} (uncommitted changes only; no upstream branch is configured).`
        case 'none':
            return 'Review the code in this new repository.'
    }
}

/** Build the follow-up prompt that scopes simplification to the collected files. */
export function buildSimplifyPrompt(
    files: readonly ChangedFile[],
    meta: SimplifyMeta
): string {
    const opening = promptOpening(meta)

    const stagedNote = meta.staged ? '\n\nOnly staged changes are included.' : ''
    const fileList = files.map(formatFile).join('\n')

    let note = ''
    if (meta.skippedCount > 0 || meta.omittedCount > 0) {
        const parts: string[] = []
        if (meta.skippedCount > 0) {
            parts.push(`${meta.skippedCount} file(s) excluded by the ignore filter`)
        }
        if (meta.omittedCount > 0) {
            parts.push(`${meta.omittedCount} file(s) omitted by the ${MAX_FILES}-file cap`)
        }
        note = `\n\nNote: ${parts.join(' and ')}. Do not edit omitted or excluded files.`
    }

    return `${opening}${stagedNote}

## Principles

- **Preserve behavior**: Do not change what the code does. Existing tests must continue to pass.
- **Follow project standards**: Apply conventions from AGENTS.md or CLAUDE.md in this project.
- **Improve clarity**: Reduce complexity and nesting, remove dead code and redundant abstractions, improve names, and consolidate duplication.
- **Keep useful comments**: Preserve comments that explain rationale, business rules, non-obvious behavior, or intent. Remove only noise that restates the code.
- **Prefer readability over line count**: Avoid nested ternaries; use switch or if/else for multi-branch logic. Do not merge unrelated concerns, drop helpful abstractions, or write clever one-liners.
- **Do not over-simplify**: Clever solutions that are harder to understand are worse than the original.

## Scope

Only the files listed below and their listed changed lines are in scope. Line numbers
refer to the current file contents. You may read surrounding code for context, but you
must not edit outside the listed line ranges. Files marked added or explicitly requested
are fully in scope. Do not add features, change public APIs, or refactor unchanged code.
If a worthwhile simplification needs unchanged code, leave it alone and mention it in
the summary instead.

${fileList}${note}

## Process

1. Read each file listed above and inspect its changed lines.
2. Identify concrete issues within those lines: dead code, unclear names, redundant logic, unnecessary nesting or abstraction, duplication, inconsistent patterns.
3. Apply edits one file at a time, keeping every edit within the listed ranges.
4. If the project has a test or lint command, run it and fix only failures caused by your edits.
5. Summarize what you changed per file, and list worthwhile out-of-scope opportunities you deliberately skipped.`
}

function fileDiffArgs(staged: boolean, sha: string, file: ChangedFile): string[] {
    const args = ['diff', '--unified=0', '--no-ext-diff']
    if (staged) args.push('--cached')
    args.push(sha, '--', file.path)
    if (file.oldPath && file.oldPath !== file.path) args.push(file.oldPath)
    return args
}

async function addChangedLines(
    pi: ExecApi,
    cwd: string,
    staged: boolean,
    sha: string | undefined,
    files: readonly ChangedFile[]
): Promise<ChangedFile[]> {
    return Promise.all(
        files.map(async file => {
            if (file.status === 'added' || file.explicit) return file
            if (!sha) return file

            const result = await pi.exec('git', fileDiffArgs(staged, sha, file), { cwd })
            return result.code === 0
                ? { ...file, changedLines: parseChangedLines(result.stdout) }
                : file
        })
    )
}

/** Collect tracked, untracked, and explicitly requested files with their changed ranges. */
export async function getChangedFiles(
    pi: ExecApi,
    cwd: string,
    options: SimplifyOptions
): Promise<ChangedFilesResult> {
    const base = await resolveBase(pi, cwd, options.ref)
    const explicitPaths = new Set(options.files)
    let skippedCount = 0

    const diffArgs = ['diff', '--name-status', '-z']
    if (options.staged) diffArgs.push('--cached')
    if (base.base) diffArgs.push(base.base)
    if (options.files.length > 0) diffArgs.push('--', ...options.files)

    const diff = await pi.exec('git', diffArgs, { cwd })
    if (diff.code !== 0) {
        throw new Error(diff.stderr.trim() || `git diff failed with exit code ${diff.code}.`)
    }

    const shouldSkip = (path: string): boolean =>
        !explicitPaths.has(path) && shouldIgnore(path)

    const tracked: ChangedFile[] = []
    for (const file of parseNameStatus(diff.stdout)) {
        if (shouldSkip(file.path)) {
            skippedCount += 1
            continue
        }
        tracked.push(file)
    }

    const untracked: ChangedFile[] = []
    if (!options.staged) {
        const args = ['ls-files', '--others', '--exclude-standard', '-z']
        if (options.files.length > 0) args.push('--', ...options.files)
        const result = await pi.exec('git', args, { cwd })
        if (result.code === 0) {
            for (const path of result.stdout.split('\0')) {
                if (!path) continue
                if (shouldSkip(path)) {
                    skippedCount += 1
                    continue
                }
                untracked.push({ path, status: 'added' })
            }
        }
    }

    const byPath = new Map<string, ChangedFile>()
    for (const file of tracked) {
        if (!byPath.has(file.path)) byPath.set(file.path, file)
    }
    for (const file of untracked) {
        if (!byPath.has(file.path)) byPath.set(file.path, file)
    }
    if (!options.staged) {
        for (const path of options.files) {
            if (!byPath.has(path)) {
                byPath.set(path, { path, status: 'modified', explicit: true })
            }
        }
    }

    const sorted = [...byPath.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    )
    const omittedCount = Math.max(0, sorted.length - MAX_FILES)
    const capped = sorted.slice(0, MAX_FILES)
    const files = await addChangedLines(pi, cwd, options.staged, base.base, capped)

    return { files, base, skippedCount, omittedCount }
}

function emptyMessage(source: BaseSource, base: BaseInfo, staged: boolean): string {
    if (staged) return `No staged changes relative to ${base.name}.`
    if (source === 'upstream') {
        return `Nothing unpushed or uncommitted relative to ${base.name}. Pass file paths or --ref=<branch> to review something else.`
    }
    if (source === 'head') {
        return 'No uncommitted changes. Configure an upstream branch or pass --ref=<branch> to review committed work.'
    }
    if (source === 'ref') return `No changes relative to ${base.name}.`
    return 'No changed files found.'
}

function sourceFor(base: BaseInfo): BaseSource {
    return base.source === 'head' && !base.base ? 'none' : base.source
}

export async function handleSimplifyCommand(
    args: string,
    ctx: ExtensionCommandContext,
    pi: ExtensionAPI
): Promise<void> {
    let options: SimplifyOptions
    let result: ChangedFilesResult
    try {
        options = parseArgs(args)
        result = await getChangedFiles(pi, ctx.cwd, options)
    } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
        return
    }

    const source = sourceFor(result.base)
    if (result.files.length === 0) {
        if (result.skippedCount > 0) {
            ctx.ui.notify(
                `No reviewable files: ${result.skippedCount} changed file(s) were excluded as generated, vendored, lock, or binary.`,
                'info'
            )
            return
        }
        ctx.ui.notify(emptyMessage(source, result.base, options.staged), 'info')
        return
    }

    cachedChangedFiles = result.files.map(file => file.path)
    const excluded = result.skippedCount > 0 ? ` (${result.skippedCount} excluded)` : ''
    ctx.ui.notify(
        `Simplify: reviewing ${result.files.length} file(s) relative to ${result.base.label}${excluded}`,
        'info'
    )

    const prompt = buildSimplifyPrompt(result.files, {
        baseLabel: result.base.label,
        source,
        staged: options.staged,
        skippedCount: result.skippedCount,
        omittedCount: result.omittedCount,
    })
    await pi.sendUserMessage(prompt, { deliverAs: 'followUp' })
}

interface Completion {
    value: string
    label: string
    description: string
}

/**
 * Complete the whole argument string. `argumentText` is everything after
 * `/simplify `; returned values replace that entire string, so the head is
 * re-attached to each suggestion.
 */
export function getArgumentCompletions(argumentText: string): Completion[] {
    const match = /^(.*\s)?(\S*)$/s.exec(argumentText)
    const head = match?.[1] ?? ''
    const token = match?.[2] ?? ''

    if (token.startsWith('-')) {
        return [
            {
                value: `${head}--staged`,
                label: '--staged',
                description: 'Review only staged changes',
            },
            {
                value: `${head}--ref=`,
                label: '--ref=',
                description: 'Review changes relative to a git ref',
            },
        ].filter(item => item.label.startsWith(token))
    }

    return cachedChangedFiles
        .filter(path => path.startsWith(token))
        .slice(0, 20)
        .map(path => ({ value: head + path, label: path, description: 'changed' }))
}

export default function simplifyExtension(pi: ExtensionAPI): void {
    pi.registerCommand(COMMAND_NAME, {
        description:
            'Review changed code for clarity, consistency, and maintainability improvements',
        getArgumentCompletions: argumentText => getArgumentCompletions(argumentText),
        handler: (args, ctx) => handleSimplifyCommand(args, ctx, pi),
    })
}
