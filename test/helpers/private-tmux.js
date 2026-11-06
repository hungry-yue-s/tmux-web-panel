import { rmSync } from 'node:fs';
import { dirname } from 'node:path';

export const PRIVATE_TMUX_IDENTITY_FORMAT = '#{pid}\t#{socket_path}';

export function parsePrivateTmuxIdentity(output, socket) {
  const [pid, socketPath, extra] = String(output).trim().split('\t');
  if (!/^[1-9]\d*$/.test(pid) || !Number.isSafeInteger(Number(pid)) || socketPath !== socket || extra !== undefined) {
    throw new Error('tmux did not identify the expected private socket');
  }
  return { pid: Number(pid), socketPath };
}

function stillRunning(pid) {
  try { process.kill(pid, 0); return true; } // Liveness probe only; never terminate by PID.
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Cleanup only this test's recorded server; unknown ownership is left for inspection. */
export async function cleanupPrivateTmux({ dir, socket, identity, readIdentity, killServer, primaryError }) {
  try {
    if (!identity || dirname(socket) !== dir || identity.socketPath !== socket) throw new Error('missing private server identity');
    const current = await readIdentity();
    if (current.pid !== identity.pid || current.socketPath !== identity.socketPath) throw new Error('private server identity changed');
    await killServer(); // The caller always uses the same explicit -S socket, never a raw PID signal.
    // Let the terminated server be reaped once; this is not a second kill or retry.
    await new Promise(resolve => setTimeout(resolve, 20));
    try {
      await readIdentity();
    } catch (error) {
      // tmux may leave a stale Unix socket inode. Only its explicit refusal and
      // the original PID being absent prove this directory can be removed.
      const absent = /no server running|error connecting[^\n]*(?:No such file|Connection refused)/i.test(String(error.stderr || error.message || ''));
      if (absent && !stillRunning(identity.pid)) {
        rmSync(dir, { recursive: true, force: true });
        return;
      }
      throw new Error('private server exit is unconfirmed', { cause: error });
    }
    throw new Error('private socket still answers after shutdown');
  } catch (error) {
    const message = 'Retained private tmux directory ' + dir + ': ' + error.message;
    if (primaryError) console.warn(message); // Preserve the original test failure and report cleanup separately.
    else throw new Error(message, { cause: error });
  }
}
