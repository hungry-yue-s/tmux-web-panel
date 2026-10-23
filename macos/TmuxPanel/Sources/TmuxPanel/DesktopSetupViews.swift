import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI
import UniformTypeIdentifiers

private enum SetupStyle {
    static let accent = Color.accentColor
    static let line = Color.primary.opacity(0.1)
    static let surface = Color(nsColor: .controlBackgroundColor)
}

struct DesktopWelcomeView: View {
    @ObservedObject var setup: DesktopSetupManager
    @State private var username = "admin"
    @State private var password = ""
    @State private var confirmation = ""
    @State private var port = "17681"
    @State private var launchAtLogin = true
    @State private var showAdvanced = false

    private var valid: Bool {
        !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && password.count >= 8
            && password == confirmation && Int(port).map { (1024...65535).contains($0) } == true
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 28) {
                Image(nsImage: NSApplication.shared.applicationIconImage)
                    .resizable().frame(width: 76, height: 76)
                VStack(alignment: .leading, spacing: 12) {
                    Text("你的本机工作台。")
                        .font(.system(size: 29, weight: .semibold))
                    Text("终端、会话与文件\n从这里开始接续。")
                        .font(.system(size: 15)).foregroundStyle(.secondary).lineSpacing(6)
                }
                VStack(alignment: .leading, spacing: 18) {
                    step("person.crop.circle", "建立本机账号", "为工作台设置一个登录密码")
                    step("shippingbox", "准备内置组件", "服务端、Node 与 tmux 随客户端提供")
                    step("checkmark.circle", "检查并进入", "你能看到每一步的实际进度")
                }
                Spacer(minLength: 16)
                Text("无需 Homebrew、Xcode 或命令行安装。\n手机与远程访问可稍后配置。")
                    .font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(5)
            }
            .padding(36).frame(width: 300, alignment: .leading)
            .background(.ultraThinMaterial)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(setup.isBusy ? "正在准备工作台" : "先在这台 Mac 上开始")
                            .font(.system(size: 29, weight: .semibold))
                        Text("默认只有这台电脑能访问。初始化不会更改你已有的 tmux 设置或其他服务。")
                            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    if let error = setup.error { SetupErrorView(error: error, setup: setup) }
                    if setup.isBusy || !setup.events.isEmpty { SetupProgressView(setup: setup) }
                    if !setup.isBusy {
                        VStack(alignment: .leading, spacing: 16) {
                            setupField("登录账号") { TextField("例如 admin", text: $username) }
                            setupField("登录密码") { SecureField("至少 8 个字符", text: $password) }
                            setupField("再次输入密码") { SecureField("确认密码", text: $confirmation) }
                            if !confirmation.isEmpty && confirmation != password {
                                Label("两次输入的密码不一致", systemImage: "exclamationmark.circle")
                                    .font(.caption).foregroundStyle(.red)
                            }
                            Toggle("登录 Mac 后自动保持工作台可用", isOn: $launchAtLogin)
                            DisclosureGroup("高级选项", isExpanded: $showAdvanced) {
                                setupField("本机端口") { TextField("17681", text: $port).frame(width: 140) }
                                    .padding(.top, 12)
                                Text("建议保留默认值。如果端口被其他应用占用，可以换一个 1024–65535 之间的端口。")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .textFieldStyle(.roundedBorder)
                    }
                    HStack(spacing: 12) {
                        Button(setup.isBusy ? "正在初始化…" : setup.events.isEmpty ? "初始化工作台" : "重新初始化") {
                            var request = setup.request()
                            request.username = username.trimmingCharacters(in: .whitespacesAndNewlines)
                            request.password = password
                            request.port = Int(port)
                            request.listenOnLAN = false
                            request.launchAtLogin = launchAtLogin
                            Task {
                                if await setup.perform("initialize", request: request) {
                                    password = ""; confirmation = ""
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .disabled(!valid || setup.isBusy || !setup.bundledRuntimeAvailable || setup.status?.runtimeAvailable == false)
                        if setup.isBusy { ProgressView().controlSize(.small) }
                        Button("使用帮助") { setup.present(.help) }.buttonStyle(.link)
                    }
                    if setup.canUseLegacyService && !setup.isBusy && setup.configuration?.initialized != true {
                        Button("继续使用已有服务") { setup.useExistingWorkspace() }.buttonStyle(.link)
                    }
                    Text("密码只用于这台电脑的工作台。退出客户端不会结束会话；电脑关机仍会结束运行中的进程。")
                        .font(.caption).foregroundStyle(.secondary).lineSpacing(4)
                }
                .frame(maxWidth: 570, alignment: .leading).padding(40)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            username = setup.configuration?.username ?? "admin"
            port = String(setup.configuration?.initialized == true ? (setup.configuration?.port ?? 17681) : (setup.status?.suggestedPort ?? setup.configuration?.port ?? 17681))
            launchAtLogin = setup.configuration?.launchAtLogin ?? true
        }
    }

    private func step(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol).font(.system(size: 20)).foregroundStyle(SetupStyle.accent).frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 14, weight: .medium))
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct DesktopControlCenter: View {
    @ObservedObject var setup: DesktopSetupManager
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Tmux Panel").font(.system(size: 18, weight: .semibold)).padding(.bottom, 20)
                ForEach(DesktopControlSection.allCases) { section in
                    Button { setup.selectedSection = section } label: {
                        Label(section.rawValue, systemImage: section.symbol)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 9).padding(.horizontal, 10)
                            .background(setup.selectedSection == section ? SetupStyle.accent.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain).foregroundStyle(setup.selectedSection == section ? SetupStyle.accent : .primary)
                }
                Spacer()
                Label(setup.usesLegacyService ? "正在沿用现有服务" : "由客户端管理", systemImage: "desktopcomputer")
                    .font(.caption).foregroundStyle(.secondary)
                Text("关闭窗口不会停止后台任务。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(24).frame(width: 225).background(.ultraThinMaterial)
            Divider()
            VStack(spacing: 0) {
                HStack {
                    Text(setup.selectedSection.rawValue).font(.system(size: 23, weight: .semibold))
                    Spacer()
                    if setup.isBusy { ProgressView().controlSize(.small) }
                    Button("完成") { dismiss() }.disabled(setup.isBusy)
                }
                .padding(24)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if let error = setup.error { SetupErrorView(error: error, setup: setup) }
                        if let message = setup.successMessage, setup.error == nil {
                            Label(message, systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.callout)
                        }
                        switch setup.selectedSection {
                        case .overview: DesktopOverviewView(setup: setup)
                        case .settings: DesktopSettingsView(setup: setup)
                        case .remote: DesktopRemoteView(setup: setup)
                        case .help: DesktopHelpView(setup: setup)
                        }
                    }
                    .frame(maxWidth: 680, alignment: .leading).padding(24)
                }
            }
        }
        .frame(minWidth: 840, idealWidth: 960, minHeight: 590, idealHeight: 700)
        .background(Color(nsColor: .windowBackgroundColor))
        .interactiveDismissDisabled(setup.isBusy)
    }
}

