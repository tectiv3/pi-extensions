/**
 * Store layout (§3.1). Pure path arithmetic plus the one env/home read that
 * decides the root; no filesystem access, so every caller can compute a path
 * without creating anything first.
 */

import * as os from 'node:os'
import * as path from 'node:path'

export type Scope = 'global' | 'project'

/** `PI_MEMORY_DIR` exists so tests and side-by-side stores never touch the real one. */
export function storeRoot(): string {
    const override = process.env.PI_MEMORY_DIR
    if (override && override.trim() !== '') return path.resolve(override)
    return path.join(os.homedir(), '.pi', 'memory')
}

export function scopeDir(root: string, scope: Scope, project = ''): string {
    if (scope === 'global') return path.join(root, 'global')
    if (project === '') throw new Error('scopeDir: project scope requires a project id')
    return path.join(root, 'projects', project)
}

export function gitignorePath(root: string): string {
    return path.join(root, '.gitignore')
}

export function repoLockPath(root: string): string {
    return path.join(root, '.git', 'pi-memory.lock')
}

export function indexPath(root: string): string {
    return path.join(root, 'index.db')
}

/**
 * The database plus the sidecars SQLite keeps next to it. A downgrade deletes all
 * three (§11): a surviving `-wal` is replayed over whatever file is created next,
 * which is the failure §4 measured for the `index.db.new` + rename approach.
 */
export function indexPathSidecars(root: string): string[] {
    const base = indexPath(root)
    return [base, `${base}-wal`, `${base}-shm`]
}

/** Guards delete-and-recreate of the index; the repo lock does not cover it (§11). */
export function indexLockPath(root: string): string {
    return `${indexPath(root)}.lock`
}

export function accessLogPath(root: string): string {
    return path.join(root, 'access.log')
}

/** The single rotated generation (§7.2): older than `accessLogPath`, read first. */
export function accessLogRotatedPath(root: string): string {
    return path.join(root, 'access.log.1')
}

export function accessLogLockPath(root: string): string {
    return path.join(root, 'access.log.lock')
}

export function projectsJsonPath(root: string): string {
    return path.join(root, 'projects.json')
}
