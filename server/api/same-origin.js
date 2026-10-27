/**
 * Rejects credentialed cross-origin writes. The panel authenticates with a
 * bearer token, so this is defence in depth rather than the only control.
 */
export function requireSameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost && originHost === req.get('host')) return next();
  res.status(403).json({
    success: false,
    data: null,
    error: {
      code: 'FORBIDDEN_ORIGIN',
      message: 'Cross-origin request rejected',
      retryable: false,
      action: 'none',
    },
    meta: { requestId: null },
  });
  return undefined;
}
