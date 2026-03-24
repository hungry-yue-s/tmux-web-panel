import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusMonitor } from '../server/monitor.js';

// Mock tmux module
vi.mock('../server/tmux.js', () => ({
  listSessions: vi.fn(),
  listWindows: vi.fn(),
  listPaneCommands: vi.fn(),
}));

// Import mocked module
const tmux = await import('../server/tmux.js');

function createMockWs(readyState = 1) {
  return {
    readyState,
    send: vi.fn(),
  };
}

describe('StatusMonitor', () => {
  let monitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new StatusMonitor();
    tmux.listSessions.mockReset();
    tmux.listWindows.mockReset();
    tmux.listPaneCommands.mockReset();
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  describe('subscribe / unsubscribe', () => {
    it('adds a WebSocket client to subscribers', () => {
      const ws = createMockWs();
      monitor.subscribe(ws);
      expect(monitor.subscribers.has(ws)).toBe(true);
    });

    it('removes a WebSocket client from subscribers', () => {
      const ws = createMockWs();
      monitor.subscribe(ws);
      monitor.unsubscribe(ws);
      expect(monitor.subscribers.has(ws)).toBe(false);
    });

    it('sends cached state immediately on subscribe if available', () => {
      const ws = createMockWs();
      const cachedState = JSON.stringify({ type: 'status', data: {} });
      monitor.previousState = cachedState;
      monitor.subscribe(ws);
      expect(ws.send).toHaveBeenCalledWith(cachedState);
    });

    it('does not send anything on subscribe if no previous state', () => {
      const ws = createMockWs();
      monitor.subscribe(ws);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does not send to closed WebSocket on subscribe', () => {
      const ws = createMockWs(3); // CLOSED
      monitor.previousState = '{}';
      monitor.subscribe(ws);
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('poll', () => {
    it('fetches sessions and windows and broadcasts to subscribers', async () => {
      tmux.listSessions.mockResolvedValue([
        { name: 'main', windows: 2, attached: true, lastActivity: '12345' },
      ]);
      tmux.listWindows.mockResolvedValue([
        { index: 0, name: 'bash', active: true, width: 80, height: 24 },
        { index: 1, name: 'vim', active: false, width: 80, height: 24 },
      ]);
      tmux.listPaneCommands.mockResolvedValue([]);

      const ws = createMockWs();
      monitor.subscribe(ws);

      await monitor.poll();

      expect(tmux.listSessions).toHaveBeenCalled();
      expect(tmux.listWindows).toHaveBeenCalledWith('main');
      expect(ws.send).toHaveBeenCalledTimes(1);

      const message = JSON.parse(ws.send.mock.calls[0][0]);
      expect(message.type).toBe('status');
      expect(message.data.totalSessions).toBe(1);
      expect(message.data.totalWindows).toBe(2);
      expect(message.data.sessions[0].name).toBe('main');
      expect(message.data.sessions[0].windowDetails).toHaveLength(2);
    });

    it('does not broadcast when state has not changed', async () => {
      tmux.listSessions.mockResolvedValue([
        { name: 'main', windows: 1, attached: false, lastActivity: '0' },
      ]);
      tmux.listWindows.mockResolvedValue([
        { index: 0, name: 'bash', active: true, width: 80, height: 24 },
      ]);
      tmux.listPaneCommands.mockResolvedValue([]);

      const ws = createMockWs();
      monitor.subscribe(ws);

      await monitor.poll();
      await monitor.poll();

      // Only one send (from first poll — second is skipped due to no change)
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('broadcasts error message when tmux call fails', async () => {
      tmux.listSessions.mockRejectedValue(new Error('tmux not found'));

      const ws = createMockWs();
      monitor.subscribe(ws);

      await monitor.poll();

      expect(ws.send).toHaveBeenCalledTimes(1);
      const message = JSON.parse(ws.send.mock.calls[0][0]);
      expect(message.type).toBe('error');
      expect(message.data.message).toBe('tmux not found');
    });

    it('skips sending to closed WebSocket clients', async () => {
      tmux.listSessions.mockResolvedValue([]);
      tmux.listWindows.mockResolvedValue([]);
      tmux.listPaneCommands.mockResolvedValue([]);

      const openWs = createMockWs(1);
      const closedWs = createMockWs(3);
      monitor.subscribe(openWs);
      monitor.subscribe(closedWs);

      await monitor.poll();

      expect(openWs.send).toHaveBeenCalledTimes(1);
      expect(closedWs.send).not.toHaveBeenCalled();
    });
  });

  describe('start / stop', () => {
    it('starts periodic polling', async () => {
      tmux.listSessions.mockResolvedValue([]);
      tmux.listWindows.mockResolvedValue([]);

      monitor.start(1000);

      // Immediate poll on start
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(tmux.listSessions).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      expect(tmux.listSessions).toHaveBeenCalledTimes(3);
    });

    it('stops periodic polling', async () => {
      tmux.listSessions.mockResolvedValue([]);
      tmux.listWindows.mockResolvedValue([]);

      monitor.start(1000);
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);

      monitor.stop();

      await vi.advanceTimersByTimeAsync(3000);
      // No additional calls after stop
      expect(tmux.listSessions).toHaveBeenCalledTimes(1);
    });

    it('restarts cleanly when start is called twice', async () => {
      tmux.listSessions.mockResolvedValue([]);
      tmux.listWindows.mockResolvedValue([]);

      monitor.start(1000);
      monitor.start(2000);

      expect(tmux.listSessions).toHaveBeenCalledTimes(2); // Two immediate polls

      await vi.advanceTimersByTimeAsync(2000);
      // Should use the second interval (2000ms), so one more poll
      expect(tmux.listSessions).toHaveBeenCalledTimes(3);
    });

    it('stop is safe to call when not started', () => {
      expect(() => monitor.stop()).not.toThrow();
    });
  });
});
