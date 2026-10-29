# Fork feasibility & licensing — seven pi memory extensions

**Snapshot: 2026-10-29T09:01Z.** Companion to `agent-memory-extensions-compared.md` (which ranks the
field) — this doc asks a narrower question: *can we legally fork these, and how much of their code
survives into our design?*

Method: `npm view` for registry metadata; `gh api repos/<r>/license` + `repos/<r>/commits` for the repo
LICENSE and last commit; the published npm tarballs (`registry.npmjs.org/<pkg>/-/<pkg>-<v>.tgz`) for
source; `raw.githubusercontent.com` for files the tarballs omit (remnic ships `dist/` only) and for
drift checks. Every claim below is one of: measured, quoted, or marked **UNVERIFIED**.

## 0. The target design (the yardstick for "survives")

1. Markdown, **one file per key**, as source of truth.
2. A **git repo** as the store (commit per write, history = audit trail).
3. **SQLite FTS5 + sqlite-vec** as a *rebuildable* index (never authoritative).
4. **Three tiers**: global / project / private.
5. Private tier **AES-256-GCM** with a passphrase-derived key.
6. **Explicit-write-only** tools (no automatic extraction, no background model calls).
7. Tiny **key-index injection** at session start (keywords only, bodies fetched on demand).
8. macOS `NLEmbedding` vectors via a **precompiled Swift CLI**.

## 1. Licensing — all seven are stock MIT, no traps

| Package | npm `license` | Repo | GitHub LICENSE SPDX | Copyright line (verbatim) |
|---|---|---|---|---|
| `pi-memory` | MIT | `jayzeng/pi-memory` | MIT | `Copyright (c) 2026 Jay Zeng` |
| `pi-memory-md` | MIT | `VandeeFeng/pi-memory-md` | MIT | `Copyright (c) 2026 Vandee` |
| `@remnic/plugin-pi` | MIT | `joshuaswarren/remnic` | MIT | `Copyright (c) 2025 Joshua Warren` |
| `pi-hermes-memory` | MIT | `chandra447/pi-hermes-memory` | MIT | `Copyright (c) 2025 Chandra Teja` |
| `@henryqw/pi-memory` | MIT | `HenryQW/pi-harness` (monorepo) | MIT | `Copyright (c) 2026 Henry Wang` |
| `@shanelevs/pi-memory-auto` | MIT | `ShaneLevs/pi-memory-auto` | MIT | `Copyright (c) 2026 Shane` |
| `@samfp/pi-memory` | MIT | `samfoy/pi-memory` | MIT | `Copyright (c) 2026 Sam Painter` |

`gh api repos/<r>/license --jq .license.spdx_id` returns `MIT` for all seven. npm metadata and repo
LICENSE agree in every case — no dual licensing, no `SEE LICENSE IN`, no separate terms file.

**The bodies are byte-identical.** `tail -n +4 LICENSE | shasum` gives `aebed1e2f73c` for all seven; only
the copyright line differs. Verbatim body (from `jayzeng/pi-memory`):

```
MIT License

Copyright (c) 2026 Jay Zeng

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Verdict: modification + redistribution under a different name

**Permitted for all seven.** "to deal in the Software without restriction, including without limitation
the rights to use, copy, **modify**, merge, publish, distribute, sublicense, and/or sell copies" covers
both acts. Renaming is unencumbered: MIT grants no trademark rights and imposes no name restriction, so
there is nothing to license or avoid — we simply must not imply endorsement.

One obligation, and it is mechanical: *"The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software."* If we copy code, we need a
`THIRD_PARTY_NOTICES` file carrying the relevant copyright line(s) verbatim. Nothing else.

Friction check (all clean):
- **No CLA / no contributor licence agreement** referenced in any tarball (`grep -ril "contributor license
  agreement"` over all seven unpacked packages: 0 hits), so no inbound-licence asymmetry to inherit.
- **No `trademark` clause** in any LICENSE or package README (0 hits).
- `@remnic/plugin-pi` publishes with `publishConfig: { "provenance": true }`; provenance attestation is
  irrelevant to the licence grant.

## 2. Version, recency, and a trap: npm tarballs lag git HEAD

Stars/pushed from `gh api repos/<r>`; publish date from `npm view <pkg> time`.

| Package | Version (HEAD == npm) | npm published | Last commit | Stars |
|---|---|---|---|---|
| `pi-memory` | 0.4.2 | 2026-08-11 | 2026-09-21T02:05Z | 201 |
| `pi-memory-md` | 0.1.38 | **2026-05-25** | 2026-10-18T06:25Z | 66 |
| `@remnic/plugin-pi` | `latest` 9.69.56 / `alpha` **10.0.36** | 2026-10-29 | 2026-10-29T00:41Z | 230 |
| `pi-hermes-memory` | 0.9.11 | 2026-10-21 | 2026-10-25T06:22Z | 508 |
| `@henryqw/pi-memory` | 10.0.2 | 2026-10-28 | 2026-10-29T04:20Z | 20 (monorepo `HenryQW/pi-harness`) |
| `@shanelevs/pi-memory-auto` | 0.9.0 | 2026-10-26 | 2026-10-26T15:48Z | 0 |
| `@samfp/pi-memory` | 1.6.1 | 2026-10-09 | 2026-10-09T22:47Z | 86 |

