import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import {
    mergeProject,
    normalizeRemote,
    projectId,
    readProjects,
    resolveProjectId,
    slug,
} from './project.ts'
import { initStore } from './git.ts'
import { projectsJsonPath } from './paths.ts'

function tmpDir(t: TestContext, prefix = 'pi-memory-project-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    return dir
}

function runGit(cwd: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
}

function makeRepo(t: TestContext, dirName?: string, remote?: string): string {
    const base = tmpDir(t)
    const root = dirName === undefined ? base : path.join(base, dirName)
    if (dirName !== undefined) fs.mkdirSync(root)
    initStore(root)
    if (remote !== undefined) runGit(root, ['remote', 'add', 'origin', remote])
    return root
}

function runGitOut(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}

function hash8(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

test('normalizeRemote folds every network form of one repository together', () => {
    const same = [
        'git@github.com:Owner/Repo.git',
        'https://github.com/owner/repo',
        'https://github.com/Owner/Repo.git',
        'ssh://git@github.com/owner/repo.git',
        'ssh://git@github.com:22/owner/repo',
        'git+ssh://git@github.com:22/owner/repo.git',
        'git://github.com/owner/repo',
        'https://user:token@github.com/owner/repo.git',
        'https://github.com/owner/repo.git/',
        'https://github.com/owner/repo?ref=main#readme',
        '  https://github.com/owner/repo  ',
        'git@github.com:/owner/repo.git',
    ]
    for (const url of same) {
        assert.equal(normalizeRemote(url), 'github.com/owner/repo', url)
    }
})

test('normalizeRemote keeps non-default ports and drops default ones', () => {
    assert.equal(normalizeRemote('ssh://git@host:2222/owner/repo'), 'host:2222/owner/repo')
    assert.equal(normalizeRemote('ssh://git@host:22/owner/repo'), 'host/owner/repo')
    assert.equal(normalizeRemote('https://host:443/owner/repo'), 'host/owner/repo')
    assert.equal(normalizeRemote('http://host:80/owner/repo'), 'host/owner/repo')
})

test('normalizeRemote returns null for local remotes', () => {
    for (const url of [
        'file:///Users/someone/repo',
        'file://localhost/Users/someone/repo',
        '/Users/someone/repo',
        './repo',
        '../repo',
        '~/repo',
        'repo',
        '',
        '   ',
    ]) {
        assert.equal(normalizeRemote(url), null, url)
    }
})

test('slug lowercases, replaces, collapses and trims', () => {
    assert.equal(slug('Pi Extensions'), 'pi-extensions')
    assert.equal(slug('a__b---c'), 'a-b-c')
    assert.equal(slug('--x--'), 'x')
    assert.equal(slug('??'), '')
})

test('one remote is one project id across url forms', t => {
    const urls = [
        'git@github.com:Owner/Repo.git',
        'https://github.com/owner/repo',
        'ssh://git@github.com:22/owner/repo.git',
        'https://github.com/owner/repo.git',
        'https://github.com/OWNER/REPO',
    ]
    const ids = urls.map(url => {
        const root = makeRepo(t, undefined, url)
        return projectId(root)
    })
    for (const identity of ids) {
        assert.equal(identity.id, ids[0].id)
        assert.equal(identity.name, 'repo')
        assert.equal(identity.remote, 'github.com/owner/repo')
    }
    assert.equal(ids[0].id, `repo-${hash8('github.com/owner/repo')}`)
})

test('renaming the checkout does not change the id or the name when a remote exists', t => {
    const first = projectId(makeRepo(t, 'first-checkout', 'git@github.com:owner/repo.git'))
    const second = projectId(makeRepo(t, 'renamed-checkout', 'git@github.com:owner/repo.git'))
    assert.equal(first.id, second.id)
    assert.equal(first.name, 'repo')
    assert.equal(second.name, 'repo')
})

test('without a remote the id is the directory name plus the realpath hash', t => {
    const root = makeRepo(t)
    const real = fs.realpathSync(root)
    const identity = projectId(root)
    assert.equal(identity.remote, null)
    assert.equal(identity.name, path.basename(real))
    assert.equal(identity.id, `${slug(path.basename(real))}-${hash8(real)}`)
})

test('a file:// remote falls back to the path hash', t => {
    const root = makeRepo(t, undefined, 'file:///Users/someone/repo')
    const real = fs.realpathSync(root)
    const identity = projectId(root)
    assert.equal(identity.remote, null)
    assert.equal(identity.id, `${slug(path.basename(real))}-${hash8(real)}`)

    // Two different checkouts of the same local path are different projects, which
    // is exactly what a path-based identity means.
    const other = makeRepo(t, 'other', 'file:///Users/someone/repo')
    assert.notEqual(projectId(other).id, identity.id)
})

test('the id does not change when a copy of the repo moves, remote-first', t => {
    const inside = makeRepo(t, 'a')
    const outside = makeRepo(t, 'b', 'git@github.com:owner/repo.git')
    assert.notEqual(projectId(inside).id, projectId(outside).id)
    runGit(inside, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'])
    assert.equal(projectId(inside).id, projectId(outside).id)
})

test('resolveProjectId walks up to the work-tree root and returns null outside a repo', t => {
    const root = makeRepo(t, undefined, 'git@github.com:owner/repo.git')
    const nested = path.join(root, 'a', 'b')
    fs.mkdirSync(nested, { recursive: true })

    const resolved = resolveProjectId(nested)
    assert.ok(resolved !== null)
    assert.equal(resolved.root, fs.realpathSync(root))
    assert.equal(resolved.id, projectId(root).id)

    assert.equal(resolveProjectId(tmpDir(t)), null)
})

test('mergeProject keeps both ids and writes atomically', t => {
    const root = makeRepo(t)
    const first = { id: 'one-11111111', name: 'one', path: '/tmp/one', remote: null }
    const second = {
        id: 'two-22222222',
        name: 'two',
        path: '/tmp/two',
        remote: 'github.com/owner/repo',
    }

    assert.equal(mergeProject(root, first).added, true)
    assert.equal(mergeProject(root, second).added, true)

    const projects = readProjects(root)
    assert.deepEqual(Object.keys(projects).sort(), ['one-11111111', 'two-22222222'])
    assert.deepEqual(projects['one-11111111'], {
        name: 'one',
        path: '/tmp/one',
        remote: null,
    })
    assert.deepEqual(projects['two-22222222'], {
        name: 'two',
        path: '/tmp/two',
        remote: 'github.com/owner/repo',
    })

    const onDisk = JSON.parse(fs.readFileSync(projectsJsonPath(root), 'utf8'))
    assert.deepEqual(onDisk, projects)
    assert.equal(fs.existsSync(`${projectsJsonPath(root)}.tmp`), false)
    assert.equal(fs.existsSync(path.join(root, '.git', 'pi-memory.lock')), false)
    // projects.json and its temp file are gitignored (§3.1), so registering a
    // project never shows up as an uncommitted note.
    assert.equal(runGitOut(root, ['status', '--porcelain']), '')
})

test('mergeProject updates a moved path without losing other entries', t => {
    const root = makeRepo(t)
    mergeProject(root, { id: 'one-11111111', name: 'one', path: '/tmp/one', remote: null })
    mergeProject(root, { id: 'two-22222222', name: 'two', path: '/tmp/two', remote: null })

    const updated = mergeProject(root, {
        id: 'one-11111111',
        name: 'one',
        path: '/tmp/moved',
        remote: null,
    })
    assert.equal(updated.added, false)

    const projects = readProjects(root)
    assert.equal(projects['one-11111111'].path, '/tmp/moved')
    assert.equal(projects['two-22222222'].path, '/tmp/two')
})

test('readProjects tolerates a missing or corrupt file', t => {
    const root = makeRepo(t)
    assert.deepEqual(readProjects(root), {})

    fs.writeFileSync(projectsJsonPath(root), '{not json')
    assert.deepEqual(readProjects(root), {})

    fs.writeFileSync(projectsJsonPath(root), '["nope"]')
    assert.deepEqual(readProjects(root), {})

    fs.writeFileSync(projectsJsonPath(root), '{"id":{"name":"n","path":"/p","remote":null}}')
    assert.deepEqual(readProjects(root), { id: { name: 'n', path: '/p', remote: null } })
})
