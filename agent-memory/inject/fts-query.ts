/**
 * §6.2's query builder: free user text → an FTS5 `MATCH` expression that cannot
 * raise a syntax error and cannot reach a column the caller did not name.
 *
 * The safety property comes from *construction*, not from filtering afterwards. A
 * token is only ever emitted as one double-quoted FTS5 string, where every character
 * except `"` is literal and the whole thing is a phrase; operator keywords, column
 * filters (`key:`), prefix (`*`), caret (bare `^`), `-` and `(`/`)` are all removed
 * by the tokenizer because none of them can survive a run of `[^\p{L}\p{N}]`. An
 * unquoted `-rf` is `NOT rf` and `foo:bar` is "search column `foo`", which is why
 * quoting is the only form this module emits.
 *
 * `null` means "nothing searchable survived": the caller must then skip detection
 * rather than send an empty `MATCH`, which *is* a syntax error.
 */

/** §6.2's token cap. Twenty words from one message is already a long query. */
export const MAX_QUERY_TOKENS = 20
/** §6.2's query cap. The joined string, quotes and ` OR ` separators included. */
export const MAX_QUERY_CHARS = 512
/**
 * A single token is capped well below the query cap so one unbroken 2 KB "word"
 * cannot consume the whole budget and leave `null` for a message that had real
 * words after it.
 */
const MAX_TOKEN_CHARS = 64

/** FTS5 operators as bare words: quoted they are terms, but they carry no signal. */
const FTS_KEYWORDS = new Set(['and', 'or', 'not', 'near'])

/** Anything that is not a letter or a digit separates tokens — punctuation, quotes, symbols. */
const TOKEN_SEPARATORS = /[^\p{L}\p{N}]+/u

/**
 * The §6.2 pipeline: tokenize, drop what cannot help, quote, join with `OR`.
 *
 * Returns `null` only when no token survives, which is the one case where the
 * caller must not run a query at all.
 */
export function toFtsQuery(text: string): string | null {
    const tokens = tokenize(text)
    if (tokens.length === 0) return null

    const quoted: string[] = []
    let length = 0
    for (const token of tokens) {
        if (quoted.length >= MAX_QUERY_TOKENS) break
        const phrase = quoteToken(token)
        // ` OR ` is four characters; the first token has no separator in front of it.
        const next =
            quoted.length === 0 ? phrase.length : length + ' OR '.length + phrase.length
        if (next > MAX_QUERY_CHARS) break
        quoted.push(phrase)
        length = next
    }
    return quoted.length === 0 ? null : quoted.join(' OR ')
}

/**
 * Lowercased word runs of at least two characters (§6.2), split on whitespace and
 * punctuation. Case is folded here because FTS5's `unicode61` tokenizer folds it
 * anyway and a stable token list keeps the cache key of a repeated query stable.
 */
export function tokenize(text: string): string[] {
    const tokens: string[] = []
    for (const raw of text.toLowerCase().split(TOKEN_SEPARATORS)) {
        if (raw.length < 2) continue
        if (FTS_KEYWORDS.has(raw)) continue
        tokens.push(raw.slice(0, MAX_TOKEN_CHARS))
    }
    return tokens
}

/**
 * One FTS5 string literal. `tokenize` cannot emit a quote, so the doubling below is
 * not reachable today — it is here because it is the whole escape rule and this
 * function must stay total for any token it is handed.
 */
function quoteToken(token: string): string {
    return `"${token.replace(/"/g, '""')}"`
}
