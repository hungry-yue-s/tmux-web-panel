import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync('plugins/auth/client/login.html', 'utf8');
let win;
afterEach(() => win?.close());
function setup(fetch, { search = '', stored = {}, relay = '', blockedStorage = false } = {}) {
  win = new JSDOM(html, { url: 'https://panel.example/login.html' + search, runScripts: 'outside-only' }).window;
  for (const [key, value] of Object.entries(stored)) win.localStorage.setItem(key, value);
  if (blockedStorage) Object.defineProperty(win, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  win.PANEL_RELAY_PAGE = relay;
  win.__navigate = vi.fn();
  win.fetch = fetch;
  for (const script of win.document.scripts) {
    if (!script.src) win.eval(script.textContent
      .replace('window.location.replace(', 'window.__navigate(')
      .replaceAll("window.location.href = '/';", "window.__navigate('/');"));
  }
  return win.document;
}

function submitTrusted(doc) {
  doc.querySelector('#username').value = 'tester';
  doc.querySelector('#password').value = 'test-only-password';
  doc.querySelector('#trusted').checked = true;
  doc.querySelector('form').dispatchEvent(new win.Event('submit', { cancelable: true }));
}

describe('shared desktop and mobile login', () => {
  it('preserves the password, trust-device and optional TOTP request contract', async () => {
    let finish;
    const fetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const doc = setup(fetch);
    doc.querySelector('#username').value = 'tester';
    doc.querySelector('#password').value = 'test-only-password';
    doc.querySelector('#trusted').checked = true;
    doc.querySelector('#totp').value = '123456';
    doc.querySelector('form').dispatchEvent(new win.Event('submit', { cancelable: true }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ username: 'tester', password: 'test-only-password', trusted: true, totp: '123456' });
    expect(doc.querySelector('#login-btn').disabled).toBe(true);
    expect(doc.querySelector('form').getAttribute('aria-busy')).toBe('true');
    finish({ json: async () => ({ success: false, error: '验证码不正确' }) });
    await vi.waitFor(() => expect(doc.querySelector('#login-btn').disabled).toBe(false));
    expect(doc.querySelector('#login-error').textContent).toBe('验证码不正确');
    expect(doc.querySelector('#login-error').getAttribute('role')).toBe('alert');
  });

  it('recovers from network failure without losing typed credentials', async () => {
    const doc = setup(vi.fn().mockRejectedValue(new Error('offline')));
    doc.querySelector('#username').value = 'tester';
    doc.querySelector('form').dispatchEvent(new win.Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(doc.querySelector('#login-error').classList.contains('visible')).toBe(true));
    expect(doc.querySelector('#username').value).toBe('tester');
    expect(doc.querySelector('#login-btn').textContent).toBe('进入工作台');
    expect(doc.querySelector('[autofocus]')).toBeNull();
    expect(doc.querySelector('#password').autocomplete).toBe('current-password');
  });

  it.each([
    { search: '?relay=1&return=https://untrusted.invalid/', stored: {} },
    { search: '', stored: { tmux_relay_login: '1' } },
  ])('returns a trusted login to the configured relay after entry %j', async (entry) => {
    const token = 'fixture-new-trusted-session';
    const fetch = vi.fn(async () => ({ json: async () => ({ success: true, data: { token, trusted: true } }) }));
    const doc = setup(fetch, { ...entry, relay: 'https://relay.example/' });
    expect(win.localStorage.getItem('tmux_relay_login')).toBe('1');
    submitTrusted(doc);
    await vi.waitFor(() => expect(win.__navigate).toHaveBeenCalledOnce());
    expect(JSON.parse(fetch.mock.calls[0][1].body).trusted).toBe(true);
    expect(win.localStorage.getItem('tmux_auth_token')).toBe(token);
    const target = new URL(win.__navigate.mock.calls[0][0]);
    expect(target.origin).toBe('https://relay.example');
    expect(target.search).not.toContain(token);
    const fragment = new URLSearchParams(target.hash.slice(1));
    expect(fragment.get('store')).toBe(token);
    expect(fragment.get('return')).toBe('https://panel.example/');
  });

  it('keeps a direct login direct even when the deployment has a relay', async () => {
    const token = 'fixture-direct-session';
    const doc = setup(vi.fn(async () => ({ json: async () => ({ success: true, data: { token, trusted: true } }) })),
      { relay: 'https://relay.example/' });
    submitTrusted(doc);
    await vi.waitFor(() => expect(win.__navigate).toHaveBeenCalledWith('/'));
    expect(win.localStorage.getItem('tmux_relay_login')).toBeNull();
    expect(win.localStorage.getItem('tmux_auth_token')).toBe(token);
  });

  it('does not invent a relay destination when a remembered relay has no deployment configuration', async () => {
    const doc = setup(vi.fn(async () => ({ json: async () => ({ success: true, data: { token: 'fixture-session' } }) })),
      { stored: { tmux_relay_login: '1' } });
    submitTrusted(doc);
    await vi.waitFor(() => expect(win.__navigate).toHaveBeenCalledWith('/'));
  });

  it('keeps the login form usable when storage is blocked and does not claim a saved session', async () => {
    const fetch = vi.fn(async () => ({ json: async () => ({ success: true, data: { token: 'fixture-session' } }) }));
    let doc;
    expect(() => { doc = setup(fetch, { search: '?relay=1', relay: 'https://relay.example/', blockedStorage: true }); }).not.toThrow();
    submitTrusted(doc);
    await vi.waitFor(() => expect(doc.querySelector('#login-btn').disabled).toBe(false));
    expect(fetch).toHaveBeenCalledOnce();
    expect(doc.querySelector('#login-error').classList.contains('visible')).toBe(true);
    expect(doc.querySelector('#login-error').textContent).not.toBe('');
    expect(win.__navigate).not.toHaveBeenCalled();
  });
});
