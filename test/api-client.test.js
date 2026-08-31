import { describe, it, expect, vi } from 'vitest';
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

  it('builds the workspace path', () => {
    const { Api } = loadApi();
    expect(Api.workspacePath('prod')).toBe('/api/servers/prod/workspace');
    expect(Api.workspacePath('%12')).toBe('/api/servers/%2512/workspace');
  });
});
