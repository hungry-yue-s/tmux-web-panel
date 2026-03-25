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

| Command | Description |
|---------|-------------|
| `./scripts/install-service.sh install` | Install and start service |
| `./scripts/install-service.sh uninstall` | Remove service |
| `./scripts/install-service.sh status` | Show service status |
| `./scripts/install-service.sh logs` | Tail service logs |

- **Linux** — systemd user service (`~/.config/systemd/user/`), restarts on failure, enables lingering
- **macOS** — launchd user agent (`~/Library/LaunchAgents/`), logs at `~/Library/Logs/tmux-web-panel/`

## Development

```bash
npm test          # Run tests
npm run dev       # Start dev server
```
