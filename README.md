<div align="center">

<img src="public/favicon.svg" width="76" alt="Tmux Web Panel logo">

English | [中文版](README.zh-CN.md)

# Tmux Web Panel

**The tmux sessions on your machines, in any browser — desktop, phone or tablet —
as if you were sitting at the keyboard.**

Real `tmux attach`, not a toy terminal emulator: every session, window and pane
of every machine you own, plus rendered docs, live perf dashboards and
"your build finished" notifications that follow you to your phone.

<img src="docs/assets/readme/hero.png" alt="Desktop: terminal beside a docked Mermaid diagram preview" width="100%">

</div>

---

## Sound familiar?

| Your day | What the panel does about it |
|---|---|
| The build runs on the office Mac. You're on the couch with only a phone. | A full terminal in mobile Safari/Chrome: real key input, inertial fling scrolling, long-press select & copy. No SSH client, no jump host, no squinting at an 80×24 screenshot. |
| You launched four long jobs in four tmux windows, then forgot they exist. | The panel watches every window. The moment a command finishes, that sidebar row starts breathing — and the macOS app pushes a native notification. One tap lands you on the exact window. |
| `Esc`, `Ctrl-C`, `↑`, `:wq` — none of which your phone keyboard can type. | A scene-aware key drawer. It sees the pane is running Claude Code, vim or lazygit and hands you exactly those keys, plus your own most-used commands ranked by use. |
| A stack trace prints `api/routes/checkout.js:214`. On a phone that's a squint-and-screenshot moment. | Every path and URL in terminal output is tappable. Code, Markdown (Obsidian wikilinks & callouts), Mermaid, CSV/XLSX, PDFs and archive trees render in a docked tab beside the terminal. |
| Laptop, homelab box, CI runner, GPU box, that one Windows machine. Five terminal apps and a pile of SSH config held in your head. | One workbench lists every machine with health, latency and CPU/RAM. Every view — down to a single pane — has a shareable URL. |
| Web terminals are usually canvases that mangle TUIs, break on resize and eat your scrollback. | This is a genuine `tmux attach` over `node-pty` with the xterm WebGL renderer: zoom or split panes, drag-resize layouts, 12 themes, per-pane font size, CJK-safe. |

If two or more rows felt personal, keep scrolling.

---

## See it move

| | |
|:---:|:---:|
| <img src="docs/assets/readme/notify.gif" alt="A background window finishes; the sidebar row breathes; one click jumps to it" width="100%"> | <img src="docs/assets/readme/palette.gif" alt="Command palette fuzzy-searching windows" width="100%"> |
| A job finishes in a window you're not looking at. The row breathes, the bell badge counts it, one click takes you there. | `⌘K` fuzzy-finds any window on any connected machine. |
| <img src="docs/assets/readme/themes.gif" alt="Cycling terminal themes" width="100%"> | <img src="docs/assets/readme/mobile-drawer.png" alt="Mobile key drawer" width="300"> |
| Twelve themes, applied to the UI and the terminal at once. | The phone key drawer: scene tabs, fixture pad, your top-8 keys by usage. |

---

## A day with the panel

### 23:40 — start the migration from the couch

The terminal is not a read-only log viewer. It is your tmux, attached: type,
`Ctrl-C`, resize, split. On a phone the key drawer supplies the keys your
keyboard doesn't have, and it switches its layout automatically when the pane
switches from shell to Claude to vim.

<img src="docs/assets/readme/mobile-terminal.png" alt="Mobile terminal" width="300"> <img src="docs/assets/readme/mobile-drawer.png" alt="Mobile key drawer" width="300">

### 09:15 — learn what finished overnight, without opening anything

Completion detection watches for the non-shell → shell transition in every
pane, so plain scripts notify you with zero setup; interactive TUIs (Claude
Code etc.) get a one-command bell hook. Notifications persist across restarts
and bridge into macOS Notification Center when you use the native app.

### 11:30 — read the doc without alt-tabbing

Tap the path a tool just printed. Markdown renders with KaTeX math, Obsidian
callouts and clickable `[[wikilinks]]`; Mermaid diagrams render in your current
theme and export to PNG; zips show their entry tree. Dock it on the right and
keep working — tabs persist per window.

<img src="docs/assets/readme/split.png" alt="Split panes in the browser" width="100%">

