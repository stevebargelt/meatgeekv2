import CryptoKit
import Foundation
public import MeatGeekAPI
import Observation

/// Whether the app may show alerts, as iOS answers it. Provisional and
/// ephemeral authorization count as granted: iOS delivers to them.
public enum NotificationPermission: Sendable, Equatable {
    /// The pitmaster has not been asked yet.
    case notDetermined
    case granted
    case denied
}

/// The slice of iOS's notification machinery the app uses: the permission
/// state, the permission request, the APNs device token, and a tapped
/// alert. The port the notifications model runs on, like `LiveHub` for the
/// live panel.
///
/// The app's is `SystemNotifications` (MeatGeek/SystemNotifications.swift),
/// over `UNUserNotificationCenter` and `UIApplication`; UI test mode's is
/// `StubNotifications`; unit tests use a fake. Everything happens on the
/// main actor.
@MainActor
public protocol NotificationsPort: AnyObject {
    /// The permission as it is now. Never asks.
    func permission() async -> NotificationPermission
    /// Shows the system's permission prompt (iOS shows it at most once per
    /// install) and returns the answer.
    func requestPermission() async -> NotificationPermission
    /// Asks APNs for the phone's device token. It arrives through
    /// `onDeviceToken`, now or later, and again whenever it changes.
    func registerForRemoteNotifications()
    /// Each device token iOS hands the app, as raw bytes.
    func onDeviceToken(_ handler: @escaping @MainActor (Data) -> Void)
    /// The cook id of an alert the pitmaster tapped. A tap from before the
    /// handler was set (the tap that launched the app) is delivered when it is.
    func onAlertTapped(_ handler: @escaping @MainActor (String) -> Void)
}

/// What an alert's push payload carries for the app (see `alertPayload` in
/// apps/api/src/functions/cooks/target-alerts.ts).
public enum AlertPayload {
    /// The payload key of the alert's cook id, at the top level.
    public static let cookIDKey = "cookId"

    /// The cook a tapped alert is about; nil for any other notification.
    public static func cookID(in userInfo: [AnyHashable: Any]) -> String? {
        guard let id = userInfo[cookIDKey] as? String, !id.isEmpty else { return nil }
        return id
    }
}

/// Alerts on this phone: asks for permission the first time a running
/// cook's screen shows (starting a cook opens its screen), registers the
/// phone's APNs token with the API (`POST /users/me/push-tokens`) once
/// permission is granted and whenever the token changes, removes it
/// (`DELETE /users/me/push-tokens/{tokenId}`) when the pitmaster signs out,
/// and passes a tapped alert's cook on to the screens.
///
/// Work runs one step at a time, in the order it was asked for, so a
/// registration and a sign-out never race. `settled()` waits for it.
@MainActor
@Observable
public final class NotificationsModel {
    /// What a running cook's screen says while permission is declined.
    public nonisolated static let alertsOffMessage =
        "Alerts are off. Turn on notifications for MeatGeek in Settings to be alerted when a target is reached."

    /// The permission as last read; nil until it has been.
    public private(set) var permission: NotificationPermission?
    /// A tapped alert's cook, for the screens to open. `cookOpened()` clears it.
    public private(set) var openCookID: String?

    @ObservationIgnored private let port: any NotificationsPort
    @ObservationIgnored private let session: SessionModel
    /// The phone's token as iOS last handed it, in lowercase hex.
    @ObservationIgnored private var deviceToken: String?
    /// The token the API has for this phone and the signed-in user.
    @ObservationIgnored public private(set) var registeredToken: String?
    /// The permission prompt is showing, or about to.
    @ObservationIgnored private var asking = false
    @ObservationIgnored private var tail: Task<Void, Never>?

    /// Wires itself to `port`, and to `session`'s sign-out
    /// (`SessionModel.beforeSignOut`), which removes this phone's token first.
    public init(port: any NotificationsPort, session: SessionModel) {
        self.port = port
        self.session = session
        port.onDeviceToken { [weak self] data in self?.tokenReceived(data) }
        port.onAlertTapped { [weak self] cookID in self?.openCookID = cookID }
        session.beforeSignOut = { [weak self] in await self?.signingOut() }
    }

    /// Whether a running cook's screen says alerts are off.
    public var alertsOff: Bool { permission == .denied }

    /// Signed in, or back in the foreground: reads the permission again (it
    /// can change in Settings) and, when granted, asks APNs for the token,
    /// which is then registered. Never asks the pitmaster.
    public func refresh() {
        enqueue { [self] in
            permission = await port.permission()
            if permission == .granted {
                port.registerForRemoteNotifications()
                await syncRegistration()
            }
        }
    }

    /// A running cook's screen showed: the moment to ask, once. Does
    /// nothing when the pitmaster has already answered.
    public func runningCookShown() {
        guard !asking, permission == nil || permission == .notDetermined else { return }
        asking = true
        enqueue { [self] in
            defer { asking = false }
            var current = await port.permission()
            if current == .notDetermined {
                current = await port.requestPermission()
            }
            permission = current
            if current == .granted {
                port.registerForRemoteNotifications()
                await syncRegistration()
            }
        }
    }

    /// The screens opened the tapped alert's cook.
    public func cookOpened() {
        openCookID = nil
    }

