// `ctx.launch`: how this installation was started.
//
// The service managers configure the panel through the environment (PORT,
// HOST, AUTH, NODE_ONLY, TLS_CERT, TLS_KEY, HTTP_PORT, ANYMUX_CONFIG_DIR)
// and the desktop app through `--config <settings.json>`. This plugin reads
// them exactly as the old server did (lib/runtime-config.js), so switching a
// service to `anymux` changes nothing about how it is configured.
//
// Config, for tests and dev runs: `env` adds variables before resolving
// (e.g. { AUTH: 'me:pw', PORT: '0' }); any other field replaces the
// resolved value outright.

import { resolveRuntimeConfig } from '../../lib/runtime-config.js';

export const name = 'launch';

/** @param {{ env?: Record<string, string>, argv?: string[], [field: string]: any }} [config] */
export function apply(ctx, config) {
  const { env, argv, ...fields } = config ?? {};
  const resolved = resolveRuntimeConfig({
    env: env ? { ...process.env, ...env } : process.env,
    argv: argv ?? process.argv,
  });
  ctx.provide('launch', Object.freeze({ ...resolved, ...fields }));
}
