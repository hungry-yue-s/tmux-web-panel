/**
 * Stable error codes and response envelopes for server-scoped APIs.
 *
 * Legacy endpoints answer with `error: string`; every endpoint added for
 * multi-server support answers with the structured shape below so the frontend
 * can pick a repair action without parsing prose.
 */

import { randomBytes } from 'node:crypto';

export const ErrorCode = Object.freeze({
  SERVER_NOT_FOUND: 'SERVER_NOT_FOUND',
  SERVER_IN_USE: 'SERVER_IN_USE',
  SERVER_OFFLINE: 'SERVER_OFFLINE',
  SERVER_DISABLED: 'SERVER_DISABLED',
  SERVER_EXISTS: 'SERVER_EXISTS',
  SERVER_IMMUTABLE: 'SERVER_IMMUTABLE',
  SSH_AUTH_REQUIRED: 'SSH_AUTH_REQUIRED',
  SSH_HOST_KEY_UNKNOWN: 'SSH_HOST_KEY_UNKNOWN',
  SSH_HOST_KEY_CHANGED: 'SSH_HOST_KEY_CHANGED',
  SSH_TIMEOUT: 'SSH_TIMEOUT',
  WORKSPACE_UNAVAILABLE: 'WORKSPACE_UNAVAILABLE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  WINDOW_NOT_FOUND: 'WINDOW_NOT_FOUND',
  PANE_NOT_FOUND: 'PANE_NOT_FOUND',
  PROVIDER_CHANGED: 'PROVIDER_CHANGED',
  CONNECTION_LIMIT: 'CONNECTION_LIMIT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNSUPPORTED: 'UNSUPPORTED',
  INTERNAL: 'INTERNAL',
});

const DEFAULTS = Object.freeze({
  [ErrorCode.SERVER_NOT_FOUND]: { status: 404, retryable: false, action: 'open_server_list' },
  [ErrorCode.SERVER_IN_USE]: { status: 409, retryable: false, action: 'confirm_force_close' },
  [ErrorCode.SERVER_OFFLINE]: { status: 503, retryable: true, action: 'retry_probe' },
  [ErrorCode.SERVER_DISABLED]: { status: 409, retryable: false, action: 'enable_server' },
  [ErrorCode.SERVER_EXISTS]: { status: 409, retryable: false, action: 'edit_connection' },
  [ErrorCode.SERVER_IMMUTABLE]: { status: 400, retryable: false, action: 'none' },
  [ErrorCode.SSH_AUTH_REQUIRED]: { status: 502, retryable: false, action: 'edit_connection' },
  [ErrorCode.SSH_HOST_KEY_UNKNOWN]: { status: 502, retryable: false, action: 'confirm_host_key' },
  [ErrorCode.SSH_HOST_KEY_CHANGED]: { status: 502, retryable: false, action: 'verify_host_key' },
  [ErrorCode.SSH_TIMEOUT]: { status: 504, retryable: true, action: 'retry_probe' },
  [ErrorCode.WORKSPACE_UNAVAILABLE]: { status: 409, retryable: true, action: 'retry_probe' },
  [ErrorCode.SESSION_NOT_FOUND]: { status: 404, retryable: false, action: 'refresh_workspace' },
  [ErrorCode.WINDOW_NOT_FOUND]: { status: 404, retryable: false, action: 'refresh_workspace' },
  [ErrorCode.PANE_NOT_FOUND]: { status: 404, retryable: false, action: 'refresh_workspace' },
  [ErrorCode.PROVIDER_CHANGED]: { status: 409, retryable: true, action: 'refresh_workspace' },
  [ErrorCode.CONNECTION_LIMIT]: { status: 429, retryable: true, action: 'close_other_clients' },
  [ErrorCode.VALIDATION_ERROR]: { status: 400, retryable: false, action: 'fix_input' },
  [ErrorCode.UNSUPPORTED]: { status: 501, retryable: false, action: 'none' },
  [ErrorCode.INTERNAL]: { status: 500, retryable: true, action: 'retry' },
});

export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    const preset = DEFAULTS[code] || DEFAULTS[ErrorCode.INTERNAL];
    this.name = 'AppError';
    this.code = ErrorCode[code] ? code : ErrorCode.INTERNAL;
    this.status = options.status || preset.status;
    this.retryable = options.retryable === undefined ? preset.retryable : options.retryable;
    this.action = options.action || preset.action;
    if (options.details) this.details = options.details;
  }

  toJSON() {
    const out = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      action: this.action,
    };
    if (this.details) out.details = this.details;
    return out;
  }
}

export function newRequestId() {
  return 'req_' + randomBytes(8).toString('hex');
}

export function ok(data, requestId = newRequestId()) {
  return { success: true, data: data === undefined ? null : data, error: null, meta: { requestId } };
}

export function fail(error, requestId = newRequestId()) {
  const appError = error instanceof AppError
    ? error
    : new AppError(ErrorCode.INTERNAL, (error && error.message) || 'Internal error');
  return { success: false, data: null, error: appError.toJSON(), meta: { requestId } };
}

/**
 * Express handler wrapper: sends the structured envelope for AppError and keeps
 * unexpected failures from leaking stack traces or connection secrets.
 */
export function handle(fn) {
  return async (req, res) => {
    const requestId = newRequestId();
    try {
      const data = await fn(req, res, requestId);
      if (res.headersSent) return;
      res.json(ok(data, requestId));
    } catch (err) {
      if (res.headersSent) return;
      const appError = err instanceof AppError
        ? err
        : new AppError(ErrorCode.INTERNAL, 'Internal error');
      res.status(appError.status).json(fail(appError, requestId));
    }
  };
}
