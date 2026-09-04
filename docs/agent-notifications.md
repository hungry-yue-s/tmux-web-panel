# Agent completion and attention notifications

`tmux-web-panel` can turn agent lifecycle events into the same persisted
notifications and sidebar highlights used by tmux bell detection. This covers
Qoder, Codex, and any other CLI that can run a command hook or wrapper.

## What gets reported

The panel accepts normalized events at:

```text
POST /api/agent-events
```

The built-in router script maps agent hooks into these states:

| Agent event | Panel state | Bell |
|---|---|---|
| `Stop` | `agent_stopped` | yes |
| `PermissionRequest` | `waiting_attention` | yes |
| `Notification` | `waiting_attention` | yes |
| `StopFailure` | `failed` | yes |
| `SessionEnd` | `session_ended` | no |
| `SubagentStop` | `agent_stopped` | no |

Events are deduped by pane/window/session location and priority, so a `Stop`
hook, a tmux bell, and a later process-exit fallback should produce one visible
notification instead of three.

## Install Qoder and Codex hooks

Run this on the machine where Qoder/Codex and `tmux-web-panel` run:

```bash
node scripts/install-agent-hooks.js qoder
node scripts/install-agent-hooks.js codex
# or both:
node scripts/install-agent-hooks.js all
```

The installer edits personal agent config only:

| Agent | File |
|---|---|
| Qoder | `~/.qoder/settings.json` |
| Codex | `~/.codex/hooks.json` |

Before each edit it writes a timestamped backup next to the original file. It
preserves existing hooks and adds only hooks named `tmux-web-panel-*`.

To remove them later:

```bash
node scripts/install-agent-hooks.js all --uninstall
```

## Authentication

Do not hard-code bearer tokens into Qoder or Codex config. The installed hooks
call:

```bash
scripts/agent-event-router.js
```

The router authenticates in this order:

1. `--panel-token ...`
2. `TMUX_WEB_PANEL_TOKEN`
3. the local persisted panel token store at
   `~/.config/tmux-web-panel/tokens.json`

For a normal local install, log in to the panel once with a trusted token and no
extra configuration is needed. If the panel runs elsewhere, set:

```bash
export TMUX_WEB_PANEL_AGENT_EVENTS_URL="https://127.0.0.1:7681/api/agent-events"
export TMUX_WEB_PANEL_TOKEN="<panel bearer token>"
```

The default URL is `https://127.0.0.1:7681/api/agent-events`. Localhost
self-signed TLS is accepted by the router; non-local HTTPS still uses normal
certificate verification.

## Verify

After installing hooks, send a smoke event:

```bash
printf '{"hook_event_name":"Notification","session_id":"smoke","reason":"agent hook smoke"}' \
  | scripts/agent-event-router.js --agent qoder --event notification --no-bell
```

Then open the notification panel, or query the API with a valid panel token:

```bash
curl -k https://127.0.0.1:7681/api/notifications \
  -H "Authorization: Bearer $TMUX_WEB_PANEL_TOKEN"
```

You should see an `agent-event` notification with `state=waiting_attention`.

## Notes for Codex

Current Codex installs that support hooks read `~/.codex/hooks.json`. The
installer uses the same JSON hook shape already used by Codex for `Stop` and
`SubagentStop`. If a future Codex build does not support one of the optional
lifecycle events, that event is ignored by Codex while the supported events keep
working.

Some Codex builds may ask you to trust newly-added hooks on first use. Approve
only the `tmux-web-panel-*` hooks if the command path points to this repository's
`scripts/agent-event-router.js`.
