# pi-extensions

pi coding-agent extensions, TypeScript, loaded directly by pi (no build step).

- **`subagent/`** — subagent tool: delegates tasks to specialized agents with isolated context
  windows. Single and chain modes; persistence and resume of interrupted runs;
  background runs with notifications; live attach and steering of running subagents.
- **`ask-user-question/`** — structured question tool: single- and multi-question prompts with
  typed option pages, tabbed navigation for multiple questions, `allowOther` free-text option,
  and remote answer relay (answers can arrive from the mobile companion via the `rc` extension).
- **`index/`** — index tool: shells out to the shared `idx` binary (maki-style) to return a compact
  source-file skeleton (imports, types, signatures with `[start-end]` line ranges) or directory
  listing, so the model can `read` with offset/limit only the sections it needs. Resolves the
  binary via `IDX_BIN` → PATH → `~/.local/bin/idx`; when absent, the tool fails
  with an install hint, and appends a use-`index`-first system-prompt nudge only when the binary
  is found and the tool is active.
- **`multi-opencode-go/`** — manual failover switch for the `opencode-go` provider:
  `/opencode-switch` toggles outgoing requests between pi's primary key and a second failover
  key from `auth.json["opencode-go-failover"]`. No usage polling, cooldowns, or automatic
  rotation. Adapted from
  [pi-multi-opencode-go](https://github.com/huaxel/pi-multi-opencode-go) (MIT).
- **`smart-fold/`** — transcript compaction: finished thinking collapses to one
  `Thought for 12.4s` line (click to expand; live thinking shows a scrolling tail plus elapsed
  time), `bash` rows hide their output while collapsed (errors stay visible), `read`/`grep`/
  `find`/`ls` keep pi's 10-line preview, and `write`/`edit` keep pi's content preview with a
  `+N -M` stat appended to the header (`/fold writecollapsed header` reduces them to the header
  line). Folding is display-only — nothing changes in the conversation sent to the model. `/fold`
  opens a settings picker; settings are session-only. Vendored from
  [`@clapecho233/pi-smart-fold`](https://www.npmjs.com/package/@clapecho233/pi-smart-fold) (MIT)
  with its on-disk config file removed and collapsed-row behaviour retuned.
- **`simplify/`** — `/simplify` command: reviews changed code for clarity, consistency, and
  maintainability, scoped to changed line ranges. Default scope is everything unpushed plus
  uncommitted and untracked changes; `--ref=<git-ref>` diffs against another base, `--staged`
  limits to the index, and file paths narrow the scope. Filters vendored, generated, lock, and
  binary files. Adapted from
  [pi-simplify](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify) (MIT).

## Diffs from the pi examples

**`subagent/`** is a fork of the
[subagent example](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent)
from pi-mono, extended well beyond it. The example provides: isolated subprocess per
subagent, streaming output, markdown rendering, per-agent usage tracking,
Ctrl+C abort propagation (the parallel mode the example shipped was removed here). Added here:

- **Persistence & resume** — interrupted or failed runs persist under `~/.pi/agent/subagents/`
  with a subagent id; `resume: "<id>"` continues a persisted run in the same conversation.
  Resume inherits the original cwd, re-reads the agent prompt (guarded by a `promptHash`
  check), and recovers partial output up to the last completed message.
- **Recoverable abort** — aborting returns an error tool result with partial output instead
  of an exception.
- **RPC-mode children** — subagents run in pi's RPC mode with stdin task delivery and a live
  registry. This is the architectural change that makes attach/steering possible; the example
  spawns plain child processes that can only be streamed and killed.
- **Attach** — `/subagents` manager view with a live transcript per subagent (manual scroll
  window, ring-buffered stream events); resume respawns a persisted run and auto-attaches.
- **Steering** — the attach view accepts steering input; steers queue as pending lines and
  are delivered to the running child mid-task.
- **Per-subagent abort** — from the manager view.
- **Question relay** — a subagent's own `ask_user_question` call is relayed to the parent,
  so a child can ask the user questions through the parent's tool.
- **Background runs** — `background: true` returns immediately and leaves the child running
  detached from parent Escape; completion is delivered as a coalesced notification
  (settlements within 100 ms arrive as a single turn) and the full result is fetched with
  `subagent_collect`.
- **Running-subagents footer** — the pi footer shows live running subagents
  (`⏳ <n>: <agent> <elapsed>`) while any run is in flight.

**`ask-user-question/`** is a fork of the
[questionnaire example](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts)
(a unified single/multi-question tool; pi also ships a simpler
[question example](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/question.ts)),
consolidating an earlier single-question tool into it. Added here:

- **Singleton shape** — one pending ask at a time; Esc aborts through its signal; the pending
  ask survives `/reload`.
- **Remote answers** — pairs with the `rc` extension (kept in the openclient-llm repo): a
  pending ask can be answered from the mobile companion; the TUI waits on the remote client
  answer instead of blocking on the terminal.
- **Question relay** — a subagent's ask call is relayed to the parent (see above), so
  children can ask the user questions too.

## Install

Symlink each extension directory into your agent dir:

```sh
ln -s "$PWD/subagent" ~/.pi/agent/extensions/subagent
ln -s "$PWD/ask-user-question" ~/.pi/agent/extensions/ask-user-question
ln -s "$PWD/index" ~/.pi/agent/extensions/index
ln -s "$PWD/simplify" ~/.pi/agent/extensions/simplify
ln -s "$PWD/smart-fold" ~/.pi/agent/extensions/smart-fold
ln -s "$PWD/multi-opencode-go" ~/.pi/agent/extensions/multi-opencode-go
```

Type-checks against host pi package stubs in `types.d.ts`; see `AGENTS.md` for the check
commands and baseline rules.