Two facts that change the fork plan:

1. **Version strings do not track content.** `pi-memory-md` HEAD `package.json` says `0.1.38`, npm
   `latest` is `0.1.38` — but the files differ. Measured shasums, tarball vs `main` HEAD:

   ```
   memory-git.ts   tarball a5906147081c   HEAD 136b875554d0
   memory-core.ts  tarball 22608458d59f   HEAD a0f2c98d114f
   tools.ts        tarball 04e3557bb9f3   HEAD 4f3d1eb4a2a4
   index.ts        tarball 8969b435efba   HEAD 5da9eecb3cdb
   ```

   `pi-hermes-memory` and `@henryqw/pi-memory` drift the same way (`hermes/src/store/memory-store.ts`:
   tarball `64e63ab688fe` vs HEAD `e3e1dadeedcb`; `@henryqw` `src/store.ts`: `3019527b1bcd` vs
   `78fb38f212fa`). **Fork from git HEAD, never from the npm tarball**, and pin the commit.
2. `@remnic/plugin-pi`'s `latest` tag (9.69.56) is behind the repo: the `alpha` tag is 10.0.36,
   published 2026-10-29 from the same commit range as HEAD. Treat 9.69.56 as the stable API and the repo
   as the code.

## 3. How much survives into the target design

LOC = `wc -l` on `*.ts` from the npm tarball, excluding `tests/`. "Survives" is an **estimate** of lines
we would keep in recognisable form after adaptation, not a diff.

| Package | Total src LOC | Survives | Deleted | Why |
|---|---|---|---|---|
| `pi-memory-md` | 8,167 (core 2,854 / `tape/` 5,313) | **~600** | ~7,550 | Git layer + frontmatter store + path safety + injection hook map directly; `tape/` and Orama BM25 do not |
| `pi-hermes-memory` | 17,859 | **~650** | ~17,200 | Atomic markdown write with conflict fingerprints + FTS5 DDL + trigram tokenizer choice survive; the entire learning loop does not |
| `@remnic/plugin-pi` | ~364 `.ts` (dist-only pkg); `remnic-core/src/secure-store/` ≈ 2,900 across 10 files (115 KB) | **~300** | rest of a ~470k-line monorepo | Only `seal()` / `deriveKey()` / in-memory keyring; the shipped plugin is an HTTP client |
| `@samfp/pi-memory` | 2,939 | **~120** | ~2,800 | `node:sqlite`/`bun:sqlite` dual loader + FTS5-optional fallback pattern; brute-force cosine in JS is replaced by sqlite-vec |
| `@shanelevs/pi-memory-auto` | 4,769 | **~150** | ~4,600 | The keyword-index injection *idea* and its determinism invariants; the extraction/consolidation pipeline does not |
| `@henryqw/pi-memory` | 2,017 | **~80** | ~1,900 | Atomic write that preserves symlinks (a real edge case); everything else is the `§`-store + LLM review gate |
| `pi-memory` | 2,431 + 48 (`postinstall.cjs`) | **~50** | ~2,430 | Tool-registration boilerplate and the `qmd` probe/degrade pattern; no git, no tiers, no index, no locking |

Nothing here is a fork candidate in the "take the repo and rename it" sense — the most reusable single
artifact is **~200 lines of `pi-memory-md/memory-git.ts`**. The rest is design knowledge, not code.

### Per-candidate, in one line each

- **`pi-memory`** — single `MEMORY.md` + `SCRATCHPAD.md` + `daily/YYYY-MM-DD.md` (`index.ts:61-64`),
  writes are bare `fs.writeFileSync` with **no temp+rename and no lock** (`index.ts:1517, 1717, 1737`),
  global tier only, 7 tools. Its semantic search is not its own: `memory_search` shells out to `qmd`
  (`index.ts:875-931`, including a Windows `.cmd`-shim workaround by resolving
  `node_modules/@tobilu/qmd/dist/cli/qmd.js`). Dies: the whole store. Survives: the "detect the external
  binary, degrade with `ctx.ui.notify` instead of failing" pattern — which is directly relevant to §6 Q4.
- **`@henryqw/pi-memory`** — `MEMORY.md`/`USER.md` with `ENTRY_DELIMITER = "\n§\n"` (`src/store.ts:5`),
  atomic write via unique temp name + `renameFn` (`src/store.ts:328-377`), with a comment worth stealing:
  `// tmp+rename would replace the link itself and silently disconnect` (`src/store.ts:229`) — i.e. the
  atomic-rename contract breaks symlinked stores. Our git store will hit that if `.serena`-style symlinks
  or a `~/.memory -> repo` link exist.
