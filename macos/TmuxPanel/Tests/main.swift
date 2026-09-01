import Foundation

private enum SelfTestError: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case let .failed(message): message
        }
    }
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw SelfTestError.failed(message) }
}

private func testEndpointResolution() throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let certificateDER = Data([0x30, 0x03, 0x02, 0x01, 0x01])
    let certificateURL = directory.appendingPathComponent("cert.der")
    try certificateDER.write(to: certificateURL)
    let plistURL = directory.appendingPathComponent("panel.plist")
    let plist: [String: Any] = [
        "EnvironmentVariables": [
            "PORT": "9443",
            "HOST": "0.0.0.0",
            "TLS_CERT": certificateURL.path,
        ],
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: plistURL)

    let endpoint = PanelEndpointResolver.resolve(environment: [:], launchAgentURL: plistURL)
    try expect(endpoint.url.absoluteString == "https://127.0.0.1:9443/", "TLS endpoint resolution failed")
    try expect(endpoint.pinnedCertificateDER == certificateDER, "certificate pin loading failed")

    let override = PanelEndpointResolver.resolve(
        environment: ["TMUX_PANEL_URL": "http://localhost:8080"],
        launchAgentURL: plistURL
    )
    try expect(override.url.absoluteString == "http://localhost:8080/", "URL override failed")
    try expect(PanelEndpointResolver.normalizedURL("file:///tmp/panel") == nil, "unsafe URL scheme accepted")
    try expect(PanelEndpointResolver.normalizedURL("not a url") == nil, "invalid URL accepted")
    try expect(PanelEndpointResolver.isLoopback("127.0.0.1"), "IPv4 loopback rejected")
    try expect(PanelEndpointResolver.isLoopback("LOCALHOST"), "localhost rejected")
    try expect(PanelEndpointResolver.isLoopback("::1"), "IPv6 loopback rejected")
    try expect(!PanelEndpointResolver.isLoopback("192.168.1.10"), "LAN host accepted as loopback")
    try expect(
        PanelEndpointResolver.isSameOrigin(
            URL(string: "https://127.0.0.1:9443/terminal.html")!,
            as: endpoint.url
        ),
        "same-origin panel URL rejected"
    )
    try expect(
        !PanelEndpointResolver.isSameOrigin(
            URL(string: "https://example.com/terminal.html")!,
            as: endpoint.url
        ),
        "external origin accepted"
    )
    try expect(
        PanelEndpointResolver.isSameOrigin(
            URL(string: "http://localhost/path")!,
            as: URL(string: "http://localhost:80/")!
        ),
        "default HTTP port did not match explicit port"
    )

    let rootEndpoint = URL(string: "https://127.0.0.1:9443/")!
    for allowed in ["/", "/index.html", "/login.html?next=%23%2Fservers", "/#/servers/local"] {
        try expect(
            PanelEndpointResolver.isAllowedPrimaryDocument(
                URL(string: "https://127.0.0.1:9443\(allowed)")!,
                as: rootEndpoint
            ),
            "allowed primary document rejected: \(allowed)"
        )
    }
    for blocked in ["/research/note.md", "/api/files/raw", "/terminal.html"] {
        try expect(
            !PanelEndpointResolver.isAllowedPrimaryDocument(
                URL(string: "https://127.0.0.1:9443\(blocked)")!,
                as: rootEndpoint
            ),
            "unexpected primary document accepted: \(blocked)"
        )
    }
    try expect(
        !PanelEndpointResolver.isAllowedPrimaryDocument(
            URL(string: "https://example.com/")!, as: rootEndpoint
        ),
        "cross-origin primary document accepted"
    )

    let baseEndpoint = URL(string: "https://panel.test/base/")!
    try expect(
        PanelEndpointResolver.isAllowedPrimaryDocument(
            URL(string: "https://panel.test/base/login.html")!, as: baseEndpoint
        ),
        "base-path login document rejected"
    )
    try expect(
        !PanelEndpointResolver.isAllowedPrimaryDocument(
            URL(string: "https://panel.test/research/note.md")!, as: baseEndpoint
        ),
        "path outside base accepted"
    )
}

private func testServiceStateParsing() throws {
    try expect(
        ServiceInspector.parseLaunchctlOutput("state = running\npid = 42") == .running,
        "running launchd state was not recognized"
    )
    try expect(
        ServiceInspector.parseLaunchctlOutput("state = exited\nlast exit code = 1") == .stopped,
        "stopped launchd state was not recognized"
    )
    try expect(ServiceInspector.parseLaunchctlOutput("") == .unavailable, "empty state should be unavailable")
}

do {
    try testEndpointResolution()
    try testServiceStateParsing()
    print("macOS shell self-tests passed: endpoint, TLS pin, loopback policy, service state")
} catch {
    fputs("macOS shell self-test failed: \(error)\n", stderr)
    exit(1)
}
