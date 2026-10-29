/**
 * Project identity (§3.2) and `projects.json` (§3.1, §3.4 step 1a).
 *
 * The identity must not depend on where the checkout happens to live: a remote,
 * when there is one, is the only stable name for a repository. A local path is
 * the last resort, and hashes the realpath so a move still produces a new id
 * rather than silently merging two different repositories.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { withRepoLock } from './git.ts'
import { projectsJsonPath } from './paths.ts'

const GIT_TIMEOUT_MS = 10_000
/** Ports that carry no identity: ssh, https, http. */
const DEFAULT_PORTS = new Set(['22', '443', '80'])
/** `slug()` can empty out on a remote whose last segment is all punctuation. */
const FALLBACK_SLUG = 'project'

// ---------------------------------------------------------------------------
// remote normalization
// ---------------------------------------------------------------------------

/**
 * Reduces a remote URL to `host/owner/repo`, or `null` when the remote is a
 * local path. `file://` and bare paths are not remotes: an absolute path in the
 * hash destroys the move-invariance remote-first identity exists for.
 *
 * The whole result is lowercased, not just the host: `Owner/Repo` and
 * `owner/repo` are one repository, and giving it two ids is the exact orphan
 * this function prevents. Documented cost: two case-distinct repos on a
 * case-sensitive self-hosted server collide.
 */