- **`@shanelevs/pi-memory-auto`** — the only candidate that already does **key-index injection**:
  `src/index-map.ts:1-15` documents "MEMORY.md (and the injected block) is a table of unique keywords: one
  line per keyword, no bodies, no gists… deterministic: same entries → same bytes, so the session snapshot
  is stable". That determinism requirement (cache-safe prompt) is a constraint our injection must copy.
  Layout is per-category files (`MEMORY.md`, `CONVENTIONS.md`, `DECISIONS.md`, `FAILURES.md`;
  `src/constants.ts:13,17`), entries serialised as a meta line + body separated by blank lines
  (`src/entry.ts:73`) — no `§`. Global + project tiers. Dies: `turns.ts`, `extractor.ts`, `llm.ts`,
  `consolidate.ts`, `review-gate.ts` (all automatic capture).
- **`@samfp/pi-memory`** — **pure SQLite, no markdown at all**: `~/.pi/memory/memory.db`
  (`src/index.ts:95-96`), tables `semantic` / `lessons` / `events` (`src/store.ts:89-108`), loader picks
  `node:sqlite` `DatabaseSync` or `bun:sqlite` (`src/store.ts:30-35`), FTS5 is *optional* with graceful
  degradation (`src/store.ts:137-174`), vectors are `Float32Array` → BLOB with cosine in JS
  (`src/store.ts:238-285`). Injection is prompt-relevance-selected, capped at
  `MAX_CONTEXT_CHARS = 8000` (`src/injector.ts:12`).
  **Correction to the companion doc:** it describes `@samfp/pi-memory` as markdown with an 8,000-char
  cap. The cap is right; the substrate is not — everything is in SQLite.
- **`pi-hermes-memory`** and **`pi-memory-md`** and **`@remnic/plugin-pi`** — deep dives below.

## 4. Deep dive A — `pi-memory-md` (best store-layer match)

**Shape:** markdown files with YAML frontmatter inside a git repo at `~/.pi/memory-md` (configurable
`localPath`/`repoUrl`), one directory per project (`getMemoryDir` → `path.basename(mainRoot)`), plus an
optional global dir (`getGlobalMemoryDir`). Four bundled skills do the writing
(`skills/memory-{init,write,import,digest}/SKILL.md`); only three tools are actually registered
(`tools.ts:144 memory_sync`, `:397 memory_search`, `:674 memory_check` — `memory_read`/`memory_write`/
`memory_list`/`memory_init` are commented out at `tools.ts:217,269,326,607`).

### (a) Maps cleanly onto the target

| Target property | Their code | Lines |
|---|---|---|
| git repo as store | `memory-git.ts:58 gitExec` (abort/timeout wrapper over `pi.exec`), `:84 syncRepository` (12h `FETCH_HEAD` TTL, `fetch`, `rebase --autostash @{u}`, clone-if-missing), `:149 pushRepository` (`status --porcelain` → `add .` → commit → push) | ~200 |
| one file per key | `types.ts:7 MemoryFrontmatter { description; limit?; tags?; created?; updated? }`; `memory-core.ts:358 readMemoryFileAsync` (gray-matter parse with fallback), `:367 listMemoryFilesAsync` (recursive `.md` walk), `:397 writeMemoryFile` (`matter.stringify`) | ~90 |
| path safety | `utils.ts:75 isPathInside`, `:81 resolvePathWithin`, `:87 hasSymlinkInPath` — path-traversal and symlink-escape checks already written | ~70 |
| tier plumbing | `memory-core.ts:219 getMemoryDir` (project), `:225 getGlobalMemoryDir`, `:238 getCoreDir`, `:242 getUserDir`, `:246 isMemoryInitialized` | ~50 |
| injection at session start | `hooks.ts:13 DEFAULT_HOOKS` (`sessionStart: ["pull"]`), `index.ts:488 before_agent_start` → `return { systemPrompt: ... }`; `memory-core.ts:569 buildMemoryContextAsync` + `:281 renderMemoryTree` | ~120 |
| explicit-write-only | already true: writes happen through agent skills against files, not an auto-extractor | 0 (design) |

Their git layer is genuinely good and hard to get right from scratch: `rebase --autostash` with a
post-rebase behind-count recheck, and a separately-thrown "exists but is not a git repo" case rather than
a silent `init`. Quoting the push path:

```ts
const statusResult = await gitExec(pi, localPath, ["status", "--porcelain"]);
const hasChanges = statusResult.stdout.trim().length > 0;
if (hasChanges) {
  await gitExec(pi, localPath, ["add", "."]);
  const commitResult = await gitExec(pi, localPath, ["commit", "-m", `Update memory - ${timestamp}`]);
```

Note the granularity mismatch: this is **one commit per push of everything**, not one commit per write.
Our design wants commit-per-write, so the call site changes but `gitExec` survives verbatim.

### (b) Architecturally incompatible — delete

- **`tape/` (5,313 LOC, 65% of the package)** — an unrelated transcript-tape subsystem
  (`tape-review.ts` 1,045, `tape-tools.ts` 919, `tape-context.ts` 733, plus reader/thread/gate/anchor/
  analyze/service). Nothing to do with a memory store.
- **`bm25.ts` (177)** — Orama + `nodejieba` CJK tokeniser. Replaced wholesale by SQLite FTS5 (whose
  `trigram` tokenizer covers CJK without a native dep — see §5).
- **`writeMemoryFile` is not atomic** — `fs.writeFileSync` straight to the target, no temp+rename, no
  lock (`memory-core.ts:397-400`). Our private tier must never publish a partially-written ciphertext, so
  this is a rewrite, not a reuse.
