/**
 * The gate (§7): every gated operation is confirmed once, and every attempt is
 * logged as a `pending` line plus a resolver sharing a 16-hex id.
 *
 * `GateContext` is a structural slice of pi's `ExtensionContext` rather than the
 * host type: the decision table (subagent → no UI → confirm) is the part that
 * must be testable without a running pi, so importing host types here would make
 * the rules unverifiable in isolation.
 */

import type { Scope } from '../store/paths.ts'
import {
    appendLog,
    type LogDecision,
    type LogOp,
    type LogResult,
    newAttemptId,
} from './log.ts'

export interface GateContext {
    hasUI: boolean
    ui: {
        confirm(title: string, message: string): Promise<boolean>
    }
    sessionId?: string
}

export interface GateRequest {
    /** The store root; logging needs it and it is not part of pi's context. */
    root: string
    op: LogOp
    scope?: Scope
    project?: string
    key: string
    /** §5's required justification, logged (capped at 500 chars). */
    reason: string
    /**
     * The first ~200 chars of the body, shown in the confirmation and **never**
     * logged: it is gated content.
     */
    preview: string
}

export type GateDenialCode = 'blocked-subagent' | 'denied-no-ui' | 'declined' | 'error'

export type GateResult =
    { allowed: true; attempt: string } | { allowed: false; code: GateDenialCode }

const PREVIEW_CHARS = 200

export function isSubagent(): boolean {
    return process.env.PI_MEMORY_SUBAGENT === '1'
}

/**
 * The single entry point for a gated operation.
 *
 * A gated operation fails closed when `PI_MEMORY_SUBAGENT` is set or `hasUI` is
 * false (§7.3). The subagent check runs **first on purpose**: `hasUI` is `true`
 * in RPC mode, so a subagent would otherwise be routed into the parent's
 * confirmation and a backgrounded run could block indefinitely (§5.3).
 *
 * Approval is per operation, never cached: the caller gets an attempt id and must
 * resolve it (see `resolveAttempt`) in a `finally` so a mutation that fails after
 * approval reports `failed:<class>` rather than an unexplained `approved`.
 */
export async function requestGatedAccess(
    ctx: GateContext,
    req: GateRequest
): Promise<GateResult> {
    const attempt = newAttemptId()
    appendLog(req.root, {
        attempt,
        op: req.op,
        initiator: 'agent',
        decision: 'pending',
        scope: req.scope,
        project: req.project,
        key: req.key,
        session: ctx.sessionId,
        reason: req.reason,
    })

    if (isSubagent()) return deny(req.root, attempt, 'blocked-subagent')
    if (!ctx.hasUI) return deny(req.root, attempt, 'denied-no-ui')

    let approved: boolean
    try {
        approved = await ctx.ui.confirm(confirmTitle(req), confirmMessage(req))
    } catch {
        // A rejecting confirm is not a decline: `error` records that no decision
        // was made, which `declined` would misstate (§7.1).
        resolveAttempt(req.root, attempt, 'error')
        return { allowed: false, code: 'error' }
    }

    if (!approved) {
        resolveAttempt(req.root, attempt, 'declined')
        return { allowed: false, code: 'declined' }
    }

    resolveAttempt(req.root, attempt, 'approved', 'ok')
    return { allowed: true, attempt }
}

/** The resolver line. Safe (and intended) to call from a `finally`. */
export function resolveAttempt(
    root: string,
    attempt: string,
    decision: Exclude<LogDecision, 'pending'>,
    result?: LogResult
): void {
    appendLog(root, { attempt, decision, result })
}

export interface UserAccess {
    op: LogOp
    scope?: Scope
    project?: string
    key: string
    session?: string
}

/**
 * User-initiated access (`/memory show`, §10) logs **one** line: nobody approved
 * their own keystroke, so `pending`/`approved` would record a decision that never
 * happened, and `reason` has no meaning for the user's own action.
 */
export function logUserAccess(root: string, access: UserAccess): void {
    appendLog(root, {
        attempt: newAttemptId(),
        op: access.op,
        initiator: 'user',
        decision: 'user',
        result: 'ok',
        scope: access.scope,
        project: access.project,
        key: access.key,
        session: access.session,
    })
}

/** The exact §7.3 fail-closed error string. */
export function failClosedMessage(key: string): string {
    return `gated note '${key}'; no UI available to confirm — use /memory show`
}

function deny(root: string, attempt: string, code: GateDenialCode): GateResult {
    resolveAttempt(root, attempt, code)
    return { allowed: false, code }
}

function confirmTitle(req: GateRequest): string {
    return `memory: confirm ${req.op} of gated note '${req.key}'`
}

function confirmMessage(req: GateRequest): string {
    const where =
        req.scope === 'project' && req.project !== undefined
            ? `project ${req.project}`
            : 'global'
    return [
        `Gated note: ${req.key} (${where})`,
        `Operation: ${req.op}`,
        `Reason: ${req.reason}`,
        '',
        `Preview (first ${PREVIEW_CHARS} chars):`,
        previewOf(req.preview),
    ].join('\n')
}

function previewOf(body: string): string {
    const text = body.trim()
    return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`
}
