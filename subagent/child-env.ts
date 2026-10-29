/**
 * The rpc child's environment, built in one place.
 *
 * Subagent identity travels by environment variable, not by a CLI flag: this
 * extension builds the child's argv itself and has no arbitrary-flag hook, so an
 * unregistered `--memory-subagent` would be captured as an unknown option and eat
 * the next argument. The marker itself is read by the agent-memory extension.
 *
 * `spawnChild` is exported so the test exercises the exact options object handed to
 * `spawn`, not a reconstruction of it.
 */

import { type ChildProcess, spawn } from 'node:child_process'

/** Read by `agent-memory/gate/gate.ts` to deny mutations and gated reads. */
export const MEMORY_SUBAGENT_ENV = 'PI_MEMORY_SUBAGENT'

/**
 * A copy, never a mutation: the parent's own marker must not leak into the parent
 * process, and a child spawned from a subagent stays marked either way.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { ...env, [MEMORY_SUBAGENT_ENV]: '1' }
}

/** The single spawn point for rpc children: argv unchanged, env marked. */
export function spawnChild(command: string, args: string[], cwd: string): ChildProcess {
    return spawn(command, args, {
        cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(),
    })
}
