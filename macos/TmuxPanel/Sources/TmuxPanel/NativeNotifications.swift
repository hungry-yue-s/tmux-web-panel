import AppKit
import Foundation
import UserNotifications

struct NativeNotificationPayload: Equatable, Sendable {
    let id: String
    let session: String
    let windowIndex: String
    let windowName: String
    let command: String

    init?(messageBody: Any) {
        guard let body = messageBody as? [String: Any],
              let session = body["session"] as? String,
              !session.isEmpty,
              let windowIndex = body["windowIndex"] as? String,
              !windowIndex.isEmpty else {
            return nil
        }
        id = body["id"] as? String ?? UUID().uuidString
        self.session = session
        self.windowIndex = windowIndex
        windowName = body["windowName"] as? String ?? ""
        command = body["command"] as? String ?? ""
    }

    init(id: String, session: String, windowIndex: String, windowName: String, command: String) {
        self.id = id
        self.session = session
        self.windowIndex = windowIndex
        self.windowName = windowName
        self.command = command
    }
}

final class NativeNotificationCenter: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = NativeNotificationCenter()

    @MainActor var activationHandler: ((NativeNotificationPayload) -> Void)?

    private let center = UNUserNotificationCenter.current()

    func installDelegate() {
        center.delegate = self
    }

    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    func deliver(_ payload: NativeNotificationPayload) async {
        let status = await authorizationStatus()
        guard status == .authorized || status == .provisional else { return }

        let content = UNMutableNotificationContent()
        content.title = payload.windowName.isEmpty
            ? "\(payload.session) · window \(payload.windowIndex)"
            : "\(payload.session) · \(payload.windowIndex): \(payload.windowName)"
        content.body = payload.command.isEmpty ? "命令已完成" : "命令完成：\(payload.command)"
        content.sound = .default
        content.userInfo = [
            "session": payload.session,
            "windowIndex": payload.windowIndex,
            "windowName": payload.windowName,
            "command": payload.command,
        ]
        let identifier = payload.id.isEmpty ? UUID().uuidString : payload.id
        try? await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let session = info["session"] as? String ?? ""
        let windowIndex = info["windowIndex"] as? String ?? ""
        let payload = NativeNotificationPayload(
            id: response.notification.request.identifier,
            session: session,
            windowIndex: windowIndex,
            windowName: info["windowName"] as? String ?? "",
            command: info["command"] as? String ?? ""
        )
        completionHandler()
        guard !session.isEmpty, !windowIndex.isEmpty else { return }
        Task { @MainActor in
            self.activationHandler?(payload)
        }
    }
}
