// Panel plugins: reviewed packages from the repository catalog (tmux-agent),
// installed per machine, each with its tools served over MCP (lib/plugins.js).
// A tool call for another server runs in that server's own copy of the plugin,
// reached through the hub's links. A Node-only install has no hub plugins: it
// knows only itself, and hubs call its tools.

import { PluginManager } from '../../lib/plugins.js';
import { createPluginsRouter } from '../../lib/api/plugins.js';
import { repoPath } from '../../lib/paths.js';
import { AppError, ErrorCode } from '../../lib/servers/errors.js';

export const name = 'panel-plugins';

export const inject = ['launch', 'http', 'tmux', 'workspace'];

export async function apply(ctx) {
  const hubLinks = () => {
    const links = ctx.get('hubLinks');
    if (!links) throw new AppError(ErrorCode.UNSUPPORTED, 'This panel does not manage other servers');
    return links;
  };
  const manager = new PluginManager({
    configDir: ctx.launch.configDir,
    catalogDir: repoPath('catalog'),
    dependencies: {
      tmux: ctx.tmux,
      workspaceService: ctx.workspace,
      servers: {
        list: () => ctx.get('servers')?.list() ?? { servers: [{ id: 'local' }] },
      },
      remote: {
        call: (serverId, pluginId, tool, args) => hubLinks().link(serverId).requestJson(
          'POST',
          `/api/plugins/${encodeURIComponent(pluginId)}/tools/${encodeURIComponent(tool)}`,
          args,
          { timeout: 30_000 },
        ),
      },
    },
  });
  await manager.load();
  ctx.http.mount('/api/plugins', createPluginsRouter(manager));
  ctx.provide('panelPlugins', manager);
  // The front end, where there are pages at all.
  ctx.inject(['ui'], (ctx) => ctx.ui.contribute(new URL('./client/page.json', import.meta.url)));
}
