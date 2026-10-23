import AppKit
import Combine
import Foundation

struct DesktopRelayConfiguration: Decodable, Sendable {
    var enabled: Bool?
    var domain: String?
    var pagesURL: String?
    var hasToken: Bool?
}

struct DesktopConfiguration: Decodable, Sendable {
    var schemaVersion: Int?
    var port: Int?
    var listenOnLAN: Bool?
    var launchAtLogin: Bool?
    var username: String?
    var relay: DesktopRelayConfiguration?
    var initialized: Bool?
}

struct DesktopRuntimeStatus: Decodable, Sendable {
    var managedInstalled: Bool?
    var runtimeAvailable: Bool?
    var legacyInstalled: Bool?
    var portAvailable: Bool?
    var endpoint: String?
    var lanEndpoint: String?
    var runtimeError: String?
    var suggestedPort: Int?
    var certificateNeedsRenewal: Bool?
    var runtimeUpdateAvailable: Bool?
    var runtimeBuildId: String?
    var bundledBuildId: String?
    var nodeVersion: String?
    var tmuxVersion: String?
    var panelState: String?
    var tmuxState: String?
}

struct DesktopSetupPaths: Decodable, Sendable {
    var configuration: String?
    var logs: String?
    var events: String?
    var relaySite: String?
    var tlsCertificate: String?
    var caCertificate: String?
}

struct DesktopSetupEvent: Decodable, Identifiable, Sendable {
    var id: String
    var title: String
    var status: String
    var message: String?
    var at: String?
}

struct DesktopSetupError: Decodable, Sendable {
    var code: String?
    var message: String?
    var action: String?
}

struct DesktopSetupResult: Decodable, Sendable {
    var ok: Bool
    var error: DesktopSetupError?
    var configuration: DesktopConfiguration?
    var status: DesktopRuntimeStatus?
    var paths: DesktopSetupPaths?
    var events: [DesktopSetupEvent]?
    var requiresRestart: Bool?
    var sessionToken: String?
    var message: String?
}

struct DesktopSetupRequest: Encodable, Sendable {
    struct Relay: Encodable, Sendable {
        var enabled: Bool
        var domain: String
        var pagesURL: String
        var duckdnsToken: String?
    }
    var dataDir: String
    var runtimePath: String
    var username: String?
    var password: String?
    var port: Int?
    var listenOnLAN: Bool?
    var launchAtLogin: Bool?
    var relay: Relay?
}

enum DesktopHelper {
    static func run(command: String, request: DesktopSetupRequest) async throws -> DesktopSetupResult {
        try await Task.detached(priority: .utility) {
            let runtime = URL(fileURLWithPath: request.runtimePath, isDirectory: true)
            let node = runtime.appendingPathComponent("bin/node")
            let script = runtime.appendingPathComponent("app/scripts/desktop-runtime.mjs")
            guard FileManager.default.isExecutableFile(atPath: node.path),
                  FileManager.default.fileExists(atPath: script.path) else {
                throw CocoaError(.fileNoSuchFile)
            }
            let process = Process()
            let input = Pipe()
            let output = Pipe()
            process.executableURL = node
            process.arguments = [script.path, command]
            process.standardInput = input
            process.standardOutput = output
            // The helper returns sanitized, actionable errors in JSON. Avoid
            // showing an accidental runtime stack trace or credential in UI.
            process.standardError = FileHandle.nullDevice
            try process.run()
            try input.fileHandleForWriting.write(contentsOf: JSONEncoder().encode(request))
            try input.fileHandleForWriting.close()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return try JSONDecoder().decode(DesktopSetupResult.self, from: data)
        }.value
    }
}

@MainActor
final class DesktopSetupManager: ObservableObject {
    @Published private(set) var configuration: DesktopConfiguration?
    @Published private(set) var status: DesktopRuntimeStatus?
    @Published private(set) var paths: DesktopSetupPaths?
    @Published private(set) var events: [DesktopSetupEvent] = []
    @Published private(set) var error: DesktopSetupError?
    @Published private(set) var successMessage: String?
    @Published private(set) var isBusy = false
    @Published private(set) var isChecking = true
    @Published private(set) var requiresRestart = false
    @Published private(set) var revision = 0
    @Published var isPresented = false
    @Published var selectedSection: DesktopControlSection = .overview

