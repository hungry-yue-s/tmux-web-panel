// `ctx.api`: JSON requests to the panel.
//
// Every wait has a bound: reads give up after 45 s, writes after 5 minutes.
// Long transfers (uploads, downloads) do not go through here.

import { Service } from 'cordis';

export const READ_TIMEOUT_MS = 45_000;
export const WRITE_TIMEOUT_MS = 5 * 60_000;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export default class ApiService extends Service {
  constructor(ctx) {
    super(ctx, 'api');
  }

  async request(method, path, body) {
    const read = method === 'GET' || method === 'HEAD';
    const init = {
      method,
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(read ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new ApiError(0, 'TIMEOUT', '请求超时');
      throw new ApiError(0, 'NETWORK', '无法连接面板');
    }
    if (response.status === 204) return undefined;
    let data = null;
    try {
      data = await response.json();
    } catch {
      // A non-JSON body is reported by status below.
    }
    if (!response.ok) {
      throw new ApiError(response.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.message ?? `HTTP ${response.status}`);
    }
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }
  delete(path) { return this.request('DELETE', path); }
}
