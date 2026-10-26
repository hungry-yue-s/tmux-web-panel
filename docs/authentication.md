# Authentication

Authentication is optional. Without it the panel is open to whoever can reach the
port; with it, every request and WebSocket upgrade must carry a token issued by
the login page.

## Enable

**Recommended — environment variable** (the password never appears in `ps` or shell history):

```bash
AUTH=user:password node server/index.js
```

**Not recommended — CLI flag** (visible in the process list):

```bash
node server/index.js --auth user:password
```

Format is `username:password`, split on the *first* `:` — the password itself may contain `:`.

## How it works

- The server stores a salted hash of the password and issues opaque tokens with a 24h TTL.
- Tokens survive restarts in `~/.config/tmux-web-panel/tokens.json` (mode `0600`).
- Clients send the token as `Authorization: Bearer` on HTTP and as `?token=` on the WebSocket upgrade.
- On expiry or logout the client is redirected to the login page.

## Panel-to-panel (node token)

When another panel manages this machine (see [architecture](architecture.md)),
it does not log in. On startup this panel writes a random 64-hex-digit node
token to `~/.config/tmux-web-panel/node-token` and the pairing file
`~/.config/tmux-web-panel/node.json` (both owner-only; on Windows inheritance is
removed with `icacls`). The other panel reads the pairing file over SFTP — which
already proves it can log in to this machine as you — and sends the token as
`Authorization: Bearer` on HTTP and on the WebSocket upgrade.

- The node token is accepted for this machine's own API only. The `/n/:serverId`
  relay requires a login token, so a node token cannot be used to hop on to
  further machines.
- The token survives restarts. To revoke every paired panel, delete
  `node-token` and restart the service; panels re-pair on their next request.

## Logout

Open the **设置** (Settings) page and tap **Sign Out**.
