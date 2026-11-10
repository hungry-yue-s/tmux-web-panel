import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../../plugins/workbench/index.js';
import { createViewStore } from '../../plugins/workbench/client/model.js';

function scope(configDir) {
  let value;
  apply({ launch: { configDir, authCredentials: { username: 'owner' } },
    client: { entry: (_file, config) => { value = config.storageScope; } }, inject() {} });
  return value;
}
describe('workbench installation identity', () => {
  it('keeps saved views when the standard application directory is renamed', () => {
    const dom = new JSDOM('', { url: 'https://panel.test/' });
    const disk = dom.window.localStorage;
    try {
      const previous = createViewStore(disk, scope(join(homedir(), '.config/tmux-web-panel')));
      const view = previous.create({ serverId: 'local', instanceId: '1:2', sessionId: '$1', windowId: '@1', clientId: 'native-client' });
      const migrated = createViewStore(disk, scope(join(homedir(), '.config/anymux')));
      expect(migrated.get(view.id)).toMatchObject({ clientId: 'native-client', windowId: '@1' });
      expect(createViewStore(disk, scope('/home/owner/custom-config')).get(view.id)).toBeNull();
    } finally { dom.window.close(); }
  });
  it('keeps two explicit custom configuration directories isolated even when they use the app names', () => {
    const dom = new JSDOM('', { url: 'https://panel.test/' });
    const disk = dom.window.localStorage;
    try {
      const first = createViewStore(disk, scope('/srv/project/tmux-web-panel'));
      const view = first.create({ serverId: 'local', instanceId: '1:2', sessionId: '$1', windowId: '@1', clientId: 'native-client' });
      expect(createViewStore(disk, scope('/srv/project/anymux')).get(view.id)).toBeNull();
    } finally { dom.window.close(); }
  });
});
