(function (global) {
  var LOGIN_URL = '/login.html';

  class ApiError extends Error {
    constructor(info) {
      var meta = info || {};
      super(meta.message || 'Request failed');
      this.name = 'ApiError';
      this.code = meta.code || 'INTERNAL';
      this.retryable = meta.retryable === true;
      this.action = meta.action || 'none';
      this.status = typeof meta.status === 'number' ? meta.status : 0;
      if (meta.aborted) this.aborted = true;
      if (meta.requestId) this.requestId = meta.requestId;
    }
  }

  function fallbackCode(status) {
    return status ? 'HTTP_' + status : 'NETWORK_ERROR';
  }

  function fallbackMessage(status) {
    return status ? 'HTTP ' + status : 'Network error';
  }

  function requestIdOf(payload) {
    if (payload && payload.meta && payload.meta.requestId) return payload.meta.requestId;
    return undefined;
  }

  function normalizeError(payload, status) {
    var httpStatus = typeof status === 'number' ? status : 0;
    var raw = payload && typeof payload === 'object' ? payload.error : null;
    if (raw && typeof raw === 'object') {
      return {
        code: raw.code || fallbackCode(httpStatus),
        message: raw.message || fallbackMessage(httpStatus),
        retryable: raw.retryable === true,
        action: raw.action || 'none',
        status: httpStatus,
        requestId: requestIdOf(payload),
      };
    }
    if (typeof raw === 'string' && raw) {
      return {
        code: 'LEGACY_ERROR',
        message: raw,
        retryable: false,
        action: 'none',
        status: httpStatus,
        requestId: requestIdOf(payload),
      };
    }
    return {
      code: fallbackCode(httpStatus),
      message: fallbackMessage(httpStatus),
      // No status at all means the request never reached the server.
      retryable: httpStatus === 0,
      action: 'none',
      status: httpStatus,
      requestId: requestIdOf(payload),
    };
  }

  function authHeaders() {
    var auth = global && global.Auth;
    if (auth && typeof auth.headers === 'function') {
      try {
        return auth.headers() || {};
      } catch (_e) {
        return {};
      }
    }
    return {};
  }

  function handleUnauthorized() {
    var auth = global && global.Auth;
    if (!auth || typeof auth.clearToken !== 'function') return;
    try {
      auth.clearToken();
    } catch (_e) {}
    if (global && global.location) global.location.href = LOGIN_URL;
  }

  function getFetch() {
    if (global && typeof global.fetch === 'function') return global.fetch;
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  function readText(res) {
    if (!res || typeof res.text !== 'function') return Promise.resolve(null);
    return Promise.resolve()
      .then(function () {
        return res.text();
      })
      .catch(function () {
        return null;
      });
  }

  function readBody(res) {
    if (!res || typeof res.json !== 'function') return readText(res);
    return Promise.resolve()
      .then(function () {
        return res.json();
      })
      .catch(function () {
        return readText(res);
      });
  }

  function isOk(res) {
    if (!res) return false;
    if (res.ok !== undefined) return !!res.ok;
    return res.status >= 200 && res.status < 300;
  }

  function request(method, path, body, opts) {
    var options = opts || {};
    var headers = {};
    var auth = authHeaders();
    Object.keys(auth).forEach(function (k) {
      headers[k] = auth[k];
    });
    var init = { method: (method || 'GET').toUpperCase(), headers: headers };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (options.headers) {
      Object.keys(options.headers).forEach(function (k) {
        headers[k] = options.headers[k];
      });
    }
    if (options.signal) init.signal = options.signal;

    var doFetch = getFetch();
    if (!doFetch) {
      return Promise.reject(new ApiError({ code: 'NETWORK_ERROR', message: 'fetch is unavailable', status: 0 }));
    }

    return doFetch(path, init).then(function (res) {
      return readBody(res).then(function (payload) {
        var status = typeof res.status === 'number' ? res.status : 0;
        if (status === 401) {
          handleUnauthorized();
          throw new ApiError(normalizeError(payload, status));
        }
        var failed = !isOk(res) || (payload && typeof payload === 'object' && payload.success === false);
        if (failed) throw new ApiError(normalizeError(payload, status));
        if (payload && typeof payload === 'object' && 'success' in payload) return payload.data;
        return payload;
      });
    }, function (err) {
      // Only transport failures land here; response handling rejects separately.
      if (err instanceof ApiError) throw err;
      var aborted = Boolean(
        (err && err.name === 'AbortError') || (options.signal && options.signal.aborted),
      );
      if (aborted) {
        throw new ApiError({
          code: 'ABORTED',
          message: 'Request aborted',
          retryable: false,
          status: 0,
          aborted: true,
        });
      }
      throw new ApiError({
        code: 'NETWORK_ERROR',
        message: 'Network request failed',
        retryable: true,
        status: 0,
      });
    });
  }

  function get(path, opts) {
    return request('GET', path, null, opts);
  }

  function post(path, body, opts) {
    return request('POST', path, body, opts);
  }

  function patch(path, body, opts) {
    return request('PATCH', path, body, opts);
  }

  function put(path, body, opts) {
    return request('PUT', path, body, opts);
  }

  function del(path, opts) {
    return request('DELETE', path, null, opts);
  }

  function serverPath(serverId, suffix) {
    var id = serverId === undefined || serverId === null ? '' : String(serverId);
    return '/api/servers/' + encodeURIComponent(id) + (suffix || '');
  }

  function workspacePath(serverId) {
    return serverPath(serverId, '/workspace');
  }

  global.Api = {
    ApiError: ApiError,
    normalizeError: normalizeError,
    request: request,
    get: get,
    post: post,
    patch: patch,
    put: put,
    del: del,
    serverPath: serverPath,
    workspacePath: workspacePath,
  };
})(typeof window !== 'undefined' ? window : globalThis);
