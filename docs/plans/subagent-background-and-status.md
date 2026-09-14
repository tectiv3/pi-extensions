# Subagent: background runs + footer status

Spec for two features in the `subagent` extension:

1. **Background mode** — `subagent { agent, task, background: true }` returns immediately; the
   child keeps running; the parent LLM is notified on completion and pulls the full result via
   a new `subagent_collect` tool.
2. **Footer status** — running subagents (with live elapsed time) and uncollected background
   results are shown in the pi footer via `ctx.ui.setStatus`.

"Rejected" notes record alternatives that were considered and dismissed; open items that
cannot be settled from code are collected in §5 (verification checklist).

---

## 1. Background mode

### 1.1 Semantics

- `background: true` is a new optional boolean on the existing `subagent` tool schema
  (`SubagentParams`). Same tool, same dispatch path, different wait policy. A separate
  `subagent_bg` tool was rejected (schema duplication, two near-identical tools for the model).
- **Single mode only.** `background` alongside `chain` or `tasks` is rejected with a clear
  error result (a backgrounded batch would need batch-level completion semantics — out of
  scope).
- **Print mode rejected.** `background: true` with `ctx.mode === 'print'` returns an error
  result: the one-shot parent exits right after the reply, SIGTERMing the child, and there is
  no notification channel. The model should use the blocking foreground call instead.
- **Detached from the parent's abort.** No abort-signal listener is wired for backgrounded
  children (the foreground `signal` → `killProc` path at the spawn site is skipped). Escape in
  the parent does not kill background work.
- **Killing** uses the existing paths, no new mechanism: `/subagents abort [id]` and the
  manager view's `x` key (both SIGTERM the registry entry's proc). A killed background run
  settles through the same completion path as any other (see 1.3) — the model is notified of
  the kill as a failure.
- **Session-scoped lifetime.** Live runs (foreground and background) are killed on session
  teardown. `pi.on('session_shutdown')` (`reason: quit | reload | new | resume | fork`)
  SIGTERMs every `activeSubagents` child, drops the drain timer/queue and
  `backgroundResults`, clears the footer slot, and sets a `sessionTearingDown` flag so the
  killed runs' settlements emit no completion notification. This is required, not cosmetic:
  pi reloads and rebinds extensions on session replacement, which drops the module-level
  registries — a surviving child would be an untracked orphan. A `process.on('exit')` hook
  is kept as well, because pi's `uncaughtException` path calls `process.exit` without
  disposing the runtime, so `session_shutdown` is not emitted on a crash (and the on-quit
  kill is idempotent across both hooks). A backgrounded run does not outlive the session or
  the parent (a true "detach" — survive + file-persisted result + orphan reaping — is a
  documented future feature, not in scope).
- **Stall watchdog unchanged** (300s silence default): a stalled backgrounded child is
  killed and settles as a failure like any other.
- **Relay UI unchanged:** `confirm`/`select`/`input` requests from a backgrounded child are
  still relayed to the parent TUI via the existing mutex relay.
- **Concurrency:** no new cap. Backgrounded runs and foreground runs coexist; the parallel
  batch cap (8 tasks / 4 concurrent) is unchanged and unrelated.
