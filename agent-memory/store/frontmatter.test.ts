import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import {
    fileHash,
    FrontmatterError,
    isInFrontmatter,
    parseNote,
    renderNote,
} from './frontmatter.ts'

const GATED_HEADER = '---\naccess: gated\n---\n'
const GATED_HEADER_BYTES = Buffer.byteLength(GATED_HEADER)

function parse(text: string) {
    return parseNote(Buffer.from(text, 'utf8'))
}

test('a gated note parses with the exact body byte offset', () => {
    const parsed = parse(`${GATED_HEADER}secret body\n`)
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.body, 'secret body\n')
    assert.equal(parsed.fmLen, GATED_HEADER_BYTES)
    assert.equal(parsed.fmLen, 22)
})

test('an open note has no frontmatter at all', () => {
    const parsed = parse('just a body\nsecond line\n')
    assert.equal(parsed.access, 'open')
    assert.equal(parsed.body, 'just a body\nsecond line\n')
    assert.equal(parsed.fmLen, 0)
})

test('a horizontal rule is not frontmatter and keeps the whole file as body', () => {
    const rule = '---\n\noutro\n'
    const parsed = parse(`intro\n\n${rule}`)
    assert.equal(parsed.access, 'open')
    assert.equal(parsed.body, `intro\n\n${rule}`)
    assert.equal(parsed.fmLen, 0)

    // Also when the rule opens the file, and when the block holds keys that are not
    // `access:`: it is a table, not a gate.
    const leading = parse('---\ntitle: notes\n---\nbody\n')
    assert.equal(leading.access, 'open')
    assert.equal(leading.body, '---\ntitle: notes\n---\nbody\n')
    assert.equal(leading.fmLen, 0)
})

test('a CRLF gated note still parses as gated', () => {
    const text = '---\r\naccess: gated\r\n---\r\nbody\r\n'
    const parsed = parse(text)
    assert.equal(parsed.access, 'gated')
    // CRLF is normalised for matching only; the body keeps the original bytes.
    assert.equal(parsed.body, 'body\r\n')
    assert.equal(parsed.fmLen, 25)
})

test('a BOM before a gated block still parses as gated', () => {
    const parsed = parse(`\uFEFF${GATED_HEADER}body\n`)
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.body, 'body\n')
    assert.equal(parsed.fmLen, 22 + 3)
})

test('an extra key inside a valid block stays out of the body', () => {
    const parsed = parse('---\naccess: gated\ntags: x\n---\nbody\n')
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.body, 'body\n')
    assert.equal(parsed.fmLen, Buffer.byteLength('---\naccess: gated\ntags: x\n---\n'))
    assert.equal(parsed.body.includes('tags:'), false)
})

test('a trailing space after a delimiter line still parses as gated', () => {
    const closing = parse('---\naccess: gated\n--- \nbody\n')
    assert.equal(closing.access, 'gated')
    assert.equal(closing.body, 'body\n')
    assert.equal(closing.fmLen, 23)

    const opening = parse('---  \naccess: gated\n---\nbody\n')
    assert.equal(opening.access, 'gated')
    assert.equal(opening.body, 'body\n')
})

test('an upper-case access key and value still parse as gated', () => {
    const parsed = parse('---\nAccess: Gated\n---\nbody\n')
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.body, 'body\n')
})

test('an indented access key inside a block still parses as gated', () => {
    // Fail-closed (§2.1): requiring column 0 demoted the block to body, which opened the
    // note *and* left `access: gated` searchable.
    const parsed = parse('---\n  access: gated\n---\nsecret body\n')
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.body, 'secret body\n')
})

test('an explicit access: open block is frontmatter and is stripped', () => {
    const parsed = parse('---\naccess: open\n---\nbody\n')
    assert.equal(parsed.access, 'open')
    assert.equal(parsed.body, 'body\n')
    assert.equal(parsed.fmLen, 21)
})

test('an empty file is an open note with an empty body', () => {
    assert.deepEqual(parseNote(Buffer.alloc(0)), { access: 'open', body: '', fmLen: 0 })
})

