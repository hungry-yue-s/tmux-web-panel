import AppKit
import SwiftUI

@main
struct TmuxPanelApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window("Tmux Panel", id: "panel") {
            PanelRootView()
                .environmentObject(model)
        }
        .defaultSize(width: 1280, height: 820)
        .windowStyle(.hiddenTitleBar)
        .commands {
            PanelCommands(model: model)
        }

        MenuBarExtra {
            StatusMenuView()
                .environmentObject(model)
        } label: {
            Label("Tmux Panel", systemImage: model.menuBarSymbol)
        }
        .menuBarExtraStyle(.menu)
    }
}

struct PanelRootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        PanelContentView(model: model, setup: model.desktop)
    }
}

private struct PanelContentView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var setup: DesktopSetupManager

    var body: some View {
        ZStack {
            if setup.isChecking {
                ProgressView("正在检查本机工作台…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if setup.needsSetup {
                DesktopWelcomeView(setup: setup)
            } else {
                PanelWebView(model: model)
                    .id(model.webViewID).ignoresSafeArea()
                if case let .failed(message) = model.webState {
                    ConnectionFailureView(message: message)
                        .environmentObject(model)
                }
            }
        }
        .frame(minWidth: 760, minHeight: 520)
        .sheet(isPresented: $setup.isPresented) { DesktopControlCenter(setup: setup) }
    }
}

struct ConnectionFailureView: View {
    @EnvironmentObject private var model: AppModel
    let message: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 34))
                .foregroundStyle(.orange)
            Text("无法连接 Tmux Panel")
                .font(.title2.bold())
            Text(model.endpoint.url.absoluteString)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            HStack {
                Button("重新加载") { model.reload() }
                    .keyboardShortcut(.defaultAction)
                Button("在浏览器中打开") { model.openInBrowser() }
                Button("设置与运行状态") { model.desktop.present() }
            }
        }
        .padding(30)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 18)
    }
}

struct StatusMenuView: View {
    @Environment(\.openWindow) private var openWindow
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Button("显示 Tmux Panel") {
            openWindow(id: "panel")
            NSApp.activate(ignoringOtherApps: true)
        }

        Divider()

        StatusRow(title: "网页", value: model.webState.title, running: model.webState == .ready)
        StatusRow(title: "面板服务", value: model.panelService.title, running: model.panelService == .running)
        StatusRow(title: "tmux companion", value: model.tmuxService.title, running: model.tmuxService == .running)

        Text(model.endpoint.url.absoluteString)
            .font(.caption.monospaced())

        Divider()

        Button(model.notificationStatusTitle) {
            model.requestNotificationAuthorization()
        }
        .disabled(model.notificationStatus == .authorized)

        Button("重新加载网页") { model.reload() }
            .keyboardShortcut("r", modifiers: .command)
        Button("切换全屏") { model.toggleFullScreen() }
            .keyboardShortcut("f", modifiers: [.command, .control])
        Button("刷新服务状态") { model.refreshServices() }
        Button("设置与运行状态…") {
            openWindow(id: "panel")
            NSApp.activate(ignoringOtherApps: true)
            model.desktop.present()
        }
        Button("在浏览器中打开") { model.openInBrowser() }
        Button("打开日志目录") { model.openLogs() }

        Divider()

        Button("退出 Tmux Panel") { NSApp.terminate(nil) }
            .keyboardShortcut("q", modifiers: .command)
    }
}

struct StatusRow: View {
    let title: String
    let value: String
    let running: Bool

    var body: some View {
        HStack {
            Image(systemName: running ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(running ? .green : .secondary)
            Text(title)
            Spacer()
            Text(value)
                .foregroundStyle(.secondary)
        }
    }
}

struct PanelCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            Button("设置与运行状态…") { model.desktop.present() }
                .keyboardShortcut(",", modifiers: .command)
            Button("重新加载面板") { model.reload() }
                .keyboardShortcut("r", modifiers: .command)
            Button("切换全屏") { model.toggleFullScreen() }
                .keyboardShortcut("f", modifiers: [.command, .control])
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NativeNotificationCenter.shared.installDelegate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