- **Id-supersession rule (resume collision).** Resumed runs reuse the original id
  (`runSingleAgent` uses `resume?.id`; verified: `resolveResumeTarget` accepts an exact or
  unique-prefix id, resolves it to the full run id, and returns that — `registerActiveSubagent`
  re-registers under it). Any spawn — background or foreground, tool or
  `/subagents resume` — for an id that has a `backgroundResults` entry **deletes the stale
  entry at registration time** (right at `registerActiveSubagent`, inside `runSingleAgent` —
  NOT at the top of the function: the pre-spawn early returns — unknown agent, prompt-file
  write failure — run BEFORE `registerActiveSubagent` and must not consume the stale report
  while no RUNNING entry exists; a spawn *error* — `proc.on('error')`, e.g. ENOENT — fires
  asynchronously AFTER registration, so the run did register and did fail, and consuming the
  stale entry there is correct — do not "fix" supersession to skip it on spawn errors).
  The delete is unconditional and idempotent at registration (no
  footer/manager side effect of its own; the footer shows running runs only — see 2). A
  **backgrounded resume stores a fresh entry** at settlement like any backgrounded
  run (the model must be notified of its completion); only the *non-background* resume paths
  (tool resume without `background`, `/subagents resume`) skip the sink — their completions
  already have their own handling (tool result; "finished"/"keeps running" notices). No
  completion notification is emitted for the superseded stale entry itself.
  Without this rule, `subagent_collect <id>` would return the stale failure report while the
  resumed run is actively running.
  A `subagent_collect` on a re-running (resumed) id hits the running branch (lookup checks
  `activeSubagents` first — see 1.2.4) and returns "still running".
- **Relay questions on detached runs.** A backgrounded child's `confirm`/`select`/`input`
  requests are relayed as today, but with three differences the caller must know: (1) the relay
  has **no abort source** — the foreground path aborts the relay on the tool-call AbortSignal,
  which background runs deliberately don't have; the relay stays open until the user answers
  or dismisses the dialog (the stall watchdog is paused while `relayPending`, same as
  foreground); (2) the TUI fallback calls the **spawn-time tool ctx's** `ctx.ui` after the tool
  call has returned — see the verification checklist. The rc (`pi-rc`) relay path is ctx-free
  and unaffected;
  (3) **cross-child mutex hold** — the relay is a process-wide FIFO mutex
  (`acquireRelayMutex`), and a child's `relayPending` flag is set only AFTER the mutex is
  acquired: while a backgrounded dialog sits unanswered, every OTHER child's relay
  (foreground or background) queues behind it, and a queued child's stall watchdog keeps
  running — a foreground run whose question waits >300s behind a backgrounded dialog can be
  killed by its own watchdog. There is no per-dialog timeout; the only release is the user
  answering/Esc on that specific dialog.

### 1.2 Result delivery (push + pull)

The chosen model: **push notification on settlement + pull via `subagent_collect`.**
Rejected: pull-only (an idle model never retrieves the result) and push-only with full
output (transcript bloat, no re-fetch).

#### 1.2.1 Spawn (tool result returned immediately)

`subagent { agent, task, background: true }` resolves as soon as the child is spawned and
registered (the existing `onSpawned` point). Tool result text:

```
Background subagent <shortId> started (agent: <agent>).
Task: <task preview>
You'll be notified when it completes. Call subagent_collect { id: "<fullId>" } for the result;
subagent_inspect { id: "<shortId>" } for progress.
```

`details` reuses `SubagentDetails` with mode `'single'` and an empty `results` array — the
same shape the existing invalid-params paths already return, so renderers are unaffected.

**Spawn-bridge (pinned).** The background branch of `execute()` cannot await
`runSingleAgent` (that would block until child exit — the point of the feature is that it
does not). It reuses the bridge pattern from `handleSubagentsResume`: a spawn promise
resolved by whichever of these fires first —
1. the `onSpawned` callback (today passed `undefined` in single-mode dispatch; this branch
   supplies the first single-mode user),
2. the floating run promise **resolving** with a pre-spawn failure — the unknown-agent
   early return (verified: it RESOLVES with a failure result, exitCode 1),
3. the floating run promise **rejecting** — a prompt-file write failure REJECTS (verified:
   `writePromptToTempFile` throws on `mkdtemp`/`writeFile` failure and the enclosing `try`
   has only a `finally`, so the run promise rejects with the raw error before
   `onSpawned`), or
4. a **5s timeout** (`RESUME_SPAWN_TIMEOUT_MS` 15s is too long for a returns-immediately
   tool; spawn + registration are synchronous, so 5s is pure insurance).

