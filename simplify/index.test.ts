import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import type { ChangedFilesResult, ExecApi, SimplifyMeta } from './index.ts'
import {
    buildSimplifyPrompt,
    getChangedFiles,
    getArgumentCompletions,
    handleSimplifyCommand,
    parseArgs,
    parseChangedLines,
    parseNameStatus,
    resolveBase,
    shouldIgnore,
} from './index.ts'

type ExecResult = Awaited<ReturnType<ExecApi['exec']>>

const BASE_SHA = '1234567890abcdef1234567890abcdef12345678'
const HEAD_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const MERGE_SHA = 'fedcba0987654321fedcba0987654321fedcba09'

function ok(stdout: string): ExecResult {
    return { stdout, stderr: '', code: 0, killed: false }
}

function fail(stderr = ''): ExecResult {
    return { stdout: '', stderr, code: 1, killed: false }
}

function makeExec(handler: (args: string[]) => ExecResult | undefined): {
    pi: ExecApi
    calls: string[][]
} {
    const calls: string[][] = []
    const exec: ExecApi['exec'] = async (_command, args) => {
        calls.push(args)
        return handler(args) ?? fail()
    }
    return { pi: { exec }, calls }
}

function upstreamBase(args: string[]): ExecResult | undefined {
    const key = args.join(' ')
    if (key === 'rev-parse --is-inside-work-tree') return ok('true\n')
    if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        return ok('origin/main\n')
    }
    if (key === 'merge-base HEAD origin/main') return ok(`${BASE_SHA}\n`)
    return undefined
}

const baseMeta: SimplifyMeta = {
    baseLabel: `origin/main (${BASE_SHA.slice(0, 7)})`,
    source: 'upstream',
    staged: false,
    skippedCount: 0,
    omittedCount: 0,
}

test('parseArgs defaults, flags, quoted paths, and invalid refs', () => {
    assert.deepEqual(parseArgs(''), { files: [], staged: false })
    assert.deepEqual(parseArgs('   '), { files: [], staged: false })
    assert.deepEqual(parseArgs('--staged'), { files: [], staged: true })
    assert.deepEqual(parseArgs('--ref=main'), { files: [], ref: 'main', staged: false })
    assert.deepEqual(parseArgs('"src/a file.ts" src/b.ts'), {
        files: ['src/a file.ts', 'src/b.ts'],
        staged: false,
    })
    assert.deepEqual(parseArgs("--staged 'src/a file.ts' --ref=develop"), {
        files: ['src/a file.ts'],
        ref: 'develop',
        staged: true,
    })

    // Ref values starting with "-" would look like git options, so parsing throws.
    assert.throws(() => parseArgs('--ref=-bad'), /Invalid git ref/)
    assert.throws(() => parseArgs('--ref='), /Missing value for --ref/)
    assert.throws(() => parseArgs('--dry-run'), /Unknown option: --dry-run/)
})

test('parseNameStatus handles NUL records, renames, copies, deletions, spaces, and unicode', () => {
    const stdout =
        [
            'M',
            'src/a.ts',
            'A',
            'src/b.ts',
            'R100',
            'src/old name.ts',
            'src/new ü.ts',
            'C100',
            'src/orig.ts',
            'src/copy.ts',
            'D',
            'src/gone.ts',
            'M',
            'src/with space.ts',
        ].join('\0') + '\0'

    assert.deepEqual(parseNameStatus(stdout), [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/b.ts', status: 'added' },
        { path: 'src/new ü.ts', status: 'renamed', oldPath: 'src/old name.ts' },
        { path: 'src/copy.ts', status: 'copied', oldPath: 'src/orig.ts' },
        { path: 'src/with space.ts', status: 'modified' },
    ])
})

test('parseChangedLines extracts, merges, and skips hunk ranges', () => {
    assert.deepEqual(
        parseChangedLines(
            ['@@ -1 +1,2 @@', '@@ -20,0 +30,4 @@', '@@ -40 +50,0 @@', '@@ -60 +70 @@'].join(
                '\n'
            )
        ),
        [
            { start: 1, end: 2 },
            { start: 30, end: 33 },
            { start: 70, end: 70 },
        ]
    )

    assert.deepEqual(parseChangedLines('@@ -1 +1,2 @@\n@@ -4,0 +3,2 @@\n'), [
        { start: 1, end: 4 },
    ])

    assert.deepEqual(parseChangedLines('@@ -5 +9,0 @@\n'), [])
    assert.deepEqual(parseChangedLines('@@ -0,0 +1,5 @@\n'), [{ start: 1, end: 5 }])
})