### 14:00 — one tab for every machine you own

Register a host and the panel speaks to it over your existing OpenSSH setup —
config, agent, ProxyJump, hardware keys; it installs nothing remotely and stores
no secrets. Machines without tmux still work: the panel hosts the session tree
itself over persistent SSH PTYs.

<img src="docs/assets/readme/servers.png" alt="Server switcher" width="100%">

The status page is a small observatory: per-machine CPU/RAM/IO with history,
the processes actually pressing on each, per-tmux-window resource breakdown,
and — on the machine running your AI tools — live Claude and Codex usage
windows with reset countdowns.

<img src="docs/assets/readme/perf.png" alt="Performance dashboard" width="100%">

### 16:20 — make it yours

Drag pane borders in the visual layout picker, pin the windows you live in,
right-click anything for context actions, and pick a theme that matches the
rest of your setup.

<img src="docs/assets/readme/layout.png" alt="Layout picker" width="100%">

---

## Highlights

The terminal line is a real attach: `node-pty` plus xterm.js 6 on WebGL, zoom and split modes, layout presets with drag-resize, pane labels, per-pane font size, and reconnect logic that tells a clean detach from a network drop and says so in different words.

Input is where the mobile work went. The key drawer detects whether the pane runs Claude Code, vim or lazygit and swaps its own layout accordingly, ranks keys by how often you actually press them, and seeds itself on first run from your shell history, slash commands and vim maps. Long-press selection comes with an editable copy preview, and you can push a file from the phone straight to the host.

Link detection is the feature people stop noticing they rely on: paths, `file://`, `localhost:port`, `:line` refs and CJK filenames are all clickable, and previews cover code, Markdown with Obsidian syntax, Mermaid, images, PDF, CSV/XLSX, directories and archive trees, refreshing when the file changes and exportable as a shared snapshot with a TTL. The multi-machine line adds eight explicit health states, host-key first-trust with fingerprint confirmation, and remote metrics collected by a read-only stdin probe with nothing installed on the far side. Notifications ride along: completion and bell edges per pane, breathing sidebar rows, a persisted notification center, and native macOS notifications that deep-link to the window.

Ops is not an afterthought. Optional token auth, optional self-signed TLS covering localhost and the LAN IP, a systemd/launchd installer that builds tmux from a pinned submodule, and a companion service that brings sessions back after a reboot. The frontend has no build step, and there are roughly 1,400 automated tests across frontend, backend, SSH transport and the native bridges.

---

## Quick start

```bash
npm install
node server/index.js
```

Open <http://localhost:7681>. That's the whole thing — no build step, no database.

Run it as a login-starting, crash-restarting service (and optionally HTTPS for
your LAN) with one command:

```bash
git submodule update --init --recursive
./scripts/install-service.sh install          # add TLS_AUTO=1 for HTTPS
```

AI agents such as Qoder and Codex can report stop, attention, failure and
session-end events into the same notification feed:

```bash
node scripts/install-agent-hooks.js all
```

On macOS there is also a native SwiftUI shell (`npm run build:macos`) that adds
menu-bar status, native notifications and a real clipboard bridge.

---

## Go deeper

| | |
|---|---|
| [Configuration & authentication](docs/authentication.md) | flags, env vars, token model, logout |
| [Agent notifications](docs/agent-notifications.md) | Qoder/Codex hook install, token handling, dedupe rules |
| [Service install & reboot persistence](docs/service-install.md) | systemd/launchd, TLS, vendored tmux, tmux-resurrect wiring |
| [File preview & link detection](docs/file-preview.md) | dock tabs, renderers, sharing, sensitive-path policy |
| [Mobile interaction guide](docs/mobile-gestures.md) | selection gestures, scrolling, key drawer, uploads |
| [Multi-server design](docs/多服务器管理-UIUX设计.md) | the UX model behind the workbench, with a clickable demo |
| [Multi-server implementation](docs/多服务器管理-前后端实现文档.md) | providers, SSH transport, API/WS contracts, security boundaries |
| [macOS native app](macos/README.md) | what the Swift shell adds and how to build it |
| [Known issues & fix list](docs/known-issues.md) | what we already know is rough |

## Development

```bash
npm test          # vitest: frontend, backend, SSH transport, native bridges
npm run dev       # start the server
```
