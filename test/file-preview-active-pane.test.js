import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const terminalSource = readFileSync('public/js/terminal.js', 'utf8');
const appSource = readFileSync('public/js/app.js', 'utf8');

describe('file preview active pane wiring', () => {
  it('queries the live pane list in split mode and selects active=true', () => {
    expect(terminalSource).toContain('function _resolvePreviewPaneId()');
    expect(terminalSource).toContain("'/windows/' + encodeURIComponent(state.currentWindow) + '/panes'");
    expect(terminalSource).toContain('if (panes[i].active) return panes[i].id;');
  });

  it('uses the resolver for toolbar, terminal links, mobile taps, and shortcut', () => {
    expect(terminalSource).toContain('_openFilePreviewFromBuffer();');
    expect(terminalSource).toContain('FilePreview.registerLinkProvider(term, state.currentPane, _resolvePreviewPaneId);');
    expect(terminalSource).toContain('FilePreview.activateHit(tapHit, paneId);');
    expect(appSource).toContain("typeof _openFilePreviewFromBuffer === 'function'");
  });

  it('keeps web-link opening synchronous to the click gesture', () => {
    const previewSource = readFileSync('public/js/file-preview.js', 'utf8');
    expect(previewSource).toContain("if (f.kind === 'web') { _activateLink(f, paneId); return; }");
  });
});
