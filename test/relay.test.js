import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync('relay/index.template.html', 'utf8');
const themeSource = readFileSync('public/js/theme.js', 'utf8');
const relaySource = readFileSync('relay/relay.js', 'utf8');
const authSource = readFileSync('public/js/auth.js', 'utf8');
let win;
afterEach(() => { win?.close(); vi.useRealTimers(); });

function setup({ search = '', hash = '', stored = {}, mobile = false, fetch, blockedStorage = false } = {}) {
  win = new JSDOM(html, { url: 'https://relay.example/' + search + hash, runScripts: 'outside-only' }).window;
  for (const [key, value] of Object.entries(stored)) win.localStorage.setItem(key, value);
  if (blockedStorage) Object.defineProperty(win, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  win.matchMedia = () => ({ matches: mobile });
  const scripts = [...win.document.scripts].filter(s => !s.src);
  win.eval(scripts[0].textContent);
  win.eval(themeSource);
  win.eval(scripts[1].textContent);
  win.PANEL_RELAY_CONFIG = { name: 'example.duckdns.org', port: 7681 };
  win.fetch = fetch || vi.fn(() => new Promise(() => {}));
  // Observe navigation without leaving jsdom or printing test token fragments.
  win.__navigate = vi.fn();
  win.eval(relaySource.replace('location.replace(target.href)', 'window.__navigate(target.href)'));
  return win;
}
const answer = (ip = '192.168.1.12') => ({ ok: true, json: async () => ({ Answer: [{ type: 1, data: ip }] }) });

describe('animated relay and client theme continuity', () => {
  it('uses every workspace palette directly and records later native theme changes', () => {
    setup();
    const themes = win.Theme.getThemeList();
    expect(themes.length).toBe(10);
    for (const theme of themes) {
      win.Theme.apply(theme.id);
      expect(win.localStorage.getItem('panel_relay_theme')).toBe(theme.id);
      expect(win.document.getElementById('theme-name').textContent).toBe(theme.name);
      expect(win.document.querySelector('meta[name="theme-color"]').content).toBe(theme.colors['--workspace-bg']);
    }
  });

  it.each([
    [{ mobile: true }, 'oyster'],
    [{ stored: { panel_relay_theme: 'forest-ink' } }, 'forest-ink'],
    [{ mobile: true, stored: { tmux_theme: 'deep-current', panel_relay_theme: 'oyster' } }, 'deep-current'],
    [{ search: '?theme=prism', stored: { tmux_theme: 'graphite' } }, 'prism'],
    [{ search: '?theme=catppuccin-mocha' }, 'prism'],
    [{ search: '?theme=unknown' }, 'tokyo-night'],
  ])('restores client preference %j as %s', (options, expected) => {
    setup(options);
    expect(win.document.documentElement.dataset.theme).toBe(expected);
  });

  it('preserves the palette through a fresh IP login without sending tokens to DNS', async () => {
    const fetch = vi.fn(async () => answer());
    setup({ mobile: true, fetch });
    await vi.waitFor(() => expect(win.__navigate).toHaveBeenCalledOnce());
    const target = new URL(win.__navigate.mock.calls[0][0]);
    expect(target.origin).toBe('https://192.168.1.12:7681');
    expect(target.pathname).toBe('/login.html');
    expect(Object.fromEntries(target.searchParams)).toEqual({ relay: '1', theme: 'oyster' });
    expect(win.document.body.dataset.state).toBe('ready');
    expect(win.document.getElementById('go').href).toBe(target.href);
    expect(fetch.mock.calls[0][0]).toBe('https://dns.alidns.com/resolve?name=example.duckdns.org&type=A');
  });

  it('hands off token and theme, then strips both from the panel address bar', async () => {
    const token = 'trusted+token /=';
    setup({ search: '?theme=forest-ink', stored: { panel_relay_token: token }, fetch: vi.fn(async () => answer()) });
    await vi.waitFor(() => expect(win.__navigate).toHaveBeenCalledOnce());
    const url = win.__navigate.mock.calls[0][0];
    expect(new URL(url).search).toBe('');
    const panel = new JSDOM('', { url, runScripts: 'outside-only' });
    try {
      panel.window.eval(authSource);
      panel.window.eval(themeSource);
      expect(panel.window.Auth.getToken()).toBe(token);
      expect(panel.window.Theme.getCurrent()).toBe('forest-ink');
      expect(panel.window.location.hash).toBe('');
    } finally { panel.window.close(); }
  });

  it('deposits login state and returns with the selected palette', () => {
    const params = new URLSearchParams({ store: 'test-session', return: 'https://192.168.1.15:7681/' });
    setup({ search: '?theme=github-light', hash: '#' + params });
    expect(win.fetch).not.toHaveBeenCalled();
    expect(win.localStorage.getItem('panel_relay_token')).toBe('test-session');
    expect(new URL(win.__navigate.mock.calls[0][0]).hash).toBe('#handoff=test-session&theme=github-light');
  });

  it('falls back on invalid DNS answers and exposes retry after both resolvers fail', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(answer('999.1.2.3')).mockRejectedValueOnce(new Error('offline'));
    setup({ fetch });
    await vi.waitFor(() => expect(win.document.body.dataset.state).toBe('failed'));
    expect(win.__navigate).not.toHaveBeenCalled();
    expect(win.document.getElementById('retry').hidden).toBe(false);
    fetch.mockResolvedValueOnce(answer());
    win.document.getElementById('retry').click();
    await vi.waitFor(() => expect(win.__navigate).toHaveBeenCalledOnce());
    expect(win.document.getElementById('retry').hidden).toBe(true);
  });

  it('bounds each DNS attempt so a stalled network can reach retry', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timeout')));
    }));
    setup({ fetch });
    await vi.advanceTimersByTimeAsync(10001);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(win.document.body.dataset.state).toBe('failed');
  });

  it('rejects unsafe deposit return schemes', () => {
    setup({ hash: '#' + new URLSearchParams({ store: 'test-session', return: 'javascript:alert(1)' }) });
    expect(win.document.body.dataset.state).toBe('failed');
    expect(win.__navigate).not.toHaveBeenCalled();
    expect(win.localStorage.getItem('panel_relay_token')).toBeNull();
  });

  it('adopts the relay palette on the login page before Theme loads', () => {
    const login = readFileSync('public/login.html', 'utf8');
    win = new JSDOM(login, { url: 'https://panel.example/login.html?relay=1&theme=oyster', runScripts: 'outside-only' }).window;
    win.eval([...win.document.scripts].find(s => !s.src).textContent);
    win.eval(themeSource);
    expect(win.Theme.getCurrent()).toBe('oyster');
  });

  it('can connect with the selected theme when storage is unavailable', async () => {
    setup({ search: '?theme=oyster', blockedStorage: true, fetch: vi.fn(async () => answer()) });
    await vi.waitFor(() => expect(win.__navigate).toHaveBeenCalledOnce());
    expect(new URL(win.__navigate.mock.calls[0][0]).searchParams.get('theme')).toBe('oyster');
  });

  it('still strips handoff fragments when storage is unavailable', () => {
    win = new JSDOM('', { url: 'https://panel.example/#handoff=test-session&theme=oyster', runScripts: 'outside-only' }).window;
    Object.defineProperty(win, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
    win.eval(authSource);
    expect(win.location.hash).toBe('');
  });
});
