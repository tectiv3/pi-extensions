# pi memory extensions — compared

Companion to `agent-memory-prior-art.md` (which covered host capabilities, WAL/concurrency, and
security primitives). This doc goes into the published extensions themselves.

**Snapshot date: 2026-10-29.** Every number below is either measured on that date or explicitly
marked `UNVERIFIED`. Measurement commands are given so the numbers can be re-taken.

## How the ranking was built

Primary signal: **npm weekly downloads** for the week `2026-10-21 … 2026-10-27`, read from
`https://api.npmjs.org/downloads/point/last-week/<pkg>`.

Secondary signal: **GitHub stars + last push**, read from `gh api repos/<owner>/<repo>`.

Caveat on downloads: pi installs extensions as npm packages into `~/.pi/agent/extensions/`, so
download counts are inflated by re-installs, CI, and mirrors; they are still the only
cross-package unit available. `pi-memory` is also listed in the official pi package directory
(`pi.dev/packages`, cited by its own README), which plausibly drives install traffic more than
stars do.

Caveat on **package-name spoofing**: several unscoped names are squatted or stale. `pi-vcc` on npm
is *not* the project (`pi-vcc` ships v0.4.1, 16.5 MB unpacked, 56 dl/wk); the real package is
`@sting8k/pi-vcc` (v0.11.2, 266 KB, 5,597 dl/wk). `@samfp/pi-memory`'s README explicitly warns that
`pi-memory` will install *a different project* if the scope is omitted.

Ranked list (top 10 by weekly downloads, then the two MCP alternatives):

| # | Extension | npm package | Version | Downloads/wk (2026-10-21…27) | GH stars | Last push | Repo |
|---|---|---|---|---|---|---|---|
| 1 | pi-memory | `pi-memory` | 0.4.2 | **17,519** | 201 | 2026-09-21 | `jayzeng/pi-memory` |
| 2 | pi-hermes-memory | `pi-hermes-memory` | 0.9.11 | **9,316** | 508 | 2026-10-25 | `chandra447/pi-hermes-memory` |
| 3 | pi-vcc | `@sting8k/pi-vcc` | 0.11.2 | **5,597** | 551 | 2026-10-29 | `sting8k/pi-vcc` |
| 4 | pi-blackhole | `pi-blackhole` | 0.5.16 | **3,562** | 274 | 2026-10-28 | `k0valik/pi-blackhole` |
| 5 | signetai | `signetai` | 0.157.3 (npm) / 0.238.0 (repo) | **1,611** | 314 | 2026-10-28 | `Signet-AI/signetai` |
| 6 | pi-observational-memory | `pi-observational-memory` | 3.1.4 | **1,461** | **735** | 2026-10-05 | `elpapi42/pi-observational-memory` |
| 7 | pi-optchat | `pi-optchat` | 0.10.1 | **1,447** | 419 | 2026-10-27 | `jonaslsaa/pi-optchat` |
| 8 | @amaster.ai/pi-memory | `@amaster.ai/pi-memory` | 0.1.32 | **1,057** | 87 (monorepo `TGYD-helige/pi`) | 2026-10-29 | `TGYD-helige/pi` |
| 9 | @henryqw/pi-memory | `@henryqw/pi-memory` | 10.0.2 | **902** | UNVERIFIED (no public repo found at `henryqw/pi-memory`) | UNVERIFIED | UNVERIFIED |
| 10 | @shanelevs/pi-memory-auto | `@shanelevs/pi-memory-auto` | 0.9.0 | **746** | 0 | 2026-10-26 | `shanelevs/pi-memory-auto` |
| — | *serena* (MCP, not a pi extension) | PyPI `serena-agent` | — | n/a (not npm) | **30,829** | 2026-10-28 | `oraios/serena` |
| — | *basic-memory* (MCP, not a pi extension) | PyPI `basic-memory` 0.24.1 | 0.24.1 | n/a (not npm) | **4,394** | 2026-10-29 | `basicmachines-co/basic-memory` |
| ref | `@modelcontextprotocol/server-memory` (knowledge-graph MCP, for scale) | | | **191,568** | — | — | `modelcontextprotocol/servers` |

Just outside the cut, for context: `@neottia/pi-memory` 563 dl/wk, `@samfp/pi-memory` 260 dl/wk /
86★, `pi-memory-md` 65 dl/wk / 66★, `@askjo/pi-mem` 23 dl/wk / 79★, `amosblomqvist/pi-observational-memory`
(fork of #6) 79★. Stars do not track downloads at all: `#6` has the most stars and only 8% of `#1`'s
downloads, while `#10` has zero stars and 746 downloads/wk.

## Stack

Runtime deps = `dependencies` in the package's own `package.json` (all of them declare the pi
packages as `peerDependencies` instead). LOC counted on the repo tarball fetched 2026-10-29 with
`gh api repos/<r>/tarball`, `*.ts`/`*.tsx`, excluding `test/`, `tests/`, `examples/`, `docs/`.

