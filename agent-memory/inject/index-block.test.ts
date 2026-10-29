import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { resolveProjectId } from '../store/project.ts'
import { openStore, type Store } from '../store/store.ts'
import {
    MAX_INDEX_CHARS,
    MAX_INDEX_KEYS,
    buildIndexBlock,
    cacheIndexBlock,
    clearIndexBlockCache,
    getCachedIndexBlock,
} from './index-block.ts'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function tempDir(t: TestContext, prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

/** The store root is `PI_MEMORY_DIR`; the cwd only decides project identity. */
function useStoreDir(t: TestContext): string {
    const dir = tempDir(t, 'pi-memory-block-')
    const saved = process.env.PI_MEMORY_DIR
    process.env.PI_MEMORY_DIR = dir
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_DIR
        else process.env.PI_MEMORY_DIR = saved
    })
    return dir
}

function openStoreFor(t: TestContext): { root: string; store: Store } {
    const root = useStoreDir(t)
    const store = openStore(tempDir(t, 'pi-memory-block-cwd-'))
    t.after(() => store.close())
    return { root, store }
}

/**
 * Notes are written as files and reindexed, never through `writeNote`: 200 notes
 * through the write path is 200 git commits, and these tests are about the cap, the
 * ordering and the gate — not about the commit.
 */
