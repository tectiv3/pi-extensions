import assert from 'node:assert/strict'
import test from 'node:test'

import { type Fused, DEFAULT_LIMIT, RRF_K, fuse } from './rrf.ts'

interface Row {
    id: number
}

function ids(entries: readonly Fused<Row>[]): number[] {
    return entries.map(entry => entry.item.id)
}

test('results found by both lists outrank results found by one', () => {
    const fused = fuse([{ id: 1 }, { id: 2 }, { id: 3 }], [{ id: 4 }, { id: 2 }, { id: 1 }], {
        limit: 10,
    })

    assert.deepEqual(
        ids(fused)
            .slice(0, 2)
            .sort((a, b) => a - b),
        [1, 2]
    )
    assert.deepEqual(
        ids(fused)
            .slice(2)
            .sort((a, b) => a - b),
        [3, 4]
    )
    // Agreement beats a single first place: 1/61 + 1/63 > 1/61.
    assert.ok(fused[0].score > 1 / (RRF_K + 1))
})

test('a rank-1 hit in one list scores 1 / (k + 1)', () => {
    const fused = fuse([{ id: 7 }], [], { limit: 10 })
    assert.equal(fused.length, 1)
    assert.equal(fused[0].item.id, 7)
    assert.ok(Math.abs(fused[0].score - 1 / (RRF_K + 1)) < 1e-12)
})

test('limit is applied after fusion order', () => {
    const bm25 = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const vector = [{ id: 4 }, { id: 2 }, { id: 1 }]

    const fused = fuse(bm25, vector, { limit: 2 })
    assert.equal(fused.length, 2)
    assert.deepEqual(
        ids(fused).sort((a, b) => a - b),
        [1, 2]
    )
    assert.equal(fuse(bm25, vector).length, 4)
    assert.deepEqual(fuse(bm25, vector, { limit: 0 }), [])
})

test('the default limit is 10', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ id: index + 1 }))
    assert.equal(DEFAULT_LIMIT, 10)
    assert.equal(fuse(rows, []).length, 10)
})

type Bm25Row = { id: number; key: string }
type VectorRow = { note_id: number; distance: number }
type Hit = Bm25Row | VectorRow

test('fuses vector hits through an id accessor', () => {
    const bm25: Bm25Row[] = [
        { id: 1, key: 'a' },
        { id: 2, key: 'b' },
    ]
    const vector: VectorRow[] = [
        { note_id: 2, distance: 0.1 },
        { note_id: 3, distance: 0.2 },
    ]

    const fused = fuse<Hit>(bm25, vector, {
        limit: 3,
        id: hit => ('id' in hit ? hit.id : hit.note_id),
    })
    assert.deepEqual(
        fused.map(entry => ('id' in entry.item ? entry.item.id : entry.item.note_id)),
        [2, 1, 3]
    )
})

test('ties break deterministically by best rank, then id', () => {
    assert.deepEqual(ids(fuse([{ id: 5 }], [{ id: 6 }], { limit: 2 })), [5, 6])
    assert.deepEqual(ids(fuse([{ id: 6 }], [{ id: 5 }], { limit: 2 })), [5, 6])
})

test('empty input fuses to nothing', () => {
    assert.deepEqual(fuse([], []), [])
})
