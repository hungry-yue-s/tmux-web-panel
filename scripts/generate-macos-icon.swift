import AppKit

// Generate standard 1x/2x representations for iconutil during app packaging.
let iconset = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
try MainActor.assumeIsolated {
    for points in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let bitmap = AppIcon.make(pixels: points * scale)
            let suffix = scale == 2 ? "@2x" : ""
            let url = iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
            try bitmap.representation(using: .png, properties: [:])!.write(to: url)
        }
    }
}

enum AppIcon {
    @MainActor
    static func make(pixels: Int) -> NSBitmapImageRep {
        let size = NSSize(width: 512, height: 512)
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let pixelScale = NSAffineTransform()
        pixelScale.scale(by: CGFloat(pixels) / size.width)
        pixelScale.concat()

        // Preserve the existing icon artwork and its macOS safe margin.
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

        NSGraphicsContext.restoreGraphicsState()
        return bitmap
    }
}
