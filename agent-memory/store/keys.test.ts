import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { InvalidKeyError, noteRelPath, normalizeKey, resolveKeyPath } from './keys.ts'

function makeScope(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-keys-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function isInvalidKey(err: unknown, segment?: string): boolean {
    if (!(err instanceof InvalidKeyError)) return false
    return segment === undefined || err.segment === segment
}

test('rejects every key from §12.7', () => {
    const rejected: [string, string | undefined][] = [
        ['../../etc/x', '..'],
        ['/abs/path', ''],
        ['a/./b', '.'],
        ['a/..', '..'],
        ['.hidden/x', '.hidden'],
        ['A B/c', 'a b'],
        ['ünicode/x', 'ünicode'],
        ['', undefined],
        ['a/', ''],
        ['a\\b', 'a\\b'],
        ['a:b/c', 'a:b'],
    ]
    for (const [raw, segment] of rejected) {
        assert.throws(
            () => normalizeKey(raw),
            err => isInvalidKey(err, segment),
            `expected ${JSON.stringify(raw)} to be rejected`
        )
    }
})

test('accepts and lowercases valid keys', () => {
    assert.equal(normalizeKey('Auth/Session'), 'auth/session')
    assert.equal(normalizeKey('a//b'), 'a/b')
    assert.equal(normalizeKey('a/b.md'), 'a/b')
    assert.equal(normalizeKey('a/b.md.md'), 'a/b.md')
    assert.equal(normalizeKey('deploy/nix_flake'), 'deploy/nix_flake')
    assert.equal(normalizeKey('notes.tmp'), 'notes.tmp')
    assert.equal(normalizeKey('a/b-c_d.e'), 'a/b-c_d.e')
})

test('normalization is idempotent', () => {
    for (const key of ['auth/session', 'a/b.md', 'deploy/nix_flake']) {
        assert.equal(normalizeKey(normalizeKey(key)), normalizeKey(key))
    }
})

test('an NFC/NFD pair normalizes to one key', () => {
    const nfc = 'ünicode/x'.normalize('NFC')
    const nfd = 'ünicode/x'.normalize('NFD')
    assert.notEqual(nfc, nfd)

    // Both are rejected — the character class is ASCII — but they must be rejected
    // as *one* key, or a case-folding filesystem would hold two files for it.
    const errors = [nfc, nfd].map(raw => {
        try {
            normalizeKey(raw)
            return null
        } catch (err) {
            assert.ok(err instanceof InvalidKeyError)
            return err as InvalidKeyError
        }
    })
    assert.equal(errors[0]?.normalized, errors[1]?.normalized)
})

test('the rejected segment is named in the error', () => {
    assert.throws(
        () => normalizeKey('auth/../session'),
        err =>
            err instanceof InvalidKeyError &&
            err.segment === '..' &&
            err.normalized === 'auth/../session' &&
            /segment "\.\."/.test(err.message)
    )
})

test('noteRelPath places the note under its scope dir', () => {
    assert.equal(noteRelPath('global', 'preferences/editor'), 'global/preferences/editor.md')
    assert.equal(
        noteRelPath('projects/pi-extensions-1a2b3c4d', 'Auth/Session'),
        'projects/pi-extensions-1a2b3c4d/auth/session.md'
    )
})

test('resolveKeyPath joins a plain key to the note file', t => {
    const scope = makeScope(t)
    assert.equal(resolveKeyPath(scope, 'auth/session'), path.join(scope, 'auth', 'session.md'))
    // The scope dir need not exist yet: the write path creates it.
    assert.equal(resolveKeyPath(scope, 'new/key'), path.join(scope, 'new', 'key.md'))
})

test('resolveKeyPath rejects a symlinked leaf file', t => {
    const scope = makeScope(t)
    const outside = makeScope(t)
    fs.writeFileSync(path.join(outside, 'real.md'), 'x\n')
    fs.symlinkSync(path.join(outside, 'real.md'), path.join(scope, 'link.md'))

    assert.throws(
        () => resolveKeyPath(scope, 'link'),
        er => isInvalidKey(er)
    )
})

test('resolveKeyPath rejects a symlinked parent directory', t => {
    const scope = makeScope(t)
    const outside = makeScope(t)
    fs.symlinkSync(outside, path.join(scope, 'auth'))
    fs.mkdirSync(path.join(scope, 'real'))
    fs.symlinkSync(outside, path.join(scope, 'real', 'nested'))

    // Redirecting the directory the tmp+rename happens in is as effective as
    // redirecting the file itself, so both depth-1 and depth-2 links are refused.
    assert.throws(
        () => resolveKeyPath(scope, 'auth/session'),
        er => isInvalidKey(er)
    )
    assert.throws(
        () => resolveKeyPath(scope, 'real/nested/x'),
        er => isInvalidKey(er)
    )
})

test('resolveKeyPath rejects a symlinked scope root', t => {
    const base = makeScope(t)
    const real = path.join(base, 'real-scope')
    fs.mkdirSync(real)
    fs.symlinkSync(real, path.join(base, 'linked-scope'))
    assert.throws(
        () => resolveKeyPath(path.join(base, 'linked-scope'), 'a/b'),
        er => isInvalidKey(er)
    )
})

test('resolveKeyPath accepts a real directory chain', t => {
    const scope = makeScope(t)
    fs.mkdirSync(path.join(scope, 'auth', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(scope, 'auth', 'session.md'), 'body\n')
    assert.equal(resolveKeyPath(scope, 'auth/session'), path.join(scope, 'auth', 'session.md'))
    assert.equal(
        resolveKeyPath(scope, 'auth/nested/new'),
        path.join(scope, 'auth', 'nested', 'new.md')
    )
})