| Extension | Shape | Runtime deps | LOC (src) | Unpacked size (npm) | Build step? |
|---|---|---|---|---|---|
| pi-memory | pure TS in-process; **spawns `qmd` CLI** (or `node_modules/@tobilu/qmd/dist/cli/qmd.js`) only for `memory_search` | **0** | 2,490 (one file, `index.ts`) | 107 KB | no (`main: index.ts`) |
| pi-hermes-memory | in-process TS + **native SQLite** (`better-sqlite3`) | 2 | 17,901 | 1.23 MB | no JS build (`main: src/index.ts`), but `better-sqlite3` must resolve a prebuilt binary or compile |
| pi-vcc | pure TS in-process, no store | **0** | 13,213 | 266 KB (repo 21 MB) | no (`main: index.ts`) |
| pi-blackhole | in-process TS, **requires `tsup` build** (`main: ./dist/index.js`); 137 src files | **0** | 47,827 | 2.33 MB | **yes** (`dist/`; git install fails without `npmCommand`) |
| signetai | **daemon + compiled native binary**; the pi extension is a thin HTTP client to `http://127.0.0.1:3850` | 0 in the extension; `@signet/core` workspace | pi integration 4,660; whole monorepo ~466k TS lines (954 files) | 2.62 MB (npm shim) | **yes** — bun/esbuild/turbo, `build:native`, 8-part build graph |
| pi-observational-memory | in-process TS + **background model workers** (Observer / Reflector / Dropper) | **0** | 5,880 | 223 KB | yes (`dist/`, `build` script) |
| pi-optchat | in-process TS; **unix socket server/client** (`node:net`) for connected windows | **0** | 6,057 | 480 KB | no (`files: src`) |
| @amaster.ai/pi-memory | in-process TS, compiled `dist/` only | 2 (`proper-lockfile`, `@amaster.ai/pi-shared`) | ~1,669 (dist, as shipped) | 1.92 MB | yes (not shipped as source) |
| @henryqw/pi-memory | in-process TS + 3 sibling `@henryqw/*` packages | 4 (`proper-lockfile` + 3 siblings) | 2,017 | 160 KB | no (`files: extensions, src`) |
| @shanelevs/pi-memory-auto | in-process TS | **0** | 4,769 | 252 KB | no (`main: index.ts`) |
| pi-memory-md | in-process TS + **native `nodejieba`** + Orama index | 3 (`@orama/orama`, `gray-matter`, `nodejieba`) | 14,507 | 392 KB | no (`files: index.ts, …`) |
| serena (MCP) | **external Python MCP server**, language-server based | many (PyPI) | — | — | no (pip/uv install) |
| basic-memory (MCP) | **external Python MCP server** + SQLite index | many (PyPI) | — | — | no (uvx/pip) |

## Storage, retrieval, tiers, write path, host API

Token figures marked "≈" are **arithmetic from the extension's own declared char caps**
(`chars / 4`), not measurements of a live prompt.

