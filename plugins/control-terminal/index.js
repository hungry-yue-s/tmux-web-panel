// Native windows and raw pane streams own their clients independently. Legacy
// terminals and Mosh keep ctx.terminals and their established lifecycle.
import express from 'express';
import { ControlPool } from '../../lib/terminal/control-pool.js';
import { ControlGateway } from '../../lib/terminal/control-gateway.js';
import { WorkbenchService } from '../../lib/terminal/control-service.js';
import { NativeWindowPool } from '../../lib/terminal/native-window-pool.js';
import { NativeWindowGateway } from '../../lib/terminal/native-window-gateway.js';
import { handle } from '../../lib/servers/errors.js';
import { requireSameOrigin } from '../../lib/api/same-origin.js';

export const name = 'control-terminal';
export const inject = ['launch', 'http', 'tmux', 'workspace', 'node'];

export function apply(ctx) {
  const pool = new ControlPool({ tmux: ctx.tmux, workspace: ctx.workspace });
  const nativePool = new NativeWindowPool({ tmux: ctx.tmux });
  const service = new WorkbenchService({ pool, nativePool, tmux: ctx.tmux, workspace: ctx.workspace, configDir: ctx.launch.configDir });
  const gateway = new ControlGateway({ pool });
  const nativeGateway = new NativeWindowGateway({ pool: nativePool });
  ctx.http.websocket('/ws/pane-stream/*', ({ ws, url }) => gateway.handle(ws, url.pathname, url.searchParams));
  ctx.http.websocket('/ws/native-window/*', ({ ws, url }) => nativeGateway.handle(ws, url.pathname, url.searchParams));
  const router = express.Router();
  router.use(requireSameOrigin);
  router.get('/capability', handle(() => service.capability()));
  router.get('/native-capability', handle(() => nativePool.capability()));
  router.post('/windows', handle(async (req, res) => { const window = await service.createWindow(req.body); res.status(201); return window; }));
  router.get('/panes', handle(() => service.listPanes()));
  router.get('/panes/:paneId/history', handle(req => service.history({
    paneId: req.params.paneId, instanceId: req.query.instanceId, sessionId: req.query.sessionId, windowId: req.query.windowId,
  }, { before: req.query.before === undefined ? undefined : Number(req.query.before), limit: req.query.limit === undefined ? 500 : Number(req.query.limit) })));
  router.post('/panes', handle(async (req, res) => { const pane = await service.createPane(req.body); res.status(201); return pane; }));
  router.delete('/panes/:paneId', handle(async (req, res) => {
    await service.terminate({ paneId: req.params.paneId, instanceId: req.query.instanceId, sessionId: req.query.sessionId, windowId: req.query.windowId });
    res.status(204).end();
  }));
  ctx.http.mount('/api/workbench', router);
  ctx.effect(() => ctx.node.setCapability('controlTerminal', () => pool.capability()), 'control-terminal.capability');
  ctx.effect(() => ctx.node.setCapability('nativeWindow', () => nativePool.capability()), 'control-terminal.native-capability');
  ctx.effect(() => () => { service.dispose(); pool.dispose(); nativePool.dispose(); }, 'control-terminal.sessions');
  ctx.provide('controlTerminals', Object.freeze({ pool, gateway, service, nativePool, nativeGateway }));
}
