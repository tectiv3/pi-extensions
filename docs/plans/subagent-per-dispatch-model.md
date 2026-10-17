# Subagent: per-dispatch model parameter

Add an optional `model` to the `subagent` tool so a dispatch can pick the child's
model explicitly, instead of requiring a frontmatter `model:` pin (which spawns one
agent file per `(agent, model)` combination).

Status: approved for implementation. Decisions resolved with the user (see
[Decision log](#decision-log)); reviewed by plan-critic. Fresh-agent handoff — read
this file, then `index.ts`. All line numbers below were re-verified after the
plan-critic pass; re-locate by grep if they drift again.

## Background

Model resolution for a subagent run today (`runSingleAgent`, index.ts **1858**;
resolution block **~1909-1930**):

```
new run:    model = agent.model ?? dispatchDefaults.model
resume:     model = resume.meta.model ?? dispatchDefaults.model
```

- `agent.model` — frontmatter `model:` pin in the agent file (`agents.ts` **109**).
- `dispatchDefaults.model` — the PARENT session's model, built at index.ts
  **3337-3339** from `ctx.model` as `"provider/id"`.

The tool schema has **no** `model` parameter (`SubagentParams` **3226**), so today the
only way to run an agent on a non-parent model is a per-agent frontmatter pin
(`scout-flash.md`, `worker-zai.md` in `~/.pi/agent/agents/` are real examples). That
causes agent-file sprawl: every `(agent, model)` pair wants its own file.

This plan adds explicit per-dispatch model selection so agent files stay
model-agnostic. A pin remains a **per-agent default**, not a hard identity — an
explicit dispatch override wins over it (Decision log D1).

## Changes (all in `index.ts` + `README.md`)

### 1. Schema (typebox)

- `SubagentParams` (**3226**): add
  `model: Type.Optional(Type.String({ description: "Model override for this dispatch, 'provider/model-id'. Precedence: explicit > agent file pin > parent session default." }))`.
- `TaskItem` (**3202**) and `ChainItem` (**3210**): add the same optional `model`
  field (per-item override for parallel/chain modes).
- `SubagentParams.model` is single-mode only. If it is passed together with
  `tasks`/`chain`, return an error mirroring the existing `background` guard
  (**3400**), testing presence explicitly so an empty string is not silently
  accepted:
  > `model is single-mode only ({agent, task, model}); set model per item in tasks/chain.`

  Guard shape: `if (params.model !== undefined && (hasChain || hasTasks)) { ... isError: true }`.
  (Decision log D4. This prevents a silently-ignored top-level field.)

### 2. Thread the override into `runSingleAgent`

Definition **1858**. Append the new parameter **last** (after the trailing
`background` and `runtimeBackgroundable` booleans) so the 5 existing positional call
sites only gain a trailing argument:

```ts
    background: boolean = false,
    runtimeBackgroundable: boolean = false,
    overrideModel?: string
```

All call sites (`grep runSingleAgent(` — exhaustive, verified). Because
`overrideModel?` is appended last, each site pads the intervening defaulted params
explicitly (TypeScript enforces this):

- **3743** single (foreground) — currently ends `..., false, true`; append
  `, params.model`.
- **3676** background single — currently ends `..., toolCallId, true`; append
  `, false, params.model`.
- **3581** parallel (`params.tasks` loop) — currently ends `..., toolCallId`;
  append `, false, false, t.model`.
- **3477** chain — currently ends `..., toolCallId`; append
  `, false, false, step.model`.
- **2728** void call in `handleSubagentsResume` (the `/subagents resume <id>`
  command, NOT attach/respawn) — currently ends at `relayUiRequest`; **no change**
  (all defaulted params, incl. `overrideModel`, are omitted → `undefined`).

### 3. Resolution rules

Replace the resolution block (**~1909-1930**) with (branches explicit):

```ts
if (resume) {
    model = overrideModel ?? resume.meta.model ?? dispatchDefaults.model
    if (overrideModel === undefined) {
        thinkingLevel = resume.meta.thinkingLevel   // continuity; unchanged
    } else if (model === dispatchDefaults.model) {
        thinkingLevel = dispatchDefaults.thinkingLevel
    }
} else {
    model = overrideModel ?? agent.model ?? dispatchDefaults.model
    if (model === dispatchDefaults.model) thinkingLevel = dispatchDefaults.thinkingLevel
}
```

- Explicit override at resume WINS over recorded meta (user intent at resume time
  overrides the original run's model). `resumeNote` triggers: set it whenever an
  override is applied at resume, and keep the existing note for the
  no-recorded-model case.
- **Thinking level (D2):** inherit the parent's thinking level **iff the resolved
  model equals `dispatchDefaults.model`** (neither a pin nor a differing override
  applied). A differing model means an explicit model choice, so the child gets its
  own default thinking level. Inheritance is keyed on the resolved model, **not**
  on the presence of a frontmatter pin.
- **Behaviour preservation (qualify precisely):**
  - new run, unpinned + no override → model == parent → inherit (unchanged);
  - new run, pinned with pin ≠ parent → child default (unchanged);
  - resume without override → keeps `resume.meta.thinkingLevel` via the explicit
    branch, so the recorded value is never discarded even when `resume.meta.model`
    is undefined and `model` falls back to the parent default;
  - **one intentional divergence:** a pinned agent whose pin value *equals* the
    parent model now inherits the parent thinking level (the old `!agent.model`
    rule gave it the child default). Accepted as consistent with D2: the effective
    model is the parent default, so inheritance applies.
- **Resume thinking (D3):** a resume **without** an override keeps
  `resume.meta.thinkingLevel` (continuity — unchanged). A resume **with** an
  override re-derives thinking with the D2 rule. This is keyed on the *presence* of
  the override, so re-specifying the same model at resume also re-derives (the old
  model's level is not assumed valid); the branch uses `overrideModel === undefined`.
  Note: the new code uses `??` where the old resume path used `if (!model)`; a
  recorded `model === ""` (never written by `spawnMeta`) would differ — unreachable
  in practice.
- Child spawn already pushes `--model` when set (**1928**); no spawn change.
- `spawnMeta.model` already records the resolved model (**2009-2022**, field
  **2012**); no sidecar schema change (see D6 for the resulting semantics).

### 4. Unknown / bogus model ids (D5)

Do **not** add client-side model validation; the child pi process is the source of
truth. Document the actual behaviour:

- unknown **provider** (e.g. `nope/nope`) → pi errors (`process.exit(1)`); the run
  is marked failed and the error surfaces via the existing stderr/exit-code path.
- known **provider** with an unknown **model** (e.g. `anthropic/does-not-exist`) →
  pi's `buildFallbackModel` fabricates a custom model id and emits only a
  *warning*; the child **starts** and may fail later at request time.

Both cases must be covered by live tests (see below); the plan makes no promise of
fail-fast for the second.

### 5. Sticky meta (D6)

`spawnMeta.model` is written with the resolved model on every spawn, including a
resume with an override (**2009-2022**, field **2012**). Consequence: an
override-resume rewrites the sidecar's `model`, so a later resume without an
override continues on the override model. This is intended (`meta.model` = the
run's **last resolved model**, single source of truth). Document it in README and
lock it with a test.

### 6. Docs

- `README.md` (this dir): new section on per-dispatch model — syntax for single /
  parallel / chain, precedence table, resume behaviour, thinking-level note, the
  single-mode restriction, the unknown-model semantics, and the sticky-meta note.
- Tool parameter descriptions are already LLM-visible via the schema.

## Out of scope

- Per-dispatch `thinking` parameter (same shape; separate decision — D2 chose the
  derived rule instead).
- Client-side model validation against the registry (D5).
- Cross-provider reasoning continuity guarantees: an override-resume may name a
  different provider than the original run. Whether the transcript's reasoning
  blocks continue correctly across providers is verified live (below), not
  guaranteed by this change.
- Any change to `subagent_inspect` / `subagent_collect`.

## Decision log

| # | Decision | Rationale |
|---|---|---|
| D1 | Frontmatter pin is a per-agent **default**; explicit dispatch override wins. | Serves the anti-sprawl goal: one override, no new agent file. |
| D2 | Inherit parent thinking iff the resolved model == parent default; otherwise child default. | Symmetric; removes the pinned-vs-unpinned override asymmetry. Common cases unchanged; the one divergence (a pin equal to the parent model) is documented in §3. |
| D3 | Resume without override keeps recorded thinking; resume with override re-derives via D2. | An explicit model change should drop the old model's thinking level. |
| D4 | Reject top-level `model` with `tasks`/`chain`, mirroring the `background` guard. | No silently-ignored field; explicit per-item precedence. |
| D5 | Accept pi's model resolution; no client-side validation. | pi is the source of truth; avoids duplicating registry logic. |
| D6 | Keep meta sticky (`meta.model` = last resolved model); document + test. | Single source of truth for "the run's current model". |

## Verification (the implementer runs before reporting)

1. Repo gates: `npx tsc --noEmit` (baseline must not regress) and `npx eslint .`
   (zero warnings), per the repo README / AGENTS.md.
2. Live tests (a pi session with this extension loaded — dev symlink into
   `~/.pi/agent/extensions/`; use a cheap/fast model for the test child):
   - single dispatch, unpinned agent, explicit `model` → result meta shows the
     override model (not parent, not pin)
   - explicit `model` on a **pinned** agent → explicit wins
   - no `model` param → parent model inherited (regression check)
   - parallel `tasks` with two different per-item models → both honoured
   - chain with a mid-chain per-step model → honoured
   - top-level `model` + `tasks` → clean single-mode-only error, no silent ignore
   - resume of a persisted run with explicit `model` → override wins, `resumeNote`
     present
   - cross-provider override-resume (original on provider A, override on provider
     B) → override wins; record whether the transcript continues cleanly across
     providers (deferred guarantee, see Out of scope)
   - resume **twice**, second without override → second resumes on the override
     model recorded by the first (D6 sticky)
   - bogus model, unknown provider (`nope/nope`) → clean error, run failed
   - bogus model, known provider (`<provider>/does-not-exist`) → fallback warning;
     record what actually happens (D5)
   - thinking-level checks: pinned agent + override → child default thinking (not
     parent's); unpinned agent + override → child default (not parent's); no
     override → parent thinking inherited
3. Report: changed line ranges per hunk, gate output, live-test matrix results,
   deviations, NOT COVERED.

## Rules

- No git commits (main agent commits after verifying).
- No changes outside `pi-extensions/` except reading.
- Keep the diff surgical: schema, one function signature, one resolution block,
  call sites, README. Resist refactoring adjacent code.
