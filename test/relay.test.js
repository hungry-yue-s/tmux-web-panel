import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync('relay/index.template.html', 'utf8');
const themeSource = readFileSync('public/js/theme.js', 'utf8');
const relaySource = readFileSync('relay/relay.js', 'utf8');
const authSource = readFileSync('public/js/auth.js', 'utf8');
const apiSource = readFileSync('public/js/api.js', 'utf8');
const loginHtml = readFileSync('public/login.html', 'utf8');
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
const storageOf = (page) => Object.fromEntries(Array.from({ length: page.localStorage.length }, (_, i) => {
  const key = page.localStorage.key(i);
  return [key, page.localStorage.getItem(key)];
}));

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
    expect(new URLSearchParams(new URL(url).hash.slice(1)).get('relay')).toBe('1');
    const panel = new JSDOM('', { url, runScripts: 'outside-only' });
    try {
      panel.window.eval(authSource);
      panel.window.eval(themeSource);
      expect(panel.window.Auth.getToken()).toBe(token);
      expect(panel.window.localStorage.getItem('tmux_relay_login')).toBe('1');
      expect(panel.window.Theme.getCurrent()).toBe('forest-ink');
      expect(panel.window.location.hash).toBe('');
    } finally { panel.window.close(); }
  });

  it('deposits login state and returns with the selected palette', () => {
    const params = new URLSearchParams({ store: 'test-session', return: 'https://192.168.1.15:7681/' });
    setup({ search: '?theme=github-light', hash: '#' + params });
    expect(win.fetch).not.toHaveBeenCalled();
    expect(win.localStorage.getItem('panel_relay_token')).toBe('test-session');
    const fragment = new URLSearchParams(new URL(win.__navigate.mock.calls[0][0]).hash.slice(1));
    expect(Object.fromEntries(fragment)).toEqual({ handoff: 'test-session', theme: 'github-light', relay: '1' });
  });

  it.each(['marked handoff', 'legacy Android handoff'])(
    'renews an expired relay session through trusted login and a cold start: %s', async (entry) => {
      const oldToken = 'fixture-expired-session';
      const newToken = 'fixture-new-trusted-session';
      const pages = [];
      try {
        const initial = setup({ stored: { panel_relay_token: oldToken }, fetch: vi.fn(async () => answer()) });
        pages.push(initial);
        await vi.waitFor(() => expect(initial.__navigate).toHaveBeenCalledOnce());
        const target = new URL(initial.__navigate.mock.calls[0][0]);
        if (entry === 'legacy Android handoff') {
          const fragment = new URLSearchParams(target.hash.slice(1));
          fragment.delete('relay');
          target.hash = fragment.toString();
        }
        const panel = new JSDOM('', { url: target.href, runScripts: 'outside-only' }).window;
        pages.push(panel);
        if (entry === 'legacy Android handoff') Object.defineProperty(panel.navigator, 'userAgent', {
          value: 'Mozilla/5.0 Android TmuxPanelAndroid/1.0', configurable: true,
        });
        panel.eval(authSource);
        expect(panel.Auth.getToken()).toBe(oldToken);
        expect(panel.localStorage.getItem('tmux_relay_login')).toBe('1');

        // The real API handler clears an expired session and goes to bare login.
        // Keep its redirect in memory, without reading or printing real credentials.
        const apiWindow = {
          Auth: panel.Auth, location: { href: target.origin + '/' },
          fetch: vi.fn(async () => ({ status: 401, ok: false,
            json: async () => ({ success: false, error: 'Authentication required' }) })),
        };
        new Function('window', apiSource)(apiWindow);
        await expect(apiWindow.Api.get('/api/servers')).rejects.toMatchObject({ status: 401 });
        expect(panel.Auth.getToken()).toBeNull();
        expect(panel.localStorage.getItem('tmux_relay_login')).toBe('1');

        const loginUrl = new URL(apiWindow.location.href, target.origin);
        expect(loginUrl.searchParams.has('relay')).toBe(false);
        const login = new JSDOM(loginHtml, { url: loginUrl.href, runScripts: 'outside-only' }).window;
        pages.push(login);
        for (const [key, value] of Object.entries(storageOf(panel))) login.localStorage.setItem(key, value);
        login.PANEL_RELAY_PAGE = 'https://relay.example/';
        login.__navigate = vi.fn();
        login.fetch = vi.fn(async () => ({ json: async () => ({ success: true, data: { token: newToken, trusted: true } }) }));
        for (const script of login.document.scripts) {
          if (!script.src) login.eval(script.textContent
            .replace('window.location.replace(', 'window.__navigate(')
            .replaceAll("window.location.href = '/';", "window.__navigate('/');"));
        }
        login.document.querySelector('#username').value = 'tester';
        login.document.querySelector('#password').value = 'test-only-password';
        login.document.querySelector('#trusted').checked = true;
        login.document.querySelector('form').dispatchEvent(new login.Event('submit', { cancelable: true }));
        await vi.waitFor(() => expect(login.__navigate).toHaveBeenCalledOnce());
        expect(JSON.parse(login.fetch.mock.calls[0][1].body).trusted).toBe(true);
        expect(login.localStorage.getItem('tmux_auth_token')).toBe(newToken);
        const depositUrl = new URL(login.__navigate.mock.calls[0][0]);
        expect(depositUrl.origin).toBe('https://relay.example');
        expect(depositUrl.search).not.toContain(newToken);

        const deposit = setup({ search: depositUrl.search, hash: depositUrl.hash, stored: storageOf(initial) });
        pages.push(deposit);
        expect(deposit.localStorage.getItem('panel_relay_token')).toBe(newToken);
        const cold = setup({ stored: storageOf(deposit), fetch: vi.fn(async () => answer('192.168.1.13')) });
        pages.push(cold);
        await vi.waitFor(() => expect(cold.__navigate).toHaveBeenCalledOnce());
        const coldUrl = cold.__navigate.mock.calls[0][0];
        expect(new URL(coldUrl).origin).toBe('https://192.168.1.13:7681');
        const reopened = new JSDOM('', { url: coldUrl, runScripts: 'outside-only' }).window;
        pages.push(reopened);
        expect(reopened.localStorage.getItem('tmux_auth_token')).toBeNull();
        reopened.eval(authSource);
        expect(reopened.Auth.getToken()).toBe(newToken);
        expect(reopened.localStorage.getItem('tmux_relay_login')).toBe('1');
        expect(reopened.location.hash).toBe('');
      } finally { pages.forEach(page => page.close()); }
    },
  );

  it.each(['Mozilla/5.0 browser', 'Mozilla/5.0 TmuxPanelMac/1.0'])(
    'does not mistake a plain handoff for relay entry in %s', (userAgent) => {
      win = new JSDOM('', { url: 'https://panel.example/#handoff=fixture-session', runScripts: 'outside-only' }).window;
      Object.defineProperty(win.navigator, 'userAgent', { value: userAgent, configurable: true });
      win.eval(authSource);
      expect(win.Auth.getToken()).toBe('fixture-session');
      expect(win.localStorage.getItem('tmux_relay_login')).toBeNull();
      expect(win.location.hash).toBe('');
    },
  );

  it('does not mark a legacy Android page without a handoff as relay entry', () => {
    win = new JSDOM('', { url: 'https://panel.example/', runScripts: 'outside-only' }).window;
    Object.defineProperty(win.navigator, 'userAgent', { value: 'TmuxPanelAndroid/1.0', configurable: true });
    win.eval(authSource);
    expect(win.localStorage.getItem('tmux_relay_login')).toBeNull();
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

  it('can return a deposit safely when relay storage is blocked', () => {
    const token = 'fixture-session';
    setup({ blockedStorage: true, hash: '#' + new URLSearchParams({ store: token, return: 'https://panel.example/' }) });
    expect(win.fetch).not.toHaveBeenCalled();
    const target = new URL(win.__navigate.mock.calls[0][0]);
    expect(target.origin).toBe('https://panel.example');
    expect(target.search).toBe('');
    expect(Object.fromEntries(new URLSearchParams(target.hash.slice(1))))
      .toMatchObject({ handoff: token, relay: '1' });
  });

  it('still strips handoff fragments when storage is unavailable', () => {
    win = new JSDOM('', { url: 'https://panel.example/#handoff=test-session&theme=oyster&relay=1', runScripts: 'outside-only' }).window;
    Object.defineProperty(win, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
    win.eval(authSource);
    expect(win.location.hash).toBe('');
  });
});
