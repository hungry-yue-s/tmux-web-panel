import AppKit
import Combine
import Foundation
import UserNotifications
import WebKit

enum WebState: Equatable {
    case loading
    case ready
    case failed(String)

    var title: String {
        switch self {
        case .loading: "正在连接"
        case .ready: "网页已连接"
        case .failed: "网页连接失败"
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var endpoint: PanelEndpoint
    @Published private(set) var webViewID = UUID()
    let desktop = DesktopSetupManager()

    @Published private(set) var webState: WebState = .loading
    @Published private(set) var panelService: ServiceState = .checking
    @Published private(set) var tmuxService: ServiceState = .checking
    @Published private(set) var notificationStatus: UNAuthorizationStatus = .notDetermined

    private weak var webView: WKWebView?
    private var pendingNavigation: NativeNotificationPayload?
    private var statusTimer: Timer?
    private var desktopObservation: AnyCancellable?
    private var pendingHandoffToken: String?

    init(endpoint: PanelEndpoint = PanelEndpointResolver.resolve()) {
        self.endpoint = endpoint
        desktopObservation = desktop.$revision.dropFirst().sink { [weak self] _ in
            self?.applyDesktopState()
        }
        NativeNotificationCenter.shared.activationHandler = { [weak self] payload in
            self?.openNotification(payload)
        }
        refreshServices()
        refreshNotificationStatus()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshServices() }
        }
    }

    var menuBarSymbol: String {
        if panelService == .running && tmuxService == .running && webState == .ready {
            return "rectangle.connected.to.line.below"
        }
        if case .failed = webState { return "exclamationmark.triangle" }
        return "rectangle.split.2x2"
    }

    var notificationStatusTitle: String {
        switch notificationStatus {
        case .authorized: "原生通知已启用"
        case .denied: "原生通知已禁用"
        case .provisional: "原生通知为临时授权"
        case .ephemeral: "原生通知为临时授权"
        case .notDetermined: "启用原生通知"
        @unknown default: "检查通知权限"
        }
    }

    func attach(webView: WKWebView) {
        self.webView = webView
    }

    func initialLoadURL() -> URL {
        guard let token = pendingHandoffToken else { return endpoint.url }
        pendingHandoffToken = nil
        var components = URLComponents(url: endpoint.url, resolvingAgainstBaseURL: false)
        let encoded = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        components?.percentEncodedFragment = "handoff=" + encoded
        return components?.url ?? endpoint.url
    }

    private func applyDesktopState() {
        guard let next = desktop.endpoint else { return }
        let token = desktop.takeSessionToken()
        if next != endpoint || token != nil {
            endpoint = next
            pendingHandoffToken = token
            webState = .loading
            webView = nil
            webViewID = UUID()
        }
        panelService = ServiceState(rawValue: desktop.status?.panelState ?? "") ?? .unavailable
        tmuxService = ServiceState(rawValue: desktop.status?.tmuxState ?? "") ?? .unavailable
    }

    func markLoading() {
        webState = .loading
    }

    func markReady() {
        webState = .ready
        navigateIfNeeded()
    }

    func markFailed(_ message: String) {
        webState = .failed(message)
    }

    func reload() {
        webState = .loading
        webView?.reload()
    }

    func toggleFullScreen() {
        webView?.window?.toggleFullScreen(nil)
    }

    func openInBrowser() {
        NSWorkspace.shared.open(endpoint.url)
    }

    func openLogs() {
        if desktop.isManaged {
            desktop.openPath(desktop.paths?.logs)
            return
        }
        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/tmux-web-panel")
        NSWorkspace.shared.open(logs)
    }

    func refreshServices() {
        Task {
            if desktop.isManaged {
                await desktop.refresh()
                applyDesktopState()
                return
            }
            async let panel = ServiceInspector.inspect(label: "com.tmux-web-panel")
            async let tmux = ServiceInspector.inspect(label: "com.tmux-web-panel.tmux-server")
            panelService = await panel
            tmuxService = await tmux
            desktop.updateLegacyServices(panel: panelService, tmux: tmuxService, endpoint: endpoint.url)
        }
    }

    func requestNotificationAuthorization() {
        Task {
            _ = await NativeNotificationCenter.shared.requestAuthorization()
            refreshNotificationStatus()
        }
    }

    func refreshNotificationStatus() {
        Task {
            notificationStatus = await NativeNotificationCenter.shared.authorizationStatus()
        }
    }

    private func openNotification(_ payload: NativeNotificationPayload) {
        pendingNavigation = payload
        NSApp.activate(ignoringOtherApps: true)
        NSApp.windows.first(where: { $0.canBecomeKey })?.makeKeyAndOrderFront(nil)
        navigateIfNeeded()
    }

    private func navigateIfNeeded() {
        guard webState == .ready,
              let webView,
              let payload = pendingNavigation else { return }

        let options: [String: Any] = [
            "currentSession": payload.session,
            "currentWindow": payload.windowIndex,
            "currentPane": NSNull(),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: options),
              let json = String(data: data, encoding: .utf8) else { return }

        let script = "typeof navigate === 'function' ? (navigate('terminal', \(json)), true) : false"
        webView.evaluateJavaScript(script) { [weak self] result, _ in
            Task { @MainActor in
                if (result as? Bool) == true { self?.pendingNavigation = nil }
            }
        }
    }
}
