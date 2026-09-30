import assert from 'node:assert/strict'
import test from 'node:test'
import {
    advanceSessionEpoch,
    currentSessionEpoch,
    isCurrentSessionRun,
} from './session-epoch.ts'

test('session epoch advances so stale runs are rejected', () => {
    assert.equal(currentSessionEpoch(), 0)
    assert.equal(isCurrentSessionRun(0), true)

    advanceSessionEpoch()

    assert.equal(currentSessionEpoch(), 1)
    assert.equal(isCurrentSessionRun(0), false)
    assert.equal(isCurrentSessionRun(1), true)
})
