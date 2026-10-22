import AppKit

// Resample the shared artwork into standard 1x/2x representations for iconutil.
let iconset = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let sourceURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let image = NSImage(contentsOf: sourceURL) else {
    fatalError("Unable to load app icon: \(sourceURL.path)")
}
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
try MainActor.assumeIsolated {
    for points in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let pixels = points * scale
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
            NSGraphicsContext.current?.imageInterpolation = .high
            // Normalize the native tile boundary so macOS does not wrap the
            // transparent artwork in an extra generic background plate.
            let edge = CGFloat(pixels)
            let tile = NSRect(x: edge * 0.09, y: edge * 0.09, width: edge * 0.82, height: edge * 0.82)
            let outline = NSBezierPath(roundedRect: tile, xRadius: edge * 0.15375, yRadius: edge * 0.15375)
            NSColor(calibratedRed: 0.02, green: 0.075, blue: 0.055, alpha: 1).setFill()
            outline.fill()
            outline.addClip()
            image.draw(in: NSRect(x: edge * 0.025, y: edge * 0.025, width: edge * 0.95, height: edge * 0.95))
            NSGraphicsContext.restoreGraphicsState()
            let suffix = scale == 2 ? "@2x" : ""
            let url = iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
            try bitmap.representation(using: .png, properties: [:])!.write(to: url)
        }
    }
}
