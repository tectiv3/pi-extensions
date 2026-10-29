# Agent Memory — Prior Art Survey

Scope: research for a proposed pi "agent memory" extension. Facts only.
Evidence markers: `[verified]` = observed locally/read in source; `[doc]` = vendor documentation;
`UNVERIFIED` = could not confirm.

Environment: pi 1.4.0 (= `~/code/pi-mono` @ `a6a7bac86`, versions match `[verified]`), macOS arm64,
`/usr/bin/sqlite3` 3.54.0, nix-darwin + home-manager, no brew sqlite installed `[verified]`.

---

## 1. Existing pi memory extensions

### 1.1 Host capabilities pi already has

Pi has no memory/embedding primitive of its own. `grep -rn memory src/core` in
`packages/coding-agent` matches only `settings-manager.ts`, `auth-storage.ts`, `session-manager.ts`,
`export-html/index.ts`, `output-accumulator.ts` — i.e. no store, no vectors, no retrieval `[verified]`.

What it does have:

| Facility | Detail | Evidence |
|---|---|---|
| Session persistence | JSONL, one file per session, tree via `id`/`parentId`, v3 | `packages/coding-agent/docs/session-format.md:1-30` `[doc]` |
| Session location | `~/.pi/agent/sessions/--<path>--/<timestamp>_<id>.jsonl` | same, lines 9-14 |
| Session locking | none — no `lock`/`flock` primitive in `src/core/session-manager.ts` (grep: 0 hits) `[verified]` | `UNVERIFIED` whether CLI prevents two processes on one session file |
| Context files | `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` discovered per-dir | `src/core/resource-loader.ts:212` `[verified]` |
| Disable context files | `--no-context-files` / `-nc` | `src/cli/args.ts:336` `[verified]` |
| Compaction | LLM summary at `contextTokens > contextWindow - reserveTokens` (default 16384), keeps 20k recent | `docs/compaction.md:24-40` `[doc]` |
| Branch summarization | on `/tree` navigation | `docs/compaction.md:20-21` `[doc]` |
| No daemon | each `pi` process is standalone; sessions are files, not a shared DB | `docs/sessions.md`, `[verified]` no lock code |

### 1.2 Exact extension API surface

Source: `packages/coding-agent/src/core/extensions/types.ts` (2308 lines) `[verified]`.

**Inject context into a turn** — four distinct points:

```typescript
// types.ts:885 — before every LLM call; messages mutable, system messages excluded.
// Pi restores prompt/tool state after handlers return.
export interface ContextEvent { type: "context"; messages: AgentMessage[]; }

// types.ts:895 — after all `context` handlers; FULL transcript incl. system messages.
// The returned value is sent as-is: the handler owns prompt + tool declarations.
export interface ContextWithSystemEvent { type: "context_with_system"; messages: AgentMessage[]; }

// types.ts:1496 — per-run: replace system prompt and/or inject one custom message.
export interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  systemPrompt?: string;   // "Replace the complete system prompt for this turn."
}

// types.ts:1171 — rewrite or swallow user input before it becomes a run.
export interface InputEventResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: ImageContent[] }
  | { action: "handled" };
```

`resources_discover` (types.ts:725-737) can add **skill/prompt/theme paths only** — not context files,
so it is not a memory-injection path `[verified]`.

**Intercept tool calls:**

```typescript
// types.ts:1256 — discriminated union over bash|powershell|read|edit|write|grep|find|ls|custom.
// event.input is MUTABLE in place; "No re-validation is performed after mutation." (types.ts:1252)
// types.ts:1454
export interface ToolCallEventResult {
  block?: boolean;      // block execution
  reason?: string;
  terminate?: boolean;  // stop agent after this batch (only if every result in batch sets it)
}
```

Also `tool_result` (types.ts:1285-1489) which can replace `content`/`details`/`structuredContent`/
`isError`/`usage`, and observe-only `tool_execution_start|update|end` (types.ts:1094-1129).

**Add custom tools:** `pi.registerTool()` (types.ts:1675), `defineTool()` (types.ts:690),
`ToolExposure = "direct"|"model-only"|"codemode"|"deferred"|"hidden"` (types.ts:516),
`ToolDefinition.state` + `renderCall`/`renderResult` (types.ts:579-672).

