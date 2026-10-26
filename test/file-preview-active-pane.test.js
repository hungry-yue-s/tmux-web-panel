import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const terminalSource = readFileSync('public/js/terminal.js', 'utf8');
const appSource = readFileSync('public/js/app.js', 'utf8');

describe('file preview active pane wiring', () => {
  it('queries the live pane list in split mode and selects active=true', () => {
    expect(terminalSource).toContain('function _resolvePreviewPaneId()');
    // The pane list now comes from the server-scoped adapter, so a remote
    // window is not resolved against the panel's own machine.
    expect(terminalSource).toContain('TerminalTarget.listPanes(state.currentSession, state.currentWindow)');
    expect(terminalSource).toContain('if (panes[i].active) return panes[i].id;');
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
    const previewSource = readFileSync('public/js/file-preview.js', 'utf8');
    expect(previewSource).not.toMatch(/fetch\('\/api\/files\//);
    expect(previewSource).toContain("_machine() + '/api/files/");
  });

  it('keeps web-link opening synchronous to the click gesture', () => {
    const previewSource = readFileSync('public/js/file-preview.js', 'utf8');
    expect(previewSource).toContain("if (f.kind === 'web') { _activateLink(f, paneId); return; }");
  });
});
