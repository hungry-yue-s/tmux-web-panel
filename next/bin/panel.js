#!/usr/bin/env node
// panel — start a panel from a profile.
//
//   panel [profile] [--profile <name|path>] [--patch <file>]... [--home <dir>] [--dump-config]
//
// The profile names the plugins; patches (the home patch, then each --patch)
// change them. --dump-config prints the result and exits without starting.
//
// The old server's options (--config for the desktop app, --port, --host,
// --auth, --tls-cert, --tls-key, --http-port, --poll-interval,
// --max-connections) are accepted unchanged; the runtime plugin reads them.

import { parseArgs } from 'node:util';
import { createApp, defaultHome } from '../kernel/app.js';
import { dumpEntries, resolveEntries } from '../kernel/profile.js';

// Ending mosh processes may take longer than the rest; this only bounds a stall.
const STOP_TIMEOUT_MS = 15_000;

const RUNTIME_OPTIONS = ['config', 'port', 'host', 'auth', 'tls-cert', 'tls-key', 'http-port', 'poll-interval', 'max-connections'];

function usage() {
  return 'usage: panel [profile] [--profile <name|path>] [--patch <file>]... [--home <dir>] [--dump-config]\n'
    + `       runtime options: ${RUNTIME_OPTIONS.map((option) => `--${option} <value>`).join(' ')}`;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        profile: { type: 'string' },
        patch: { type: 'string', multiple: true, default: [] },
        home: { type: 'string' },
        'dump-config': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        ...Object.fromEntries(RUNTIME_OPTIONS.map((option) => [option, { type: 'string' }])),
      },
    });
  } catch (error) {
    console.error(`${error.message}\n${usage()}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(usage());
    return 0;
  }
  if (positionals.length > 1 || (positionals.length === 1 && values.profile)) {
    console.error(usage());
    return 2;
  }
  const options = {
    profile: values.profile ?? positionals[0] ?? 'panel',
    patches: values.patch,
    home: values.home ?? defaultHome(),
  };

  if (values['dump-config']) {
    process.stdout.write(dumpEntries(await resolveEntries(options)));
    return 0;
  }

  const app = await createApp(options);
  const status = app.loader.status();
  const failed = status.filter((entry) => entry.state === 'failed');
  const waiting = status.filter((entry) => entry.state === 'pending');
  for (const entry of waiting) console.warn(`[panel] "${entry.id}" is waiting for a service no entry provides`);
  if (failed.length) {
    for (const entry of failed) console.error(`[panel] "${entry.id}" failed: ${entry.error}`);
    await app.stop();
    return 1;
  }

  await new Promise((resolve) => {
    const onSignal = (signal) => {
      console.log(`[panel] ${signal} received, stopping`);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
  const forced = setTimeout(() => {
    console.error('[panel] plugins did not stop in time');
    process.exit(1);
  }, STOP_TIMEOUT_MS);
  forced.unref();
  await app.stop();
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}, (error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
