/**
 * Characterisation of the shared walker (F11).
 *
 * The point of the refactor was that `reindexFromDisk` and `populateFromDisk` must
 * visit the same files, so this pins the walk against an independent recursive
 * listing rather than against either of the two implementations it replaced.
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { type NoteFileError, STALE_TEMP_MS, removeStaleTemps, walkNotes } from './walk.ts'

function makeRoot(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-walk-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function writeFile(root: string, relPath: string, content = 'body\n'): void {
    const target = path.join(root, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
}

/** Every `.md` file under `dir`, depth-first and sorted — the naive reference. */
function listMarkdown(dir: string): string[] {
    const found: string[] = []
    const walk = (current: string): void => {
        let entries: fs.Dirent[]
        try {
            entries = fs
                .readdirSync(current, { withFileTypes: true })
                .slice()
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.isDirectory()) walk(path.join(current, entry.name))
        }
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.md')) {
                found.push(path.relative(dir, path.join(current, entry.name)))
            }
        }
    }
    walk(dir)
    return found
}

test('the walker visits exactly the note files a recursive listing finds', t => {
    const root = makeRoot(t)
    writeFile(root, 'global/one.md')
    writeFile(root, 'global/nested/two.md')
    writeFile(root, 'global/nested/deeper/three.md')
    writeFile(root, 'projects/proj-1a2b3c4d/notes/four.md')
    writeFile(root, 'projects/proj-5e6f7a8b/notes/five.md')
    // Not notes: ignored by both.
    writeFile(root, 'global/README.txt')
    writeFile(root, 'projects/index.db')

    const errors: NoteFileError[] = []
    const files = [...walkNotes(root, error => errors.push(error))]

    assert.deepEqual(errors, [])
    assert.deepEqual(files.map(file => file.relPath).sort(), [
        'global/nested/deeper/three.md',
        'global/nested/two.md',
        'global/one.md',
        'projects/proj-1a2b3c4d/notes/four.md',
        'projects/proj-5e6f7a8b/notes/five.md',
    ])
    for (const file of files) {
        assert.equal(
            file.relPath,
            `${file.scope === 'global' ? 'global' : `projects/${file.project}`}/${file.key}.md`
        )
        assert.equal(
            file.absPath,
            path.join(root, ...file.relPath.split('/')),
            'absPath and relPath disagree'
        )
    }

    // The reference listing, scoped the same way, sees the same set.
    const reference = [
        ...listMarkdown(path.join(root, 'global')),
        ...listMarkdown(path.join(root, 'projects')),
    ]
    assert.equal(files.length, reference.length)
})

test('a missing store is empty, not an error', t => {
    const root = makeRoot(t)
    const errors: NoteFileError[] = []
    assert.deepEqual([...walkNotes(root, error => errors.push(error))], [])
    assert.deepEqual(errors, [])
})

test('an unnameable file is reported and skipped, never thrown', t => {
    const root = makeRoot(t)
    writeFile(root, 'global/good.md')
    writeFile(root, 'global/Bad Name.md')
    writeFile(root, 'global/.hidden.md')

    const errors: NoteFileError[] = []
    const files = [...walkNotes(root, error => errors.push(error))]

    assert.deepEqual(
        files.map(file => file.key),
        ['good']
    )
    assert.deepEqual(errors.map(error => error.path).sort(), [
        'global/.hidden.md',
        'global/Bad Name.md',
    ])
    for (const error of errors) assert.ok(error.reason.length > 0)
    // The reason is the key error, not a bare stringified object.
    assert.match(errors[0].reason, /key|segment/i)
})

test('keys are normalised exactly as normalizeKey does it', t => {
    const root = makeRoot(t)
    writeFile(root, 'global/Notes/UPPER.md')
    writeFile(root, 'global/notes/lower.md')

    const errors: NoteFileError[] = []
    const files = [...walkNotes(root, error => errors.push(error))]

    assert.deepEqual(errors, [])
    assert.deepEqual(files.map(file => file.key).sort(), ['notes/lower', 'notes/upper'])
})

test('an unreadable directory throws instead of returning a short list', t => {
    const root = makeRoot(t)
    writeFile(root, 'global/one.md')
    // A regular file where the `global/` directory belongs: a walk that swallowed this
    // would hand the reindex pass an empty tree, and "not seen" would delete every row.
    const global = path.join(root, 'global')
    fs.rmSync(global, { recursive: true, force: true })
    fs.writeFileSync(global, 'not a directory')

    assert.throws(() => [...walkNotes(root, () => {})], /ENOTDIR/)
})

test('a symlinked note or directory is reported, never silently dropped', t => {
    const root = makeRoot(t)
    const outside = makeRoot(t)
    writeFile(outside, 'real.md')
    fs.mkdirSync(path.join(root, 'global'), { recursive: true })
    fs.symlinkSync(path.join(outside, 'real.md'), path.join(root, 'global/linked.md'))
    fs.symlinkSync(outside, path.join(root, 'global/linked-dir'))

    const errors: NoteFileError[] = []
    const visited = [...walkNotes(root, error => errors.push(error))]

    assert.deepEqual(visited, [])
    assert.deepEqual(errors.map(error => error.path).sort(), [
        'global/linked-dir',
        'global/linked.md',
    ])
    for (const error of errors) assert.match(error.reason, /symlinks are not followed/)
})

test('removeStaleTemps deletes only aged `*.md.tmp` leftovers', t => {
    const root = makeRoot(t)
    const stale = path.join(root, 'global/notes/old.md.tmp')
    const fresh = path.join(root, 'global/notes/new.md.tmp')
    const real = path.join(root, 'global/notes/real.md')
    for (const target of [stale, fresh, real]) {
        writeFile(root, path.relative(root, target))
    }
    const twoHoursAgo = new Date(Date.now() - 2 * STALE_TEMP_MS)
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo)

    assert.equal(removeStaleTemps(root), 1)
    assert.equal(fs.existsSync(stale), false, 'a crashed temp file survived the sweep')
    assert.equal(fs.existsSync(fresh), true, 'a live writer\u2019s temp file was deleted')
    assert.equal(fs.existsSync(real), true)
    assert.equal(removeStaleTemps(root), 0, 'a second pass has nothing left to do')
})
