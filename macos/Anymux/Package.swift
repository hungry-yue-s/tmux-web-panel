// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "Anymux",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "Anymux", targets: ["Anymux"]),
    ],
    targets: [
        .executableTarget(name: "Anymux"),
    ]
)
