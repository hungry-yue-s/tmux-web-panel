# Tmux Web Panel

A mobile-friendly web UI for tmux session management.

## Quick Start

```bash
npm install
node server/index.js
```

Open `http://localhost:7681` in your browser.

## Configuration

| Option | CLI Flag | Environment Variable | Default |
|--------|----------|---------------------|---------|
| Port | `--port` | `PORT` | `7681` |
| Host | `--host` | `HOST` | `0.0.0.0` |
| Auth | `--auth` | `AUTH` | disabled |
| Poll interval | `--poll-interval` | `POLL_INTERVAL` | `3000` |
| Max connections | `--max-connections` | `MAX_CONNECTIONS` | `5` |
| TLS certificate | `--tls-cert` | `TLS_CERT` | disabled |
| TLS private key | `--tls-key` | `TLS_KEY` | disabled |

## Authentication

Authentication is optional. When enabled, users must log in through a web login page before accessing the panel.

### Enable Authentication

**Recommended — use environment variable** (password won't appear in `ps` or shell history):

```bash
AUTH=user:password node server/index.js
```

**Not recommended — CLI flag** (password visible in process list):

```bash
node server/index.js --auth user:password
```

Format: `username:password` (separated by the first `:`; password may contain `:`).

### How It Works

- Server generates opaque tokens (24h TTL) stored in memory
- Client stores token in `localStorage`, sends via `Authorization: Bearer` header (HTTP) or `?token=` query param (WebSocket)
- On token expiry or logout, the user is redirected to the login page
- Without `--auth` / `AUTH`, everything works without authentication

### Logout

Go to the **More** page (gear icon) and click **Sign Out**.

## Command Completion Notifications

The sidebar will blink when a command finishes in any non-active window.

For interactive programs like Claude Code, install the bell notification hook:

```bash
node scripts/install-claude-hook.js
```

To uninstall: `node scripts/install-claude-hook.js --uninstall`

## Auto-Start Service

Install as a user-level service that starts on login and auto-restarts on crash:

```bash
./scripts/install-service.sh install
```

With custom config:

```bash
PORT=8080 AUTH=user:pass ./scripts/install-service.sh install
```

For HTTPS on the current machine and LAN, the installer can generate and
reuse a self-signed certificate containing `localhost`, `127.0.0.1`, the
hostname, and the current default-interface IP:

```bash
TLS_AUTO=1 AUTH=user:pass ./scripts/install-service.sh install
```

The certificate is stored under `~/.config/tmux-web-panel/tls/`. Re-running
the command reuses it while it is valid and still covers the current IP;
otherwise it is regenerated. Set `TLS_DIR` or `TLS_DAYS` to override the
storage directory or lifetime. Other devices must trust the generated
certificate explicitly, or their browser will show a certificate warning.

| Command | Description |
|---------|-------------|
| `./scripts/install-service.sh install` | Install and start service |
| `./scripts/install-service.sh uninstall` | Remove service |
| `./scripts/install-service.sh status` | Show service status |
| `./scripts/install-service.sh logs` | Tail service logs |

- **Linux** — systemd user service (`~/.config/systemd/user/`), restarts on failure, enables lingering
- **macOS** — launchd user agent (`~/Library/LaunchAgents/`), logs at `~/Library/Logs/tmux-web-panel/`

### Session persistence across reboots

tmux sessions live in the `tmux` server's memory and are **lost when the computer reboots**. The web panel only reads existing sessions — it does not create or persist them. To survive reboots:

1. **Linux installer ships a `tmux-server.service` companion unit** (auto-installed by `install-service.sh`) that boots the tmux server on login. The web panel's unit declares `After=tmux-server.service`, so the panel sees sessions immediately on first page load.
2. **Configure [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) + [tmux-continuum](https://github.com/tmux-plugins/tmux-continuum)** in your `~/.tmux.conf` to actually persist session content (windows, panes, cwd, command lines) to disk:

   ```tmux
   set -g @plugin 'tmux-plugins/tmux-resurrect'
   set -g @plugin 'tmux-plugins/tmux-continuum'
   set -g @continuum-restore 'on'      # auto-restore on tmux server start
   set -g @continuum-save-interval '15' # save every 15 minutes
   ```

   Without these plugins, `tmux-server.service` will start an empty server on boot and the panel will simply show no sessions.

3. **`set -g exit-empty off`** is appended to `~/.tmux.conf` automatically by the installer (idempotent). It prevents the empty server started by systemd from self-exiting before tmux-continuum's auto-restore finishes.

> **macOS note**: `install-service.sh` does not install a launchd agent for the tmux server. Either start tmux manually after login, or use [`tmuxinator`](https://github.com/tmuxinator/tmuxinator)/your own LaunchAgent. The web panel still works — it just shows an empty list until a tmux server exists.

> **Recovery after manual `tmux kill-server`**: tmux-continuum only auto-restores on the *first* server start. If you kill the server while the system is up, restart `tmux-server.service` will give you an empty server — press `prefix + Ctrl-r` inside any tmux session to manually restore the last snapshot.

## Mobile Text Selection

Long-press on the terminal to select and copy text on mobile devices.

| Gesture | Action |
|---------|--------|
| Long-press (500ms) | Select the word under your finger, vibration feedback |
| Hold + drag | Extend selection character-by-character (works across lines) |
| Release | Selection stays, editable preview panel appears at top |
| Edit preview | Tap the preview panel to modify text before copying |
| Copy button | Copies the (edited) preview content to clipboard |
| Tap terminal | Dismiss selection and preview |

The preview panel auto-scrolls to match drag direction: dragging down shows the tail, dragging up shows the head.

## Development

```bash
npm test          # Run tests
npm run dev       # Start dev server
```
