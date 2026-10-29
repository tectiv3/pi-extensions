# pi agent memory — spec

Status: revision 5 (fourth plan-critic pass). Date 2026-10-29.
Rev 1 → 30 findings. Rev 2 → 7 blocking. Rev 3 → 6 blocking. Rev 4 → 8 blocking, 12 high.
All addressed. §14 is the finding-to-fix map; §15 is the implementation sequence.

**Product identity: personal, single-user, local. Not published.** Installed by symlinking into
`~/.pi/agent/extensions/`. No npm release, no per-arch matrix, no CI. §11.

## 1. What this is

A pi extension that gives agents a persistent, tiered, searchable memory store.

- **Store**: plain markdown, one file per note, in a git repo. git is the history, the diff, and the undelete.
- **Index**: SQLite (FTS5 + `sqlite-vec`) under the store. Disposable — delete it and reindex.
- **Tiers**: two orthogonal properties — `scope ∈ {global, project}` × `access ∈ {open, gated}`.
- **Gate**: reading a gated note requires explicit user confirmation; every attempt is logged.
- **Search**: BM25 plus on-device `NLEmbedding` vectors (English). No network, no model download.

Replaces `.serena/memories` as the injection path. Updating `AGENTS.md` is a **manual step**;
`/memory import` prints the exact line to remove.

### Non-goals (deliberate, decided)

| Not doing | Why |
|---|---|
| Multi-process coherence as a product claim | Single-user local use. §12 still tests it, so the assumption is checked rather than asserted. |
| Encryption of gated notes | The gate is consent and notification, not confidentiality (§9). |
| Automatic capture at compaction | Compaction is a context problem, not a memory problem. |
| Non-English embeddings | `NLEmbedding` returns nil for everything but `en`/`fr`. |
| Hosted or multi-machine store | Same machine only. |
| Chunk-level vectors | One vector per note (§8.2). |
| Publishing to npm | Personal tool. Symlink install (§11). |

## 2. Data model

A note is identified by `(scope, project, key)`.

```
scope    global | project
project  '' for scope=global, else the project id (§3.2). NEVER NULL — §4.
key      normalized path-like string, e.g. "auth/session_handling"
access   open | gated
body     markdown, excluding frontmatter
```

`access` is a per-note property, not a tier: a gated note still belongs to a project or to global.
`private` as a third tier conflated a scope with a permission.

### 2.1 Frontmatter — the on-disk representation of `access`

`access` must survive deletion of `index.db` (§3.3). Its only on-disk representation is a frontmatter
block. **A gated note file MUST begin with:**

```
---
access: gated
---
```

An `open` note has **no frontmatter block** — the file is pure body, so imported and hand-written
markdown is untouched.

**Parsing is strict but must not fail open.** A lenient parser that misses a gated block silently
un-gates the note *and* leaves `access: gated` in `notes.body`, where it becomes searchable. So:

1. Strip a UTF-8 BOM if present; normalise CRLF → LF **for matching only**. `fm_len` remains the byte
   offset of the body in the original file.
2. If the (normalised) file does not start with `---\n`, there is no frontmatter: the whole file is
   body, `access=open`, `fm_len=0`.
3. If it does start with `---\n`, scan to the next `\n---\n` or EOF. That region is a **candidate**
   block.
4. If the candidate block contains an `access:` line, it **is** frontmatter: parse `access`, and
   `fm_len` = byte offset of the body. An unparseable `access:` value is an **index error**, not a
   silent `open`.
5. If the candidate block does **not** contain `access:`, it is not frontmatter — the file is body and
   `access=open`. This is what makes a markdown horizontal rule (`---` … `---`) harmless.
6. Unknown keys inside a valid block (`tags:`, `note:`) are tolerated and ignored; they do not change
   `access` and do not re-enter `notes.body`.

Measured failure modes this rule exists to prevent, with the naive `^---\n(access: (open|gated)\n)?---\n`
regex: CRLF, BOM, an extra key, an upper-case key, and a trailing space all failed to match, produced
`fm_len=0`, set `access=open`, and left the gated text in the body.

`fm_len` lets `memory_edit` reject an `oldText` matching inside the frontmatter without re-parsing, and
lets reindex slice the body deterministically. **Reindex reads `access` from the file**, which is what
makes `rm index.db` lossless rather than a gate bypass.

`created_at` / `updated_at` are **not** stored — they come from git commit history.

### 2.2 Key normalization

`normalizeKey()` is the only way a key enters the system. **Order matters** — validation runs on the
lowercased form:

1. Unicode **NFC**.
2. Strip a trailing `.md`.
3. Collapse `//` to `/`.
4. **Lowercase.**
5. **Reject** if: empty; leading `/`; any `..` segment; any `.` segment; any segment starting with `.`;
   or any character outside `[a-z0-9/_.-]`.
6. **Reject** if the *resolved* target is a symlink, or if **any parent directory** up to the scope
   root is a symlink (`realpath` the parent and compare to the expected root). Checking only the leaf
   is insufficient: a symlinked parent redirects `tmp+rename` just as effectively.

Keys are case-insensitive because APFS is: `Auth/Session` and `auth/session` are one file on disk but
would be two rows in SQLite. `Auth/Session` is therefore **accepted and lowercased**.

### 2.3 Hashing

`baseHash` and `body_hash` are `sha256` of the **entire file including frontmatter**. Hashing only the
body would make an `access` flip invisible to the edit precondition.

## 3. Storage

### 3.1 Layout

```
~/.pi/memory/                     git repo (the store)
├── .gitignore                    /index.db*  /access.log*  /projects.json  *.tmp
├── global/preferences/editor.md
├── projects/pi-extensions-1a2b3c4d/auth/session.md
├── index.db                      SQLite, gitignored, rebuildable
├── access.log                    JSONL, gitignored
└── projects.json                 gitignored, write-once metadata: id → {name, path, remote}
```

**`.gitignore` anchoring is mixed, deliberately.** `/index.db*`, `/access.log*`, `/projects.json` are
root-anchored. **`*.tmp` is unanchored**, because §3.4 step 3 writes `path.tmp` *in the note's own
directory*: an anchored `/*.tmp` matches only the repo root, so a crashed temp file is visible to
`git status` and §3.3's sweep commits it as `memory: recover uncommitted`. (A note key `notes.tmp`
cannot collide either way — it is written as `notes.tmp.md`.)

Key = file path relative to its scope directory, minus `.md`. One file per key, so
`git log -- projects/<id>/auth/session.md` is the note's history. Commit messages name the key.

**`projects.json` is authoritative for `{name, path, remote}` and is NOT derivable by scanning** — a
directory scan yields only ids, which cannot produce a human name or a stale path. Written on a
project's first use and updated by read-merge-write under the repo lock as its **own step (§3.4 step
1a)**, because project resolution happens before any commit. The write is atomic
(`projects.json.tmp` + `rename`). Gitignored: it holds machine-specific absolute paths.

**Repo initialisation**: `git init` on first use, with `user.name`/`user.email` set **in that repo's
local config**, so the `identity` failure class cannot occur.

### 3.2 Project identity

```
if git remote "origin" exists and is a network remote:
    r = normalizeRemote(url)
    id = slug(lastPathSegment(r)) + "-" + sha256(r)[0:8]
else:
    id = slug(basename(git_root_realpath)) + "-" + sha256(git_root_realpath)[0:8]
```