function seedFile(root: string, key: string, body: string, mtime?: number): string {
    const file = path.join(root, 'global', `${key}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
    if (mtime !== undefined) {
        const stamp = new Date(mtime)
        fs.utimesSync(file, stamp, stamp)
    }
    return file
}

function keysLine(block: string): string {
    return block.split('\n')[1] ?? ''
}

// ---------------------------------------------------------------------------
// block content (§6.1)
// ---------------------------------------------------------------------------

test('an empty store produces no block at all', t => {
    const { store } = openStoreFor(t)
    const cwd = tempDir(t, 'pi-memory-block-cwd-')
    assert.equal(buildIndexBlock({ store, cwd }), '')
})

test('an all-gated store still reports the count, and names no key', t => {
    const { root, store } = openStoreFor(t)
    seedFile(root, 'secrets/one', '---\naccess: gated\n---\nbody')
    seedFile(root, 'secrets/two', '---\naccess: gated\n---\nbody')
    store.reindex()

    const block = buildIndexBlock({ store, cwd: tempDir(t, 'pi-memory-block-cwd-') })
    assert.equal(block, 'scope: global\ngated: 2 hidden (ask for one by name)')
    assert.ok(!block.includes('secrets/one'))
})

test('the block carries the scope, the keys and the gated count', t => {
    const { root, store } = openStoreFor(t)
    seedFile(root, 'auth/session', 'tokens are refreshed on request')
    seedFile(root, 'secrets/api_token', '---\naccess: gated\n---\nrotated by hand')
    store.reindex()

    const block = buildIndexBlock({ store, cwd: tempDir(t, 'pi-memory-block-cwd-') })
    assert.match(block, /^scope: global$/m)
    assert.match(block, /^auth\/session$/m)
    assert.match(block, /^gated: 1 hidden \(ask for one by name\)$/m)
    assert.ok(!block.includes('secrets/api_token'), 'a gated key was named')
    assert.ok(!block.includes('rotated by hand'), 'a gated body was injected')
})

test('keys are ordered mtime DESC then id DESC, and the cap keeps the newest', t => {
    const { root, store } = openStoreFor(t)
    const base = 1_700_000_000_000
    seedFile(root, 'notes/oldest', 'a', base)
    seedFile(root, 'notes/middle', 'b', base + 5_000)
    // Same-millisecond notes: the higher id (written later) must win the tie.
    seedFile(root, 'notes/tie_first', 'c', base + 9_000)
    seedFile(root, 'notes/tie_second', 'd', base + 9_000)
    store.reindex()

    const block = buildIndexBlock({ store, cwd: tempDir(t, 'pi-memory-block-cwd-') })
    assert.equal(
        keysLine(block),
        'notes/tie_second, notes/tie_first, notes/middle, notes/oldest'
    )
})

test('the key cap is 200 keys plus an overflow line', t => {
    const { root, store } = openStoreFor(t)
    const base = 1_700_000_000_000
    for (let index = 0; index < MAX_INDEX_KEYS + 6; index++) {
        seedFile(
            root,
            `bulk/note_${String(index).padStart(3, '0')}`,
            'body',
            base + index * 1000
        )
    }
    assert.equal(store.reindex().updated, MAX_INDEX_KEYS + 6)

    const block = buildIndexBlock({ store, cwd: tempDir(t, 'pi-memory-block-cwd-') })
    const line = keysLine(block)
    assert.equal(line.split(', ').length, MAX_INDEX_KEYS + 1)
    assert.match(line, /\+6 more \(recent first\)$/)
    // mtime DESC: the newest note is listed, the oldest is not.
    assert.ok(line.includes('bulk/note_205'))
    assert.ok(!line.includes('bulk/note_000'))
})

test('the character cap cuts before 4,800 characters of keys', t => {
    const { root, store } = openStoreFor(t)
    // 200 notes × ~40 chars is ~8,000 chars of keys: the character cap must bite first,
    // and the block must still say how many keys were left out.
    for (let index = 0; index < MAX_INDEX_KEYS; index++) {
        const key = `long/${'a'.repeat(20)}_${String(index).padStart(3, '0')}/${'b'.repeat(12)}`
        seedFile(root, key, 'body')
    }
    assert.equal(store.reindex().updated, MAX_INDEX_KEYS)

    const block = buildIndexBlock({ store, cwd: tempDir(t, 'pi-memory-block-cwd-') })
    assert.ok(
        keysLine(block).length <= MAX_INDEX_CHARS + 32,
        `keys line is ${keysLine(block).length}`
    )
    assert.ok(keysLine(block).length > MAX_INDEX_CHARS - 80, 'the cap stalled far too early')
    assert.match(keysLine(block), /\+\d+ more \(recent first\)$/)
})

test('inside a repository the block names and lists both tiers, project first', t => {
    const root = useStoreDir(t)
    const repo = tempDir(t, 'pi-memory-block-repo-')
    const init = spawnSync('git', ['init', '--quiet', '-b', 'main'], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 10_000,
    })
    assert.equal(init.status, 0, `git init failed: ${init.stderr}`)
    const store = openStore(repo)
    t.after(() => store.close())
    const projectId = resolveProjectId(repo)?.id
    assert.ok(projectId !== undefined)

    const base = 1_700_000_000_000
    // The global note is newer: recency alone must not put it ahead of the project's.
    const projectFile = path.join(root, `projects/${projectId}/build/flags.md`)
    fs.mkdirSync(path.dirname(projectFile), { recursive: true })
    fs.writeFileSync(projectFile, 'project build flags')
    fs.utimesSync(projectFile, new Date(base), new Date(base))
    seedFile(root, 'editor/prefs', 'global editor prefs', base + 60_000)
    assert.equal(store.reindex().updated, 2)

    const block = buildIndexBlock({ store, cwd: repo })
    const lines = block.split('\n')
    assert.match(lines[0], /^scope: project:\S+ \+ global$/)
    assert.equal(lines[1], 'build/flags, editor/prefs')
    // Naming the tier is the whole point: a reader must be able to tell which one a
    // key came from, and the ordering is the only signal on the key line.
    assert.ok(!block.includes('gated:'))
})

// ---------------------------------------------------------------------------
// the cache (§6.1)
// ---------------------------------------------------------------------------

test('the block is cached until it is cleared or recomputed', t => {
    const { root, store } = openStoreFor(t)
    const cwd = tempDir(t, 'pi-memory-block-cwd-')
    clearIndexBlockCache()
    assert.equal(getCachedIndexBlock(), '', 'a fresh process has no block')

    seedFile(root, 'auth/session', 'body')
    store.reindex()
    const cached = cacheIndexBlock({ store, cwd })
    assert.match(cached, /auth\/session/)
    assert.equal(getCachedIndexBlock(), cached)

    // A note written after the cache was filled must not appear until the cache is
    // refreshed: that is what keeps the system prompt byte-identical between turns.
    seedFile(root, 'build/flake', 'body')
    store.reindex()
    assert.equal(getCachedIndexBlock(), cached)
    assert.ok(!getCachedIndexBlock().includes('build/flake'))

    assert.equal(cacheIndexBlock({ store, cwd }).includes('build/flake'), true)
    clearIndexBlockCache()
    assert.equal(getCachedIndexBlock(), '')
})
