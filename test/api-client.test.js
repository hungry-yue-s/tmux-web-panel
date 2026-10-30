import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../public/js/api.js', import.meta.url), 'utf8');
const TOKEN = 'super-secret-token-value';

function jsonResponse(status, body, ok) {
  return {
    ok: ok === undefined ? status >= 200 && status < 300 : ok,
    status,
    json: async () => body,
  };
}

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('Unexpected token < in JSON');
    },
    text: async () => text,
  };
}

function loadApi(opts) {
  const options = opts || {};
  const win = {
    location: { href: 'http://localhost/index.html' },
    fetch: vi.fn(),
  };
  if (options.auth !== false) {
    win.Auth = {
      clearToken: vi.fn(),
      headers: () => ({ Authorization: 'Bearer ' + TOKEN }),
    };
  }
  new Function('window', SRC)(win);
  return { Api: win.Api, win, fetchMock: win.fetch };
}

describe('Api.request unwrapping', () => {
  it('resolves the data field of a legacy success envelope', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { sessions: ['a'] }, error: null }));
    await expect(Api.get('/api/sessions')).resolves.toEqual({ sessions: ['a'] });
  });

  it('resolves the data field of a new envelope with meta', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(200, {
      success: true,
      data: { id: 'prod' },
      error: null,
      meta: { requestId: 'req_1' },
    }));
    await expect(Api.get('/api/servers/prod')).resolves.toEqual({ id: 'prod' });
  });

  it('resolves null data without throwing', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: null, error: null }));
    await expect(Api.del('/api/servers/prod')).resolves.toBeNull();
  });

  it('resolves the whole body when there is no success key', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(200, { windows: [1, 2], total: 2 }));
    await expect(Api.get('/api/windows')).resolves.toEqual({ windows: [1, 2], total: 2 });
  });
});

describe('Api verbs and headers', () => {
  it('sends the auth header and no content type for GET', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: 1, error: null }));
    await Api.get('/api/x');
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/x');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('serializes a JSON body with a content type', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: 1, error: null }));
    await Api.post('/api/servers', { name: 'prod' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"name":"prod"}');
  });

  it('maps the convenience methods to HTTP verbs', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: 1, error: null }));
    await Api.patch('/api/x', { a: 1 });
    await Api.put('/api/x', { a: 1 });
    await Api.del('/api/x');
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['PATCH', 'PUT', 'DELETE']);
  });

  it('works without a global Auth', async () => {
    const { Api, fetchMock } = loadApi({ auth: false });
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: 'ok', error: null }));
    await expect(Api.get('/api/x')).resolves.toBe('ok');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({});
  });
});

describe('Api error normalization', () => {
  it('turns a legacy string error into LEGACY_ERROR', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(400, { success: false, data: null, error: 'session not found' }));
    const err = await Api.get('/api/sessions').catch((e) => e);
    expect(err).toBeInstanceOf(Api.ApiError);
    expect(err.code).toBe('LEGACY_ERROR');
    expect(err.message).toBe('session not found');
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.action).toBe('none');
  });

  it('preserves code, retryable and action from a structured error', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(503, {
      success: false,
      data: null,
      error: { code: 'SERVER_OFFLINE', message: 'prod is offline', retryable: true, action: 'retry_probe' },
      meta: { requestId: 'req_42' },
    }));
    const err = await Api.get('/api/servers/prod/workspace').catch((e) => e);
    expect(err.code).toBe('SERVER_OFFLINE');
    expect(err.message).toBe('prod is offline');
    expect(err.retryable).toBe(true);
    expect(err.action).toBe('retry_probe');
    expect(err.status).toBe(503);
    expect(err.requestId).toBe('req_42');
  });

  it('rejects on success:false even with a 200 status', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(200, {
      success: false,
      data: null,
      error: { code: 'VALIDATION_ERROR', message: 'bad host', retryable: false, action: 'fix_input' },
    }));
    const err = await Api.post('/api/servers', {}).catch((e) => e);
    expect(err).toBeInstanceOf(Api.ApiError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.status).toBe(200);
  });

  it('falls back to HTTP_<status> for a non-JSON error body', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(textResponse(500, '<html>Internal Server Error</html>'));
    const err = await Api.get('/api/x').catch((e) => e);
    expect(err.code).toBe('HTTP_500');
    expect(err.status).toBe(500);
    expect(err.message).toBe('HTTP 500');
  });

  it('falls back to HTTP_<status> for an empty error body', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(502, null));
    const err = await Api.get('/api/x').catch((e) => e);
    expect(err.code).toBe('HTTP_502');
  });

  it('normalizeError is exported and pure', () => {
    const { Api } = loadApi();
    expect(Api.normalizeError({ error: 'boom' }, 409)).toEqual({
      code: 'LEGACY_ERROR',
      message: 'boom',
      retryable: false,
      action: 'none',
      status: 409,
      requestId: undefined,
    });
    expect(Api.normalizeError(null, 404)).toEqual({
      code: 'HTTP_404',
      message: 'HTTP 404',
      retryable: false,
      action: 'none',
      status: 404,
      requestId: undefined,
    });
    expect(Api.normalizeError(null, 0).code).toBe('NETWORK_ERROR');
  });
});

