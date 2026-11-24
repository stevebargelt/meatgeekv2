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

    public static func isEnabled(_ environment: [String: String]) -> Bool {
        environment[environmentKey] == "1"
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
