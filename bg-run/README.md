# bg-run

Background shell jobs for pi: `bg_run`, `bg_list`, `bg_kill`, and a steering message that wakes the
agent when a job finishes. `/bg` prints the job list.

Forked from [pi-bg-run](https://github.com/huanhc1311/pi-bg-run) (MIT, huanhc1311) as a starting
point. The widget, panel, persistence and per-project sharing were dropped.

## Lifecycle

- A job is a detached `sh -c` process group, logging to `$TMPDIR/bg-run/<pid>/<start>/<id>.log`.
- Jobs belong to the session that started them. `session_shutdown` (quit, `/reload`, session
  replacement) stops them all. A job killed this way never wakes the next session.
- A process `exit` hook sends SIGTERM to live groups when pi dies without `session_shutdown`.
- `bg_kill` sends SIGTERM to the group, then SIGKILL after 10 seconds, and returns once the job has
  exited.
- At most 10 jobs run at once. Settled jobs stay listed until 50 newer ones push them out.

## Paseo control service

`globalThis[Symbol.for('pi-extensions:bg-run:control')]`, version 1. The symbol string is the
contract; the types are exported from `index.ts`.

| Member | Behavior |
|---|---|
| `list()` | This session's jobs: `id`, `label`, `command`, `status`, `startedAt` (epoch ms), `capabilities` (`['stop']` while running). |
| `stop(id)` | Same path as `bg_kill`. Resolves after the job exits; `{ ok: false, reason }` for unknown or settled ids. |
| `subscribe(listener)` | Called after every start and settle. Returns an unsubscribe. |
