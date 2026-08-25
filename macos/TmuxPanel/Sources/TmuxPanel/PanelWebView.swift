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
        configuration.websiteDataStore = .default()

        let webView = PanelWKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsMagnification = true
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
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        static let notificationHandlerName = "tmuxPanelNotification"
        static let actionHandlerName = "tmuxPanelAction"
        static let clipboardHandlerName = "tmuxPanelClipboard"
        static let maximumClipboardBytes = 1_048_576

        private weak var model: AppModel?
        private let endpoint: PanelEndpoint

        init(model: AppModel, endpoint: PanelEndpoint) {
            self.model = model
            self.endpoint = endpoint
        }

        func load(_ url: URL, in webView: WKWebView) {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            model?.markLoading()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model?.markReady()
            (webView as? PanelWKWebView)?.publishFullscreenState()
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            model?.markFailed(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
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
               let body = message.body as? [String: Any],
               let text = body["text"] as? String,
               !text.isEmpty,
               text.utf8.count <= Self.maximumClipboardBytes {
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(text, forType: .string)
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

            if navigationAction.targetFrame?.isMainFrame == true,
               PanelEndpointResolver.isSameOrigin(url, as: endpoint.url) {
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
            if navigationAction.targetFrame == nil,
               let url = navigationAction.request.url {
                openExternalHTTPURL(url)
            }
            return nil
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
