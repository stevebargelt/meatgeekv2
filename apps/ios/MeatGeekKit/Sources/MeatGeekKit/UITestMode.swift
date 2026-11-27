import Foundation

/// How the app runs under its UI tests: launched with `MEATGEEK_UI_TEST=1`, it
/// signs in with `FakeTokenProvider` and calls `StubAPI.uiTest()`, in process.
/// Nothing reaches MSAL, Entra or the network.
public enum UITestMode {
    /// Set to "1" to run on the fakes.
    public static let environmentKey = "MEATGEEK_UI_TEST"
    /// Set to "1" (with `environmentKey`) to start as if no client id were
    /// configured.
    public static let notConfiguredKey = "MEATGEEK_UI_TEST_NOT_CONFIGURED"

    /// The account `FakeTokenProvider` signs in as. Not what the home screen
    /// shows: that is `StubAPI.uiTestUserName`, from `GET /users/me`.
    public static let accountName = "UI Test Account"

    /// The clock in UI test mode: always 2026-11-22T18:00:00Z. The stub's
    /// device timestamps and the devices list's "last heard" ages are both
    /// measured on it, so the text is the same on every run.
    public static let fixedNow = Date(timeIntervalSince1970: 1_795_370_400)

    public static func isEnabled(_ environment: [String: String]) -> Bool {
        environment[environmentKey] == "1"
    }

    /// The clock the app's screens read: `fixedNow` in UI test mode, the
    /// device's clock otherwise.
    public static func now(environment: [String: String]) -> @Sendable () -> Date {
        if isEnabled(environment) {
            return { fixedNow }
        }
        return { Date() }
    }

    /// What the app runs on in UI test mode: the session over the stub, the
    /// stub's clock (which the screens read), the live panel's stub hub, and
    /// alerts on `StubNotifications`, and lock-screen activities held in
    /// memory (`StubLiveActivities`). The activities follow no readings: a
    /// second stub connection would change the readings the live panel's
    /// tests expect.
    @MainActor
    public static func makeApp(environment: [String: String]) -> (
        session: SessionModel, now: @Sendable () -> Date, live: LiveServices, notifications: NotificationsModel,
        activities: StubLiveActivities
    ) {
        let clock = StubClock()
        let (api, live) = StubAPI.uiTestWithLive(clock: clock)
        let session: SessionModel = environment[notConfiguredKey] == "1"
            ? .notConfigured()
            : SessionModel(
                tokenProvider: FakeTokenProvider(signInAccount: SignedInAccount(displayName: accountName)),
                api: api
            )
        let notifications = NotificationsModel(port: StubNotifications(environment: environment), session: session)
        return (session, { clock.now }, live.services, notifications, StubLiveActivities())
    }

    /// The session the app uses in UI test mode: signed out at launch.
    @MainActor
    public static func makeSession(environment: [String: String]) -> SessionModel {
        if environment[notConfiguredKey] == "1" {
            return .notConfigured()
        }
        return SessionModel(
            tokenProvider: FakeTokenProvider(signInAccount: SignedInAccount(displayName: accountName)),
            api: StubAPI.uiTest()
        )
    }
}
