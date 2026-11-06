import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const terminalSource = readFileSync('plugins/terminal/client/js/terminal.js', 'utf8');
const appSource = readFileSync('plugins/ui/client/js/app.js', 'utf8');

describe('file preview active pane wiring', () => {
  it('queries the live pane list in split mode and selects active=true', () => {
    expect(terminalSource).toContain('function _resolvePreviewPaneId()');
    // The pane list now comes from the server-scoped adapter, so a remote
    // window is not resolved against the panel's own machine.
    expect(terminalSource).toContain('TerminalTarget.listPanes(state.currentSession, state.currentWindow)');
    expect(terminalSource).toContain('if (panes[i].active) return panes[i].id;');
  });

  describe('resolving focus on the real code', () => {
    const resolvers = terminalSource.slice(
      terminalSource.indexOf('function _focusFollowsTmux()'),
      terminalSource.indexOf('function _openFilePreviewFromBuffer()'),
    );
    function load({ mode = 'split', mobile = false, provider = true, panes, session = 'main', window: windowIndex = '1' } = {}) {
      const state = { currentPane: '%1', currentSession: session, currentWindow: windowIndex, panes: [{ id: '%1' }] };
      const listPanes = vi.fn(() => (panes instanceof Error ? Promise.reject(panes) : Promise.resolve(panes)));
      const target = { listPanes, supportsTmuxActions: () => provider };
      // eslint-disable-next-line no-new-func
      const built = new Function('state', '_terminalMode', '_isMobileTerminal', 'TerminalTarget',
        `${resolvers}; return { focused: _resolveFocusedPaneId, preview: _resolvePreviewPaneId };`);
      return { ...built(state, mode, () => mobile, target), listPanes, state };
    }

    it('in a split, focus is what tmux says, even when the list from the mount had one pane', async () => {
      const { focused, listPanes } = load({ panes: [{ id: '%1', active: false }, { id: '%2', active: true }] });
      await expect(focused()).resolves.toBe('%2');
      expect(listPanes).toHaveBeenCalledWith('main', '1');
    });

    it('on tabs and phones, focus is the selected pane, without asking', async () => {
      for (const options of [{ mode: 'tab' }, { mobile: true }, { provider: false }]) {
        const { focused, listPanes } = load({ ...options, panes: [{ id: '%2', active: true }] });
        await expect(focused()).resolves.toBe('%1');
        expect(listPanes).not.toHaveBeenCalled();
      }
    });

    it('rejects rather than answer with the attach pane when tmux cannot say', async () => {
      await expect(load({ panes: new Error('offline') }).focused()).rejects.toThrow('offline');
      await expect(load({ panes: [{ id: '%1' }, { id: '%2' }] }).focused()).rejects.toThrow('活动窗格');
      await expect(load({ session: null, panes: [] }).focused()).rejects.toThrow('窗口');
    });

    it('still lets a preview fall back to the attach pane, as it always has', async () => {
      await expect(load({ panes: new Error('offline') }).preview()).resolves.toBe('%1');
      await expect(load({ panes: [{ id: '%2' }] }).preview()).resolves.toBe('%1');
      await expect(load({ panes: [{ id: '%2', active: true }] }).preview()).resolves.toBe('%2');
    });
  });

  it('uses the resolver for toolbar, terminal links, mobile taps, and shortcut', () => {
    expect(terminalSource).toContain('_openFilePreviewFromBuffer();');
    expect(terminalSource).toContain('FilePreview.registerLinkProvider(term, state.currentPane, _resolvePreviewPaneId);');
    expect(terminalSource).toContain('FilePreview.activateHit(tapHit, paneId);');
    expect(appSource).toContain("typeof _openFilePreviewFromBuffer === 'function'");
  });

  it('registers the link provider on every server and reads files on the pane\'s machine', () => {
    // A remote pane's paths resolve through that machine's own /api/files,
    // never through the panel host's filesystem.
    expect(terminalSource).not.toMatch(/FilePreview !== 'undefined' && !TerminalTarget\.isRemote\(\)/);
    expect(terminalSource).toContain('FilePreview.registerLinkProvider(term, state.currentPane, _resolvePreviewPaneId)');
    const previewSource = readFileSync('plugins/files/client/js/file-preview.js', 'utf8');
    expect(previewSource).not.toMatch(/fetch\('\/api\/files\//);
    expect(previewSource).toContain("_machine() + '/api/files/");
  });

  it('keeps web-link opening synchronous to the click gesture', () => {
    const previewSource = readFileSync('plugins/files/client/js/file-preview.js', 'utf8');
    expect(previewSource).toContain("if (f.kind === 'web') { _activateLink(f, paneId); return; }");
  });
});
