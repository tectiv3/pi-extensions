/**
 * `registerMemoryTools` — maps §5's definitions onto `pi.registerTool`.
 *
 * Two host facts shape this file:
 *
 * - `registerTool` runs at load time and gets no context, while the **gate needs the
 *   per-call `ExtensionToolContext`** (`hasUI`, `ui.confirm`, the session id). The
 *   tool definitions therefore receive deps built inside `execute`, and the store's
 *   own mutation gate is kept in step through one shared `GateContext` object that the
 *   store captured by reference when it was opened.
 * - A tool result is `{ content, details, isError }`; the definitions return
 *   `{ text, details, isError }`, so `toAgentResult` is the single conversion point.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import type { GateContext } from '../gate/gate.ts'
import type { Access } from '../store/frontmatter.ts'
import type { Scope } from '../store/paths.ts'
import type { Store } from '../store/store.ts'
import {
    type Embedder,
    type MemoryDeps,
    type ToolResult,
    memoryDelete,
    memoryEdit,
    memoryIndex,
    memoryRead,
    memorySearch,
    memoryWrite,
} from './definitions.ts'

export interface RegisterOptions {
    /** U9's embedder; absent → BM25-only search (§12.10). */
    embed?: Embedder
    /**
     * The gate object the store was opened with. Mutated in place before every call so
     * a mutation sees the same UI as the read that preceded it. Omit to build a
     * throwaway one (read-only callers).
     */
    gate?: GateContext
}

/** The six §5 tools, in the order the model should hear about them. */
export const MEMORY_TOOL_NAMES = [
    'memory_index',
    'memory_search',
    'memory_read',
    'memory_write',
    'memory_edit',
    'memory_delete',
] as const

type JsonSchema = Record<string, unknown>

/**
 * Parameters are plain JSON Schema rather than TypeBox builders.
 *
 * The host aliases `typebox` into an extension at load time (`loader.ts:119`), so a
 * static import would work inside pi — but not under this repo's plain `node --test`
 * runner, where the package is deliberately absent because it is a host-provided
 * runtime dependency. The plain form is not a downgrade: `Type.Object` emits exactly
 * `{ type, required, properties }`, and the host has a first-class non-TypeBox path
 * (`ai/src/utils/validation.ts:326`) that coerces and validates it.
 */
function params(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
    return { type: 'object', required, properties }
}

const SCOPE: JsonSchema = {
    type: 'string',
    enum: ['project', 'global'],
    description:
        "'project' or 'global'. Omit to cover both: project notes rank first, global notes remain discoverable, and a read falls back to global when the key is not in the project. A working directory outside a git repository has only global.",
}

const REASON: JsonSchema = {
    type: 'string',
    description:
        'Required for any gated note: the justification shown in the confirmation and written to the access log (max 500 chars).',
}

const KEY: JsonSchema = {
    type: 'string',
    description:
        "Path-like note key, e.g. 'auth/session_handling'. Lowercased and normalised; must stay inside the store.",
}

/**
 * A per-call gate view. `hasUI` is the host's own flag, so `pi -p` and JSON mode deny
 * gated operations locally (§7.3); RPC reports `true`, which is why `PI_MEMORY_SUBAGENT`
 * is checked first inside the gate.
 */
export function sessionGate(ctx: ExtensionContext | undefined): GateContext {
    const ui = ctx?.ui
    return {
        hasUI: ctx?.hasUI === true,
        sessionId: ctx?.sessionManager?.getSessionId?.(),
        ui: {
            confirm: (title: string, message: string) =>
                ui === undefined ? Promise.resolve(false) : ui.confirm(title, message),
        },
    }
}