On (2) the tool returns the real failure (`formatFailureReport` of the pre-spawn result) —
NOT the spawn text; on (3) it returns an error result carrying `err.message`; on (4) it
returns an error result ("spawn did not confirm within 5s"). The discriminator for (2)/(3)
needs no result inspection: if the run promise has settled while the bridge is still open,
spawn must have failed (a successful spawn resolves the bridge via `onSpawned` first).
The floating run promise is `.catch`-guarded in `execute` (the guard lives on the floating
promise here, mirroring the resume handler, while per-step containment stays in the sink):
on rejection, IF THE BRIDGE IS STILL OPEN → settle it with the error (the tool returns the
real failure); if the bridge is already closed (spawn confirmed; this is defensive —
post-spawn failures resolve through the close path, not the reject path) → debug log
only, never a UI notify (the tool has already returned; the sink's own error containment
is the only reporting channel).

#### 1.2.2 Settlement sink

Today `runSingleAgent` computes the final `SingleResult` after the exit promise resolves,
cleans up files, and returns it to the awaiting tool call. For backgrounded runs the tool
call has already returned, so the caller stores the result instead:

- New module-level registry: `backgroundResults = new Map<string, { result: SingleResult; settledAt: number }>()`.
  (Not the `activeSubagents` registry — that entry is unregistered at process close by the
  existing `proc.on('close')` handler, and a settled record has no proc. A separate map keeps
  `ActiveSubagent` semantics intact.)
- On settlement the caller:
  1. stores `result` in `backgroundResults` (success **and** failure — the failure carries
     the existing failure report: partial output, stopReason, exitCode),
  2. pushes the completion notification (1.2.3),
  3. refreshes the footer status (2) — running runs only; the uncollected result itself has no
     UI (see 2.3).
  Removal from `backgroundResults` happens only in `subagent_collect` or at registration-time
  supersession (1.1), never in the sink.
- **Store order / invariant.** Verified code sequence: the close handler runs
  `unregisterActiveSubagent` synchronously, then `safeResolve`; `runSingleAgent`'s post-exit
  section is the `await` continuation — a microtask after both. The sink is invoked
  synchronously inside that post-exit section (no awaits between `unregisterActiveSubagent`
  and the sink call; do not insert any). The window between unregister and store is
  microtask-only — no external callback can observe it. Invariant: at every observable
  moment a background run is in exactly one of {RUNNING (in `activeSubagents`), READY (in
  `backgroundResults`)} — no neither-window, **and no both-window**: the store step begins
  with a defensive `unregisterActiveSubagent(id)` (idempotent `Map.delete`), because the
  exit-fallback path (close lags exit by >3s — grandchild holding a stdio pipe; the code's
  documented scenario) resolves the promise WITHOUT the close handler having unregistered,
  which would otherwise leave the id in both maps (collect would report a settled run as
  "still running").