test('shouldIgnore skips generated, vendored, lock, and binary paths', () => {
    assert.equal(shouldIgnore('node_modules/x.ts'), true)
    assert.equal(shouldIgnore('dist/a.js'), true)
    assert.equal(shouldIgnore('pnpm-lock.yaml'), true)
    assert.equal(shouldIgnore('foo.min.js'), true)
    assert.equal(shouldIgnore('foo.pb.go'), true)
    assert.equal(shouldIgnore('src/foo.ts'), false)
    assert.equal(shouldIgnore('src/generated.generated.ts'), true)
    assert.equal(shouldIgnore('assets/logo.png'), true)
})

test('buildSimplifyPrompt includes files, ranges, wording, scope, and conditional notes', () => {
    const prompt = buildSimplifyPrompt(
        [
            {
                path: 'src/a.ts',
                status: 'modified',
                changedLines: [
                    { start: 1, end: 1 },
                    { start: 9, end: 12 },
                ],
            },
            { path: 'src/new.ts', status: 'added' },
            {
                path: 'src/new-name.ts',
                status: 'renamed',
                oldPath: 'src/old-name.ts',
                changedLines: [{ start: 3, end: 3 }],
            },
            {
                path: 'src/copy.ts',
                status: 'copied',
                oldPath: 'src/base.ts',
                changedLines: [],
            },
            { path: 'docs/notes.md', status: 'modified', explicit: true },
            { path: 'src/unknown.ts', status: 'modified' },
        ],
        baseMeta
    )

    assert.match(prompt, /Review the code changed relative to origin\/main \(1234567\)/)
    assert.match(prompt, /all unpushed commits plus uncommitted and untracked changes/)
    assert.match(prompt, /- src\/a\.ts \(modified; changed lines: 1, 9-12\)/)
    assert.match(prompt, /- src\/new\.ts \(added; entire file in scope\)/)
    assert.match(
        prompt,
        /- src\/new-name\.ts \(renamed from src\/old-name\.ts; changed lines: 3\)/
    )
    assert.match(prompt, /- src\/copy\.ts \(copied from src\/base\.ts; no content changes\)/)
    assert.match(prompt, /- docs\/notes\.md \(explicitly requested; entire file in scope\)/)
    assert.match(
        prompt,
        /- src\/unknown\.ts \(modified; changed lines unavailable — inspect git diff before editing\)/
    )
    assert.match(prompt, /must not edit outside the listed line ranges/)
    assert.doesNotMatch(prompt, /omitted by the 100-file cap/)
    assert.doesNotMatch(prompt, /excluded by the ignore filter/)

    const withNotes = buildSimplifyPrompt(
        [{ path: 'src/a.ts', status: 'modified', changedLines: [] }],
        { ...baseMeta, skippedCount: 2, omittedCount: 3 }
    )
    assert.match(withNotes, /2 file\(s\) excluded by the ignore filter/)
    assert.match(withNotes, /3 file\(s\) omitted by the 100-file cap/)
    assert.match(withNotes, /Do not edit omitted or excluded files/)
    assert.match(withNotes, /deletions only/)
})

test('buildSimplifyPrompt openings match the base source', () => {
    const file = [{ path: 'src/a.ts', status: 'modified' as const, changedLines: [] }]
    assert.match(
        buildSimplifyPrompt(file, { ...baseMeta, source: 'head', baseLabel: 'HEAD' }),
        /relative to HEAD \(uncommitted changes only; no upstream branch is configured\)/
    )
    assert.match(
        buildSimplifyPrompt(file, { ...baseMeta, source: 'ref', baseLabel: 'main (abcdef1)' }),
        /Review the code changed relative to main \(abcdef1\)\./
    )
    assert.match(
        buildSimplifyPrompt(file, { ...baseMeta, source: 'none', baseLabel: 'HEAD' }),
        /Review the code in this new repository\./
    )
    assert.match(
        buildSimplifyPrompt(file, { ...baseMeta, staged: true }),
        /Only staged changes are included\./
    )
})

