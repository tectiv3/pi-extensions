# Subagent: runtime backgrounding

Spec for converting a **foreground single-mode** subagent run to a background run
mid-flight, from the `/subagents` manager view (`b` key on a RUNNING row).
Companion to [subagent-background-and-status.md](subagent-background-and-status.md)
(spawn-time backgrounding + the settlement sink), whose §1.1 pins the background
semantics this feature reuses at runtime.

---

## 1. Semantics

- `b` on a RUNNING row converts a foreground single-mode tool-call run to a
  background run mid-flight:
  - the pending `subagent` tool call resolves immediately with a "sent to the
    background" tool result (non-error) mirroring the spawn-time background text
    style — short id + agent, task preview, and the `subagent_collect` /
    `subagent_inspect` hints;
  - the child process keeps running untouched;
  - the run detaches from the parent's abort signal (Escape no longer kills it):
    the spawn-time kill listener is removed, and a pending relayed question's
    abort wiring is dropped (the dialog stays open until answered/dismissed —
    relays after the conversion behave like spawn-time background relays, no
    abort source);
  - `onUpdate` streaming stops (the tool call has returned);
  - when the child exits, the existing background settlement path runs
    (`settleBackgroundRun`: store in `backgroundResults`, coalesced completion
    notification, footer refresh) and `subagent_collect` delivers the result.
- **Eligibility: foreground single-mode tool-call runs only**, including
  foreground `resume` runs (same dispatch call site). NOT parallel tasks, NOT
  chain steps, NOT `/subagents resume` handler spawns (no awaiting tool call),
  NOT spawn-time background runs, NOT print mode. Ineligible rows get a refusal
  notice; the one-off refusal text is "background applies to foreground
  single-mode runs only".
- The manager row stays in the RUNNING section (the registry entry lives until
  the child closes) and gains a `bg` badge after the conversion. The running-row
  legend gains `b background`.

## 2. Invariants

- **Exit wins ties.** `runSingleAgent` awaits
  `Promise.race([exitCodePromise.then(…), backgroundizePromise.then(…)])` with
  the exit term FIRST in the array: when both promises are already settled,
  `Promise.race` resolves the first array element, so a child that exits at the
  same moment the user presses `b` settles through the normal exit path.
- **finalizeExit exactly once, never inline for the backgrounded path.** The
  post-exit bookkeeping (exitCode/wasAborted assignment, status computation,
  pid removal, success-cleanup vs meta rewrite, `backgrounded → settleBackgroundRun`,
  the `returning:` debug log) is factored into a local `finalizeExit(exitCode)`.
  The runtime-backgrounded branch returns the marker result
  (`{ …currentResult, runtimeBackgrounded: true }`) immediately and runs
  `finalizeExit` ONLY from the `exitCodePromise` continuation (`.catch`-guarded,
  `.finally` tmp-cleanup) — never inline.
- **resolved/settled refusal.** `backgroundize()` returns false once the exit
  promise resolved (`safeResolve` ran) or `entry.settled` arrived
  (`agent_settled` frame) — the manager reports "already finished — nothing to
  background". A second `b` on a converted row is refused by the
  `runtimeBackgrounded` idempotence guard ("already backgrounded").
- **Abort cleanup.** The spawn-time abort wiring stays keyed on the immutable
  `background` param (spawn-time decision); its listener is registered with a
  removable `abortCleanup` so `backgroundize` can detach it. Relays key their
  abort wiring on the mutable `backgrounded` copy: new relays after the
  conversion get no abort source, and a pending relay's listener is dropped via
  the hoisted `pendingRelayAbortCleanup` (the relay's own `finally` still clears
  both).
- **No streaming after return.** `emitUpdate` early-returns once `backgrounded`
  is set — harmless for spawn-time background, where `onUpdate` is undefined.
- **Spawn-time semantics bit-identical.** When `runtimeBackgroundable` is false
  (every call site except the foreground single dispatch), `backgroundize` is
  never wired and the race degrades to a `.then` over the exit promise; the
  `background` param's behavior is unchanged.
- **Tmp prompt file deferral.** The `--append-system-prompt` temp file is read by
  the child exactly once, during its boot (pi's resource loader). The
  runtime-backgrounded early return defers the temp-file cleanup to the exit
  continuation (user decision): a `b` pressed in the boot window must not delete
  the file before the child has read it — pi would otherwise append the raw path
  string as prompt text.

## 3. Rejected alternatives (user decisions)

- **Attach-view key** — the conversion is a manager-level action on the run, not
  a property of watching it; the attach view stays read/steer-only.
- **`/subagents background` subcommand** — a second surface to keep in sync with
  the manager; the manager row already encodes eligibility.
- **Parallel-task support** — a batch would need per-task conversion semantics
  and batch-level completion; out of scope (README L6 stays single-mode).

## 4. Verification checklist (main agent)

1. `npx tsc --noEmit` — no new error signatures vs `.tsc-baseline`; `npx eslint .`
   — zero warnings.
2. Foreground single run → manager `b` → the tool result returns immediately
   with the "sent to the background" text; the child keeps running (`ps`); the
   row shows the `bg` badge and stays in RUNNING.
3. Escape after the conversion does NOT kill the child (footer keeps it);
   manager `x` still kills it, and it settles as a failure notification.
4. Child exit after the conversion → coalesced completion notification fires;
   `subagent_collect` returns the full result and clears the entry.
5. `b` on a parallel task, chain step, `/subagents resume` spawn, or
   spawn-time background row → refusal notice.
6. `b` twice on the same row → "already backgrounded"; `b` on a row whose child
   just exited → "already finished"; exactly one `returning:` debug line per run
   (finalizeExit runs once).
7. Foreground `resume` run → `b` → same conversion path (spec §1.1 resumes).
8. Spawn-time `background: true` behavior unchanged (spawn text, notification,
   collect).