- **Error containment.** The sink runs from process callbacks (including during parent
  shutdown, when the exit handler's SIGTERM can fire close events) with no awaiting tool
  call: every step is independently try/catch-guarded (a notify failure must not lose the
  store, a refresh failure must not lose the notify), the whole promise chain has an explicit
  `.catch` → debug log + best-effort failure settle. Store-before-notify ordering IS the
  shutdown containment: a `sendUserMessage` that throws mid-shutdown is caught by its own
  guard and the stored result survives (there is no consumer for a queued turn anyway).
  Do NOT rely on an "exiting" flag — `process.on('exit')` fires after the event loop has
  closed, i.e. after (or never before) the child close callbacks this guards; the flag would
  be unobservable at the moment it is needed.
- **Retention: in-memory only.** File cleanup stays exactly as today (success → all three
  files deleted at settlement; failure/abort → persisted for resume). Rejected: deferring
  file cleanup until collect (mode-dependent cleanup rules, new "succeeded" entries in
  `/subagents`, orphan-file policy). Consequence (documented limitation): if the parent exits
  before collect, an uncollected result is lost — same class of loss as today's exit-kill.
  Note the result contract for implementers: for a successful background run the transcript
  files are deleted at settlement and the full output lives **only in the `backgroundResults`
  Map** (plus the 2000-char notification truncation). Do not "fix" the cleanup to keep files
  — that would break the success-cleanup contract the rest of the extension relies on.
- `subagent_collect` removes the entry from `backgroundResults` when it delivers a settled
  result (the entry leaves the in-memory ready set; there is no manager/footer UI for it).

#### 1.2.3 Completion notification

`pi.sendUserMessage(text, { deliverAs: 'followUp' })` (the `pi` ExtensionAPI is captured in
module scope alongside `eventBus`; `deliverAs: 'steer'` was rejected — mid-turn injection
disrupts in-flight reasoning and followUp is visible next turn anyway).

- Success:
  ```
  Background subagent <shortId> (<agent>) finished.
  <final output, truncated to INSPECT_FINAL_OUTPUT_CAP (2000) chars>
  <usage line: turns/tokens/cost/ctx via the existing formatUsageStats>
  Call subagent_collect { id: "<fullId>" } for the full result.
  ```
- Failure/abort/kill: failure summary (stopReason/exitCode, stderr tail) + resume hint
  (`/subagents resume <shortId>`), mirroring `formatFailureReport`.

- **Coalescing (mechanism pinned):** settlements enqueue a per-id block and ensure a
  **100ms `setTimeout` drain** (`unref()`ed) is pending; the drain emits ONE followUp for
  all blocks enqueued since the last drain. Queue semantics are pinned so a burst cannot
  drop a notify: the **enqueue** step pushes the block and arms the timer if (and only if)
  no drain is pending; the **drain** step synchronously snapshots the queue into a local
  array AND clears it BEFORE awaiting `sendUserMessage`. A block enqueued while the drain
  is mid-`sendUserMessage` therefore goes to a FRESH drain (the enqueuer sees no pending
  drain and arms a new timer) — it is never merged late, dropped, or double-counted.
  (Untested SDK behavior: whether two followUps queued in the same tick would coalesce or
  double-trigger turns — coalescing removes that dependency.)
  Why a timer at all: a microtask or `setImmediate` flush would batch nothing — each
  child's `close` is its own macrotask (separate poll phase) and `setImmediate` runs in the
  check phase of the SAME poll, so run A's flush would fire before run B's close is even
  delivered. A 100ms timer crosses polls, so kill-sweeps and same-wave watchdog kills
  (N closes within ms of each other) → one message, and the model can issue N parallel
  `subagent_collect` calls in one turn. Completions >100ms apart each get their own message
  — the documented fallback, N turns for N spread-out completions. Each per-id block
  (success or failure) is self-contained with its full id and hint, so batching is purely
  cosmetic; the 100ms latency on every completion is imperceptible.
- The notification text always carries the **full id** (collect/resume hints) — for the model
  it is the only id source.
- Shutdown: see the sink error-containment rule (1.2.2) — the notification is try/catch-
  guarded; a throw mid-shutdown cannot drop the stored result (store-before-notify ordering).

#### 1.2.4 `subagent_collect` tool

New registered tool:

```
subagent_collect { id: string }
```

- Resolves `id` (exact or unique short prefix — the same id-resolution convention the
  tool's `resume` param and `/subagents resume` now share, but against in-memory maps)
  against the **union `activeSubagents` ∪ `backgroundResults`**, running branch first — a
  READY-only id is resolvable; only ids in NEITHER map are unknown (the error result lists
  short ids from both maps). The running branch resolves exact/unique-prefix against `activeSubagents`
  keys only (like `resolveAttachTarget`) — NEVER via the file-based `resolveInspectTarget`,
  whose "indistinguishable from a successfully completed run" error message is wrong for a
  running id. (This is also how a resumed run's id reports "still running" instead of its
  superseded stale entry.) It does not cover persisted runs from other sessions
  (`subagent_inspect` and `/subagents resume` cover those) and not foreground runs (their
  result is already in the parent's tool result).
- **Still running → returns immediately** (non-blocking; the owner rejected blocking-until-
  settled). Rendering reuses `buildSubagentInspectReport(id, limit)` — the same report
  `subagent_inspect` renders for a running run (status, agent, task, usage so far, transcript
  tail; add an elapsed line if desired) — not a parallel renderer (two renderers for the
  same content will drift). The model may simply continue working; the completion
  notification is the primary trigger.
- **Settled →** renders from the stored `SingleResult` (never from disk — the files are
  already gone for successes): full final output (capped at `PER_TASK_OUTPUT_CAP`, 50KB, as
  foreground results are; reuse `truncateParallelOutput` for the cap note, with its
  "tool details" wording adjusted — collect has no separate tool-details payload), status,
  usage; failures return the failure report (`formatFailureReport` — not `isError`; a
  reported failure is a normal answer, matching how inspect treats failures). Removes the
  entry from `backgroundResults` (no footer/manager refresh — the footer shows running runs
  only).
- **Unknown id →** error result listing the short ids of the **union** of both maps
  (`activeSubagents` ∪ `backgroundResults`, deduped by id) + hint that persisted runs live
  in `/subagents`.

### 1.3 Failure matrix (backgrounded runs)

| Event | Path | Notification |
|---|---|---|
| Normal completion (`agent_settled` → clean exit) | settlement sink, success | success notice |
| LLM error in child (stopReason error) | settlement sink, failure | failure + resume hint |
| Stall watchdog kill | close → sink, failure | failure (stall noted in stderr/diagnostics) |
| Parent Escape | **no effect** (detached) | — |
| `/subagents abort <id>` / manager `x` | close → sink, failure | failure (killed) |
| Parent process exit | exit handler SIGTERM (unchanged) | lost with the process (documented) |
| Session switch/fork/reload (`session_shutdown`) | SIGTERM live children + drop state | none (suppressed; the run belonged to the old session) |
| Resume of this id (tool or `/subagents resume`) | registration-time supersession | none for the stale entry; the resume path's own handling applies |

---

## 2. Footer status

### 2.1 Content

`ctx.ui.setStatus('subagent', text)` (key namespaced like the rc extension's); cleared with
`undefined` when nothing is active.

Format:

```
⏳ 5: scout 1:23, worker 0:41, +3
```

- `⏳ <total>: <agent> <elapsed>, …` — the leading number is the TOTAL running count; the
  agent/elapsed pairs are a sample (from `activeSubagents`, excluding settled) capped at 3,
  elapsed via the existing `formatElapsedMs`.
- Up to **3** agent/elapsed pairs; extras collapse to `+N`.
- Example line: `⏳ 1: scout 0:42`.
- Print mode: `refreshSubagentStatus` gates on `ctx.hasUI`/mode (2.2) and skips the
  `setStatus` call entirely — no host-level no-op is assumed or required. (Background is
  rejected in print mode anyway, so this path mainly serves foreground spawns.)

### 2.2 Updates

- **Event-driven:** spawn, settlement (→ running−1), abort/kill, and the timer tick.
  Invariant: **every path that mutates `activeSubagents` ends in a `refreshSubagentStatus`
  call** (spawn → running+1; settlement → running−1; abort → via the close handler).
  `backgroundResults` (the collect buffer) is invisible to the footer, so its mutations do not
  refresh it. The 10s tick is the safety net, not the primary refresh.
- **Timer:** a single module-level interval (10s — same cadence as `STALL_CHECK_INTERVAL_MS`)
  that re-renders elapsed times. Started when the running count goes 0 → >0, stopped (and the
  status cleared) as soon as the running count reaches 0. The timer is `unref()`ed.
- **Every refresh is a full idempotent recompute** of the running set from `activeSubagents` —
  no incremental deltas; that is how stale clears happen when refreshes interleave.
- The stop/clear (timer stop + `setStatus(undefined)`) is evaluated inside every refresh; a
  ready-only state keeps neither the line nor the tick.
- `refreshSubagentStatus` gates on `ctx.hasUI`/mode itself (existing code gates UI calls this
  way), so callers need no per-mode branching.
- The owner chose live elapsed over event-only updates, accepting the standing timer.

### 2.3 Manager view (`/subagents`) — READY UI dropped

The planned READY section was dropped (owner decision): `backgroundResults` is an internal
collection buffer for `subagent_collect`, not a user-facing list, so no stored-result renderer,
no `inspectReady` action, and no PERSISTED-duplicate hint are needed. Consequences:

- The manager keeps RUNNING + PERSISTED exactly as before. RUNNING rows already cover
  backgrounded runs and drop out when the child closes via the existing proc-close re-scan.
- A failed/aborted background run still appears in PERSISTED (its files survive failure) and
  is inspectable/resumable from disk like any other persisted run.
- A successful settled-uncollected run has no manager row; it is surfaced only by its
  completion notification.
- The `subagent:status` `eventBus` channel (settled/collected/superseded) that existed only to
  drive this view's re-render is removed as dead code. The separate high-frequency
  `subagent:event` channel (consumed by rc) is untouched.

---

## 3. Implementation notes (single file: `subagent/index.ts`)

- `SubagentParams`: add `background: Type.Optional(Type.Boolean())` with a description that
  tells the model when to use it (long-running work; result arrives as a notification; fetch
  via `subagent_collect`). Update the tool `description` accordingly.
- `runSingleAgent` gains a `background?: boolean` (or a settle-callback param): when set,
  skip the abort-signal wiring; the exit-promise post-processing is unchanged; **the sink is
  invoked from inside the post-exit section (store first, per 1.2.2's invariant), not from a
  floating `.then` in the caller** — the caller only returns the spawn text. The foreground
  path is untouched. The whole background branch is `.catch`-guarded (1.2.2 error
  containment).
- Pre-existing quirk, do NOT "fix" as part of this change: the abort-path SIGKILL
  escalation `setTimeout(5000)` (foreground only — background runs skip signal wiring
  entirely) is not `unref()`ed and can keep the event loop alive up to 5s during shutdown.
  Out of scope; only relevant if a later change touches the abort path.
- Supersession (1.1): inside `runSingleAgent`, at the `registerActiveSubagent` point —
  if the subagentId (which for resumes is the resumed id) is in `backgroundResults`, delete
  it there (NOT at the top of the function: pre-spawn early returns must not consume the
  stale report). The delete is idempotent and has no footer/manager side effect.
- `execute()` in the `subagent` tool: after the existing validation, branch on
  `params.background` — validate single-mode + non-print-mode, then the **spawn bridge**
  (1.2.1): `onSpawned` callback + floating run promise resolving with a pre-spawn failure +
  5s timeout → return the spawn text (or the real failure / timeout error). The background
  dispatch must pass the tool call's `toolCallId` through to `runSingleAgent`'s trailing
  `toolCallId` param (like the chain/parallel/single dispatches do) so the meta sidecar
  records it — omitting it would break the rc server's attach-by-toolCallId correlation for
  backgrounded runs.
- New tool registration block for `subagent_collect` (params: `id`, mirroring
  `SubagentInspectParams`'s id handling and prefix resolution; running branch reuses
  `buildSubagentInspectReport`).
- `backgroundResults` map + `settleBackgroundRun(result, ...)` (the sink: defensive
  `unregisterActiveSubagent` → store → coalesced notify enqueue → status refresh; every step
  independently guarded) + `refreshSubagentStatus(ctx)` (full
  idempotent recompute; the stop/clear — timer stop + `setStatus(undefined)` when
  running reaches 0 — is part of EVERY refresh, not a lifecycle callers manage).
  `pi`/`ctx` capture follows the existing module-scope pattern (`eventBus`,
  `currentPiSessionId`): a module-level **latest-ctx slot**, updated at the same entry
  points that already call `capturePiSessionId` (tool `execute` + the command handlers —
  the existing capture sites), and a module-level `pi` capture. `refreshSubagentStatus`
  and the coalesced notification run from child callbacks, so they use the latest-ctx
  slot, falling back to the run's own spawn ctx (held by the sink) if the slot is empty.
  Do NOT hold only the spawn ctx: a background run that settles while no foreground tool
  is running must still be able to refresh the footer via the newest available ctx.
- Coalescing: a 100ms `setTimeout` (unref) drain queue that batches nearby settlements
  into one `sendUserMessage` (1.2.3).

## 4. Limitations (documented in README)

- Uncollected background results are lost when the parent process exits (in-memory retention;
  a successful run's full output exists only in the `backgroundResults` Map after settlement).
- Uncollected background results have no UI: after settlement the footer shows running runs
  only and the manager lists RUNNING/PERSISTED, so an uncollected result is visible only in
  the completion notification and retrievable only via `subagent_collect`.
- Backgrounded runs do not survive the parent process or a session replacement (`/new`,
  `/resume`, `/fork`, `/reload`): live runs are SIGTERM'd on `session_shutdown` (no true
  detach).
- Background is single-mode only; no backgrounded parallel batches or chains.
- `subagent_collect` covers runs of the current process (running or settled-uncollected);
  persisted runs from other sessions are out of its scope.
- A backgrounded child blocked on a relayed question has no auto-cancel — the dialog stays
  open until answered/dismissed (stall watchdog paused meanwhile, as in foreground).

## 5. Verification checklist (main agent, during/after implementation)

Unverified-SDK or cross-component behaviors the design rests on. Each must be observed once
on the target box before the feature is declared done:

1. **`pi.sendUserMessage(followUp)` from a child `close` callback** (outside any pi turn
   context, while the parent is idle; while the parent is streaming an unrelated turn; while
   the parent is blocked in a foreground `subagent` tool call): delivered, queued correctly,
   no throw, no double turn.
2. **Relay via a completed tool call's ctx** (the spec's §1.1 relay note): backgrounded child
   fires `ask_user_question`-style confirm/select while the parent is (a) idle, (b) mid
   unrelated turn → dialog appears and the answer reaches the child; Esc dismisses cleanly.
3. **`setStatus` slot persistence:** the slot survives turn boundaries until cleared; the
   `subagent` slot coexists with the rc extension's slot without clobbering.
4. **RPC-mode parent** (background allowed — only print is rejected): followUp + setStatus
   behave (or are documented no-ops); if broken, tighten the mode guard.
    (Not applicable to this deployment: the owner drives sessions via the rc phone client,
    not `pi --mode rpc`; revisit only if RPC mode is adopted.)
5. **Coalescing:** two backgrounded runs killed in one sweep (closes <100ms apart) →
   exactly one followUp message listing both ids; one turn collects both. Two completions
   seconds apart → two messages (the documented fallback). Also: a single completion's
   notification latency is ~100ms (the drain), not a hung/lost message.
6. **Spawn bridge:** (a) `background: true` with an unknown agent → the tool returns the
   unknown-agent failure immediately (not the spawn text, not a hang); (b) normal spawn →
   spawn text returns within ms, child keeps running.
7. **Store-invariant:** (a) kill a backgrounded run and immediately `subagent_collect` — it must
   return the settled failure, never "still running"; (b) exit-fallback
   path — a child whose grandchild holds a stdio pipe (close lags exit >3s): while settled,
   the id must not appear in both `activeSubagents` and `backgroundResults` and collect must not say "still running"
   (the defensive unregister at store is the fix; verify it). On this path the store and the
   completion notification may land up to ~3s after exit (the fallback timer is what resolves
   the promise) — assert the bound and that the notify FIRES, not zero latency.
8. **Supersession:** (a) fail a backgrounded run, leave the entry uncollected, resume the
   same id via the tool (non-background) → the stale entry is gone at registration, collect
   on the running id says "still running" (not the stale failure); (b) a **backgrounded resume** (`background: true` + `resume`) settles into a
   fresh `backgroundResults` entry and its notification fires.
9. **Stale-ctx status path:** `ctx.ui.setStatus` through the module-level ctx captured on an
   EARLIER (already-returned) tool call — i.e. the sink's own refresh, not just the
   relay-ctx dialog of item 2 — updates the footer for as long as the parent session lives;
   if the host rejects a completed tool call's ctx, fall back to the rc relay path or drop
   the live-elapsed tick (degrade to event-driven only) — decide then, not during.
10. **Session switch with an in-flight background run** (`switchSession`/`newSession`/
    `fork`/`reload`): the run is SIGTERM'd on `session_shutdown`, the footer slot is
    cleared, and no completion notification fires for it. Verify: `/new` with a run in
    flight → the child process is gone (`ps`), the footer is empty, no follow-up arrives.
11. **Cross-child relay mutex hold:** with a backgrounded dialog open, a second child's
    relay queues behind it; the queued child's stall watchdog keeps running (its
    `relayPending` is set only after the mutex) — observe the queued behavior and that
    answering/Esc on the first dialog releases the queue.

### Verification status (observed 2026-09-14)

Results from the manual verification pass on the target box:

- **1 — follow-up delivery:** PASS. Delivered as its own turn when the parent was idle;
  queued and drained at run end when the parent was mid-turn (no drop, no double turn).
- **2 — relay via a completed tool ctx:** PASS. A `ctx.ui.confirm` from a background child
  surfaced while the parent was idle and while mid-turn; the answer reached the child
  (`confirm result: true`) and Esc cancelled cleanly (`confirm result: false`). Exercised
  with a temporary probe tool (the relay forwards only `select`/`confirm`/`input`);
  `ask_user_question` reaches the same path via its RPC-mode `select`/`input` fallback.
- **3 — `setStatus` slot:** PASS. `⏳ <n>: <agent> …` while running, cleared on settle;
  `subagent_collect` does not touch the slot (the footer is running-only).
- **5 — coalescing:** PASS. Two closes within ms (direct SIGTERM sweep) produced one
  follow-up listing both ids; completions seconds apart arrived as separate turns.
- **6 — spawn bridge:** PASS. Normal spawn returns the spawn text in ms; `background: true`
  with an unknown agent returns the real failure immediately, not the spawn text.
- **7a — kill store-invariant:** PASS. After a kill, `subagent_collect` returns the settled
  failure, never "still running".
- **8 — supersession:** PASS. A backgrounded resume deleted the stale entry at registration
  (collect on the running id said "still running"); the resumed run settled into a fresh
  entry and notified.
- **9 — stale-ctx status path:** PASS. Sink-driven refreshes updated the footer through the
  captured completed-tool ctx.
- **10 — session switch:** PASS. `/clone` with a live background run: the child was
  SIGTERM'd (`exitCode: 143`), its `.pid` removed and failure artifacts persisted, the
  footer cleared, and no completion notification fired.
- **11 — cross-child relay mutex:** PASS for serialization: with two background children
  prompting, exactly one dialog showed at a time (A, then B after A was resolved).
- **4 — RPC-mode parent:** not applicable to this deployment (the owner drives sessions via
  the rc phone client, not `pi --mode rpc`).
- **7b — exit-fallback store:** code-verified only. The fallback is unreachable in practice
  (pi reaps the child's process tree, so a `sleep`-style grandchild cannot hold the pipe
  past exit); the defensive `unregisterActiveSubagent` is the sink's first step, so the
  both-maps state the item guards against cannot occur.
- **11 (stall-watchdog nuance)** — unobserved: verifying that a child queued behind a held
  relay keeps its stall watchdog running requires an unanswered dialog held >300 s.

## 6. Out of scope / future

- True detach (survive parent exit, file-persisted result, orphan reaping in a later session).
- Backgrounded parallel/chain batches.
- A model-facing kill tool (users have `/subagents abort`; the model doesn't need one here).
- Auto-collect heuristics (e.g. auto-deliver full output when under a size threshold).