export function registerMemoryTools(
    pi: ExtensionAPI,
    store: Store,
    options: RegisterOptions = {}
): void {
    const gate: GateContext = options.gate ?? sessionGate(undefined)

    /** Fresh deps per call: `cwd` and the gate belong to the calling context. */
    const depsFor = (ctx: ExtensionContext): MemoryDeps => {
        Object.assign(gate, sessionGate(ctx))
        return { store, gate, cwd: ctx.cwd, embed: options.embed }
    }

    pi.registerTool({
        name: 'memory_index',
        label: 'Memory Index',
        description:
            'List the memory keys in scope with the first line of each note. Gated notes are reported only as a count; ask for one by key with memory_read.',
        // Read-only and independent of everything else in the turn.
        executionMode: 'parallel',
        parameters: params({ scope: SCOPE }, []),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            return toAgentResult(memoryIndex(depsFor(ctx), { scope: params.scope as Scope }))
        },
    })

    pi.registerTool({
        name: 'memory_search',
        label: 'Memory Search',
        description:
            'Search memory notes by keyword and meaning (BM25 + vectors, fused). Gated notes are never returned; use memory_read with the exact key.',
        executionMode: 'parallel',
        parameters: params(
            {
                query: { type: 'string', description: 'What to look for, in words.' },
                scope: SCOPE,
                limit: {
                    type: 'number',
                    minimum: 1,
                    maximum: 50,
                    description:
                        'Maximum results, 1-50. Omit for the default of 10; a value below 1 or above 50 is clamped into range.',
                },
            },
            ['query']
        ),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            return toAgentResult(
                await memorySearch(depsFor(ctx), {
                    query: params.query,
                    scope: params.scope as Scope,
                    limit: params.limit,
                })
            )
        },
    })

    pi.registerTool({
        name: 'memory_read',
        label: 'Memory Read',
        description:
            'Read one memory note by key (without frontmatter). With `scope` omitted a project note wins and a global note of the same key is the fallback. A gated note asks the user first and needs `reason`.',
        executionMode: 'parallel',
        parameters: params({ key: KEY, scope: SCOPE, reason: REASON }, ['key']),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            return toAgentResult(
                await memoryRead(depsFor(ctx), {
                    key: params.key,
                    scope: params.scope as Scope,
                    reason: params.reason,
                })
            )
        },
    })

    pi.registerTool({
        name: 'memory_write',
        label: 'Memory Write',
        description:
            'Create a note or fully replace its body. Returns a unified diff and the new hash. A gated note asks the user first and needs `reason`; `access` is preserved unless passed.',
        // Mutations serialize: two writes in one turn must not race on the repo lock.
        executionMode: 'sequential',
        parameters: params(
            {
                key: KEY,
                body: { type: 'string', description: 'Markdown body, without frontmatter.' },
                scope: SCOPE,
                access: {
                    type: 'string',
                    enum: ['open', 'gated'],
                    description:
                        "'open' or 'gated'. Omitted: preserved on update, 'open' on create.",
                },
                baseHash: {
                    type: 'string',
                    description:
                        'Hash from a previous read/write. Supplied and stale → the write is rejected.',
                },
                reason: REASON,
            },
            ['key', 'body']
        ),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            return toAgentResult(
                await memoryWrite(depsFor(ctx), {
                    key: params.key,
                    body: params.body,
                    scope: params.scope as Scope,
                    access: params.access as Access,
                    baseHash: params.baseHash,
                    reason: params.reason,
                })
            )
        },
    })

    pi.registerTool({
        name: 'memory_edit',
        label: 'Memory Edit',
        description:
            'Replace one exact occurrence of oldText in a note. Rejected when oldText matches more than once, when it touches the frontmatter, or when baseHash is stale — re-read first.',
        executionMode: 'sequential',
        parameters: params(
            {
                key: KEY,
                oldText: {
                    type: 'string',
                    description: 'Exact text to replace; must match once.',
                },
                newText: { type: 'string', description: 'Replacement text.' },
                baseHash: { type: 'string', description: 'Hash of the file as last read.' },
                scope: SCOPE,
                reason: REASON,
            },
            ['key', 'oldText', 'newText', 'baseHash']
        ),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            return toAgentResult(
                await memoryEdit(depsFor(ctx), {
                    key: params.key,
                    oldText: params.oldText,
                    newText: params.newText,
                    baseHash: params.baseHash,
                    scope: params.scope as Scope,
                    reason: params.reason,
                })
            )
        },
    })

    pi.registerTool({
        name: 'memory_delete',
        label: 'Memory Delete',
        description:
            'Delete a note file and its index rows. The file stays in git history. A gated note asks the user first and needs `reason`.',
        executionMode: 'sequential',
        parameters: params({ key: KEY, scope: SCOPE, reason: REASON }, ['key']),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            return toAgentResult(
                await memoryDelete(depsFor(ctx), {
                    key: params.key,
                    scope: params.scope as Scope,
                    reason: params.reason,
                })
            )
        },
    })
}

function toAgentResult(result: ToolResult): {
    content: Array<{ type: string; text: string }>
    details?: unknown
    isError?: boolean
} {
    return {
        content: [{ type: 'text', text: result.text }],
        ...(result.details === undefined ? {} : { details: result.details }),
        ...(result.isError === true ? { isError: true } : {}),
    }
}