private struct DesktopOverviewView: View {
    @ObservedObject var setup: DesktopSetupManager
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(setup.usesLegacyService ? "保留你正在使用的工作环境" : setup.isManaged ? "工作台就在这台 Mac 上" : "准备好后，一键开始")
                .font(.title3.weight(.semibold))
            Text(setup.usesLegacyService ? "检测到已有服务。客户端会继续使用它，不会替换配置、重启服务或更改已有 tmux 会话。" : "服务在后台运行，窗口只负责展示工作台。这里可以检查组件、查看日志，并管理客户端创建的面板服务。")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if setup.usesLegacyService {
                Button("创建独立管理的工作台") { setup.chooseIndependentWorkspace() }
                Text("新工作台使用独立配置与会话区，原安装和现有任务保持不变。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            VStack(spacing: 0) {
                component("内置 Node", value: setup.status?.nodeVersion ?? (setup.bundledRuntimeAvailable ? "已包含" : "未包含"), running: setup.bundledRuntimeAvailable)
                component("内置 tmux", value: setup.status?.tmuxVersion ?? "等待检查", running: setup.status?.tmuxVersion != nil)
                component("面板服务", value: stateLabel(setup.status?.panelState), running: setup.status?.panelState == "running")
                component("会话守护", value: stateLabel(setup.status?.tmuxState), running: setup.status?.tmuxState == "running")
            }
            .padding(.horizontal, 16).background(SetupStyle.surface, in: RoundedRectangle(cornerRadius: 14))
            if let endpoint = setup.status?.endpoint {
                LabeledContent("本机地址") { Text(endpoint).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
            }
            if setup.requiresRestart {
                Label(setup.status?.certificateNeedsRenewal == true ? "网络地址已变化，重启面板以更新连接证书。现有 tmux 会话会保留。" : "新配置已保存，重启面板服务后生效。现有 tmux 会话会保留。", systemImage: "arrow.clockwise.circle")
                    .foregroundStyle(.orange).font(.callout)
            }
            HStack {
                Button("重新检查") { Task { await setup.refresh() } }
                Button("查看日志") { setup.openPath(setup.paths?.logs) }.disabled(setup.paths?.logs == nil)
                Button("复制诊断摘要") { setup.copyDiagnostics() }
            }
            .disabled(setup.isBusy)
            if setup.isManaged {
                HStack {
                    Button("启动面板") { Task { await setup.perform("start") } }
                    Button("重启面板") { Task { await setup.perform("restart") } }
                    Button("停止面板") { Task { await setup.perform("stop") } }
                }
                .disabled(setup.isBusy)
                Text("这些操作只影响网页连接，不会结束 tmux 里的任务。电脑重新启动后，应用可以恢复工作台服务，但不会恢复进程内存。")
                    .font(.caption).foregroundStyle(.secondary)
                Divider()
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(setup.status?.runtimeUpdateAvailable == true ? "有可用的内置组件更新" : "内置组件维护").font(.headline)
                        if let build = setup.status?.runtimeBuildId { Text("当前版本：\(build)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                    }
                    Spacer()
                    Button("更新/修复内置组件") { Task { await setup.perform("repair") } }.disabled(setup.isBusy)
                }
                Text("工作台网页会短暂重连，现有配置和任务会保留。如果新安装包需要更换仍在使用的 tmux 会话引擎，客户端会保留当前任务并提示下一步。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !setup.usesLegacyService && !setup.events.isEmpty { SetupProgressView(setup: setup) }
            if let logs = setup.paths?.logs {
                DisclosureGroup("查看最近日志") { DesktopLogPreview(directory: logs).padding(.top, 12) }
            }
        }
    }

    private func component(_ title: String, value: String, running: Bool) -> some View {
        HStack {
            Image(systemName: running ? "checkmark.circle.fill" : "circle").foregroundStyle(running ? .green : .secondary)
            Text(title)
            Spacer()
            Text(value).foregroundStyle(.secondary).textSelection(.enabled)
        }
        .padding(.vertical, 15).overlay(alignment: .bottom) { Rectangle().fill(SetupStyle.line).frame(height: 1) }
    }

    private func stateLabel(_ raw: String?) -> String {
        switch raw {
        case "running", "active": "运行中"
        case "stopped", "not-installed", "unloaded": "未运行"
        case "checking": "检查中"
        default: setup.usesLegacyService ? "由原安装管理" : "等待检查"
        }
    }
}

private struct DesktopSettingsView: View {
    @ObservedObject var setup: DesktopSetupManager
    @State private var username = "admin"
    @State private var password = ""
    @State private var port = "17681"
    @State private var listenOnLAN = false
    @State private var launchAtLogin = true
    @State private var importedRelay: DesktopSetupRequest.Relay?
    @State private var fileMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if setup.usesLegacyService {
                Text("当前使用的是已有服务。为了保护正在运行的任务，这里不会修改它的安装配置。")
                    .foregroundStyle(.secondary)
                Button("打开原配置目录") { setup.openPath(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/tmux-web-panel").path) }
                Divider()
                Text("也可以创建一个由新版客户端独立管理的工作台。它使用另一套配置和会话区，原来的服务与任务会继续运行，不会被迁移或替换。")
                    .foregroundStyle(.secondary)
                Button("创建独立管理的工作台") { setup.chooseIndependentWorkspace() }
            } else if !setup.isManaged {
                Text("完成首次初始化后，可以在这里统一管理设置。")
            } else {
                setupField("登录账号") { TextField("账号", text: $username) }
                setupField("更改密码") { SecureField("留空则保留当前密码", text: $password) }
                Text("更改账号或密码并应用后，已登录的客户端和其他设备需要使用新账号密码重新登录。")
                    .font(.caption).foregroundStyle(.secondary)
                setupField("面板端口") { TextField("17681", text: $port).frame(width: 140) }
                Toggle("登录 Mac 后自动启动服务", isOn: $launchAtLogin)
                Toggle("允许同一网络的手机或其他电脑连接", isOn: $listenOnLAN)
                Text(listenOnLAN ? "开启后需要工作台账号与密码。手机需与电脑网络互通，并安装本机 CA 证书。公网访问还需要可达网络或 VPN。" : "当前只允许这台 Mac 访问。在原生客户端内使用时，HTTPS 证书会自动校验，不必导入证书；改用浏览器访问时，可能需要信任本机 CA。DNS 与 GitHub Pages 都可跳过。")
                    .font(.callout).foregroundStyle(.secondary)
                Button("保存设置") {
                    var request = setup.request()
                    request.username = username
                    request.password = password.isEmpty ? nil : password
                    request.port = Int(port)
                    request.listenOnLAN = listenOnLAN
                    request.launchAtLogin = launchAtLogin
                    request.relay = importedRelay
                    Task { if await setup.perform("save", request: request) { password = "" } }
                }
                .buttonStyle(.borderedProminent)
                .disabled(setup.isBusy || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || Int(port).map { (1024...65535).contains($0) } != true || (!password.isEmpty && password.count < 8))
                if setup.requiresRestart {
                    HStack {
                        Text("设置已保存，等待重启面板服务。").foregroundStyle(.secondary)
                        Button("应用并重启面板") { Task { await setup.perform("restart") } }.disabled(setup.isBusy)
                    }
                }
                Text("账号、端口、联网方式都保存在同一份配置。配置导出不会包含密码或 DNS Token。")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("导入无凭据配置") { importConfiguration() }
                    Button("导出无凭据配置") { exportConfiguration() }
                }.disabled(setup.isBusy)
                if let fileMessage { Text(fileMessage).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            }
        }
        .textFieldStyle(.roundedBorder)
        .onAppear { load() }
    }

    private func load() {
        username = setup.configuration?.username ?? "admin"
        port = String(setup.configuration?.port ?? 17681)
        listenOnLAN = setup.configuration?.listenOnLAN ?? false
        launchAtLogin = setup.configuration?.launchAtLogin ?? true
    }

    private func exportConfiguration() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Tmux-Panel-settings.json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let safe: [String: Any] = [
            "schemaVersion": 1, "port": Int(port) ?? 17681, "listenOnLAN": listenOnLAN,
            "launchAtLogin": launchAtLogin, "username": username,
            "relay": ["enabled": setup.configuration?.relay?.enabled ?? false,
                      "domain": setup.configuration?.relay?.domain ?? "",
                      "pagesURL": setup.configuration?.relay?.pagesURL ?? ""],
        ]
        do { try JSONSerialization.data(withJSONObject: safe, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic) }
        catch { fileMessage = "无法保存配置：" + error.localizedDescription }
    }

    private func importConfiguration() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try Data(contentsOf: url)
            guard data.count < 1_000_000 else { fileMessage = "配置文件过大，请选择客户端导出的设置文件。"; return }
            let value = try JSONDecoder().decode(DesktopConfiguration.self, from: data)
            guard let importedPort = value.port, (1024...65535).contains(importedPort) else {
                fileMessage = "配置中的端口无效，请选择客户端导出的设置文件。"; return
            }
            username = value.username ?? username
            port = String(importedPort)
            listenOnLAN = value.listenOnLAN ?? listenOnLAN
            launchAtLogin = value.launchAtLogin ?? launchAtLogin
            if let relay = value.relay {
                importedRelay = DesktopSetupRequest.Relay(enabled: relay.enabled ?? false, domain: relay.domain ?? "", pagesURL: relay.pagesURL ?? "", duckdnsToken: nil)
            }
            fileMessage = "已读入配置，检查后点击“保存设置”应用。密码和 DNS Token 不会导入。" + (importedRelay?.enabled == true ? "远程入口：\(importedRelay?.pagesURL ?? "")" : "")
        } catch { fileMessage = "无法读取配置：" + error.localizedDescription }
    }
}

