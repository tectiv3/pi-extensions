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

/**
 * The rpc path's `allowOther` row label. It is both displayed and matched against
 * the answer, so it must be a single constant (the TUI uses its own internal row).
 */
export const TYPE_SOMETHING_LABEL = 'Type something...'

export interface PromptOption {
    value: string
    label: string
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

export interface PromptUi {
    select(
        title: string,
        options: string[],
        opts?: PromptDialogOptions
    ): Promise<string | undefined>
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

            const optionLabels = question.options.map(option => option.label)
            if (question.allowOther) optionLabels.push(TYPE_SOMETHING_LABEL)

            const controller = new AbortController()
            activeController = controller
            const detach = bridgeAbort(signal, controller)
            let selected: string | undefined
            try {
                selected = await ui.select(question.prompt, optionLabels, {
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
            if (selected === undefined) return { kind: 'cancelled', answers }

            if (question.allowOther && selected === TYPE_SOMETHING_LABEL) {
                const inputController = new AbortController()
                activeController = inputController
                const detachInput = bridgeAbort(signal, inputController)
                let typed: string | undefined
                try {
                    typed = await ui.input(question.prompt, undefined, {
                        signal: inputController.signal,
                        timeout: deadline?.remaining(),
                    })
                } finally {
                    detachInput()
                    if (activeController === inputController) activeController = undefined
                }

                if (signal?.aborted) return { kind: 'cancelled', answers }
                if (deadline?.elapsed()) {
                    timedOut = true
                    break
                }
                if (typed === undefined) return { kind: 'cancelled', answers }
                answers.push({
                    id: question.id,
                    value: typed,
                    label: typed,
                    wasCustom: true,
                })
                continue
            }

            const matched = question.options.find(option => option.label === selected)
            const matchedIndex = question.options.findIndex(
                option => option.label === selected
            )
            answers.push({
                id: question.id,
                value: matched?.value ?? selected,
                label: selected,
                wasCustom: false,
                index: matchedIndex >= 0 ? matchedIndex + 1 : undefined,
            })
        }
    } finally {
        deadline?.clear()
    }

    if (timedOut) {
        return { kind: 'timed-out', answers: recommendedAnswers(questions, answers) }
    }
    return { kind: 'answered', answers }
}