- **`renderMemoryTree` shells out to `tree` and `find`** (`memory-core.ts:281-330`) with GNU-only
  `find -printf`. Non-portable and unnecessary once we have an index.
- Skills-as-write-path (`skills/memory-write/SKILL.md`) is directionally right for
  explicit-write-only but is prose, not code; we would write our own.
- Config file precedence, `delivery: "system-prompt" | "message-append"`, hook-action indirection
  (`hooks.ts:58 runHookTrigger`) — pure arity we don't need.

### (c) LOC estimate

**Reusable ≈ 600** of 8,167 (git 200 near-verbatim, store/frontmatter 90, path safety 70, tiers 50,
injection 120, misc 70). **Deleted ≈ 7,550** (tape 5,313, Orama BM25 177, tools 798, index wiring ~450,
renderers ~300, remaining core). Net: a fork is pointless; a *copy of one file plus ~400 lines of ideas*
is the right move.

## 5. Deep dive B — `pi-hermes-memory` (best index + concurrency match)

**Shape:** 17,859 LOC. `store/` 7,871, `handlers/` 5,870, `tools/` 1,452. Markdown `MEMORY.md`/`USER.md`/
per-project store with `ENTRY_DELIMITER = "\n§\n"` (`src/constants.ts:8`), plus a SQLite `sessions.db`
with FTS5 over both session transcripts and memory entries. Native `better-sqlite3`.

### (a) Maps cleanly onto the target

| Target property | Their code | Lines |
|---|---|---|
| SQLite FTS5 index | `store/schema.ts:52,90` — `CREATE VIRTUAL TABLE ... USING fts5(content, content='memories', content_rowid='id', tokenize='trigram')` + the six sync triggers | ~60 |
| rebuildable index | `store/db.ts:79 FTS5_TOKENIZER_VERSION_KEY`, `:1094` comment on why `CREATE VIRTUAL TABLE IF NOT EXISTS` cannot retokenise an existing index, `:331` quarantine-and-rebuild on corruption | ~120 |
| atomic markdown write | `store/memory-store.ts:933-1000 saveToDisk` — `mkdtemp` **in the target directory** (EXDEV-safe), `fs.link` for create-if-absent, `rename` old → `recovery/`, fingerprint recheck either side, rollback on conflict | ~250 |
| conflict detection | `fileFingerprints` map + `readFileState()` + `ExternalMemoryWriteConflict` with bounded retries | ~80 |
| tiering | `paths.ts` `AGENT_ROOT` (`PI_CODING_AGENT_DIR`-aware), `resolveProjectsRoot`, per-project stores under `projects-memory/` | ~60 |
| lexical ranking | `store/fts-query.ts` (158) query escaping + `bm25()` ordering (`sqlite-memory-store.ts:885 bm25(memory_fts) AS rank_score`) | ~100 |
| multi-process safety | `store/atomic-lock-coordinator.ts` — `PRAGMA busy_timeout = 5000`, `journal_mode = WAL`, a `locks` table | ~100 |

Two details worth copying verbatim:

1. **The temp dir goes next to the target, not in `os.tmpdir()`** — the comment says exactly why:
   *"Creates temp files in the same directory as the target to avoid cross-device rename errors (EXDEV)
   when os.tmpdir() is on a different drive than the memory directory (common on Windows)."*
2. **`tokenize='trigram'`** for the FTS5 tables, with the comment *"FTS5 trigram indexes support
   substring search for CJK and retain normal token search for English"*. That removes the need for
   `nodejieba`-style tokenisers entirely — relevant because it kills our only other native dependency.

### (b) Architected against us — delete

- **The entire learning loop**: `handlers/` (5,870) — background review every N turns, auto-consolidation
  with an LLM, correction detection, content/secret scanning, standing instructions, skill store
  (`store/skill-store.ts` 950). Our design is explicit-write-only; **every automatic path is a
  policy violation**, not just dead weight.
- **Session indexing** (`store/session-indexer.ts` 686, `session-parser.ts` 213,
  `session-anchor-search.ts` 472) — depends on reading `~/.pi/agent/sessions/*.jsonl` directly, a host
  internal. Our index covers memory files only.
- **`better-sqlite3`** — a native addon we do not want (see Q4). Their own
  `store/sqlite-native.ts:1-15` is a monument to the cost:
  *"When the host Node that runs Pi (e.g. Homebrew) differs from the Node that compiled better-sqlite3,
  require() throws NODE_MODULE_VERSION errors. Detect that, attempt one npm rebuild against the current
  runtime, and surface a clear recovery path."* — plus `isBunRuntime()` because
  *"Compiled Pi cannot resolve better-sqlite3 … every code path that needs SQLite must route through
  bun:sqlite instead."*
- **`§`-in-one-file** — the whole `MemoryStore` entry model (`memory-store.ts` 1,279) is an array of
  `string` entries joined by a delimiter, with char caps (5,000 per store). Our unit is a file.

### (c) LOC estimate