The remote branch takes its display name from the **remote's** last path segment, not the local
directory: renaming a checkout must not change the id.

`normalizeRemote()`: drop scheme; drop credentials and `user@`; convert scp `host:owner/repo` →
`host/owner/repo`; drop default ports (`22`, `443`, `80`) but keep non-default; drop query and
fragment; drop trailing `/` and `.git`; **lowercase the entire result**. Lowercasing only the host
produces two ids for one repo (`Owner/Repo` vs `owner/repo`), the exact orphan this section prevents.
Documented tradeoff: a self-hosted case-sensitive host would collide two distinct repos.

`file://` and bare-path remotes are treated as **no remote** — an absolute path in the hash destroys
the move-invariance remote-first exists for.

### 3.3 Authoritative vs derived

**git + markdown is authoritative. `index.db` contains nothing unique.** A crash cannot lose a write.
Any process may rebuild the index at any time.

**Startup sweep**: on `session_start` (skip when the reason is `reload`), if `git status --porcelain`
shows any of `??`, ` M`, `M `, `A `, ` A `, `D ` under `global/` or `projects/`, commit them as one
`memory: recover uncommitted`. The set matters: after §3.4 adds the path, a crash between add and
commit leaves `A `, which is neither untracked nor modified.

**The sweep takes the same repo lock as the write path.** Without it the sweep and a writer race on
git's shared index exactly as two writers do: the sweep commits the writer's staged note under the
wrong message, and §12.1's message-naming fails silently while the writer is told `nothing to commit`.
`session_start` fires per process, including every subagent spawn, so this is live. A subagent that
cannot acquire the lock logs and skips the sweep rather than failing its own startup.

Documented limitation: the sweep cannot distinguish a crashed write from a deliberate hand edit. Both
become `memory: recover uncommitted`. Hand-editable markdown is a feature; losing that distinction is
its cost.

### 3.4 Write path

**1. Resolve.** `normalizeKey()`, refuse symlinks (§2.2 step 6), resolve scope (§5.1), resolve `access`
(§5.1 — preserved on update).

**1a. Register the project if new.** If `scope=project` and the id is absent from `projects.json`: take
the repo lock, re-read, merge this id's `{name, path, remote}`, write `projects.json.tmp` + `rename`,
release.

**2. Gate.** If the operation touches a gated note: write a `pending` line (§7.1), then confirm. On
decline or throw, write the resolver and abort **before touching disk**.

**3. Write the file.** Content is `frontmatter(access) + body` when gated, else the bare body (§2.1).
Write `path.tmp` in the same directory, `fsync`, `rename()` over the target.

**4. Commit under the repo lock.**

- Acquire `.git/pi-memory.lock` (§3.5). 5 tries, 100/200/400/800/1600 ms backoff.
- `git -c commit.gpgsign=false add -- <path>` — **the add is required.** A pathspec-only commit cannot
  commit an untracked file: measured, `git commit -m msg -- global/newdir/new.md` fails with
  `error: pathspec … did not match any file(s) known to git`. That would break every create, every
  import, and the first write in a fresh store. Adding only `<path>` leaves a foreign staged file
  staged (measured), so the add does not reintroduce the race the lock exists to prevent.
- `headBefore = git rev-parse HEAD` (may be empty in a fresh repo).
- `git -c commit.gpgsign=false commit -m "memory: <op> <key>" -- <path>`.
- **Classify on evidence, never on git's message.** The `nothing to commit` phrase only appears when
  the tree is otherwise clean (`nothing to commit, working tree clean`); with any other uncommitted
  change present, identical content yields `no changes added to commit`, exit 1. The store is most
  likely dirty precisely when a concurrent writer exists, so a phrase check fails in the one race it
  exists for. Success iff **any** of:
  - `git rev-parse HEAD` moved from `headBefore`, or
  - `git cat-file -e HEAD:<path>` succeeds **and** `git diff --quiet HEAD -- <path>` exits 0
    (content is in HEAD). `git diff --quiet` alone is **unsound**: measured, it exits 0 for an
    untracked file and for a path that never existed, so on its own it certifies nothing.
  - for a delete: the path is absent from both HEAD and the worktree.
- Other failures are classified and surfaced: **lock** (retries exhausted), **signing**, **identity**,
  **other**.
- Release the lock in `finally`.

**5. Index upsert — required.** `RETURNING id` form (§4). Retry 3× with 50 ms backoff. Store `fm_len`
and `body_hash`. On failure return `"written and committed, but not indexed; run /memory index"`.

**6. Log the resolver** for gated operations — in a `finally`, so an approved-but-failed mutation still
resolves its `pending` line (§7.1).

**7. Enqueue an embedding job** keyed by `(scope, project, key, body_hash)` — never by `notes.id`,
which every rebuild reassigns.

Steps 3–4 must succeed for the write to be committed. Step 5 must succeed for the tool to report
success. Only step 7 is fire-and-forget.

### 3.5 The lock is advisory

`.git/pi-memory.lock` is an O_EXCL file containing `pid ts`. **Staleness takeover is not atomic and is
not claimed to be**: two processes can both read a stale lock, both unlink, both create, and both enter
the critical section — measured with the same algorithm at a compressed time scale. The lock therefore
provides *mutual exclusion in the normal case and eventual progress always*, which is what this store
needs (single user, rare concurrency).

Rules that make it survivable:

- **Treat unparsable content as "held"** and decide on `mtime` alone. `open(O_EXCL)` then `write(pid)`
  exposes an empty file; `Number("") === 0` and `process.kill(0, 0)` succeeds, so a reader would
  otherwise see a live pid where there is none.
- **Staleness threshold 30 s**, refreshed by `utimes` after each git subprocess returns. The threshold
  must exceed the worst critical section (a large import or a multi-file sweep can run for seconds;
  §8.1 measures the machine at load average 14).
- Takeover requires the recorded pid to be dead **or** `mtime` older than the threshold.
- A victim whose lock was stolen must detect it before unlinking: re-read the file and only unlink if it
  still contains its own pid.
- `/memory index --force-unlock` removes a lock whose pid is alive but wedged.

`.access.log.lock` (§7.2) uses the same rules, including takeover — without it a single SIGKILL bricks
rotation permanently.

## 4. Index

`index.db` (SQLite, WAL, `busy_timeout=5000`), opened with `{allowExtension: true}`:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE notes(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,   -- never reuse ids
  scope      TEXT NOT NULL,
  project    TEXT NOT NULL DEFAULT '',            -- '' means global; NEVER NULL
  key        TEXT NOT NULL,
  path       TEXT NOT NULL,
  body       TEXT NOT NULL,                       -- body WITHOUT frontmatter
  fm_len     INTEGER NOT NULL,                    -- frontmatter byte length (§2.1)
  body_hash  TEXT NOT NULL,
  vec_hash   TEXT,                                -- body_hash the stored vector was built from
  access     TEXT NOT NULL,
  mtime      INTEGER NOT NULL,                    -- floor(stat(path).mtimeMs)
  UNIQUE(scope, project, key)
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  key, body, content='notes', content_rowid='id'
);

