/**
 * Subagent question budget: an rpc child is unattended by design, so a question
 * it asks must not block forever. When the budget runs out, every question still
 * unanswered settles on its recommended (first) option. Root-agent questions are
 * never touched.
 *
 * Host-free on purpose: the whole timeout path, including the sequential prompt
 * loop the rpc branch runs, is exercised headlessly by `timeout.test.ts`.
 */

/** Marks every process spawned by the subagent extension (see `subagent/child-env.ts`). */
export const SUBAGENT_ENV = 'PI_SUBAGENT'

/** Overrides the default budget; `0`, a negative value, or garbage disables it. */
export const TIMEOUT_ENV = 'PI_SUBAGENT_QUESTION_TIMEOUT_MS'

export const DEFAULT_TIMEOUT_MS = 300_000

export interface PromptOption {
    value: string
    label: string
    description?: string
}

export interface PromptQuestion {
    id: string
    prompt: string
    options: readonly PromptOption[]
    allowOther: boolean
}

export interface PromptAnswer {
    id: string
    value: string
    label: string
    wasCustom: boolean
    index?: number
    /** True when the deadline filled this answer from `options[0]`. */
    autoAccepted?: boolean
}

export interface PromptDialogOptions {
    signal?: AbortSignal
    timeout?: number
}

/**
 * Only `input` is driven: it is the one rpc dialog a user can type into (see the
 * note in `askWithDeadline`).
 */
export interface PromptUi {
    input(
        title: string,
        defaultValue?: string,
        opts?: PromptDialogOptions
    ): Promise<string | undefined>
}

export type PromptOutcome =
    | { kind: 'answered'; answers: PromptAnswer[] }
    | { kind: 'cancelled'; answers: PromptAnswer[] }
    | { kind: 'timed-out'; answers: PromptAnswer[] }

function envFlag(raw: string | undefined): boolean {
    return raw !== undefined && raw !== '' && raw !== '0'
}

export function isSubagentOrigin(env: NodeJS.ProcessEnv = process.env): boolean {
    return envFlag(env[SUBAGENT_ENV])
}

/**
 * `undefined` means "no budget": either this is the root agent, or the feature
 * was switched off. Read per prompt so a changed environment takes effect
 * without a reload.
 */
