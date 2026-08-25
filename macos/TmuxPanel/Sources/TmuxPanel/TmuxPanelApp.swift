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
        ZStack {
            PanelWebView(model: model)
            if case let .failed(message) = model.webState {
                ConnectionFailureView(message: message)
                    .environmentObject(model)
            }
        }
        .frame(minWidth: 760, minHeight: 520)
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
        NSApp.applicationIconImage = AppIcon.make()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

enum AppIcon {
    @MainActor
    static func make() -> NSImage {
        let size = NSSize(width: 512, height: 512)
        let image = NSImage(size: size)
        image.lockFocus()

        // Runtime-provided Dock icons are not given the automatic safe margin
        // applied to asset-catalog icons. Keep the artwork inside an 82% tile
        // so its visual size matches neighboring macOS app icons.
        let artworkScale: CGFloat = 0.82
        let artworkInset = size.width * (1 - artworkScale) / 2
        let transform = NSAffineTransform()
        transform.translateX(by: artworkInset, yBy: artworkInset)
        transform.scale(by: artworkScale)
        transform.concat()

        let background = NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 96, yRadius: 96)
        NSColor(calibratedRed: 0.12, green: 0.13, blue: 0.19, alpha: 1).setFill()
        background.fill()

        NSColor(calibratedRed: 0.48, green: 0.64, blue: 0.97, alpha: 1).setStroke()
        let split = NSBezierPath()
        split.lineWidth = 24
        split.lineCapStyle = .round
        split.move(to: NSPoint(x: 256, y: 62))
        split.line(to: NSPoint(x: 256, y: 450))
        split.move(to: NSPoint(x: 62, y: 256))
        split.line(to: NSPoint(x: 256, y: 256))
        split.stroke()

        let prompt = ">_" as NSString
        prompt.draw(
            at: NSPoint(x: 76, y: 320),
            withAttributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 102, weight: .bold),
                .foregroundColor: NSColor(calibratedRed: 0.62, green: 0.81, blue: 0.42, alpha: 1),
            ]
        )

        image.unlockFocus()
        return image
    }
}