**Reusable ≈ 650** of 17,859 (atomic write + conflict 330, FTS5 DDL + tokenizer versioning 180,
lock/WAL 100, path resolution 60). **Deleted ≈ 17,200.** A 3.6% survival rate is the honest number; what
we want from this package is *two files' worth of hard-won concurrency code*, not a codebase.

## 6. Deep dive C — `@remnic/plugin-pi` (the only prior art for the private tier)

**Shape:** the published package is a `dist/`-only bundle (364 lines of `.ts`, plus `dist/index.js` that
bundles `@remnic/core`) and is a **thin HTTP/MCP client to a separate daemon**: `remnicDaemonUrl`
defaults to `http://127.0.0.1:4318` (`README.md:76`), start it with `npm i -g @remnic/cli && remnic
daemon start`. So the *pi package* contributes ~0 code to us; the encryption lives in the
`joshuaswarren/remnic` monorepo at `packages/remnic-core/src/secure-store/`
(`cipher.ts`, `kdf.ts`, `keyring.ts`, `header.ts`, `metadata.ts`, `secure-fs.ts`, plus CLI handlers
— 115 KB, ≈2,900 LOC excluding the ~2,000 lines of tests in the same directory).

### (a) Maps cleanly

`cipher.ts` `seal()`/`open()` + `kdf.ts` `deriveKey*()` + `keyring.ts` — ≈300 LOC of portable
`node:crypto` code that implements exactly our private-tier primitive. Everything else in
`secure-store/` (`secure-fs.ts` 34 KB of store-root routing, CLI handlers, header/metadata sidecar
format) is scaffolding for their daemon.

### (b) Incompatible

