# Code review — `agent-memory` extension

Scope: everything under `agent-memory/`, plus the one `subagent/` change (child-env marker
delivery). Commits `291a941..6340538`. Reviewed against `docs/plans/agent-memory-spec.md` (rev 5)
and the host source at `~/code/pi-mono/packages/coding-agent` (1.4.0, matching the installed
`pi`).

Method: read every non-test module, then reproduced the suspected defects against a real store in
`/tmp` with throwaway drivers (`node --experimental-strip-types`). 230/230 tests pass;
`npx tsc --noEmit` adds nothing to `.tsc-baseline`; `npx eslint agent-memory subagent` is clean.
None of the defects below are caught by the suite.

## Table of contents

- [Summary](#summary)
- [F1 — one malformed note silently blanks the whole index (blocking)](#f1)
- [F2 — the `vec0` downgrade destroys the index and can disable the extension (blocking)](#f2)
- [F3 — the `global` tier is unreachable from inside any repository (blocking)](#f3)
- [F4 — the shutdown drain is not bounded at 2 s (high)](#f4)
- [F5 — a crashed delete is never swept: ` D` is not a dirty code (high)](#f5)
- [F6 — reindex never removes rows for deleted files (medium)](#f6)
- [F7 — `writeVector` records the *current* `body_hash`, not the vector's (medium)](#f7)
- [F8 — `writeNote` prompts before the `baseHash` precondition it will fail (medium)](#f8)
- [F9 — `WriteOk.access` is the requested access, not the stored one (medium)](#f9)
- [F10 — the index lock does not cover the open it claims to protect (medium)](#f10)
- [F11 — duplicated plumbing that already exists elsewhere (medium)](#f11)
- [F12 — the mention cache survives `newSession` into another scope (low)](#f12)
- [Smaller findings (nit)](#smaller)
- [Test quality: named gaps](#tests)
- [Untested assumptions](#assumptions)
- [Verdict](#verdict)

---

<a name="summary"></a>
## Summary

**Not shippable for personal daily use yet.** The architecture is sound and unusually well
argued — the two-line log invariant, the consent/outcome split, the frontmatter parser, the FTS
query builder, the `RETURNING id` upsert and the subagent marker all survive adversarial reading
and, where I tested them, they hold. Gate discipline is genuinely good: 16/16 outcome
combinations produce exactly two log lines and no denial path leaks a body.

What is not sound is the **index-recovery story**. Three independent defects converge on the same
failure: *the store's content becomes invisible while the tooling reports nothing useful.*

- One note with a typo'd `access:` value aborts the entire reindex pass — every note after it in
  sort order stays unindexed, and the only signal is a `console.warn` that does not name the
  file (`F1`).
- The `vec0` downgrade deletes `index.db*` before repopulating, so a single unreadable/broken file
  during that repopulate leaves an empty index **and** makes `openStore` throw — no memory tools
  registered for the session (`F2`).
- A crashed delete is never committed and never reconciled, leaving a ghost index row plus a
  permanently dirty worktree (`F5`, `F6`).

On top of that, the `global` tier has no discovery path at all from inside a repository —
`memory_index`, `memory_search`, `memory_read`, the injected block and mention detection all
filter to the project scope. Notes written as `global` are written, committed, indexed, and then
unreachable (`F3`). For a personal tool whose daily cwd is a repo, that is a dead half of the data
model.

The spec was implemented literally in the places where the spec is wrong (`F5`'s missing ` D`),
and diverged from in the places where the spec is right (`F3`'s "project wins" rule implies a
global fallback that the code does not implement).

---

<a name="f1"></a>
## F1 — one malformed note silently blanks the whole index · **blocking**

`store/reindex.ts:55-57` — `parseNote` is deliberately allowed to throw, and the throw escapes
`reindexFromDisk`, aborting the pass. Files are visited in sorted order, so every file after the
offender is never indexed. The caller (`index.ts:142-144`) reduces it to one `console.warn` whose
text contains neither the path nor a UI channel:

```ts
// store/reindex.ts:55
// `parseNote` throws here, by design: see the module comment.
const raw = fs.readFileSync(file.absPath)
const parsed = parseNote(raw)
```

Evidence — a store of four notes where only `aaa.md` has a bad `access:` value:

```
$ node --experimental-strip-types t3b.ts
THROWS: unparseable frontmatter access value "someday"
rows: []
```

and with the broken file sorting last, everything before it lands and everything after it does
not:

```
reindex2 THROWS: unparseable frontmatter access value "someday"
rows after reindex2: [{"key":"alpha"},{"key":"beta"},{"key":"gamma"},{"key":"yankee"}]
```

`beta` is also a stale ghost here (see F6) and `zeta` is absent — silently.

Why this matters for *this* tool: hand-editable markdown is a designed feature (§3.3), the file is
one line of prose away from being valid, and the visible outcome is "the agent forgot
everything". `frontmatter.ts` already refuses to fail open for good reasons; the defect is that
the refusal costs the entire corpus instead of one note, and names nothing.

**Smallest fix:** keep the fail-closed semantics per note, not per pass. In `reindexFromDisk`,
wrap the read+parse in `try` and on failure push `{ path: file.relPath, reason }` into
`result.errors`, `deleteNote`-style remove any existing row for that `(scope, project, key)` so no
stale body stays searchable, and `continue`. `ReindexResult.errors` already exists and
`/memory index` already prints it; nothing else changes. Give `readFileSync` the same treatment.

---

<a name="f2"></a>
## F2 — the `vec0` downgrade destroys the index and can disable the extension · **blocking**

`index/db.ts:266-276` — the order is `close()` → `removeIndexFiles()` → `openIndex()` →
`populateFromDisk()`. Nothing between the delete and the repopulate can recover the old file, and
a `populateFromDisk` throw leaves:

- the previous index deleted,
- a fresh, **empty** `index.db` (with `vec_enabled='false'` already written at line 274),
- the freshly opened handle never closed (leaked),
- the exception propagating out of `openStore`, so `index.ts:180` registers **no memory tools at
  all** for the session.

Evidence (downgrade forced the way the test seam does it — `vecLoader: null`):

```
$ node --experimental-strip-types t6-downgrade.ts
s1 probe+meta: true
DOWNGRADE THREW: unparseable frontmatter access value "someday"
index.db exists after: true
s3 opened; meta: true rows: []
s3 REINDEX THROWS: unparseable frontmatter access value "someday"
s3 rows after reindex: []
```

Session 3 opens fine but the index is empty and `reindex` throws again, so the store stays blank
across restarts until the offending file is fixed by hand. Nothing in that output names the file.

This is exactly the question in the brief ("delete succeeds but recreate fails"): the store is
left in a state where **no** note is searchable and the extension is off, and every later session
repeats it.

**Smallest fix:** (a) fix F1 so `populateFromDisk` shares reindex's per-file error policy instead
of throwing, and (b) in `handleVecUnavailable`, `try { transaction(...) } catch (err) {
fresh.close(); throw ... }` with the failing path in the message. With (a) in place the downgrade
degrades to "rebuilt without vectors, N files skipped" instead of "extension disabled".

---

<a name="f3"></a>
## F3 — the `global` tier is unreachable from inside any repository · **blocking**

`tools/definitions.ts:145` (`scopeOverview`), `index/notes.ts:243` (`searchBm25` default filter),
`inject/mention.ts:133-139`, `store/notes.ts:283` (`readNote`) all resolve *one* scope from `cwd`
and filter to it. `resolveScope` returns `project` whenever `cwd` is in a work tree, so from a
repo every discovery and read path excludes `global/`.

Evidence — one `global` note and one project note, both real, cwd inside a git repo:

```
--- memory_index (from repo) ---
scope: project:proj-e49f172d
build/flags: nix build with --impure
--- memory_search "helix" (from repo) ---
no memory notes matched "helix vim editor"
--- memory_read global note, no scope ---
memory note 'editor-preferences' not found (project proj-e49f172d)
--- memory_read with scope global ---
I use helix, never vim
```

Mention detection is the same filter, so a cross-cutting global note can never be suggested:

```
from repo cwd: {"keys":[],"top1":0,"m10":0,"n":0,"injected":false,"reason":"no-match"}
```

Two separate problems in one:

1. **Divergence from §5.1.** The spec's rule is "*scope omitted and the key exists in both*:
   project wins", which is only meaningful if a miss in project falls back to global. The code
   never falls back: `readNote` errors with `not found (project X)` even though the key exists in
   `global` — and the error does not say so.
2. **Unspecified filter in search/index/mention.** The spec says "run the latest user message as a
   BM25 query" with no scope restriction; the implementation added one. Consequence: the `global`
   tier is write-only. An agent writes it, gets `wrote editor-preferences (global, open)`, and
   nobody will ever see it again unless they remember to type `scope: "global"`, which nothing
   ever suggests.

**Smallest fix:** keep `project` first for ranking and add the global scope as a second, lower
ranked source (union with `scope='global'` and rank project hits above global ones), or at minimum
make `readNote`'s miss fall back to the other scope and make `scopeOverview` list
`gated: N hidden`/keys for both scopes with a label. Search can stay project-first without losing
either tier.

---

<a name="f4"></a>
## F4 — the shutdown drain is not bounded at 2 s · **high**

`embed/worker.ts:156-166`. `stop()` sets `stopped`, then chains its bounded drain behind `chain` —
the promise of whatever run is already in flight. An interval tick starts an **unbounded**
`processQueue(undefined)` (the deadline check at `:190` never fires without a deadline) and loops
until the queue is empty regardless of `stopped`. So `stop(2000)` waits out the whole unbounded
run first.

Evidence — 80 notes, 100 ms/embed, batch size 2 (a slow machine, which §8.1 explicitly budgets
for):

```
$ node --experimental-strip-types t8-shutdown.ts
queued: 80
stop(2000) took 4078 ms; result: { processed: 78, remaining: 0, timedOut: false } embed calls: 40
```

`timedOut: false, remaining: 0` proves the drain ran to completion rather than stopping at the
deadline. §8.1 promises "`session_shutdown` returns within ~2 s and pi exits"; the host awaits
shutdown handlers with no timeout (`runner.ts:257-274`, verified), so the extension is the only
bound and it does not hold. With 500 imported notes it would be tens of seconds.

**Smallest fix:** give the interval tick a deadline too — `enqueueRun(Date.now() + intervalMs * 4)`
— so no run is ever unbounded; then `stop`'s chain has at most one short batch ahead of it.
Alternative one-liner: `if (stopped) { deadlineHit = true; return }` at the top of
`processQueue`'s loop body, but only after setting a distinct flag for the shutdown drain so
`stop`'s own run is not skipped.

---

<a name="f5"></a>
## F5 — a crashed delete is never swept: ` D` is not a dirty code · **high**

`store/git.ts:32`:

```ts
const DIRTY_CODES = new Set(['??', ' M', 'M ', 'A ', ' A', 'D '])
```

`deleteNote` (`store/notes.ts:452`) unlinks the file **before** `applyDeleteResult` runs
`git add`. A crash in that window leaves porcelain ` D` (delete in worktree, not staged) — which
is not in the set. (`' A'` in the set is not a code git emits; `A ` is the staged add.) The sweep
therefore skips exactly the crash state it exists for.

Evidence — write, then simulate the crash window by unlinking without committing:

```
porcelain after crash-delete: " D global/doomed.md\n"
dirtyNotePaths: []
sweep: {"committed":[]}
porcelain after sweep: " D global/doomed.md\n"
index rows: [{"key":"doomed"}]
readNote after crash delete: THROWS: memory note 'doomed' not found (global)
```

Three lasting consequences: the worktree is dirty forever (every later `sweep` is a no-op, and the
store's `git status` is a lie); the index keeps a row that `memory_read` cannot satisfy (F6 makes
this permanent); and any `git checkout`/`reset` in the store resurrects a note the user deleted.

The spec's own §3.3 list omits ` D` too, so this is a spec defect implemented faithfully.

**Smallest fix:** add `' D'` to `DIRTY_CODES` (and drop the impossible `' A'`). One-line change;
`sweepUncommitted` then commits the deletion as `memory: recover uncommitted`.

---

<a name="f6"></a>
## F6 — reindex never removes rows for deleted files · **medium**

`store/reindex.ts:42-92` only upserts. `deleteNote`'s own path clears the row, but a **hand**
delete (a documented workflow — "hand-editable markdown is a feature") never does, and neither
does a `git checkout`/`git revert` that removes a note.

Evidence:

```
$ node --experimental-strip-types t3-reindex.ts
reindex: {"scanned":2,"updated":0,"skipped":2,"errors":[]}
rows after reindex: [{"key":"alpha"},{"key":"beta"},{"key":"gamma"}]   # beta's file was unlinked
```

`memory_search` and `memory_index` keep returning `beta`; `memory_read` then errors. The only
remedy is `/memory index --rebuild`, which nothing tells the user to run.

**Smallest fix:** collect the set of `(scope, project, key)` seen during the pass and delete rows
whose `path` was not seen (scoped to `global/` and `projects/` so a partial walk cannot wipe the
table). Report the count in `ReindexResult` so `/memory index` shows it.

---

<a name="f7"></a>
## F7 — `writeVector` records the *current* `body_hash`, not the vector's · **medium**

`index/notes.ts:329-331`:

```ts
// Read at the last moment: a body written meanwhile leaves vec_hash behind
// body_hash, which is exactly what the re-enqueue predicate looks for.
db.prepare('UPDATE notes SET vec_hash = body_hash WHERE id = ?').run(noteId)
```

The comment states the opposite of what the statement does. `vec_hash = body_hash` is one atomic
statement, so a body written before it makes the two *equal* — the predicate
(`vec_hash IS NULL OR vec_hash <> body_hash`) can no longer see the staleness, so the wrong vector
is pinned until the body changes again.

Evidence:

```
after body change:      {"body_hash":"H2","vec_hash":"H1"}   needsEmbedding: 1
after stale writeVector:{"body_hash":"H2","vec_hash":"H2"}   needsEmbedding: 0
```

Currently unreachable through the only caller: `embed/worker.ts:240-248` re-reads `body_hash` and
compares it to the job's inside the same synchronous transaction, so no interleaving is possible
in-process. That guard is the *only* thing standing between this and a permanently wrong vector —
and the function's own docstring advertises the guard as living here. Any future second caller,
or a change that moves the check outside the transaction, converts a latent defect into silent
ranking corruption.

Same function, `:326`: the `UNIQUE`-retry's `update.run(blob, vecId)` result is discarded, so a
lost race leaves `vec_hash` claiming a vector that was never stored — every other write in this
file checks `changes`.

**Smallest fix:** take the expected hash — `writeVector(db, id, embedding, bodyHash)` — and write
`UPDATE notes SET vec_hash = ? WHERE id = ? AND body_hash = ?`, throwing when `changes === 0`;
check `changes` on the retry too. Fix the comment.

---

<a name="f8"></a>
## F8 — `writeNote` prompts before the `baseHash` precondition it will fail · **medium**

`store/notes.ts:502-518`: the gate runs (step 2) before the `baseHash` check (step 3).
`editNote` deliberately does the opposite (`:427`, with a comment saying so). So `memory_write`
with a stale hash on a gated note shows the user a confirmation dialog carrying the new body
preview, collects an approval, and only then reports `note changed since read` — logged as
`approved/failed:other`.

That is approval fatigue (§13's top risk) spent on an operation that could never happen, and it
dirties the log with a "failed" outcome for a rejected precondition.

**Smallest fix:** move the `baseHash` comparison above the gate in `persistNote`, reusing the
`existing` snapshot already read at `:490` — the same code the `try` block runs today, just
earlier. `editNote` needs no change.

---

<a name="f9"></a>
## F9 — `WriteOk.access` is the requested access, not the stored one · **medium**

`store/notes.ts:544` returns the local `access` variable, while `applyWriteResult` parses the file
it just wrote (`:628` `access: parsed.access`). For an **open** note the body is written bare, so
a body that itself starts with a frontmatter block becomes the file's frontmatter:

```
write result access: open
file on disk: "---\naccess: gated\n---\nthe secret\n"
readNote.access: gated body: "the secret\n"
index row: [{"key":"sneaky","access":"gated","body":"the secret\n"}]
```

The tool tells the agent `open`; disk, index and the next read all say `gated`. Fail-closed (the
read prompt still fires, and un-gating still requires the gate), so this is a correctness/lie
problem, not a bypass — but `memory_write`'s result is the contract the model plans against.

**Smallest fix:** return the parsed `access` from `applyWriteResult` (it is already computed) and
report that. Optionally reject a body whose first line opens a frontmatter block on create, with a
message telling the agent to pass `access` instead.

---

<a name="f10"></a>
## F10 — the index lock does not cover the open it claims to protect · **medium**

`store/store.ts:111` opens the database **before** `handleVecUnavailable` takes
`index.db.lock`. `index/db.ts:263-267` then deletes `index.db*` under the lock. A second process
that is already using the file never takes the lock, so the lock cannot stop the hazard it
documents ("deleting a live database is the hazard §4 measured"): the other handle keeps writing
into a deleted inode while its `-wal` is unlinked underneath it.

Narrow (single user, requires a simultaneous upgrade/downgrade), but it is precisely the class
of thing §11 claims to have closed, and the fix is local.

**Smallest fix:** move `openIndex` inside the locked section of `handleVecUnavailable` (or have
`openStore` acquire `index.db.lock` around "open, probe, maybe downgrade"), so every participant
in a delete-and-recreate holds it.

---

<a name="f11"></a>
## F11 — duplicated plumbing that already exists elsewhere · **medium**

Not a bug today; a drift hazard in a codebase that otherwise argues carefully about single
sources of truth.

| Thing | Copies |
|---|---|
| `toPosix` | `index/notes.ts:481`, `commands/index.ts:703`, `store/reindex.ts:160`, `store/notes.ts:832` |
| `sleepSync` | `store/git.ts:176`, `store/notes.ts:711` |
| `message(err)` | `index.ts:200`, `tools/definitions.ts:524`, `commands/index.ts:707`, `embed/cli.ts:430`, `embed/worker.ts:343`, `store/reindex.ts:157` (`reasonOf`) |
| git timeout `10_000` | `store/git.ts:15`, `store/notes.ts:54`, `store/project.ts:18`, `commands/index.ts:451` (inline) |
| `FAIL_CLOSED_GATE` | `store/store.ts:104`, `commands/index.ts:80` |
| note-file walker | `index/notes.ts:418-478` (`noteFiles`/`collectNotes`) and `store/reindex.ts:100-165` (`noteFiles`/`collect`) |

The last row is the consequential one: two implementations of "walk the store and upsert every
note" with **different error policies** — `populateFromDisk` has none, `reindexFromDisk` throws
per pass (F1). That divergence is why F2 exists.

`readLog(root, tail)`'s `tail` parameter (`gate/log.ts:171`) is dead in production —
`runLog` calls `readLog(store.root)` and tails paired rows instead. And `mergeProjectLocked`
(`store/project.ts:257`) is exported "for callers already inside `withRepoLock`" and has none.
Both invite a caller to do the wrong thing.

Related, same axis: `withRepoLock` is **not reentrant** and there is no guard — a nested call
re-acquires its own lock file, sees its own live pid, sleeps the full 100/200/400/800/1600 ms
backoff and then throws `LockTimeoutError`. Any future nested use fails after a 3.1 s stall with
a message that says the lock is "held" by ourselves. `withRepoLock` should short-circuit when
`heldLocks.has(rootKey(root))`, exactly as it already tracks ownership for `commitPath`.

---

<a name="f12"></a>
## F12 — the mention cache survives `newSession` into another scope · **low**

`inject/mention.ts:296-303` caches `lastText`/`lastResult` in the hook closure. The hook is
installed once at load, and `session_start` does not reset it, so the first user message of a new
session in a *different* project reuses the previous project's `keys` when the text matches. Keys
only, never bodies, and only on an exact text match — but it needs no imagination to hit in a
workflow of "continue".

**Smallest fix:** include the resolved scope in the cache key, or reset `lastText`/`lastResult`
on `session_start` (the hook would need a small reset handle, or key the cache on
`store` identity + text).

---

<a name="smaller"></a>
## Smaller findings (nit)

1. `embed/worker.ts:127` — `void enqueueRun().finally(...)`: if `processQueue` ever rejects, the
   promise returned by `.finally` rejects with no handler, i.e. an unhandled rejection that Node
   turns into a process exit. Today nothing inside `processQueue` can throw (every branch is
   caught), so this is latent. Fix: `void enqueueRun().then(() => { tickQueued = false },
   () => { tickQueued = false })`.
2. `embed/worker.ts:311` — `stats()` calls `isAvailable()`, which can `spawnSync` the CLI probe
   and clear the interval timer. A getter with that side effect is a footgun.
3. `store/notes.ts:786-796` — nothing ever deletes `<note>.md.tmp`. The `*.tmp` ignore rule is
   correct, but crashed temp files accumulate in the store directory forever.
4. `store/notes.ts:452` — a delete whose commit fails reports `commit failed (lock)` while the
   file is already gone. The retry then answers `not found`. The message should say the file was
   removed and will be committed by the next sweep.
5. `store/frontmatter.ts:31` — `ACCESS_LINE = /^access[ \t]*:(.*)$/i` requires column 0, so an
   indented `  access: gated` inside an otherwise valid block demotes the block to body: the note
   becomes `open` and `access: gated` becomes searchable. That is the exact fail-open class §2.1
   exists to prevent; allow leading whitespace (`/^[ \t]*access…/`).
6. `tools/definitions.ts:243-250` — a note hand-gated mid-session is still `access='open'` in the
   index until the next reindex, so `memory_search` returns its **key and first 120 chars of the
   body**, and `memory_index`/the injected block list it. §5 fixes this for `memory_read` only.
   Either refresh the row on a search miss, or drop `firstLine` from search results.
7. `commands/index.ts:629-637` — a symlinked `.md` or directory under `.serena/memories` is
   neither `isFile` nor `isDirectory`, so it vanishes without an entry in `skipped`/`conflicts`.
8. `tools/definitions.ts:555` — `limit: 0` means "10 results", not "none". Fine, but the schema
   allows `minimum: 1`, so the branch only fires on a hand-written call.
9. `store/git.ts:146-151` — `commitGitignore` writes `.gitignore` then commits it, all on every
   `openStore` (i.e. every session start, including every subagent). It is cheap, but it is four
   `git` subprocesses of latency on startup for a file that almost never changes.

---

<a name="tests"></a>
## Test quality: named gaps

The suite is behaviour-first (fixtures on disk, assertions on files/commits/DB rows, not on
internals), and the corpus-based mention tests in particular are honest about `F` being
corpus-dependent. Coverage is not the problem; these specific paths are.

1. **No test starts an interval tick and then drains.** Every `createEmbedWorker` in
   `embed/worker.test.ts` passes `intervalMs: 60_000`, so the concurrency between a tick and
   `stop`/`drain` — the mechanism behind F4 — is never exercised. Missing test: enqueue 40 jobs
   with `intervalMs: 10`, wait one tick, `await stop(2000)`, assert `elapsed < 2500`.
2. **No test deletes a note file without committing.** `store/git.test.ts:380` asserts only the
   staged `D ` code. Missing test: unlink a committed note, assert
   `dirtyNotePaths()` contains it and `sweepUncommitted()` produces one `recover uncommitted`
   commit (F5).
3. **No test removes a file and reindexes.** `store/reindex.test.ts` covers hand-*created* files,
   never hand-*deleted* ones (F6). Missing test: write two notes, unlink one, `reindex()`, assert
   the row is gone.
4. **No test fails `populateFromDisk`.** `index/db.test.ts:184` and `:453` both downgrade with a
   clean tree. Missing test: one unparseable-frontmatter fixture in the tree, force
   `vecLoader: null`, then assert the extension still opens and reports the skipped file (F2).
5. **No test writes a *global* note and then queries from a repo cwd.** Every test seeds and
   queries in the same scope, which is exactly why F3 is invisible. Missing test:
   `writeNote({scope:'global'})`, `memorySearch`/`memoryIndex`/`detectMentions` with a repo
   `cwd`, assert the note is reachable (or, if the filter is intended, that the miss is
   *reported*).
6. **No test pins `writeVector`'s contract.** The worker's guard is tested; the function that
   writes `vec_hash` is not (F7). Missing test: `writeVector` with a row whose `body_hash` moved
   on, assert `needsEmbedding` still reports it.
7. **No test asserts `WriteOk.access` agrees with the file** for a body that opens a frontmatter
   block (F9).
8. **No test covers a stale `baseHash` on a *gated* `memory_write`** (F8) — which is why the
   prompt-then-fail ordering is unobserved.

Also worth knowing: `store/notes.test.ts:273`/`:346` do assert exactly two log lines, and those
assertions are the right shape (line counts + decisions, not JSON snapshots). My own sweep of all
16 gate outcome × operation combinations agreed with them.

---

<a name="assumptions"></a>
## Untested assumptions

- **The host's `context` hook picks up in-place mutation.** Verified in
  `runner.ts:1298-1322`: `visibleMessages` shares objects with `currentMessages`, `sameMessages`
  compares identity, and an identity-preserving edit therefore reaches the request without
  `restoreSystemMessages`. The comment is accurate. **Not verified:** that a *second* `context`
  handler in the same process (another extension) does not rebuild the array and drop the
  appended line. The mention hook silently loses to any handler that returns a fresh list.
- **`memory-index` is a legal section name.** Verified (`/^[a-z][a-z0-9_-]*$/`,
  `system-prompt.ts:58`); an illegal name would throw inside `buildSystemPromptSections` and break
  every turn, so this assumption is load-bearing and only accidentally safe.
- **`registerTool` is replace-by-name, not append.** Verified (`loader.ts:299` `Map.set`), so the
  per-`session_start` registration does not duplicate tools. **Not verified:** what happens to the
  *previous session's* tool closures when a later `session_start` fails to open the store — they
  stay registered and hold a **closed** `DatabaseSync`, so every memory call that session returns
  "database is not open".
- **`spawnSync` git with `env: {...process.env}` inside the pi TUI** does not block anything
  user-visible. That is a 10 s worst case per call (`GIT_TIMEOUT_MS`) on the event loop, plus the
  embedder probe's 10 s. Unmeasured.
- **`NLEmbedding` is silent on stderr about embedded text.** `embed/cli.ts:349` forwards
  `warning:` lines from the child's stderr into `onWarning`→`console.warn`, and the module
  documents "Never the embedded text". Untested against the Swift binary in this review: I did not
  read `experiments/embed/NLEmbed.swift` beyond confirming it exists and is tracked.
- **`dirtyNotePaths` treats an untracked *directory* as one path.** `git status --porcelain`
  collapses a fully-untracked directory to `?? global/newdir/`; the sweep then commits a
  directory pathspec and `pathSettled` reasons about a tree path. It works when the commit lands
  (HEAD moves) but the classification for the no-op case is unverified.
- **The gate's `hasUI` in RPC mode is `true`.** Taken from the spec and from
  `runner.ts:581`; not exercised against a real subagent in this review. The marker delivery
  itself I did verify (`subagent/child-env.ts` + `child-env.test.ts` spawn a real child; the
  single spawn site in `subagent/index.ts` was converted and its `stdio`/`env` semantics are
  equivalent to the previous inheritance).
- **`index.db` corruption/deletion recovery** (`rm index.db` → identical notes *and access
  flags*) follows from `populateFromDisk` reading frontmatter, which I verified indirectly
  through reindex. A full `rm -rf index.db` round-trip was not run.

---

<a name="verdict"></a>
## Verdict

**Request Changes.** Shipworthy design, not-yet-shipworthy failure behaviour. Blocking, in the
order I would fix them:

1. **F1** — per-file error policy in `reindexFromDisk` (and share it with `populateFromDisk`).
   Without this, one typo silently erases the agent's memory.
2. **F2** — close the leaked handle and stop letting a repopulate failure disable the extension.
3. **F3** — give `global` a discovery path (fall back to global on a read miss; search/index across
   both scopes, project first). As it stands, half the data model is write-only.
4. **F5** — add `' D'` to `DIRTY_CODES`. One character class of change; it removes a permanent
   dirty worktree and a resurrection hazard.
5. **F4** — bound the interval tick so `stop(2000)` means 2 s.

F6–F10 are one-line-to-one-function fixes that should land in the same pass; F11 is worth doing
because the walker duplication is the direct cause of F1/F2. The remaining nits are exactly that.

For a personal tool where the store *is* the memory, "silently stops indexing" is worse than
"refuses to start", and today the extension does the former with a `console.warn` that names no
file.
