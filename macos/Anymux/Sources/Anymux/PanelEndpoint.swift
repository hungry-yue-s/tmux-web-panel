import Foundation

struct PanelEndpoint: Equatable, Sendable {
    let url: URL
    let pinnedCertificateDER: Data?
}

/// Where the source installation (scripts/install-service.sh) keeps things.
/// Before the rename it used com.tmux-web-panel labels and tmux-web-panel
/// directories; until it is reinstalled the app follows whichever exists.
enum SourceInstall {
    static func pick(_ current: URL, _ legacy: URL) -> URL {
        let files = FileManager.default
        return files.fileExists(atPath: current.path) || !files.fileExists(atPath: legacy.path) ? current : legacy
    }

    static func launchAgentURL(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        let agents = home.appendingPathComponent("Library/LaunchAgents")
        return pick(agents.appendingPathComponent("com.anymux.plist"), agents.appendingPathComponent("com.tmux-web-panel.plist"))
    }

    /// com.anymux, or com.tmux-web-panel for an installation from before the rename.
    static func labelPrefix(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> String {
        launchAgentURL(home: home).lastPathComponent == "com.tmux-web-panel.plist" ? "com.tmux-web-panel" : "com.anymux"
    }

    static func logsURL(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        pick(home.appendingPathComponent("Library/Logs/anymux"), home.appendingPathComponent("Library/Logs/tmux-web-panel"))
    }

    static func configURL(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        pick(home.appendingPathComponent(".config/anymux"), home.appendingPathComponent(".config/tmux-web-panel"))
    }

    /// ANYMUX_<name>, or the TMUX_PANEL_<name> that was set before the rename.
    static func environmentValue(_ name: String, in environment: [String: String]) -> String? {
        environment["ANYMUX_" + name] ?? environment["TMUX_PANEL_" + name]
    }
}

enum PanelEndpointResolver {
    static let defaultURL = URL(string: "http://127.0.0.1:7681/")!

    static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        launchAgentURL: URL = SourceInstall.launchAgentURL()
    ) -> PanelEndpoint {
        let launchAgent = readLaunchAgent(at: launchAgentURL)
        let certificate = launchAgent.certificatePath.flatMap(loadCertificateDER(at:))

        if let override = SourceInstall.environmentValue("URL", in: environment),
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

    static func isAllowedPrimaryDocument(_ candidate: URL, as endpoint: URL) -> Bool {
        guard isSameOrigin(candidate, as: endpoint) else { return false }
        let endpointPath = endpoint.path.isEmpty ? "/" : endpoint.path
        let baseDirectory: String
        if endpoint.hasDirectoryPath {
            baseDirectory = endpointPath.hasSuffix("/") ? endpointPath : endpointPath + "/"
        } else {
            let parent = (endpointPath as NSString).deletingLastPathComponent
            baseDirectory = parent == "/" ? "/" : parent + "/"
        }
        let allowed = Set([
            endpointPath,
            baseDirectory,
            baseDirectory + "index.html",
            baseDirectory + "login.html",
        ])
        return allowed.contains(candidate.path.isEmpty ? "/" : candidate.path)
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