describe('Api 401 handling', () => {
  it('clears the token, redirects and still rejects', async () => {
    const { Api, win, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(401, { success: false, data: null, error: 'unauthorized' }));
    const err = await Api.get('/api/x').catch((e) => e);
    expect(win.Auth.clearToken).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe('/login.html');
    expect(err).toBeInstanceOf(Api.ApiError);
    expect(err.status).toBe(401);
  });

  it('does not blow up on 401 when Auth is missing', async () => {
    const { Api, win, fetchMock } = loadApi({ auth: false });
    fetchMock.mockResolvedValue(jsonResponse(401, null));
    const err = await Api.get('/api/x').catch((e) => e);
    expect(err).toBeInstanceOf(Api.ApiError);
    expect(err.code).toBe('HTTP_401');
    expect(win.location.href).toBe('http://localhost/index.html');
  });
});

describe('Api never leaks the auth token', () => {
  it('keeps the token out of thrown errors', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue(jsonResponse(500, {
      success: false,
      data: null,
      error: { code: 'INTERNAL', message: 'Internal error', retryable: true, action: 'retry' },
    }));
    const err = await Api.get('/api/x').catch((e) => e);
    const dumped = [err.message, err.stack || '', JSON.stringify({ ...err })].join('|');
    expect(dumped).not.toContain(TOKEN);
  });

  it('keeps the token out of a rejected fetch path', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockRejectedValue(new Error('network down'));
    const err = await Api.get('/api/x').catch((e) => e);
    const dumped = [err.message, err.stack || '', JSON.stringify({ ...err })].join('|');
    expect(dumped).not.toContain(TOKEN);
  });
});

describe('Api transport failures', () => {
  it('normalizes a network failure instead of leaking a browser TypeError', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const err = await Api.get('/api/x').catch((e) => e);

    expect(err).toBeInstanceOf(Api.ApiError);
    expect(err.name).toBe('ApiError');
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(0);
    expect(err.aborted).toBeUndefined();
  });

  it('marks an aborted request distinctly so it is not shown as a failure', async () => {
    const { Api, fetchMock } = loadApi();
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValue(abortError);

    const err = await Api.get('/api/x').catch((e) => e);

    expect(err.code).toBe('ABORTED');
    expect(err.aborted).toBe(true);
    expect(err.retryable).toBe(false);
  });

  describe('time limits', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    /** A fetch that never answers, and fails as a browser does once aborted. */
    function hanging(fetchMock) {
      fetchMock.mockImplementation((_path, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }));
    }

    it('fails a read that never answers instead of hanging', async () => {
      const { Api, fetchMock } = loadApi();
      hanging(fetchMock);
      const result = Api.get('/api/x').catch((e) => e);
      await vi.advanceTimersByTimeAsync(45000);
      const err = await result;
      expect(err).toMatchObject({ code: 'TIMEOUT', retryable: true, status: 0 });
    });

    it('gives writes far longer, as some are slow before they answer', async () => {
      const { Api, fetchMock } = loadApi();
      hanging(fetchMock);
      let settled = false;
      const result = Api.post('/api/git/commit-message', {}).catch((e) => { settled = true; return e; });
      await vi.advanceTimersByTimeAsync(60000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(240000);
      expect((await result).code).toBe('TIMEOUT');
    });

    it('takes a limit from the caller, and none when asked', async () => {
      const { Api, fetchMock } = loadApi();
      hanging(fetchMock);
      const short = Api.get('/api/x', { timeout: 100 }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(100);
      expect((await short).code).toBe('TIMEOUT');

      fetchMock.mockImplementation(() => new Promise(() => {}));
      let settled = false;
      Api.get('/api/long', { timeout: 0 }).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(600000);
      expect(settled).toBe(false);
      expect(fetchMock.mock.calls.at(-1)[1].signal).toBeUndefined();
    });

    it('fails when the body stalls after the headers, not with an empty success', async () => {
      const { Api, fetchMock } = loadApi();
      fetchMock.mockImplementation((_path, init) => Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
        text: async () => { throw new Error('aborted'); },
      }));
      const result = Api.get('/api/x').catch((e) => e);
      await vi.advanceTimersByTimeAsync(45000);
      expect((await result).code).toBe('TIMEOUT');
    });

    it('leaves nothing running once answered', async () => {
      const { Api, fetchMock } = loadApi();
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: 1 }) });
      await Api.get('/api/x');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('still reports the caller cancelling as an abort, not a timeout', async () => {
      const { Api, fetchMock } = loadApi();
      hanging(fetchMock);
      const controller = new AbortController();
      const result = Api.get('/api/x', { signal: controller.signal }).catch((e) => e);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect((await result).code).toBe('ABORTED');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('treats an aborted signal as an abort even without AbortError', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockRejectedValue(new Error('cancelled'));

    const err = await Api.get('/api/x', { signal: { aborted: true } }).catch((e) => e);

    expect(err.code).toBe('ABORTED');
  });

  it('does not mislabel a parse failure on a real response as a network error', async () => {
    const { Api, fetchMock } = loadApi();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error('not json'); },
      text: async () => 'Internal Server Error',
    });

    const err = await Api.get('/api/x').catch((e) => e);

    expect(err.status).toBe(500);
    expect(err.code).toBe('HTTP_500');
  });
});

