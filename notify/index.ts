/**
 * Desktop notifications when pi settles, errors, or waits on the user.
 *
 * Every emission is gated on `ctx.mode === "tui"`: print/JSON/RPC sessions must
 * never receive terminal escape sequences.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { emitNotification, resolveBackend } from './emit.ts'

interface AttentionPayload {
    title: string
    body?: string
}

interface RunOutcome {
    error: boolean
    message?: string
}

interface NotificationContext {
    mode: string
}

interface CommandContext extends NotificationContext {
    ui: { notify(message: string, severity: string): void }
}

// ask-user-question publishes this immediately before opening its dialog.
const ATTENTION_CHANNEL = 'notify:attention'
const ATTENTION_TTL_MS = 5_000
// A dialog that closes immediately (validation, a remote answer) is not worth a
// desktop notification.
const PROMPT_GRACE_MS = 150

function firstLine(text: string | undefined): string {
    if (!text) return ''
    return text.split(/\r?\n/)[0].trim()
}

function parseAttention(data: unknown): AttentionPayload | undefined {
    if (typeof data !== 'object' || data === null) return undefined
    const { title, body } = data as { title?: unknown; body?: unknown }
    if (typeof title !== 'string' || title.trim() === '') return undefined
    return typeof body === 'string' ? { title, body } : { title }
}

function genericPromptBody(event: { kind?: string; title?: string }): string {
    const generic = `Waiting for your input (${event.kind ?? 'input'})`
    const title = event.title?.trim()
    return title ? `${title} — ${generic}` : generic
}

export default function notifyExtension(pi: ExtensionAPI) {
    let enabled = true
    let outcome: RunOutcome = { error: false }
    let attention: { payload: AttentionPayload; expiresAt: number } | undefined
    let promptActive = false
    let promptToken: object | undefined

    const sessionTitle = (): string => {
        const name = pi.getSessionName()?.trim()
        return name ? `pi · ${name}` : 'pi'
    }

    const notify = (ctx: NotificationContext, title: string, body?: string): void => {
        if (!enabled) return
        if (ctx.mode !== 'tui') return
        emitNotification({ title, body })
    }

    const takeAttention = (): AttentionPayload | undefined => {
        const current = attention
        attention = undefined
        if (!current || Date.now() > current.expiresAt) return undefined
        return current.payload
    }

    const statusLine = (): string => {
        const backend = resolveBackend(process.env)
        const state =
            process.env.PI_NOTIFY === '0' ? 'disabled (PI_NOTIFY=0)' : enabled ? 'on' : 'off'
        return `notifications ${state}; backend: ${backend}`
    }

    const sendTest = (ctx: CommandContext): void => {
        if (ctx.mode !== 'tui') {
            ctx.ui.notify('notifications require the TUI', 'warning')
            return
        }
        if (process.env.PI_NOTIFY === '0') {
            ctx.ui.notify('notifications are hard-disabled by PI_NOTIFY=0', 'warning')
            return
        }
        if (!enabled) {
            ctx.ui.notify('notifications are off; run /notify on', 'warning')
            return
        }
        const backend = resolveBackend(process.env)
        if (backend === 'none') {
            ctx.ui.notify(
                'no supported terminal detected; set PI_NOTIFY_BACKEND to override',
                'warning'
            )
            return
        }
        emitNotification({ title: sessionTitle(), body: 'Test notification' })
        ctx.ui.notify(`test notification sent via ${backend}`, 'info')
    }

    pi.events.on(ATTENTION_CHANNEL, data => {
        const payload = parseAttention(data)
        if (payload) attention = { payload, expiresAt: Date.now() + ATTENTION_TTL_MS }
    })

    pi.on('agent_start', () => {
        outcome = { error: false }
    })

    pi.on('message_end', event => {
        const message = event?.message
        if (message?.role !== 'assistant') return
        if (message.stopReason === 'error') {
            outcome = { error: true, message: firstLine(message.errorMessage) || 'Error' }
        } else {
            outcome = { error: false }
        }
    })

    pi.on('agent_settled', (event, ctx) => {
        if (event?.aborted) return
        const body = outcome.error ? `Error: ${outcome.message ?? 'Error'}` : 'Done'
        outcome = { error: false }
        notify(ctx, sessionTitle(), body)
    })

    pi.on('ui_prompt_start', (event, ctx) => {
        if (promptActive) return
        promptActive = true
        const token = {}
        promptToken = token

        const pending = takeAttention()
        const title = pending ? `pi · ${pending.title}` : sessionTitle()
        const body = pending?.body ?? genericPromptBody(event)

        setTimeout(() => {
            if (promptToken !== token) return
            promptToken = undefined
            try {
                notify(ctx, title, body)
            } catch {
                // The session can shut down between the prompt start and this timer.
            }
        }, PROMPT_GRACE_MS)
    })

    pi.on('ui_prompt_end', () => {
        promptActive = false
        promptToken = undefined
    })

    pi.registerCommand('notify', {
        description: 'Desktop notifications: on | off | test | status',
        handler: async (args, ctx) => {
            const subcommand = (args.trim().split(/\s+/)[0] || 'status').toLowerCase()
            switch (subcommand) {
                case 'on':
                    enabled = true
                    ctx.ui.notify(statusLine(), 'info')
                    return
                case 'off':
                    enabled = false
                    ctx.ui.notify(statusLine(), 'info')
                    return
                case 'test':
                    sendTest(ctx)
                    return
                case 'status':
                default:
                    ctx.ui.notify(statusLine(), 'info')
            }
        },
    })
}
