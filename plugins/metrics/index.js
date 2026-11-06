// What this machine is doing: CPU, memory, IO with history, the processes
// behind the load, and per-window usage.

import systemStatsRouter from '../../lib/api/system-stats.js';
import windowStatsRouter from '../../lib/api/window-stats.js';
import perfHistoryRouter, { startSampler, stopSampler } from '../../lib/api/perf-history.js';
import perfDrilldownRouter from '../../lib/api/perf-drilldown.js';
import { MetricsService } from '../../lib/metrics/service.js';
import { collectLocalMetrics } from '../../lib/metrics/local-collector.js';
import { createMetricsRouter } from '../../lib/api/metrics.js';

export const name = 'metrics';

export const inject = ['http'];

export function apply(ctx) {
  ctx.http.mount('/api/system-stats', systemStatsRouter);
  ctx.http.mount('/api/perf/history', perfHistoryRouter);
  ctx.http.mount('/api/perf/drilldown', perfDrilldownRouter);
  ctx.http.mount('/api/window-stats', windowStatsRouter);

  const metrics = new MetricsService({ collector: collectLocalMetrics });
  ctx.http.mount('/api/metrics', createMetricsRouter({ metricsService: metrics }));

  // A 2 s sample into a one-hour ring, for the history charts.
  ctx.effect(() => {
    startSampler();
    return () => stopSampler();
  }, 'metrics.perf-history');

  ctx.provide('metrics', metrics);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
