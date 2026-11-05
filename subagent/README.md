# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **One delegation level**: Children are spawned with `--exclude-tools` for the subagent tools, so a subagent cannot delegate further
- **Streaming output**: See tool calls and progress as they happen
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Persistence**: Interrupted or failed runs survive under `~/.pi/agent/subagents/` with a subagent id
- **Resume**: Continue a persisted run in the same conversation (`resume: "<id or unique suffix>"`, single mode)
- **Recoverable abort**: Interrupting the parent returns an error tool result with partial output, not an exception
- **Steering**: `subagent_steer { id, message }` queues a correction for a running foreground or background run; it is delivered at the child's next turn boundary, never as an interruption (see [Steering a running run](#steering-a-running-run-subagent_steer))
- **Background runs (default)**: a single-mode call with `background` omitted or `true` returns immediately, leaving the child running; completion is delivered as a notification and fetched with `subagent_collect`. Pass `background: false` for a foreground run that waits for the result. A running foreground single run can also be converted mid-flight from `/subagents` (`b`)
- **Running-subagents footer**: the pi footer shows live running subagents (`⏳ <n>: <agent> <id> <elapsed> <turns>t ↓<output>`, elapsed refreshed every 10s, counters per turn)

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool always prompts for confirmation before running
project-local agents from an untrusted repository.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Sequential workflow
```
First have scout find the read tool, then have planner suggest improvements using the scout result
```

