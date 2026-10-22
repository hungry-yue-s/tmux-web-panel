import AppKit

/// Fullscreen Spaces have no desktop behind the window for AppKit to sample.
/// Keep a local wallpaper layer below the material in a native fullscreen Space.
@MainActor
final class PanelBackgroundView: NSView {
    let materialView = NSVisualEffectView()
    private let wallpaperView = NSView()
    private let workspaceNotifications = NSWorkspace.shared.notificationCenter
    private var wallpaperScreenNumber: NSNumber?
    private var wallpaperURL: URL?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        wallpaperView.wantsLayer = true
        wallpaperView.layer?.contentsGravity = .resizeAspectFill
        wallpaperView.layer?.masksToBounds = true
        wallpaperView.isHidden = true
        materialView.material = .underWindowBackground
        materialView.blendingMode = .behindWindow
        materialView.state = .active
        for view in [wallpaperView, materialView] {
            view.frame = bounds
            view.autoresizingMask = [.width, .height]
            addSubview(view)
        }
    }

    required init?(coder: NSCoder) { nil }

    deinit {
        NotificationCenter.default.removeObserver(self)
        workspaceNotifications.removeObserver(self)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self)
        workspaceNotifications.removeObserver(self)
        guard let window else { return }
        for name in [NSWindow.willEnterFullScreenNotification, NSWindow.didEnterFullScreenNotification,
                     NSWindow.didExitFullScreenNotification, NSWindow.didChangeScreenNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(updateBackground(_:)), name: name, object: window)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(updateBackground(_:)),
            name: NSApplication.didBecomeActiveNotification, object: nil)
        workspaceNotifications.addObserver(self, selector: #selector(updateBackground(_:)),
            name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        updateBackground(nil)
    }

    @objc private func updateBackground(_ notification: Notification?) {
        guard let window, let screen = window.screen ?? NSScreen.main else { return }
        // Cache the desktop image before entering its own Space. Fullscreen may
        // report no desktop image; retain the last decoded image in that case.
        let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        let screenChanged = wallpaperScreenNumber != screenNumber
        if let url = NSWorkspace.shared.desktopImageURL(for: screen), url.isFileURL {
            if screenChanged || url != wallpaperURL || notification?.name == NSApplication.didBecomeActiveNotification {
                if let image = NSImage(contentsOf: url),
                   let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                    wallpaperView.layer?.contents = cgImage
                    wallpaperURL = url
                    wallpaperScreenNumber = screenNumber
                } else if screenChanged {
                    wallpaperView.layer?.contents = nil
                    wallpaperURL = nil
                    wallpaperScreenNumber = nil
                }
            }
        } else if screenChanged {
            wallpaperView.layer?.contents = nil
            wallpaperURL = nil
            wallpaperScreenNumber = nil
        }
        let useWallpaper = wallpaperView.layer?.contents != nil && window.styleMask.contains(.fullScreen)
        wallpaperView.isHidden = !useWallpaper
        materialView.material = useWallpaper ? .titlebar : .underWindowBackground
        materialView.blendingMode = useWallpaper ? .withinWindow : .behindWindow
    }
}
