// The browser runs the same kernel as the server. Boot only creates the root
// context; every service and view is a plugin named by the server's manifest.

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

// For the browser console: twp.registry, twp.get('shell'), …
globalThis.twp = ctx;

function showFatal(text) {
  const app = document.getElementById('app');
  const message = document.createElement('p');
  message.className = 'boot-message boot-error';
  message.textContent = text;
  app.replaceChildren(message);
}

async function start() {
  const response = await fetch('/api/client/manifest', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.title) document.title = manifest.title;
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
  showFatal(`面板加载失败：${error?.message ?? error}`);
});
