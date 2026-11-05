import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { handle, AppError, ErrorCode } from '../servers/errors.js';
import { requireSameOrigin } from './same-origin.js';

export function createPluginsRouter(manager) {
  const router = express.Router();
  router.use(requireSameOrigin);
  router.get('/', handle(async () => ({ plugins: await manager.list() })));
  router.post('/:id/:action', (req, res, next) => {
    if (req.params.action === 'mcp') return next();
    return handle(async () => manager.change(req.params.id, req.params.action))(req, res);
  });
  router.get('/:id/connection', handle(async (req) => {
    return manager.connection(req.params.id, req.protocol + '://' + req.get('host'));
  }));

  // Stateless HTTP: reconnecting an agent does not own or terminate tmux jobs.
  router.post('/:id/mcp', handle(async (req, res) => {
    const id = req.params.id;
    const plugin = await manager.getRuntime(id);
    const server = new McpServer({ name: id, version: manager.state[id].version }, {
      instructions: 'Read the workspace and target pane before input. Command jobs and agent tasks have different completion semantics. A timeout never means success.',
    });
    plugin.register(server, z, () => manager.requireEnabled(id));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));
  // A hub relaying a tool call that targets this machine.
  router.post('/:id/tools/:tool', handle(async (req) => {
    const id = req.params.id;
    const plugin = await manager.getRuntime(id);
    if (typeof plugin.call !== 'function') throw new AppError(ErrorCode.UNSUPPORTED, 'Plugin has no remote tools');
    try {
      return await plugin.call(req.params.tool, req.body || {}, z, () => manager.requireEnabled(id));
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Tool errors are meant for the agent; keep the message across the relay.
      throw new AppError(ErrorCode.VALIDATION_ERROR, err.message || 'Tool failed', { status: 422 });
    }
  }));
  router.all('/:id/mcp', handle(async () => {
    throw new AppError(ErrorCode.UNSUPPORTED, 'Use MCP Streamable HTTP POST', { status: 405 });
  }));
  return router;
}
