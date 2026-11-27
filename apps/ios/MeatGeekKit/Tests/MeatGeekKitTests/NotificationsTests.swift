import Foundation
import MeatGeekAPI
import Testing
@testable import MeatGeekKit

/// Alerts on this phone (#245): the permission flow, the token's
/// registration and its removal at sign-out, and a tapped alert, through
/// `NotificationsModel` on a fake port and `StubAPI`. Every step is awaited
/// (`settled()`); nothing waits in real time.

/// The notifications port for unit tests: answers as told and records
/// what the model asked of it. A token arrives only when the test hands one.
@MainActor
final class FakeNotifications: NotificationsPort {
    var current: NotificationPermission
    /// What the permission prompt is answered with.
    var answer: NotificationPermission
    private(set) var requestCount = 0
    private(set) var registerCount = 0
    private(set) var unregisterCount = 0
    private var tokenHandler: (@MainActor (Data) -> Void)?
    private var tapHandler: (@MainActor (String) -> Void)?

    init(_ current: NotificationPermission = .notDetermined, answer: NotificationPermission = .granted) {
        self.current = current
        self.answer = answer
    }

    func permission() async -> NotificationPermission { current }

    func requestPermission() async -> NotificationPermission {
        requestCount += 1
        if current == .notDetermined { current = answer }
        return current
    }

    func registerForRemoteNotifications() { registerCount += 1 }

    func unregisterForRemoteNotifications() { unregisterCount += 1 }

    func onDeviceToken(_ handler: @escaping @MainActor (Data) -> Void) { tokenHandler = handler }

    func onAlertTapped(_ handler: @escaping @MainActor (String) -> Void) { tapHandler = handler }

    /// iOS hands the app a device token.
    func deliver(token: Data) { tokenHandler?(token) }

    /// The pitmaster taps an alert for `cookID`.
    func tap(cookID: String) { tapHandler?(cookID) }
}

enum NotificationFixtures {
    /// 32 bytes, 00 to 1f; its hex and its id at the API.
    static let token = Data((0..<32).map { UInt8($0) })
    static let tokenHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    static let tokenID = "6c86c6aac5fb24bcf5d9939cb7d7d5645ce39418f449e03b262dd4fa14b4b92b"
    static let otherToken = Data(repeating: 0xab, count: 32)
    static let otherTokenID = "271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a"

    /// A stub over `CookFixtures.api()` whose push-token routes record the
    /// tokens registered and the ids deleted, answering `register` and
    /// `delete`.
    static func api(
        registered: Recorder<String>,
        deleted: Recorder<String>,
        register: @escaping @Sendable (String) -> Operations.RegisterPushToken.Output = { token in
            .created(.init(body: .json(.init(id: NotificationsModel.tokenID(token), registeredAt: fixedNow))))
        },
        delete: @escaping @Sendable (String) -> Operations.DeletePushToken.Output = { _ in .noContent(.init()) }
    ) -> StubAPI {
        var api = CookFixtures.api()
        api.registerPushTokenHandler = { input in
            guard case .json(let body) = input.body else { return .undocumented(statusCode: 415, .init()) }
            registered.record(body.token)
            return register(body.token)
        }
        api.deletePushTokenHandler = { input in
            deleted.record(input.path.tokenId)
            return delete(input.path.tokenId)
        }
        return api
    }

    /// A `UserDefaults` of its own, empty, standing in for the app's across
    /// launches. `done` removes it.
    static func defaults() -> (UserDefaults, done: () -> Void) {
        let name = "NotificationsTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return (defaults, { defaults.removePersistentDomain(forName: name) })
    }

    /// A signed-in session over `api`, and the model on `port`.
    @MainActor
    static func model(_ api: StubAPI, port: FakeNotifications, signedIn: Bool = true, defaults: UserDefaults? = nil) async
        -> (SessionModel, FakeTokenProvider, NotificationsModel) {
        let provider = FakeTokenProvider(account: signedIn ? DeviceFixtures.account : nil)
        let session = SessionModel(tokenProvider: provider, api: api)
        await session.restore()
        return (session, provider, NotificationsModel(port: port, session: session, defaults: defaults))
    }
}

@Suite("Notifications: permission")
@MainActor
struct NotificationPermissionTests {
    typealias N = NotificationFixtures

