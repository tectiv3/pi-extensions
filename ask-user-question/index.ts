/**
 * Ask User Question Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
    Editor,
    type EditorTheme,
    Key,
    matchesKey,
    Text,
    visibleWidth,
    wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import { Type } from 'typebox'

// Types
interface QuestionOption {
    value: string
    label: string
    description?: string
}

type RenderOption = QuestionOption & { isOther?: boolean }

interface Question {
    id: string
    label: string
    prompt: string
    options: QuestionOption[]
    allowOther: boolean
}

interface Answer {
    id: string
    value: string
    label: string
    wasCustom: boolean
    index?: number
}

interface AskUserQuestionResult {
    questions: Question[]
    answers: Answer[]
    cancelled: boolean
}

// Schema
const QuestionOptionSchema = Type.Object({
    value: Type.Optional(
        Type.String({ description: 'The value returned when selected (defaults to label)' })
    ),
    label: Type.String({ description: 'Display label for the option' }),
    description: Type.Optional(
        Type.String({ description: 'Optional description shown below label' })
    ),
})

const QuestionSchema = Type.Object({
    id: Type.Optional(
        Type.String({
            description: 'Unique identifier for this question (defaults to Q1, Q2, ...)',
        })
    ),
    label: Type.Optional(
        Type.String({
            description:
                "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
        })
    ),
    prompt: Type.String({ description: 'The full question text to display' }),
    options: Type.Array(QuestionOptionSchema, {
        description: 'Available options to choose from',
    }),
    allowOther: Type.Optional(
        Type.Boolean({ description: "Allow 'Type something' option (default: true)" })
    ),
})

const AskUserQuestionParams = Type.Object({
    questions: Type.Array(QuestionSchema, {
        description: 'Questions to ask the user',
        minItems: 1,
    }),
})

function errorResult(
    message: string,
    questions: Question[] = []
): { content: { type: 'text'; text: string }[]; details: AskUserQuestionResult } {
    return {
        content: [{ type: 'text', text: message }],
        details: { questions, answers: [], cancelled: true },
    }
}

// Remote-control access (see pi-extensions/rc). The structural type keeps the
// two extensions decoupled: rc is looked up on globalThis and checked, never imported.
interface RcRemote {
    isServing(): boolean
    hasConnectedClients(): boolean
    // Widened ask gate: serving AND (clients connected OR push sendable) —
    // keeps the question push reachable for a locked phone with 0 clients.
    askAvailable(): boolean
    ask(opts: {
        kind: 'ask_user_question'
        params: unknown
        signal?: AbortSignal
    }): Promise<Answer[] | 'dismissed' | null>
}

const RC_KEY = Symbol.for('pi-rc')

function rcRemote(): RcRemote | undefined {
    const rc = (globalThis as unknown as Record<symbol, unknown>)[RC_KEY]
    if (!rc) return undefined
    // Widened guard (both `ask` AND `askAvailable` must be functions): a stale
    // pre-`askAvailable` singleton can survive /reload (the extension module is
    // reloaded but the singleton object lives on in globalThis). Accepting it
    // by `ask` alone would then call rc.askAvailable() on a plain undefined
    // and THROW mid-tool-call; requiring both lets it fall through to the
    // local TUI prompt instead.
    if (
        typeof (rc as RcRemote).ask !== 'function' ||
        typeof (rc as RcRemote).askAvailable !== 'function'
    )
        return undefined
    return rc as RcRemote
}

// Esc escape hatch for the remote ask: show a non-blocking wait panel while
// the singleton waits for a remote client answer. Esc aborts the ask through
// its signal (the singleton cancels the pending ask and resolves null) so the
// caller falls through to the local TUI prompt. The tool-call abort signal is
// forwarded onto the same controller: an agent-run abort cancels the remote
// ask and closes the wait panel instead of leaving both dangling. Any other
// null cause (Esc, /rc toggle-off, all clients disconnected) resolves the
// same way.
async function askRemoteWithEscHatch(
    ctx: ExtensionContext,
    questions: Question[],
    signal: AbortSignal | undefined
): Promise<Answer[] | 'dismissed' | null> {
    const rc = rcRemote()
    if (!rc) return null
    const controller = new AbortController()
    const onToolAbort = () => controller.abort()
    if (signal) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', onToolAbort, { once: true })
    }
    const askPromise = rc.ask({
        kind: 'ask_user_question',
        params: { questions },
        signal: controller.signal,
    })
    // Non-blocking wait panel: closes when the remote ask settles, however it
    // settles (client answered, or Esc/toggle-off/disconnect cancelled it).
    await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        let settled = false
        const finish = () => {
            if (settled) return
            settled = true
            done()
        }
        void askPromise.then(finish, finish)
        return {
            render: (width: number) => {
                const bar = '─'.repeat(Math.max(1, width))
                return [
                    theme.fg('accent', bar),
                    ' ' + theme.fg('text', 'Question(s) sent to remote client(s).'),
                    ' ' + theme.fg('dim', 'Press Esc to answer locally.'),
                    theme.fg('accent', bar),
                ]
            },
            invalidate: () => {},
            handleInput: (data: string) => {
                if (matchesKey(data, Key.escape)) {
                    controller.abort()
                    finish()
                }
            },
        }
    })
    if (signal) signal.removeEventListener('abort', onToolAbort)
    return await askPromise
}

export default function askUserQuestion(pi: ExtensionAPI) {
    pi.registerTool({
        name: 'ask_user_question',
        label: 'Ask User Question',
        description:
            'Ask the user one or more questions with typed options. Single question shows a simple option list; multiple questions show a tab-based interface. Use when you need user input, preferences, or confirmation.',
        executionMode: 'sequential',
        parameters: AskUserQuestionParams,

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            // Normalize once up front (defaults for id/label/options.value/
            // allowOther); every later consumer — remote params, TUI, details —
            // uses this array.
            const questions: Question[] = params.questions.map((q, i) => ({
                id: q.id || `Q${i + 1}`,
                label: q.label || `Q${i + 1}`,
                prompt: q.prompt,
                options: q.options.map(o => ({
                    value: o.value || o.label,
                    label: o.label,
                    ...(o.description !== undefined ? { description: o.description } : {}),
                })),
                allowOther: q.allowOther !== false,
            }))

            const rc = rcRemote()
            if (rc && rc.askAvailable()) {
                const answers =
                    ctx.mode === 'tui'
                        ? await askRemoteWithEscHatch(ctx, questions, signal)
                        : await rc.ask({
                              kind: 'ask_user_question',
                              params: { questions },
                              signal: signal ?? undefined,
                          })
                if (answers !== null && answers !== 'dismissed') {
                    const answerLines = answers.map(a => {
                        const qLabel = questions.find(q => q.id === a.id)?.label || a.id
                        if (a.wasCustom) {
                            return `${qLabel}: user wrote: ${a.label}`
                        }
                        // value may intentionally differ from label (the schema
                        // supports both); the model consumes this text, so
                        // surface the value when they differ.
                        const suffix = a.value !== a.label ? ` (value: ${a.value})` : ''
                        return `${qLabel}: user selected: ${a.index}. ${a.label}${suffix}`
                    })
                    return {
                        content: [{ type: 'text', text: answerLines.join('\n') }],
                        details: { questions, answers, cancelled: false },
                    }
                }
                // Dismissed (wire abort) or a run abort: report the cancellation.
                // Falling through to the local TUI prompt is wrong here — the run
                // is going away, and a local prompt would hold the aborting run
                // hostage on an unattended terminal.
                if (answers === 'dismissed' || (answers === null && signal?.aborted)) {
                    return errorResult('User cancelled the question', questions)
                }
                // TUI + null (Esc, toggle-off, all clients disconnected): fall through to
                // the local TUI prompt below. Non-TUI has no local prompt; the ask is
                // final there.
                if (ctx.mode !== 'tui') {
                    return errorResult('User cancelled the question', questions)
                }
            }

            if (ctx.mode !== 'tui') {
                // rpc mode: relay questions to parent via ctx.ui.select/input.
                // These methods exist at runtime (rpc-mode.ts emits extension_ui_request
                // events on stdout) but are absent from the local type stubs.
                const ui = ctx.ui as unknown as {
                    select(
                        title: string,
                        options: string[],
                        opts?: { signal?: AbortSignal }
                    ): Promise<string | undefined>
                    input(
                        title: string,
                        defaultValue?: string,
                        opts?: { signal?: AbortSignal }
                    ): Promise<string | undefined>
                }

                const answers: Answer[] = []
                for (const question of questions) {
                    const optionLabels = question.options.map(o => o.label)
                    if (question.allowOther) {
                        optionLabels.push('Type something...')
                    }

                    const selected = await ui.select(question.prompt, optionLabels, {
                        signal: signal ?? undefined,
                    })

                    if (selected === undefined) {
                        return errorResult('User cancelled the question', questions)
                    }

                    if (question.allowOther && selected === 'Type something...') {
                        const typed = await ui.input(question.prompt, undefined, {
                            signal: signal ?? undefined,
                        })
                        if (typed === undefined) {
                            return errorResult('User cancelled the question', questions)
                        }
                        answers.push({
                            id: question.id,
                            value: typed,
                            label: typed,
                            wasCustom: true,
                        })
                    } else {
                        const matchedOption = question.options.find(o => o.label === selected)
                        const matchedIndex = question.options.findIndex(
                            o => o.label === selected
                        )
                        answers.push({
                            id: question.id,
                            value: matchedOption?.value ?? selected,
                            label: selected,
                            wasCustom: false,
                            index: matchedIndex >= 0 ? matchedIndex + 1 : undefined,
                        })
                    }
                }

                const answerLines = answers.map(a => {
                    const qLabel = questions.find(q => q.id === a.id)?.label || a.id
                    if (a.wasCustom) {
                        return `${qLabel}: user wrote: ${a.label}`
                    }
                    const suffix = a.value !== a.label ? ` (value: ${a.value})` : ''
                    return `${qLabel}: user selected: ${a.index}. ${a.label}${suffix}`
                })

                return {
                    content: [{ type: 'text', text: answerLines.join('\n') }],
                    details: { questions, answers, cancelled: false },
                }
            }

            const isMulti = questions.length > 1
            const totalTabs = questions.length + 1 // questions + Submit

            const result = await ctx.ui.custom<AskUserQuestionResult>(
                (tui, theme, _kb, done) => {
                    // State
                    let currentTab = 0
                    let optionIndex = 0
                    let inputMode = false
                    let inputQuestionId: string | null = null
                    let cachedLines: string[] | undefined
                    const answers = new Map<string, Answer>()

                    // Editor for "Type something" option
                    const editorTheme: EditorTheme = {
                        borderColor: s => theme.fg('accent', s),
                        selectList: {
                            selectedPrefix: t => theme.fg('accent', t),
                            selectedText: t => theme.fg('accent', t),
                            description: t => theme.fg('muted', t),
                            scrollInfo: t => theme.fg('dim', t),
                            noMatch: t => theme.fg('warning', t),
                        },
                    }
                    const editor = new Editor(tui, editorTheme)

                    // Helpers
                    function refresh() {
                        cachedLines = undefined
                        tui.requestRender()
                    }

                    function submit(cancelled: boolean) {
                        done({ questions, answers: Array.from(answers.values()), cancelled })
                    }

                    function currentQuestion(): Question | undefined {
                        return questions[currentTab]
                    }

                    function currentOptions(): RenderOption[] {
                        const q = currentQuestion()
                        if (!q) return []
                        const opts: RenderOption[] = [...q.options]
                        if (q.allowOther) {
                            opts.push({
                                value: '__other__',
                                label: 'Type something.',
                                isOther: true,
                            })
                        }
                        return opts
                    }

                    function allAnswered(): boolean {
                        return questions.every(q => answers.has(q.id))
                    }

                    function advanceAfterAnswer() {
                        if (!isMulti) {
                            submit(false)
                            return
                        }
                        if (currentTab < questions.length - 1) {
                            currentTab++
                        } else {
                            currentTab = questions.length // Submit tab
                        }
                        optionIndex = 0
                        refresh()
                    }

                    function saveAnswer(
                        questionId: string,
                        value: string,
                        label: string,
                        wasCustom: boolean,
                        index?: number
                    ) {
                        answers.set(questionId, {
                            id: questionId,
                            value,
                            label,
                            wasCustom,
                            index,
                        })
                    }

                    // Editor submit callback
                    editor.onSubmit = value => {
                        if (!inputQuestionId) return
                        const trimmed = value.trim() || '(no response)'
                        saveAnswer(inputQuestionId, trimmed, trimmed, true)
                        inputMode = false
                        inputQuestionId = null
                        editor.setText('')
                        advanceAfterAnswer()
                    }

                    function handleInput(data: string) {
                        // Input mode: route to editor
                        if (inputMode) {
                            if (matchesKey(data, Key.escape)) {
                                inputMode = false
                                inputQuestionId = null
                                editor.setText('')
                                refresh()
                                return
                            }
                            editor.handleInput(data)
                            refresh()
                            return
                        }

                        const q = currentQuestion()
                        const opts = currentOptions()

                        // Tab navigation (multi-question only)
                        if (isMulti) {
                            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                                currentTab = (currentTab + 1) % totalTabs
                                optionIndex = 0
                                refresh()
                                return
                            }
                            if (
                                matchesKey(data, Key.shift('tab')) ||
                                matchesKey(data, Key.left)
                            ) {
                                currentTab = (currentTab - 1 + totalTabs) % totalTabs
                                optionIndex = 0
                                refresh()
                                return
                            }
                        }

                        // Submit tab
                        if (currentTab === questions.length) {
                            if (matchesKey(data, Key.enter) && allAnswered()) {
                                submit(false)
                            } else if (matchesKey(data, Key.escape)) {
                                submit(true)
                            }
                            return
                        }

                        // Option navigation
                        if (matchesKey(data, Key.up)) {
                            optionIndex = Math.max(0, optionIndex - 1)
                            refresh()
                            return
                        }
                        if (matchesKey(data, Key.down)) {
                            optionIndex = Math.min(opts.length - 1, optionIndex + 1)
                            refresh()
                            return
                        }

                        // Select option
                        if (matchesKey(data, Key.enter) && q) {
                            const opt = opts[optionIndex]
                            if (opt.isOther) {
                                inputMode = true
                                inputQuestionId = q.id
                                editor.setText('')
                                refresh()
                                return
                            }
                            saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1)
                            advanceAfterAnswer()
                            return
                        }

                        // Cancel
                        if (matchesKey(data, Key.escape)) {
                            submit(true)
                        }
                    }

                    function render(width: number): string[] {
                        if (cachedLines) return cachedLines

                        const lines: string[] = []
                        const renderWidth = Math.max(1, width)
                        const q = currentQuestion()
                        const opts = currentOptions()

                        function addWrapped(text: string) {
                            lines.push(...wrapTextWithAnsi(text, renderWidth))
                        }

                        function addWrappedWithPrefix(prefix: string, text: string) {
                            const prefixWidth = visibleWidth(prefix)
                            if (prefixWidth >= renderWidth) {
                                addWrapped(prefix + text)
                                return
                            }
                            const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth)
                            const continuationPrefix = ' '.repeat(prefixWidth)
                            for (let i = 0; i < wrapped.length; i++) {
                                lines.push(
                                    `${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`
                                )
                            }
                        }

                        lines.push(theme.fg('accent', '─'.repeat(renderWidth)))

                        // Tab bar (multi-question only)
                        if (isMulti) {
                            const tabs: string[] = ['← ']
                            for (let i = 0; i < questions.length; i++) {
                                const isActive = i === currentTab
                                const isAnswered = answers.has(questions[i].id)
                                const lbl = questions[i].label
                                const box = isAnswered ? '■' : '□'
                                const color = isAnswered ? 'success' : 'muted'
                                const text = ` ${box} ${lbl} `
                                const styled = isActive
                                    ? theme.bg('selectedBg', theme.fg('text', text))
                                    : theme.fg(color, text)
                                tabs.push(`${styled} `)
                            }
                            const canSubmit = allAnswered()
                            const isSubmitTab = currentTab === questions.length
                            const submitText = ' ✓ Submit '
                            const submitStyled = isSubmitTab
                                ? theme.bg('selectedBg', theme.fg('text', submitText))
                                : theme.fg(canSubmit ? 'success' : 'dim', submitText)
                            tabs.push(`${submitStyled} →`)
                            addWrappedWithPrefix(' ', tabs.join(''))
                            lines.push('')
                        }

                        // Helper to render options list
                        function renderOptions() {
                            for (let i = 0; i < opts.length; i++) {
                                const opt = opts[i]
                                const selected = i === optionIndex
                                const isOther = opt.isOther === true
                                const prefix = selected ? theme.fg('accent', '> ') : '  '
                                const label = `${i + 1}. ${opt.label}${isOther && inputMode ? ' ✎' : ''}`
                                const color =
                                    selected || (isOther && inputMode) ? 'accent' : 'text'

                                addWrappedWithPrefix(prefix, theme.fg(color, label))
                                if (opt.description) {
                                    addWrappedWithPrefix(
                                        '     ',
                                        theme.fg('muted', opt.description)
                                    )
                                }
                            }
                        }

                        // Content
                        if (inputMode && q) {
                            addWrappedWithPrefix(' ', theme.fg('text', q.prompt))
                            lines.push('')
                            // Show options for reference
                            renderOptions()
                            lines.push('')
                            addWrappedWithPrefix(' ', theme.fg('muted', 'Your answer:'))
                            for (const line of editor.render(Math.max(1, renderWidth - 2))) {
                                lines.push(` ${line}`)
                            }
                            lines.push('')
                            addWrappedWithPrefix(
                                ' ',
                                theme.fg('dim', 'Enter to submit • Esc to cancel')
                            )
                        } else if (currentTab === questions.length) {
                            addWrappedWithPrefix(
                                ' ',
                                theme.fg('accent', theme.bold('Ready to submit'))
                            )
                            lines.push('')
                            for (const question of questions) {
                                const answer = answers.get(question.id)
                                if (answer) {
                                    const prefix = answer.wasCustom ? '(wrote) ' : ''
                                    const summary = `${theme.fg('muted', `${question.label}: `)}${theme.fg('text', prefix + answer.label)}`
                                    addWrappedWithPrefix(' ', summary)
                                }
                            }
                            lines.push('')
                            if (allAnswered()) {
                                addWrappedWithPrefix(
                                    ' ',
                                    theme.fg('success', 'Press Enter to submit')
                                )
                            } else {
                                const missing = questions
                                    .filter(q => !answers.has(q.id))
                                    .map(q => q.label)
                                    .join(', ')
                                addWrappedWithPrefix(
                                    ' ',
                                    theme.fg('warning', `Unanswered: ${missing}`)
                                )
                            }
                        } else if (q) {
                            addWrappedWithPrefix(' ', theme.fg('text', q.prompt))
                            lines.push('')
                            renderOptions()
                        }

                        lines.push('')
                        if (!inputMode) {
                            const help = isMulti
                                ? 'Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel'
                                : '↑↓ navigate • Enter select • Esc cancel'
                            addWrappedWithPrefix(' ', theme.fg('dim', help))
                        }
                        lines.push(theme.fg('accent', '─'.repeat(renderWidth)))

                        cachedLines = lines
                        return lines
                    }

                    return {
                        render,
                        invalidate: () => {
                            cachedLines = undefined
                        },
                        handleInput,
                    }
                }
            )

            if (result.cancelled) {
                return {
                    content: [{ type: 'text', text: 'User cancelled the question' }],
                    details: result,
                }
            }

            const answerLines = result.answers.map(a => {
                const qLabel = questions.find(q => q.id === a.id)?.label || a.id
                if (a.wasCustom) {
                    return `${qLabel}: user wrote: ${a.label}`
                }
                // value may intentionally differ from label (the schema
                // supports both); the model consumes this text, so surface the
                // value when they differ.
                const suffix = a.value !== a.label ? ` (value: ${a.value})` : ''
                return `${qLabel}: user selected: ${a.index}. ${a.label}${suffix}`
            })

            return {
                content: [{ type: 'text', text: answerLines.join('\n') }],
                details: result,
            }
        },

        renderCall(args, theme, _context) {
            const qs = (args.questions as Question[]) || []
            const count = qs.length
            const labels = qs.map(q => q.label || q.id).join(', ')
            let text = theme.fg('toolTitle', theme.bold('ask_user_question '))
            text += theme.fg('muted', `${count} question${count !== 1 ? 's' : ''}`)
            if (labels) {
                text += theme.fg('dim', ` (${labels})`)
            }
            return new Text(text, 0, 0)
        },

        renderResult(result, _options, theme, _context) {
            const details = result.details as AskUserQuestionResult | undefined
            if (!details) {
                const text = result.content[0]
                return new Text(text?.type === 'text' ? text.text : '', 0, 0)
            }
            if (details.cancelled) {
                return new Text(theme.fg('warning', 'Cancelled'), 0, 0)
            }
            const lines = details.answers.map(a => {
                if (a.wasCustom) {
                    return `${theme.fg('success', '✓ ')}${theme.fg('accent', a.id)}: ${theme.fg('muted', '(wrote) ')}${a.label}`
                }
                const display = a.index ? `${a.index}. ${a.label}` : a.label
                return `${theme.fg('success', '✓ ')}${theme.fg('accent', a.id)}: ${display}`
            })
            return new Text(lines.join('\n'), 0, 0)
        },
    })
}
