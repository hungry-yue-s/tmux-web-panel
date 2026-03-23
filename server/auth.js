/**
 * HTTP Basic Authentication middleware and WebSocket auth helper.
 *
 * Parses `Authorization: Basic <base64>` headers and compares
 * against a configured user:pass string.
 */

/**
 * Decodes a Basic auth header value and returns { user, pass } or null.
 * @param {string|undefined} header - The Authorization header value
 * @returns {{ user: string, pass: string } | null}
 */
function parseBasicAuth(header) {
  if (!header || typeof header !== 'string') return null;

  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Basic') return null;

  const decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
  const colonIndex = decoded.indexOf(':');
  if (colonIndex === -1) return null;

  return {
    user: decoded.slice(0, colonIndex),
    pass: decoded.slice(colonIndex + 1),
  };
}

/**
 * Returns an Express middleware that enforces HTTP Basic auth.
 * Responds with 401 + WWW-Authenticate header on failure.
 *
 * @param {string} user - Expected username
 * @param {string} pass - Expected password
 * @returns {import('express').RequestHandler}
 */
export function httpAuth(user, pass) {
  return (req, res, next) => {
    const credentials = parseBasicAuth(req.headers.authorization);

    if (
      credentials &&
      credentials.user === user &&
      credentials.pass === pass
    ) {
      next();
      return;
    }

    res.set('WWW-Authenticate', 'Basic realm="tmux-web-panel"');
    res.status(401).json({
      success: false,
      data: null,
      error: 'Authentication required',
    });
  };
}

/**
 * Validates WebSocket upgrade request credentials.
 *
 * @param {string} user - Expected username
 * @param {string} pass - Expected password
 * @param {import('http').IncomingMessage} req - The upgrade request
 * @returns {boolean} true if authenticated
 */
export function wsAuth(user, pass, req) {
  const credentials = parseBasicAuth(req.headers.authorization);

  if (
    credentials &&
    credentials.user === user &&
    credentials.pass === pass
  ) {
    return true;
  }

  return false;
}
