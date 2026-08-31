import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  'macos/TmuxPanel/Sources/TmuxPanel/PanelWebView.swift',
  'utf8',
);
const previewSource = readFileSync('public/js/file-preview.js', 'utf8');
const terminalSource = readFileSync('public/js/terminal.js', 'utf8');
const indexSource = readFileSync('public/index.html', 'utf8');

describe('macOS native WebView navigation', () => {
  it('routes web downloads through WKDownload and the system save panel', () => {
    expect(source).toContain('WKDownloadDelegate');
    expect(source).toContain('navigationAction.shouldPerformDownload');
    expect(source).toContain('decisionHandler(.download)');
    expect(source).toContain('download.delegate = self');
    expect(source).toContain('let panel = NSSavePanel()');
    expect(source).toContain('FileManager.default.replaceItemAt');
  });

  it('opens trusted popups in native windows while keeping external URLs outside', () => {
    expect(source).toContain('javaScriptCanOpenWindowsAutomatically = true');
    expect(source).toContain('if let url = navigationAction.request.url');
    expect(source).toContain('let child = PanelWKWebView');
    expect(source).toContain('childWindows[ObjectIdentifier(child)] = controller');
    expect(source).toContain('return url.scheme?.lowercased() == "about"');
    expect(source).toContain('openExternalHTTPURL(url)');
    expect(source).toContain('func webViewDidClose');
  });

  it('uses the native window bridge for previews and terminal pop-outs', () => {
    expect(source).toContain('openWindowHandlerName = "tmuxPanelOpenWindow"');
    expect(source).toContain('html.utf8.count <= Self.maximumWindowHTMLBytes');
    expect(previewSource).toContain('handlers.tmuxPanelOpenWindow');
    expect(previewSource).toContain('html: out.html');
    expect(terminalSource).toContain('messageHandlers.tmuxPanelOpenWindow');
    expect(indexSource).toContain('/js/file-preview.js?v=35');
    expect(indexSource).toContain('/js/terminal.js?v=16');
  });

  it('copies Mermaid PNG data through the native pasteboard bridge', () => {
    expect(source).toContain('maximumClipboardImageBytes = 16_777_216');
    expect(source).toContain('body["pngBase64"] as? String');
    expect(source).toContain('pasteboard.setData(data, forType: .png)');
    expect(previewSource).toContain('handlers.tmuxPanelClipboard.postMessage');
  });
});