test('resolveBase resolves upstream, explicit refs, HEAD, and invalid refs', async () => {
    const upstream = makeExec(upstreamBase)
    assert.deepEqual(await resolveBase(upstream.pi, '/repo'), {
        base: BASE_SHA,
        label: `origin/main (${BASE_SHA.slice(0, 7)})`,
        source: 'upstream',
    })

    const ref = makeExec(args => {
        const key = args.join(' ')
        if (key === 'rev-parse --is-inside-work-tree') return ok('true\n')
        if (key === 'rev-parse --verify --quiet main^{commit}') return ok(`${BASE_SHA}\n`)
        if (key === 'merge-base HEAD main') return ok(`${MERGE_SHA}\n`)
        return undefined
    })
    assert.deepEqual(await resolveBase(ref.pi, '/repo', 'main'), {
        base: MERGE_SHA,
        label: `main (${MERGE_SHA.slice(0, 7)})`,
        source: 'ref',
    })

    const head = makeExec(args => {
        const key = args.join(' ')
        if (key === 'rev-parse --is-inside-work-tree') return ok('true\n')
        if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') return fail()
        if (key === 'rev-parse HEAD') return ok(`${HEAD_SHA}\n`)
        return undefined
    })
    assert.deepEqual(await resolveBase(head.pi, '/repo'), {
        base: HEAD_SHA,
        label: 'HEAD',
        source: 'head',
    })

    const invalid = makeExec(args => {
        const key = args.join(' ')
        if (key === 'rev-parse --is-inside-work-tree') return ok('true\n')
        if (key === 'rev-parse --verify --quiet nope^{commit}') return fail()
        return undefined
    })
    await assert.rejects(resolveBase(invalid.pi, '/repo', 'nope'), /Unknown git ref: nope/)

    const outside = makeExec(args =>
        args.join(' ') === 'rev-parse --is-inside-work-tree' ? ok('false\n') : undefined
    )
    await assert.rejects(resolveBase(outside.pi, '/repo'), /Not a git repository/)
})

test('getChangedFiles includes tracked ranges and untracked files in the upstream flow', async () => {
    const { pi } = makeExec(args => {
        const base = upstreamBase(args)
        if (base) return base
        const key = args.join(' ')
        if (key.startsWith('diff --name-status')) return ok('M\0src/a.ts\0')
        if (key.startsWith('ls-files --others')) return ok('src/new file.ts\0')
        if (key.startsWith('diff --unified=0') && key.endsWith('-- src/a.ts')) {
            return ok('@@ -1 +1,2 @@\n@@ -20 +20,3 @@\n')
        }
        return undefined
    })

    const result: ChangedFilesResult = await getChangedFiles(pi, '/repo', {
        files: [],
        staged: false,
    })

    assert.equal(result.base.source, 'upstream')
    assert.equal(result.base.label, `origin/main (${BASE_SHA.slice(0, 7)})`)
    assert.equal(result.skippedCount, 0)
    assert.equal(result.omittedCount, 0)
    assert.deepEqual(result.files, [
        {
            path: 'src/a.ts',
            status: 'modified',
            changedLines: [
                { start: 1, end: 2 },
                { start: 20, end: 22 },
            ],
        },
        { path: 'src/new file.ts', status: 'added' },
    ])
})

test('getChangedFiles --staged excludes untracked files and uses --cached', async () => {
    const { pi, calls } = makeExec(args => {
        const base = upstreamBase(args)
        if (base) return base
        const key = args.join(' ')
        if (key.startsWith('diff --name-status')) return ok('M\0src/staged.ts\0')
        if (key.startsWith('diff --unified=0')) return ok('@@ -5 +5,1 @@\n')
        return undefined
    })

    const result = await getChangedFiles(pi, '/repo', { files: [], staged: true })

    assert.deepEqual(result.files, [
        { path: 'src/staged.ts', status: 'modified', changedLines: [{ start: 5, end: 5 }] },
    ])
    assert.ok(
        calls.some(args => args.join(' ') === `diff --name-status -z --cached ${BASE_SHA}`)
    )
    assert.ok(
        calls.some(args =>
            args.join(' ').startsWith(`diff --unified=0 --no-ext-diff --cached ${BASE_SHA}`)
        )
    )
    assert.equal(
        calls.some(args => args[0] === 'ls-files'),
        false
    )
})

test('getChangedFiles keeps an explicit file with no diff as whole-file scope', async () => {
    const { pi, calls } = makeExec(args => {
        const key = args.join(' ')
        if (key === 'rev-parse --is-inside-work-tree') return ok('true\n')
        if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') return fail()
        if (key === 'rev-parse HEAD') return ok(`${HEAD_SHA}\n`)
        if (key.startsWith('diff --name-status')) return ok('')
        if (key.startsWith('ls-files --others')) return ok('')
        return undefined
    })

    const result = await getChangedFiles(pi, '/repo', {
        files: ['docs/notes.md'],
        staged: false,
    })

    assert.deepEqual(result.files, [
        { path: 'docs/notes.md', status: 'modified', explicit: true },
    ])
    assert.equal(
        calls.some(args => args.includes('--unified=0')),
        false
    )
})