-- External-content FTS5 does NOT index itself: without these three triggers the
-- table has rows and MATCH returns nothing (measured).
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, key, body) VALUES (new.id, new.key, new.body);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, key, body) VALUES('delete', old.id, old.key, old.body);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, key, body) VALUES('delete', old.id, old.key, old.body);
  INSERT INTO notes_fts(rowid, key, body) VALUES (new.id, new.key, new.body);
END;

CREATE VIRTUAL TABLE vec_notes USING vec0(
  note_id INTEGER PRIMARY KEY, embedding FLOAT[512]
);

CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
-- seeded on create: schema_version='1', embed_model='nlembedding-en',
--                   embed_dim='512', vec_enabled='true'|'false'
```

`project` is `''`, never `NULL`: SQLite treats `NULL` as distinct in `UNIQUE`, so a nullable `project`
permits unlimited duplicate global rows for one key — measured, two inserts of `('global', NULL, 'a/b')`
both succeed. `''` closes it and makes the `ON CONFLICT` target expressible without an expression index.

`notes.body` excludes frontmatter, so BM25 never matches `access: gated` on every gated note.

`mtime` is `floor(fs.stat(path).mtimeMs)`, taken from the file. A bulk rebuild stamping `Date.now()`
yields only 23 distinct values across 500 notes, making "recent first" unexpressible. Ordering is
always `ORDER BY mtime DESC, id DESC`.

**Upsert with `RETURNING id`.** `INSERT OR REPLACE` is a defect: REPLACE's implicit delete does not
fire `notes_ad` unless `recursive_triggers` is on, so the old key stays searchable while
`integrity-check` reports **ok**. And `ON CONFLICT DO UPDATE` does **not** set `last_insert_rowid()` —
measured: after `upsert a/one` following `insert a/two`, `lastInsertRowid` is `2` while `a/one`'s id is
`1`. Using it attaches `a/one`'s embedding to `a/two`.

```sql
INSERT INTO notes(scope, project, key, path, body, fm_len, body_hash, vec_hash, access, mtime)
VALUES (?,?,?,?,?,?,?,NULL,?,?)
ON CONFLICT(scope, project, key) DO UPDATE SET
  path = excluded.path, body = excluded.body, fm_len = excluded.fm_len,
  body_hash = excluded.body_hash, access = excluded.access, mtime = excluded.mtime
RETURNING id;
```

`vec_hash` is not updated by the upsert: it records which body the *stored vector* came from.

**Vector write is insert-or-update, in this order:**

1. `UPDATE vec_notes SET embedding = ? WHERE note_id = ?` → if `changes === 0`, the row does not exist.
2. `INSERT INTO vec_notes(note_id, embedding) VALUES (?, ?)`.
3. On `UNIQUE constraint failed`, retry step 1 (another process inserted between 1 and 2 — the vec table
   is outside the repo lock, so this race is real).

Then `notes.vec_hash = body_hash`. Measured: `UPDATE` on a missing row returns `{changes: 0}` with no
error, and `INSERT OR REPLACE` raises `UNIQUE constraint failed` — so a spec that only says "re-embed
is an UPDATE" never lands a note's **first** vector.

**Vectors are unit-normalized before insert and `vec0` uses L2 distance.** `NLEmbedding` norms are
6.2–9.3 (`en`) and 0.054 (`fr`), so L2 on raw vectors ranks by magnitude.

**`vec_notes.note_id` must be a `BigInt` (`1n`).** Measured: `vec0` rejects a JS number with
*"Only integers is allows for primary key values"*. All call sites go through `toVecId()`.

**Reindex policy**: per-file content hash. On `session_start` and after every write, compare
`sha256(file)` against `body_hash` and reindex what changed. **Additionally enqueue an embedding job for
every note where `vec_hash IS NULL OR vec_hash <> body_hash`.** Without that predicate nothing ever
re-enqueues, because the write path already stored the matching `body_hash`.

**Full rebuild is one transaction on the existing database**, never a second file and a rename:

```sql
BEGIN IMMEDIATE;
DELETE FROM notes;                              -- fires notes_ad per row
DELETE FROM vec_notes;
-- repopulate from disk; triggers maintain notes_fts
COMMIT;
```

Wrapped in `try/catch` with `ROLLBACK`. Without it a mid-repopulate throw leaves an open
`BEGIN IMMEDIATE` and every later write fails after `busy_timeout`.

`index.db.new` + rename is **wrong and measured to fail**: a stale `index.db-wal` from a concurrent
writer is replayed over the new main file, the rebuild is lost, `integrity_check` reports **ok**, and
the live writer errors with `no such table`.

`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')` is a repair command only.

**Delete** is one transaction over all three tables:

```sql
BEGIN;
DELETE FROM notes WHERE id = ?;                 -- fires notes_ad
DELETE FROM vec_notes WHERE note_id = ?;
COMMIT;
```

**Search shape.** `bm25()` returns **negative** scores where more negative is better, so ranking is
`ORDER BY bm25(notes_fts) ASC`. `DESC` selects the worst hit — with a 30-note store the two directions
pick opposite notes.

- BM25 candidate depth: 50.
- Vector `k`: 20, filtered **before** `k` as
  `note_id IN (SELECT id FROM notes WHERE access = 'open')`. A JOIN applies the filter *after* `k` and
  silently loses recall — measured: 1 row returned where 3 were expected.
- Fusion: reciprocal rank fusion, `k = 60` (the RRF constant, not a depth).
- Default `limit`: 10.

## 5. Tools

Gated operations take a **required** `reason: string` (max 500 chars), which is logged.

