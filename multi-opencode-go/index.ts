/**
 * Multi opencode-go — manual failover switch for the `opencode-go` provider.
 *
 * Pi reads the primary key from `auth.json["opencode-go"]`. This extension
 * leaves that entry alone and, only while failover is on, overrides the
 * outgoing auth headers with a second key from
 * `auth.json["opencode-go-failover"]`. The switch is manual: there is no usage
 * polling, cooldown, or automatic rotation.
 *
 * No runtime imports beyond node builtins and the type-only host import, so
 * `index.test.ts` runs under `node --test --experimental-strip-types` without
 * the host package on disk.
 */

import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

const PROVIDER = 'opencode-go'
const AUTH_KEY = 'opencode-go-failover'
const STATE_FILE = 'opencode-go-active.json'
const LOG_FILE = 'multi-opencode-go.log'

export interface FailoverAccount {
    label: string
    key: string
}

function expandTilde(value: string): string {
    if (value === '~') return homedir()
    if (value.startsWith('~/')) return join(homedir(), value.slice(2))
    return value
}

/**
 * Local copy of the host's `getAgentDir`. The host package is not a runtime
 * dependency here, and importing it would break standalone test execution.
 * Limitation: a custom `configDir` baked into the host package is not honored —
 * only `PI_CODING_AGENT_DIR` and the `.pi` default are.
 */
export function getAgentDir(): string {
    const envDir = process.env.PI_CODING_AGENT_DIR
    if (envDir) return expandTilde(envDir)
    return join(homedir(), '.pi', 'agent')
}

export function getLogFilePath(): string {
    return join(getAgentDir(), LOG_FILE)
}

// Best-effort: logging must never break a request or a command.
function appendLog(message: string): void {
    try {
        appendFileSync(getLogFilePath(), `${new Date().toISOString()} ${message}\n`)
    } catch {
        // ignore
    }
}

/**
 * Whole-string `$NAME` or literal only. `$$x` escapes to a literal `$x`.
 * `${VAR}`, embedded `$`, and `!command` are rejected rather than passed
 * through, so a misconfigured value can never become a garbage header.
 */
export function resolveAuthValue(value: unknown): string | undefined {
    if (typeof value !== 'string' || value === '') return undefined
    if (value.startsWith('!')) return undefined
    if (value.startsWith('$$')) return value.slice(1)
    if (value.startsWith('$')) {
        const name = value.slice(1)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined
        // Empty env lookups count as unset, matching the host resolver.
        return process.env[name] || undefined
    }
    return value.includes('$') ? undefined : value
}

export function loadFailoverAccount(): FailoverAccount | null {
    let auth: unknown
    try {
        auth = JSON.parse(readFileSync(join(getAgentDir(), 'auth.json'), 'utf8'))
    } catch {
        return null
    }
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null

    const block = (auth as Record<string, unknown>)[AUTH_KEY]
    if (!block || typeof block !== 'object' || Array.isArray(block)) return null

    const record = block as Record<string, unknown>
    const rawKey = record.key
    const key = resolveAuthValue(rawKey)
    if (key === undefined) {
        if (rawKey !== undefined) {
            appendLog(`failover key rejected for ${AUTH_KEY}`)
        }
        return null
    }

    const label =
        typeof record.label === 'string' && record.label !== '' ? record.label : 'failover'
    return { label, key }
}

export function loadFailoverOn(): boolean {
    try {
        const state = JSON.parse(readFileSync(join(getAgentDir(), STATE_FILE), 'utf8'))
        return state?.failover === true
    } catch {
        return false
    }
}

export function saveFailoverOn(on: boolean): void {
    const path = join(getAgentDir(), STATE_FILE)
    try {
        writeFileSync(path, JSON.stringify({ failover: on }), { mode: 0o600 })
        // `mode` only applies at creation; enforce it on rewrites too.
        chmodSync(path, 0o600)
    } catch {
        // Best-effort persistence.
    }
}

export default function multiOpencodeGo(pi: ExtensionAPI): void {
    // Closure-scoped so each extension invocation owns its state (tests are
    // isolated and multiple installs cannot share a toggle).
    let failover: FailoverAccount | null = null
    let failoverOn = false

    // Print mode and no-UI hosts never want the footer line, so do not assume
    // the host no-ops setStatus for them.
    function publishStatus(ctx: ExtensionContext): void {
        if (ctx.hasUI === false || ctx.mode === 'print') return
        try {
            ctx.ui.setStatus?.('multi-opencode-go', failoverOn && failover ? '⇄' : undefined)
        } catch {
            // Footer status is best-effort; never break session or command paths.
        }
    }

    pi.on('session_start', (_event, ctx) => {
        failover = loadFailoverAccount()
        failoverOn = loadFailoverOn() && failover !== null
        publishStatus(ctx)
        if (failoverOn && failover) {
            ctx.ui.notify(`opencode-go: failover active (${failover.label})`, 'info')
        }
    })

    pi.on('session_shutdown', (_event, ctx) => {
        try {
            ctx.ui.setStatus?.('multi-opencode-go', undefined)
        } catch {
            // Best-effort teardown.
        }
    })

    pi.on('before_provider_headers', (event, ctx) => {
        if (ctx.model?.provider !== PROVIDER) return
        if (!failoverOn || !failover) return
        event.headers.Authorization = `Bearer ${failover.key}`
        event.headers['x-api-key'] = failover.key
    })

    pi.registerCommand('opencode-switch', {
        description: 'Toggle opencode-go between the primary and failover key',
        handler: async (args, ctx) => {
            const account = loadFailoverAccount()
            if (!account) {
                ctx.ui.notify('No opencode-go failover account configured', 'warning')
                return
            }

            const arg = args.trim().toLowerCase()
            let next: boolean
            if (arg === '') {
                next = !failoverOn
            } else if (arg === 'on' || arg === 'failover') {
                next = true
            } else if (arg === 'off' || arg === 'primary') {
                next = false
            } else {
                ctx.ui.notify('Usage: /opencode-switch [on|off]', 'warning')
                return
            }

            // Re-read so an auth.json edit made mid-session is picked up.
            failover = account
            failoverOn = next
            saveFailoverOn(failoverOn)
            publishStatus(ctx)

            const message = failoverOn
                ? `opencode-go: using failover (${account.label})`
                : 'opencode-go: using primary'
            appendLog(message)
            ctx.ui.notify(message, 'info')
        },
    })
}