- The per-file **header envelope with a per-blob salt** (`[VERSION:1][SALT:16][IV:12][AUTHTAG:16][CT]`)
  duplicates what our keyring already knows; we want a store-level salt + per-file IV, and the salt is
  *not* secret, so carrying 16 bytes per file is waste (and it makes "same plaintext → different
  file-bytes" harder to reason about in git, where we *want* stable diffs).
- Their path-bound AAD (file path relative to memory root is authenticated) is **actively hostile to our
  design**: it means `git mv` of an encrypted file produces an auth failure. See Q3.
- Everything daemon-shaped: `.secure-store/header.json`, `unlock`/`lock`/`migrate` CLI, in-memory keyring
  keyed by absolute store path. Our extension runs in-process, so the keyring is just a closure variable.
- Only a subset of roots is covered (*"Only memory files in `facts/`, `corrections/`, `procedures/`,
  `reasoning-traces/`, `artifacts/`, `archive/`, and `profile.md` are encrypted"*), and QMD's index is
  explicitly **not** encrypted. We inherit the same hole unless we treat our index as derived-but-secret.

### (c) LOC estimate

**Reusable ≈ 300** of ~2,900 secure-store lines (cipher ~150, kdf ~120, keyring ~40 — and the keyring is
trivial in-process). **Deleted ≈ 2,600.** Cost of extraction: the code lives in a monorepo with
`CLAUDE.md`-driven conventions and `@node-rs/argon2` wiring; expect to re-derive rather than lift.

## 7. The specific questions

### Q1 — Does any of them import `.serena/memories`? **No. Zero of seven.**

Evidence, in layers:

1. `grep -ri "serena"` over all seven unpacked npm tarballs (`.ts`, `.js`, `.mjs`, `.json`, `.md`):
   **0 matches.**
2. `gh api search/code -f q="serena repo:<r>"` per repo: 0 for `jayzeng/pi-memory`,
   `VandeeFeng/pi-memory-md`, `chandra447/pi-hermes-memory`, `HenryQW/pi-harness`,
   `ShaneLevs/pi-memory-auto`, `samfoy/pi-memory`. For `joshuaswarren/remnic` it returned 3 paths — **all
   false positives**: the only literal occurrence in `tests/bench-beam-runner.test.ts` is a benchmark
   fixture (`content: "Serena owns release approvals for the visible plan."`), and
   `packages/remnic-core/src/utils/serialize-mutations.ts` contains no such string (its only match on a
   direct fetch is the unrelated identifier `onAfterReleaseRenameForTest`).
3. The nearest thing to an importer in the whole set: `pi-memory-md`'s `skills/memory-import/SKILL.md`
   — a *prose* skill that ingests **URLs (via `npx defuddle`), local folders, or files** and asks the
   agent to curate them into memory. Not a migration path from another memory system's format.
   `@remnic/plugin-pi` has real importers — `docs/importers.md` lists `@remnic/import-chatgpt`,
   `-claude`, `-gemini`, `-mem0`, `-supermemory`, plus `-lossless-claw` and `-weclone` — **and no
   serena/basic-memory/obsidian one**.

Implication: the `.serena/memories` importer is entirely ours to write. Note that serialising it is
cheap (`list_memories` + `read_memory` per topic is a directory walk plus `mem:` reference rewriting),
which is exactly why the absence is not a blocker.

### Q2 — One-file-per-key vs one `MEMORY.md` with `§`? One-file-per-record is the minority *and* the only pattern that matches us.

| Package | Layout | Evidence |
|---|---|---|
| `pi-memory-md` | **one file per record**, YAML frontmatter + body, nested `core/user/`, `core/project/`, `reference/` | `types.ts:7`, `memory-core.ts:358-400` |
| `@remnic/plugin-pi` | **one file per record** in `facts/`, `corrections/`, `procedures/`, `reasoning-traces/`, `artifacts/`, `archive/`, + `profile.md` | `docs/encryption.md` §Scope |
| `pi-memory` | multi-file but **not** per key: `MEMORY.md`, `SCRATCHPAD.md`, `daily/YYYY-MM-DD.md`, `notes/` | `index.ts:61-64` |
| `@shanelevs/pi-memory-auto` | multi-file per **category**: `MEMORY.md`, `CONVENTIONS.md`, `DECISIONS.md`, `FAILURES.md`; entries = meta line + body, blank-line separated, **no `§`** | `src/constants.ts:13,17`, `src/entry.ts:73` |
| `pi-hermes-memory` | single `MEMORY.md` + `USER.md` with **`§`** | `src/constants.ts:8` `ENTRY_DELIMITER = "\n§\n"` |
| `@henryqw/pi-memory` | single `MEMORY.md` + `USER.md` with **`§`** | `src/store.ts:5` `ENTRY_DELIMITER: string = "\n§\n"` |
| `@samfp/pi-memory` | **neither — SQLite rows** (`semantic`, `lessons`, `events`) in `~/.pi/memory/memory.db` | `src/store.ts:89-108`, `src/index.ts:95-96` |

Verdict: **2 of 7 one-file-per-record, 2 of 7 single-file with `§`, 2 of 7 multi-file-by-category-or-log,
1 of 7 SQLite-only.** So the `§` layout is *not* more common than one-file-per-key — it is tied, and the
`§` pair are both direct ports of Nous Research's Hermes `MemoryStore` (their own docs say so:
`hermes/docs/ROADMAP.md:7` "Persistent memory via `MEMORY.md` + `USER.md` with `§` delimiter"). What is
genuinely more common is "markdown files as substrate" (5 of 7).

Consequence for us: we are not fighting a convergence, we are choosing the layout that buys per-file git
diffs, per-key atomic rename, per-key encryption granularity, and filename-addressable keys. The `§`
layout buys a single small file for cheap always-inject — which our key-index tier already solves better.

### Q3 — `@remnic/plugin-pi` crypto, precisely

**Source:** `packages/remnic-core/src/secure-store/{cipher,kdf,keyring}.ts` at `main` (2026-10-29),
plus `docs/encryption.md` in the same repo.

**Cipher and mode** — AES-256-GCM via `node:crypto`, no third-party crypto library:

```ts
/** GCM nonce length. 96 bits is the NIST-recommended size for AES-GCM. */
export const IV_LENGTH = 12;
/** GCM authentication tag length. 16 bytes (128 bits) — the maximum. */
export const AUTH_TAG_LENGTH = 16;
export const ENVELOPE_SALT_LENGTH = 16;
/** Required key length for AES-256. */
export const AES_KEY_LENGTH = 32;
```

```ts
const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv), {
  authTagLength: AUTH_TAG_LENGTH,
});
```

Fresh nonce per write: *"IV (12 bytes): GCM nonce. Must be unique per (key, ciphertext) pair. We generate
it fresh from `randomBytes` on every encrypt call. Reusing an IV with the same key destroys GCM's
confidentiality and authenticity guarantees."*

**On-disk format** (docs and code agree; envelope is self-contained, salt included):

```
[VERSION:1][SALT:16][IV:12][AUTHTAG:16][CIPHERTEXT:...]
```

The file-level wrapper is `[MAGIC:10][VER:1][FLAGS:1]` with `MAGIC` = ASCII `"REMNIC-ENC"` so the file is
sniffable without decrypting it.

**KDF** — Argon2id by default, scrypt for compatibility stores. Algorithm + params are persisted in
`.secure-store/header.json`, and `deriveKey()` dispatches on the recorded name so old stores keep working:

```ts
export function deriveKey(
  algorithm: KdfAlgorithm, passphrase: string, salt: Uint8Array,
  params: ScryptParams | Argon2idParams,
): Buffer {
  if (algorithm === "scrypt") return deriveKeyScrypt(passphrase, salt, params as ScryptParams);
  if (algorithm === "argon2id") return deriveKeyArgon2id(passphrase, salt, params as Argon2idParams);
  throw new Error(`unknown KDF algorithm: ${algorithm as string}`);
}
```

- Argon2id: `memoryKiB 65536` (64 MiB), `iterations 3`, `parallelism 4`, `keyLength 32`, via
  `@node-rs/argon2`.
- scrypt legacy: `N = 1 << 17` (131072), `r 8`, `p 1`, `maxmem 256 MiB`, `keyLength 32`, via
  `node:crypto.scryptSync`.
- Salt: `KDF_SALT_LENGTH = 16`.
- Argon2 is a **native dependency**, and they know it: *"Argon2id KDF requires `@node-rs/argon2` to be
  installed and loadable on this platform. Use scrypt compatibility mode for stores that must run without
  the Argon2 native binding."*

**AAD** — the envelope header (version + salt) is always bound; caller AAD (in their case the file path)
is appended: `const finalAad = options.aad ? Buffer.concat([headerAad, Buffer.from(options.aad)]) : ...`.
Docs: *"Path-bound AAD: the file path relative to the memory root is bound as GCM associated
authenticated data. Moving or renaming an encrypted file without re-encrypting it will cause an auth
failure on next read."* **Do not copy this.** Our store is a git repo; renames are a normal operation.

**Where the key comes from** — user passphrase, derived per unlock, held only in process memory,
never persisted:

```ts
const ENTRIES = new Map<string, KeyringEntry>();
// "The keyring is process-local: keys are NEVER persisted to disk, never
//  logged, and never serialized. A daemon restart re-locks every registered store."
```

`lock()`/`lockAll()` zero the buffer before dropping it, with an honest caveat: *"The JS engine may keep
additional copies outside our control; this is best-effort hygiene, not a defense against memory-dump
attacks."* **Not keychain-backed, not OS-keyring-backed.** (Contrast: `signetai`, #5 in the companion
doc, uses an OS-keyring master key — but for its secrets store, not memories.)

