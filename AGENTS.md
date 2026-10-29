# pi-extensions

pi coding-agent extensions (TypeScript, run inside the pi process):

| Directory | Purpose |
|---|---|
| `subagent/` | Subagent tool — delegates tasks to specialized agents with isolated context (single, chain modes). See `subagent/README.md`. |
| `ask-user-question/` | Structured question tool — single- and multi-question prompts with typed answers (tabbed per-question pages, `allowOther` "Type something" option). |
| `index/` | Index tool — spawns the shared `idx` binary for maki-style file skeletons and directory listings. |
| `notify/` | Desktop notifications — emits OSC 777/OSC 9 when the agent settles, errors, or waits on a prompt. See `notify/README.md`. |
| `simplify/` | `/simplify` command — reviews changed code (unpushed + uncommitted by default) within changed line ranges. |
| `smart-fold/` | Transcript compaction — folds thinking, hides collapsed `bash` output, keeps `read`/`write` previews, adds `+N -M` stats to write/edit rows. Vendored from `@clapecho233/pi-smart-fold` (MIT), config persistence stripped, collapsed-row behaviour retuned. |
| `agent-memory/` | Agent memory — git-backed markdown notes, SQLite FTS5 + vector index, injected key index, consent gate. Needs `./build.sh`. See `agent-memory/README.md`. |

All are symlinked into the consuming pi setup (`~/.pi/agent/extensions/<name>`); there is no
build step for the TypeScript — pi loads the `.ts` files directly. Two exceptions apply to
`agent-memory/`: it ships one native helper (`bin/nle-embed`, built by its own `./build.sh`), and it is
the only extension with a runtime dependency (`sqlite-vec`, declared in the root `package.json`).

## Host source

The pi source checkout is at `~/code/pi-mono` (same packages as the installed host:
`packages/coding-agent` is `@earendil-works/pi-coding-agent`). Read host APIs, types, docs and
examples there instead of digging through `node_modules`, the pnpm store, or the bundled dist.

| What | Path |
|---|---|
| Extension API + event types | `packages/coding-agent/src/core/extensions/` |
| Built-in tools and their renderers | `packages/coding-agent/src/core/tools/` |
| Docs (extensions, themes, codemode, MCP, …) | `packages/coding-agent/docs/` |
| Working extension examples | `packages/coding-agent/examples/extensions/` |
| TUI components (`Component`, `Container`, `Text`, …) | `packages/tui/src/` |
| Provider/model layer | `packages/ai/src/`, `packages/agent/src/` |
| Settings/models/theme JSON schemas | `packages/coding-agent/schemas/` |

Check the checkout's version against `pi --version` before trusting a signature
(`packages/coding-agent/package.json`); when they differ, the installed host wins.

## Types

Runtime dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `typebox`) are provided by the host
pi installation, not by this repo. `types.d.ts` at the repo root declares stubs for them so the
tree type-checks standalone — the stubs are deliberately looser than the real package types, so
use them for this repo's own consistency only, never as documentation of the host API. Only
`node` types plus the dev toolchain (eslint, typescript, prettier) are installed here, with one
exception: `agent-memory/` declares `sqlite-vec` as a real runtime dependency.

## Checks

One-time setup per clone: `git config core.hooksPath .githooks`. The
`.githooks/pre-commit` hook then runs on every commit and auto-formats staged TS
files with prettier, auto-fixes them with eslint, and re-stages whatever it
changed. It blocks only what it could not fix automatically (remaining eslint
errors, or new TypeScript errors).

- `pnpm install`
- `npx tsc --noEmit` — type-checks against a baseline (`.tsc-baseline`). The
  baseline is **normalized** (line/column stripped to `(*)`), so formatting-only
  changes never invalidate it; only genuinely new error signatures block the
  commit. If you fix a baseline error, regenerate with the exact normalized
  command:
  ```bash
  npx tsc --noEmit 2>&1 | grep "error TS" | sed 's/([0-9]*,[0-9]*)/(*)/' | sort -u > .tsc-baseline
  ```
- `npx eslint .` — zero warnings allowed.

## Conventions

- Commit messages: imperative, concise ("Add ...", "Fix ...").
- The extensions are consumed live via symlinks — a typo in an entry point breaks the host pi
  session, so run tsc + eslint before committing, and check the consuming session still loads
  them (a fresh `pi` starts them without errors).
