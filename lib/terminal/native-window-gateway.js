import { ControlGateway } from './control-gateway.js';
import { AppError, ErrorCode } from '../servers/errors.js';
import { validateNativeTarget } from './native-window-pool.js';

export function parseNativeWindowTarget(pathname, query) {
  const invalid = () => new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid native window address');
  const match = /^\/ws\/native-window\/([^/]+)$/.exec(pathname);
  let windowId;
  try { windowId = match && decodeURIComponent(match[1]); } catch { throw invalid(); }
  const instanceId = query.get('instanceId'), sessionId = query.get('sessionId'), clientId = query.get('clientId');
  const cols = Number(query.get('cols')), rows = Number(query.get('rows'));
  if (query.get('protocol') !== '1') throw new AppError(ErrorCode.UNSUPPORTED, 'Unsupported native window protocol');
  return validateNativeTarget({ instanceId, sessionId, windowId, clientId, cols, rows });
}

export class NativeWindowGateway extends ControlGateway {
  constructor({ pool }) { super({ pool, parseTarget: parseNativeWindowTarget, responses: true, contextRequests: true }); }
}
