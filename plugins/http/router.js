// Route matching and the small set of HTTP helpers every route needs.

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code machine-readable, e.g. VALIDATION_ERROR
   * @param {string} message safe to show to the user
   * @param {object} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `/api/panes/:paneId` → named parameter; a trailing `/*` matches the rest of
 * the path (also nothing) as `params['*']`.
 */
export function compilePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`route path must start with "/": ${path}`);
  if (path === '/') return { keys: [], regex: /^\/$/, wildcard: false };
  const keys = [];
  let source = '';
  const segments = path.split('/').slice(1);
  segments.forEach((segment, index) => {
    if (segment === '*' && index === segments.length - 1) {
      keys.push('*');
      source += '(?:/(.*))?';
    } else if (segment.startsWith(':')) {
      keys.push(segment.slice(1));
      source += '/([^/]+)';
    } else {
      source += '/' + escapeRegExp(segment);
    }
  });
  return { keys, regex: new RegExp(`^${source}/?$`), wildcard: keys.includes('*') };
}

/** Params of a match, or null. Undecodable escapes are a 400, not a 500. */
export function matchPath(route, pathname) {
  const match = route.regex.exec(pathname);
  if (!match) return null;
  const params = {};
  route.keys.forEach((key, index) => {
    const raw = match[index + 1] ?? '';
    try {
      params[key] = decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, 'BAD_REQUEST', 'Malformed path');
    }
  });
  return params;
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

export function sendError(res, error) {
  sendJson(res, error.status, { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
}

/** Reads a JSON request body of at most `limit` bytes. */
export function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(type)) {
      reject(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
      } catch {
        reject(new HttpError(400, 'BAD_REQUEST', 'Malformed JSON'));
      }
    });
    req.on('error', reject);
  });
}
