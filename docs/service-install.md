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
- Debian/Ubuntu: `autoconf automake pkg-config build-essential bison libevent-dev libncurses-dev libutf8proc-dev`

Use `TMUX_INSTALL_PREFIX` to change the deployment prefix and `TMUX_BUILD_JOBS`
to set build parallelism.

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
2. **Configure [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) +
   [tmux-continuum](https://github.com/tmux-plugins/tmux-continuum)** in your
   `~/.tmux.conf` to actually persist session content (windows, panes, cwd,
   command lines) to disk:

   ```tmux
   set -g @plugin 'tmux-plugins/tmux-resurrect'
   set -g @plugin 'tmux-plugins/tmux-continuum'
   set -g @continuum-restore 'on'      # auto-restore on tmux server start
   set -g @continuum-save-interval '15' # save every 15 minutes
   ```

   Without these plugins, `tmux-server.service` will start an empty server on
   boot and the panel will simply show no sessions.

3. **`set -g exit-empty off`** is appended to `~/.tmux.conf` automatically by the
   installer (idempotent). It prevents the empty server started by systemd from
   self-exiting before tmux-continuum's auto-restore finishes.

> **Recovery after manual `tmux kill-server`**: tmux-continuum only auto-restores
> on the *first* server start. If you kill the server while the system is up,
> restarting the companion service will give you an empty server — press
> `prefix + Ctrl-r` inside any tmux session to manually restore the last snapshot.
