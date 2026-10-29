# agent-memory

A pi extension that gives the agent a durable, git-backed memory: markdown notes with frontmatter in
`~/.pi/memory`, indexed in SQLite for keyword and vector search, injected as a key index at session
start and as mention hints per turn. Notes are the authoritative artifact — one file per key, one
commit per change — so the store can be read, diffed, and reverted with git alone. `index.db` is
derived and disposable.

## Install

```bash
cd ~/code/pi-extensions && pnpm install   # sqlite-vec@0.1.9 (declared dependency)
cd agent-memory && ./build.sh             # → bin/nle-embed (macOS, arm64, Command Line Tools only)
ln -s ~/code/pi-extensions/agent-memory ~/.pi/agent/extensions/agent-memory
```

`build.sh` is idempotent, needs no Xcode project, and prints the `file` output of the result. Skip it
on a non-macOS host: everything works, search is keyword-only (see *Known limits*).

Then start a new pi session. The extension prints a warning and registers no tools if the store cannot
be created.

### Remove the manual AGENTS.md line

`AGENTS.md` (global or per project) carries a workaround that this extension replaces:

```
- start session by loading relevant to the task project memories from cwd/.serena/memories dir
```

Delete that line once the store holds the content. `/memory import` prints it again after importing, so
the exact text is always available from the command that makes it obsolete.

## Tools

| Tool | What it does |
|---|---|
| `memory_index(scope?)` | Lists keys in scope with the first line of each body; gated notes appear only as `gated: N hidden`. |
| `memory_search(query, scope?, limit?)` | BM25 + vector search fused with RRF (default 10 results); gated notes are excluded in SQL. |
| `memory_read(key, scope?, reason?)` | Reads one note's body (frontmatter stripped). Gated → confirm + log. |
| `memory_write(key, body, scope?, access?, baseHash?, reason?)` | Creates or fully replaces a note; returns a unified diff. |
| `memory_edit(key, oldText, newText, baseHash, scope?, reason?)` | Exact-text replacement. Rejected when `oldText` matches twice, touches frontmatter, or `baseHash` is stale. |
| `memory_delete(key, scope?, reason?)` | Deletes the file and its index rows; git history keeps the content. |

`scope` is `project` or `global`; omitted, it resolves to project when cwd is inside a git repository,
else global.

## Commands

| Command | What it does |
|---|---|
| `/memory index [--rebuild] [--force-unlock]` | Reindexes from disk and refreshes the injected block; `--rebuild` wipes and repopulates the index rows from the files; `--force-unlock` drops the repo lock. |
| `/memory show <key> [--gated]` | Prints one note (user-initiated, so no confirmation; logs one `user` line). `--gated` lists gated keys. |
| `/memory search <query>` | Same search as the tool, returned as text, plus a count of gated notes withheld. |
| `/memory log [--tail N]` | The access log, rotated file first, newest last, default 50 lines. |
| `/memory diff <key>` | `git log -p` for one note. |
| `/memory import` | Imports `cwd/.serena/memories/**/*.md` as project notes and deletes each source after it lands. |
| `/memory import-keep` | Same import, sources left in place. |

## The gate

A note is `gated` when its frontmatter says `access: gated`. The body is still plaintext in the git
repo; what changes is the extension's own behaviour: `memory_index`, `memory_search`, the injected key
index and mention detection never expose the body, and `memory_read`/`memory_write`/`memory_edit`/
`memory_delete`/`/memory search`/`/memory diff` on that note need an explicit confirmation plus a
`reason` that is written to `access.log`. A subagent (`PI_MEMORY_SUBAGENT=1`) is denied outright.

**It is advisory, not a boundary.** `bash` bypasses it completely — `cat ~/.pi/memory/global/x.md`,
`grep -r`, `git show`, or pi's own `read` tool all reach a gated body with no confirmation and no log
line. So does any process outside pi. Treat `gated` as a speed bump that keeps an agent from quoting a
note inadvertently, not as access control.

**Do not put secrets in memory**, gated or not: notes are plaintext, committed, and copied by anything
that copies the directory. Pushing the store repo (`git push` from `~/.pi/memory`) publishes every
gated body along with the open ones.