    /// Waits for every step asked for so far.
    public func settled() async {
        while let task = tail {
            await task.value
            if tail == task { return }
        }
    }

    // MARK: Tokens

    /// The token's hex, as the API takes it.
    public nonisolated static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// The phone's id at the API: the SHA-256 of its token's lowercase hex,
    /// in lowercase hex (`pushTokenId` in push-tokens-repository.ts).
    public nonisolated static func tokenID(_ hexToken: String) -> String {
        hex(Data(SHA256.hash(data: Data(hexToken.lowercased().utf8))))
    }

    private func tokenReceived(_ data: Data) {
        deviceToken = Self.hex(data)
        enqueue { [self] in await syncRegistration() }
    }

    /// Registers the current token when permission is granted, the user is
    /// signed in and the API does not have it yet, then removes the token it
    /// replaces. A failure leaves it unregistered; the next refresh, cook
    /// screen or token tries again.
    private func syncRegistration() async {
        guard permission == .granted, case .signedIn = session.state,
              let token = deviceToken, token != registeredToken else { return }
        guard let output = try? await session.perform({ api in
            try await api.registerPushToken(body: .json(.init(token: token)))
        }) else { return }
        switch output {
        case .ok, .created:
            let replaced = registeredToken
            registeredToken = token
            if let replaced { await delete(replaced) }
        case .unauthorized:
            session.endSession()
        case .badRequest, .internalServerError, .undocumented:
            break
        }
    }

    /// Before the session signs out: the API forgets this phone, so the
    /// signed-out phone gets no alerts. A failure does not stop the sign-out.
    private func signingOut() async {
        await settled()
        let tokens = Set([registeredToken, deviceToken].compactMap { $0 })
        for token in tokens.sorted() {
            await delete(token)
        }
        registeredToken = nil
    }

    private func delete(_ token: String) async {
        let id = Self.tokenID(token)
        _ = try? await session.perform { api in try await api.deletePushToken(path: .init(tokenId: id)) }
    }

    private func enqueue(_ step: @escaping @MainActor () async -> Void) {
        let previous = tail
        tail = Task { @MainActor in
            await previous?.value
            await step()
        }
    }
}

/// UI test mode's notifications: no system prompt and no APNs. The
/// permission starts as `MEATGEEK_UI_TEST_NOTIFICATIONS` says ("granted",
/// "denied", otherwise not asked yet) and the prompt is answered "Allow".
/// Registering hands over `StubNotifications.token` at once.
/// `MEATGEEK_UI_TEST_TAPPED_ALERT=<cook id>` delivers a tap on that cook's
/// alert, as if it had launched the app.
@MainActor
public final class StubNotifications: NotificationsPort {
    public static let permissionKey = "MEATGEEK_UI_TEST_NOTIFICATIONS"
    public static let tappedAlertKey = "MEATGEEK_UI_TEST_TAPPED_ALERT"
    /// The device token UI test mode registers: 32 bytes.
    public static let token = Data((0..<32).map { UInt8($0) })

    public private(set) var current: NotificationPermission
    private var tapped: String?
    private var tokenHandler: (@MainActor (Data) -> Void)?

    public init(environment: [String: String]) {
        switch environment[Self.permissionKey] {
        case "granted": current = .granted
        case "denied": current = .denied
        default: current = .notDetermined
        }
        tapped = environment[Self.tappedAlertKey].flatMap { $0.isEmpty ? nil : $0 }
    }

    public func permission() async -> NotificationPermission { current }

    public func requestPermission() async -> NotificationPermission {
        if current == .notDetermined { current = .granted }
        return current
    }

    public func registerForRemoteNotifications() {
        tokenHandler?(Self.token)
    }

    public func onDeviceToken(_ handler: @escaping @MainActor (Data) -> Void) {
        tokenHandler = handler
    }

    public func onAlertTapped(_ handler: @escaping @MainActor (String) -> Void) {
        if let tapped {
            self.tapped = nil
            handler(tapped)
        }
    }
}

/// UI test mode's push-token routes: one launch's phones in memory, by id.
public actor StubPushTokens {
    private var registered: [String: Date] = [:]
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date) {
        self.now = now
    }

    public var ids: [String] { registered.keys.sorted() }

    public func list() -> Operations.ListPushTokens.Output {
        let items = registered.sorted { $0.key < $1.key }.map { Components.Schemas.PushToken(id: $0.key, registeredAt: $0.value) }
        return .ok(.init(body: .json(.init(items: items))))
    }

    public func register(_ input: Operations.RegisterPushToken.Input) -> Operations.RegisterPushToken.Output {
        guard case .json(let body) = input.body else { return .undocumented(statusCode: 415, .init()) }
        let id = NotificationsModel.tokenID(body.token)
        let known = registered[id] != nil
        registered[id] = now()
        let token = Components.Schemas.PushToken(id: id, registeredAt: now())
        return known ? .ok(.init(body: .json(token))) : .created(.init(body: .json(token)))
    }

    public func delete(_ input: Operations.DeletePushToken.Input) -> Operations.DeletePushToken.Output {
        registered[input.path.tokenId] = nil
        return .noContent(.init())
    }
}
