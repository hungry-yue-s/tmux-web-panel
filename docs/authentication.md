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

## Logout

Open the **设置** (Settings) page and tap **Sign Out**.
