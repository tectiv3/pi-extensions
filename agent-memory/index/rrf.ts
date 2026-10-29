/**
 * Reciprocal rank fusion (§4): `score(d) = Σ 1 / (k + rank_i(d))`, ranks starting
 * at 1, `k = 60`. `k` is the RRF smoothing constant, not a result count — it is what
 * keeps the top hit of one list from dominating the other list's agreement.
 *
 * A document found by both lists scores twice, so it outranks any document found by
 * only one — that agreement, not the raw BM25 or L2 magnitudes, is the signal the
 * fusion exists to expose.
 */

export const RRF_K = 60
export const DEFAULT_LIMIT = 10

export interface FuseOptions<T> {
    /** The RRF constant. */
    k?: number
    limit?: number
    /**
     * How to read a note id out of a result. Defaults to `item.id`; vector results
     * carry `note_id`, so a caller fusing those passes `hit => hit.note_id`.
     */
    id?: (item: T) => number
}

export interface Fused<T> {
    item: T
    score: number
}

interface Entry<T> {
    item: T
    score: number
    /** Best (lowest) rank across the input lists; the deterministic tie-break. */
    bestRank: number
}

export function fuse<T>(
    bm25Results: readonly T[],
    vectorResults: readonly T[],
    options: FuseOptions<T> = {}
): Fused<T>[] {
    const k = options.k ?? RRF_K
    const limit = options.limit ?? DEFAULT_LIMIT
    const id =
        options.id ??
        ((item: T) => {
            const value = (item as { id?: unknown }).id
            if (typeof value !== 'number') {
                throw new TypeError('fuse: result has no numeric id; pass options.id')
            }
            return value
        })

    const entries = new Map<number, Entry<T>>()
    const add = (items: readonly T[]): void => {
        items.forEach((item, index) => {
            const noteId = id(item)
            const rank = index + 1
            const contribution = 1 / (k + rank)
            const entry = entries.get(noteId)
            if (entry === undefined) {
                entries.set(noteId, { item, score: contribution, bestRank: rank })
                return
            }
            entry.score += contribution
            entry.bestRank = Math.min(entry.bestRank, rank)
        })
    }
    add(bm25Results)
    add(vectorResults)

    return [...entries.values()]
        .sort(
            (a, b) => b.score - a.score || a.bestRank - b.bestRank || id(a.item) - id(b.item)
        )
        .slice(0, Math.max(0, limit))
        .map(entry => ({ item: entry.item, score: entry.score }))
}
