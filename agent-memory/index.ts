/**
 * The agent-memory extension entry point: open the store, keep it in step with disk,
 * hand §5's tools to the host, and install §6's two injection hooks.
 *
 * Registration of the **tools** happens in `session_start`, not at load, for one
 * reason: the spec requires that a store that cannot be created registers nothing
 * rather than leaving six tools that fail on every call. `registerTool` after load is
 * supported (`loader.ts:303` refreshes the tool registry), and a session whose store
 * failed simply has no memory tools.
 *
 * The **hooks** (`before_agent_start`, `context`) are installed at load and read the
 * store through a getter. `session_start` fires again for every new, resumed or
 * reloaded session, and a hook registered per session would stack: `on` appends
 * handlers, so the block would be injected twice after the second session start.
 *
 * §6.1's block is computed once per session and cached (`inject/index-block.ts`):
 * re-reading the store per turn would invalidate the provider's prompt cache every
 * message. The cached string is re-inserted on every `before_agent_start` because the
 * host normalizes a fresh options object per run (`runner.ts:1431`).
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { registerMemoryCommands } from './commands/index.ts'
import { createEmbedder, embedBatch as runEmbedBatch, embedderAvailable } from './embed/cli.ts'
import {
    backfill,
    createEmbedWorker,
    type EmbedBatch,
    type EmbedWorker,
} from './embed/worker.ts'
import { type GateContext, isSubagent } from './gate/gate.ts'
import { rotateIfNeeded } from './gate/log.ts'
import {
    cacheIndexBlock,
    clearIndexBlockCache,
    getCachedIndexBlock,
} from './inject/index-block.ts'
import { installMentionHook } from './inject/mention.ts'
import { installIndexSection } from './inject/system-prompt.ts'
import { openStore, type Store } from './store/store.ts'
import type { Embedder } from './tools/definitions.ts'
import { registerMemoryTools, sessionGate } from './tools/register.ts'

export interface AgentMemoryOptions {
    /** U9's embedder seam; absent → BM25-only search. */
    embed?: Embedder
}

/**
 * The object the entry-point test reads. The cached block lives in
 * `inject/index-block.ts` so the hooks and this handle agree by construction.
 */
export interface AgentMemoryHandle {
    /** The §6.1 block for the current session, `''` before `session_start`. */
    indexBlock(): string
    store(): Store | undefined
}

interface SessionStartEvent {
    reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork'
}

export default function agentMemoryExtension(
    pi: ExtensionAPI,
    options: AgentMemoryOptions = {}
): AgentMemoryHandle {
    let store: Store | undefined
    let worker: EmbedWorker | undefined
    const warnings = new Set<string>()
    /**
     * One gate per session, shared by reference with the store: the store captured it
     * when it was opened, and `registerMemoryTools` refreshes it from each call's
     * context so a mutation sees the same UI as the read before it.
     */
    const gate: GateContext = sessionGate(undefined)

    const warn = (key: string, text: string): void => {
        // Once per condition: a failing store would otherwise log on every session start.
        if (warnings.has(key)) return
        warnings.add(key)
        console.warn(`agent-memory: ${text}`)
    }

    // Keyed by text, not a single 'embed' key: §8.2's mismatch warning must reach the
    // user once per distinct condition, not once per process.
    const embedOptions = { onWarning: (text: string) => warn(`embed:${text}`, text) }
    // Injected embedders are single-text (the tool seam); the worker still receives a
    // batch function, so a test double keeps the worker's one-call-per-batch contract.
    const embed: Embedder = options.embed ?? createEmbedder(embedOptions)
    const embedBatch: EmbedBatch =
        options.embed === undefined
            ? texts => runEmbedBatch(texts, embedOptions)
            : texts => Promise.all(texts.map(text => options.embed?.(text) ?? null))

    installIndexSection(pi, getCachedIndexBlock)
    installMentionHook(pi, () => store, { embed: options.embed })
    // Registered at load: `registerCommand` is a load-time API, and the getter keeps a
    // command invoked before `session_start` from creating a store behind the hooks' back.
    registerMemoryCommands(pi, () => store, { embed, gate })

    pi.on('session_start', async (event: SessionStartEvent, ctx: ExtensionContext) => {
        // A reload re-runs `session_start` in the same process; the previous worker
        // holds the previous (about-to-close) handle, so it is stopped and drained
        // under the same 2 s bound as shutdown (§8.1).
        await worker?.stop()
        worker = undefined
        try {
            store?.close()
            store = undefined
            clearIndexBlockCache()

            Object.assign(gate, sessionGate(ctx))
            const opened = openStore(ctx.cwd, {
                gate,
                // §3.4 step 7: fire-and-forget. The closure reads the live worker, which
                // is created below because it needs the opened store's handle.
                enqueueEmbed: job => worker?.enqueue(job),
            })

            // §3.3/§7.2: `reload` re-runs session_start in the same process; the sweep
            // and rotation already ran for this session's store.
            if (event?.reason !== 'reload') {
                // A subagent that cannot take the repo lock logs and skips the sweep
                // rather than failing its own startup (§3.3), so neither step may
                // abort the session.
                try {
                    opened.sweep()
                } catch (err) {
                    warn('sweep', `startup sweep skipped: ${message(err)}`)
                }
                try {
                    rotateIfNeeded(opened.root)
                } catch (err) {
                    warn('rotate', `access log rotation skipped: ${message(err)}`)
                }
            }

            // Hand edits and crashed writes are the authoritative source (§3.3); the
            // pass is per-file and skips unchanged notes.
            try {
                opened.reindex()
            } catch (err) {
                warn('reindex', `reindex failed: ${message(err)}`)
            }

            // Cached before the hooks can run: `before_agent_start` reads this getter
            // and `context` resolves its scope from the same cwd.
            cacheIndexBlock({ store: opened, cwd: ctx.cwd })
            store = opened
            registerMemoryTools(pi, opened, { embed: options.embed, gate })

            // §8.1: a subagent has no write path and enqueues nothing, so it pays for
            // neither the probe nor the drain. Its memory_read is the whole surface.
            if (!isSubagent()) {
                worker = createEmbedWorker({
                    store: opened,
                    embed: embedBatch,
                    // The probe describes the bundled CLI only. An injected embedder
                    // is its own availability source; probing a binary it never uses
                    // would disable it on a machine that simply has no `nle-embed`.
                    available:
                        options.embed === undefined
                            ? () => embedderAvailable(embedOptions)
                            : () => true,
                    onWarning: embedOptions.onWarning,
                })
                // §4's predicate: whatever the previous session left unembedded (a
                // drained shutdown, a missing binary) is re-enqueued here.
                try {
                    backfill(opened, worker)
                } catch (err) {
                    warn('backfill', `embedding backfill skipped: ${message(err)}`)
                }
            }
        } catch (err) {
            store?.close()
            store = undefined
            clearIndexBlockCache()
            warn('open', `memory store unavailable, tools not registered: ${message(err)}`)
        }
    })

    pi.on('session_shutdown', async () => {
        // §8.1: the host awaits shutdown handlers with **no** timeout, so the bound is
        // ours. Undrained jobs are not lost: §4's predicate re-enqueues them next session.
        await worker?.stop(2_000)
        worker = undefined
        store?.close()
        store = undefined
        clearIndexBlockCache()
    })

    return {
        indexBlock: () => getCachedIndexBlock(),
        store: () => store,
    }
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
