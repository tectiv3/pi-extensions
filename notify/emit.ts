/**
 * Terminal desktop notifications via OSC escape sequences.
 *
 * Pure helpers: no I/O happens outside `emitNotification`, so the formatting
 * rules are testable without a terminal.
 */

export type NotificationBackend = 'osc777' | 'osc9' | 'none'

export interface NotificationContent {
    title: string
    body: string
    tmux: boolean
}

export interface NotificationStdout {
    write(chunk: string): unknown
    isTTY?: boolean
}

export interface EmitNotificationOptions {
    env?: NodeJS.ProcessEnv
    stdout?: NotificationStdout
    isTTY?: boolean
}

// TERM_PROGRAM values with documented OSC 9 notification support. Terminals not
// listed here are not written to at all, so CI logs and dumb terminals stay clean;
// PI_NOTIFY_BACKEND covers any other OSC 9 capable terminal by hand.
const OSC9_TERMINALS = new Set(['iTerm.app', 'WezTerm'])

const EXPLICIT_BACKENDS = new Set<string>(['osc777', 'osc9', 'none'])

const TITLE_LIMIT = 80
const BODY_LIMIT = 200

export function resolveBackend(env: NodeJS.ProcessEnv): NotificationBackend {
    const override = env.PI_NOTIFY_BACKEND
    if (override !== undefined && EXPLICIT_BACKENDS.has(override)) {
        return override as NotificationBackend
    }
    if (env.TERM_PROGRAM === 'ghostty') return 'osc777'
    if (env.TERM_PROGRAM !== undefined && OSC9_TERMINALS.has(env.TERM_PROGRAM)) {
        return 'osc9'
    }
    return 'none'
}

// Control characters become spaces rather than being deleted so that
// "line one\nline two" does not collapse into "line oneline two".
// (A loop instead of /[\x00-\x1f\x7f]/ because eslint's no-control-regex
// rejects control characters in patterns.)
function stripControls(text: string): string {
    let stripped = ''
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0
        stripped += code <= 0x1f || code === 0x7f ? ' ' : char
    }
    return stripped
}

function sanitize(text: string, limit: number): string {
    const cleaned = stripControls(text).replace(/\s+/g, ' ').trim()
    if (cleaned.length <= limit) return cleaned
    return `${cleaned.slice(0, limit).trimEnd()}…`
}

// tmux swallows unknown OSC sequences unless they arrive as a DCS
// passthrough, where every inner ESC must be doubled.
function wrapTmux(sequence: string): string {
    return `\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`
}

export function formatNotification(
    backend: NotificationBackend,
    content: NotificationContent
): string | undefined {
    if (backend === 'none') return undefined

    const title = sanitize(content.title, TITLE_LIMIT)
    const body = sanitize(content.body, BODY_LIMIT)

    let sequence: string
    if (backend === 'osc777') {
        // Ghostty splits OSC 777 on the second `;`, so the title cannot contain
        // one; the body is the last field and may.
        sequence = `\x1b]777;notify;${title.replaceAll(';', ',')};${body}\x07`
    } else {
        const text = body ? `${title}: ${body}` : title
        sequence = `\x1b]9;${text}\x07`
    }

    return content.tmux ? wrapTmux(sequence) : sequence
}

export function emitNotification(
    input: { title: string; body?: string },
    options: EmitNotificationOptions = {}
): void {
    const env = options.env ?? process.env
    if (env.PI_NOTIFY === '0') return

    const stdout = options.stdout ?? process.stdout
    if (!(options.isTTY ?? stdout.isTTY)) return

    const sequence = formatNotification(resolveBackend(env), {
        title: input.title,
        body: input.body ?? '',
        tmux: Boolean(env.TMUX),
    })
    // One write keeps the zero-width sequence atomic between pi's TUI frames.
    if (sequence !== undefined) stdout.write(sequence)
}
