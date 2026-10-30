# Service install & session persistence

## Auto-start service

Install as a user-level service that starts on login and auto-restarts on crash:

```bash
git submodule update --init --recursive
./scripts/install-service.sh install
```

The installer always builds tmux from the pinned `vendor/tmux` Git submodule and
atomically deploys it to `~/.local/share/tmux-web-panel/bin/tmux`. It does not
fall back to a system tmux. Clone this repository with `--recurse-submodules`,
or run the submodule command above after cloning.

Build dependencies:

- macOS (Homebrew): `autoconf automake pkgconf libevent ncurses utf8proc jemalloc`
- Debian/Ubuntu: `autoconf automake pkg-config build-essential bison patch libevent-dev libncurses-dev libutf8proc-dev`

Use `TMUX_INSTALL_PREFIX` to change the deployment prefix and `TMUX_BUILD_JOBS`
to set build parallelism.

Both service and macOS app builds apply `scripts/tmux-patches/` to a temporary
source copy. The startup patch prevents configuration from being loaded or a
plugin client from being blocked again when the initial client disconnects.
The pinned submodule remains unchanged. After building, check this with:

```bash
node scripts/test-tmux-startup.mjs ~/.local/share/tmux-web-panel/bin/tmux
```

To update the maintained tmux revision, check out the desired upstream commit
inside `vendor/tmux`, verify it, and commit the resulting submodule pointer in
this repository:

```bash
git -C vendor/tmux fetch origin
git -C vendor/tmux checkout <commit>
./scripts/build-tmux.sh
```

With custom config:

```bash
PORT=8080 AUTH=user:pass ./scripts/install-service.sh install
```

## HTTPS for the machine and the LAN

The installer can generate and reuse a self-signed certificate containing
`localhost`, `127.0.0.1`, the hostname, and the current default-interface IP:

```bash
TLS_AUTO=1 AUTH=user:pass ./scripts/install-service.sh install
```

The certificate is stored under `~/.config/tmux-web-panel/tls/`. Re-running the
command reuses it while it is valid and still covers the current IP; otherwise
it is regenerated. Set `TLS_DIR` or `TLS_DAYS` to override the storage directory
or lifetime. Other devices must trust the generated certificate explicitly, or
their browser will show a certificate warning.

## Commands

| Command | Description |
|---------|-------------|
| `./scripts/install-service.sh install` | Install and start service |
| `./scripts/install-service.sh uninstall` | Remove service |
| `./scripts/install-service.sh status` | Show service status |
| `./scripts/install-service.sh logs` | Tail service logs |

- **Linux** — systemd user service (`~/.config/systemd/user/`), restarts on failure, enables lingering
- **macOS** — launchd user agent (`~/Library/LaunchAgents/`), logs at `~/Library/Logs/tmux-web-panel/`

## Session persistence across reboots

tmux sessions live in the tmux server's memory and are **lost when the computer
reboots**. The web panel only reads existing sessions — it does not create or
persist them. To survive reboots:

1. **The installer ships a companion tmux service** that boots the tmux server on
   login: `tmux-server.service` on Linux and `com.tmux-web-panel.tmux-server.plist`
   on macOS. The tmux service is loaded before the web panel so restored sessions
   are available immediately.
2. **Session protection is built in** (each server's **会话** page). The panel
   saves tmux every 5 minutes with the bundled
   [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect)
   (`vendor/tmux-plugins/`), and the first time it sees a tmux server with no
   sessions it restores the latest save: windows, panes, their directories, and
   the programs ticked on that page. Nothing needs to be added to
   `~/.tmux.conf`, and tmux-continuum is not used.

   If your `~/.tmux.conf` already loads tmux-resurrect (for example through TPM
   with tmux-continuum), the panel leaves saving and restoring to it and only
   offers "save now" and restoring single sessions from history.

3. **`set -g exit-empty off`** is appended to `~/.tmux.conf` automatically by the
   installer (idempotent). It keeps the empty server started at boot alive until
   the panel restores into it.

> **After a manual `tmux kill-server`** the companion service starts an empty
> server and the panel restores into it within about 20 seconds. Any earlier
> save can be brought back under **会话 → 找回会话**; it opens as a new session
> and leaves running ones alone. `prefix + Ctrl-s` / `prefix + Ctrl-r` still
> save and restore from a terminal.

On Windows the task also ends a server that has stopped answering and starts a
new one, and every such event goes to `tmux-server.log`
(`install-service.ps1 logs -Tmux`). `install-service.ps1 reload` picks up a new
`run-tmux-server.ps1` without touching tmux; `restart -Tmux` ends the server and
every session. Known environment problems are recorded in
[known-issues.md](known-issues.md).
