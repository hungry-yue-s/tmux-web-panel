import Darwin
import Foundation

enum ServiceState: String, Sendable {
    case checking
    case running
    case stopped
    case unavailable

    var title: String {
        switch self {
        case .checking: "检查中"
        case .running: "运行中"
        case .stopped: "已停止"
        case .unavailable: "不可用"
        }
    }
}

enum ServiceInspector {
    static func inspect(label: String) async -> ServiceState {
        await Task.detached(priority: .utility) {
            let process = Process()
            let output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["print", "gui/\(getuid())/\(label)"]
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice

            do {
                try process.run()
                process.waitUntilExit()
                guard process.terminationStatus == 0 else { return .stopped }
                let data = output.fileHandleForReading.readDataToEndOfFile()
                let text = String(decoding: data, as: UTF8.self)
                return parseLaunchctlOutput(text)
            } catch {
                return .unavailable
            }
        }.value
    }

    static func parseLaunchctlOutput(_ text: String) -> ServiceState {
        let states = text.split(separator: "\n").map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        if states.contains("state = running") || states.contains("state = active") {
            return .running
        }
        return text.isEmpty ? .unavailable : .stopped
    }
}