describe('Api path builders', () => {
  it('encodes server ids', () => {
    const { Api } = loadApi();
    expect(Api.serverPath('local')).toBe('/api/servers/local');
    expect(Api.serverPath('%12')).toBe('/api/servers/%2512');
    expect(Api.serverPath('$3')).toBe('/api/servers/%243');
    expect(Api.serverPath('a b@c')).toBe('/api/servers/a%20b%40c');
  });

  it('appends the suffix verbatim', () => {
    const { Api } = loadApi();
    expect(Api.serverPath('prod', '/health')).toBe('/api/servers/prod/health');
    expect(Api.serverPath('prod')).toBe('/api/servers/prod');
  });

  it('addresses another machine through the /n/:serverId relay and keeps local paths', () => {
    const { Api } = loadApi();
    expect(Api.nodeUrl('local', '/api/files/list')).toBe('/api/files/list');
    expect(Api.nodeUrl(null, '/api/status')).toBe('/api/status');
    expect(Api.nodeUrl('win box', '/ws/status')).toBe('/n/win%20box/ws/status');
    expect(Api.workspaceUrl('prod')).toBe('/n/prod/api/workspace');
    expect(Api.workspaceUrl('local', '/windows/%405/panes')).toBe('/api/workspace/windows/%405/panes');
  });

  it('routes machine paths to the server in view but never hub paths', () => {
    const { Api, win } = loadApi();
    win.TerminalTarget = { serverId: 'prod' };
    expect(Api.activeServerId()).toBe('prod');
    expect(Api.activeUrl('/api/files/raw?path=%2Ftmp')).toBe('/n/prod/api/files/raw?path=%2Ftmp');
    expect(Api.activeUrl('/ws/status')).toBe('/n/prod/ws/status');
    for (const hub of ['/api/auth/logout', '/api/servers', '/api/servers/prod/probe', '/api/plugins', '/api/managed-resources', '/api/share?x=1']) {
      expect(Api.activeUrl(hub)).toBe(hub);
    }
    // Already relayed or not an API path: untouched.
    expect(Api.activeUrl('/n/prod/api/workspace')).toBe('/n/prod/api/workspace');
    expect(Api.activeUrl('/login.html')).toBe('/login.html');
    win.TerminalTarget = { serverId: 'local' };
    expect(Api.activeUrl('/api/files/list')).toBe('/api/files/list');
  });

  it('has no server-scoped workspace path any more', () => {
    const { Api } = loadApi();
    expect(Api.workspacePath).toBeUndefined();
  });
});
