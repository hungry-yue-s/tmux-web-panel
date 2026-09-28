import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync('public/js/terminal.js', 'utf8');
const switching = source.slice(source.indexOf('function switchPane(newPaneId)'), source.indexOf('// === Pane Navigation Bar'));

it('reconnects mobile panes without rebuilding the rail, including first/last wrap', () => {
  const dom = new JSDOM('<div class="mobile-pane-strip"><div class="pane-pills"></div></div><div class="terminal-container"></div>');
  const { window } = dom;
  window.innerWidth = 375;
  const state = { currentPane: '%0', panes: [{ id: '%0' }, { id: '%1' }, { id: '%2' }] };
  const terminalState = { termContainer: window.document.querySelector('.terminal-container') };
  const original = terminalState.termContainer;
  const strip = window.document.querySelector('.pane-pills');
  const cleanup = vi.fn(() => { terminalState.termContainer = null; });
  const mount = vi.fn();
  const update = vi.fn();
  const factory = new Function('window', 'document', 'state', 'terminalState', '_cleanupTerminalResources', '_mountTerminal', 'updatePanePills', switching + '; return { switchPane, switchPaneByDirection };');
  const api = factory(window, window.document, state, terminalState, cleanup, mount, update);
  api.switchPaneByDirection(-1);
  expect(state.currentPane).toBe('%2');
  expect(original.isConnected).toBe(false);
  expect(window.document.querySelector('.pane-pills')).toBe(strip);
  expect(update).toHaveBeenLastCalledWith(strip, '%2', true);
  expect(mount).toHaveBeenLastCalledWith(terminalState.termContainer, false);
  api.switchPaneByDirection(1);
  expect(state.currentPane).toBe('%0');
  api.switchPane('%0');
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(window.document.querySelectorAll('.terminal-container')).toHaveLength(1);
  dom.window.close();
});
