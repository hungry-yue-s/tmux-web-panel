import { describe, it, expect } from 'vitest';
import { collectNodeInfo } from '../../lib/node/info.js';
import { statusFromNodeInfo } from '../../lib/servers/health-service.js';
import { isRelayable } from '../../lib/hub/proxy.js';

describe('workbench capability across a Hub', () => {
  it('preserves the independently versioned pane protocol and unavailable reason', async () => {
    for (const capability of [
      { available: true, protocol: 1, reason: null },
      { available: false, protocol: 1, reason: 'tmux_snapshot_required' },
    ]) {
      const info = await collectNodeInfo({ tmuxVersion: async () => 'next', controlTerminal: async () => capability });
      const status = statusFromNodeInfo('remote', info, { transport: 'ssh', latencyMs: 5, now: 0 });
      expect(status.capabilities.controlTerminal).toEqual(capability);
      expect(status.workspace).toEqual({ provider: 'tmux', transport: 'ssh', persistence: 'tmux' });
    }
  });
  it('keeps older nodes usable without declaring pane streams', async () => {
    const info = await collectNodeInfo({ tmuxVersion: async () => '3.4' });
    expect(info.capabilities).not.toHaveProperty('controlTerminal');
    expect(info.capabilities).not.toHaveProperty('nativeWindow');
  });
  it('advertises actual native client support separately from raw pane snapshots', async () => {
    const nativeWindow = { available: true, protocol: 1, reason: null };
    const info = await collectNodeInfo({ tmuxVersion: async () => 'next', nativeWindow: async () => nativeWindow });
    expect(statusFromNodeInfo('remote', info, { transport: 'ssh', latencyMs: 5, now: 0 }).capabilities.nativeWindow).toEqual(nativeWindow);
    expect(info.capabilities).not.toHaveProperty('controlTerminal');
  });
  it('relays authenticated pane streams through the machine boundary', () => {
    expect(isRelayable('/ws/pane-stream/%251', { upgrade: true })).toBe(true);
    expect(isRelayable('/ws/pane-stream-unsafe/%251', { upgrade: true })).toBe(false);
    expect(isRelayable('/ws/native-window/@1', { upgrade: true })).toBe(true);
    expect(isRelayable('/ws/native-window-unsafe/@1', { upgrade: true })).toBe(false);
  });
});
