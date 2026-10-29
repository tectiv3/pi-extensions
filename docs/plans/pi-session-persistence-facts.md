# Pi session persistence — what actually lands on disk

Read-only investigation of the host source. Version checked: `~/code/pi-mono/packages/coding-agent/package.json`
→ `@earendil-works/pi-coding-agent` 1.4.0, matching `pi --version` and the installed host (same as the
prior-art doc's baseline, `a6a7bac86`).

Every claim below is cited `file:line`. Where the code does not answer a question it is marked
**UNVERIFIED** rather than inferred.

---

## 1. What is written to the session JSONL

The session file is an append-only JSONL of `SessionEntry` objects. Writing happens in exactly one place:

- `src/core/session-manager.ts:1172` `_persist(entry)` → `src/core/session-manager.ts:1187`
  `appendFileSync(this.sessionFile, \`${JSON.stringify(entry)}\n\`)`.
- `src/core/session-manager.ts:1191` `_appendEntry` is the single funnel: push to `fileEntries`, index in
  `byId`, advance `leafId`, `_persist`.

There is no serializer, no field allowlist, and **no scrubbing step** — the entry object is
`JSON.stringify`'d as constructed. A grep of `session-manager.ts` and `session-export.ts` for
`apiKey|secret` returns 0 hits (measured), i.e. no credential-shaped redaction exists on the write path.

What drives persistence: `src/core/agent-session.ts:1146-1170`. On the agent's `message_end` event the
message object itself is persisted:

- `role === "custom"` → `appendCustomMessageEntry(customType, content, display, details)` (`:1152`).
- `role ∈ {system, user, assistant, toolResult}` → `appendMessage(event.message)` (`:1165`).
- `bashExecution`, `compactionSummary`, `branchSummary` are persisted elsewhere (comment at `:1170`);
  compaction via `appendCompaction`, branch summaries via `appendBranchSummary`.

`appendMessage` (`src/core/session-manager.ts:1204-1215`) stores the message object verbatim as
`entry.message`.

### Content-by-content

| Item | Persisted? | Evidence |
|---|---|---|
| User message text / images | yes, full content blocks | `session-manager.ts:1204`; `docs/session-format.md:105-107` example |
| Assistant text | yes | same |
| Assistant **thinking** (incl. `thinkingSignature`) | **yes** — thinking is a `ThinkingContent` block inside assistant `content` | `docs/message-types.md:39-50` ("A redacted block can have no visible thinking text while retaining an encrypted payload in `thinkingSignature`"), content array at `docs/message-types.md:124` |
| Tool call **arguments** | **yes** — `ToolCall { id, name, arguments }` is a block of the assistant message | `docs/message-types.md:52-59` |
| Tool results | **yes**, `content` + `details` + `usage` + `nestedCalls` | `packages/ai/src/types.ts:640-657`; `nestedCalls` is annotated "Kept for the session record; not sent to the model" |
| System prompt + tool declarations | **yes** — as `sections` keyed by name, plus `toolsAdded`/`toolsRemoved` patches. "Replaying them in order yields the current prompt and tools; there is no separate prompt state entry." | `docs/session-format.md:78-101` |
| Compaction summaries / branch summaries | yes | `docs/session-format.md:115-138` |
| Model change, thinking-level change, usage, labels, session name | yes | `docs/session-format.md:110-126`, `:190-207` |
| Extension `custom` entries (`pi.appendEntry`) | yes, but they do **not** enter model context | `session-manager.ts:1300-1335` doc comment: "Does NOT participate in LLM context" |
| Extension `custom_message` entries | yes, and they **do** enter context | `docs/session-format.md:176-186` |

Nothing is truncated, sampled, or elided on the way to disk: the only size constant in
`session-manager.ts` is `MAX_SESSION_HEADER_SCAN_BYTES = 1 MiB` (`:607`), which guards *reading*
the header, not writing entries.

One deferred-write nuance: the file is not created until the session contains a user or assistant
message — "Setup entries alone (model, thinking level, system prompt) stay in memory so opening and
closing pi without chatting leaves no file behind" (`src/core/session-manager.ts:1160-1170`).

Confirmed by the host docs, which also enumerate export exposure: "They can contain prompts, model
responses, tool arguments, command output, file contents, and extension messages."
(`docs/sessions.md:57`).

---

## 2. Can an extension prevent, or later remove, a persisted message?

The write API is **append-only** and **not exposed for mutation**. `ctx.sessionManager` is a
`ReadonlySessionManager` (`src/core/extensions/types.ts:335`) which is a `Pick<SessionManager, …>`
over read methods only (`src/core/session-manager.ts:245-262`) — `appendMessage`, `appendCustomEntry`,
`appendContextEdit`, `appendCompaction` are all absent from that pick. There is no `deleteEntry`,
`removeMessage`, or `rewrite` method anywhere in `session-manager.ts` (grep: no such symbol).

Exact API surface that touches persistence:

| Hook / API | Effect on the session file | Evidence |
|---|---|---|
| `pi.appendEntry(customType, data)` | appends a `custom` entry. **Not** in LLM context. Only writer extensions have. | `types.ts:1750-1751`; impl `agent-session.ts:3466-3472` → `appendCustomEntry` (`session-manager.ts:1290-1301`) |
| `pi.sendMessage` / `before_agent_start` `message` | appends a `custom_message` entry, permanently in file *and* context. `display:false` only hides it in the TUI. | `types.ts:1496-1500`; `docs/session-format.md:176-186` |
| `tool_call` hook mutating `event.input` | **yes, changes what is persisted** — mutated args are what the model "called", so the persisted assistant tool-call and the executed call agree | `types.ts:1252-1263` ("No re-validation is performed after mutation") |
| `tool_result` hook returning `content` | **yes, changes what is persisted** — the replacement becomes the tool-result message content | `types.ts:1483-1489`; `agent-session.ts:690-706` (`content = hookResult?.content ?? result.content`) |
| `message_end` hook returning `{ message }` | **yes, changes what is persisted** — the replacement is copied into the finalized message object *before* the persistence block runs | `types.ts:1488-1492` (`MessageEndEventResult`: "Replace the finalized message"); applied at `agent-session.ts:1334-1351`; ordering: `agent-session.ts:1143` (extension emit) precedes `:1146` (persistence) |
| `turn_end` / `agent_before_settle` returning `entries: [{ type: "context_edit", targetId, replacement }]` | appends a `context_edit` entry that **removes or replaces the target's model-visible content from that point on**; the target entry's bytes stay in the file | `types.ts:986-1009` (`ContextEditEntryDraft`, `SessionBoundaryDraft`), `types.ts:1022-1025` (`BoundaryResult`); applied at `agent-session.ts:963` → `session-manager.ts:1360-1400` |
| `context` / `context_with_system` hook | **no effect on the file** — see §3 | |
| `--no-session` / `SessionManager.inMemory` | the only way to keep content off disk: suppress the *entire* session | `src/cli/args.ts:132`, `:314` |

So the honest summary: an extension **can** modify content *at write time* (`tool_result`,
`message_end`, `tool_call`) and **can** suppress content from *future model context* afterwards
(`context_edit` with `replacement: null`), but **cannot** delete or rewrite bytes already written.

`context_edit` semantics, from the host docs: "Append-only edit of one earlier context-producing entry.
It changes only future model context; the target entry and its metadata remain unchanged in raw history,
UI, exports, and session accounting." (`docs/session-format.md:139-152`). Projection applied in
`session-manager.ts:519-537` (`projectContextEntry` returns `[]` for `replacement === null`) and
`session-manager.ts:549-556` (latest edit per target on the active branch wins). Edits are
branch-relative: navigating to a point before the edit reveals the original contribution again.

---

## 3. Does a `context` / `context_with_system` rewrite affect the persisted file, or only the request?

**Only the outgoing request. Definitively — the transformed array never reaches the session writer.**

Three pieces of code, in order:

1. **Wiring.** `src/core/sdk.ts:428-432` — the runner's transform is installed as the agent's
   `transformContext`, nothing else:
   ```typescript
   transformContext: async (messages) => {
       const runner = extensionRunnerRef.current;
       if (!runner) return messages;
       return runner.emitContext(messages);
   },
   ```

2. **The transform is a request-only projection.** `packages/agent/src/agent-loop.ts:397-406`, inside
   `streamAssistantResponse`:
   ```typescript
   let messages = context.messages;
   if (config.transformContext) {
       messages = await config.transformContext(messages, signal);
   }
   const llmMessages = await config.convertToLlm(messages);
   const llmContext = normalizeContext({ messages: llmMessages });
   ```
   `messages` is a **local variable**. Its only consumer is `streamFunction(config.model, llmContext, …)`.
   There is no assignment back into `context.messages` (grep of `transformContext` across
   `packages/agent/src` yields exactly two sites: the type declaration at `agent/src/types.ts:244` and
   this call site). The unit test asserts the ordering only: "should apply transformContext before
   convertToLlm" (`packages/agent/test/agent-loop.test.ts:253`).

3. **Persistence reads from agent state, not from the transform.** `agent-session.ts:1146-1170` persists
   `event.message` from the `message_end` agent event — the finalized message object stored in
   `agent.state.messages` (`agent-session.ts:1285-1293`). That object is created by the agent loop from
   the model's response, independent of what `transformContext` returned.

Additional hardening inside the runner (`src/core/extensions/runner.ts:1305-1365`):

- `let currentMessages = structuredClone(messages)` (`:1307`) — handlers get a clone.
- `context` handlers see `currentMessages.filter(m => m.role !== "system")` (`:1314`) and their output is
  merged back with `restoreSystemMessages(...)` (`:1325`): "The prompt and tool state belong to Pi: it
  restores them after the handler returns, so a handler cannot drop them" (`types.ts:881-884`).
- `context_with_system` handlers can replace the whole array, but dropping the leading system message is
  reported as an extension error (`runner.ts:1345-1358`); the handler's output is still honoured.

Consequence for a memory extension: injecting memory via `before_agent_start.systemPrompt` or a
`context` hook is **transient** — it affects a request, never the transcript. Conversely, anything a
memory extension wants to survive a restart must be a real session entry (or its own file on disk).

---

## 4. Are custom-tool results persisted verbatim? Can a tool mark content non-persistent?

Persisted verbatim: yes. The tool-result message is built from the tool's `AgentToolResult` and appended
as a `message` entry by the generic path (`agent-session.ts:1165` → `session-manager.ts:1204`). The
persisted shape is `ToolResultMessage` (`packages/ai/src/types.ts:640-657`), which carries `content`,
`details`, `usage`, `nestedCalls`, `isError`, `timestamp`, `durationMs`. `details` is explicitly stored
even though it is not sent to the model ("Machine-readable result … Not sent to the model" —
`packages/agent/src/types.ts:429-433`).

There is **no** non-persistent / ephemeral flag in either type:

- `AgentToolResult` (`packages/agent/src/types.ts:424-446`): `content`, `details`, `structuredContent`,
  `usage`, `isError`, `terminate` — nothing else.
- `ToolDefinition` (`src/core/extensions/types.ts:579-664`): `name`, `label`, `description`,
  `promptSnippet`, `promptGuidelines`, `parameters`, `constrainedSampling`, `renderShell`,
  `prepareArguments`, `outputSchema`, `exposure`, `namespace`, `reachesTools`, `annotations`,
  `defaultActive`, `prepareLoadout`, `executionMode`, `execute`, `renderCall`, `renderResult` — no
  persistence control.
- `ToolExposure` (`types.ts:516`) is `"direct" | "model-only" | "codemode" | "deferred" | "hidden"`;
  `"hidden"` means "registered but unreachable" (`types.ts:511`) — a reachability setting, not a storage
  setting.

What a custom tool *can* do instead:

- Return less `content` and put the bulky/secret part in `details` — `details` is persisted but never
  sent to the model.
- Have a `tool_result` handler (possibly the same extension) replace `content` before it becomes the
  message (`agent-session.ts:690-706`) — this changes what is persisted.
- Use `context_edit` afterwards to drop the entry from future context — file bytes remain.

**UNVERIFIED:** whether any provider adapter strips `details` before writing (none seen; the write path is
provider-agnostic).

---

## 5. Is there an existing mechanism for marking content sensitive / excluded from the transcript?

**No.** There is no `sensitive`, `private`, `redact`, or `ephemeral` marker on messages, entries, tools,
or results anywhere in `session-manager.ts` or `extensions/types.ts` (grep for
`redact|sensitive|ephemeral|notPersist|nonPersistent` returns only unrelated hits: `types.ts:1276`
"Handlers that redact …" in the `structuredContent` doc comment, and `hidden` for UI/TUI purposes).

The closest existing mechanisms, and why none of them is a sensitivity marker:

| Mechanism | What it does | Why it is not access control |
|---|---|---|
| `context_edit` `replacement: null` | omits an entry from model context from that point on | append-only; the original bytes stay in the JSONL, in the UI, in exports, and in token accounting (`docs/session-format.md:139-152`) |
| `custom_message` `display: false` | hides a message in the TUI | still written to disk and still sent to the model (`docs/session-format.md:186`) |
| `ToolExposure = "hidden"` | tool unreachable by the model | registration visibility, not storage |
| `--no-session` (`args.ts:132`, `:314`) / `SessionManager.inMemory` | no session file at all | all-or-nothing; kills resumability |
| Extension-side scanners (e.g. `@spences10/pi-redact`, `pi-hermes-memory`'s secret scanner) | regex filters on content in-process | policy in the same trust domain; nothing in the host enforces them |

The host's own docs treat the transcript as sensitive-by-default and hand the problem to the user:
"Review exported or shared sessions first. They can contain prompts, model responses, tool arguments,
command output, file contents, and extension messages." (`docs/sessions.md:57`), and the `/bug` flow
warns that the transcript "can contain sensitive conversation data" (`docs/sessions.md:64`).

Also relevant: sessions are only deleted by deleting the `.jsonl` (`docs/session-format.md:17-21`), i.e.
destruction is file-level, not entry-level.

---

## Practical consequence for a memory extension

1. Anything written to the session file is **permanent and verbatim**, including tool arguments,
   command output, thinking text and provider `thinkingSignature` payloads (§1).
2. There is **no** way to persist a memory *and* keep it out of the raw transcript, except by not writing
   it as a session entry at all — an extension's own store is the only place with its own retention
   policy.
3. `context` hooks are the *wrong* tool for redaction: they only shape a request (§3). Redaction at write
   time must go through `tool_result` / `message_end`; removal after the fact is only possible as an
   append-only `context_edit`, which hides but does not delete (§2, §5).
4. **UNVERIFIED:** behaviour of concurrent pi processes on one session file. `session-manager.ts`
   contains no lock/fd-lock primitive; `_persist` is a bare `appendFileSync` (`:1187`), which is atomic
   per line for small writes on POSIX but offers no cross-process coordination. Not tested here.

## Files read

- `packages/coding-agent/src/core/session-manager.ts` (lines 120-200, 245-300, 505-570, 1160-1215, 1290-1410)
- `packages/coding-agent/src/core/agent-session.ts` (lines 940-1000, 1100-1200, 1260-1360, 3460-3475, 1770-1830)
- `packages/coding-agent/src/core/extensions/types.ts` (lines 335, 505-520, 579-664, 860-910, 985-1030, 1085-1100, 1280-1300, 1440-1500, 1745-1755)
- `packages/coding-agent/src/core/extensions/runner.ts` (lines 1030-1100, 1150-1200, 1290-1370)
- `packages/coding-agent/src/core/sdk.ts` (lines 410-440)
- `packages/agent/src/agent-loop.ts` (lines 380-420), `packages/agent/src/types.ts` (lines 420-450)
- `packages/ai/src/types.ts` (lines 630-660)
- `packages/coding-agent/docs/session-format.md`, `docs/sessions.md`, `docs/message-types.md`
- `packages/coding-agent/src/cli/args.ts` (`--no-session`)
