# Roaming access: relay hop, dynamic DNS and two-factor

The panel listens on `0.0.0.0` and clients reach it by LAN IP. When DHCP moves
that IP — or the machine roams between networks — two things break at once:

- **Sessions and caches are lost.** Browser storage is per-origin, and the origin
  *is* the IP. A new IP means an empty `localStorage`: no session token, no caches.
- **The certificate stops matching.** The leaf certificate's SAN contains the IP it
  was issued for, so between an IP change and the next re-issue clients see an
  untrusted-certificate error.

On managed networks there is a third wrinkle: corporate DNS often resolves *every*
external name to an inspecting egress proxy, so a dynamic-DNS name cannot be used as
the connect target — the proxy cannot route back into the LAN. This design therefore
uses the DNS record only as a **key/value store**, read back over DNS-over-HTTPS, and
connects to the IP directly.

## Components

| Piece | Role |
|---|---|
| `scripts/lan-ip.sh` | Prints the LAN IP of the default-route interface |
| `scripts/duckdns-update.sh` | Pushes the current IP to your Duck DNS subdomain; skips the call when unchanged |
| `scripts/local-ca.sh` | Owns a local CA (10y) and a leaf cert covering the current IP; re-issues on change |
| `scripts/sync-lan-ip.sh` | launchd entrypoint: publish IP, re-issue cert, restart panel and macOS shell |
| `scripts/install-lan-ip-sync.sh` | Installs/removes the `com.<service>.lan-ip-sync` launchd agent; `status` compares local IP, published IP and cert SAN |
| `scripts/setup-relay.sh` | Renders *your* relay page from the template and writes the panel-side relay config; `--publish` creates your Pages repo |
| `scripts/setup-totp.sh` | Enrols TOTP two-factor (QR + otpauth URI) |
| `relay/index.template.html` | Generic relay page; placeholders are substituted at render time |
| `public/js/relay-config.js` | **Generated, gitignored.** Tells the login page where relayed logins bounce |

## What lives where

The repository carries only generic code and the template. Per-deployment secrets and
rendered artifacts stay on the deployer's machine or in their own Pages repo:

- `~/.config/tmux-web-panel/duckdns.env` (0600) — Duck DNS subdomain and token
- `~/.config/tmux-web-panel/totp.json` (0600) — TOTP secret; delete it to disable MFA
- `~/.config/tmux-web-panel/ca/` (0700) — CA key and cert; the cert is also copied into the relay site for download
- `~/.config/tmux-web-panel/tokens.json` (0600) — session tokens, survive restarts
- `~/.config/tmux-web-panel/relay-site/` — rendered relay page
- your GitHub Pages repo — rendered `index.html`, `robots.txt`, `ca.crt`

## Deploy your own

```bash
# 1. service + LAN HTTPS (cert covers localhost and the current LAN IP)
git submodule update --init --recursive
TLS_AUTO=1 AUTH=user:password ./scripts/install-service.sh install

# 2. Duck DNS: create a subdomain at duckdns.org, then store the credentials
umask 077
printf 'DUCKDNS_DOMAIN=mybox\nDUCKDNS_TOKEN=your-token\n' \
  > ~/.config/tmux-web-panel/duckdns.env

# 3. relay page (needs `gh` logged in for --publish; without it, render only and
#    push ~/.config/tmux-web-panel/relay-site/ to your Pages repo yourself)
DUCKDNS_DOMAIN=mybox PAGES_URL=https://you.github.io/mybox-relay/ \
  ./scripts/setup-relay.sh --publish

# 4. the agent that keeps IP and certificate current
./scripts/install-lan-ip-sync.sh install

# 5. optional two-factor
./scripts/setup-totp.sh
```

### Phone side, once

1. Open the relay page and install the CA certificate from its download link
   (Android: Settings → Security → Encryption & credentials → install a CA
   certificate; a screen lock must be configured first).
2. Bookmark the relay page.
3. First visit lands on `login.html?relay=1`: sign in with password (plus TOTP code
   if enrolled) and tick **Trust this device**. The bounce stores a copy of the
   session token in the relay page's origin.

From then on, an IP change costs nothing: the bookmark resolves the new IP over DoH
and hands the stored token to the new origin via a URL fragment, which
`public/js/auth.js` adopts and strips from the address bar.

## How the hop works

1. Bookmark → Pages → DoH (`dns.alidns.com`, falling back to `dns.google`) → current IP.
2. Relay token stored? Redirect to `https://IP:PORT/#handoff=<token>`; the panel adopts it.
   Otherwise redirect to `/login.html?relay=1`.
