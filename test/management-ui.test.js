import { it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

it('installs a plugin from the management page and protects conflicting skills', async () => {
  const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', url: 'http://localhost' });
  const win = dom.window;
  let installed = false;
  win.AppShell = { escape: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), toast: vi.fn() };
  win.Api = {
    get: vi.fn(async (path) => path === '/api/plugins' ? { plugins: [{ id: 'tmux-agent', name: 'Tmux Agent', version: '0.1.0', description: 'test', installed, enabled: installed }] } : {
      runtime: { path: '/managed/tmux', available: false },
      tmuxConfig: { path: '/managed/tmux.conf', content: 'set -g exit-empty off\n', backupDirectory: '/backups' },
      skills: [{ name: 'tmux-agent', target: 'codex', path: '/skills/tmux-agent', status: 'conflict' }],
    }),
    post: vi.fn(async () => { installed = true; return { installed: true }; }),
  };
  win.eval(readFileSync('public/js/management.js', 'utf8'));
  const root = win.document.getElementById('root');
  await win.ManagementPage.mount(root);
  expect(root.querySelector('[data-managed="skill-install"]').disabled).toBe(true);
  root.querySelector('[data-managed="plugin-install"]').click();
  await vi.waitFor(() => expect(root.querySelector('[data-managed="plugin-disable"]')).not.toBeNull());
  expect(win.Api.post).toHaveBeenCalledWith('/api/plugins/tmux-agent/install');
  expect(root.textContent).toContain('已启用');
  dom.window.close();
});
