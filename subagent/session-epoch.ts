// pi caches extension factories per cwd, so this module is evaluated once per
// process and its state survives session replacement. Session-scoped state must
// therefore be advanced explicitly, never assumed to reset on re-evaluation.
let sessionEpoch = 0

export function currentSessionEpoch(): number {
    return sessionEpoch
}

export function advanceSessionEpoch(): void {
    sessionEpoch++
}

export function isCurrentSessionRun(runEpoch: number): boolean {
    return runEpoch === sessionEpoch
}
