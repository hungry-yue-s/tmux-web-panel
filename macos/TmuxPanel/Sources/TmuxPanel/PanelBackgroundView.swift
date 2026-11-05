import AppKit
import ImageIO

/// Fullscreen Spaces have no desktop behind the window for AppKit to sample.
/// Keep a local wallpaper layer below the material in a native fullscreen Space.
@MainActor
final class PanelBackgroundView: NSView {
    let materialView = NSVisualEffectView()
    private let wallpaperView = NSView()
    private let workspaceNotifications = NSWorkspace.shared.notificationCenter
    private var wallpaperScreenNumber: NSNumber?
    private var wallpaperURL: URL?
    private let wallpaperQueue = DispatchQueue(label: "com.tmux-web-panel.wallpaper", qos: .utility)
    private var wallpaperRequest = 0
    private var loadingWallpaperURL: URL?
    private var loadingScreenNumber: Int?

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
        wallpaperRequest += 1
        loadingWallpaperURL = nil
        loadingScreenNumber = nil
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
                loadWallpaper(url, screenNumber: screenNumber?.intValue)
            }
        } else if screenChanged {
            wallpaperRequest += 1
            loadingWallpaperURL = nil
            loadingScreenNumber = nil
            wallpaperView.layer?.contents = nil
            wallpaperURL = nil
            wallpaperScreenNumber = nil
        }
        updateMaterial()
    }

    private func loadWallpaper(_ url: URL, screenNumber: Int?) {
        guard loadingWallpaperURL != url || loadingScreenNumber != screenNumber else { return }
        wallpaperRequest += 1
        let request = wallpaperRequest
        loadingWallpaperURL = url
        loadingScreenNumber = screenNumber
        // A desktop image can live on an unavailable volume. File access and
        // decoding must not block activation, input, or an application quit.
        wallpaperQueue.async { [weak self] in
            let source = CGImageSourceCreateWithURL(url as CFURL, nil)
            let image = source.flatMap {
                CGImageSourceCreateImageAtIndex($0, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.wallpaperRequest == request else { return }
                self.loadingWallpaperURL = nil
                self.loadingScreenNumber = nil
                if let image {
                    self.wallpaperView.layer?.contents = image
                    self.wallpaperURL = url
                    self.wallpaperScreenNumber = screenNumber.map { NSNumber(value: $0) }
                } else if self.wallpaperScreenNumber?.intValue != screenNumber {
                    self.wallpaperView.layer?.contents = nil
                    self.wallpaperURL = nil
                    self.wallpaperScreenNumber = nil
                }
                self.updateMaterial()
            }
        }
    }

    private func updateMaterial() {
        guard let window else { return }
        let useWallpaper = wallpaperView.layer?.contents != nil && window.styleMask.contains(.fullScreen)
        wallpaperView.isHidden = !useWallpaper
        materialView.material = useWallpaper ? .titlebar : .underWindowBackground
        materialView.blendingMode = useWallpaper ? .withinWindow : .behindWindow
    }
}