**Does it gate reads behind a confirmation? No.** There is no approval prompt, no per-read confirmation,
no second factor. Reads are gated only by *lock state*: when locked, `recall` returns

```
[secure-store locked] Memory store is encrypted and locked. Unlock the
secure-store inside this daemon process, or restart the daemon through a
secure-store aware launcher that installs the key.
```

and their own threat model concedes the boundary: *"A running, unlocked daemon — once the store is
unlocked, the decryption key is held in memory. Any process that can communicate with the daemon
(localhost MCP, HTTP, CLI) can retrieve plaintext memories."* Grepping the shipped bundle for
`confirm` / `requiresConfirmation` yields nothing read-gated.

**The transferable lesson for our private tier:** unauthenticated-but-encrypted is fine as a disk
protection, and their two-gap disclosure is the part to copy — (1) *"The search index (QMD) is not
encrypted by this module — content is recoverable from the index even when memory files are ciphertext"*,
and (2) sidecar state and JSON indexes remain plaintext. Our FTS5/sqlite-vec index will contain the
plaintext of private entries unless we encrypt at the index layer too; since the index is rebuildable,
the correct answer is to **exclude the private tier from the on-disk index** and rebuild it in memory
after unlock.

### Q4 — Does anyone ship or invoke a native/compiled binary from npm? Yes, four different ways, and none handles Gatekeeper.

