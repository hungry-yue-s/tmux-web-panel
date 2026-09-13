---
name: tmux-panel
description: Manage Tmux Web Panel's own plugins, project-built tmux, managed tmux configuration, and related agent skills. Use for installation, enablement, configuration, and maintenance of this panel, not general terminal commands.
---

# Tmux Panel Management

The panel's Settings → 管理中心 is the source of truth for installations.
It manages the bundled plugin catalog, the pinned `vendor/tmux` build, a
managed tmux configuration fragment, and links to this repository's agent skills.

For scripted management use the existing panel URL and Bearer authentication.
Do not guess a different server or print credentials. The API returns
`{success, data, error}`; report errors rather than treating HTTP 200 as proof
of completion. Read `GET /api/plugins` and `GET /api/managed-resources` first.

- Plugin lifecycle: `POST /api/plugins/tmux-agent/install|enable|disable|uninstall`.
  Connection information and skill text: `GET /api/plugins/tmux-agent/connection`.
  The plugin MCP endpoint is `/api/plugins/tmux-agent/mcp` (Streamable HTTP).
- tmux build: `POST /api/managed-resources/tmux/build`, then inspect the resource
  status until the build completes. It uses `scripts/build-tmux.sh`; never
  substitute a system package for the project's pinned build. Rollback:
  `POST /api/managed-resources/tmux/rollback`. Neither restarts the running server.
- Config: `PUT /api/managed-resources/tmux/config` with `content` and the exact
  previously read `expectedContent`; then explicitly `POST .../tmux/config/apply`
  when the requested change should affect the running tmux server. `link` and
  `unlink` manage only the marked source-file block in `~/.tmux.conf`.
  Config saves return the backup path. Preserve `set -g exit-empty off`.
- Skill links: `POST /api/managed-resources/skills/{name}/{codex|claude}/install`
  or `/uninstall`. Only catalogued repository skills are accepted. Foreign
  directories and modified links are reported as conflicts, never overwritten.

Use existing service management for service restarts; do not manually kill and
relaunch the panel or tmux. Installing a binary is not proof that the live
server now runs that binary. Reading status should never create a tmux session.

Management scope is the panel host. Remote tmux workspaces remain accessible
through the existing server registry; this management API does not install
software or skills onto those remote hosts.
