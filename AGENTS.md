# pi-extensions

pi coding-agent extensions (TypeScript, run inside the pi process):

| Directory | Purpose |
|---|---|
| `subagent/` | Subagent tool — delegates tasks to specialized agents with isolated context (single, parallel, chain modes). See `subagent/README.md`. |
| `ask-user-question/` | Structured question tool — single- and multi-question prompts with typed answers (tabbed per-question pages, `allowOther` "Type something" option). |

Both are symlinked into the consuming pi setup (`~/.pi/agent/extensions/<name>`); there is no
build step — pi loads the `.ts` files directly.

## Types

Runtime dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `typebox`) are provided by the host
pi installation, not by this repo. `types.d.ts` at the repo root declares stubs for them so the
tree type-checks standalone. Only `node` types plus the dev toolchain (eslint, typescript,
prettier) are installed here.

## Checks

- `pnpm install`
- `npx tsc --noEmit` — type-checks against a baseline (`.tsc-baseline`). Only **new** errors
  (not in the baseline) block the commit. If you fix a baseline error, regenerate:
  `npx tsc --noEmit 2>&1 | grep "error TS" | sort > .tsc-baseline`
- `npx eslint .` — zero warnings allowed.

## Conventions

- Commit messages: imperative, concise ("Add ...", "Fix ...").
- The extensions are consumed live via symlinks — a typo in an entry point breaks the host pi
  session, so run tsc + eslint before committing, and check the consuming session still loads
  them (a fresh `pi` starts them without errors).