| Extension | Storage & location | Retrieval | Injected per turn | Tiers | Write path | pi hooks / host assumptions |
|---|---|---|---|---|---|---|
| pi-memory | markdown: `~/.pi/agent/memory/{MEMORY.md,SCRATCHPAD.md,daily/YYYY-MM-DD.md,notes/*.md}` (+`recovery/`); `PI_MEMORY_DIR` overrides | grep-free capped dump of the files; plus optional `qmd` keyword/semantic/hybrid search tool | ≈**4k tok** (`CONTEXT_MAX_CHARS = 16_000`; long-term 4k chars + scratchpad 2k + daily 3k + search 2.5k) | **global only** — no project/session tier (grep for `project` in `index.ts`: 0 hits) | 7 tools (`memory_write/read/forget/restore/search`, `scratchpad`, `memory_status`) + automatic exit summary on `session_shutdown` | `before_agent_start` (appends to `systemPrompt`), `session_start`, `session_shutdown`, `input`, `session_before_compact`; touches `ctx.modelRegistry?.find` for the summary model |
| pi-hermes-memory | markdown `MEMORY.md`/`USER.md`/project file + **SQLite `sessions.db`** with `message_fts` and `memory_fts` (FTS5, `bm25()` ranking) under `~/.pi/agent/pi-hermes-memory` | **FTS5 over both memory and all indexed session transcripts**; `/memory-index-sessions` backfill | ≈**3.7k tok** (three 5,000-char stores) + standing instructions ≤2,000 chars | **global + project + session-search** (`projects` dir under agent root) | slash commands (`/memory-index-sessions`, `/memory-sync-markdown`, `/learn-memory-tool`), background review every 10 turns, explicit tools | `input`, `session_start`, `session_shutdown`, `session_before_compact`, `before_agent_start`, `tool_result`, `resources_discover`; **reads `~/.pi/agent/sessions/*.jsonl` and `PI_CODING_AGENT_DIR` directly** |
| pi-vcc | **none** — compaction summaries written back into the session JSONL; config at `~/.pi/agent/pi-vcc-config.json` | `vcc_recall` tool searches session entries (literal/regex) | **0** on normal turns; replaced summary on compaction | session only | intercepts `/compact` + auto-compaction (`session_before_compact`), `/pi-vcc` command | `session_before_compact`, `session_compact`, `tool_call`, `tool_result`, `input` |
| pi-blackhole | OM observations/reflections as **session JSONL custom entries** (`appendEntry`: `OM_OBSERVATIONS_RECORDED`, `…_DROPPED`, `blackhole-compaction-tail`); config/ledger/cooldowns in `~/.pi/agent/pi-blackhole/` | `recall` tool: literal/regex over session history **and full-file write payloads**, `#N` entry expansion, `#N:path`/`#N:text` paging, `mode:touched` | 0 baseline; observation block on compaction/inline triggers | session + **project-recall** (scans `~/.pi/agent/sessions/`, git-root-encoded dirs only) | automatic (background workers), `/blackhole`, manual flush mode | 460 `input` handler refs, `session_*`, `tool_call`/`tool_result`, `session_before_compact`; reads `~/.pi/agent/sessions/` JSONL directly |
| signetai | **SQLite + vector index in the daemon** (migrations for `embedding-usage`, `embedding-index-failures`, `database-vec-path`); markdown `MEMORY.md` surface; secrets encrypted with the OS-keyring master key | daemon-side (vector + graph + BM25 per its docs); extension gets recall results over HTTP | UNVERIFIED (not measured; daemon-side budget) | **global / team server** (shared across harnesses) | CLI + dashboard + extension hooks; "Dreaming" background extraction | 32 `before_agent_start` refs, `session_*`, `tool_call`/`tool_result`; **requires a separate daemon process on port 3850** |
| pi-observational-memory | **session JSONL custom entries** via `pi.appendEntry` (`OM_OBSERVATIONS_RECORDED`, `OM_REFLECTIONS_RECORDED`, `…_DROPPED`) — no external store | observation/reflection replay into context at compaction; `/view`, `/status` | 0 on normal turns; block injected when compaction runs | **session only** (dies with the session file) | automatic background workers (Observer/Reflector), no explicit save tool | `input` (13 refs), `session_before_compact`, `tool_call` |
| pi-optchat | **`~/.optchat/profiles/<name>/`** (git-checkpointed): summary tree of 512-byte nodes, `AGENTS.md`, runs JSON; unix socket per profile | **summary tree rebuild each turn** with a bounded view; agent can `zoom` into nodes | ≈**32k tok** (`VIEW = 128_000` bytes, `NODE = 512`) | **profile** (cross-directory, cross-session; deliberately *not* project-scoped) | automatic (every message recorded; background compactor builds nodes), `/optchat` command, `spawn`/`tell` subagents | `input` (320 refs), `context_with_system`, `session_before_switch`, `before_agent_start`, `registerFlag`/`getFlag`, `ctx.ui.setStatus` |
| @amaster.ai/pi-memory | markdown `memories/MEMORY.md` (cap 2,200 chars) + `memories/USER.md` (cap 1,375 chars), `\n§\n`-delimited, atomic temp+rename, `proper-lockfile`, `.bak.<ts>` on drift | **none — whole snapshot** into the system prompt, frozen for the session, refreshed only after compaction / new session | ≈**900 tok** (3,575 chars) | **global + frozen session snapshot** | automatic extraction + tools; every write scanned by a bundled `threat-patterns` injection scanner (`strict`) | `session_start`, `session_shutdown`, `session_compact`, `before_agent_start`; compiled `dist/` only |
| @henryqw/pi-memory | markdown `MEMORY.md`/`USER.md`, char caps, `.bak` files, `proper-lockfile`, 65,536-byte candidate **inbox** | none (capped dump) | UNVERIFIED (caps exist; values not read) | global (inspired by Hermes' `MEMORY.md`/`USER.md`) | batched writes (≤100 ops, ≤1 MB) that pass a **`pi-memory/reviewCandidate` LLM review gate** before commit | `input`, `session_start`, `session_shutdown`, `before_agent_start` |
| @shanelevs/pi-memory-auto | markdown, **two layers**: global `~/.pi/agent/memory-auto` + per-project dir; category files (`FAILURES.md` etc.) + `MAIN.md` | **keyword index only** — the agent sees 1–3 keywords per memory and fetches the paragraph on demand | tens of tokens (keyword table only) | **global + project** (`layer: "global" \| "project"`) | automatic extraction + consolidation + self-fetch | `input`, `session_start`, `session_shutdown`, `session_before_compact`, `before_agent_start` |
| pi-memory-md | **git-backed markdown repo** at `~/.pi/memory-md` (configurable `repoUrl`/`localPath`) | **BM25 via `@orama/orama`** (+ `nodejieba` CJK tokenizer), optional "jev" rerank stage; memory *index* appended at session start, full reads via tools | small index excerpt per turn (UNVERIFIED exact size) | **global + per-project** memory spaces (`getMemoryDir(settings, ctx.cwd)`, `scope === "global" ? global : project`) | 7 tools (`memory_init/_write/_read/_list/_search/_sync/_check`) + `/skill:memory-init`; git pull/push hooks | `before_agent_start`, `input`, `session_start`, `session_shutdown`, `tool_call`; refuses project-level override of its own config |
| serena (MCP) | markdown in **`.serena/memories/`** | **no search** — `list_memories(topic)` filter + full `read_memory`; `mem:` cross-references, rename rewrites references | 0 (MCP tool calls only) | project (`.serena/` is per-repo) | 6 MCP tools: `write/read/list/delete/rename/edit_memory` | MCP server via pi's `docs/mcp.md`; no pi hooks at all |
| basic-memory (MCP) | markdown + wikilinks, SQLite index (per prior-art doc), "projects" = directories | semantic search + optional cross-encoder rerank (README) | 0 (MCP tool calls only) | project (per-project local mode) or cloud | MCP tools; two-way file sync | MCP server; no pi hooks |

## Notes worth keeping

- **Two different problems are being solved under one name.** #3/#4/#6 (and half of #5) are
  *compaction* tools: their memory is a by-product of surviving context loss, their storage is the
  session file, and their retrieval is "put it back into the prompt". #1/#2/#8/#9/#10/#11/#12 are
  *knowledge stores*: they own files on disk and have a write API. `pi-blackhole`'s README says this
  outright — it merged `pi-vcc` + `pi-observational-memory` precisely because they conflicted.
- **`pi-memory` is the only one with a real popularity moat** (17.5k/wk, ~1.9× #2, ~3× #3) and it is
  also the smallest serious implementation (2,490 LOC, 0 deps). Its semantic search is not its own:
  it shells out to `qmd`.
- **Nobody indexes embeddings in-process.** Every embedding path is delegated: `qmd` CLI (#1),
  Bedrock/OpenAI/Ollama/Mistral API (#10 `@samfp`), or a daemon (#5). `pi-memory-md` (#11) is
  lexical only (Orama BM25). `@samfp/pi-memory` explicitly removed `@xenova/transformers`
  ("no native modules, no ONNX runtime, no model download").
- **SQLite appears exactly twice among pi extensions**: `pi-hermes-memory` (FTS5 + `better-sqlite3`)
  and `@samfp/pi-memory` (`node:sqlite`/`bun:sqlite`, FTS5 optional, degraded if the Node build
  lacks FTS5). Everything else is markdown or the session JSONL.
- **Reading `~/.pi/agent/sessions/*.jsonl` directly is a common host-internal dependency**
  (#2 session indexer, #4 project-recall corpus). Neither uses a public API for it.
- **`pi-blackhole` requires a build** and its git install fails without `npmCommand` — the README
  says so. `pi-observational-memory` and `@amaster.ai/pi-memory` also ship compiled `dist/`.

## What the field converged on

1. **Markdown as the substrate, with the agent as the writer** (6 of 10: #1, #8, #9, #10, #11, #12 —
   and serena and basic-memory both do the same). Rationale visible in #1's README: "plain markdown
   files you can read, edit, and commit". Nobody chose a binary format for the *source of truth*.
2. **A hard char/token cap on the always-injected block.** Every store-backed extension has one:
   16,000 chars (#1), 3×5,000 (#2), 2,200+1,375 (#8), 8,000 (#10 `@samfp`), 128,000 bytes (#7).
   This is the field's only real defense against context bloat, and it is always a static cap, never
   a relevance-ranked budget.
3. **Session start / first turn is the injection point**, and it is *append or replace the system
   prompt* (`before_agent_start` + `systemPrompt`): #1, #8, #9, #11, plus `@samfp`'s optional
   `system-prompt` mode. `context`/`context_with_system` is used only by #7 (optchat) and `@samfp`'s
   default `context-hook` mode.
4. **Automatic capture, not agent-initiated saving.** 8 of 10 write without the model asking: exit
   summaries (#1), background review every 10 turns (#2), background Observer/Reflector (#4, #6),
   session-end LLM consolidation (#10), extraction pipeline (#8). Explicit tools exist as a
   secondary path, never the primary one.
5. **A `§` / delimiter-line entry format inside `MEMORY.md`** — adopted explicitly by #2, #8, #9
   (`"\n§\n"` appears as `ENTRY_DELIMITER`/`ENTRY_DELIMITER`-equivalent in all three), traced by
   their READMEs to Nous Research's Hermes `MemoryStore`.
6. **Two scopes at most.** Global + project is the ceiling (#2, #10, #11, #12); nobody implements
   global + project + session as three addressable tiers. Where a session tier exists (#6, #7) it
   replaces the others rather than nesting with them.

## Where they all fall short

- **No revisions.** Not one extension versions an entry. `pi-memory-md` (#11) is the only one with
  history at all, and it gets it by committing the whole repo to git — a 14,507-LOC extension plus a
  git remote for what is otherwise a CRUD store. `@henryqw` keeps `MEMORY.md.bak` and states plainly
  that "backups provide no older versions". `@amaster.ai` takes `.bak.<unix-ts>` snapshots only on
  parser drift, not on edits. There is no per-entry audit trail, no "what did this fact say three
  weeks ago", no attribution of which session wrote it.
- **No supersession / contradiction handling.** Deduplication exists (Hermes `ENTRY_DELIMITER`
  sets are de-duplicated by exact string, #9 `[...new Set(...)]`); *replacement* does not. The only
  conflict mechanisms are whole-store consolidation by an LLM (#2 "auto-consolidation merges entries
  when full") and #9's review gate that can reject a candidate write. Nothing records that entry B
  invalidates entry A, so a stale preference and its correction can both sit in the prompt.
- **No access gating anywhere.** The nearest thing is content *filtering*, not access control: #8's
  `threat-patterns` scanner rejects prompt-injection/exfil text at write and snapshot time, #2's
  secret scanner blocks API keys, #5 encrypts its secrets store with an OS-keyring key. All three
  run inside the agent process, so per the prior-art doc §4.5 they are policy checks in the same
  trust domain, not a boundary. No extension has a private tier, an approval prompt per read, or
  per-project visibility rules.
- **Budgets are static, not relevance-ranked.** #1 truncates at 16,000 chars by file order;
  #8 injects a fixed snapshot until the next compaction; #2 injects three caps in full. Only
  `@samfp` (#10, out of the top 10) does prompt-relevance selection, and only #12 tries to shrink
  the always-visible surface to keywords.
- **Retrieval quality is mostly lexical.** FTS5/BM25 (#2, #11, `@samfp`), literal/regex (#3, #4),
  or none (#8, #9, #10-by-default). Semantic retrieval is always delegated to an external binary or
  API (#1 → qmd, `@samfp` → provider API, #5 → daemon). No extension combines dense + lexical
  ranking locally.
- **The compaction cluster's memory dies with the session file.** #3, #4, #6 store into
  `pi.appendEntry` entries in the session JSONL. `#4` reaches across sessions only by scanning
  `~/.pi/agent/sessions/` itself, i.e. by depending on pi's on-disk layout rather than an API —
  which breaks if `session-format.md` changes. `pi-blackhole`'s own README concedes the quality
  problem: "The recap is pattern-matching, not understanding… the memory is model-written, so it
  has the opposite weakness: it can keep what sounds right but isn't."
- **Cost is pushed to background model calls, unmeasured.** #4 runs three worker model calls per
  cycle with fallback chains; #6 runs Observer + Reflector + Dropper; #7 runs a compactor per
  summary node. Only #4's README admits the economics ("Untuned, on your main coding model, this
  costs more than doing nothing"). No extension publishes a token-cost measurement.

## Explicit feature check (asked for in the brief)

| Capability | Who has it | Evidence |
|---|---|---|
| **Revisions / history** | `pi-memory-md` only (git commit of the whole memory repo); partial `.bak` snapshots in `@amaster.ai` and `@henryqw` | `memory-git.ts` + `memory_sync` tool; `MAX_FILE_BYTES`/`.bak` writes in `store.ts` |
| **Tiering** | global+project: #2, #10 (`@samfp`, key prefixes), #11, #12; global+frozen-session-snapshot: #8; profile-only: #7; session-only: #3, #4, #6 | table above |
| **Access gating** | none. Content scanners only (#2 secrets, #8 injection patterns, #5 encrypted secrets at rest) | `content-scanner.ts`, `threat-patterns`, signet README §Secrets |

## UNVERIFIED / not covered

- Exact per-turn token injection for #5 (signet), #9 (`@henryqw`), and #11 (`pi-memory-md`) — no
  single char-cap constant was found; #5 is daemon-side and would need a live prompt capture.
- GitHub stars for `@henryqw/pi-memory`: `gh api repos/henryqw/pi-memory` → 404; no other repo
  identified. Popularity is npm-only for that row.
- `@amaster.ai/pi-memory`'s star count is attributed to a **monorepo** (`TGYD-helige/pi`, 87★),
  not to the package; the package has no repo of its own.
- Runtime behavior of `qmd` (install size, whether it embeds locally or calls an API) was not
  inspected — only that `pi-memory` shells out to it and caches detection in `qmdAvailable`.
- basic-memory's SQLite-index detail is carried over from the prior-art doc (its README was read
  here, its source was not).
- Live measurements (actual prompt sizes, actual recall precision) were not taken for any
  extension; all token figures are arithmetic from declared caps.

### Re-take the numbers

```bash
curl -sS "https://api.npmjs.org/downloads/point/last-week/pi-memory"
gh api repos/jayzeng/pi-memory --jq '.stargazers_count, .pushed_at'
npm view <pkg> version dist.unpackedSize dependencies
gh api repos/<owner>/<repo>/tarball | tar xz -C /tmp/x   # then wc -l on *.ts
```

---

## Appendix: competitors beyond the top 10

Same snapshot date and same units as above (`api.npmjs.org/downloads/point/last-week/<pkg>` for the week
`2026-10-21…27`; `gh api repos/<owner>/<repo>` for stars). **Nothing in this appendix was in the table
above or in `agent-memory-prior-art.md` §1.3.** Packages were found by `npm search` across
`pi memory|context|session|compaction|recall|knowledge|git memory|private memory|memories version history`,
`gh search repos`, and the pi package directory (`pi.dev/packages`, 60 entries scraped; its HTML exposes
only ~60 names, so the directory is not a complete index).

Caveat that dominates this appendix: the **top of this list is not the top of the ecosystem**. Several
of these packages are multi-harness tools that pi is one host among five, and their download counts are
inflated by the other hosts' install traffic — `billion-context` alone reports 617k/wk, 35× `pi-memory`
(#1 above). They are listed because they are installable in pi and overlap the problem, not because they
are pi extensions of comparable standing.

### Memory / context stores, by weekly downloads

| Tool | npm package (version) | dl/wk | GH stars | Storage & retrieval | Flags (see key) |
|---|---|---|---|---|---|
| **billion-context** | `billion-context` 0.1.209 | **617,641** | 3,314★ `ranxianglei/billion-context` | context-*compression* plugin, not a knowledge store: `compress` folds a message range into a summary, `acp_status` reports what is still compressible. Ships as an ACP/proxy layer for pi, OpenCode, Codex, Claude Code and others (`pi-package` keyword). Depends on **`mysql2`** — a server-side store, not a local file. | none verified |
| *oh-my-pi fork's engine* | `@oh-my-pi/pi-mnemopi` 18.13.3 | 166,236 | 37,020★ (monorepo `can1357/oh-my-pi`) | "Local SQLite memory engine for omp agents" — bundled inside the `oh-my-pi` fork; not separately installable into pi proper. | UNVERIFIED |
| **openwiki** | `openwiki` 0.7.2 | **53,678** | 17,573★ `langchain-ai/openwiki` | LangChain's agent-maintained wiki: markdown concept pages plus **versioned claim sidecars** under `openwiki/.claims/`; installed with `pi install npm:openwiki`. | per-claim versioning |
| **context-mode** | `context-mode` 1.0.169 | **24,107** | 32,762★ `mksglu/context-mode` | multi-harness hook layer (pi / OpenCode / KiloCode / Claude Code): captures sessions, indices and stats into **SQLite** roots that are kept separate per host (`~/.omp/context-mode/` vs the pi root). Retrieval = search over the content index + resume snapshots. | none verified |
| **remnic** | `@remnic/plugin-pi` 9.69.56 | **5,161** | 230★ `joshuaswarren/remnic` | markdown + YAML memory records on disk, served through the `subc` daemon; hybrid retrieval (BM25 + embeddings + opt-in Personalized PageRank); same store shared with Claude Code / OpenCode / hosted clients. | **at-rest encryption**, **per-page versioning**, namespaces, hot/cold tiers |
| **pi-magic-context** | `@cortexkit/pi-magic-context` 0.49.29 | **4,026** | 2,405★ `cortexkit/magic-context` | one shared `~/.local/share/cortexkit/magic-context/context.db` (**SQLite**) across pi, oh-my-pi and the OpenCode plugin; `ctx_search` spans memories, raw conversation, indexed git commits, notes and primers; embeddings with full-text fallback. | **cross-process SQLite coordination** (read-only connection + 3 s busy timeout), git-commit *indexing* |
| **engram (pi plugin)** | `gentle-engram` 0.4.2 | **3,068** | 7,679★ `Gentleman-Programming/engram` | Engram's pi package: "one binary, one SQLite file", `remember` / `sync` / `recall`, local or cloud backend. | none verified |
| **pi-redact** | `@spences10/pi-redact` 0.0.15 | **2,905** | 138★ (monorepo `spences10/my-pi`) | not a store at all: scans tool output for tokens/keys/credentials and replaces them with placeholders **before the model sees them**. | output redaction filter |
| **hippo-memory** | `hippo-memory` 2.1.0 | **1,433** | 786★ `kitfunso/hippo-memory` | `.hippo/` directory: SQLite store + markdown mirrors; learns from `hippo learn --git` (recent commits), decay/importance scoring on retrieval. | reads git commits (**not** commit-per-write) |
| **pi-sessions** | `pi-sessions` 0.22.0 | **1,267** | 13★ `thurstonsand/pi-sessions` | session-store tooling: search, ask, handoff, messaging, auto-titling, indexing over pi session history. | session tier only |
| **om-memory-system** | `om-memory-system` 4.28.2 | **761** | 0★ `cmdaltctr/omms` | shared memory system for OpenCode **and** pi on **libsql/Turso**, with `onnxruntime-node` + `@huggingface/transformers` — i.e. embeddings computed in-process, no external API. | local embeddings in-process |
| **pi-llm-wiki** | `@zosmaai/pi-llm-wiki` 0.12.5 | **754** | 616★ `zosmaai/pi-llm-wiki` | Karpathy-pattern self-maintaining wiki with **immutable source copies** and derived pages. | immutable sources (not per-entry versioning) |
| **the-librarian** | `@the-librarian/pi-extension` 1.33.6 | **695** | 35★ `code-ministry-ltd/the-librarian` | thin pi client for the Librarian MCP server: `flag_memory`, `store_handoff`, `list_handoffs`, `claim_handoff`, primer injection. | state lives server-side |
| **unipi / MemPalace** | `@pi-unipi/memory` 3.0.0 | **514** | 71★ `Neuron-Mr-White/unipi` | facts and decisions to **markdown** files plus a MemPalace index; **all writes are routed through the MemPalace daemon** (auto-installed). | **daemon-routed writes** (single-writer by architecture) |
| **pi-weave** | `pi-weave` 0.3.15 | **480** | 5★ `EranYonai/pi-weave` | local-first **markdown vault** with a knowledge graph, shared with OpenCode and Claude Code; `/weave-scan sessions` converts changed session-history files into durable notes. | **per-change note history** (`<vault>/history/`) |
| **pi-self-learn** | `pi-self-learn` 0.2.1 | **360** | 0★ `driderr/pi-session-recall` | distils every session into scored, auto-injected lessons; `better-sqlite3` + YAML. | none verified |
| **pi-memoria** | `pi-memoria` 0.4.7 | **341** | 2★ `rcsaquino/pi-extensions` | global working memory + **SQLite FTS5** recall + full session search. | `proper-lockfile` |
| **nowledge-mem-pi** | `nowledge-mem-pi` 0.8.14 | **290** | 198★ `nowledge-co/community` | cross-tool memory; local by default, or a remote Mem via `NMEM_API_URL` / `~/.nowledge-mem/config.json`. | remote/cloud option |
| **pi-memory-evolution** | `pi-memory-evolution` 0.4.3 | **282** | 1★ `btnalit/pi-memory-evolution` | self-maintaining memory that injects what the current session needs. | none verified |
| **pi-memsearch** | `pi-memsearch` 1.5.1 | **265** | 3★ `espadat-studio/pi-memsearch` | writes into the shared `memsearch` per-project store that Claude Code, Codex, OpenClaw and OpenCode already use; semantic recall ("weeks later, by meaning"). | external shared store |
| **pi-persistent-intelligence** | `pi-persistent-intelligence` 0.17.4 | **264** | 2★ `Mont3ll/pi-persistent-intelligence` | **canonical memory is JSONL**, markdown is a rendered projection, under `~/.pi/agent/pi-memory/`; optional Obsidian vault. | governed writes (see key) |
| **pi-ltm / OpenLtm** | `@rohirik/pi-ltm` 2.22.1 | **247** | 29★ `RohiRIK/OpenLtm` | one **SQLite** file, no mandatory daemon; embeddings + a janitor that runs decay → archive → promote → dedup-*suggestions*; shares memories with Claude Code and OpenCode. | **supersession + decay lifecycle**, pattern denylist for secrets |
| **pi-knowledge** | `pi-knowledge` 0.12.0 | **245** | 31★ `nczz/pi-knowledge` | local-first RAG over docs *and* code: `better-sqlite3` index, tree-sitter parsers, `@huggingface/transformers` for embeddings. | local embeddings in-process |
| **pi-compaction-recall** | `pi-compaction-recall` 0.2.0 | **226** | 1★ `shttty/compaction-recall` | lexical recall over compacted history with automatic locators and bounded grep/expand; `jieba-wasm` for CJK tokenization. | CJK tokenizer (non-English ecosystem) |
| **pi-context-prune** | `pi-context-prune` 2.1.0 | **224** | 254★ `championswimmer/pi-context-prune` | summarizes completed tool-call batches, prunes raw tool output from **future** context, and keeps `context_tree_query` as the escape hatch to recover any original output. | prune-from-context (not delete) |
| **maskpoint** | `@maskpoint/pi` 0.4.0 | 44 | 1★ `iefnaf/maskpoint` | at compaction, **masks stale observations** instead of asking a model to summarize; records a `compaction` entry with `fromHook`/`details`, verified by its own README via `jq` on the session JSONL. | masking instead of deletion |

Feature-flag key: **at-rest encryption** = memory content encrypted on disk; **git-commit-per-write** =
a VCS commit per memory write; **cross-process coordination** = something beyond `proper-lockfile`;
**sensitive/private tier** = an addressable confidentiality class or access gate; **per-entry versioning**
= retrievable prior versions of one memory.

### The flag hunt — what was found

The brief asked specifically about five capabilities. Results:

1. **Encryption at rest of memory content — one hit: `@remnic/plugin-pi`.** AES-256-GCM transparent
   encryption of the markdown memory files, opt-in via `secureStoreEnabled` (default `false`) plus
   `secureStoreEncryptOnWrite` (default `true`), with a passphrase-initialised key and a documented threat
   model (`docs/encryption.md` in `joshuaswarren/remnic`): disk compromise, cloud-backup exfiltration,
   accidental `cat`. This is the only extension in either document that encrypts *memory content*; the
   prior doc's only encryption hit (`signetai`, #5) covers its **secrets store**, not memories, and
   `pi-hermes-memory` (#2) only *scans* for secrets.
2. **Git-commit-per-write — none new.** The two git-backed stores remain `pi-memory-md` (#11 above) and
   `@kivlor/pi-memory` (prior-art §1.3), both already documented. Two near-misses with different
   mechanisms: `pi-weave` snapshots **every note change** into `<vault>/history/` (its own history dir,
   no git), and `openwiki` keeps **versioned claim sidecars** next to the pages. `pi-magic-context`
   *indexes* git commits for retrieval — the opposite direction.
3. **Multi-process locking beyond `proper-lockfile` — three architectural answers, no better lock.**
   `@pi-unipi/memory` routes every write through the MemPalace daemon (single writer by construction);
   `billion-context` uses a **MySQL** server (`mysql2` dependency) rather than a local file;
   `@cortexkit/pi-magic-context` shares one SQLite DB across three harnesses and reads through a
   read-only connection with a 3 s busy timeout, and documents mixed-version daemon state as a class of
   bug. `pi-memoria` and `@signalridge/pi-recall` simply use `proper-lockfile`, which is what the
   existing top-10 already does (#8, #9). Nobody implements advisory locks, an O_EXCL leader election, or
   a lock-free append protocol.
4. **A private / sensitive tier — no true hit.** Closest three, each something else:
   `@remnic/plugin-pi` **namespaces** isolate tenants (opt-in `namespacesEnabled`) — isolation between
   agents/tenants on one store, not confidentiality classes inside one agent's memory;
   `@rohirik/pi-ltm`'s janitor *redacts by pattern denylist* and its own README states the limit
   ("it is a pattern denylist, not a guarantee. Stored memory is not the same as redacted memory");
   `@spences10/pi-redact` filters secrets out of tool output *before the model sees them* — an input
   filter, not a stored tier. There is still no extension with an addressable private class, a per-read
   approval, or visibility rules.
5. **Per-entry versioning — two hits, both file-granular.** `@remnic/plugin-pi` "snapshots page versions
   on every overwrite" (page = one memory file), with exact-version share links; `pi-weave` keeps a
   per-change history of every note. `openwiki` versions *claims* (sidecar records), not the page.
   None of them offers a per-entry revision log with attribution ("what did this fact say three weeks
   ago, written by which session") — the same gap the main doc reports for the top 10, now with two
   partial exceptions.

### Non-memory packages that dominate the install numbers

For scope hygiene: these appear in the same searches and pi.dev's directory, are installed in the same
command, and are **not** memory or context stores, so they are excluded from the table above —
`pi-lens` (22,425 dl/wk, 500★; LSP/ast-grep code intelligence), `@ff-labs/pi-fff` (5,798; fuzzy search),
`pi-fabric` (5,612, 318★; durable workflow runtime), `@skydiveai/pi-extensions` (6,603; agent-server
monorepo), `@vcc/blackhole-family` neighbours already listed, `bigpowers` (4,075, 285★; spec-driven
workflow), `pi-bolt` (2,136; AOT-compiled pi), `openwiki`'s sibling tooling aside.

### UNVERIFIED in this appendix

- `billion-context`'s pi integration depth: its README documents ACP/proxy hosts, the npm manifest
  carries the `pi-package` keyword and a description naming pi first, but no `pi install` line was found
  in the README. Treat "runs in pi" as **UNVERIFIED**.
- `@oh-my-pi/pi-mnemopi` — bundled in the fork, no separate pi install path inspected.
- Storage/retrieval detail for `pi-beyin` (2,852 dl/wk, 1★), `pi-context-map`, `@ayulab/pi-rewind`,
  `@spences10/pi-recall`: found, counted, not read to a level that justifies a row.
- Whether `context-mode`, `gentle-engram`, `hippo-memory`, `pi-self-learn` or `nowledge-mem-pi` encrypt,
  version, or lock anything — only READMEs were read for those rows, not source. Absence of a flag above
  means "no claim in the docs", not "verified absent in the code".
- Download counts for every package in this appendix are single-week point reads (`2026-10-21…27`) with
  no trend, in a registry where re-installs, CI and mirrors inflate the number; `billion-context`'s
  617k is the least credible figure here and was not cross-checked.
