/**
 * Validation shared by the tmux and SSH workspace providers, so the two never
 * drift into accepting different input for the same API surface.
 */

import { AppError, ErrorCode } from '../servers/errors.js';

/** Matches tmux's own pane label limit so both providers feel identical. */
export const LABEL_MAX = 32;
export const NAME_MAX = 64;
/** Geometry is expressed in percent of the window. */
export const GEOMETRY_MAX = 100;

const SPLIT_DIRECTIONS = new Set(['horizontal', 'vertical']);

function fieldError(message, field) {
  return new AppError(ErrorCode.VALIDATION_ERROR, message, { details: { field } });
}

/**
 * tmux's default `split-window` is a vertical split (stacked rows), so an
 * omitted direction means the same thing here.
 */
export function requireDirection(direction) {
  if (direction === undefined || direction === null || direction === '') return 'vertical';
  if (!SPLIT_DIRECTIONS.has(direction)) {
    throw fieldError(`Invalid split direction: ${direction}`, 'direction');
  }
  return direction;
}

/** Rejects unknown fields so a typo cannot look like a successful no-op. */
export function requireKnownFields(patch, allowed, context) {
  for (const key of Object.keys(patch || {})) {
    if (!allowed.includes(key)) {
      throw fieldError(`Unsupported field for ${context}: ${key}`, key);
    }
  }
}

export function requireDisplayName(value, field, { max = NAME_MAX, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback;
    throw fieldError(`${field} is required`, field);
  }
  if (typeof value !== 'string') throw fieldError(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (!trimmed) {
    if (fallback !== null) return fallback;
    throw fieldError(`${field} is required`, field);
  }
  if (trimmed.length > max) throw fieldError(`${field} exceeds ${max} characters`, field);
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw fieldError(`${field} contains control characters`, field);
  return trimmed;
}

export function requireGeometryValue(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > GEOMETRY_MAX) {
    throw fieldError(`${field} must be an integer between 0 and ${GEOMETRY_MAX}`, field);
  }
  return value;
}
