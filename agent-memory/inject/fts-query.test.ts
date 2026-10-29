import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'

import { openIndex } from '../index/db.ts'
import { upsertNote } from '../index/notes.ts'
import { MAX_QUERY_CHARS, MAX_QUERY_TOKENS, toFtsQuery, tokenize } from './fts-query.ts'

// ---------------------------------------------------------------------------
// fixture: a real index, so "the query is valid" is measured by SQLite
// ---------------------------------------------------------------------------

function tempIndex(t: TestContext): DatabaseSync {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-fts-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const db = openIndex(root)
    t.after(() => {
        try {
            db.close()
        } catch {}
    })
    upsertNote(db, {
        scope: 'global',
        key: 'secrets/api_token',
        path: 'global/secrets/api_token.md',
        body: 'tokens are rotated by hand every 90 days near a caret ^ and a colon',
        fmLen: 0,
        bodyHash: 'hash-a',
        access: 'open',
        mtime: 1_700_000_000_000,
    })
    upsertNote(db, {
        scope: 'global',
        key: 'build/flake',
        path: 'global/build/flake.md',
        body: 'nix build .#default rebuilds the flake quotation "quoted" string',
        fmLen: 0,
        bodyHash: 'hash-b',
        access: 'open',
        mtime: 1_700_000_001_000,
    })
    return db
}

/**
 * `MATCH` is the only honest validation of a query: FTS5's parser rejects column
 * filters, unbalanced quotes and prefix markers that look fine as strings.
 */
function matchCount(db: DatabaseSync, query: string): number {
    const rows = db
        .prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?')
        .get(query) as { n: number }
    return Number(rows.n)
}

const CASES = [
    '(re)build',
    '-rf',
    '"quoted"',
    'NEAR/3',
    'foo:bar',
    '^caret',
    '',
    '   ',
    'a',
    '!!!',
    'key:build',
    'access: gated',
    '-"*:(^)',
    '日本語のノート',
]

test('every non-null query is accepted by a real MATCH', t => {
    const db = tempIndex(t)
    for (const text of CASES) {
        const query = toFtsQuery(text)
        if (query === null) continue
        assert.equal(
            typeof matchCount(db, query),
            'number',
            `MATCH rejected ${JSON.stringify(text)} → ${query}`
        )
    }
})

test('toFtsQuery strips FTS5 operators, quotes and column filters', () => {
    // `-rf` unquoted is `NOT rf`; `(re)build` unquoted is a syntax error.
    assert.equal(toFtsQuery('-rf'), '"rf"')
    assert.equal(toFtsQuery('(re)build'), '"re" OR "build"')
    assert.equal(toFtsQuery('"quoted"'), '"quoted"')
    // A column filter is a column filter only unquoted, and `key` is a real column.
    assert.equal(toFtsQuery('foo:bar'), '"foo" OR "bar"')
    assert.equal(toFtsQuery('key:build'), '"key" OR "build"')
    assert.equal(toFtsQuery('^caret'), '"caret"')
    // `NEAR` is an operator keyword and `3` is below the two-character floor.
    assert.equal(toFtsQuery('NEAR/3'), null)
    assert.equal(toFtsQuery('build NEAR/3 flake'), '"build" OR "flake"')
})

test('toFtsQuery returns null when nothing searchable survives', () => {
    assert.equal(toFtsQuery(''), null)
    assert.equal(toFtsQuery('   '), null)
    assert.equal(toFtsQuery('!!!'), null)
    assert.equal(toFtsQuery('a'), null, 'one-character tokens are dropped')
})

test('a column filter cannot reach an unintended column', t => {
    const db = tempIndex(t)
    // Unquoted, `key:nix` is a filter on the `key` column and finds nothing: no key
    // contains "nix". Quoted, the same text is a body search and finds the build note.
    assert.equal(matchCount(db, 'key:nix'), 0)
    assert.equal(matchCount(db, toFtsQuery('key:nix') ?? ''), 1)
    assert.equal(toFtsQuery('key:nix'), '"key" OR "nix"')
})

test('toFtsQuery caps tokens at 20 and the query at 512 characters', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')
    const capped = toFtsQuery(hundred)
    assert.ok(capped !== null)
    assert.equal(capped.split(' OR ').length, MAX_QUERY_TOKENS)
    assert.match(capped, /^"word0" OR "word1"/)
    assert.ok(!capped.includes('"word20"'), 'the 21st token survived the cap')

    // One 2,000-character unbroken token must not consume the whole budget: the cap is
    // applied per token, so the words after it still form a usable query.
    const long = `${'x'.repeat(2000)} grafana dashboard`
    const query = toFtsQuery(long)
    assert.ok(query !== null)
    assert.ok(query.length <= MAX_QUERY_CHARS, `query is ${query.length} chars`)
    assert.match(query, /"grafana" OR "dashboard"$/)

    // Two thousand characters of ordinary words with a few long ones: the character
    // cap, not the token cap, has to bite, and the result must still be a valid MATCH.
    const many = Array.from({ length: 60 }, (_, i) => `${'w'.repeat(30)}${i}`).join(' ')
    const cappedByChars = toFtsQuery(many)
    assert.ok(cappedByChars !== null)
    assert.ok(
        cappedByChars.length <= MAX_QUERY_CHARS,
        `query is ${cappedByChars.length} chars`
    )
    assert.ok(cappedByChars.length > MAX_QUERY_CHARS - 40, 'the cap stalled far too early')
    assert.ok(
        cappedByChars.split(' OR ').length < MAX_QUERY_TOKENS,
        'the char cap did not bite'
    )
})

test('tokenize splits on punctuation and folds case', () => {
    assert.deepEqual(tokenize('Auth/Session_Handling'), ['auth', 'session', 'handling'])
    assert.deepEqual(tokenize('nix   build'), ['nix', 'build'])
    assert.deepEqual(tokenize('-rf --force'), ['rf', 'force'])
})

test('an injection-shaped query cannot break or broaden a MATCH', t => {
    const db = tempIndex(t)
    // Every one of these is a syntax error or a wildcard when passed through unquoted.
    for (const text of [
        '" OR "',
        '*',
        '-',
        '^',
        '()',
        'a:b',
        '"build"*',
        'NEAR(build flake)',
    ]) {
        const query = toFtsQuery(text)
        if (query === null) continue
        const count = matchCount(db, query)
        assert.ok(Number.isFinite(count), `${text} → ${query} did not produce a count`)
    }
    // `*` is FTS5's "everything" placeholder and an error on its own; a tokenizer that
    // let it through would turn a shrug into a full-corpus match.
    assert.equal(toFtsQuery('*'), null)
    assert.equal(toFtsQuery('***'), null)
})
