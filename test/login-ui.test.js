import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync('public/login.html', 'utf8');
let win;
afterEach(() => win?.close());
function setup(fetch) {
  win = new JSDOM(html, { url: 'https://panel.example/login.html', runScripts: 'outside-only' }).window;
  win.fetch = fetch;
  for (const script of win.document.scripts) {
    if (!script.src) win.eval(script.textContent);
  }
  return win.document;
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
});
