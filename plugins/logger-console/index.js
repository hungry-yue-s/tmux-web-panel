// Prints the Cordis logger to the process console (journald, the Windows task
// log). Without an exporter, log messages only reach the logger's buffer.

import { Logger } from 'cordis';

export const name = 'logger-console';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/** @param {{ level?: keyof typeof LEVELS }} [config] */
export function apply(ctx, config) {
  const level = LEVELS[config?.level ?? 'info'] ?? LEVELS.info;
  ctx.logger.exporter({
    colors: process.stdout.isTTY ? 3 : 0,
    levels: { default: level },
    export(message) {
      const text = `[${message.type[0].toUpperCase()}] ${message.name} ${Logger.format(this, message)}`;
      if (message.type === 'error') console.error(text);
      else if (message.type === 'warn') console.warn(text);
      else console.log(text);
    },
  });
}
