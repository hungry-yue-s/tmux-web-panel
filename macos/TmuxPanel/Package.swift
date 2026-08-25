// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "TmuxPanel",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "TmuxPanel", targets: ["TmuxPanel"]),
    ],
    targets: [
        .executableTarget(name: "TmuxPanel"),
    ]
)