export function normalizeRemote(url: string): string | null {
    let rest = url.trim()
    if (rest === '') return null

    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(rest)
    if (scheme !== null) {
        if (scheme[1].toLowerCase() === 'file') return null
        rest = rest.slice(scheme[0].length)
    } else {
        if (isLocalPath(rest)) return null
        // scp syntax `user@host:owner/repo`. Converted before the authority is
        // parsed, because there is no `//` for the parser to key on.
        const scp = /^([^/:]+):(.*)$/.exec(rest)
        if (scp === null) return null
        rest = `${scp[1]}/${scp[2].replace(/^\/+/, '')}`
    }

    rest = rest.split(/[?#]/)[0]

    const slash = rest.indexOf('/')
    let authority = slash === -1 ? rest : rest.slice(0, slash)
    const tail = slash === -1 ? '' : rest.slice(slash)

    // Credentials (`user:token@`) carry no identity and must not reach the hash.
    const at = authority.lastIndexOf('@')
    if (at !== -1) authority = authority.slice(at + 1)

    const port = /^(.+):(\d+)$/.exec(authority)
    if (port !== null) {
        authority = DEFAULT_PORTS.has(port[2]) ? port[1] : `${port[1]}:${port[2]}`
    }

    rest = `${authority}${tail}`
    rest = rest.replace(/\/{2,}/g, '/')
    rest = rest.replace(/\/+$/, '')
    rest = rest.replace(/\.git$/i, '')
    rest = rest.replace(/\/+$/, '')
    rest = rest.toLowerCase()

    return rest === '' ? null : rest
}

function isLocalPath(value: string): boolean {
    return (
        value === '.' ||
        value === '..' ||
        value.startsWith('/') ||
        value.startsWith('./') ||
        value.startsWith('../') ||
        value.startsWith('~/') ||
        /^[A-Za-z]:[\\/]/.test(value)
    )
}

function lastPathSegment(value: string): string {
    const trimmed = value.replace(/\/+$/, '')
    const slash = trimmed.lastIndexOf('/')
    return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** Lowercase, non-alphanumerics → `-`, collapse runs, trim `-`. */
export function slug(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
}

function hash8(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

export interface ProjectIdentity {
    id: string
    name: string
    /** The normalized remote, or `null` when the identity came from the path. */
    remote: string | null
}

export interface ResolvedProject extends ProjectIdentity {
    /** Realpath of the working-tree root. */
    root: string
}

export function projectId(gitRoot: string): ProjectIdentity {
    const root = realpathOrResolve(gitRoot)
    const normalized = originRemote(root)
    if (normalized !== null) {
        // The name comes from the remote, not the checkout directory: renaming a
        // clone must not rename the project.
        const name = lastPathSegment(normalized)
        return {
            id: `${slug(name) || FALLBACK_SLUG}-${hash8(normalized)}`,
            name,
            remote: normalized,
        }
    }
    const name = path.basename(root) || FALLBACK_SLUG
    return { id: `${slug(name) || FALLBACK_SLUG}-${hash8(root)}`, name, remote: null }
}

function originRemote(gitRoot: string): string | null {
    const raw = gitOutput(gitRoot, ['remote', 'get-url', 'origin'])
    return raw === null ? null : normalizeRemote(raw)
}

function gitOutput(cwd: string, args: string[]): string | null {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    if (result.status !== 0) return null
    const out = (result.stdout ?? '').trim()
    return out === '' ? null : out
}

function realpathOrResolve(target: string): string {
    try {
        return fs.realpathSync(target)
    } catch {
        return path.resolve(target)
    }
}

/** `null` when `cwd` is not inside a work tree, so callers can error per §5.1. */
export function resolveProjectId(cwd: string): ResolvedProject | null {
    const found = findGitRoot(path.resolve(cwd))
    if (found === null) return null
    const root = realpathOrResolve(found)
    return { root, ...projectId(root) }
}

function findGitRoot(start: string): string | null {
    let current = start
    for (;;) {
        // A `.git` file as well as a directory: worktrees and submodules use one.
        if (fs.existsSync(path.join(current, '.git'))) return current
        const parent = path.dirname(current)
        if (parent === current) return null
        current = parent
    }
}

// ---------------------------------------------------------------------------
// projects.json
// ---------------------------------------------------------------------------

export interface ProjectEntry {
    name: string
    path: string
    remote: string | null
}

export interface ProjectRegistration extends ProjectEntry {
    id: string
}

export type ProjectsFile = Record<string, ProjectEntry>

/**
 * Tolerates a missing or hand-corrupted file. It is metadata only — ids are
 * recomputable and names/paths are recoverable from the checkout — so a bad file
 * must not fail every write.
 */
export function readProjects(root: string): ProjectsFile {
    let text: string
    try {
        text = fs.readFileSync(projectsJsonPath(root), 'utf8')
    } catch {
        return {}
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return {}
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const projects: ProjectsFile = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = asEntry(value)
        if (entry !== null) projects[id] = entry
    }
    return projects
}

function asEntry(value: unknown): ProjectEntry | null {
    if (value === null || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    const name = record.name
    const entryPath = record.path
    const remote = record.remote
    if (typeof name !== 'string') return null
    if (typeof entryPath !== 'string') return null
    if (remote === null || remote === undefined) return { name, path: entryPath, remote: null }
    if (typeof remote !== 'string') return null
    return { name, path: entryPath, remote }
}

/**
 * Register a project under the repo lock (§3.4 step 1a). Read-merge-write, never
 * read-replace: two processes registering different projects must both survive,
 * so the file is re-read inside the lock and only this id's entry is replaced.
 */
export function mergeProject(
    root: string,
    registration: ProjectRegistration
): { added: boolean; stored: ProjectEntry } {
    return withRepoLock(root, () => mergeProjectLocked(root, registration))
}

/** For callers already inside `withRepoLock`; the lock is not reentrant. */
export function mergeProjectLocked(
    root: string,
    registration: ProjectRegistration
): { added: boolean; stored: ProjectEntry } {
    const { id, ...stored } = registration
    const projects = readProjects(root)
    const added = projects[id] === undefined
    const changed = added || !sameEntry(projects[id], stored)
    if (changed) {
        projects[id] = stored
        writeProjects(root, projects)
    }
    return { added, stored }
}

function sameEntry(a: ProjectEntry | undefined, b: ProjectEntry): boolean {
    return a !== undefined && a.name === b.name && a.path === b.path && a.remote === b.remote
}

/**
 * `projects.json.tmp` + rename, never an in-place rewrite: a reader must never
 * see a half-written file, and the temp name is gitignored by `*.tmp`.
 */
function writeProjects(root: string, projects: ProjectsFile): void {
    const target = projectsJsonPath(root)
    const tmp = `${target}.tmp`
    const ordered: ProjectsFile = {}
    for (const id of Object.keys(projects).sort()) ordered[id] = projects[id]
    const body = `${JSON.stringify(ordered, null, 2)}\n`
    const fd = fs.openSync(tmp, 'w')
    try {
        fs.writeFileSync(fd, body)
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }
    fs.renameSync(tmp, target)
}