**Baseline: nobody mentions quarantine.** `grep -ril -E "gatekeeper|quarantine|xattr|codesign|xcode-select|spctl"`
over all seven packages returns only unrelated hits — Remnic's namespace dead-letter command (`remnic
quarantine list`) and Hermes's corrupt-DB quarantine logic. **Zero lines of macOS distribution,
notarisation, or `com.apple.quarantine` handling in the entire candidate set.**

The four patterns actually in use:

| Pattern | Who | Mechanism | Gatekeeper / CLT behaviour |
|---|---|---|---|
| Invoke an external CLI installed from npm | `pi-memory` → `qmd` (`@tobilu/qmd` 2.8.3, `bin: { qmd: "bin/qmd" }`) | `execFile` on `qmd`, with a Windows-shim workaround that resolves `node_modules/@tobilu/qmd/dist/cli/qmd.js` and runs it under `node` (`index.ts:883-931`) | Works because the "binary" is a JS entrypoint under `node`. **No quarantine issue at all** — the trick is that it is not a Mach-O. |
| npm-shipped native addon with node-gyp | `pi-memory-md` → `nodejieba@3.5.8`, `scripts.install = "npx @mapbox/node-pre-gyp install --fallback-to-build"` | loaded lazily through a `import("nodejieba")` guarded by a Han-regex check (`bm25.ts:38-58`) | `--fallback-to-build` **requires Xcode CLT** when no prebuilt matches the ABI; then a `node-gyp` failure surfaces at `import` time (caught, degrades to a regex fallback tokeniser) |
| npm-shipped native addon with ABI repair | `pi-hermes-memory` → `better-sqlite3@^13` | `store/sqlite-native.ts`: catch `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED`, run **one** `npm rebuild`, else throw a typed `BetterSqlite3LoadError`; `isBunRuntime()` → `bun:sqlite` | The rebuild path needs CLT. They are explicit that this actually happens: *"When the host Node that runs Pi (e.g. Homebrew) differs from the Node that compiled better-sqlite3, require() throws NODE_MODULE_VERSION errors."* |
| Platform-specific **optionalDependency** packages holding a prebuilt binary | `@tobilu/qmd` → `sqlite-vec` with `optionalDependencies: { "sqlite-vec-darwin-arm64": "0.1.9", "sqlite-vec-darwin-x64": ..., "sqlite-vec-linux-arm64": ..., ... }`; each package declares `os: "darwin"`, `cpu: "arm64"` | npm's own platform filtering installs only the matching artefact; no build step, no postinstall download | **This is the only pattern in the ecosystem that avoids both CLT and a network fetch at install time.** Untested here for quarantine behaviour — see UNVERIFIED |

Plus one pure-JS escape hatch worth noting: `@samfp/pi-memory` → `node:sqlite` / `bun:sqlite` (no native
dep at all), with FTS5 treated as optional because *"FTS5 not available (node:sqlite compiled without
SQLITE_ENABLE_FTS5)"* (`src/store.ts:174`).

**Answer to the open packaging problem for our Swift CLI:** there is no prior art for this. The closest
and best-fitting precedent is `sqlite-vec`'s **platform-specific optionalDependencies** layout — publish
`@ourscope/embed-darwin-arm64` / `-darwin-x64` with `os`/`cpu` fields containing a precompiled,
codesign-ad-hoc'd binary, so npm installs only the matching one and there is no postinstall build or
download. Two unresolved items that no candidate answers:

- **Quarantine.** A Mach-O delivered inside an npm tarball is not quarantined (npm does not set
  `com.apple.quarantine` on extracted files — extraction is via `tar`, not a download-agent-wrapped
  unzip). So Gatekeeper is *probably* a non-issue for the npm path and only a real issue for a
  user-downloaded `.zip`/`.pkg`. **UNVERIFIED** — I did not install and check `xattr` on a real artefact,
  and that is the one measurement that would settle it.
- **Absence of Xcode CLT** only matters if we ever compile at install time. The whole point of shipping a
  prebuilt binary is to not do that; but Swift-linked binaries pull `libswift_*` runtime libraries from
  the OS (macOS 10.14.4+ has them in `/usr/lib/swift`), so a `swiftc`-built CLI is genuinely
  redistributable without a toolchain on the target. Not verified here either.

## 8. What this means for the fork decision

1. **Licensing is a non-issue.** All seven are stock MIT with no CLA, no trademark clause, identical
   bodies. Modification and redistribution under our own name are permitted; the only obligation is a
   `THIRD_PARTY_NOTICES` file with the copied copyright line(s).
2. **No candidate is forkable as a codebase.** Best survival rate is `pi-memory-md` at ~7% (600 of
   8,167) and `pi-hermes-memory` at ~3.6%. Both numbers are dominated by one subsystem each (git layer /
   atomic write + FTS5). Everything we would keep is small enough to read in an afternoon and re-type
   with our own types — which is cheaper than inheriting a 470k-line monorepo or a 17.9k-line learning
   loop.
3. **The right relationship is "copy three files' worth of technique, credit them, write our own":**
   - `pi-memory-md/memory-git.ts` (~200) — git store, the only near-verbatim lift worth doing.
   - `pi-hermes-memory/store/memory-store.ts:933-1000` (~250) — atomic write + fingerprint conflict
     detection, EXDEV-safe temp placement. (Rewrite: theirs is non-atomic at the file level for us
     because our writes are per-key, not whole-store.)
   - `@remnic/plugin-pi`'s `remnic-core/src/secure-store/{cipher,kdf,keyring}.ts` (~300) — AES-256-GCM
     envelope + KDF dispatch + in-memory keyring, minus the path-bound AAD.
4. **Three design facts we get for free from their mistakes:** use FTS5 `tokenize='trigram'` (kills
   `nodejieba`); keep the index rebuildable and exclude the private tier from it (kills Remnic's QMD
   leak); make the key-index injection byte-deterministic for a given entry set (`@shanelevs`'s stated
   invariant, needed for prompt-cache stability).
5. **The `.serena/memories` importer is greenfield** — nobody has one, and nothing in the set does
   one-file-per-key + git + tiers together, so there is no upstream to track.

## 9. UNVERIFIED

- **Quarantine behaviour of a Mach-O inside an npm tarball** — asserted from how npm extracts (no
  download-agent, so no `com.apple.quarantine` xattr) but not measured. The discriminating check is
  `xattr -p com.apple.quarantine <installed binary>` after `npm i` on a real package that ships a
  prebuilt macOS executable. `sqlite-vec-darwin-arm64` (a `.dylib`) is the natural subject.
- **Whether `better-sqlite3@13` still needs CLT on darwin-arm64.** `npm view better-sqlite3 scripts`
  shows no `install` script (v13 appears to have moved to bundled `prebuilds` + `node-gyp-build`), so its
  CLT exposure may now be zero. Hermes's ABI-repair path implies it still bites in practice; not tested.
- **`nodejieba` prebuilt coverage for darwin-arm64** at the Node ABI Pi runs — `node-pre-gyp
  --fallback-to-build` implies coverage gaps exist, but I did not enumerate the published prebuilds.
- **Exact reusable LOC.** The three "survives" figures (~600 / ~650 / ~300) are my structural estimates
  from reading the relevant functions, not a diff. They are the softest numbers in this document.
- **`@henryqw/pi-memory`'s monorepo home.** Package repo is `HenryQW/pi-harness` (MIT, 20★), and
  `packages/pi-memory/src/store.ts` at HEAD matches the npm install location, but I did not confirm that
  is the published source path (the tarball ships prebuilt `extensions/memory.ts` + `src/`).
- **Remnic's `alpha` (10.0.36) vs `latest` (9.69.56) divergence** — I compared the repo at `main` and the
  `latest` tarball, not 10.0.36 specifically. The secure-store module is present at `main`; whether it is
  identical in 9.69.56 is unchecked.
