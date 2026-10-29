/**
 * One rendering of a caught value, for every layer that logs or reports one.
 *
 * Six copies of `err instanceof Error ? err.message : String(err)` meant a single
 * `String(err)`-only site could print `[object Object]` into a warning that names no
 * cause, and nothing would catch it — the reports are read by a human, not asserted.
 */

export function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
