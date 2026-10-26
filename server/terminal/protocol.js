/**
 * Terminal WebSocket protocol.
 *
 * The socket URL carries only a paneId, which is verified against tmux before
 * attaching; a client can never supply a host, user, key path or command.
 */

const PANE_ID_MAX = 64;
/** Above this a "terminal" size is a bug or an attack, not a window. */
export const MAX_DIMENSION = 2000;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
/** One keystroke burst or paste; anything larger is abuse, not typing. */
export const MAX_INPUT_BYTES = 64 * 1024;

/** Query keys a client is allowed to influence. Anything else is ignored. */
export const ALLOWED_QUERY_KEYS = Object.freeze(['cols', 'rows', 'nozoom', 'token']);

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding must not throw out of the upgrade handler.
    return null;
  }
}

/**
 * Parses `/ws/terminal/:paneId`. Returns null for anything unparseable rather
 * than throwing, so a bad URL closes one socket instead of taking down the
 * upgrade listener.
 */
export function parseTerminalPath(pathname) {
  if (typeof pathname !== 'string') return null;
  const prefix = '/ws/terminal/';
  if (!pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length);
  if (!segment || segment.includes('/')) return null;
  const paneId = safeDecode(segment);
  // Control characters have no place in an id and would corrupt logs.
  if (paneId === null || paneId.length === 0 || paneId.length > PANE_ID_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(paneId)) return null;
  return { paneId };
}

export function clampDimension(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  // Number is strict where parseInt would accept "80junk".
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (parsed < 1) return fallback;
  return Math.min(parsed, MAX_DIMENSION);
}

/** Reads only the dimension/zoom hints from the query string. */
export function parseTerminalQuery(searchParams) {
  const get = (key) => (searchParams && typeof searchParams.get === 'function' ? searchParams.get(key) : null);
  return {
    cols: clampDimension(get('cols'), DEFAULT_COLS),
    rows: clampDimension(get('rows'), DEFAULT_ROWS),
    nozoom: get('nozoom') === '1',
  };
}

/**
 * Validates one client frame. Unknown types and malformed payloads are dropped
 * rather than partially applied.
 */
export function parseClientMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'input') {
    if (typeof msg.data !== 'string') return null;
    if (Buffer.byteLength(msg.data, 'utf8') > MAX_INPUT_BYTES) return null;
    return { type: 'input', data: msg.data };
  }
  if (msg.type === 'resize') {
    if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows)) return null;
    if (msg.cols < 1 || msg.rows < 1 || msg.cols > MAX_DIMENSION || msg.rows > MAX_DIMENSION) return null;
    const focusEpoch = Number.isInteger(msg.focusEpoch) ? msg.focusEpoch : null;
    return { type: 'resize', cols: msg.cols, rows: msg.rows, focusEpoch };
  }
  if (msg.type === 'focus') {
    return Number.isInteger(msg.focusEpoch) ? { type: 'focus', focusEpoch: msg.focusEpoch } : null;
  }
  return null;
}

export const ServerMessage = {
  ready({ paneId, provider, persistence }) {
    return JSON.stringify({ type: 'ready', paneId, provider, persistence });
  },
  output(data) {
    return JSON.stringify({ type: 'output', data });
  },
  clipboard(data) {
    return JSON.stringify({ type: 'clipboard', data });
  },
  error({ code, message, retryable = false }) {
    return JSON.stringify({ type: 'error', code, message, retryable });
  },
  exit({ code = null, signal = null, reason = null }) {
    return JSON.stringify({ type: 'exit', code, signal, reason });
  },
};