**Add slash commands:**

```typescript
// types.ts:1573
export interface RegisteredCommand {
  name: string; sourceInfo: SourceInfo; description?: string;
  getArgumentCompletions?(prefix: string): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}
// types.ts:1684 — pi.registerCommand(name, opts)
```

**Per-session state:** `pi.appendEntry(customType, data)` writes a `custom` entry into the session
JSONL; `pi.registerEntryRenderer(customType, renderer)` renders it on resume; `ctx.sessionManager` is
a read-only view; `session_start` / `session_shutdown` (types.ts:755, 824) bracket the resource.
Module-scope state lives for one extension runtime only (reload replaces it — `docs/extensions.md`
"code after `await ctx.reload()` must not reuse state").

**Ask-user / permission primitives:**

```typescript
// types.ts:149-160 (ExtensionUIContext)
select(title, options, opts?): Promise<string | undefined>;
confirm(title, message, opts?): Promise<boolean>;   // opts: {signal, timeout} with countdown
input(title, placeholder?, opts?): Promise<string | undefined>;
notify(message, type?): void;
```

Plus `ctx.hasUI` (false in print/json modes), `ctx.isProjectTrusted()`, and the `project_trust`
event (types.ts:700-719) where the first extension returning `"yes"|"no"` owns the decision.
Working examples: `examples/extensions/permission-gate.ts` (in-process pattern match + `ctx.ui.select`),
`protected-paths.ts` (hard `block: true`), `timed-confirm.ts`, `project-trust.ts`,
`confirm-destructive.ts`.

**Compact hooks:** `session_before_compact` (types.ts:785, carries `preparation`, `branchEntries`,
`reason: "manual"|"threshold"|"overflow"`, `signal`), `session_compact` (798),
`session_compact_failed` (809), `ctx.compact(options)` (types.ts:314).

### 1.3 Published pi memory extensions (npm + GitHub)

Twenty-plus packages exist. All are markdown-file stores, session-transcript stores, or thin clients
to an external service; none ships an in-process vector index `[verified]` from package descriptions.

