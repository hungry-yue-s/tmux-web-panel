// Which tmux server the panel talks to — the one place that decides it.
//
// By default: the user's server, with no global options (exactly what the
// panel has always done). Tests and smoke runs select a private server with
// a socket name (tmux -L) or an absolute socket path (tmux -S); then every
// tmux the panel starts — commands, the attach PTY, file helpers — carries
// that option, and children lose TMUX / TMUX_PANE so an inherited $TMUX can
// never send a command to the user's server (see the root CLAUDE.md and the
// "no experiments on the user's tmux" rule).
//
// Anything that cannot honour a private server (tmux-resurrect's scripts
// call plain `tmux`) must check isPrivateServer() and refuse to run.

let selected = null;

/** @param {{ socket?: string | null, socketPath?: string | null } | null} server */
export function selectTmuxServer(server) {
  const socket = server?.socket || null;
  const socketPath = server?.socketPath || null;
  if (socket && socketPath) throw new Error('select a tmux socket name or a socket path, not both');
  if (socket && !/^[A-Za-z0-9._-]+$/.test(socket)) throw new Error(`invalid tmux socket name: ${socket}`);
  if (socketPath && !/^(\/|[A-Za-z]:[\\/])/.test(socketPath)) throw new Error('a tmux socket path must be absolute');
  const previous = selected;
  selected = socket || socketPath ? { socket, socketPath } : null;
  return () => {
    selected = previous;
  };
}

/** Global options that select the server, to put before any tmux command. */
export function tmuxServerArgs() {
  if (!selected) return [];
  return selected.socket ? ['-L', selected.socket] : ['-S', selected.socketPath];
}

export function isPrivateServer() {
  return selected !== null;
}

/** The same options as a shell word list, for the Unix attach command line. */
export function tmuxServerShellArgs() {
  return tmuxServerArgs().map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** A child environment for tmux: without TMUX / TMUX_PANE when a private server is selected. */
export function tmuxEnv(env = process.env) {
  if (!selected) return env;
  const copy = { ...env };
  delete copy.TMUX;
  delete copy.TMUX_PANE;
  return copy;
}
