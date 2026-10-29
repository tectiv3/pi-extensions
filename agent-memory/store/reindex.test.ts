import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'

import { openIndex } from '../index/db.ts'
import { getNoteByKey, upsertNote } from '../index/notes.ts'
import { parseNote } from './frontmatter.ts'
import { reindexFromDisk } from './reindex.ts'

const GATED = '---\naccess: gated\n---\n'

function makeRoot(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-reindex-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function openTemp(t: TestContext): { root: string; db: DatabaseSync } {
    const root = makeRoot(t)
    const db = openIndex(root)
    t.after(() => {
        try {
            db.close()
        } catch {}
    })
    return { root, db }
}

function writeFile(root: string, relPath: string, content: string): void {
    const target = path.join(root, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
}

test('reindex picks up a hand-created gated fixture as gated', t => {
    const { root, db } = openTemp(t)
    // §12.14's awkward variants: CRLF, an extra key and a trailing space still parse
    // as gated, and the block never reaches `notes.body`.
    writeFile(
        root,
        'global/auth/session.md',
        '---\r\naccess: gated \r\ntags: auth\r\n---\r\nrotate at 90 days'
    )
    writeFile(root, 'global/plain.md', 'nothing special here\n')

    const result = reindexFromDisk(root, db)
    assert.deepEqual(result, { scanned: 2, updated: 2, skipped: 0, removed: 0, errors: [] })

    const gated = getNoteByKey(db, 'global', '', 'auth/session')
    assert.equal(gated.access, 'gated')
    assert.equal(gated.body, 'rotate at 90 days')
    assert.equal(gated.path, 'global/auth/session.md')
    assert.ok(gated.fm_len > 0)

    const plain = getNoteByKey(db, 'global', '', 'plain')
    assert.equal(plain.access, 'open')
    assert.equal(plain.fm_len, 0)

    // `access: gated` is not in the indexed body, so BM25 cannot match the block.
    const match = db
        .prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?')
        .get('gated')
    assert.equal(Number(match.n), 0)
    assert.equal(
        Number(
            db
                .prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?')
                .get('rotate').n
        ),
        1
    )
})

test('reindex reports project-scoped files under their project id', t => {
    const { root, db } = openTemp(t)
    writeFile(
        root,
        'projects/pi-extensions-1a2b3c4d/deploy/grafana.md',
        'dashboards live here\n'
    )

    reindexFromDisk(root, db)
    const row = getNoteByKey(db, 'project', 'pi-extensions-1a2b3c4d', 'deploy/grafana')
    assert.notEqual(row, null)
    assert.equal(row.scope, 'project')
    assert.equal(row.path, 'projects/pi-extensions-1a2b3c4d/deploy/grafana.md')
})

test('reindex skips an unchanged file and updates a changed one', t => {
    const { root, db } = openTemp(t)
    writeFile(root, 'global/notes/a.md', 'first body\n')

    assert.deepEqual(reindexFromDisk(root, db), {
        scanned: 1,
        updated: 1,
        skipped: 0,
        removed: 0,
        errors: [],
    })
    const before = getNoteByKey(db, 'global', '', 'notes/a')

    // Same bytes: the whole-file hash matches, so nothing is rewritten (§2.3).
    assert.deepEqual(reindexFromDisk(root, db), {
        scanned: 1,
        updated: 0,
        skipped: 1,
        removed: 0,
        errors: [],
    })
    assert.equal(getNoteByKey(db, 'global', '', 'notes/a').body_hash, before.body_hash)

    writeFile(root, 'global/notes/a.md', `${GATED}second body\n`)
    assert.deepEqual(reindexFromDisk(root, db), {
        scanned: 1,
        updated: 1,
        skipped: 0,
        removed: 0,
        errors: [],
    })
    const after = getNoteByKey(db, 'global', '', 'notes/a')
    assert.equal(after.access, 'gated', 'access comes from the file, not the old row')
    assert.equal(after.body, 'second body\n')
    assert.notEqual(after.body_hash, before.body_hash)
})

test('reindex reports a filename that fails normalizeKey instead of throwing', t => {
    const { root, db } = openTemp(t)
    writeFile(root, 'global/good.md', 'indexed fine\n')
    writeFile(root, 'global/Bad Name.md', 'unreachable key\n')
    writeFile(root, 'global/.hidden.md', 'hidden segment\n')

    const result = reindexFromDisk(root, db)

    assert.equal(result.scanned, 3)
    assert.equal(result.updated, 1)
    assert.equal(result.errors.length, 2)
    const badPaths = result.errors.map(error => error.path).sort()
    assert.deepEqual(badPaths, ['global/.hidden.md', 'global/Bad Name.md'])
    for (const error of result.errors) assert.ok(error.reason.length > 0)

    // A stray file must not brick the pass for the notes beside it.
    assert.notEqual(getNoteByKey(db, 'global', '', 'good'), null)
})

test('one malformed note is reported by path and does not blank the pass', t => {
    const { root, db } = openTemp(t)
    // `aaa` sorts first: under the old all-or-nothing policy everything after it was
    // never indexed, and the caller reduced that to one warning that named no file.
    writeFile(root, 'global/aaa.md', '---\naccess: someday\n---\nsecret\n')
    writeFile(root, 'global/beta.md', 'beta body\n')
    writeFile(root, 'global/zeta.md', 'zeta body\n')

    const result = reindexFromDisk(root, db)

    assert.equal(result.scanned, 3)
    assert.equal(result.updated, 2)
    assert.deepEqual(
        result.errors.map(error => error.path),
        ['global/aaa.md']
    )
    assert.match(result.errors[0].reason, /unparseable frontmatter access value/)
    assert.equal(getNoteByKey(db, 'global', '', 'beta').body, 'beta body\n')
    assert.equal(getNoteByKey(db, 'global', '', 'zeta').body, 'zeta body\n')
    // Fail-closed per note (§2.1): the unparseable note is absent, not `open`.
    assert.equal(getNoteByKey(db, 'global', '', 'aaa'), null)
})

test('a note that stops parsing loses its index row instead of staying searchable', t => {
    const { root, db } = openTemp(t)
    writeFile(root, 'global/odd.md', 'indexed while open\n')
    reindexFromDisk(root, db)
    assert.notEqual(getNoteByKey(db, 'global', '', 'odd'), null)

    // The hand edit that breaks it: `access:` with a value the parser refuses.
    writeFile(root, 'global/odd.md', '---\naccess: maybe\n---\nnow gated, maybe\n')
    const result = reindexFromDisk(root, db)

    assert.deepEqual(
        result.errors.map(error => error.path),
        ['global/odd.md']
    )
    assert.equal(
        getNoteByKey(db, 'global', '', 'odd'),
        null,
        'the old body stayed searchable behind an unparseable access value'
    )
    // The stale row is gone from FTS and vec_notes too, not just from `notes`.
    const fts = db.prepare('SELECT count(*) AS n FROM notes_fts').get()
    assert.equal(Number(fts.n), 0)
})

test('reindex removes the row of a hand-deleted note and counts it', t => {
    const { root, db } = openTemp(t)
    writeFile(root, 'global/alpha.md', 'alpha body\n')
    writeFile(root, 'global/beta.md', 'beta body\n')
    reindexFromDisk(root, db)

    fs.rmSync(path.join(root, 'global/beta.md'))
    const result = reindexFromDisk(root, db)

    assert.deepEqual(result, {
        scanned: 1,
        updated: 0,
        skipped: 1,
        removed: 1,
        errors: [],
    })
    assert.equal(getNoteByKey(db, 'global', '', 'beta'), null)
    const fts = db.prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?')
    assert.equal(Number(fts.get('beta').n), 0, 'the deleted note is still searchable')
    assert.equal(Number(fts.get('alpha').n), 1)
})

test('reindex removes a project row for a deleted project note', t => {
    const { root, db } = openTemp(t)
    writeFile(root, 'projects/proj-1a2b3c4d/deploy/grafana.md', 'dashboards\n')
    writeFile(root, 'global/keep.md', 'keep\n')
    reindexFromDisk(root, db)

    fs.rmSync(path.join(root, 'projects/proj-1a2b3c4d/deploy/grafana.md'))
    const result = reindexFromDisk(root, db)

    assert.equal(result.removed, 1)
    assert.equal(getNoteByKey(db, 'project', 'proj-1a2b3c4d', 'deploy/grafana'), null)
    assert.notEqual(getNoteByKey(db, 'global', '', 'keep'), null)
})

test('reindex keeps a row whose file still exists but the walk did not see', t => {
    const { root, db } = openTemp(t)
    // The row's file is there, it is simply not a note this pass visits — the same
    // shape a note written after the walk passed its directory leaves behind. Deleting
    // it would drop a live note from search until the next pass.
    writeFile(root, 'global/keep.txt', 'not a note file')
    upsertNote(db, {
        scope: 'global',
        key: 'other',
        path: 'global/keep.txt',
        body: 'written while the pass was running\n',
        fmLen: 0,
        bodyHash: 'h-other',
        access: 'open',
        mtime: 1,
    })

    const result = reindexFromDisk(root, db)
    assert.equal(result.removed, 0)
    assert.notEqual(getNoteByKey(db, 'global', '', 'other'), null)
})

test('reindex reports a file it cannot read and drops its row', t => {
    const { root, db } = openTemp(t)
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        t.skip('root reads a 0o000 file regardless of its mode')
        return
    }
    writeFile(root, 'global/secret.md', 'readable first\n')
    reindexFromDisk(root, db)
    assert.notEqual(getNoteByKey(db, 'global', '', 'secret'), null)

    const target = path.join(root, 'global/secret.md')
    fs.chmodSync(target, 0o000)

    const result = reindexFromDisk(root, db)
    assert.deepEqual(
        result.errors.map(error => error.path),
        ['global/secret.md']
    )
    assert.match(result.errors[0].reason, /EACCES|EPERM/)
    assert.equal(getNoteByKey(db, 'global', '', 'secret'), null)
})

test('reindex tolerates a missing scope directory', t => {
    const { root, db } = openTemp(t)
    assert.deepEqual(reindexFromDisk(root, db), {
        scanned: 0,
        updated: 0,
        skipped: 0,
        removed: 0,
        errors: [],
    })
})

test('a file that is only frontmatter indexes as gated with an empty body', t => {
    const { root, db } = openTemp(t)
    writeFile(root, 'global/empty.md', GATED)

    reindexFromDisk(root, db)
    const row = getNoteByKey(db, 'global', '', 'empty')
    assert.equal(row.access, 'gated')
    assert.equal(row.body, '')
    assert.equal(row.fm_len, GATED.length)
    assert.deepEqual(parseNote(fs.readFileSync(path.join(root, 'global/empty.md'))), {
        access: 'gated',
        body: '',
        fmLen: GATED.length,
    })
})