3. After a relayed login the panel bounces to the relay page with `#store=<token>` (and the
   panel theme), the relay page saves it in its own origin and bounces back with `#handoff=`.
4. On network change the launchd agent (`WatchPaths` on
   `/Library/Preferences/SystemConfiguration`, plus a 30-minute backstop) publishes the IP if
   it moved, re-issues the leaf cert, and restarts the panel and the macOS shell.

## 引导页主题与动画

引导页直接使用 `public/js/theme.js` 的完整配色；`setup-relay.sh` 会一起发布主题、连接脚本和预览页，新增主题无需另维护一套颜色。桌面为左右布局，手机为纵向布局；解析中显示不定进度与连接动效，找到地址立即跳转，失败可重试。系统开启“减少动态效果”时停用动画。

同一个引导地址支持 `?theme=<id>`。优先使用显式主题，其次是客户端注入/本地保存的 `tmux_theme`、中继保存的 `panel_relay_theme`；没有偏好时，手机默认 `oyster`，桌面默认 `tokyo-night`。原生 Android 已在页面脚本前注入保存的主题，进入引导页后可继续通过 `Theme.apply` 同步。Swift/Web 使用相同的主题文件；登录回跳及跨 IP 的 token 交接同时携带主题，使新地址下的登录页和工作台继续使用相同配色。

发布地址下的 `themes.html` 展示全部主题动画。网格中的预览使用隔离存储的 iframe，不执行地址解析或 token 交接；点击“使用并预览”会在当前浏览器保存选定配色。单页外观路径为 `preview.html?theme=<id>`，真正连接的路径为 `?theme=<id>`。

| 主题 | ID |
|---|---|
| Prism · 棱镜 | `prism` |
| Graphite · 石墨 | `graphite` |
| Deep Current | `deep-current` |
| Forest Ink · 森林 | `forest-ink` |
| Tokyo Night | `tokyo-night` |
| Nord | `nord` |
| Gruvbox Dark | `gruvbox-dark` |
| Oyster · 牡蛎白 | `oyster` |
| Solarized Light | `solarized-light` |
| GitHub Light | `github-light` |

每次 DoH 尝试最多 5 秒，主解析失败后尝试备用解析，两个均失败后显示重试。动画不增加等待时间，也不将“解析到地址”误报为服务已连接。

## Maintenance and update paths

| Changed | Takes effect |
|---|---|
| `sync-lan-ip.sh`, `duckdns-update.sh`, `local-ca.sh` | next trigger; shell scripts are re-read per run |
| panel server code | `launchctl kickstart -k gui/$(id -u)/<service>` |
| launchd plist environment | `unload` + `load -w` — **kickstart does not reload env** |
| relay page | push to your Pages repo; build ~1 min, edge cache ~10 min (append `?v=1` once to bypass) |
| leaf certificate | automatically, on IP change |

Inspect with `./scripts/install-lan-ip-sync.sh status` and
`~/Library/Logs/<service>/lan-ip-sync.*.log`.

## Troubleshooting

- **Untrusted certificate right after an IP change** — the window between DHCP and
  re-issue. Retry after a few seconds; `status` shows whether local IP, published IP
  and cert SAN agree.
- **Phone asks for login again after an IP change** — the relay token is missing: the
  first relayed login was never completed, or login happened without `?relay=1`. Do one
  relayed login with **Trust this device** ticked.
- **429 on login** — per-IP rate limit (5 failures per 15 min, 10 min lock, `Retry-After`
  header). The counter is in-memory: restarting the panel clears it.
- **Relay page shows 解析失败** — both DoH endpoints failed (captive portal, blocked
  egress). Use the retry button, or connect to the IP directly as a fallback.
- **Login works but the relay bounce does not** — `public/js/relay-config.js` missing or
  stale; re-run `setup-relay.sh`.

## Security notes

- The relay page stores a **non-expiring trusted token** in its own origin. Logging out
  revokes it server-side; the relay copy then fails validation on the next hop. Treat the
  Pages repo and the phone browser profile accordingly.
- Publishing your LAN IP in a public DNS record is a deliberate trade-off of this design;
  pick an unguessable subdomain. The panel itself still requires auth (and MFA if enrolled).
- On managed/corporate devices, tunnels or VPNs that expose the panel outside the reachable
  network are typically prohibited and are not part of this design: everything here stays
  inside networks that can already route to the machine, and adds no egress bypass.
