/**
 * Key normalization (§2.2) and the filesystem path a key resolves to.
 *
 * `normalizeKey` is steps 1–5 and is deliberately filesystem-free: validation is
 * decidable from the string alone, so callers can reject a key before creating
 * anything. Step 6 (symlinks) needs the scope root, so it lives in
 * `resolveKeyPath`, which normalizes first and then refuses a target that is a
 * symlink or sits under one.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const SEGMENT_CHARS = /^[a-z0-9_.-]+$/

export class InvalidKeyError extends Error {
    readonly raw: string
    readonly normalized: string
    /** The offending path segment, when the rule has one. */
    readonly segment: string | undefined

    constructor(raw: string, normalized: string, reason: string, segment?: string) {
        const where = segment === undefined ? '' : ` (segment "${segment}")`
        super(`invalid memory key "${raw}": ${reason}${where}`)
        this.name = 'InvalidKeyError'
        this.raw = raw
        this.normalized = normalized
        this.segment = segment
    }
}

/**
 * The only way a key enters the system. Order is load-bearing: validation runs on
 * the lowercased form, because APFS makes `Auth/Session` and `auth/session` one
 * file while an un-normalized store would give them two rows.
 */
export function normalizeKey(raw: string): string {
    let key = raw.normalize('NFC')
    if (key.endsWith('.md')) key = key.slice(0, -'.md'.length)
    key = key.replace(/\/{2,}/g, '/')
    key = key.toLowerCase()
    validateKey(raw, key)
    return key
}

function validateKey(raw: string, key: string): void {
    if (key === '') throw new InvalidKeyError(raw, key, 'key is empty')
    if (key.startsWith('/')) {
        throw new InvalidKeyError(raw, key, 'key must be relative to its scope', '')
    }
    for (const segment of key.split('/')) {
        if (segment === '') {
            throw new InvalidKeyError(raw, key, 'empty path segment', segment)
        }
        if (segment === '..') {
            throw new InvalidKeyError(raw, key, 'parent traversal is not allowed', segment)
        }
        if (segment === '.') {
            throw new InvalidKeyError(
                raw,
                key,
                'current-directory segment is not allowed',
                segment
            )
        }
        if (segment.startsWith('.')) {
            throw new InvalidKeyError(raw, key, 'hidden segment is not allowed', segment)
        }
        if (!SEGMENT_CHARS.test(segment)) {
            throw new InvalidKeyError(
                raw,
                key,
                'only [a-z0-9_.-] is allowed inside a segment',
                segment
            )
        }
    }
}

/**
 * Absolute path of the note file for `key`, with step 6 applied: a symlinked leaf
 * or a symlinked parent redirects `tmp` + `rename` just as effectively as a
 * symlinked file, so every component up to and including the scope root is
 * refused.
 */
export function resolveKeyPath(scopeRoot: string, rawKey: string): string {
    const key = normalizeKey(rawKey)
    const root = path.resolve(scopeRoot)
    const segments = key.split('/')
    const noteName = `${segments[segments.length - 1]}.md`

    const chain = [root]
    for (const segment of segments.slice(0, -1)) {
        chain.push(path.join(chain[chain.length - 1], segment))
    }
    const parent = chain[chain.length - 1]
    const target = path.join(parent, noteName)

    // The deepest path that exists is the deepest one a symlink could redirect
    // through; nothing below a missing component can exist.
    let deepestExisting: string | null = null
    for (const candidate of [...chain, target]) {
        let stats: fs.Stats
        try {
            stats = fs.lstatSync(candidate)
        } catch {
            break
        }
        if (stats.isSymbolicLink()) {
            throw new InvalidKeyError(rawKey, key, `symlinked path is refused: ${candidate}`)
        }
        deepestExisting = candidate
    }

    // The lstat walk proves no component is a link itself; comparing realpaths is
    // what proves the existing part was not reached through a link above it.
    if (deepestExisting !== null) {
        const rootReal = realpathOrNull(root)
        const deepestReal = realpathOrNull(deepestExisting)
        if (rootReal !== null && deepestReal !== null) {
            const expected = path.join(rootReal, path.relative(root, deepestExisting))
            if (deepestReal !== expected) {
                throw new InvalidKeyError(
                    rawKey,
                    key,
                    `parent directory escapes the scope root: ${deepestReal}`
                )
            }
        }
    }
    return target
}

function realpathOrNull(target: string): string | null {
    try {
        return fs.realpathSync(target)
    } catch {
        return null
    }
}

/** Key → path relative to the store root, as git sees it (§3.1). */
export function noteRelPath(scopeDir: string, rawKey: string): string {
    return `${path.posix.join(scopeDir, normalizeKey(rawKey))}.md`
}
