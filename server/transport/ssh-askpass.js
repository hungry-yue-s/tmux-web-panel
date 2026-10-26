// OpenSSH reads this helper's stdout through its private askpass pipe. Read the
// encrypted registry locally so passwords never enter argv, env or PTY input.
import { ServerRegistry } from '../servers/registry.js';
import { controlSocketName } from './openssh-executor.js';

try {
  const registry = await new ServerRegistry({ configDir: process.env.TMUX_PANEL_SSH_CONFIG_DIR }).load();
  const server = registry.require(process.env.TMUX_PANEL_SSH_SERVER_ID);
  // An edit may have happened after the SSH process was started. Never send a
  // new credential to the old connection, even if its host key is trusted.
  if (registry.writesBlocked || server.ssh.authMethod !== 'password'
    || controlSocketName(server) !== process.env.TMUX_PANEL_SSH_CONNECTION) process.exit(1);
  process.stdout.write(server.ssh.password + '\n');
} catch {
  process.exit(1);
}
