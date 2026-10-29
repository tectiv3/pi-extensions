import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { GateContext } from '../gate/gate.ts'
import { getNoteByKey } from '../index/notes.ts'
import { openStore, type Store } from './store.ts'

function tempDir(t: TestContext, prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

function useStoreDir(t: TestContext): string {
    const dir = tempDir(t, 'pi-memory-open-')
    const saved = process.env.PI_MEMORY_DIR
    process.env.PI_MEMORY_DIR = dir
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_DIR
        else process.env.PI_MEMORY_DIR = saved
    })
    return dir
}

/** The store root is `PI_MEMORY_DIR`; the cwd only decides project identity. */
function openTestStore(t: TestContext, options: Parameters<typeof openStore>[1] = {}): Store {
    const store = openStore(tempDir(t, 'pi-memory-cwd-'), options)
    t.after(() => store.close())
    return store
}

function allowGate(): GateContext {
    return {
        hasUI: true,
        sessionId: 'sess-store',
        ui: {
            async confirm() {
                return true
            },
        },
    }
}

function ensureNotSubagent(t: TestContext): void {
    const saved = process.env.PI_MEMORY_SUBAGENT
    delete process.env.PI_MEMORY_SUBAGENT
    t.after(() => {
        if (saved !== undefined) process.env.PI_MEMORY_SUBAGENT = saved
    })
}

test('openStore initialises the repo, the index and the path helpers', t => {
    const root = useStoreDir(t)
    const store = openTestStore(t)

    assert.equal(store.root, root)
    assert.ok(fs.existsSync(path.join(root, '.git')))
    assert.equal(
        fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
        '/index.db*\n/access.log*\n/projects.json\n*.tmp\n'
    )
    assert.equal(store.paths.indexDb, path.join(root, 'index.db'))
    assert.equal(store.paths.accessLog, path.join(root, 'access.log'))
    assert.equal(store.paths.projectsJson, path.join(root, 'projects.json'))
    assert.equal(store.paths.scopeDir('global'), path.join(root, 'global'))
    assert.equal(
        store.paths.scopeDir('project', 'pi-1a2b3c4d'),
        path.join(root, 'projects', 'pi-1a2b3c4d')
    )
    assert.equal(
        store.paths.noteFile('project', 'pi-1a2b3c4d', 'Auth/Session.md'),
        path.join(root, 'projects', 'pi-1a2b3c4d', 'auth/session.md')
    )
    // §4 schema is live on the owned handle.
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM notes').get().n, 0)
})

test('the default gate fails closed: no UI means no gated write', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openTestStore(t)

    const res = await store.writeNote({
        key: 'auth/token',
        body: 'gated content',
        access: 'gated',
        reason: 'should not land',
    })

    assert.equal(res.ok, false)
    assert.equal(res.code, 'denied-no-ui')
    assert.equal(fs.existsSync(path.join(root, 'global/auth/token.md')), false)
    // The attempt is logged before the decision (§7.3).
    assert.match(fs.readFileSync(path.join(root, 'access.log'), 'utf8'), /denied-no-ui/)
})

test('readNote trusts the file over a stale index row (§5)', async t => {
    ensureNotSubagent(t)
    useStoreDir(t)
    const store = openTestStore(t, { gate: allowGate() })

    const res = await store.writeNote({
        key: 'auth/session',
        body: 'token policy',
        access: 'gated',
        reason: 'fixture',
    })
    assert.equal(res.ok, true)

    // Simulate an index that disagrees with disk, which is the state a hand-gated
    // note is in until the next reindex.
    store.db.prepare("UPDATE notes SET access = 'open' WHERE key = 'auth/session'").run()
    assert.equal(getNoteByKey(store.db, 'global', '', 'auth/session').access, 'open')

    const snapshot = store.readNote({ key: 'auth/session' })
    assert.equal(snapshot.access, 'gated')
    assert.equal(snapshot.body, 'token policy')
    assert.equal(snapshot.hash.length, 64)
})

test('reindex and sweep are exposed on the store', async t => {
    ensureNotSubagent(t)
    const root = useStoreDir(t)
    const store = openTestStore(t)

    // A hand-created note appears in the index only after a reindex pass.
    fs.mkdirSync(path.join(root, 'global'), { recursive: true })
    fs.writeFileSync(
        path.join(root, 'global/handmade.md'),
        '---\naccess: gated\n---\nby hand\n'
    )
    assert.equal(getNoteByKey(store.db, 'global', '', 'handmade'), null)

    assert.deepEqual(store.reindex(), {
        scanned: 1,
        updated: 1,
        skipped: 0,
        removed: 0,
        errors: [],
    })
    assert.equal(getNoteByKey(store.db, 'global', '', 'handmade').access, 'gated')
    assert.deepEqual(store.reindex(), {
        scanned: 1,
        updated: 0,
        skipped: 1,
        removed: 0,
        errors: [],
    })

    // The file is committed by the sweep (§3.3), not left dirty.
    assert.deepEqual(store.sweep(), { committed: ['global/handmade.md'] })
})

test('close is safe to call twice', t => {
    useStoreDir(t)
    const store = openTestStore(t)
    store.close()
    store.close()
})
