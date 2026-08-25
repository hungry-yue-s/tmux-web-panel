import Foundation

struct PanelEndpoint: Equatable, Sendable {
    let url: URL
    let pinnedCertificateDER: Data?
}

enum PanelEndpointResolver {
    static let defaultURL = URL(string: "http://127.0.0.1:7681/")!

    static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        launchAgentURL: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.tmux-web-panel.plist")
    ) -> PanelEndpoint {
        let launchAgent = readLaunchAgent(at: launchAgentURL)
        let certificate = launchAgent.certificatePath.flatMap(loadCertificateDER(at:))

        if let override = environment["TMUX_PANEL_URL"],
           let url = normalizedURL(override) {
            return PanelEndpoint(url: url, pinnedCertificateDER: certificate)
        }

        let scheme = launchAgent.certificatePath == nil ? "http" : "https"
        let port = launchAgent.port ?? 7681
        let url = URL(string: "\(scheme)://127.0.0.1:\(port)/") ?? defaultURL
        return PanelEndpoint(url: url, pinnedCertificateDER: certificate)
    }

    static func normalizedURL(_ rawValue: String) -> URL? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              components.scheme == "http" || components.scheme == "https",
              components.host != nil else {
            return nil
        }
        if components.path.isEmpty { components.path = "/" }
        return components.url
    }

    static func readLaunchAgent(at url: URL) -> (port: Int?, certificatePath: String?) {
        guard let data = try? Data(contentsOf: url),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let root = plist as? [String: Any],
              let environment = root["EnvironmentVariables"] as? [String: Any] else {
            return (nil, nil)
        }

        let port: Int?
        if let number = environment["PORT"] as? NSNumber {
            port = number.intValue
        } else if let text = environment["PORT"] as? String {
            port = Int(text)
        } else {
            port = nil
        }

        let certificatePath = (environment["TLS_CERT"] as? String)
            .flatMap { $0.isEmpty ? nil : $0 }
        return (port, certificatePath)
    }

    static func loadCertificateDER(at path: String) -> Data? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        guard let pem = String(data: data, encoding: .utf8),
              pem.contains("BEGIN CERTIFICATE") else {
            return data
        }

        let base64 = pem
            .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
            .components(separatedBy: .whitespacesAndNewlines)
            .joined()
        return Data(base64Encoded: base64)
    }

    static func isLoopback(_ host: String) -> Bool {
        let normalized = host.lowercased()
        return normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1"
    }

    static func isSameOrigin(_ candidate: URL, as endpoint: URL) -> Bool {
        guard let candidateComponents = URLComponents(url: candidate, resolvingAgainstBaseURL: false),
              let endpointComponents = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
              let candidateScheme = candidateComponents.scheme?.lowercased(),
              let endpointScheme = endpointComponents.scheme?.lowercased(),
              let candidateHost = candidateComponents.host?.lowercased(),
              let endpointHost = endpointComponents.host?.lowercased() else {
            return false
        }

        return candidateScheme == endpointScheme
            && candidateHost == endpointHost
            && effectivePort(for: candidateComponents) == effectivePort(for: endpointComponents)
    }

    private static func effectivePort(for components: URLComponents) -> Int? {
        if let port = components.port { return port }
        switch components.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }
}