private struct DesktopRemoteView: View {
    @ObservedObject var setup: DesktopSetupManager
    @State private var enabled = false
    @State private var domain = ""
    @State private var pagesURL = ""
    @State private var token = ""
    @State private var certificateError: String?

    private var connectionURL: String? {
        guard !setup.requiresRestart, setup.status?.panelState == "running" else { return nil }
        let page = setup.configuration?.relay?.pagesURL ?? ""
        if setup.configuration?.relay?.enabled == true && !page.isEmpty { return page }
        return setup.status?.lanEndpoint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
                Text("先让手机找到这台电脑") .font(.title3.weight(.semibold))
                Text("这是选配功能。本机使用可以完全跳过。最简单的方式是手机与 Mac 连同一 Wi-Fi，并在基础设置中允许局域网访问。")
                    .foregroundStyle(.secondary)
                Label("DNS 和引导网页负责找到地址，不会打通公网或绕过路由器。换到其他网络时，仍需电脑可达或已连接 VPN。", systemImage: "network")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let url = connectionURL {
                HStack(alignment: .top, spacing: 20) {
                    if let image = qrImage(url) { Image(nsImage: image).interpolation(.none).resizable().frame(width: 132, height: 132).padding(10).background(.white, in: RoundedRectangle(cornerRadius: 12)).accessibilityLabel("Android 客户端注册链接二维码") }
                    VStack(alignment: .leading, spacing: 10) {
                        Text("在 Android 客户端扫描注册").font(.headline)
                        Text(url).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                        Text("二维码只包含连接地址，不含登录密码或会话凭据。电脑需保持开机且网络可达。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else if setup.isManaged {
                Label(setup.requiresRestart ? "先应用并重启面板，再生成手机连接二维码。" : "启动面板服务后，才能生成当前可用的手机连接二维码。", systemImage: "info.circle")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let certificateError { Text(certificateError).foregroundStyle(.red).font(.callout) }
            Divider()
            guideStep("1", title: "同一 Wi-Fi 直接连接", detail: "在基础设置开启局域网访问并应用配置；如果浏览器提示不信任，先把本机 CA 证书传到手机并在系统设置安装。") {
                HStack {
                    Button("去基础设置") { setup.selectedSection = .settings }
                    Button("导出手机 CA 证书") { exportCertificate() }.disabled(setup.paths?.caCertificate == nil)
                    Link("Android 证书说明", destination: URL(string: "https://support.google.com/pixelphone/answer/2844832")!)
                }
            }
            guideStep("2", title: "让入口不随电脑地址变化（可选）", detail: "DuckDNS 保存电脑当前地址；引导网页会查询它。请登录 DuckDNS，创建一个自己的子域名，再把子域名和 Token 填到下方。") {
                Link("打开 DuckDNS", destination: URL(string: "https://www.duckdns.org/")!)
            }
            if setup.isManaged {
                Toggle("启用固定引导入口", isOn: $enabled)
                if enabled {
                    VStack(alignment: .leading, spacing: 14) {
                        setupField("DuckDNS 子域名") { TextField("例如 my-workbench，不含 .duckdns.org", text: $domain) }
                        setupField("DuckDNS Token") { SecureField(setup.configuration?.relay?.hasToken == true ? "已保存，留空则保留" : "从 DuckDNS 账户页复制", text: $token) }
                        setupField("引导网页地址") { TextField("https://你的用户名.github.io/你的仓库/", text: $pagesURL) }
                    }
                    .textFieldStyle(.roundedBorder)
                }
                HStack {
                    Button("保存远程访问设置") {
                        var request = setup.request()
                        request.relay = DesktopSetupRequest.Relay(enabled: enabled, domain: domain, pagesURL: pagesURL, duckdnsToken: token.isEmpty ? nil : token)
                        Task { if await setup.perform("save", request: request) { token = "" } }
                    }
                    Button("更新 DNS 地址") { Task { await setup.perform("update-dns") } }.disabled(setup.configuration?.relay?.enabled != true)
                }
                .disabled(setup.isBusy)
            } else {
                Text("现有服务的远程访问配置由原安装管理；此窗口只提供说明，不会覆盖它的证书、DNS 或引导网页。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            guideStep("3", title: "发布属于你的引导网页（可选）", detail: "登录 GitHub，新建公开仓库；导出引导网页后，把目录里的网页、脚本和公开 CA 证书上传到仓库。然后进入仓库 Settings → Pages，选择 Deploy from a branch，分支 main，目录 / (root)，保存并等待部署完成。") {
                HStack {
                    Link("新建 GitHub 仓库", destination: URL(string: "https://github.com/new")!)
                    Link("GitHub Pages 官方说明", destination: URL(string: "https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site")!)
                }
                if setup.isManaged {
                    HStack {
                        Button("导出引导网页") { Task { if await setup.perform("export-relay") { setup.openPath(setup.paths?.relaySite) } } }.disabled(setup.isBusy)
                        Button("打开导出目录") { setup.openPath(setup.paths?.relaySite) }.disabled(setup.paths?.relaySite == nil)
                    }
                }
                Text("只上传导出目录中的文件，不要上传配置文件、Token、私钥或整个应用数据目录。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear {
            enabled = setup.configuration?.relay?.enabled ?? false
            domain = setup.configuration?.relay?.domain ?? ""
            pagesURL = setup.configuration?.relay?.pagesURL ?? ""
        }
    }

    private func guideStep<Content: View>(_ number: String, title: String, detail: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text(number).font(.system(size: 12, weight: .semibold)).frame(width: 24, height: 24)
                .background(SetupStyle.accent.opacity(0.1), in: Circle()).foregroundStyle(SetupStyle.accent)
            VStack(alignment: .leading, spacing: 10) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                content()
            }
        }
    }

    private func qrImage(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        guard let image = filter.outputImage,
              let cgImage = CIContext().createCGImage(image, from: image.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: image.extent.width, height: image.extent.height))
    }

    private func exportCertificate() {
        guard let path = setup.paths?.caCertificate else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Tmux-Panel-CA.crt"
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do { try Data(contentsOf: URL(fileURLWithPath: path)).write(to: destination, options: .atomic) }
        catch { certificateError = "无法导出手机证书：" + error.localizedDescription }
    }
}

private struct DesktopHelpView: View {
    @ObservedObject var setup: DesktopSetupManager
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            help("下载后无法打开", "请把客户端移到“应用程序”，下载与你的 Mac 芯片匹配的安装包。未公证的开发预览包可能需要先确认 GitHub 发布来源，再到系统设置的“隐私与安全性”选择“仍要打开”。无需关闭系统安全机制；正式签名与公证状态以发布说明为准。")
            help("初始化显示端口被占用", "换一个端口再重试。客户端不会关闭占用端口的其他应用，也不会替换已有服务。")
            help("第一次进入没有会话", "这是正常状态。在工作台里新建会话和窗口，就可以开始输入命令；客户端不会在后台擅自创建会话或改变你已有的终端环境。")
            help("关闭窗口后任务还在吗？", "关闭窗口或退出客户端不会结束 tmux 中的任务。电脑关机或重启会结束正在运行的进程；重新登录后只会恢复工作台服务。")
            help("手机连不上", "确认电脑开机、局域网访问已开启且已应用设置。手机与电脑需网络互通；访客 Wi-Fi、路由器设备隔离、防火墙、VPN 路由和电脑睡眠都可能阻止连接。固定引导入口不提供公网穿透。")
            help("部分文件夹无法访问", "桌面、文稿、外置磁盘等位置可能受 macOS 隐私权限保护。先使用普通项目目录；确实需要访问受保护目录时，再到系统设置的隐私与安全性中查看相应授权，不必为首次初始化预先开放所有权限。")
            help("浏览器提示证书不受信任", "原生客户端会校验本机证书，但浏览器不会继承这种校验。可从“手机与远程访问”导出自己工作台的 CA 证书，再按系统说明添加信任；仅在原生客户端内使用可跳过。")
            Link("Apple 证书导入说明", destination: URL(string: "https://support.apple.com/guide/keychain-access/add-certificates-to-a-keychain-kyca2431/mac")!)
            help("密码忘了或服务异常", "客户端管理的安装可以在基础设置重设工作台密码。先看运行状态与日志，再重启面板；重启面板不会结束 tmux 会话。不要删除整个数据目录来修复问题。")
            HStack {
                Button("复制诊断摘要") { setup.copyDiagnostics() }
                Button("查看日志") { setup.openPath(setup.paths?.logs) }.disabled(setup.paths?.logs == nil)
                Link("GitHub 下载与说明", destination: URL(string: "https://github.com/hungry-yue-s/tmux-web-panel/releases")!)
            }
        }
    }
    private func help(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 7) { Text(title).font(.headline); Text(detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
    }
}

private struct DesktopLogPreview: View {
    let directory: String
    @State private var file = "panel.stderr.log"
    @State private var text = "选择日志并点击读取。"
    @State private var isReading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Picker("日志来源", selection: $file) {
                    Text("面板错误").tag("panel.stderr.log")
                    Text("会话守护错误").tag("tmux.stderr.log")
                    Text("面板输出").tag("panel.stdout.log")
                }.labelsHidden()
                Button(isReading ? "正在读取…" : "读取/刷新") {
                    let path = URL(fileURLWithPath: directory, isDirectory: true).appendingPathComponent(file).path
                    isReading = true
                    Task {
                        text = await Task.detached(priority: .utility) { Self.tail(path) }.value
                        isReading = false
                    }
                }.disabled(isReading)
            }
            ScrollView([.horizontal, .vertical]) {
                Text(text).font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(12)
            }
            .frame(height: 210).background(SetupStyle.surface, in: RoundedRectangle(cornerRadius: 10))
            Text("只读取最近 64 KB，最多显示 200 行。复制诊断摘要不会包含日志正文。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    nonisolated private static func tail(_ path: String) -> String {
        do {
            let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
            defer { try? file.close() }
            let length = try file.seekToEnd()
            let offset = length > 65_536 ? length - 65_536 : 0
            try file.seek(toOffset: offset)
            let data = try file.read(upToCount: 65_536) ?? Data()
            var lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)
            if offset > 0 && !lines.isEmpty { lines.removeFirst() }
            let text = lines.suffix(200).joined(separator: "\n")
            return text.isEmpty ? "暂时没有日志。" : text
        } catch { return "暂时无法读取此日志：" + error.localizedDescription }
    }
}

