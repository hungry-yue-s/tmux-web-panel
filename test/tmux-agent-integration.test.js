import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTmuxApi } from '../server/tmux.js';
import { createPlugin } from '../plugins/tmux-agent/server.mjs';

const exec = promisify(execFile);

it.skipIf(process.env.TMUX_AGENT_INTEGRATION !== '1')('runs real persistent tmux jobs, preserves nonzero exit codes across plugin recreation and safely pastes literal text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panel-agent-'));
  const socket = join(dir, 'tmux.sock');
  const invoke = (args) => exec('tmux', ['-S', socket, ...args], { timeout: 5000 });
  let session;
  try {
    session = (await invoke(['-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-P', '-F', '#{session_id}', 'sh'])).stdout.trim();
    const executor = { exec: (command, args, options) => exec(command, command === 'tmux' ? ['-S', socket, ...args] : args, { timeout: 5000, ...options }) };
    const tmux = createTmuxApi(executor);
    const deps = { executorPool: { tmuxFor: () => tmux }, workspaceService: { getProvider: async () => ({ provider: 'tmux' }) }, jobDirectory: join(dir, 'jobs') };
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
  } finally {
    if (session) await invoke(['kill-session', '-t', session]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
