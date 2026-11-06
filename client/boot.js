// The browser runs the same kernel as the server. Boot only creates the root
// context; every service is a plugin named by the server's manifest. It runs
// beside the page's own scripts and never touches their DOM: a failure here
// is logged, not shown.

import { Context, Logger } from 'cordis';
import Timer from '@cordisjs/plugin-timer';

const ctx = new Context();

ctx.logger.exporter({
  colors: 0,
  export(message) {
    const text = `[${message.name}] ${Logger.format(this, message)}`;
    if (message.type === 'error') console.error(text);
    else if (message.type === 'warn') console.warn(text);
    else console.log(text);
  },
});

ctx.plugin(Timer);

// For the browser console: twp.registry, twp.get('api'), …
globalThis.twp = ctx;

async function start() {
  const response = await fetch('/client/manifest.json', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const manifest = await response.json();
  for (const entry of manifest.entries) {
    try {
      const mod = await import(entry.url);
      ctx.plugin(mod.default ?? mod, entry.config ?? undefined);
    } catch (error) {
      ctx.logger('boot').error('cannot load %s: %s', entry.url, error?.message ?? error);
    }
  }
}

start().catch((error) => {
  ctx.logger('boot').error('client plugins did not start: %s', error?.message ?? error);
});
