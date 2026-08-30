import AppKit
import Foundation
import Security
import SwiftUI
import WebKit

struct PanelWebView: NSViewRepresentable {
    @ObservedObject var model: AppModel

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model, endpoint: model.endpoint)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.classList.add('tmux-native-shell')",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController.add(
            context.coordinator,
            name: Coordinator.notificationHandlerName
        )
        configuration.userContentController.add(
            context.coordinator,
            name: Coordinator.actionHandlerName
        )
        configuration.userContentController.add(
            context.coordinator,
            name: Coordinator.clipboardHandlerName
        )
        configuration.userContentController.add(
            context.coordinator,
            name: Coordinator.openWindowHandlerName
        )
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.websiteDataStore = .default()

        let webView = PanelWKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsMagnification = true
        context.coordinator.attachPrimary(webView)
        model.attach(webView: webView)
        context.coordinator.load(model.endpoint.url, in: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: Coordinator.notificationHandlerName
        )
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: Coordinator.actionHandlerName
        )
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: Coordinator.clipboardHandlerName
        )
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: Coordinator.openWindowHandlerName
        )
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate,
        WKScriptMessageHandler, WKDownloadDelegate, NSWindowDelegate {
        static let notificationHandlerName = "tmuxPanelNotification"
        static let actionHandlerName = "tmuxPanelAction"
        static let clipboardHandlerName = "tmuxPanelClipboard"
        static let openWindowHandlerName = "tmuxPanelOpenWindow"
        static let maximumClipboardBytes = 1_048_576
        static let maximumClipboardImageBytes = 16_777_216
        static let maximumWindowHTMLBytes = 67_108_864

        private weak var model: AppModel?
        private weak var primaryWebView: WKWebView?
        private let endpoint: PanelEndpoint
        private var childWindows: [ObjectIdentifier: NSWindowController] = [:]
        private var downloadDestinations: [ObjectIdentifier: (temporary: URL, final: URL)] = [:]

        init(model: AppModel, endpoint: PanelEndpoint) {
            self.model = model
            self.endpoint = endpoint
        }

        func load(_ url: URL, in webView: WKWebView) {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }

        func attachPrimary(_ webView: WKWebView) {
            primaryWebView = webView
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            guard webView === primaryWebView else { return }
            model?.markLoading()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if webView === primaryWebView { model?.markReady() }
            (webView as? PanelWKWebView)?.publishFullscreenState()
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            guard webView === primaryWebView else { return }
            model?.markFailed(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            guard webView === primaryWebView else { return }
            model?.markFailed(error.localizedDescription)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame,
                  let sourceURL = message.frameInfo.request.url,
                  PanelEndpointResolver.isSameOrigin(sourceURL, as: endpoint.url) else {
                return
            }

            if message.name == Self.notificationHandlerName,
               let payload = NativeNotificationPayload(messageBody: message.body) {
                Task { await NativeNotificationCenter.shared.deliver(payload) }
                return
            }
            if message.name == Self.actionHandlerName,
               let body = message.body as? [String: Any],
               body["action"] as? String == "toggleFullscreen" {
                model?.toggleFullScreen()
                return
            }
            if message.name == Self.clipboardHandlerName,
               let body = message.body as? [String: Any] {
                copyToPasteboard(body)
                return
            }
            if message.name == Self.openWindowHandlerName,
               let body = message.body as? [String: Any] {
                openNativeWindow(body)
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            if navigationAction.shouldPerformDownload, isTrusted(webView) {
                decisionHandler(.download)
                return
            }

            if navigationAction.targetFrame?.isMainFrame == true,
               isInternal(url, in: webView) {
                decisionHandler(.allow)
                return
            }

            if navigationAction.targetFrame?.isMainFrame == false {
                decisionHandler(.allow)
                return
            }

            openExternalHTTPURL(url)
            decisionHandler(.cancel)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            guard navigationAction.targetFrame == nil,
                  isTrusted(webView) else { return nil }
            if let url = navigationAction.request.url,
               !isInternal(url, in: webView) {
                openExternalHTTPURL(url)
                return nil
            }

            let width = max(640, windowFeatures.width?.doubleValue ?? 1000)
            let height = max(480, windowFeatures.height?.doubleValue ?? 720)
            return makeChildWindow(
                configuration: configuration,
                title: "Tmux Panel",
                width: width,
                height: height
            )
        }

        func webViewDidClose(_ webView: WKWebView) {
            webView.window?.close()
        }

        func windowWillClose(_ notification: Notification) {
            guard let window = notification.object as? NSWindow,
                  let webView = window.contentView as? WKWebView else { return }
            childWindows.removeValue(forKey: ObjectIdentifier(webView))
        }

        func webView(
            _ webView: WKWebView,
            navigationAction: WKNavigationAction,
            didBecome download: WKDownload
        ) {
            download.delegate = self
        }

        func download(
            _ download: WKDownload,
            decideDestinationUsing response: URLResponse,
            suggestedFilename: String,
            completionHandler: @escaping @MainActor @Sendable (URL?) -> Void
        ) {
            let panel = NSSavePanel()
            panel.canCreateDirectories = true
            panel.nameFieldStringValue = suggestedFilename
            panel.begin { [weak self] result in
                guard let self, result == .OK, let finalURL = panel.url else {
                    completionHandler(nil)
                    return
                }
                let temporaryURL = finalURL.deletingLastPathComponent()
                    .appendingPathComponent(".\(UUID().uuidString).download")
                self.downloadDestinations[ObjectIdentifier(download)] = (temporaryURL, finalURL)
                completionHandler(temporaryURL)
            }
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let destination = downloadDestinations.removeValue(
                forKey: ObjectIdentifier(download)
            ) else { return }
            do {
                if FileManager.default.fileExists(atPath: destination.final.path) {
                    _ = try FileManager.default.replaceItemAt(
                        destination.final,
                        withItemAt: destination.temporary
                    )
                } else {
                    try FileManager.default.moveItem(
                        at: destination.temporary,
                        to: destination.final
                    )
                }
            } catch {
                showDownloadError(error.localizedDescription)
            }
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            if let destination = downloadDestinations.removeValue(
                forKey: ObjectIdentifier(download)
            ) {
                try? FileManager.default.removeItem(at: destination.temporary)
            }
            showDownloadError(error.localizedDescription)
        }

        private func isTrusted(_ webView: WKWebView) -> Bool {
            webView === primaryWebView || childWindows[ObjectIdentifier(webView)] != nil
        }

        private func copyToPasteboard(_ body: [String: Any]) {
            let pasteboard = NSPasteboard.general
            if let text = body["text"] as? String,
               !text.isEmpty,
               text.utf8.count <= Self.maximumClipboardBytes {
                pasteboard.clearContents()
                pasteboard.setString(text, forType: .string)
                return
            }
            let maximumBase64Bytes = Self.maximumClipboardImageBytes * 4 / 3 + 4
            guard let base64 = body["pngBase64"] as? String,
                  base64.utf8.count <= maximumBase64Bytes,
                  let data = Data(base64Encoded: base64),
                  data.count <= Self.maximumClipboardImageBytes else { return }
            pasteboard.clearContents()
            pasteboard.setData(data, forType: .png)
        }

        private func isInternal(_ url: URL, in webView: WKWebView) -> Bool {
            if PanelEndpointResolver.isSameOrigin(url, as: endpoint.url) { return true }
            guard isTrusted(webView) else { return false }
            return url.scheme?.lowercased() == "about" || url.scheme?.lowercased() == "blob"
        }

        private func openNativeWindow(_ body: [String: Any]) {
            guard let primaryWebView else { return }
            let width = max(640, min(2400, (body["width"] as? NSNumber)?.doubleValue ?? 1000))
            let height = max(480, min(1600, (body["height"] as? NSNumber)?.doubleValue ?? 720))
            let title = String((body["title"] as? String ?? "Tmux Panel").prefix(200))
            let configuration = WKWebViewConfiguration()
            configuration.userContentController = primaryWebView.configuration.userContentController
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
            configuration.websiteDataStore = .default()

            if let html = body["html"] as? String,
               html.utf8.count <= Self.maximumWindowHTMLBytes {
                makeChildWindow(configuration: configuration, title: title, width: width, height: height)
                    .loadHTMLString(html, baseURL: endpoint.url)
                return
            }
            guard let rawURL = body["url"] as? String,
                  let url = URL(string: rawURL, relativeTo: endpoint.url)?.absoluteURL,
                  PanelEndpointResolver.isSameOrigin(url, as: endpoint.url) else { return }
            makeChildWindow(configuration: configuration, title: title, width: width, height: height)
                .load(URLRequest(url: url))
        }

        private func makeChildWindow(
            configuration: WKWebViewConfiguration,
            title: String,
            width: Double,
            height: Double
        ) -> WKWebView {
            let child = PanelWKWebView(frame: .zero, configuration: configuration)
            child.navigationDelegate = self
            child.uiDelegate = self
            child.allowsMagnification = true
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.title = title
            window.contentView = child
            window.delegate = self
            window.center()
            let controller = NSWindowController(window: window)
            childWindows[ObjectIdentifier(child)] = controller
            controller.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            return child
        }

        private func showDownloadError(_ message: String) {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "文件导出失败"
            alert.informativeText = message
            if let window = NSApp.keyWindow {
                alert.beginSheetModal(for: window)
            } else {
                alert.runModal()
            }
        }

        private func openExternalHTTPURL(_ url: URL) {
            guard let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" else { return }
            NSWorkspace.shared.open(url)
        }

        func webView(
            _ webView: WKWebView,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  let trust = challenge.protectionSpace.serverTrust,
                  PanelEndpointResolver.isLoopback(challenge.protectionSpace.host),
                  let pinned = endpoint.pinnedCertificateDER,
                  let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
                  let serverCertificate = certificates.first else {
                completionHandler(.performDefaultHandling, nil)
                return
            }

            let serverData = SecCertificateCopyData(serverCertificate) as Data
            guard serverData == pinned else {
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }
            completionHandler(.useCredential, URLCredential(trust: trust))
        }

    }
}

@MainActor
final class PanelWKWebView: WKWebView {
    override func viewWillMove(toWindow newWindow: NSWindow?) {
        NotificationCenter.default.removeObserver(self, name: NSWindow.didEnterFullScreenNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: NSWindow.didExitFullScreenNotification, object: nil)
        super.viewWillMove(toWindow: newWindow)
        guard let newWindow else { return }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(didEnterFullscreen),
            name: NSWindow.didEnterFullScreenNotification,
            object: newWindow
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(didExitFullscreen),
            name: NSWindow.didExitFullScreenNotification,
            object: newWindow
        )
    }

    func publishFullscreenState() {
        publishFullscreenState(window?.styleMask.contains(.fullScreen) == true)
    }

    @objc private func didEnterFullscreen() {
        publishFullscreenState(true)
    }

    @objc private func didExitFullscreen() {
        publishFullscreenState(false)
    }

    private func publishFullscreenState(_ active: Bool) {
        let script = "document.dispatchEvent(new CustomEvent('tmux-panel-native-fullscreen', {detail:{active:\(active)}}))"
        evaluateJavaScript(script)
    }
}
