import { it, expect } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmuxApi } from '../server/tmux.js';
import { createPlugin } from '../plugins/tmux-agent/server.mjs';
import { PRIVATE_TMUX_IDENTITY_FORMAT, parsePrivateTmuxIdentity, cleanupPrivateTmux } from './helpers/private-tmux.js';

const exec = promisify(execFile);
let tmuxBinary;
// This opt-in integration uses POSIX sh jobs. Windows/MSYS2 needs a dedicated
// harness; neither an inherited TMUX nor a native absolute tmux.exe may select a server.
if (process.platform !== 'win32' && process.env.TMUX_AGENT_INTEGRATION === '1') {
  try { tmuxBinary = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional local integration */ }
}

it.skipIf(process.platform === 'win32' || process.env.TMUX_AGENT_INTEGRATION !== '1' || !tmuxBinary)('runs real persistent tmux jobs, preserves nonzero exit codes across plugin recreation and safely pastes literal text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-agent-'));
  const socket = join(dir, 'tmux.sock');
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const invoke = (args, options = {}) => exec(tmuxBinary, ['-S', socket, ...args], { ...options, timeout: 5000, env });
  const readIdentity = async () => parsePrivateTmuxIdentity((await invoke(['display-message', '-p', PRIVATE_TMUX_IDENTITY_FORMAT])).stdout, socket);
  let session, identity, primaryError;
  try {
    session = (await invoke(['-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-P', '-F', '#{session_id}', 'sh'])).stdout.trim();
    identity = await readIdentity();
    const executor = { tmuxBin: tmuxBinary, exec: (command, args, options) => {
      if (command === tmuxBinary) return invoke(args, options);
      if (command !== 'sh') throw new Error('Unexpected integration-test executable');
      return exec('/bin/sh', args, { ...options, timeout: 5000, env });
    } };
    const tmux = createTmuxApi(executor);
    const deps = { tmux, workspaceService: {}, jobDirectory: join(dir, 'jobs') };
    let plugin = createPlugin(deps);
    const result = await plugin.startCommand({ serverId: 'local', sessionId: session, command: "sleep 0.2; printf '%s\\n' 'hello 世界'; exit 7", cwd: dir });
    expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.paneId).toMatch(/^%/);
    plugin = createPlugin(deps);
    let job;
    for (let i = 0; i < 30; i++) {
      job = await plugin.getJob({ serverId: 'local', jobId: result.id });
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job.status).toBe('failed');
    expect(job.exitCode).toBe(7);
    expect(job.output).toContain('hello 世界');
    const running = await plugin.startCommand({ serverId: 'local', sessionId: session, command: 'sleep 30' });
    await new Promise((r) => setTimeout(r, 150));
    await invoke(['send-keys', '-t', running.paneId, 'C-c']);
    let cancelled;
    for (let i = 0; i < 30; i++) {
      cancelled = await plugin.getJob({ serverId: 'local', jobId: running.id });
      if (cancelled.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(cancelled.status).toBe('failed');
    expect(cancelled.exitCode).toBeGreaterThan(0);
    await plugin.send({ serverId: 'local', paneId: result.paneId, text: "literal $(echo unsafe) `whoami`", submit: false });
    const captured = await plugin.readPane({ serverId: 'local', paneId: result.paneId });
    expect(captured.content).toContain('literal $(echo unsafe) `whoami`');

    // Clear input in this test-owned pane, then assign a task to the shell as
    // a stand-in for a terminal agent. Echoed delivery must not count as a reply.
    await invoke(['send-keys', '-t', result.paneId, 'C-c']);
    await invoke(['send-keys', '-t', result.paneId, 'cat', 'Enter']);
    await new Promise((r) => setTimeout(r, 100));
    const task = await plugin.task({ serverId: 'local', paneId: result.paneId, prompt: 'test assignment' });
    const pending = await plugin.getJob({ serverId: 'local', jobId: task.id });
    expect(pending.status).toBe('waiting');
    await invoke(['send-keys', '-t', result.paneId, 'PANEL_TASK_DONE_' + task.id, 'Enter']);
    await new Promise((r) => setTimeout(r, 100));
    expect((await plugin.getJob({ serverId: 'local', jobId: task.id })).status).toBe('replied');
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupPrivateTmux({ dir, socket, identity, readIdentity, killServer: () => invoke(['kill-server']), primaryError });
  }
}, 15000);
