# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Persistence**: Interrupted or failed runs survive under `~/.pi/agent/subagents/` with a subagent id
- **Resume**: Continue a persisted run in the same conversation (`resume: "<id>"`, single mode)
- **Recoverable abort**: Interrupting the parent returns an error tool result with partial output, not an exception

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

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task, resume? }` | One agent, one task; `resume` continues a persisted run |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

The extension also registers the `subagent_inspect` tool and the `/subagents` command —
see [Persistence & Resume](#persistence--resume).

## Persistence & Resume

Every invocation (single task, chain step, or parallel task) gets a UUIDv7 subagent id and
runs with `--session ~/.pi/agent/subagents/<id>.jsonl`, so the child's transcript survives
the parent process.

**Artifacts** — in `~/.pi/agent/subagents/`, created with directory mode `0700` (session
files contain full tool output, potentially secrets):

| File | Contents |
|------|----------|
| `<id>.jsonl` | pi session file, written by the child |
| `<id>.meta` | JSON sidecar (mode `0600`): agent, task, model, thinking level, startedAt, sha256 `promptHash` of the agent system prompt; updated on close with status, stopReason, exitCode, and the session header id |
| `<id>.pid` | Child pid, present while the child is running |

- **Retention**: a clean success deletes all three files — the output already lives in the
  parent's tool result. Aborted/failed/killed runs persist until resumed to completion or
  manually deleted (`rm ~/.pi/agent/subagents/<id>.*`; `/subagents` lists what is there).
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
- **Ctrl+C does not abort subagents** (it clears the editor / exits the session instead).
- Children that fail or are killed externally produce the same failure report. The behavior
  is uniform across modes: chain stops at the failing step; parallel tasks each get their
  own failure report and id.

### Resuming

```
subagent { agent: "scout", task: "<continuation instruction>", resume: "<id>" }
```

- Single mode only — `resume` alongside `tasks`/`chain` is rejected.
- The child is spawned with `--session <same path>`, which continues the existing
  conversation (not `--resume`, the interactive picker flag, which is unusable headless).
  The `task` text is the continuation instruction.
- The original run's model and thinking level are re-passed from the meta sidecar; if the
  original run recorded no model, the current dispatch model (or the child's default) is
  used, noted in the tool result.
- Guards, in order:
  1. The session file must exist — otherwise the error lists the available persisted ids
     (completed runs are cleaned up).
  2. The pidfile must not belong to a live process — a stale pidfile (parent crashed before
     cleanup) is auto-removed and the run is treated as interrupted.
  3. The meta sidecar must be readable — missing or corrupt sidecars refuse the resume.
  4. `agent` must match the original run — a different agent means a different system
     prompt and toolset.
  5. The agent definition's `promptHash` must match — a changed agent file is refused with
     a suggestion to start a fresh delegation.
- Each resume increments `resumedCount` in the sidecar (shown by `subagent_inspect`).

### Inspecting runs: `subagent_inspect`

`subagent_inspect { id, limit? }` reports status, agent, task, model, usage, and the last
`limit` transcript entries (default 20; entries render like the collapsed view).

- `id` may be the exact filename id or a unique prefix (ambiguous prefixes list the matches).
- Status is `running` (via the pidfile), `aborted`, `failed`, or `unknown` (no meta sidecar).
  Successful runs are deleted on completion, so a bare id with no artifacts is
  indistinguishable from a completed run — its output is in the parent's tool result.
- Works on still-running children (the JSONL is appended incrementally) — useful for
  debugging a stuck subagent.
- Torn final lines (child killed mid-append) and unknown entry types are skipped.

### Listing runs: `/subagents`

List-only: short id (first 8 characters), agent, status, session size, and a task preview,
with a footer showing the inspect/resume/delete hints. There is no interactive delete — by
design, `subagent_inspect` covers the model and `rm` covers the user.

### Live view: `/subagents attach [id]`

Attaches to a **running** subagent and takes over the editor region with a live transcript
replayed from the subagent's in-memory ring buffer (last 500 renderable events), so
late-attaching shows recent history.

- **Resolution**: with an id, exact or unique-prefix match against running subagents
  (ambiguous prefixes list the matches). Without an id, attaches when exactly one
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
  arrow keys still scroll, printable keys never do.
- **Detach**: `Esc` returns to the parent editor; the subagent keeps running.
- **Auto-detach**: the view closes by itself when the subagent finishes
  (`agent_settled`) or its process exits (watchdog kill, crash, abort — the parent's abort
  path SIGTERMs the child, which fires the same process-exit detach).
- Requires an interactive session (`attach` is unavailable in print mode).
- **Single subagent only**: parallel/chain runs spawn through the same registry but
  `attach` is designed for the single mode view for now.

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

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
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

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
- **Chain mode**: Stops at the first failing step and reports which step failed
- **Parallel mode**: The batch is not rejected; each failed task gets a per-task summary
  with its own id and resume hint

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- **L1 — resume inherits the original cwd**: pi reads the session's working directory from
  the JSONL header, so a resumed child runs in the original project's context even when
  resumed from a different parent cwd
- **L2 — agent prompt is re-read at resume**: the original run's temp prompt file is deleted
  after the run; resume re-reads the agent's markdown file. The `promptHash` guard detects a
  changed prompt and refuses the resume
- **L3 — recovery is per-`message_end`**: partial output survives only up to the last
  completed message; a run interrupted during its first message persists no transcript