    @Test("signing in does not ask: it only reads the permission")
    func notAtLaunch() async {
        let port = FakeNotifications()
        let (_, _, model) = await N.model(N.api(registered: Recorder(), deleted: Recorder()), port: port)
        model.refresh()
        await model.settled()
        #expect(port.requestCount == 0)
        #expect(port.registerCount == 0)
        #expect(model.permission == .notDetermined)
        #expect(!model.alertsOff)
    }

    @Test("a running cook's screen asks once; granted, the phone asks APNs for its token")
    func asksOnRunningCook() async {
        let port = FakeNotifications()
        let (_, _, model) = await N.model(N.api(registered: Recorder(), deleted: Recorder()), port: port)
        model.runningCookShown()
        model.runningCookShown()
        await model.settled()
        model.runningCookShown()
        await model.settled()
        #expect(port.requestCount == 1)
        #expect(model.permission == .granted)
        #expect(port.registerCount == 1)
    }

    @Test("opening a running cook asks; opening an ended one does not")
    func cookScreens() async {
        let port = FakeNotifications()
        var api = CookDetailModelTests.api()
        let ended = CookFixtures.cook("old")
        api.getCookHandler = { input in
            .ok(.init(body: .json(input.path.cookId == "old" ? ended : CookDetailModelTests.active)))
        }
        let (_, devices, _) = await CookFixtures.models(api)
        let notifications = NotificationsModel(port: port, session: devices.session)
        let cooks = CooksModel(devices: devices, now: { fixedNow }, notifications: notifications)

        let endedDetail = CookDetailModel(cookID: "old", cooks: cooks)
        await endedDetail.start()
        await notifications.settled()
        #expect(port.requestCount == 0)

        let running = CookDetailModel(cookID: "c1", cooks: cooks)
        await running.start()
        await notifications.settled()
        #expect(port.requestCount == 1)
        #expect(!running.alertsOff)
    }

    @Test("declined: a running cook's screen says alerts are off, and no token is asked for")
    func declined() async {
        let port = FakeNotifications(answer: .denied)
        let registered = Recorder<String>()
        let api = N.api(registered: registered, deleted: Recorder())
        var cookAPI = CookDetailModelTests.api()
        cookAPI.registerPushTokenHandler = api.registerPushTokenHandler
        let (_, devices, _) = await CookFixtures.models(cookAPI)
        let notifications = NotificationsModel(port: port, session: devices.session)
        let detail = CookDetailModel(cookID: "c1", cooks: CooksModel(devices: devices, now: { fixedNow }, notifications: notifications))
        await detail.start()
        await notifications.settled()
        #expect(port.requestCount == 1)
        #expect(notifications.permission == .denied)
        #expect(detail.alertsOff)
        #expect(NotificationsModel.alertsOffMessage.hasPrefix("Alerts are off."))
        #expect(port.registerCount == 0)
        #expect(registered.all.isEmpty)
    }

    @Test("turned on in Settings: coming back reads it, and the phone registers")
    func grantedInSettings() async {
        let port = FakeNotifications(.denied)
        let registered = Recorder<String>()
        let (_, _, model) = await N.model(N.api(registered: registered, deleted: Recorder()), port: port)
        model.refresh()
        await model.settled()
        #expect(model.alertsOff)

        port.current = .granted
        model.refresh()
        await model.settled()
        #expect(!model.alertsOff)
        #expect(port.registerCount == 1)
        port.deliver(token: N.token)
        await model.settled()
        #expect(registered.all == [N.tokenHex])
    }
}

@Suite("Notifications: the phone's token")
@MainActor
struct PushTokenRegistrationTests {
    typealias N = NotificationFixtures

    @Test("granted: the token is registered as lowercase hex")
    func registers() async {
        let port = FakeNotifications()
        let registered = Recorder<String>()
        let (_, _, model) = await N.model(N.api(registered: registered, deleted: Recorder()), port: port)
        model.runningCookShown()
        await model.settled()
        port.deliver(token: N.token)
        await model.settled()
        #expect(registered.all == [N.tokenHex])
        #expect(model.registeredToken == N.tokenHex)
    }

