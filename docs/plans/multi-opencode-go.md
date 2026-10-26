# Manual failover switch: `multi-opencode-go`

Port of the failover idea from
[huaxel/pi-multi-opencode-go](https://github.com/huaxel/pi-multi-opencode-go)
(`@juanbenjumea/pi-multi-opencode-go@0.2.0`, MIT) reduced to a **manual
failover on/off toggle**. No usage fetching, no cooldowns, no auto-continue, no
overnight resume, no coordination globals.

Status: revised after plan-critic review (see [Revision log](#revision-log)).
Not yet implemented.

## Background

Pi's `opencode-go` provider reads its key from `auth.json["opencode-go"]`. The
upstream extension supports up to 8 accounts, live usage polling, automatic
rotation on quota errors, a persisted cooldown ledger, an auto-continue retry,
and an overnight-resume timer. This port keeps only the mechanism the user
asked for: **choose which key is sent, manually.**

The extension overrides the `Authorization` header per request via the
`before_provider_headers` hook, so a second key can be used without changing
pi's own auth entry.

## Decisions (resolved with the user)

| # | Decision | Choice |
|---|---|---|
| D1 | Scope | Manual switch only. Drop usage API, cooldowns, auto-continue, overnight resume, `__opencode_go_*` globals, multi-account lists, debug command. |
| D2 | Accounts | One **failover** account. The primary key stays entirely pi's concern. |
| D3 | Toggle behavior | `/opencode-switch` toggles failover on/off. **Failover on** → set `Authorization: Bearer <failover key>` **and** `x-api-key: <failover key>`. **Failover off** → the extension does not touch any header; pi sends its own `auth.json["opencode-go"]` key. |
| D3a | Wire APIs | `opencode-go` serves `openai-completions`, `anthropic-messages` (minimax-m3, qwen3.8-flash), and `openai-responses`. Setting both headers covers all three: openai uses `Authorization`, anthropic uses `x-api-key` (the provider's own apiKey-derived `x-api-key` is overridden by the transform output, which becomes the client's `defaultHeaders`). |
| D4 | Failover config | `auth.json["opencode-go-failover"]` = `{ "label": "...", "key": "..." }`. |
| D5 | Value resolution | Whole-string `$NAME` or literal only. `$$x` escapes to literal `$x`. Anything else (`${VAR}`, embedded templates, `!command`) is **rejected** (account unavailable), never passed through as a literal. |
| D6 | Persistence | Failover on/off persisted to `~/.pi/agent/opencode-go-active.json`, mode `0600`. |
| D7 | Command surface | Single command `/opencode-switch`. |
| D8 | Directory | `multi-opencode-go/`. |

### Why "override only when failover is on" (D3)

Reading pi's primary key and always overriding would duplicate pi's own
config-value resolver (`dist/core/resolve-config-value.js` supports `${VAR}`,
embedded templates, `$$`/`$!`, and `!command`). Any divergence would risk
sending a garbage `Authorization` on *primary* requests — the exact case the
extension is supposed to leave alone. It would also break if the primary auth
entry is OAuth-shaped (`access`/`refresh`, no `key`). Leaving primary
untouched removes that whole failure class and needs no primary-key resolution.

## Files

```
multi-opencode-go/
├── index.ts        single-file extension (~160 LOC)
├── index.test.ts   pure + fake-pi wiring tests
└── README.md
```

Single-file matches the repo convention for small extensions
(`ask-user-question/index.ts`, `index/index.ts`). No `lib/` split.

## Design — `index.ts`

- `PROVIDER = "opencode-go"`, `AUTH_KEY = "opencode-go-failover"`,
  `STATE_FILE = "opencode-go-active.json"`.
- `getAgentDir()` implemented locally so the file has **no runtime imports**
  beyond node builtins and type-only host types (required for
  `index.test.ts` under standalone `node --test --experimental-strip-types`;
  the host package is not in `node_modules`). It mirrors the host:
  `process.env.PI_CODING_AGENT_DIR` (no trim) with `~` expansion, else
  `join(homedir(), ".pi", "agent")`. **Documented limitation:** a custom
  `configDir` in the host package is not honored; only `PI_CODING_AGENT_DIR`
  and the `.pi` default are.
- `resolveAuthValue(value)` — whole-string only (D5):
  - non-string / empty → `undefined`
  - starts with `!` → `undefined` (command execution intentionally unsupported)
  - starts with `$$` → literal `value.slice(1)`
  - starts with `$` → `name = value.slice(1)`; if `name` matches
    `/^[A-Za-z_][A-Za-z0-9_]*$/` return `process.env[name]`, else `undefined`
    (rejects `${VAR}` and malformed refs)
  - otherwise → `value` if it contains no `$`, else `undefined` (rejects
    embedded templates such as `prefix$VAR`)
- `loadFailoverAccount()`: reads `auth.json`; returns
  `{ label, key } | null` from `auth[AUTH_KEY]`, label defaulting to
  `"failover"`, key via `resolveAuthValue`. `null` when the key is
  missing/unresolvable. A rejection from `resolveAuthValue` is logged to the
  extension log, not silently swallowed.
- `loadFailoverOn()` / `saveFailoverOn(on)`: read/write
  `join(getAgentDir(), STATE_FILE)` as `{ "failover": boolean }`. Read
  errors → `false`; write errors swallowed (best-effort).
- Default export `(pi)` with **closure-scoped** state (one set per invocation,
  so tests are isolated and multiple installs cannot share state):
  - `failover: Account | null`, `failoverOn: boolean`.
  - `pi.on("session_start")` → `failover = loadFailoverAccount()`;
    `failoverOn = loadFailoverOn() && failover !== null`.
  - `loadFailoverAccount()` returns `null` when `auth[AUTH_KEY]` is absent,
    not an object, or its key is missing/unresolvable.
  - `resolveAuthValue` treats an empty-string env lookup as unset
    (`process.env[name] || undefined`), matching the host.
  - `pi.on("before_provider_headers", (event, ctx))` → if
    `ctx.model?.provider === PROVIDER` **and** `failoverOn` **and** `failover`,
    set `event.headers.Authorization = "Bearer " + failover.key` and
    `event.headers["x-api-key"] = failover.key`. Otherwise return without
    mutating. (The host's `prepareRequest` merges the transform output as the
    provider client's `defaultHeaders`, so these override the apiKey-derived
    header on every wire API.)
  - `pi.registerCommand("opencode-switch", { description, handler })`:
    - failover not configured → `ctx.ui.notify("No opencode-go failover account configured", "warning")`.
    - no arg → toggle `failoverOn`, persist, notify
      `opencode-go: using failover (<label>)` / `opencode-go: using primary`.
    - `on` / `failover` → enable; `off` / `primary` → disable (case-insensitive).
    - unknown arg → warning with usage.
    - The handler **re-reads** `loadFailoverAccount()` before acting, so an
      `auth.json` edit made mid-session is picked up without a reload.
      (Outside the command, a mid-session key edit still needs a reload; the
      `before_provider_headers` path uses the in-memory account.)
- Logging: `getLogFilePath()` = `join(getAgentDir(), "multi-opencode-go.log")`.
  `appendFileSync`, best-effort, labels only, no key material. Used for the
  resolver-rejection message and the failover on/off notices.

### Notes / edge cases

- Failover is toggled **manually**; there is no automatic switch on a
  429/quota error. If the active key is bad the user sees the provider error
  and runs `/opencode-switch`.
- If failover was persisted on but the failover account is no longer
  configured at `session_start`, the extension forces it off (no dangling
  override).
- No cross-restart reconciliation beyond the boolean; the key is re-read from
  `auth.json` every `session_start`.

## Config example

```json
{
  "opencode-go":          { "type": "api_key", "key": "$OPENCODE_API_KEY_1" },
  "opencode-go-failover": { "label": "failover", "key": "$OPENCODE_API_KEY_2" }
}
```

**Not compatible with upstream's config.** Upstream uses
`auth.json["opencode-go-failover"] = { "accounts": [ {label,key}, ... ] }`
(up to 8). This port expects a single `{ label, key }` object; an upstream
`accounts[]` block is ignored. The README must state this.

## Tests — `index.test.ts`

Added to the `package.json` `test` glob. Style matches
`subagent/session-epoch.test.ts` (pure modules; no host runtime imports).

- `resolveAuthValue`:
  - `$ENV` set → value; unset → `undefined`.
  - `$$literal` → `$literal`.
  - plain literal → itself.
  - `!cmd` → `undefined` (asserted, not passed through).
  - `${VAR}` → `undefined`; `prefix$VAR` → `undefined`.
  - empty / non-string → `undefined`.
- `loadFailoverAccount`: valid; missing key; `$ENV` indirection; malformed
  value rejected; absent block; non-object block (string/array) → `null`.
- `resolveAuthValue`: empty-string env value → `undefined`.
- persistence: `saveFailoverOn` → `loadFailoverOn` round-trip; missing file →
  `false`; corrupt file → `false`.
- fake-`pi` wiring (temp `PI_CODING_AGENT_DIR` + `auth.json`):
  - `session_start` loads the failover account and restores the boolean;
  - `before_provider_headers` sets both `Authorization: Bearer <failover key>`
    and `x-api-key: <failover key>` when on, leaves both untouched when off,
    and ignores non-`opencode-go` providers;
  - `/opencode-switch` toggles the injected key, re-reads `auth.json`, and
    persists the boolean;
  - a stale persisted "on" with no failover account is forced off.

## Verification (main thread)

1. `npx tsc --noEmit` against the existing baseline.
2. `npx eslint .` (zero warnings).
3. `npm test`.
4. Live `pi` load check (extension loads without errors).
5. **Override proof**: with failover on and a deliberately invalid primary
   key (or by capturing the outgoing request), confirm a request succeeds on
   the failover key — proving the header actually replaces the key pi sends.
   Repeat for one `openai-completions` model and one `anthropic-messages`
   model (`minimax-m3` or `qwen3.8-flash`), since those use different auth
   headers.
6. Commit once green.

## Open items

- README must state the primary key remains in `auth.json["opencode-go"]` so
  pi's own auth check passes; the extension only overrides the outgoing header
  when failover is on.
- Upstream README suggests `settings.retry.provider.maxRetries: 0`; that
  setting is global across providers and is **not** part of this port.
- Symlink install line:
  `ln -s "$PWD/multi-opencode-go" ~/.pi/agent/extensions/multi-opencode-go`.

## Revision log

- **v2 → v3 (plan-critic PROCEED, follow-ups applied).** Set both
  `Authorization` and `x-api-key` when failover is on, to cover
  `anthropic-messages` models (the previous plan only set `Authorization`).
  Added a verification step that proves the failover key is the one actually
  sent, on both wire APIs. Defined the log file path. Defined non-object
  `auth[AUTH_KEY]` → unavailable. Made the state path explicitly
  `join(getAgentDir(), STATE_FILE)`. `/opencode-switch` now re-reads the
  failover account. Empty env lookups treated as unset.
- **v1 → v2 (plan-critic REVISE).** Switched from "always override, read the
  primary key" to "override only when failover is on" (removes resolver-parity
  and OAuth-primary failure classes). Resolver narrowed to whole-string
  `$NAME`/literal with explicit rejection of `${VAR}`, embedded templates, and
  `!command` (previously passed through literally). `getAgentDir()` aligned
  with the host (no trim, `~` expansion) with the custom-`configDir` limitation
  documented. `(n/2)` denominator removed. State made closure-scoped per
  extension invocation. Upstream config-format incompatibility documented.
  Added resolver tests for `${VAR}` and `!cmd`.