| Tool | Signature | Notes |
|---|---|---|
| `memory_index` | `(scope?)` | Keys + first line of each note's **body** (a gated file's first line is `---`). Gated notes appear as a count only: `gated: 3 hidden`. No `includeGated` (§5.2). |
| `memory_search` | `(query, scope?, limit?)` | RRF over BM25 + vectors, `limit` default 10. Gated notes excluded **in SQL, before ranking**. |
| `memory_read` | `(key, scope?)` | The only way an **agent** reaches gated content. Confirm + log if gated. |
| `memory_write` | `(key, body, scope?, access?, baseHash?)` | Creates or fully replaces. Returns a unified diff. Confirm + log if gated. |
| `memory_edit` | `(key, oldText, newText, baseHash, scope?)` | Exact-text replacement; **rejects when `oldText` matches more than once** (same rule as pi's `edit`). Rejected if `baseHash` ≠ current file hash. Cannot touch frontmatter. Confirm + log if gated. |
| `memory_delete` | `(key, scope?)` | Removes the file, commits, clears all three index tables. Confirm + log if gated. |

`memory_write` takes an **optional** `baseHash` (creation has nothing to compare against); when
supplied and stale it is rejected as `memory_edit` is.

The diff is produced by `git diff --no-index`, which **exits 1 when files differ** — that is success,
not an error; only exit codes > 1 are failures.

**The gate decision reads the file, not the index.** `memory_read` inspects the note's leading bytes at
operation time. Trusting `notes.access` would let a note hand-gated mid-session be read with no confirm
and no log until the next reindex. The index's `access` column is used only for listing and filtering.

### 5.1 Scope resolution and `access` defaults

- **`scope` omitted, reads**: try **project first, then global**. Only the tier the file was actually
  found in governs the gate. The not-found error names every tier tried.
- **`scope` omitted, discovery** (`memory_index`, `memory_search`, mention detection, the injected
  block): cover **both** tiers, project results ranked first on ties, each row labelled with its tier,
  gated counts summed. "Project wins" only means something if a project miss falls back to global —
  revision 5 filtered to the resolved tier, which made the global tier **unreachable from inside any
  repository**.
- **Explicit `scope`** narrows to exactly that tier.
- **cwd is not a git repo**: global only; `scope: project` errors (`"not in a git repository; no project
  scope"`).
- **`access` on create**: defaults to `open`.
- **`access` on update**: **preserved**. A full-body replace must never silently un-gate. Changing it
  requires passing it explicitly.
- **`baseHash` is checked before the gate.** A stale write must not prompt the user to approve
  something that is then rejected.

### 5.2 Why `includeGated` was removed

Revision 1 gave `memory_index` and `memory_search` an `includeGated` boolean — a gate bypass: one
parameter returned gated keys and bodies with no confirmation and no log line. Both are gone. **Gated
content is reachable by an agent only through `memory_read`.** The user reaches it through
`/memory show` (§10).

### 5.3 Subagent surface

Subagents get the injected index and `memory_read` **for open notes only**. No search, edit, write, or
delete.

**There is no subagent field in the host API**, and **no way to pass a flag to a subagent**:
`ExtensionContext` exposes `mode`, `hasUI`, `cwd` and nothing about nesting; `registerTool` runs at load
time with no ctx; the subagent extension builds the child argv itself (`subagent/index.ts:2038`,
`:2071-2076`) and pushes only `--model/--thinking/--tools/--exclude-tools/--append-system-prompt`, with
no arbitrary-flag hook and no `env:`.

**Delivery is an environment variable, and it needs a one-line change in the subagent extension:**

> `subagent/index.ts` spawns the child with `env: { ...process.env, PI_MEMORY_SUBAGENT: "1" }`.

The memory extension reads `process.env.PI_MEMORY_SUBAGENT`. An env marker was chosen over
`registerFlag`/`--memory-subagent` because the flag route requires the *subagent* extension to learn the
memory extension's flag name, while the env route requires no cross-extension coupling and cannot be
positionally mis-parsed (an unregistered `--memory-subagent <value>` is captured as an unknown option and
eats the next argument).

Enforcement is two-layered:

1. The subagent extension's per-agent `tools:` allowlist omits the mutating memory tools. This is
   configuration, not a mechanism — agents without a `tools:` list inherit the full toolset.
2. `execute` rejects mutating operations **and gated reads** when the env var is set, logging
   `blocked-subagent`.

Layer 2 blocking gated reads is not optional: `hasUI` is `true` in RPC mode, so a subagent's gated read
would otherwise be relayed to the parent's UI or auto-denied by the fallback, and a backgrounded run
could block indefinitely.

## 6. Injection

### 6.1 Session start — key index

The block **string** is computed once at `session_start` and cached; it must be **re-inserted on every
`before_agent_start`**, because that hook receives freshly normalized options each run
(`runner.ts:1431`). Re-reading the store mid-session would invalidate the provider's prompt cache every
turn. `/memory index` refreshes the cache explicitly.

Injection uses **`event.systemPromptOptions.sections["memory-index"]`**, not `event.systemPrompt`:
returning `systemPrompt` sets `forceSystemPrompt`, which short-circuits the option build
(`system-prompt.ts:203` returns `{content}` with no sections) and silently discards sections, context
files, and skills from every other extension.

**The section API cannot emit tag attributes** (`system-prompt.ts:187-191` wraps content as
`<name>\n…\n</name>`), so the scope goes inside the body:

```
<memory-index>
scope: project:pi-extensions-1a2b3c4d
auth/session_handling, build/nix_flake, deploy/grafana_dashboard
gated: 3 hidden (ask for one by name)
</memory-index>
```

Cap: 200 keys or 4,800 characters (≈1,200 tokens at 4 chars/token — one comparison basis, evaluated
against the rendered block). Overflow becomes `+N more (recent first)`, ordered `mtime DESC, id DESC`.
Project keys first, then global, under one line: `scope: project:<id> + global`. Keys only, never
bodies. Gated keys never appear.

### 6.2 Mention detection — per turn

On the `context` hook, run the latest user message as a BM25 query; if the top hit clears the threshold,
append to that message:

```
possibly relevant memories: deploy/grafana_dashboard, auth/session_handling
```

Gated notes are excluded in SQL before the top hit is chosen, in **both** tiers (project and global).

**Query construction**: tokenize on whitespace and punctuation, keep tokens ≥ 2 chars, cap at 20 tokens
and 512 characters, quote each token, join with `OR`. Drop `-`, `"`, `*`, `:`, `(`, `)`, `^`, `NEAR`.
~150 lines of care, as `pi-hermes-memory`'s `store/fts-query.ts` (158 lines) demonstrates.

**Tokens of ≥ 3 chars become prefix queries** (`"symlink"*`), which is what makes `symlink` match
`symlinks` and `symlinked`. FTS5's default `unicode61` tokenizer does no stemming, and measured, an
exact-phrase query misses every inflection — the agent then concludes the memory does not exist.
2-char tokens stay exact phrases: a 3-char prefix would match too much. This is a deliberate, tested
rule, not a formatting detail.

**Threshold — measured, not assumed.** `bm25()` on the host's SQLite (3.53.3) returns **negative**
scores; a realistic 30-note store yields 2–8 for a matching term (`"grafana"` 3.99, `"sqlite"` 3.16,
`"nix" OR "flake" OR "build"` 7.60). The score collapses to `-1e-6` **only when a term appears in at
least half the documents** (measured: 15 of 30 → 1e-6; 1 of 30 → 2.98). So the failure mode is not
"nothing is ever injected on a small store" — it is "everything is injected", because with `n < 4` the
relative guard is skipped.

Rule:

- Rank `ORDER BY bm25(notes_fts) ASC`; take `top1` and `m10`, the median `|score|` of the top 10.
- **Skip entirely** if `|top1| < 1e-3` (the IDF-clamp signature: the term is in ≥ half the corpus, so
  the query carries no signal).
- Require `n ≥ 1`.
- Inject at most 3 keys when `|top1| ≥ F`, and additionally, **only when `n ≥ 4`**, `|top1| ≥ 1.5 × m10`.
- **`F = 2.5`** initially, derived from the measured 30-note distribution (single-token noise sits below
  ~1, real matches at 3–8). It is a **per-store tuning constant**: FTS5 IDF shifts with corpus size.
- Decisions (`top1`, `m10`, `n`, injected keys) go to `access.log` as **one line each**, `op: "mention"`,
  `decision: "inject" | "skip"` — telemetry, not consent, so no `pending`/resolver pair (§7.1). This is
  what lets `F` be retuned from data.

**Cache cost, stated honestly**: the block is appended to the latest *user* message, so the next turn
re-sends that message without the block and the prefix diverges from that point. Accepted, because
rewriting the system prompt would invalidate the entire prefix. If it measures badly, mention detection
is the first thing cut.

The `context` hook rewrite affects only the outgoing request and is **not persisted**
(`agent-loop.ts:397-401`; `runner.ts:1307` `structuredClone`s; persistence happens on `message_end`).

## 7. The gate

`access = gated` means reading it requires a `ctx.ui.confirm` showing the key, the first ~200 chars of
the body, and the agent's `reason`. Approval is **per operation**, not per session.

### 7.1 Log format

JSONL is append-only and cannot be back-filled, so an attempt and its outcome are **two lines sharing a
16-hex `attempt` id** (4 hex collides at ~300 attempts; pairing is also scoped to the same session and
key):

```json
{"ts":"…","attempt":"3f9a1c7e2b4d8a60","op":"read","initiator":"agent","decision":"pending",
 "scope":"project","project":"pi-extensions-1a2b3c4d","key":"auth/session","session":"abc",
 "reason":"checking token refresh policy"}
{"ts":"…","attempt":"3f9a1c7e2b4d8a60","decision":"approved","result":"ok"}
```

- `op ∈ {read, write, edit, delete, show, search, diff, rotate, mention}`
- `initiator ∈ {agent, user}`
- `decision ∈ {pending, approved, declined, denied-no-ui, blocked-subagent, error, user, inject, skip}`
- `inject` / `skip` are **mention-detection telemetry, not consent**: one line per decision, no `pending`
  predecessor, no `attempt` pairing. Using `approved`/`declined` for them would make `/memory log`
  report a user decision that never happened.
- `result ∈ {ok, failed:<class>}` where class is one of the §3.4 failure classes
- `error` is used when `confirm` rejects or throws rather than returning a boolean.
- `reason` is absent for `initiator: "user"`.

**Consent and outcome are separate fields.** `decision` records what the user decided; `result` records
whether the mutation landed. Without that split, `approved` implies success it cannot know about.

**An approved-then-failed mutation is still two lines.** Ownership, not line count, is what makes this
work: the gate writes `pending` and returns the attempt id **without** a resolver; the caller writes the
single resolver in its `finally` as `approved` + `result: ok | failed:<class>`. A decline, a headless
denial, a subagent block, and a throwing `confirm` are terminal inside the gate, so the gate writes
their resolver itself. Every terminal path is therefore exactly two lines:

| outcome | lines |
|---|---|
| approved write, success | `pending`, `approved/ok` |
| approved write, commit failed | `pending`, `approved/failed:<class>` |
| declined | `pending`, `declined` |
| no UI / subagent / confirm threw | `pending`, `denied-no-ui` / `blocked-subagent` / `error` |
| user `/memory show` | one `decision: "user"` line |

The earlier design had the gate write an optimistic `approved/ok` and the caller append a second
resolver, which produced three lines and two contradictory outcomes for one attempt. `result` is
**absent** for `declined`, `denied-no-ui`, `blocked-subagent`, and `error` — nothing was attempted, so
`ok` would be a false statement.

`initiator: "user"` lines carry an `attempt` id but no `pending` predecessor, so pairing yields
`pending: null` and the user line as the resolver.

A `pending` with no resolver means the process died mid-confirm — deliberately better than no record.
The resolver is written in a `finally`, so an approved-but-failed mutation still resolves its attempt;
without that, `approved` would be indistinguishable from a crash.

### 7.2 Rotation

`access.log` is capped at 10 MB. On `session_start` (skip when reason is `reload`), if the cap is
exceeded: take `.access.log.lock` (§3.5 rules, including staleness takeover — without it one SIGKILL
bricks rotation permanently), rotate to `access.log.1` (one generation kept), append
`{"op":"rotate"}` to the new file, release.

**The rotate marker is not required to be the first line.** An appender that opens by path between the
`rename` and the marker write lands first — measured — so asserting "first entry" is unenforceable. The
marker is simply appended after rotation; readers tolerate it anywhere.

**Appenders open the log per write**, by path. A writer holding an fd writes through the rename into
`.1` forever, and the next rotation deletes the whole generation.

**`/memory log` reads `access.log.1` then `access.log`**, applying `--tail N` **after** concatenation
(otherwise it yields up to 2N lines). Reading only the live file loses every post-rotation attempt.

### 7.3 Logging point and fail-closed behaviour

The `pending` line is written **before** the confirmation; the resolver **after** (§7.1).

**Fail closed when there is no confirmation path.** `confirm` resolves to `false` with no UI
(`runner.ts:331-333`); `hasUI` is `false` in `pi -p`/JSON mode but **`true` in RPC mode**, which is what
subagents use. Rule:

> A gated operation fails closed when `!ctx.hasUI` **or** `PI_MEMORY_SUBAGENT` is set.

Error: `"gated note 'auth/session'; no UI available to confirm — use /memory show"`. Logged as
`denied-no-ui` or `blocked-subagent`, each **preceded by its `pending` line**.

### 7.4 Confirmation fatigue

Confirmations are required for **every gated mutation**. Accepted cost: an agent maintaining one gated
note prompts on every touch. Mitigation: the confirm shows the diff and requires a `reason`.

## 8. Embeddings

`experiments/embed/` is the prototype: a single-file Swift CLI (`NLEmbed.swift`) → `bin/nle-embed`.

### 8.1 Runtime

- `NLEmbedding.sentenceEmbedding(for: .english)` — 512-dim, on-device, no network.
- Model loaded once per process; batching mandatory (`swift script.swift` ~250 ms/call vs ~20–30 ms
  through the binary for one text).
- **Never on the write's critical path** (§3.4 step 7). One per-process worker drains in batches.
- **Terminated on `session_shutdown` after a self-enforced 2 s drain.** Host shutdown handlers are
  awaited with **no timeout** (`runner.ts:262-274`), so the extension must enforce it or pi hangs.
  Subagents skip the worker entirely — they have no write path and enqueue nothing.
- Undrained jobs are not lost: §4's reindex predicate (`vec_hash IS NULL OR <> body_hash`) re-enqueues
  them. At load average 14 (31–103 ms/text) a 2 s drain covers ~20–60 notes, so this is the normal case
  after a large import, not an edge case.
- Embedder absent / non-darwin / non-`en`: skip, warn once, degrade to BM25.

Measured (`experiments/embed`, reproduced by the critic within noise):

| | |
|---|---|
| related vs unrelated, English | 0.46–0.62 vs 0.055–0.25 across four sentence groups |
| throughput, idle | 4.27–4.43 ms/text mean, p95 5.07–5.24, 225–234 texts/sec |
| throughput, load average 14 | **31–103 ms/text** — up to 24× worse |
| long input | 2 KB → **118 ms** (vs 4.3 ms short) |
| languages available | 2 of 29 (`en` 512, `fr` 640) |

### 8.2 What gets embedded

`key + "\n" + first 1024 characters of body`, truncated on a word boundary. One vector per note, written
via the insert-or-update sequence in §4. Longer notes are represented by their opening — a documented
recall limitation.

**Language guard**: `NLLanguageRecognizer` mislabels short English as Turkish
(`"The cat sat on the mat"` → `tr=0.531, en=0.294`). Guard is confidence-based: hard mismatch only when
the top hypothesis ≥ 0.40, `en` < 0.15, and ≥ 3 tokens; otherwise proceed with a warning.

**Job identity**: jobs carry `(scope, project, key, body_hash)`. At vector-write time the id is
re-resolved from those three and `body_hash` re-checked; a mismatch drops the job. Never carry
`notes.id` — a rebuild reassigns it.

## 9. Threat model, stated honestly

The gate is **advisory, not a boundary.**

- **Defended**: an agent deciding on its own to read gated content, or a prompt-injected agent doing so
  through the tools. No tool parameter reaches gated content (§5.2); it cannot reach or spoof the
  confirmation; every attempt is logged (§7.3), including declines, headless denials, and subagent
  blocks. Consent and outcome are both recorded (§7.1).
- **Not defended**: the agent has `bash`. It can `cat ~/.pi/memory/projects/*/...` directly, bypassing
  the confirmation and leaving no log entry.
- **Never defended**: a compromised process or malicious extension at the same UID. pi's own
  `docs/security.md` states there is no security boundary.
- **Pushing the repo publishes gated bodies in plaintext.**

Gated notes must not be used for secrets.

## 10. Commands

`/memory index [--rebuild] [--force-unlock]` · `/memory show <key> [--gated]` · `/memory search <query>` ·
`/memory log [--tail N]` · `/memory diff <key>` · `/memory import` · `/memory import-keep`

`/memory search` and `/memory diff` apply the same gate and log as `memory_read` for gated notes.

**`/memory show` is user-initiated**, so it does not confirm — prompting someone to approve their own
keystroke is noise. It logs **one line** with `initiator: "user"`, `decision: "user"`, `result: "ok"`,
and no `reason`. This is the one documented exception to the two-line rule; `approved` would be a false
statement, since nobody approved anything. `/memory show --gated` lists gated keys without bodies.

`/memory log` reads `access.log.1` then `access.log`, `--tail` applied after concatenation.

`/memory diff <key>` is `git log -p -- <path>`, rendered compactly.

`import` maps `.serena/memories/<path>.md` → `scope=project`, `key=normalizeKey(<path>)`, `access=open`.
Non-`.md` files are skipped and reported (measured: 13 of 52 real `.serena/memories` dirs contain
`.DS_Store`, 24 contain subdirectories). Existing keys are not overwritten; conflicts are reported as
`{path, reason}` and **left in place**. `import` deletes only files actually imported, then removes the
directory only if empty. Both variants commit with explicit paths, never `git add -A`.

## 11. Packaging — personal install, not published

- **Symlinked** into `~/.pi/agent/extensions/agent-memory`. No npm release, no CI.
- **One native artefact**: `bin/nle-embed`, built by `./build.sh` (`swiftc -O`) for `arm64`. No per-arch
  packages, no universal2. An `x86_64` build has never been produced; a machine without it gets
  BM25-only.
- **Runtime dependency `sqlite-vec@0.1.9` must be declared** (`pnpm add sqlite-vec`). It ships
  `darwin-arm64` and `darwin-x64` via its own `optionalDependencies` and selects one with
  `require.resolve`. Verified: `sqliteVec.load(db)` on an `{allowExtension:true}` handle reports
  `vec_version() v0.1.9` and returns correct KNN. `vec0.dylib` is **not** vendored — the `/nix/store`
  path is garbage-collectable.
- `node:sqlite` must be opened with `{ allowExtension: true }` **at construction**.
- **No `xattr` step is needed.** Measured across registry install, local `file:` tarball, HTTP-served
  tarball, `git+file://`, and pnpm: extracted binaries carry only `com.apple.provenance`,
  `com.apple.quarantine` is absent, and all execute. npm 11.19.0 has zero references to
  `quarantine`/`xattr`. (Contrast, measured: the same quarantined `.tgz` extracted with `ditto` or
  `/usr/bin/tar` **does** propagate it and the binary is killed with exit 137.)
- **`vec0` probe, downgrade and re-upgrade.** Probe with `SELECT vec_version()` at open.
  - **Failure with `meta.vec_enabled='true'`**: take `index.db.lock` (§3.5 rules — the repo lock does not
    cover a DB shared across scopes, and deleting a live DB is the hazard §4 measured), delete
    `index.db*`, reindex from files **with the `vec_notes` DDL omitted**, set `vec_enabled='false'`.
    Do **not** attempt to rebuild "without vec_notes" using §4's SQL: with the module absent,
    `DELETE`/`DROP`/`SELECT` on `vec_notes` all fail with `no such module: vec0`, so the §4 rebuild —
    which begins `DELETE FROM vec_notes` — cannot run in the path that invokes it.
  - **Condition on `vec_enabled='true'`, not on `embed_dim` being set.** `embed_dim` is seeded at
    creation, so conditioning on it would delete and rebuild the index on **every** session start while
    the module is absent.
  - **On a later successful probe**: `CREATE VIRTUAL TABLE IF NOT EXISTS vec_notes …` — the table was
    never created in the vectorless DB, so `vec_enabled='true'` alone does not make the backfill
    possible — then set `vec_enabled='true'` and let §4's predicate backfill.

## 12. Acceptance criteria

1. `memory_write` → file on disk, one git commit naming the key, note findable by `memory_search` after
   the index pass. A failed index pass reports that error, not success. **Includes creating a note in a
   fresh store with no prior commit** (the pathspec-only commit fails this).
2. Two pi processes writing different keys concurrently: both notes present, both committed, neither
   reports failure, each commit message names its own key.
3. `memory_edit` with a stale `baseHash` is rejected and the note unchanged; an `access` flip alone
   changes `baseHash`; `memory_write` with a stale `baseHash` is rejected; `memory_edit` with an
   `oldText` matching twice is rejected.
4. Delete `index.db`, restart → identical note count, keys, **and access flags** (gated notes still
   gated, read from frontmatter), vector rows repopulate after the drain. `--rebuild` while another
   process writes leaves both correct.
5. **No gated body reaches an agent** without an approved confirmation and one `pending` + one
   `approved` line. Enumeration: for each of `memory_index`, `memory_search`, `memory_read` (declined),
   the injected block, and the mention block, assert the gated key and a distinctive body token are
   absent from the tool result or message text.
6. Declining a gated read leaves no plaintext and produces `pending` + `declined`; under `pi -p` it
   fails closed with the §7.3 error and produces `pending` + `denied-no-ui`.
7. Key rules (complete): `../../etc/x`, `/abs/path`, `a/./b`, `a/..`, `.hidden/x`, `A B/c`, `ünicode/x`
   rejected; `Auth/Session` → `auth/session`; `a//b` → `a/b`; an NFC/NFD pair resolves to one note; a
   symlinked leaf **and** a symlinked parent are rejected.
8. Delete a note, create a new note, confirm the new note has no `vec_notes` row inherited.
9. `/memory import` on a `.serena/memories` tree yields one project-scoped note per `.md`, skips and
   reports non-`.md`, removes only imported files; conflicted files remain and are reported.
10. With `bin/nle-embed` removed, every tool and command works; search is BM25-only.
11. Reindex of 500 notes completes in under 2 s excluding embeddings (independent measurement:
    40–49 ms).
12. **`access` preservation**: write an open note, flip to gated, `memory_write` a new body without
    `access` — still gated.
13. **Subagent enforcement**: with `PI_MEMORY_SUBAGENT=1`, `memory_write`/`memory_edit`/`memory_delete`
    are rejected, and a gated `memory_read` fails closed logging `pending` + `blocked-subagent`. Test
    through a real subagent spawn, not a hand-set env var.
14. **Frontmatter**: a gated note's body is searchable; `access: gated` never appears in `notes.body`; a
    note about gating is unaffected; a note whose first line is `---` with no `access:` key keeps all
    content; **CRLF, BOM, an extra key (`tags:`), and a trailing space still parse as gated**; a file
    that is only frontmatter yields an empty body and `access=gated`. Fixtures created on disk,
    picked up by reindex.
15. **Re-embed**: change a body, drain, assert `notes.vec_hash` changed and the vector differs.
    **First vector**: a note with no `vec_notes` row gets one inserted (the `UPDATE`-only path fails
    this).
16. **Startup sweep**: with `PI_MEMORY_TEST_HOLD=pre-commit`, kill between file write and commit; unset,
    start a session; exactly one `memory: recover uncommitted` commit. Also covers the `A ` staged
    state.
17. **Mention detection**: a gated key is never suggested; a query whose term appears in ≥ half the
    corpus injects nothing (IDF clamp); a single-hit query above `F` **does** inject; `top1`/`m10`/`n`
    are logged. "Weak"/"strong" are defined by the logged numbers, not adjectives.
18. **Rotation**: exceed the cap, start a session, assert `access.log.1` exists, `/memory log` shows
    entries from **both** files, `--tail 10` returns at most 10, and an attempt whose `pending` landed
    in `.1` still pairs with its resolver in the live file.
19. **Scope precedence**: key in both scopes, omitted `scope` → project.
20. **Repo lock**: kill a process holding `.git/pi-memory.lock`; next write succeeds via staleness
    takeover. `/memory index --force-unlock` clears a live-pid lock. An unparsable lock file is treated
    as held, not as pid 0.
21. **Commit classification**: pre-commit the same content from another process **while the tree is
    otherwise dirty**; the write reports success. Also: a failed create is never reported as committed
    (`git diff --quiet` alone would).
22. **`projects.json` merge**: two processes registering different projects concurrently both survive.
23. **`fm_len` edit rejection**: `memory_edit` matching inside the frontmatter is rejected.
24. **`vec0` downgrade and re-upgrade**: remove `sqlite-vec` from a DB with vectors; the extension
    deletes `index.db*` under `index.db.lock`, reindexes without `vec_notes`, sets `vec_enabled='false'`,
    all tools keep working, and **a second session start does not rebuild again**. Restore the module;
    `vec_notes` is created, `vec_enabled` returns to `'true'`, vectors backfill.
25. **Drain bound**: large queue → `session_shutdown` returns within ~2 s and pi exits; remaining notes
    backfill next session.
26. **`mtime` ordering**: 50 notes written in a loop list newest-first; same-millisecond notes ordered
    by `id DESC`.
27. **Search direction**: a query matching one strongly relevant and one weakly relevant note ranks the
    strong one first (`ORDER BY bm25() ASC`, not `DESC`).

## 13. Open risks

| Risk | Impact | Mitigation |
|---|---|---|
| Approval fatigue on every gated mutation | Gate becomes a reflex | Show diff + require `reason`; revisit if prompts exceed a few per session |
| Gate bypassable via `bash` | No confidentiality | Documented (§9); gated ≠ secret |
| `F = 2.5` tuned on one 30-note store | Wrong threshold on a real corpus | Logged `top1`/`m10`/`n`; retune from data; mention detection is the first cut |
| IDF clamp (term in ≥ half the corpus) silently suppresses injection | Legitimate broad queries suggest nothing | Explicit `< 1e-3` skip, logged as a decision |
| Hybrid retrieval unmeasured against BM25 | Vector machinery may buy nothing | Prototype stays; measure recall on real notes before chunking |
| Single local git repo, no off-machine backup | Disk failure loses everything | A remote is possible but publishes gated bodies (§9) |
| `NLEmbedding` macOS-only and load-sensitive | Vectors unavailable or slow | Async queue, BM25 fallback, §12.10/12.25 |
| `x86_64` `nle-embed` never produced | Intel Macs get BM25-only | Accepted; out of scope |
| Advisory lock, takeover race | Two writers can briefly overlap | Documented (§3.5); the failure mode is a misnamed commit, not data loss |
| Subagents can read but not search | A subagent cannot discover a key absent from the index | Index injection is the discovery mechanism |

## 14. Finding → fix map

### Rev 1 → 2 (30 findings; confirmed fixed by rounds 2–4)

1 `includeGated` → §5.2 · 2 subagent mechanism → §5.3 · 3 headless gate → §7.3 · 4 FTS5 triggers → §4 ·
5 best-effort vs immediate → §3.4/§12.1 · 6 recency source → `notes.mtime` · 7 key handling → §2.2/2.3 ·
8 scope/access defaults → §5.1 · 9 embed input → §8.2 · 10 packaging → §11 · 11 `projects.json` → §3.1 ·
12 log rotation → §7.2 · 13 rebuild race → §4 · 14 delete debris/rowid → §4 · 15 diff impl → §5 · 16 FTS
query → §6.2 · 17 import deletes → §10 · 18 self-healing → §3.3 · 19 per-run hook → §6.1 · 20 cache cost
→ §6.2 · 21 threshold contradiction → §6.2 · 22 `forceSystemPrompt` → §6.1 · 23 `normalizeRemote` → §3.2 ·
24 git invocation → §3.4 · 25 decline logging → §7.3 · 26 push publishes gated → §9 · 27 evidence claims
→ §1/§8/§11 · 28 acceptance gaps → §12 · 29 commands skipped gate → §10 · 30 AGENTS.md → §1

### Rev 2 → 3 (7 blocking, 9 high; confirmed fixed by rounds 3–4)

B1 `body` column · B2 `project NOT NULL DEFAULT ''` · B3 in-transaction rebuild · B4 two-line log · B5
`UPDATE vec_notes` · B6 repo lock · B7 RPC fail-closed · H1 `normalizeRemote` · H2 `projects.json`
authoritative · H3 log-before-mutate · H4 lowercase-before-validate · H5 small-n threshold · H6
`ON CONFLICT DO UPDATE` · H8 section body · H9 strict frontmatter · A1–A8 → §12 · S personal install

### Rev 3 → 4 (6 blocking, 14 other; confirmed fixed by round 4 except where noted)

`RETURNING id` · startup sweep under the lock · `access` on disk · `vec_hash` re-enqueue · step 1a ·
`registerFlag` (superseded in rev 5 by BK4) · rebuild job identity · `mtime` source · rotation reader ·
criteria 4–7/14/16/17 · `slug` from the remote · token basis · body first line · import skip/report ·
`sqlite-vec` declared · `vec_enabled` reset (corrected again in rev 5) · parent symlink check ·
`projects.json` atomic · §5.2 wording · §12.6 pending line · shutdown timeout · sweep limitation ·
§12.7 rule list

### Rev 4 → 5

| # | Finding | Fix |
|---|---|---|
| BK1 | `git commit -- <path>` cannot commit an untracked file; every create fails | `git add -- <path>` under the lock before the pathspec commit (§3.4 step 4) |
| BK2 | `nothing to commit` is only printed when the tree is clean; the race it exists for prints a different message | Classify on evidence (HEAD moved, or `cat-file` + `diff --quiet`), never on the message (§3.4) |
| BK3 | `git diff --quiet HEAD -- <path>` exits 0 for untracked/nonexistent paths | `cat-file -e HEAD:<path>` required alongside it (§3.4) |
| BK4 | `--memory-subagent` cannot be delivered — the subagent extension builds argv with no flag hook | `PI_MEMORY_SUBAGENT=1` in the child env; one-line change assigned to `subagent/index.ts` (§5.3) |
| BK5 | Only `UPDATE` specified, so a note's first vector never lands | Insert-or-update sequence with `changes === 0` and UNIQUE-retry (§4, §12.15) |
| BK6 | `/memory show` had no legal log encoding | `decision:"user"`, single line, no `reason` (§7.1, §10) |
| BK7 | Resolver written after steps that can fail; `approved` implied success | Resolver in `finally`; `decision` and `result` split; `error` decision added (§3.4, §7.1) |
| BK8 | Re-upgrade impossible — `vec_notes` was never created | `CREATE VIRTUAL TABLE IF NOT EXISTS` on a successful probe (§11, §12.24) |
| H1 | Lock takeover has its own race; empty-file pid hole; `.access.log.lock` had no takeover | Advisory lock stated; mtime heartbeat; 30 s threshold; unparsable = held; own-pid check on release; same rules for the log lock (§3.5) |
| H2 | Frontmatter failed open on CRLF/BOM/extra key, un-gating notes silently | BOM/CRLF normalisation, `access:`-key detection, index error on unparseable value (§2.1, §12.14) |
| H3 | Anchored `/*.tmp` missed temp files in note directories — my rev-4 fix was wrong | `*.tmp` unanchored; other patterns stay anchored (§3.1) |
| H4 | BM25 premise false: scores are 2–8 on a 30-note store, clamp at ≥ half the corpus | Measured rule, `F = 2.5`, `< 1e-3` skip, `n ≥ 1` (§6.2, §12.17, §13) |
| H5 | Gate decision source undefined; index trust let hand-gated notes be read unlogged | Gate reads the file at operation time (§5) |
| H6 | Search direction, depth and limits undefined | `ORDER BY bm25 ASC`, depth 50, `k=20`, RRF 60, limit 10 (§4, §12.27) |
| H7 | Sweep input omitted staged additions | Porcelain set enumerated (§3.3) |
| H8 | Deleting the live `index.db*` with no index lock | `index.db.lock` for delete/recreate (§11) |
| H9 | Downgrade re-fired every session start | Condition on `vec_enabled='true'` (§11) |
| H10 | "First entry" unenforceable; fd policy unstated; log lock wedged | Marker appended, not first; per-write open; takeover on the log lock (§7.2) |
| H11 | 4-hex attempt id collides; resolver unpaired | 16 hex, pairing scoped by session + key (§7.1) |
| H12 | `memory_edit` multi-match undefined; `git diff --no-index` exit 1 misread | Reject on multiple matches; exit 1 = difference, not error (§5) |
| N | `--tail` before/after concat; `reason` unbounded; `reload` re-runs rotation/sweep; vector filter must precede `k`; `op` enum; unsourced 30 ms | §7.2/§10; 500-char cap (§5); `reload` skip (§3.3, §7.2); `note_id IN (…)` (§4); enum (§7.1); 40–49 ms (§12.11) |

### Found during implementation

| # | Defect | Fix |
|---|---|---|
| I1 | Gated mutations wrote three log lines with two contradictory resolvers (gate wrote an optimistic `approved/ok`, the caller appended another) | Ownership split: gate writes `pending` and returns; caller writes the single resolver in `finally`. Every terminal path is two lines (§7.1) |
| I2 | Search did not match inflections — `symlink` missed `symlinks`, measured | Tokens ≥ 3 chars emitted as prefix queries `"tok"*` (§6.2) |
| I3 | §11's `vec0` downgrade was wired nowhere in production, so the downgrade could never fire | `openStore` calls `handleVecUnavailable`; verified end-to-end with a genuinely unloadable module (§11, §12.24) |
| I4 | Mention decisions were logged as `declined`, i.e. as a user decision that never happened | `op:"mention"` + `decision:"inject"|"skip"`, one line, no consent pairing (§6.2, §7.1) |

### Found by the code review

| # | Defect | Fix |
|---|---|---|
| C1 | One malformed note aborted the whole reindex pass, silently blanking the index | Per-file error policy: report the path, delete that note's row, continue (§3.3) |
| C2 | The `vec0` downgrade could delete the index, fail to repopulate, and leave the extension registering no tools | Downgrade shares the per-file policy; a failed recreate closes the handle and names the cause (§11) |
| C3 | The global tier was unreachable from inside any repository — every discovery path filtered to the resolved tier | Two-tier discovery with project-first ranking and read fallback (§5.1) |
| C4 | The shutdown drain exceeded its bound (measured 4024 ms for a 2000 ms budget) because an interval tick ran an unbounded drain | Every tick run gets a deadline (§8.1) |
| C5 | A crashed delete (` D`) was never swept, leaving the worktree permanently dirty and a ghost index row | `' D'` added to the dirty set (§3.3) |
| C6 | Reindex never removed rows for deleted files | Stale rows deleted, count reported as `removed` |
| C7 | `writeVector` stamped the *current* `body_hash`, so a stale job could claim a vector it did not build | Expected hash passed in and re-checked (§4) |
| C8 | The gate prompted before the `baseHash` precondition it was about to fail | Precondition moved above the gate (§5.1) |

## 15. Implementation sequence

No A→B→A cycle in the code path. The two circularities are **ownership, not ordering**: child-flag
delivery (§5.3) and the vec insert-or-update (§4) must be decided before their dependents start.

| # | Unit | Depends on | Est. LoC |
|---|---|---|---|
| U0 | repo init, `.gitignore`, lock (§3.5), `commitPath` (BK1/BK2/BK3) | — | 250–350 |
| U1 | `normalizeKey`, `normalizeRemote`, project resolution, `projects.json` | U0 | 200–300 |
| U2 | frontmatter parse/render (§2.1), `fm_len`, hashing | — | 80–150 |
| U3 | schema/open/migrate, `vec0` probe, upsert, delete, rebuild | U1, U2 | 400–600 |
| U4 | read/write/edit/delete, `baseHash`, startup sweep | U0–U3 | 300–400 |
| U5 | gate: attempt id, two-line logger, confirm, fail-closed, rotation | U0, U1 | 250–350 |
| U6 | tools incl. search/RRF/fusion | U3, U4, U5 | 400–500 |
| U7 | injection at `session_start` + `before_agent_start` section | U1, U3 | 150–250 |
| U8 | mention detection (tokenizer ~150, threshold) | U3, U5 | 200–300 |
| U9 | embedding worker, queue, drain, vector insert | U3, U4 | 350–500 |
| U10 | commands incl. import | U4, U5, U6 | 350–450 |
| U11 | subagent env wiring (one line in `subagent/index.ts`) | U6 + subagent repo | 60–100 |
| U12 | `build.sh`, symlink, README | — | 100–150 |

**~2.8–3.9k LoC.** Build **U5 with U0–U2**, not last: U4, U6, and U8 all log through it, and retrofitting
the two-line logger across three callers is worse than writing it first.
