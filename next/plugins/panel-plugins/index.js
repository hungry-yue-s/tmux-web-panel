// Panel plugins: reviewed packages from the repository catalog (tmux-agent),
// installed per machine, each with its tools served over MCP (lib/plugins.js).
// A tool call for another server runs in that server's own copy of the plugin.

import { PluginManager } from '../../lib/plugins.js';
import { createPluginsRouter } from '../../lib/api/plugins.js';
import { repoPath } from '../../lib/paths.js';

export const name = 'panel-plugins';

export const inject = ['launch', 'http', 'tmux', 'workspace', 'servers'];

export async function apply(ctx) {
  const servers = ctx.servers;
  const manager = new PluginManager({
    configDir: ctx.launch.configDir,
    catalogDir: repoPath('plugins'),
    dependencies: {
      tmux: ctx.tmux,
      workspaceService: ctx.workspace,
      servers: servers.service,
      remote: {
        call: (serverId, pluginId, tool, args) => servers.links.link(serverId).requestJson(
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