Each step is a separate `subagent` call: run one, then pass its result in the next call's
`task`.

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task, resume? }` | One agent, one task; `resume` continues a persisted run, and there `agent` is optional (the run's recorded agent is used). Runs in the background by default |
| Foreground single | `{ agent, task, background: false }` | Waits for the result; the tool call blocks until the child settles |
| Background single | `{ agent, task }` or `background: true` | Returns immediately; result delivered by notification, fetched via subagent_collect |

The extension also registers the `subagent_inspect`, `subagent_collect`, and
`subagent_steer` tools and the `/subagents` command — see
[Persistence & Resume](#persistence--resume) and
[Steering a running run](#steering-a-running-run-subagent_steer).

**Delegation is one level deep.** Every child is spawned with `--exclude-tools`
listing `subagent`, `subagent_inspect`, `subagent_collect`, and `subagent_steer`, so
subagents cannot themselves delegate or steer a sibling. The denylist is applied after
`--tools`, so it holds for agents without `tools:` frontmatter too — those would
otherwise inherit the full default toolset. Nesting is hard-blocked, not merely
discouraged by a prompt.

## Per-dispatch model

A dispatch can name the child's model explicitly, so agent files stay model-agnostic
instead of one file per `(agent, model)` pair:

```
subagent { agent: "scout", task: "find the auth code", model: "anthropic/claude-haiku-4-5" }
```

`model` takes a `provider/model-id` string, the same form pi uses on the command line.
Precedence, highest first:

| Source | Scope | Applies when |
|--------|-------|--------------|
| dispatch `model` | this call | always wins |
| agent frontmatter `model:` | every run of that agent file | no dispatch model |
| parent session model | the default for all dispatches | neither of the above |

A frontmatter pin is a **per-agent default**, not the agent's identity — an explicit
dispatch model overrides it.

An empty or whitespace-only `model` is rejected — it is not treated as "no override".

**Thinking level.** The child inherits the parent's thinking level only when the resolved
model equals the parent session model. A model chosen by dispatch override or by an agent
pin that differs from the parent means an explicit model choice, so the child uses its own
default thinking level. (`thinking` is not a tool parameter; this rule is derived.)

**Resume.** A resume without `model` re-passes the recorded model and thinking level from
the meta sidecar, exactly as before. A resume **with** `model` overrides the recorded model and
re-derives the thinking level by the rule above; the note about this appears in the foreground
result, the background completion notification, and `subagent_collect`. When the override
equals the recorded model, the note says only that the thinking level was re-derived. The
sidecar's `model` is rewritten to the resolved model on every spawn, so it always records
the run's **last** model: resuming twice, the second time without `model`, continues on the
model the override-resume used.

**Unknown models are not validated client-side** — the child pi process is the source of
truth. An unknown provider (`nope/nope`) makes the child exit immediately, and the run is
reported failed. A known provider with an unknown model id (`anthropic/does-not-exist`)
only makes pi fabricate a fallback model with a warning: the child starts and may fail
later, when a request is made.

## Persistence & Resume

Every invocation gets a UUIDv7 subagent id. A spawn-time
background run is spawned with
`--session ~/.pi/agent/subagents/<id>.async/transcript.jsonl`, inside its
retention-managed run directory, which exists before the child starts writing.
Foreground runs use `--session ~/.pi/agent/subagents/<id>.jsonl`; a run the user
sends to the background mid-flight keeps that same legacy path, because its child already
has the file open.

**Artifacts** — in `~/.pi/agent/subagents/`, created with directory mode `0700` (session
files contain full tool output, potentially secrets):

| File | Contents |
|------|----------|
| `<id>.jsonl` | pi session file for foreground runs, and for runs runtime-backgrounded mid-flight |
| `<id>.async/transcript.jsonl` | pi session file for spawn-time background runs; lives in the retention-managed directory |
| `<id>.async/status.json` | tracker payload written at spawn and settlement (see [Async settlement notice](#async-settlement-notice)) |
| `<id>.meta` | JSON sidecar (mode `0600`): agent, task, model, thinking level, startedAt, sha256 `promptHash` of the agent system prompt, and the spawning `subagent` tool call id (absent for non-tool spawns such as `/subagents resume`); updated on close with status, stopReason, exitCode, and the session header id |
| `<id>.pid` | Child pid, present while the child is running |

Readers resolve a run's transcript from its id: `<id>.async/transcript.jsonl` when it
exists, else `<id>.jsonl`. No mode flag is threaded through inspect, resume, delete, size
formatting, or the session-header read.

- **Retention**: a foreground success deletes its transcript and `.meta` — the
  output already lives in the parent's tool result. A spawn-time background success
  deletes `.meta` and `.pid` but **keeps** `.async/transcript.jsonl`: the run directory
  owns it now, and the 30-day retention sweep deletes the directory and transcript
  together. That holds for any success on the run-directory transcript, including a
  foreground resume of a background run. Aborted/failed/killed runs persist until resumed
  to completion or manually deleted (`rm -r ~/.pi/agent/subagents/<id>.*`; `/subagents`
  lists what is there) — except runs that went to the background: those have a run
  directory, so the sweep deletes them once they are 30 days idle, `.meta`, `.pid` and
  any legacy `<id>.jsonl` included.
- **Resume needs a transcript**: a run with a `.meta` but no transcript (it never wrote
  one, or retention removed it) is refused with "nothing to continue" instead of
  starting an empty session.
- **Inspect after success**: a successful run on the run-directory transcript has no
  `.meta`; `subagent_inspect` takes its status and agent from `status.json` and reports
  task and model as unknown.
- The directory sits outside the per-project sessions tree, so subagent runs never appear
  in the `/resume` picker.
- **Recovery granularity**: pi creates the session file only at the child's first
  `message_end`. A run interrupted during its first message persists no transcript — there
  is nothing to inspect or resume, and the failure report says so. Expected behavior, not
  a bug.

### Aborting

- **Escape** (`app.interrupt`) aborts the running subagent: the child process is killed and
  the tool returns a recoverable **error tool result** — not an exception — with the partial
  output up to the last `message_end`, the subagent id, and a resume hint.
- **Every abort escalates**: each run owns an abort source, and the kill sequence is SIGTERM,
  then SIGKILL if the child is still alive 5 seconds later. `/subagents abort <id>` and the
  manager's `x` key abort a child the same way, foreground or background — a background run
  has no parent abort signal, but it does have its own abort source, so it is not a special
  case.
- **Ctrl+C does not abort subagents** (it clears the editor / exits the session instead).
- Children that fail or are killed externally produce the same failure report. The behavior
  is uniform across foreground and background runs: a failed or aborted run reports its
  partial output, id, and a resume hint.

### Resuming

```
subagent { agent: "scout", task: "<continuation instruction>", resume: "<id>" }
```

- The id may be exact or a unique suffix (same semantics as `subagent_inspect`): an exact
  id resolves across sessions, a suffix is scoped to this pi session; ambiguous suffixes
  are refused with a list of candidates.
- The child is spawned with `--session <same path>`, which continues the existing
  conversation (not `--resume`, the interactive picker flag, which is unusable headless).
  The `task` text is the continuation instruction.
- The original run's model and thinking level are re-passed from the meta sidecar; if the
  original run recorded no model, the current dispatch model (or the child's default) is
  used, noted in the foreground result, the background completion notification, and
  `subagent_collect`. Passing `model` at resume overrides the recorded model —
  see [Per-dispatch model](#per-dispatch-model).
- Guards, in order:
  1. The id must resolve — exact id with a readable meta sidecar, or a unique suffix among
     this session's persisted runs; otherwise the error lists the available persisted ids
     (completed runs are cleaned up).
  2. The pidfile must not belong to a live process — a stale pidfile (parent crashed before
     cleanup) is auto-removed and the run is treated as interrupted.
  3. `agent` is optional and defaults to the run's recorded agent; a given one must match
     it — a different agent means a different system prompt and toolset.
  4. The agent definition's `promptHash` must match — a changed agent file is refused with
     a suggestion to start a fresh delegation.
- Each resume increments `resumedCount` in the sidecar (shown by `subagent_inspect`).

### Inspecting runs: `subagent_inspect`

`subagent_inspect { id, limit? }` reports status, agent, task, model, usage, and the last
`limit` transcript entries (default 20; entries render like the collapsed view).

- `id` may be the exact filename id or a unique suffix (ambiguous suffixes list the matches).
- Status is `running` (via the pidfile), `aborted`, `failed`, or `unknown` (no meta sidecar).
  Successful runs are deleted on completion, so a bare id with no artifacts is
  indistinguishable from a completed run — its output is in the parent's tool result.
- Works on still-running children (the JSONL is appended incrementally) — useful for
  debugging a stuck subagent.
- Torn final lines (child killed mid-append) and unknown entry types are skipped.

### Collecting results: `subagent_collect`

`subagent_collect { id }` fetches the result of a background run. `id` may be exact or a
unique suffix, resolved against running runs first, then settled-uncollected results held
in memory for this process. See [Background Runs](#background-runs) for the notification
that announces a settlement.

- **Running** → returns immediately (non-blocking) with the same status/progress report
  `subagent_inspect` renders.
- **Settled** → renders the in-memory result: status and agent, the full final output
  (capped at 50KB), and usage; a failure renders the failure report — a reported failure
  is a normal answer, not a tool error. The entry is removed after collection.
- **Unknown id** → error listing the available short ids; persisted runs from other
  sessions use `subagent_inspect` / `/subagents resume`.

Scope is the current process only (running runs, or settled results not yet collected).

### Steering a running run: `subagent_steer`

`subagent_steer { id, message }` writes a steering message to a running child's stdin
(RPC `steer`). `id` is exact or a unique suffix, resolved against running runs first and
settled background results second (ambiguous suffixes list the matches; an unknown id
errors). It works on foreground and background runs.

What the tool actually guarantees, and nothing beyond it:

- **Queued, not applied**: the message is accepted by the transport and delivered at the
  child's **next turn boundary** — after the tool call it is running now finishes, before
  its next LLM request. A long `bash` call keeps running; nothing is preempted.
- **It does not undo anything**: an edit the child already committed stays committed, and
  the correction only affects what the child does next.
- **The effect is unverified**: the result says "queued" because that is all the parent
  observed. Whether the child reads it, obeys it, or finishes before the boundary arrives
  is invisible to the caller — verify the outcome with `subagent_inspect` /
  `subagent_collect` rather than assuming the correction landed.
- **It is not a safety mechanism**: steering cannot stop a run from doing damage, cannot
  cancel a tool call, and is not a substitute for a careful brief.
- **Refusals**: a run that has settled or is settling is refused (its last turn boundary
  has passed) with a hint to collect the result or resume; a failed stdin write is reported
  as a tool error, never swallowed.
- **Reachability**: a foreground `subagent` tool call blocks the parent's turn, so in
  practice this tool reaches **background** runs (the default, or runtime-backgrounded).
  A foreground run is steered by the human through `/subagents attach` — same write, same
  turn-boundary semantics.
- The watchdog is unaffected: a steer resets the activity timer, so a queued steer cannot
  cause a silent kill, and it cannot keep a genuinely dead child alive.

**Prefer abort + resume when the run is already wrong.** Steering is a forward-only nudge.
If the child has committed the wrong edit, spent its budget on the wrong approach, or is
stuck in a tool call, a queued message will not help: abort it (`/subagents abort <id>`, or
Escape for a foreground run) and resume with a corrected brief —
`subagent { agent, task, resume: "<id>" }` keeps the conversation and replaces the
instruction. The same applies to a run that has stopped: restart with a corrected plan
rather than trying to steer a finished run.

### Listing runs: `/subagents`

Opens the interactive manager view (TUI): RUNNING rows — short id (last 8 characters),
agent, elapsed time, a `bg` badge on runtime-backgrounded runs — above PERSISTED rows
(status). Keys on a running row: `Enter/a` attach, `b` background (foreground,
`background: false` single-mode runs only — see [Runtime backgrounding](#runtime-backgrounding)), `x` abort,
`i` inspect; on a persisted row: `Enter/r` resume, `d` delete, `i` inspect; `Esc/q`
closes. Print mode keeps the plain text report.

### Live view: `/subagents attach [id]`

Attaches to a **running** subagent and takes over the editor region with a live transcript
replayed from the subagent's in-memory ring buffer (last 500 renderable events), so
late-attaching shows recent history.

- **Resolution**: with an id, exact or unique-suffix match against running subagents
  (ambiguous suffixes list the matches). Without an id, attaches when exactly one
  subagent is running; otherwise lists the running short ids.
- **View**: assistant text as Markdown, thinking blocks dimmed and truncated (200 chars),
tool calls formatted like the parent TUI, tool output truncated (200 chars). Streaming
  `message_update` frames are not rendered — the completed message supersedes them.
- **Scrolling**: `↑/↓`, `PageUp/PageDown`, `Home/End`. The view follows the newest output
  and suspends the pin while you scroll up (`End` jumps back to live).
- **Steering**: anything you type goes into the `› ▌` input row at the bottom of the view.
  `Enter` sends the line to the subagent as a steering message (it lands in the child's next
  turn); `Backspace` edits the line; pastes are supported (bracketed-paste markers are
  stripped and newlines/tabs flattened to spaces). The sent line shows up in the transcript
  as a muted `‹you› ...` marker once the child accepts it. Scroll keys are unaffected —
  arrow keys still scroll, printable keys never do. This is the same write `subagent_steer`
  performs, with the same semantics: queued for the next turn boundary, not applied.
- **Detach**: `Esc` returns to the parent editor; the subagent keeps running.
- **Auto-detach**: the view closes by itself when the subagent finishes
  (`agent_settled`) or its process exits (watchdog kill, crash, abort — the parent's abort
  path SIGTERMs the child, which fires the same process-exit detach).
- Requires an interactive session (`attach` is unavailable in print mode).

## Background Runs

`subagent { agent, task }` — `background` omitted, or `background: true` — spawns a single
run detached from the parent tool call and returns immediately with the spawn text (short
id, task preview, and the full id plus `subagent_collect` / `subagent_inspect` hints).
The child keeps running. This is the default for single mode; `background: false` opts
into a foreground run that waits for the result.

- **Print mode is always foreground** — `ctx.mode === 'print'` forces foreground because
  the parent exits before a detached child could settle. There is no notification
  channel in print mode, so the blocking call is the only working shape there.
- **Detached from the parent's abort** — Escape does not kill a background child. Kill it
  with `/subagents abort <id>` or the manager view's `x` key; a killed run settles as a
  failure notification. Both paths use the same kill sequence as a foreground abort:
  SIGTERM, then SIGKILL if the child is still alive after 5 seconds — so a child stuck
  inside a long tool call (the usual reason a steer did not help) still dies.
- **Relayed questions** (`confirm`/`select`/`input`) still reach the parent TUI, but there
  is no parent abort source: the dialog stays until the user answers or dismisses it (the
  stall watchdog is paused while the relay is pending). A request that carries rpc's
  `timeout` — `ask_user_question` in a child sets it to its remaining question budget —
  closes the dialog at that deadline instead.
- **Concurrency** is unchanged — there is no separate cap, and background and foreground
  runs coexist.
- **Backgrounded resume** — a `resume` call runs in the background unless it passes
  `background: false`; either way the resumed run stores (background) or returns
  (foreground) a fresh result at settlement.
- **Id supersession** — spawning a run whose id has an uncollected background result
  deletes the stale entry at registration, so `subagent_collect` on a re-running id reports
  "still running" rather than the stale result.

### Runtime backgrounding

The `/subagents` manager view's `b` key converts a **running foreground single-mode**
run (including a foreground `resume`) to a background run mid-flight: the awaiting
`subagent` tool call returns immediately with a "sent to the background" result (same
collect/inspect hints as above), the child keeps running detached from the parent's
abort (Escape no longer kills it), streaming stops, and settlement is delivered exactly
like a spawn-time background run — completion notification plus `subagent_collect`.
The manager row stays in RUNNING with a `bg` badge. `/subagents resume` spawns and
spawn-time background runs are not convertible (`b` refuses with a notice).

### Completion notifications

On settlement (success or failure) the result is stored in memory and a notification
message is delivered to the model at the parent's next turn (after its current
assistant turn and its tool calls):

- **Success** — a header with the short id and agent, the final output truncated to 2000
  chars, the usage line, and a `Call subagent_collect { id: "<full id>" }` hint.
- **Failure** — the failure report and a resume hint instead of the output.

Settlements within 100 ms of each other are coalesced into a single notification listing
every id; settlements further apart arrive as separate turns. No notice is sent once the
result is collected or superseded; a late notice for an already-collected result says no
action is needed.

#### Async settlement notice

Alongside that model-facing notification, every settled background run appends exactly one
`subagent-notify` **session entry** (`pi.appendEntry`) to the parent transcript. A tracker
driving runs from its own UI has no tool result to read — the spawn call returned at spawn
time and this run settles later — so the notice is the only durable terminal marker it can
clear the run on.

Entries are the off-context channel, which is why the notice lives there: the host converts
any custom *message* into a user-role LLM message on the next turn regardless of its
`display` flag, while `sessionEntryToContextMessages` returns `[]` for `type: 'custom'`.
The notice is therefore persisted for replay, is not a user-role message, and costs no
context. It is visible in the TUI only through the renderer registered for the type
(`createTerminalNoticeRenderer`): status + agent and the async token collapsed, the tracker
payload verbatim on expand. A session running a pi build without that renderer shows
nothing at all.

Entry `data`:

- `agent`, `status` (`succeeded` | `failed` | `aborted`), `asyncToken`.
- `content` — the tracker text verbatim: first line
  `Background task (completed|failed|stopped): **<agent>**`, final line
  `Retention-managed async directory: <token>`.
- `notification` (optional) — `{ shortId, text }`: this run's block of the parent's
  completion notification as built at settlement. It is not a delivery receipt: the
  parent's notification batches runs settled together and drops a run whose result was
  already collected or superseded by a resume before the batch went out.

A consumer reading the parent transcript must read the entry's `data.content`; the notice is
no longer a `custom_message` entry and fires no `custom_message` event.

The token is `<agentDir>/subagents/<id>.async` — a correlation key that must be
derivable from the run id alone (a replay rebuilds it from the transcript). It is a real
directory and holds two payloads with the same correlation string. The spawn side
reports the path on the tool result's `details.asyncDir`, next to `details.asyncId` (the
full run id); a tracker keys the two together, so a drift in either half strands the run
with no error.

`status.json` in that directory is the **live channel**, for trackers that poll rather
than read a transcript:

- Written at spawn (`state: "running"`, `startedAt`, one step for the dispatched agent
  with `agent` + `status: "running"`, plus `sessionFile` naming the run's transcript from
  the first poll) and again at settlement (`state`, `endedAt`, `lastUpdate`; step status
  mirrors the run). A spawn-time background run's path is deterministic and inside the
  run directory, so it is advertised before the child creates it: the tracker retries a
  missing file indefinitely. Written atomically — temp file plus rename in the same
  directory — so a poller never reads a half-written payload. The settlement write is not
  session-scoped: it lands whatever the session epoch, since the directory it names
  belongs to the run, not to a transcript.
- `sessionFile` is only ever the run-directory transcript. A run whose child writes the
  legacy `<id>.jsonl` — runtime-backgrounded mid-flight, or a background resume of a run
  that was spawned in the foreground — omits `sessionFile` from both payloads rather than
  naming a path no tracker followed from spawn and that success cleanup deletes.
- A foreground resume of a run that has a `status.json` rewrites it terminal at
  settlement, so the file does not keep the earlier run's outcome.
- Shape: `{ runId, mode: "single", state, startedAt, endedAt?, lastUpdate, steps: [{ agent,
  status?, sessionFile? }] }`, epoch milliseconds for the timestamps.
- `state` is `running | complete | failed | stopped`; the internal outcome maps
  `succeeded → complete`, `failed → failed`, `aborted → stopped`.
- Quitting pi (and `session_shutdown` generally, plus the process `exit` hook) marks every
  run still published as `running` as `stopped` synchronously, before the children are
  killed: a quit exits in the same turn, so the killed child's own settlement never runs.
  Where the process survives (reload, new, fork) that settlement still lands and
  overwrites it. Only a hard kill of pi (SIGKILL, power loss) leaves `running` behind; the
  directory then stays until something overwrites or removes it.
- Retention: one sweep per pi process, 60 s after the extension first loads (session
  replacement does not re-evaluate the module). It looks only at
  `<agentDir>/subagents/*.async` directories, skips any run still live in this process or
  whose `<id>.pid` names a live process (another pi resuming it), keeps anything with a
  missing/unreadable `status.json` or a non-terminal state, and deletes a terminal run
  (`complete | failed | stopped | rejected`) whose newest signal (`endedAt`/`lastUpdate`,
  then the mtimes of the directory, `status.json`, and both transcript locations) is older
  than 30 days — rename aside, then `rm -r`, with `*.async.deleting-*` crash residue older
  than an hour reaped on the next pass. The whole run goes: once the directory is removed,
  its `<id>.meta` / `<id>.pid` / `<id>.jsonl` siblings are deleted too.

The `subagent-notify` entry described above remains the **durable replay channel**, and
it is what a tracker that started after the run finished has to read: the entry survives
in the parent transcript, `status.json` only outlives its directory.

Two behaviours a consumer must tolerate:

- The header always reads `Background task …`, even for a foreground run the user sent to
  the background mid-flight with the manager view's `b` key.
- A settlement arriving after `session_shutdown` writes no `subagent-notify` entry (the
  run's session epoch is stale, so the entry — the only channel that lands in a transcript —
  is suppressed). Its `status.json` **is** still written terminal (and was already marked
  `stopped` by the shutdown handler): the file names a
  run-scoped directory, not a transcript, so a tracker polling it settles instead of
  displaying the run as running, and the retention sweep still deletes the directory.

### Running-subagents footer

While subagents run, the pi footer shows
`⏳ <n>: <agent> <short-id> <elapsed> <turns>t ↓<out-tokens>, …` — up to three segments,
with extras collapsed to `+N`. Elapsed is recomputed every 10 s; the turn and output-token
counters advance on each assistant message and stay omitted until non-zero. A single
running agent also appends ` — <task preview>` (40 chars); with two or more the preview is
dropped so the counters fit.

The line clears as soon as the running count reaches 0. It shows running runs only;
settled-but-uncollected results are surfaced by the completion notification, not the footer.

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker, one subagent call per step |
| `/scout-and-plan <query>` | scout → planner, one subagent call per step |
| `/implement-and-review <query>` | worker → reviewer → worker, one subagent call per step |

## Error Handling

Failed and aborted children return error tool results (not exceptions). Whenever spawn
artifacts were persisted, the report includes the partial output, the subagent id, and a
resume hint:

- **Exit code != 0**: Failure report with stderr/diagnostics and partial output
- **stopReason "error"**: LLM error message propagated in the failure report
- **stopReason "aborted"**: Abort kills the subprocess; the report carries the partial
  output up to the last `message_end`, or states that none was persisted
- **Pre-spawn failures** (e.g. unknown agent): error result without id or hint — nothing
  was spawned or persisted
- **Swallowed persistence/parse failures**: none of these fail a run — artifact writes (dir
  setup, `.meta`, pidfile), artifact removals, tail-frame drops, unparsable child frames, and
  unreadable pid/session files. They are written to a file-only diagnostic log when
  `PI_RC_DEBUG` is set to any non-empty value (`PI_RC_DEBUG=0` enables it too) or
  `PI_RC_DEBUG_FILE=<path>` is set; the default log is `~/.pi/agent/rc-debug.log`, shared with
  the other extensions' diagnostics. Without either variable they are silent. Unparsable child
  frames are logged individually for the first 3, then only as a suppressed total at exit, so a
  frame flood cannot stall the run on sync log writes. A dropped frame can still leave a run
  marked successful with truncated output.

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- **L1 — resume inherits the original cwd**: pi reads the session's working directory from
  the JSONL header, so a resumed child runs in the original project's context even when
  resumed from a different parent cwd
- **L2 — agent prompt is re-read at resume**: the original run's temp prompt file is deleted
  after the run; resume re-reads the agent's markdown file. The `promptHash` guard detects a
  changed prompt and refuses the resume
- **L3 — recovery is per-`message_end`**: partial output survives only up to the last
  completed message; a run interrupted during its first message persists no transcript
- **L4 — background results are in-memory**: if the parent exits before `subagent_collect`,
  the result is lost (a successful foreground run's transcript files are deleted at
  settlement; a successful background run's transcript stays in its run directory but the
  result itself is not re-read from it)
- **L5 — no true detach**: backgrounded runs do not survive the parent process or a session
  replacement (`/new`, `/resume`, `/fork`, `/reload`); live runs are SIGTERM'd on session
  teardown
- **L6 — runtime backgrounding is foreground-only**: the manager's `b` key converts an
  awaiting `background: false` single run, nothing else
- **L7 — `subagent_collect` is process-scoped**: persisted runs from other sessions use
  `subagent_inspect` / `/subagents resume`
- **L8 — no parent auto-cancel for relayed questions**: a backgrounded child blocked on a
  relayed question without a `timeout` leaves the dialog open until answered or dismissed.
  `ask_user_question` sends its subagent budget as `timeout`, so those dialogs do close.
- **L9 — uncollected results have no UI**: they are visible only in the completion
  notification
- **L10 — a steer is a queued message, not a correction**: it is delivered at the child's
  next turn boundary, so it cannot interrupt a running tool call, undo a committed edit, or
  stop a run that is already off the rails. Nothing in the parent observes whether the child
  obeys it, so the tool result says only "not yet in effect"
- **L11 — a hard kill leaks the run directory**: when pi itself is SIGKILLed (or loses
  power) neither the shutdown handler nor the exit hook runs, so a background run never writes a terminal
  `status.json`, so its `running` directory and transcript stay on disk forever and are
  never swept. The sweep has no orphan reconciliation by design; remove it manually
  (`rm -r ~/.pi/agent/subagents/<id>.async`)