    @Test("already granted: signing in registers without asking")
    func alreadyGranted() async {
        let port = FakeNotifications(.granted)
        let registered = Recorder<String>()
        let (_, _, model) = await N.model(N.api(registered: registered, deleted: Recorder()), port: port)
        port.deliver(token: N.token)
        model.refresh()
        await model.settled()
        #expect(port.requestCount == 0)
        #expect(registered.all == [N.tokenHex])
    }

    @Test("the same token again is not registered twice")
    func sameToken() async {
        let port = FakeNotifications(.granted)
        let registered = Recorder<String>()
        let (_, _, model) = await N.model(N.api(registered: registered, deleted: Recorder()), port: port)
        model.refresh()
        port.deliver(token: N.token)
        port.deliver(token: N.token)
        model.refresh()
        await model.settled()
        #expect(registered.all == [N.tokenHex])
    }

    @Test("a changed token is registered, and the one it replaces is removed")
    func changed() async {
        let port = FakeNotifications(.granted)
        let registered = Recorder<String>()
        let deleted = Recorder<String>()
        let (_, _, model) = await N.model(N.api(registered: registered, deleted: deleted), port: port)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()
        port.deliver(token: N.otherToken)
        await model.settled()
        #expect(registered.all == [N.tokenHex, NotificationsModel.hex(N.otherToken)])
        #expect(deleted.all == [N.tokenID])
        #expect(model.registeredToken == NotificationsModel.hex(N.otherToken))
    }

    @Test("not granted: a token is not registered")
    func notGranted() async {
        let port = FakeNotifications(.denied)
        let registered = Recorder<String>()
        let (_, _, model) = await N.model(N.api(registered: registered, deleted: Recorder()), port: port)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()
        #expect(registered.all.isEmpty)
    }

    @Test("a failed registration is tried again on the next refresh")
    func retried() async {
        let port = FakeNotifications(.granted)
        let registered = Recorder<String>()
        let fails = Box(true)
        let api = N.api(registered: registered, deleted: Recorder(), register: { token in
            if fails.value {
                return .internalServerError(.init(body: .json(CookFixtures.error(.internalServerError, "boom"))))
            }
            return .created(.init(body: .json(.init(id: NotificationsModel.tokenID(token), registeredAt: fixedNow))))
        })
        let (_, _, model) = await N.model(api, port: port)
        model.refresh()
        await model.settled()
        port.deliver(token: N.token)
        await model.settled()
        #expect(model.registeredToken == nil)
        fails.value = false
        model.refresh()
        await model.settled()
        #expect(registered.all == [N.tokenHex, N.tokenHex])
        #expect(model.registeredToken == N.tokenHex)
    }

    @Test("a 401 from registering ends the session")
    func unauthorized() async {
        let port = FakeNotifications(.granted)
        let api = N.api(registered: Recorder(), deleted: Recorder(), register: { _ in
            .unauthorized(.init(body: .json(.init(
                error: .unauthenticated, reason: .principalHeaderMissing, requestId: "req-401"
            ))))
        })
        let (session, _, model) = await N.model(api, port: port)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()
        #expect(session.state == SessionModel.State.signedOut(message: SessionModel.sessionEndedMessage))
    }

    @Test("after a 401 ends the session, the next sign-in registers the token again")
    func reRegistersAfter401() async {
        let port = FakeNotifications(.granted)
        let registered = Recorder<String>()
        let (session, _, model) = await N.model(N.api(registered: registered, deleted: Recorder()), port: port)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()
        // Another screen's call gets a 401: the session ends without a sign-out.
        session.endSession()
        await session.signIn()
        model.refresh()
        await model.settled()
        #expect(registered.all == [N.tokenHex, N.tokenHex])
        #expect(model.registeredToken == N.tokenHex)
    }

    @Test("a token that changed between launches replaces the one the last launch registered")
    func changedBetweenLaunches() async {
        let (defaults, done) = N.defaults()
        defer { done() }
        let registered = Recorder<String>()
        let deleted = Recorder<String>()
        let api = N.api(registered: registered, deleted: deleted)
        let firstPort = FakeNotifications(.granted)
        let (_, _, first) = await N.model(api, port: firstPort, defaults: defaults)
        first.refresh()
        firstPort.deliver(token: N.token)
        await first.settled()

        let nextPort = FakeNotifications(.granted)
        let (_, _, next) = await N.model(api, port: nextPort, defaults: defaults)
        next.refresh()
        nextPort.deliver(token: N.otherToken)
        await next.settled()
        #expect(registered.all == [N.tokenHex, NotificationsModel.hex(N.otherToken)])
        #expect(deleted.all == [N.tokenID])
    }