test('a file that is only frontmatter yields an empty gated body', () => {
    assert.deepEqual(parse(GATED_HEADER), {
        access: 'gated',
        body: '',
        fmLen: GATED_HEADER_BYTES,
    })
    // No terminating newline after the closing delimiter: still the whole file.
    assert.deepEqual(parse('---\naccess: gated\n---'), {
        access: 'gated',
        body: '',
        fmLen: Buffer.byteLength('---\naccess: gated\n---'),
    })
})

test('a block with access: but no closing delimiter is frontmatter to EOF', () => {
    // Spec-literal (§2.1 step 3): the candidate then runs to EOF, so the body is
    // empty. Swallowing the text is the safe direction — the alternative un-gates
    // the note on a hand-edit that deleted a line.
    const text = '---\naccess: gated\nbody text\n'
    assert.deepEqual(parse(text), {
        access: 'gated',
        body: '',
        fmLen: Buffer.byteLength(text),
    })
})

test('an unparseable access value throws instead of silently opening', () => {
    assert.throws(() => parse('---\naccess: maybe\n---\nbody\n'), FrontmatterError)
    assert.throws(() => parse('---\naccess:\n---\nbody\n'), FrontmatterError)
})

test('duplicate access keys throw rather than picking one', () => {
    assert.throws(
        () => parse('---\naccess: gated\naccess: open\n---\nbody\n'),
        FrontmatterError
    )
})

test('renderNote round-trips through parseNote', () => {
    for (const access of ['open', 'gated'] as const) {
        const rendered = renderNote(access, 'body line\n')
        const parsed = parse(rendered)
        assert.equal(parsed.access, access)
        assert.equal(parsed.body, 'body line\n')
        assert.equal(parsed.fmLen, access === 'gated' ? GATED_HEADER_BYTES : 0)
    }
    assert.equal(renderNote('open', 'body\n'), 'body\n')
    assert.equal(renderNote('gated', 'body\n'), `${GATED_HEADER}body\n`)
})

test('fmLen is a byte offset, not a character offset, for a multi-byte body', () => {
    const buf = Buffer.from(`${GATED_HEADER}ünïcode\n`, 'utf8')
    const parsed = parseNote(buf)
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.fmLen, GATED_HEADER_BYTES)
    assert.equal(parsed.body, 'ünïcode\n')
    // 'ü' is two bytes: the first body byte is 0xC3 only if fmLen counted bytes.
    assert.equal(buf[parsed.fmLen], 0xc3)
    assert.deepEqual(buf.subarray(parsed.fmLen), Buffer.from('ünïcode\n', 'utf8'))
})

test('fileHash covers the whole file, frontmatter included', () => {
    const buf = Buffer.from(`${GATED_HEADER}body\n`, 'utf8')
    const expected = createHash('sha256').update(buf).digest('hex')
    assert.equal(fileHash(buf), expected)

    // An access flip alone must change the hash (§2.3).
    const open = Buffer.from('body\n', 'utf8')
    assert.notEqual(fileHash(open), fileHash(buf))
})

test('isInFrontmatter rejects offsets before the body start', () => {
    assert.equal(isInFrontmatter(GATED_HEADER_BYTES, 0), true)
    assert.equal(isInFrontmatter(GATED_HEADER_BYTES, GATED_HEADER_BYTES - 1), true)
    assert.equal(isInFrontmatter(GATED_HEADER_BYTES, GATED_HEADER_BYTES), false)
    assert.equal(isInFrontmatter(GATED_HEADER_BYTES, 100), false)
    assert.equal(isInFrontmatter(0, 0), false)
})

test('fixtures on disk parse the same way as in-memory buffers', (t: TestContext) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-fm-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const target = path.join(dir, 'note.md')
    fs.writeFileSync(target, GATED_HEADER + 'disk body\n')
    const parsed = parseNote(fs.readFileSync(target))
    assert.equal(parsed.access, 'gated')
    assert.equal(parsed.body, 'disk body\n')
    assert.equal(parsed.fmLen, GATED_HEADER_BYTES)
})
