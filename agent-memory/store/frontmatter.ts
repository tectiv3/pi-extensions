/**
 * Frontmatter — the on-disk representation of `access` (§2.1).
 *
 * The parser is strict but never fails open. A lenient parse that misses a gated
 * block un-gates the note *and* leaves `access: gated` in the body where it becomes
 * searchable, so every "weird" variant (BOM, CRLF, extra keys, trailing space,
 * upper-case key) is treated as a real block rather than as a body. A block is
 * only demoted to body when it contains no `access:` line at all, which is what
 * keeps a markdown horizontal rule harmless.
 */

import { createHash } from 'node:crypto'

export type Access = 'open' | 'gated'

export class FrontmatterError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'FrontmatterError'
    }
}

export interface ParsedNote {
    access: Access
    /** Body bytes from the original buffer, frontmatter excluded. */
    body: string
    /** Byte offset of the body in the original buffer; 0 when there is none. */
    fmLen: number
}

const DELIMITER = /^---[ \t]*$/
/**
 * Leading whitespace is allowed on purpose: `  access: gated` inside a block that
 * already parsed as frontmatter must not demote the block to body, which would
 * un-gate the note *and* make the line searchable (§2.1's fail-open class).
 */
const ACCESS_LINE = /^[ \t]*access[ \t]*:(.*)$/i

export function parseNote(buf: Buffer): ParsedNote {
    // Latin-1 decoding is a 1:1 byte→char map, so string indices are byte offsets
    // and every ASCII delimiter below is unambiguous inside multi-byte UTF-8.
    const text = buf.toString('latin1')
    const start = hasBom(buf) ? 3 : 0

    const opening = readLine(text, start)
    if (opening === null || !DELIMITER.test(opening.text)) {
        // The whole file is the body, BOM included, so that
        // `body === buf.subarray(fmLen)` holds for every note.
        return { access: 'open', body: buf.toString('utf8'), fmLen: 0 }
    }

    // The candidate block runs from the line after the opening delimiter to the
    // next delimiter line — or to EOF, in which case the body is empty.
    const blockLines: string[] = []
    let bodyStart = text.length
    let cursor = nextLineStart(opening)
    while (cursor < text.length) {
        const line = readLine(text, cursor)
        if (line === null) break
        if (DELIMITER.test(line.text)) {
            bodyStart = Math.min(nextLineStart(line), text.length)
            break
        }
        blockLines.push(line.text)
        if (line.end === text.length) break
        cursor = line.end + 1
    }

    const accessValue = readAccessValue(blockLines)
    if (accessValue === null) {
        // No `access:` key: this was a horizontal rule, not frontmatter.
        return { access: 'open', body: buf.toString('utf8'), fmLen: 0 }
    }
    return {
        access: parseAccess(accessValue),
        body: buf.subarray(bodyStart).toString('utf8'),
        fmLen: bodyStart,
    }
}

interface Line {
    text: string
    /** Index of the terminating `\n`, or the string length at EOF. */
    end: number
}

function readLine(text: string, from: number): Line | null {
    if (from >= text.length) return null
    const newline = text.indexOf('\n', from)
    const end = newline === -1 ? text.length : newline
    const raw = text.slice(from, end)
    // CRLF is normalised for matching only; `end` still points at the `\n`, so the
    // byte offsets derived from it stay valid for the original buffer.
    return { text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, end }
}

function nextLineStart(line: Line): number {
    return line.end + 1
}

function hasBom(buf: Buffer): boolean {
    return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

/**
 * `null` when the block has no `access:` key. A duplicate is an error rather than
 * a silent first-wins: two disagreeing values have no correct reading.
 */
function readAccessValue(lines: string[]): string | null {
    let found: string | null = null
    for (const line of lines) {
        const match = ACCESS_LINE.exec(line)
        if (match === null) continue
        if (found !== null)
            throw new FrontmatterError('frontmatter has more than one access key')
        found = match[1]
    }
    return found
}

function parseAccess(value: string): Access {
    const text = value.trim().toLowerCase()
    if (text === 'open' || text === 'gated') return text
    throw new FrontmatterError(`unparseable frontmatter access value "${value.trim()}"`)
}

export function renderNote(access: Access, body: string): string {
    if (access === 'gated') return `---\naccess: gated\n---\n${body}`
    return body
}

/** sha256 of the whole file including frontmatter (§2.3). */
export function fileHash(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex')
}

/**
 * `memory_edit` rejection (§2.1, §12.23). A match starting before `fmLen` either
 * touches or precedes the frontmatter; a match starting in the body cannot extend
 * backwards into it.
 */
export function isInFrontmatter(fmLen: number, byteOffset: number): boolean {
    return byteOffset >= 0 && byteOffset < fmLen
}