## Store layout

```
~/.pi/memory/                  git repo (the store)
├── .gitignore                 /index.db*  /access.log*  /projects.json  *.tmp
├── global/<key>.md            global-scope notes
├── projects/<id>/<key>.md     project-scope notes; <id> is derived from the git remote or path
├── index.db                   SQLite: FTS5 + vec0, gitignored, rebuildable
├── access.log                 JSONL, one `pending` line + one resolver per gated attempt
├── projects.json              id → {name, path, remote}; gitignored, machine-specific
└── .git/pi-memory.lock        write lock; a dead pid is taken over, a live one is not
```

`PI_MEMORY_DIR` overrides the root — any absolute path, useful for a second store or a throwaway one.
`index.db` is disposable: delete `index.db`, `index.db-wal`, `index.db-shm` and the next session
rebuilds it from the note files. Nothing unique lives there; a note's `access` flag is read from its
frontmatter, not from the index.

## Known limits

- **English-only vectors.** `nle-embed` embeds with `NLEmbedding.sentenceEmbedding(for: .english)`
  (512-dim). Non-English text produces meaningless vectors; the CLI warns and exits 2, and the
  extension falls back to BM25 for that batch.
- **macOS-only binary.** The embedding models are part of macOS and there is no `x86_64` build on this
  machine. Any other host gets keyword-only search.
- **BM25 fallback is a first-class mode, not an error.** With `bin/nle-embed` removed, or `sqlite-vec`
  absent (`vec_enabled='false'`), every tool and command still works; search loses the vector half.
- **`F = 2.5`** is the mention-detection floor (`meta.mention_floor`, default 2.5). It is a tuned
  starting point for a mature store, not a constant: each decision logs `top1`, `m10`, `n`, and an
  injected line, so retuning is a matter of reading `/memory log`.
- **IDF clamp:** FTS5 gives a term that appears in at least half the corpus a score of ~1e-6, which is
  below the clamp threshold. In a store with fewer than ~5 notes a query term matches half the corpus,
  so mention detection effectively never fires — the injected index and `memory_search` are what carry
  a small store.
- **Search is word-exact.** FTS5 uses its default `unicode61` tokenizer, which folds case but does
  not stem: `symlink` does not match `symlinks` (measured: a note containing "symlinks" is found by
  `symlinks` and missed by `symlink`). Search with a token the note actually contains.
- **Mentions, not recall.** Per-turn hints are capped at three keys and only ever name open notes; a
  gated key is never suggested.

## Troubleshooting

**`embeddings unavailable (nle-embed missing or unusable); search is BM25-only`** — build it, or point
at one:

```bash
cd ~/code/pi-extensions/agent-memory && ./build.sh
./bin/nle-embed embed --text "the embedding model is ready"   # dim 512, one JSON line
```

`PI_MEMORY_EMBED_BIN=/path/to/nle-embed` overrides resolution entirely. If `swiftc` is missing,
`xcode-select --install`.

**`sqlite-vec` missing.** The DB is opened with `{ allowExtension: true }` and the module is loaded per
process; a failure downgrades the index instead of breaking it. Check the latch:

```bash
sqlite3 ~/.pi/memory/index.db "select v from meta where k = 'vec_enabled'"
```

`'false'` means vectorless. Run `pnpm install` in `~/code/pi-extensions`, then start a new session:
the `vec_notes` table is created and vectors backfill from the reindex predicate. If the module cannot
be loaded at all, delete `index.db*` to rebuild without vectors.

**A write fails with a lock error after a crash.** The store records the holder's pid; a dead pid is
taken over automatically, so a persistent error means the pid is alive or the file is unparsable (an
unreadable lock is treated as held, never as pid 0). Clear it with:

```
/memory index --force-unlock
```

**Search returns nothing useful but `/memory index` lists the keys.** Delete `index.db`, `index.db-wal`
and `index.db-shm`, then start a session: the index is derived, so this costs only the re-embedding
time. `/memory index --rebuild` repopulates the rows in place but keeps `meta`, so it does not reset
`vec_enabled`.