export function subagentQuestionTimeoutMs(
    env: NodeJS.ProcessEnv = process.env
): number | undefined {
    if (!isSubagentOrigin(env)) return undefined
    const raw = env[TIMEOUT_ENV]
    if (raw === undefined) return DEFAULT_TIMEOUT_MS
    const ms = Number(raw)
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

export interface PromptDeadline {
    /** Milliseconds left, floored at 1 so rpc-mode does not read it as "no timeout". */
    remaining(): number
    /** True once the budget is spent, whether or not the timer callback has run yet. */
    elapsed(): boolean
    /** Cancels the timer; idempotent and safe after the timer fired. */
    clear(): void
}

/**
 * The clock check in `elapsed()` matters: rpc-mode honours the `timeout` we pass
 * to a dialog, so a select can resume from its own timer a tick before ours runs.
 * Both paths must read as "timed out".
 */
export function startDeadline(
    timeoutMs: number | undefined,
    onElapsed: () => void
): PromptDeadline | undefined {
    if (timeoutMs === undefined) return undefined
    const fireAt = Date.now() + timeoutMs
    let fired = false
    let cleared = false
    const timer = setTimeout(() => {
        fired = true
        onElapsed()
    }, timeoutMs)
    timer.unref?.()

    return {
        remaining: () => Math.max(1, fireAt - Date.now()),
        elapsed: () => fired || (!cleared && Date.now() >= fireAt),
        clear: () => {
            cleared = true
            clearTimeout(timer)
        },
    }
}

/**
 * Real answers stay untouched (and untagged); every unanswered question gets its
 * first option. A question with no options has no recommended option to accept,
 * so it stays unanswered rather than inventing one.
 */
export function recommendedAnswers(
    questions: readonly PromptQuestion[],
    answers: readonly PromptAnswer[]
): PromptAnswer[] {
    const byId = new Map(answers.map(answer => [answer.id, answer]))
    const merged: PromptAnswer[] = []
    for (const question of questions) {
        const existing = byId.get(question.id)
        if (existing) {
            merged.push(existing)
            continue
        }
        const first = question.options[0]
        if (!first) continue
        merged.push({
            id: question.id,
            value: first.value,
            label: first.label,
            wasCustom: false,
            index: 1,
            autoAccepted: true,
        })
    }
    return merged
}

export function formatDuration(ms: number): string {
    if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`
    if (ms >= 1000) return `${Math.round(ms / 1000)}s`
    return `${Math.round(ms)}ms`
}

/** Dialog text is one line per option, so an embedded newline would break the numbering. */
function singleLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function optionLine(position: number, option: PromptOption): string {
    const label = singleLine(option.label)
    const description = option.description === undefined ? '' : singleLine(option.description)
    return description === ''
        ? `${position}. ${label}`
        : `${position}. ${label} — ${description}`
}

function replyInstruction(question: PromptQuestion): string {
    return question.allowOther
        ? 'Reply with an option number, or type your own answer.'
        : 'Reply with an option number.'
}

/**
 * The rpc card has no body: the title is the whole dialog, so the prompt, the
 * answer instruction and the numbered option list all travel in it.
 */
function questionDialogTitle(question: PromptQuestion): string {
    return [
        question.prompt.trim(),
        '',
        replyInstruction(question),
        '',
        ...question.options.map((option, index) => optionLine(index + 1, option)),
    ].join('\n')
}

/** The reply as a 1-based option position, when it is exactly one existing number. */
function optionPosition(reply: string, question: PromptQuestion): number | undefined {
    if (!/^\d+$/.test(reply)) return undefined
    const position = Number(reply)
    return position >= 1 && position <= question.options.length ? position : undefined
}

/** A number picks an option; anything else is the user's own answer, verbatim. */
function answerFromReply(question: PromptQuestion, reply: string): PromptAnswer {
    const position = optionPosition(reply, question)
    const option = position === undefined ? undefined : question.options[position - 1]
    if (!option) return { id: question.id, value: reply, label: reply, wasCustom: true }
    return {
        id: question.id,
        value: option.value,
        label: option.label,
        wasCustom: false,
        index: position,
    }
}

export interface AskWithDeadlineOptions {
    questions: readonly PromptQuestion[]
    ui: PromptUi
    timeoutMs: number | undefined
    /** The tool-call abort signal: cancels the pending dialog like a user cancel. */
    signal?: AbortSignal
}

/** Abort `target` whenever `source` aborts; returns the detach handle. */
function bridgeAbort(source: AbortSignal | undefined, target: AbortController): () => void {
    if (!source) return () => {}
    if (source.aborted) {
        target.abort()
        return () => {}
    }
    const onAbort = () => target.abort()
    source.addEventListener('abort', onAbort, { once: true })
    return () => source.removeEventListener('abort', onAbort)
}

/**
 * The rpc/print-mode prompt loop, one dialog per question. The timer is
 * prompt-wide: it is started once here and each dialog gets only the time that
 * is left, so a slow first answer eats into the budget instead of extending it.
 */
export async function askWithDeadline(
    options: AskWithDeadlineOptions
): Promise<PromptOutcome> {
    const { questions, ui, timeoutMs, signal } = options
    const answers: PromptAnswer[] = []
    let activeController: AbortController | undefined
    let timedOut = false

    const deadline = startDeadline(timeoutMs, () => activeController?.abort())

    try {
        for (const question of questions) {
            // A run abort outranks the budget: its result is discarded either way.
            if (signal?.aborted) return { kind: 'cancelled', answers }
            if (deadline?.elapsed()) {
                timedOut = true
                break
            }

            // An rpc host paints `ui.select` as option chips with no text field and
            // `ui.input` as a card that can be typed in, so typing a custom answer
            // is only reachable through `input`; the numbers live in its title.
            const controller = new AbortController()
            activeController = controller
            const detach = bridgeAbort(signal, controller)
            let reply: string | undefined
            try {
                reply = await ui.input(questionDialogTitle(question), undefined, {
                    signal: controller.signal,
                    timeout: deadline?.remaining(),
                })
            } finally {
                detach()
                if (activeController === controller) activeController = undefined
            }

            if (signal?.aborted) return { kind: 'cancelled', answers }
            if (deadline?.elapsed()) {
                timedOut = true
                break
            }
            if (reply === undefined) return { kind: 'cancelled', answers }

            const trimmed = reply.trim()
            if (trimmed === '') return { kind: 'cancelled', answers }
            answers.push(answerFromReply(question, trimmed))
        }
    } finally {
        deadline?.clear()
    }

    if (timedOut) {
        return { kind: 'timed-out', answers: recommendedAnswers(questions, answers) }
    }
    return { kind: 'answered', answers }
}