private struct SetupProgressView: View {
    @ObservedObject var setup: DesktopSetupManager
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if setup.isBusy && setup.events.isEmpty { ProgressView("正在检查安装环境…") }
            ForEach(setup.events) { event in
                HStack(alignment: .top, spacing: 12) {
                    if event.status == "running" && setup.isBusy { ProgressView().controlSize(.small).frame(width: 20) }
                    else { Image(systemName: symbol(event.status)).foregroundStyle(color(event.status)).frame(width: 20) }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(event.title).font(.system(size: 13, weight: .medium))
                        if let message = event.message { Text(message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                    }
                }
            }
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(SetupStyle.surface, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
    }
    private func symbol(_ status: String) -> String { ["complete", "completed", "done", "success"].contains(status) ? "checkmark.circle.fill" : ["error", "failed"].contains(status) ? "exclamationmark.circle.fill" : "circle" }
    private func color(_ status: String) -> Color { ["complete", "completed", "done", "success"].contains(status) ? .green : ["error", "failed"].contains(status) ? .red : .secondary }
}

private struct SetupErrorView: View {
    let error: DesktopSetupError
    @ObservedObject var setup: DesktopSetupManager
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(error.message ?? "操作未完成", systemImage: "exclamationmark.circle.fill").font(.headline)
            if let action = error.action { Text(action).font(.callout).foregroundStyle(.secondary).textSelection(.enabled) }
            HStack { Button("复制诊断摘要") { setup.copyDiagnostics() }; Button("查看日志") { setup.openPath(setup.paths?.logs) }.disabled(setup.paths?.logs == nil) }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

@ViewBuilder
private func setupField<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 6) { Text(title).font(.system(size: 13, weight: .medium)); content() }
}
