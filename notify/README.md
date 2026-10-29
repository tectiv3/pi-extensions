# notify

Desktop notifications from pi via terminal escape sequences.

| Trigger | Notification |
| --- | --- |
| Agent settles normally | `pi · <session name>` / `Done` |
| Agent settles after an assistant error | `pi · <session name>` / `Error: <first line>` |
| Pi opens a blocking prompt (question, confirm, select, …) | `pi · <session name>` / prompt text |

Aborted runs (Escape) stay silent. Dialogs that close within 150 ms (validation, an answer that arrives remotely) stay silent too.

No focus gating: Ghostty withdraws a notification while its surface is focused, so firing on every settle is harmless there. Other terminals may show the notification even when you are looking at the session.

## Supported terminals

| Backend          | Terminals                             |
| ---------------- | ------------------------------------- |
| `OSC 777;notify` | Ghostty                               |
| `OSC 9`          | iTerm2, WezTerm                       |
| none             | everything else (unknown, `dumb`, CI) |

`TERM_PROGRAM` selects the backend. Unknown terminals never receive escape sequences, so a pipeline or CI log stays clean. Terminals outside the table (Warp, VS Code, kitty, …) can be enabled with `PI_NOTIFY_BACKEND=osc9` when they support OSC 9; kitty's native protocol is OSC 99 and is not implemented here.

## Ghostty setup

Ghostty ignores notifications until they are enabled in its config:

```ini
desktop-notifications = true
```

On macOS the first notification also needs a permission grant: System Settings → Notifications → Ghostty → Allow Notifications.

Ghostty withdraws the notification when the originating surface gains focus (ghostty-org/ghostty discussion #14626), so a notification only remains visible while you are looking at another surface or application.

## tmux

tmux drops unknown OSC sequences unless passthrough is enabled:

```tmux
set -g allow-passthrough on
```

With passthrough on, the extension wraps the sequence in a tmux DCS envelope automatically. Without it, nothing is delivered.

## Environment variables

| Variable | Effect |
| --- | --- |
| `PI_NOTIFY=0` | Hard-disable notifications for the process, regardless of `/notify on`. |
| `PI_NOTIFY_BACKEND` | Force the backend: `osc777`, `osc9`, or `none`. Overrides `TERM_PROGRAM`. |

## Command

```
/notify [on|off|test|status]
```

- `on` / `off` — toggle notifications for the current session (in-memory only).
- `test` — emit a sample notification.
- `status` (default) — report the session state and the resolved backend.