test('getChangedFiles ignores auto-discovered lockfiles but not explicit paths', async () => {
    const { pi } = makeExec(args => {
        const key = args.join(' ')
        if (key === 'rev-parse --is-inside-work-tree') return ok('true\n')
        if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') return fail()
        if (key === 'rev-parse HEAD') return ok(`${HEAD_SHA}\n`)
        if (key.startsWith('diff --name-status')) {
            return args.includes('--')
                ? ok('M\0package-lock.json\0')
                : ok('M\0package-lock.json\0M\0src/ok.ts\0')
        }
        if (key.startsWith('ls-files --others')) return ok('')
        if (key.startsWith('diff --unified=0')) return ok('@@ -2 +2,2 @@\n')
        return undefined
    })

    const auto = await getChangedFiles(pi, '/repo', { files: [], staged: false })
    assert.equal(auto.skippedCount, 1)
    assert.deepEqual(auto.files, [
        { path: 'src/ok.ts', status: 'modified', changedLines: [{ start: 2, end: 3 }] },
    ])

    const explicit = await getChangedFiles(pi, '/repo', {
        files: ['package-lock.json'],
        staged: false,
    })
    assert.equal(explicit.skippedCount, 0)
    assert.deepEqual(explicit.files, [
        {
            path: 'package-lock.json',
            status: 'modified',
            changedLines: [{ start: 2, end: 3 }],
        },
    ])
})

test('getArgumentCompletions completes flags and cached files', () => {
    assert.deepEqual(
        getArgumentCompletions('--st').map(item => item.value),
        ['--staged']
    )
    assert.deepEqual(
        getArgumentCompletions('--ref=').map(item => item.value),
        ['--ref=']
    )
    assert.deepEqual(getArgumentCompletions('nope'), [])
})

test('handleSimplifyCommand reports ignored-only and empty staged scopes', async () => {
    const notices: Array<[string, string]> = []
    const ctx = {
        cwd: '/repo',
        ui: {
            notify: (message: string, severity: string) => notices.push([message, severity]),
        },
    } as unknown as ExtensionCommandContext
    const sent: string[] = []

    const ignored = makeExec(args => {
        const base = upstreamBase(args)
        if (base) return base
        if (args.join(' ') === `diff --name-status -z ${BASE_SHA}`) {
            return ok('M\0pnpm-lock.yaml\0')
        }
        if (args[0] === 'ls-files') return ok('')
        return undefined
    })
    const ignoredApi = {
        ...ignored.pi,
        sendUserMessage: (text: string) => sent.push(text),
    } as unknown as ExtensionAPI

    await handleSimplifyCommand('', ctx, ignoredApi)
    assert.match(
        notices.at(-1)?.[0] ?? '',
        /No reviewable files: 1 changed file\(s\) were excluded/
    )
    assert.equal(sent.length, 0)

    const staged = makeExec(args => {
        const base = upstreamBase(args)
        if (base) return base
        if (args.join(' ').startsWith('diff --name-status -z --cached')) return ok('')
        return undefined
    })
    const stagedApi = {
        ...staged.pi,
        sendUserMessage: (text: string) => sent.push(text),
    } as unknown as ExtensionAPI

    await handleSimplifyCommand('--staged', ctx, stagedApi)
    assert.match(notices.at(-1)?.[0] ?? '', /No staged changes relative to origin\/main/)
    assert.equal(sent.length, 0)
})

test('handleSimplifyCommand notifies errors, sends a follow-up, and caches completions', async () => {
    const { pi } = makeExec(args => {
        const base = upstreamBase(args)
        if (base) return base
        const key = args.join(' ')
        if (key.startsWith('diff --name-status')) return ok('M\0src/command.ts\0')
        if (key.startsWith('ls-files --others')) return ok('')
        if (key.startsWith('diff --unified=0')) return ok('@@ -4 +4,2 @@\n')
        return undefined
    })
    const notices: Array<[string, string]> = []
    const sent: Array<{ text: string; opts: unknown }> = []
    const ctx = {
        cwd: '/repo',
        ui: {
            notify: (message: string, severity: string) => notices.push([message, severity]),
        },
    } as unknown as ExtensionCommandContext
    const api = {
        ...pi,
        sendUserMessage: (text: string, opts: unknown) => sent.push({ text, opts }),
    } as unknown as ExtensionAPI

    await handleSimplifyCommand('', ctx, api)

    assert.equal(notices.length, 1)
    assert.equal(notices[0]?.[1], 'info')
    assert.match(notices[0]?.[0] ?? '', /reviewing 1 file\(s\) relative to origin\/main/)
    assert.equal(sent.length, 1)
    assert.equal((sent[0]?.opts as { deliverAs?: string }).deliverAs, 'followUp')
    assert.match(sent[0]?.text ?? '', /src\/command\.ts/)
    assert.deepEqual(
        getArgumentCompletions('src/').map(item => item.value),
        ['src/command.ts']
    )

    const invalid = makeExec(args =>
        args.join(' ') === 'rev-parse --is-inside-work-tree' ? ok('true\n') : undefined
    )
    await handleSimplifyCommand('--ref=nope', ctx, invalid.pi as unknown as ExtensionAPI)
    assert.equal(notices.at(-1)?.[1], 'error')
    assert.match(notices.at(-1)?.[0] ?? '', /Unknown git ref: nope/)
    assert.equal(sent.length, 1)
})
