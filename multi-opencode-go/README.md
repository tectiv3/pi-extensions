# multi-opencode-go

Manual failover switch for the `opencode-go` provider. Choose, at runtime, whether outgoing `opencode-go` requests carry pi's primary key or a second failover key — no usage polling, cooldowns, automatic rotation, or retry logic.

Ported from [huaxel/pi-multi-opencode-go](https://github.com/huaxel/pi-multi-opencode-go) (`@juanbenjumea/pi-multi-opencode-go@0.2.0`, MIT), reduced to a manual on/off toggle.

## How it works

Pi reads the primary key from `auth.json["opencode-go"]`. **The primary key must stay in `auth.json["opencode-go"]`** so pi's own auth check passes; this extension never reads or replaces that entry. It only overrides the outgoing headers — and only while failover is on:

- **Failover off** (default): the extension does not touch any header. Pi sends its own `auth.json["opencode-go"]` key.
- **Failover on**: the extension sets `Authorization: Bearer <failover key>` **and** `x-api-key: <failover key>`. Setting both covers all three wire APIs the provider serves (`openai-completions`, `anthropic-messages`, `openai-responses`): OpenAI-style APIs use `Authorization`, Anthropic-style APIs use `x-api-key`.

Switching is **manual**. There is no automatic switch on a 429/quota error: if the active key is bad you see the provider error and run `/opencode-switch`.

## Configuration

Add a failover account to `~/.pi/agent/auth.json`:

```json
{
    "opencode-go": { "type": "api_key", "key": "$OPENCODE_API_KEY_1" },
    "opencode-go-failover": { "label": "failover", "key": "$OPENCODE_API_KEY_2" }
}
```

`label` is optional (defaults to `failover`). `key` resolution is deliberately narrow — whole-string `$NAME` or a literal only:

- `$NAME` → the environment variable `NAME` (an empty value counts as unset).
- `$$x` → the literal `$x`.
- Anything else — `${NAME}`, embedded templates like `prefix$NAME`, or `!command` — is **rejected** and the account is treated as unavailable. A rejected key is written to the log (see below); it is never sent as a header.

## Command

```
/opencode-switch            # toggle failover on/off
/opencode-switch on         # use the failover key (aliases: failover)
/opencode-switch off        # use pi's primary key (aliases: primary)
```

The command re-reads `auth.json` each time it runs, so a mid-session edit is picked up without reloading. Outside the command, a mid-session key edit still requires a reload — the request path uses the account loaded at session start.

If failover was persisted on but the failover account is no longer configured at session start, the extension forces failover off (no dangling override).

## Footer status

While failover is on, the pi footer shows the single glyph `⇄` under the `multi-opencode-go` status key. It is cleared when failover is turned off and on session shutdown. Print mode and no-UI hosts never get it.

When failover is already on at `session_start`, a one-time info notice reports the active failover label: `opencode-go: failover active (<label>)`.

## State and logging

- `~/.pi/agent/opencode-go-active.json` — persisted `{ "failover": boolean }`, written with mode `0600`. Missing or corrupt state reads as off.
- `~/.pi/agent/multi-opencode-go.log` — best-effort log of failover on/off notices and rejected keys. Labels only; never key material.

## Install

Symlink the directory into your agent dir:

```sh
ln -s "$PWD/multi-opencode-go" ~/.pi/agent/extensions/multi-opencode-go
```

## Notes and limitations

- **Not compatible with upstream's config.** Upstream uses `auth.json["opencode-go-failover"] = { "accounts": [ { label, key }, ... ] }` (up to 8 accounts). This port expects a single `{ label, key }` object; an upstream `accounts[]` block is ignored (treated as an unavailable account).
- **Custom `configDir` is not honored.** `getAgentDir()` is implemented locally (the host package is not a runtime dependency here) and mirrors only `PI_CODING_AGENT_DIR` with `~` expansion, falling back to `~/.pi/agent`. A custom `configDir` baked into the host package is not detected.
- The upstream README suggests `settings.retry.provider.maxRetries: 0`; that setting is global across providers and is **not** part of this port.