    @Test("a token from before sign-in is registered once signed in")
    func beforeSignIn() async {
        let port = FakeNotifications(.granted)
        let registered = Recorder<String>()
        let (session, _, model) = await N.model(N.api(registered: registered, deleted: Recorder()), port: port, signedIn: false)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()
        #expect(registered.all.isEmpty)
        await session.signIn()
        model.refresh()
        await model.settled()
        #expect(registered.all == [N.tokenHex])
    }

    @Test("the id is the SHA-256 of the lowercase hex, as the API computes it")
    func tokenID() {
        #expect(NotificationsModel.hex(N.token) == N.tokenHex)
        #expect(NotificationsModel.tokenID(N.tokenHex) == N.tokenID)
        #expect(NotificationsModel.tokenID(N.tokenHex.uppercased()) == N.tokenID)
    }
}

@Suite("Notifications: sign-out and taps")
@MainActor
struct NotificationSignOutTests {
    typealias N = NotificationFixtures

    @Test("signing out removes the phone's token from the API, then signs out")
    func signOut() async {
        let port = FakeNotifications(.granted)
        let deleted = Recorder<String>()
        let (session, provider, model) = await N.model(N.api(registered: Recorder(), deleted: deleted), port: port)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()
        await session.signOut()
        #expect(deleted.all == [N.tokenID])
        #expect(model.registeredToken == nil)
        #expect(session.state == SessionModel.State.signedOut(message: nil))
        #expect(await provider.signOutCount == 1)
    }

    @Test("signing out deletes the token, then unregisters from APNs; signing in again registers again")
    func signOutUnregisters() async {
        let port = FakeNotifications(.granted)
        let registered = Recorder<String>()
        let deleted = Recorder<String>()
        var api = N.api(registered: registered, deleted: deleted)
        api.deletePushTokenHandler = { input in
            // The delete comes first: APNs is still registered while it runs.
            let unregistered = await MainActor.run { port.unregisterCount }
            deleted.record(unregistered == 0 ? input.path.tokenId : "after-unregister")
            return .noContent(.init())
        }
        let (session, _, model) = await N.model(api, port: port)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()

        await session.signOut()
        #expect(deleted.all == [N.tokenID])
        #expect(port.unregisterCount == 1)

        await session.signIn()
        model.refresh()
        await model.settled()
        #expect(port.registerCount == 2)
        port.deliver(token: N.otherToken)
        await model.settled()
        #expect(registered.all == [N.tokenHex, NotificationsModel.hex(N.otherToken)])
        #expect(model.registeredToken == NotificationsModel.hex(N.otherToken))
    }

    @Test("signing out unregisters from APNs even when the delete fails")
    func signOutUnregistersWhenDeleteFails() async {
        let port = FakeNotifications(.granted)
        let api = N.api(registered: Recorder(), deleted: Recorder(), delete: { _ in
            .internalServerError(.init(body: .json(CookFixtures.error(.internalServerError, "boom"))))
        })
        let (session, _, model) = await N.model(api, port: port)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()
        await session.signOut()
        #expect(port.unregisterCount == 1)
        #expect(session.state == SessionModel.State.signedOut(message: nil))
    }

    @Test("each launch asks APNs for the token and sends it, never a stored one")
    func everyLaunchRegisters() async {
        let (defaults, done) = N.defaults()
        defer { done() }
        let registered = Recorder<String>()
        let api = N.api(registered: registered, deleted: Recorder())
        let firstPort = FakeNotifications(.granted)
        let (_, _, first) = await N.model(api, port: firstPort, defaults: defaults)
        first.refresh()
        firstPort.deliver(token: N.token)
        await first.settled()

        let nextPort = FakeNotifications(.granted)
        let (_, _, next) = await N.model(api, port: nextPort, defaults: defaults)
        next.refresh()
        await next.settled()
        #expect(nextPort.registerCount == 1)
        #expect(registered.all == [N.tokenHex])
        nextPort.deliver(token: N.token)
        await next.settled()
        #expect(registered.all == [N.tokenHex, N.tokenHex])
    }

