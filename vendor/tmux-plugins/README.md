# Vendored tmux plugins

Session protection (`server/session-protection/`) saves tmux with
[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect). The panel
runs its `save.sh` itself and restores snapshots with its own code, so
tmux-continuum is not used and nothing has to be added to `~/.tmux.conf`.

| Directory | Upstream | Commit |
|---|---|---|
| `tmux-resurrect/` | tmux-plugins/tmux-resurrect (MIT, see its `LICENSE.md`) | `cff343cf9e81983d3da0c8562b01616f12e8d548` |

Only the files needed at runtime are kept: `resurrect.tmux`, `scripts/`,
`save_command_strategies/`, `strategies/` and the license.

Added by this project:

- `tmux-resurrect/save_command_strategies/msys_procfs.sh`: MSYS2 (Windows)
  has neither `ps -o` nor `pgrep`, so the stock strategies record no programs.
  This one reads `/proc/<pid>/ppid` and `cmdline` instead.

To update, copy the same files from a newer upstream commit, keep
`msys_procfs.sh`, update the commit above, and keep the files executable
(`git update-index --chmod=+x`) with LF endings (see `.gitattributes`).