    let dataDirectory: URL
    let runtimeDirectory: URL
    private(set) var usesLegacyService: Bool
    let canUseLegacyService: Bool
    private var pendingSessionToken: String?
    private var timer: Timer?
    private var tick = 0
    private var inspecting = false
    private var operationGeneration = 0

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        let home = FileManager.default.homeDirectoryForCurrentUser
        dataDirectory = environment["TMUX_PANEL_DATA_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? home.appendingPathComponent("Library/Application Support/Tmux Panel", isDirectory: true)
        runtimeDirectory = environment["TMUX_PANEL_RUNTIME_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("runtime", isDirectory: true)
        let hasLegacyAgent = FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/LaunchAgents/com.tmux-web-panel.plist").path)
        let hasManagedConfiguration = FileManager.default.fileExists(atPath: dataDirectory.appendingPathComponent("settings.json").path)
        canUseLegacyService = environment["TMUX_PANEL_URL"] != nil || (environment["TMUX_PANEL_DATA_DIR"] == nil && hasLegacyAgent)
        usesLegacyService = environment["TMUX_PANEL_URL"] != nil || (!hasManagedConfiguration && environment["TMUX_PANEL_DATA_DIR"] == nil && hasLegacyAgent)
        if usesLegacyService { isChecking = false }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.readEvents()
                self.tick += 1
                if self.tick % 5 == 0 && !self.isBusy { await self.refresh() }
            }
        }
        Task { await refresh() }
    }

    var isManaged: Bool { configuration?.initialized == true && !usesLegacyService }
    var needsSetup: Bool { !usesLegacyService && configuration?.initialized != true }
    var bundledRuntimeAvailable: Bool {
        FileManager.default.isExecutableFile(atPath: runtimeDirectory.appendingPathComponent("bin/node").path)
            && FileManager.default.fileExists(atPath: runtimeDirectory.appendingPathComponent("app/scripts/desktop-runtime.mjs").path)
    }
    var endpoint: PanelEndpoint? {
        guard isManaged, let raw = status?.endpoint, let url = PanelEndpointResolver.normalizedURL(raw) else { return nil }
        let pin = paths?.tlsCertificate.flatMap { PanelEndpointResolver.loadCertificateDER(at: $0) }
        return PanelEndpoint(url: url, pinnedCertificateDER: pin)
    }

    func takeSessionToken() -> String? {
        defer { pendingSessionToken = nil }
        return pendingSessionToken
    }

    func updateLegacyServices(panel: ServiceState, tmux: ServiceState, endpoint: URL) {
        guard usesLegacyService else { return }
        var value = status ?? DesktopRuntimeStatus()
        value.panelState = panel.rawValue
        value.tmuxState = tmux.rawValue
        value.endpoint = endpoint.absoluteString
        status = value
    }

    func request() -> DesktopSetupRequest {
        DesktopSetupRequest(dataDir: dataDirectory.path, runtimePath: runtimeDirectory.path)
    }

    func chooseIndependentWorkspace() {
        usesLegacyService = false
        configuration = nil
        events = []
        error = nil
        successMessage = nil
        isPresented = false
        revision += 1
        Task { await refresh() }
    }

    func useExistingWorkspace() {
        guard canUseLegacyService, !isBusy else { return }
        usesLegacyService = true
        error = nil
        revision += 1
    }

    func refresh() async {
        guard !inspecting, !isBusy else { return }
        guard bundledRuntimeAvailable else {
            isChecking = false
            if !usesLegacyService {
                error = DesktopSetupError(code: "RUNTIME_MISSING", message: "这个安装包没有包含运行组件。请下载与你的 Mac 芯片匹配的完整版客户端。", action: "打开 GitHub 下载页，选择 Apple Silicon 或 Intel 安装包。")
            }
            return
        }
        inspecting = true
        let generation = operationGeneration
        defer { inspecting = false; isChecking = false }
        do {
            let result = try await DesktopHelper.run(command: "inspect", request: request())
            guard generation == operationGeneration, !isBusy else { return }
            apply(result, showError: false)
        }
        catch { if !usesLegacyService { self.error = helperError(error) } }
    }

    @discardableResult
    func perform(_ command: String, request: DesktopSetupRequest? = nil) async -> Bool {
        guard !isBusy else { return false }
        isBusy = true
        operationGeneration += 1
        error = nil
        successMessage = nil
        if command == "initialize" { events = [] }
        defer { isBusy = false; isChecking = false }
        do {
            let result = try await DesktopHelper.run(command: command, request: request ?? self.request())
            apply(result, showError: true)
            if result.ok {
                let messages = ["save": "设置已保存。", "start": "面板服务已启动。", "stop": "面板服务已停止，tmux 会话仍保留。", "restart": "面板服务已重启。", "repair": "内置组件已更新或修复。", "update-dns": "当前地址已更新到 DuckDNS。", "export-relay": "引导网页已导出。"]
                successMessage = result.message ?? messages[command]
            }
            readEvents()
            return result.ok
        } catch {
            self.error = helperError(error)
            return false
        }
    }

    func present(_ section: DesktopControlSection = .overview) {
        selectedSection = section
        isPresented = true
        Task { await refresh() }
    }

    func openPath(_ path: String?) {
        guard let path else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    func copyDiagnostics() {
        let rows = [
            "Tmux Panel \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development")",
            "macOS \(ProcessInfo.processInfo.operatingSystemVersionString)",
            "安装方式: \(usesLegacyService ? "现有服务" : "客户端管理")",
            "地址: \(diagnosticEndpoint())",
            "Node: \(status?.nodeVersion ?? "未检测")",
            "tmux: \(status?.tmuxVersion ?? "未检测")",
            "面板: \(status?.panelState ?? "未检测") / tmux: \(status?.tmuxState ?? "未检测")",
            "错误: \(error?.code ?? "无") \(error?.message ?? "")",
        ]
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(rows.joined(separator: "\n"), forType: .string)
    }

    private func diagnosticEndpoint() -> String {
        guard let raw = status?.endpoint, var url = URLComponents(string: raw) else { return "未初始化" }
        url.user = nil; url.password = nil; url.query = nil; url.fragment = nil
        return url.string ?? "未初始化"
    }

    private func apply(_ result: DesktopSetupResult, showError: Bool) {
        if let configuration = result.configuration { self.configuration = configuration }
        if var status = result.status {
            if usesLegacyService {
                status.panelState = self.status?.panelState ?? "checking"
                status.tmuxState = self.status?.tmuxState ?? "checking"
                status.endpoint = self.status?.endpoint
            }
            self.status = status
        }
        if var paths = result.paths {
            if usesLegacyService {
                paths.logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/tmux-web-panel").path
                paths.tlsCertificate = nil
                paths.caCertificate = nil
                paths.relaySite = nil
            }
            self.paths = paths
        }
        if let events = result.events { self.events = Self.latestEvents(events) }
        if let requiresRestart = result.requiresRestart { self.requiresRestart = requiresRestart }
        if let token = result.sessionToken { pendingSessionToken = token }
        if showError || !result.ok { error = result.ok ? nil : result.error }
        if result.status?.runtimeAvailable == false, let reason = result.status?.runtimeError {
            error = DesktopSetupError(code: "RUNTIME_UNAVAILABLE", message: "内置组件未通过检查。", action: reason)
        }
        revision += 1
    }

    private func readEvents() {
        guard isBusy else { return }
        let url = paths?.events.map { URL(fileURLWithPath: $0) }
            ?? dataDirectory.appendingPathComponent("setup-events.jsonl")
        guard let data = try? Data(contentsOf: url), data.count < 2_000_000,
              let text = String(data: data, encoding: .utf8) else { return }
        events = Self.latestEvents(text.split(separator: "\n").compactMap {
            try? JSONDecoder().decode(DesktopSetupEvent.self, from: Data($0.utf8))
        })
    }

    static func latestEvents(_ records: [DesktopSetupEvent]) -> [DesktopSetupEvent] {
        var ordered: [DesktopSetupEvent] = []
        for event in records {
            if let index = ordered.firstIndex(where: { $0.id == event.id }) { ordered[index] = event }
            else { ordered.append(event) }
        }
        return ordered
    }

    private func helperError(_ error: Error) -> DesktopSetupError {
        DesktopSetupError(code: "HELPER_UNAVAILABLE", message: "无法读取内置组件的运行结果。", action: "请检查安装包是否完整、芯片版本是否匹配，然后重试。错误：\(error.localizedDescription)")
    }
}

enum DesktopControlSection: String, CaseIterable, Identifiable {
    case overview = "运行状态"
    case settings = "基础设置"
    case remote = "手机与远程访问"
    case help = "使用帮助"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .overview: "waveform.path.ecg"
        case .settings: "slider.horizontal.3"
        case .remote: "iphone.and.arrow.forward"
        case .help: "questionmark.circle"
        }
    }
}