    @Test("signing out still signs out when the removal fails")
    func signOutFails() async {
        let port = FakeNotifications(.granted)
        let deleted = Recorder<String>()
        let api = N.api(registered: Recorder(), deleted: deleted, delete: { _ in
            .internalServerError(.init(body: .json(CookFixtures.error(.internalServerError, "boom"))))
        })
        let (session, _, model) = await N.model(api, port: port)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()
        await session.signOut()
        #expect(deleted.all == [N.tokenID])
        #expect(session.state == SessionModel.State.signedOut(message: nil))
    }

    @Test("a token that arrives while signing out is not registered again")
    func tokenDuringSignOut() async {
        let port = FakeNotifications(.granted)
        let registered = Recorder<String>()
        let deleted = Recorder<String>()
        var api = N.api(registered: registered, deleted: deleted)
        api.deletePushTokenHandler = { input in
            deleted.record(input.path.tokenId)
            await MainActor.run { port.deliver(token: N.otherToken) }
            return .noContent(.init())
        }
        let (session, _, model) = await N.model(api, port: port)
        model.refresh()
        port.deliver(token: N.token)
        await model.settled()
        await session.signOut()
        await model.settled()
        #expect(registered.all == [N.tokenHex])
        #expect(model.registeredToken == nil)
        #expect(session.state == SessionModel.State.signedOut(message: nil))
    }

    @Test("signing out after a relaunch, before iOS hands over the token, still removes it")
    func signOutAfterRelaunch() async {
        let (defaults, done) = N.defaults()
        defer { done() }
        let deleted = Recorder<String>()
        let api = N.api(registered: Recorder(), deleted: deleted)
        let firstPort = FakeNotifications(.granted)
        let (_, _, first) = await N.model(api, port: firstPort, defaults: defaults)
        first.refresh()
        firstPort.deliver(token: N.token)
        await first.settled()

        let (session, _, next) = await N.model(api, port: FakeNotifications(.denied), defaults: defaults)
        await session.signOut()
        withExtendedLifetime(next) {}
        #expect(deleted.all == [N.tokenID])
        #expect(defaults.string(forKey: NotificationsModel.lastTokenKey) == nil)
    }

    @Test("with no token, signing out calls nothing")
    func signOutNoToken() async {
        let deleted = Recorder<String>()
        let (session, _, _) = await N.model(N.api(registered: Recorder(), deleted: deleted), port: FakeNotifications())
        await session.signOut()
        #expect(deleted.all.isEmpty)
        #expect(session.state == SessionModel.State.signedOut(message: nil))
    }

    @Test("a tapped alert's cook is there to open until the screens open it")
    func tap() async {
        let port = FakeNotifications()
        let (_, _, model) = await N.model(N.api(registered: Recorder(), deleted: Recorder()), port: port)
        port.tap(cookID: "c1")
        #expect(model.openCookID == "c1")
        model.cookOpened()
        #expect(model.openCookID == nil)
    }

    @Test("the alert payload's cook id")
    func payload() {
        #expect(AlertPayload.cookID(in: ["aps": ["alert": "x"], "cookId": "c1"]) == "c1")
        #expect(AlertPayload.cookID(in: ["aps": ["alert": "x"]]) == nil)
        #expect(AlertPayload.cookID(in: ["cookId": ""]) == nil)
        #expect(AlertPayload.cookID(in: ["cookId": 7]) == nil)
    }

    @Test("UI test mode: allowed at the prompt, its token registered with the stub, a launch tap delivered")
    func uiTestStub() async {
        let stub = StubNotifications(environment: [StubNotifications.tappedAlertKey: "seeded-cook-1"])
        let api = StubAPI.uiTest(now: { fixedNow })
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let model = NotificationsModel(port: stub, session: session)
        #expect(model.openCookID == "seeded-cook-1")
        model.runningCookShown()
        await model.settled()
        #expect(model.permission == .granted)
        #expect(model.registeredToken == N.tokenHex)
        let listed = try? await api.listPushTokens().ok.body.json.items.map(\.id)
        #expect(listed == [N.tokenID])
        await session.signOut()
        let after = try? await api.listPushTokens().ok.body.json.items.map(\.id)
        #expect(after == [])
    }
}