| Package | Approach | Scope tiers |
|---|---|---|
| `pi-memory` (jayzeng) | `~/.pi/agent/memory/`: `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, `notes/*.md`; optional `qmd` CLI for keyword/semantic/hybrid search + auto-embed. 7 tools. Hooks: `session_start`, `session_shutdown`, `input`, `before_agent_start` (appends to `systemPrompt`), `session_before_compact` `[verified]` (raw `index.ts` lines 1464-1638) | global (`~/.pi/agent/memory`), overridable dir; no session tier |
| `@askjo/pi-mem` (jo-inc) | same layout, `PI_MEMORY_DIR`, `PI_CONTEXT_FILES`; keyword-only search | global |
| `@amaster.ai/pi-memory` | capped `MEMORY.md` + `USER.md`, "frozen session snapshot" injected into system prompt | global + session snapshot |
| `@henryqw/pi-memory` | capped entry stores + frozen session snapshots | global + session |
| `@samfp/pi-memory` | learns corrections/preferences, injects into future conversations | global |
| `@abianbiya/lean-memory` | project-isolated: explicit global facts, per-worktree notes/tasks, scoped keyword search | global + project |
| `@kivlor/pi-memory` | git-backed cross-session memory, `[[link]]` navigation, memory_init/search/read/save | repo |
| `pi-memory-md` | "Letta-like memory management … structured markdown files in a git repository" | repo |
| `@amaster.ai/pi-memory-mem0` | mem0 backend (platform / embedded / self-hosted) + agent-callable tool | external service |
| `@neottia/pi-memory` | in-process tools from `@neottia/memory-core` | global |
| `@shanelevs/pi-memory-auto` | body + 1-3 keywords, unique keyword table injected | global |
| `@prjct.app/pi-memory` | searchable session history (incl. what compaction removed), read by id/date | session |
| `@mammothb/pi-memory` | VCC compaction via `mm-cli` | session |
| `pi-observational-memory` (elpapi42) | Observer/Reflector background model workers | session |
| `pi-vcc` (sting8k) | algorithmic (no-LLM) compactor + `vcc_recall` search | session |
| `pi-blackhole` (k0valik) | merges the two above; 3 workers, JSON config, fallback chains | session |
| `pi-optchat` (jonaslsaa) | per-profile "infinite" chat: binary tree of summaries, 512-byte lines, `zoom` tool, 128KB view | per-profile (cross-directory) |
| `signetai` (Signet-AI) | separate daemon ("Dreaming") + entity graph + compiled native binary, multi-harness | global, or team server |

URLs: `https://github.com/jayzeng/pi-memory`, `https://github.com/jo-inc/pi-mem`,
`https://github.com/elpapi42/pi-observational-memory`, `https://github.com/sting8k/pi-vcc`,
`https://github.com/k0valik/pi-blackhole`, `https://github.com/jonaslsaa/pi-optchat`,
`https://github.com/Signet-AI/signetai`, `https://www.npmjs.com/package/pi-memory`.

**Serena** is not a pi extension; it is an MCP server (`https://github.com/oraios/serena`).
Memory tools are `write_memory`, `read_memory`, `list_memories`, `delete_memory`, `rename_memory`,
`edit_memory` over files in `.serena/memories/`, with `mem:` cross-references (verified in
`src/serena/tools/memory_tools.py`). Pi can consume it via MCP (`docs/mcp.md`) `[verified]`.

**Not found:** any pi extension that owns a SQLite (or sqlite-vec) store, any that dedupe/decay
memories with embeddings computed in-process, any that gate a memory tier behind an OS-level approval.
Searches run: `gh search repos` (topic `pi-extension`, `pi-coding-agent`), `gh search code`,
`npm search pi-memory` — ~20 packages, listed above `[verified]`.

---

## 2. Cross-agent / cross-process memory systems

**mem0** — Library (OSS) plus hosted Platform; no mandatory daemon. Pipeline: LLM fact extraction →
dedupe → embed → write to three stores: SQL DB (facts + metadata/history), vector DB (embeddings),
entity store (nodes/edges); Platform adds Graph Memory. Retrieval fuses semantic, keyword, entity,
temporal signals. Tiers are flat identifiers passed by the caller — `user_id`, `agent_id`, `run_id`,
plus arbitrary metadata filters; there is no built-in global/project/session hierarchy, the app
constructs it. https://docs.mem0.ai/core-concepts/memory-types

**Letta / MemGPT** — All state (messages, reasoning, tool calls, memory blocks) in a database
(Postgres or SQLite); "memory blocks" are strings pinned into the system prompt and edited by the agent
via memory tools; blocks can be detached and shared across agents. After eviction/compaction old
messages remain retrievable via the API and retrieval tools. Runs as a stateful App Server (daemon) with
agents/messages/runs as API objects. https://docs.letta.com/guides/agents/memory

**Zep / Graphiti** — Graphiti is the OSS temporal knowledge-graph framework: episodes in, entity/edge
extraction out, bi-temporal edges with invalidation for point-in-time queries. Retrieval is hybrid —
vector similarity + BM25 full-text + graph traversal in one ranked answer, no LLM-in-the-loop rerank.
Backends Neo4j, FalkorDB, or Amazon Neptune. Scoping is one "Context Graph" per subject. Zep is the
managed service (Konig graph DB). https://help.getzep.com/graphiti/getting-started/overview

**basic-memory** — Ground truth is Markdown files with wiki-links, `observations` and `relations`
frontmatter-ish syntax; a SQLite index (default) or Postgres mirrors them, kept current by sync/watch.
Retrieval: full-text/permalink plus optional vector and optional cross-encoder rerank. Scoping via
"projects", each mapped to a directory; per-project local mode or routed to cloud. MCP server; no
daemon required for local use. https://github.com/basicmachines-co/basic-memory

**claude-mem** — Host-lifecycle hook capture (session start, prompt submit, tool use), AI compression
into observations, SQLite storage, vector search via a `uv`-installed Python component, and a
Bun-managed **worker service** (daemon) registered by the installer. Exposes 3-layer MCP search:
`search` (compact index, ~50-100 tok/result) → `timeline` (chronological context) →
`get_observations` (full detail, ~500-1000 tok/result). Project scoping is a filter dimension.
https://github.com/thedotmack/claude-mem

**LangGraph memory store** — Two layers: **checkpointers** persist per-thread graph state
(`SqliteSaver`, `PostgresSaver`, `MemorySaver`); **stores** persist application-defined data across
threads, keyed by a namespace tuple, with optional vector/semantic search. Tiers = thread (session) vs
namespace (user/org/global) chosen by the app. In-process library, no daemon.
https://docs.langchain.com/oss/python/langgraph/persistence

**Cognee** — ECL pipeline (extract → cognify → load): text becomes entities, relationships and
searchable chunks; code becomes a symbol/dependency graph. Local models (GLiNER extraction, local
embeddings) make it offline-capable; "session distillation" promotes accepted lessons into permanent
memory. Query-time retrieval selects graph, vector, or code context; pluggable graph/vector backends
(Postgres-as-graph-store is documented as a demo feature). Library + optional API server.
https://github.com/topoteretes/cognee

**Khoj** — Django application, Postgres with the `pgvector` extension (`src/khoj/database/migrations/
0003_vector_extension.py` `[verified]` via code search), semantic search over indexed documents,
agents/automations, runs as a self-hosted server (daemon) or cloud. Tiers: per-user, per-agent
knowledge bases. https://github.com/khoj-ai/khoj

**Common shape:** every system above separates *capture* (LLM extraction/compression) from *retrieval*
(hybrid ranking) and treats scope as a key predicate rather than a separate store. The ones that are
daemons (Letta, Zep, claude-mem, Khoj, Signet) are daemons because they hold a DB connection pool or
run background model work — not because retrieval needs it.

---

## 3. Concurrency precedent for a shared local SQLite store

### 3.1 WAL facts

- "only one WAL file, there can only be one writer at a time"; readers and writers do not block each
  other; checkpoints need a moment with no active reader, otherwise the WAL grows without bound.
  https://sqlite.org/wal.html (§2.2)
- WAL requires the `-shm`/`-wal` files and **write permission on the containing directory**, and it
  does not work over a network filesystem (single-host only).
- Queries — not just writes — can return `SQLITE_BUSY` in WAL mode:
  https://sqlite.org/wal.html#sometimes_queries_return_sqlite_busy_in_wal_mode
- `busy_timeout` defaults to 0: the second writer fails immediately rather than queueing.
  https://sqlite.org/c3ref/busy_timeout.html

Local measurement `[verified]`, two connections on a WAL db:

```
sqlite> pragma journal_mode=wal; create table t(x);        -- -> wal
conn1: begin immediate; insert into t values(1);
conn2: insert into t values(2);    -> OperationalError: database is locked
conn3: select count(*) from t;     -> 0   (uncommitted row invisible, read did NOT block)
files after open: a.db, a.db-shm, a.db-wal
pragma busy_timeout=5000           -> 5000 (accepted)
```

### 3.2 Extension availability

- `/usr/bin/sqlite3` 3.54.0 (Apple build) has `ENABLE_FTS3`, `ENABLE_FTS4`, `ENABLE_FTS5`,
  `ENABLE_FTS3_TOKENIZER`; `create virtual table t using fts5(x)` works `[verified]`
  (`pragma compile_options`).
- Homebrew `sqlite` is 3.54.1, keg-only, not installed here; the formula passes no FTS/compile flags,
  so FTS5 comes from whatever the upstream configure defaults enable — **UNVERIFIED** without a build.
- `sqlite-vec` (pure C, `vec0` virtual tables, float/int8/binary vectors) is packaged in nixpkgs:
  `nix eval nixpkgs#sqlite-vec.version` → `0.1.9` `[verified]`.
- Loading it requires runtime extension loading. Apple's Python `sqlite3` has **no**
  `enable_load_extension` attribute `[verified]`; `better-sqlite3` is not installed in this repo
  `[verified]`. Whether a uv-managed CPython or Node build on this host allows loading is
  **UNVERIFIED** and would need a test.
  https://github.com/asg017/sqlite-vec

### 3.3 "First process is master, others connect over a socket"

This pattern is real, but in every comparable case the daemon is **long-lived and started by an
init system or an explicit command**, not elected by whichever CLI happened to run first:

| Tool | Mechanism |
|---|---|
| ssh-agent | long-lived process, UNIX socket path exported as `SSH_AUTH_SOCK`; clients are short-lived and stateless. https://www.ietf.org/archive/id/draft-miller-ssh-agent-04.html |
| mpd | single daemon, `pid_file` + socket; a second instance refuses to start. https://mpd.readthedocs.io/en/latest/mpd.conf.5.html |
| tailscaled | daemon owns state, CLI is a thin client over a local API socket. https://tailscale.com/kb/1108/endpoint-security |
| PostgreSQL | postmaster takes shared memory + `postmaster.pid`, clients connect over the socket; second postmaster fails to bind rather than electing. https://www.postgresql.org/docs/current/app-postgres.html |
| LSP servers | spawned **per editor client** as a child process; editors do not share one server between windows. https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ |

### 3.4 Failure modes of master election / token ring for short-lived CLIs

- **Election latency vs process lifetime.** `pi` in `-p`/print mode runs for the duration of one
  prompt; a socket handshake + version negotiation + schema migration on first connect is paid on
  every cold start, and the first process pays an unbounded amount.
- **Stale lock after SIGKILL.** `O_EXCL` lockfile creation is atomic, but a killed master leaves the
  file; liveness requires a PID probe, and PID reuse makes the probe unsound (check `starttime` on
  Linux, `p_ustart`/`proc_pidinfo` on macOS). Socket-path probing has the same reuse problem with a
  shorter window.
- **Two processes starting simultaneously** both create-then-lose; the loser must block and retry, so
  the CLI carries a retry loop whose worst case is the other process's prompt lifetime.
- **Version skew.** The master outlives upgrades; a rebuilt client then talks an old protocol/schema.
  This is the failure that dominates in practice for editor/daemon pairs (a stale daemon keeps the old
  schema while the CLI expects the new one).
- **Token ring requires resident participants.** Short-lived CLI processes cannot hold a ring token;
  a ring degenerates into "the daemon holds it", i.e. the master pattern again.
- **Split brain on multi-host views.** Any pointer to "the" master stored in a path that is itself
  network-mounted (or in a container with a separate PID namespace) breaks the single-writer
  assumption; WAL does not work over network filesystems at all.
- **Ownership of cleanup.** Whoever is master must also checkpoint/truncate the WAL and vacuum; a
  master that exits mid-tool-call leaves an unbounded WAL (see §3.1) and no one to truncate it.

The **single-writer queue** alternative (SQLite in WAL + `busy_timeout` + short write transactions,
or an `appeasement`-style app-level mutex row) works for many short writers as long as writes are
milliseconds; it fails for any operation that holds a write transaction across a model call.

---

## 4. Security primitives for a "private tier"

### 4.1 What pi itself states

`packages/coding-agent/docs/security.md:1-12` `[doc]`:
"Pi can read, change, and execute files with the permissions of the account that started it, and it
does not ask for approval before every tool call. Extensions, package installers, language servers,
and other child processes run with those same permissions unless an operating-system or
virtualization boundary restricts them." … "Watching the transcript, using project trust, and
reviewing changes do not create a security boundary."

So every in-process approval primitive listed in §1.2 (`ctx.ui.confirm`, `tool_call` `block`,
`project_trust`) is a policy check inside the same trust domain, executed by the same process that a
compromised model or extension already controls. `examples/extensions/permission-gate.ts` is
explicitly bypassable: it only inspects `toolName === "bash"` for three regexes.

### 4.2 macOS

- Keychain items can carry ACLs and `SecAccessControl` flags (`.userPresence`, `.biometryAny`,
  `.devicePasscode`), enforced by `securityd`, not by the calling app.
  https://developer.apple.com/documentation/security/secaccesscontrol
- The `security` CLI exposes **no** biometric/user-presence flag (`security -h` output contains no
  `biometr*`/`touch*` option) `[verified]` — so "put it in the keychain and read it with `security`"
  gives no per-operation user gate; any same-user process can invoke the same command.
- Whether an item created by another tool prompts on access depends on its ACL/trusted-app list; this
  is **UNVERIFIED** here (no such item to test) and is code-signature-based, so a helper binary the
  agent can execute under a trusted signature defeats it.

### 4.3 Linux

- Secret Service (`org.freedesktop.secrets`) over D-Bus, implemented by gnome-keyring/KWallet;
  libsecret is the client. Unlock state is per-session; any process with access to the session bus can
  request a secret from an unlocked collection. Whether a collection-level prompt reliably appears for
  a non-graphical/automated client is **UNVERIFIED**.
  https://www.freedesktop.org/wiki/Specifications/secret-storage-spec/
- File permissions (`0600`/`0700`) separate users only; they do nothing against a same-UID process.

### 4.4 age / sops

- `age` is X25519 + ChaCha20-Poly1305 file/stream encryption with no user-presence step; the identity
  is a key file, so any process that can read the identity can decrypt.
  https://github.com/FiloSottile/age
- `sops` encrypts values inside structured files and decrypts into the process at read time, with key
  backends age/PGP/KMS/Vault. Same property: decryption is a function of reachable key material, not of
  user intent. https://github.com/getsops/sops
- Neither is installed on this host (`age`, `sops`, `secret-tool`, `op` all absent; `gpg` present)
  `[verified]`.

### 4.5 Is "secure against a compromised agent process running as the same user" achievable?

No. A same-UID process can read every file the user can read, including the store, the key file, the
decrypted temp copy, and the extension's own source; it can also call the same approval API the
extension calls. Any gate implemented inside the agent process, or by a helper the agent can invoke,
is bypassable by definition.

What is achievable, and what each costs:

| Option | Boundary | Residual risk |
|---|---|---|
| Separate UID + broker daemon holding plaintext, agent holds only a socket | kernel-enforced UID check | the broker's own request-validation logic; agent can still *request* |
| VM / container with only required files exposed | OS/virtualization | everything mounted in; `docs/security.md` calls this "usually the strongest practical option" |
| OS user-presence-gated key (Secure Enclave + `.userPresence`, or `pam_tid` sudo) | key material never leaves SEP; prompt drawn by the system | the agent can trigger the prompt at will and misdescribe the request; requires the human to read the prompt every time |
| Encrypt-at-rest only (age/sops/keychain item with default ACL) | other users, backups, disk theft | none against same-UID |

**Does any local agent tool implement a gate a compromised agent cannot bypass?** Not found in this
survey. Checked: pi's own `permission-gate.ts`/`protected-paths.ts`/`timed-confirm.ts`/`project-trust.ts`
(in-process), `cc-safety-net` (pre-execution command guard for Pi and other harnesses — still a wrapper
the agent's shell can route around, `https://github.com/kenryu42/cc-safety-net`), and every pi memory
package in §1.3 (none has an approval tier). The nearest real precedents are out-of-process brokers
(1Password CLI with biometric unlock, `sudo` with `pam_tid`), and whether they resist same-user
automation is **UNVERIFIED** — it depends on whether the requesting code signature is displayed and
whether the user actually reads it.

One design consequence that follows from the pi API rather than from any product: because
`tool_call` mutation is not re-validated (types.ts:1252) and `context_with_system` hands the handler
the whole prompt and tool declarations (types.ts:895), a *second* extension loaded after the memory
extension can silently rewrite whatever the memory extension injected. There is no ordering guarantee
expressed in the types beyond registration order.

## NOT COVERED

- Actual runtime behavior of `pi-optchat`'s "connected windows" (mechanism not read: file, socket, or
  advisory lock) — UNVERIFIED.
- Whether a uv-managed CPython or a Node `better-sqlite3` build on this host permits loading
  `sqlite-vec` (not installed) — UNVERIFIED.
- Homebrew sqlite FTS5 compile flags (formula not installed; grep of formula shows no explicit flags).
- Serena's memory retrieval (pure name/topic listing vs. search) — read only tool signatures.
- Windows-specific locking semantics; out of scope for this host.
