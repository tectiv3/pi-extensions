import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
    accessLogLockPath,
    accessLogPath,
    accessLogRotatedPath,
    gitignorePath,
    indexPath,
    projectsJsonPath,
    repoLockPath,
    scopeDir,
    storeRoot,
} from './paths.ts'

test('storeRoot honours PI_MEMORY_DIR and defaults to ~/.pi/memory', t => {
    const saved = process.env.PI_MEMORY_DIR
    t.after(() => {
        if (saved === undefined) delete process.env.PI_MEMORY_DIR
        else process.env.PI_MEMORY_DIR = saved
    })

    delete process.env.PI_MEMORY_DIR
    assert.equal(storeRoot(), path.join(os.homedir(), '.pi', 'memory'))

    process.env.PI_MEMORY_DIR = '/tmp/pi-memory-override'
    assert.equal(storeRoot(), '/tmp/pi-memory-override')

    // An empty variable means unset, not "the current directory".
    process.env.PI_MEMORY_DIR = '  '
    assert.equal(storeRoot(), path.join(os.homedir(), '.pi', 'memory'))
})

test('scopeDir places both scopes under the store root', () => {
    const root = '/store'
    assert.equal(scopeDir(root, 'global'), path.join(root, 'global'))
    assert.equal(
        scopeDir(root, 'project', 'repo-1a2b3c4d'),
        path.join(root, 'projects', 'repo-1a2b3c4d')
    )
    assert.throws(() => scopeDir(root, 'project'))
})

test('store file paths are fixed by the layout', () => {
    const root = '/store'
    assert.equal(gitignorePath(root), path.join(root, '.gitignore'))
    assert.equal(repoLockPath(root), path.join(root, '.git', 'pi-memory.lock'))
    assert.equal(indexPath(root), path.join(root, 'index.db'))
    assert.equal(accessLogPath(root), path.join(root, 'access.log'))
    assert.equal(accessLogRotatedPath(root), path.join(root, 'access.log.1'))
    assert.equal(accessLogLockPath(root), path.join(root, 'access.log.lock'))
    assert.equal(projectsJsonPath(root), path.join(root, 'projects.json'))
})
