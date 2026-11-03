// `ctx.tmux`: runs this machine's tmux. Nothing else in the panel spawns tmux.
//
// Arguments are always an array (no shell). On Windows the MSYS2 quoting and
// environment are applied here, so callers never think about them.
//
// `socket` (tmux -L) and `configFile` (tmux -f) exist for tests and private
// servers: experiments never run against the user's default tmux server.

import { execFile } from 'node:child_process';
import { Service } from 'cordis';
import { IS_WINDOWS, msysEnv, msysExecArgs, resolveTmuxBin } from './msys.js';

export const name = 'tmux';

const EXEC_TIMEOUT_MS = 5000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * @typedef {object} TmuxConfig
 * @property {string} [bin] tmux executable; default TMUX_BIN, then MSYS2's on Windows, then `tmux`
 * @property {string} [socket] socket name (tmux -L)
 * @property {string} [configFile] config read when a call starts the server (tmux -f)
 * @property {number} [timeout] per-call timeout in ms
 */

export default class TmuxService extends Service {
  /** @param {TmuxConfig} [config] */
  constructor(ctx, config) {
    super(ctx, 'tmux');
    this.bin = config?.bin || resolveTmuxBin();
    this.socket = config?.socket || null;
    this.configFile = config?.configFile || null;
    this.timeout = config?.timeout ?? EXEC_TIMEOUT_MS;
    this.windows = IS_WINDOWS;
    this.env = this.windows ? msysEnv(process.env) : process.env;
  }

  /** The global options that select this service's tmux server. */
  serverArgs() {
    const args = [];
    if (this.socket) args.push('-L', this.socket);
    if (this.configFile) args.push('-f', this.configFile);
    return args;
  }

  /**
   * Runs one tmux command (or a `;`-chained list) and returns stdout.
   * A failure rejects with the execFile error, whose `stderr` says why.
   */
  exec(args, { timeout = this.timeout } = {}) {
    const argv = [...this.serverArgs(), ...args];
    const [finalArgs, options] = msysExecArgs(argv, {
      timeout,
      maxBuffer: EXEC_MAX_BUFFER,
      env: this.env,
      windowsHide: true,
    }, this.windows);
    return new Promise((resolve, reject) => {
      execFile(this.bin, finalArgs, options, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /** e.g. "3.5a", or null when the output is not recognised. */
  async version() {
    const stdout = await this.exec(['-V']);
    const match = /tmux\s+(?:next-)?([0-9]+\.[0-9]+[a-z]?)/i.exec(stdout.trim());
    return match ? match[1] : null;
  }
}
