import Foundation
import HTTPTypes
import MeatGeekAPI
import OpenAPIRuntime
import Testing
@testable import MeatGeekKit

/// The session and the home screen's profile load, on `FakeTokenProvider`
/// and `StubAPI` (or the generated client over `FakeTransport`). No MSAL, no
/// network, no clock: every step is awaited.
@Suite("SessionModel")
@MainActor
struct SessionModelTests {
    static let pat = SignedInAccount(displayName: "Pat Pitmaster")
    static let ended = SessionModel.State.signedOut(message: "Your session ended. Sign in again.")

    @Test("starts signing in, before restore runs")
    func initialState() {
        let session = SessionModel(tokenProvider: FakeTokenProvider(), api: StubAPI())
        #expect(session.state == .signingIn)
        #expect(session.canSignIn)
    }

    @Test("restore with a cached account that gets a token silently is signed in")
    func restoreSucceeds() async {
        let provider = FakeTokenProvider(account: Self.pat)
        let session = SessionModel(tokenProvider: provider, api: StubAPI())

        await session.restore()

        #expect(session.state == .signedIn(Self.pat))
        #expect(await provider.tokenRequestCount == 1)
        #expect(await provider.signInCount == 0)
    }

    @Test("restore with no cached account is signed out, with no message")
    func restoreNoAccount() async {
        let provider = FakeTokenProvider()
        let session = SessionModel(tokenProvider: provider, api: StubAPI())

        await session.restore()

        #expect(session.state == .signedOut(message: nil))
        #expect(await provider.tokenRequestCount == 0)
    }

    @Test("restore that needs sign-in is signed out with the session-ended message")
    func restoreSignInRequired() async {
        let provider = FakeTokenProvider(account: Self.pat, tokenError: .signInRequired)
        let session = SessionModel(tokenProvider: provider, api: StubAPI())

        await session.restore()

        #expect(session.state == Self.ended)
    }

    @Test("restore that fails another way is failed, not signed out")
    func restoreOtherFailure() async {
        let provider = FakeTokenProvider(account: Self.pat, tokenError: .failed("The network is offline."))
        let session = SessionModel(tokenProvider: provider, api: StubAPI())

        await session.restore()

        #expect(session.state == .failed("The network is offline."))
    }

    @Test("sign-in signs in as the provider's account")
    func signIn() async {
        let provider = FakeTokenProvider(signInAccount: Self.pat)
        let session = SessionModel(tokenProvider: provider, api: StubAPI())
        await session.restore()

        await session.signIn()

        #expect(session.state == .signedIn(Self.pat))
        #expect(await provider.signInCount == 1)
    }

    @Test("a cancelled sign-in is signed out with no message")
    func signInCancelled() async {
        let session = SessionModel(tokenProvider: FakeTokenProvider(signInError: .cancelled), api: StubAPI())
        await session.restore()

        await session.signIn()

        #expect(session.state == .signedOut(message: nil))
    }

    @Test("a failed sign-in is failed, with the reason")
    func signInFailed() async {
        let session = SessionModel(
            tokenProvider: FakeTokenProvider(signInError: .failed("AADSTS50011: redirect URI mismatch")),
            api: StubAPI()
        )
        await session.restore()

        await session.signIn()

        #expect(session.state == .failed("Sign-in failed. AADSTS50011: redirect URI mismatch"))
    }

    @Test("sign-out clears the provider's account and is signed out")
    func signOut() async {
        let provider = FakeTokenProvider(account: Self.pat)
        let session = SessionModel(tokenProvider: provider, api: StubAPI())
        await session.restore()
        #expect(session.state == .signedIn(Self.pat))

        await session.signOut()

        #expect(session.state == .signedOut(message: nil))
        #expect(await provider.signOutCount == 1)
        #expect(await provider.currentAccount == nil)
        // A later launch finds nothing to restore.
        await session.restore()
        #expect(session.state == .signedOut(message: nil))
    }

    @Test("not configured: no sign-in, and restore and sign-in do nothing")
    func notConfigured() async {
        let session = SessionModel.notConfigured()
        #expect(session.state == .notConfigured)
        #expect(!session.canSignIn)

        await session.restore()
        await session.signIn()
        session.endSession()

        #expect(session.state == .notConfigured)
    }

    @Test("perform refuses to call the API while signed out")
    func performWhileSignedOut() async {
        let session = SessionModel(tokenProvider: FakeTokenProvider(), api: StubAPI.uiTest())
        await session.restore()

        await #expect(throws: SessionError.notSignedIn) {
            _ = try await session.perform { api in try await api.getUserProfile() }
        }
    }

    @Test("endsSession recognises a 401 and sign-in-required, wrapped or not")
    func endsSession() {
        #expect(SessionModel.endsSession(TokenProviderError.signInRequired))
        #expect(!SessionModel.endsSession(TokenProviderError.cancelled))
        #expect(!SessionModel.endsSession(TokenProviderError.failed("x")))
        #expect(SessionModel.endsSession(Self.clientError(underlying: TokenProviderError.signInRequired)))
        #expect(SessionModel.endsSession(
            Self.clientError(underlying: StubAPI.NotStubbed(operationID: "x"), status: .unauthorized)
        ))
        #expect(!SessionModel.endsSession(
            Self.clientError(underlying: StubAPI.NotStubbed(operationID: "x"), status: .internalServerError)
        ))
        #expect(!SessionModel.endsSession(URLError(.notConnectedToInternet)))
    }

    static func clientError(underlying: any Error, status: HTTPResponse.Status? = nil) -> ClientError {
        ClientError(
            operationID: "getUserProfile",
            operationInput: Operations.GetUserProfile.Input(),
            request: nil,
            requestBody: nil,
            baseURL: nil,
            response: status.map { HTTPResponse(status: $0) },
            responseBody: nil,
            causeDescription: "test",
            underlyingError: underlying
        )
    }
}

@Suite("HomeModel")
@MainActor
struct HomeModelTests {
    static let account = SignedInAccount(displayName: "Account Name")
    static let ended = SessionModel.State.signedOut(message: "Your session ended. Sign in again.")

    /// A signed-in session over `api`.
    static func signedIn(
        api: any APIProtocol,
        provider: FakeTokenProvider = FakeTokenProvider(account: account)
    ) async -> SessionModel {
        let session = SessionModel(tokenProvider: provider, api: api)
        await session.restore()
        #expect(session.state == .signedIn(account))
        return session
    }

    @Test("shows the name from GET /users/me")
    func loadsProfile() async {
        let session = await Self.signedIn(api: StubAPI.uiTest())
        let home = HomeModel(session: session)
        #expect(home.state == .loading)

        await home.load()

        #expect(home.state == .loaded(displayName: "Pat Pitmaster"))
        #expect(session.state == .signedIn(Self.account))
    }

    @Test("the handler's 401 signs the session out with the message")
    func handlerUnauthorized() async {
        var api = StubAPI()
        api.getUserProfileHandler = { _ in
            .unauthorized(.init(body: .json(.init(
                error: .unauthenticated, reason: .principalHeaderMissing, requestId: "req-401"
            ))))
        }
        let session = await Self.signedIn(api: api)
        let home = HomeModel(session: session)

        await home.load()

        #expect(session.state == Self.ended)
    }

    @Test("Easy Auth's bodiless 401, through the real client, signs the session out with the message")
    func platformUnauthorized() async {
        let provider = FakeTokenProvider(account: Self.account)
        let transport = FakeTransport(response: .init(status: .unauthorized, body: nil))
        let client = APIClientFactory.makeClient(
            baseURL: APIClientTests.baseURL, tokenProvider: provider, transport: transport
        )
        let session = await Self.signedIn(api: client, provider: provider)
        let home = HomeModel(session: session)

        await home.load()

        #expect(session.state == Self.ended)
        #expect(await transport.requests.count == 1)
    }

    @Test("the bearer middleware sends the provider's token")
    func bearerFromProvider() async throws {
        let provider = FakeTokenProvider(account: Self.account, token: "token-from-provider")
        let transport = FakeTransport(response: .json(status: .ok, Data(Self.userJSON.utf8)))
        let client = APIClientFactory.makeClient(
            baseURL: APIClientTests.baseURL, tokenProvider: provider, transport: transport
        )
        let session = await Self.signedIn(api: client, provider: provider)
        let home = HomeModel(session: session)

        await home.load()

        #expect(home.state == .loaded(displayName: "Profile Name"))
        let sent = try #require(await transport.requests.first)
        #expect(sent.request.path == "/users/me")
        #expect(sent.request.headerFields[.authorization] == "Bearer token-from-provider")
        // One token for restore, one for the request.
        #expect(await provider.tokenRequestCount == 2)
    }

    @Test("sign-in-required from the provider, through the middleware, signs out instead of failing")
    func signInRequiredThroughMiddleware() async {
        let provider = FakeTokenProvider(account: Self.account)
        let transport = FakeTransport(response: .json(status: .ok, Data(Self.userJSON.utf8)))
        let client = APIClientFactory.makeClient(
            baseURL: APIClientTests.baseURL, tokenProvider: provider, transport: transport
        )
        let session = await Self.signedIn(api: client, provider: provider)
        let home = HomeModel(session: session)
        await provider.setTokenError(.signInRequired)

        await home.load()

        #expect(session.state == Self.ended)
        #expect(home.state == .loading) // never shown as an error
        #expect(await transport.requests.isEmpty) // nothing sent without a token
    }

    @Test("no profile yet (404) shows the account's own name")
    func noProfile() async {
        var api = StubAPI()
        api.getUserProfileHandler = { _ in
            .notFound(.init(body: .json(.init(
                error: .userNotFound, message: "No profile.", requestId: "req-404"
            ))))
        }
        let session = await Self.signedIn(api: api)
        let home = HomeModel(session: session)

        await home.load()

        #expect(home.state == .noProfile(displayName: "Account Name"))
        #expect(session.state == .signedIn(Self.account))
    }

    @Test("another failure shows an error and keeps the session")
    func otherFailure() async {
        var api = StubAPI()
        api.getUserProfileHandler = { _ in throw URLError(.notConnectedToInternet) }
        let session = await Self.signedIn(api: api)
        let home = HomeModel(session: session)

        await home.load()

        guard case .failed(let message) = home.state else {
            Issue.record("expected .failed, got \(home.state)")
            return
        }
        #expect(message.hasPrefix("Your profile could not be loaded."))
        #expect(session.state == .signedIn(Self.account))
    }

    @Test("an undocumented status shows an error with the status")
    func undocumented() async {
        var api = StubAPI()
        api.getUserProfileHandler = { _ in .undocumented(statusCode: 503, .init()) }
        let session = await Self.signedIn(api: api)
        let home = HomeModel(session: session)

        await home.load()

        #expect(home.state == .failed("Your profile could not be loaded (HTTP 503)."))
    }

    static let userJSON = """
    {
      "id": "tid:oid",
      "email": "profile@example.test",
      "name": "Profile Name",
      "preferences": {
        "temperatureUnit": "celsius",
        "timeZone": "UTC",
        "notifications": {
          "tempAlerts": true, "cookComplete": true, "deviceOffline": true,
          "weeklyReports": false, "productUpdates": false,
          "pushNotifications": {
            "enabled": true, "sound": true, "vibration": true,
            "quietHours": { "enabled": false, "startTime": "22:00", "endTime": "07:00" }
          },
          "email": { "enabled": false, "frequency": "daily" },
          "sms": { "enabled": false }
        },
        "defaultTargetTemps": {},
        "privacy": { "shareData": false, "publicProfile": false, "allowAnalytics": false },
        "display": { "theme": "auto", "compactMode": false, "showAdvancedMetrics": false }
      },
      "devices": [],
      "createdAt": "2026-11-20T15:00:00.000Z"
    }
    """
}

@Suite("UI test mode and the stub API")
@MainActor
struct UITestModeTests {
    @Test("is on only for MEATGEEK_UI_TEST=1")
    func enabled() {
        #expect(UITestMode.isEnabled(["MEATGEEK_UI_TEST": "1"]))
        #expect(!UITestMode.isEnabled([:]))
        #expect(!UITestMode.isEnabled(["MEATGEEK_UI_TEST": "0"]))
    }

    @Test("starts signed out, signs in on the fakes and shows the stub user")
    func session() async {
        let session = UITestMode.makeSession(environment: ["MEATGEEK_UI_TEST": "1"])
        await session.restore()
        #expect(session.state == .signedOut(message: nil))

        await session.signIn()
        #expect(session.state == .signedIn(SignedInAccount(displayName: UITestMode.accountName)))

        let home = HomeModel(session: session)
        await home.load()
        #expect(home.state == .loaded(displayName: StubAPI.uiTestUserName))
    }

    @Test("MEATGEEK_UI_TEST_NOT_CONFIGURED=1 starts not configured")
    func notConfigured() {
        let session = UITestMode.makeSession(environment: [
            "MEATGEEK_UI_TEST": "1", "MEATGEEK_UI_TEST_NOT_CONFIGURED": "1",
        ])
        #expect(session.state == .notConfigured)
    }

    @Test("an operation nobody stubbed throws NotStubbed")
    func notStubbed() async {
        await #expect(throws: StubAPI.NotStubbed(operationID: "getDevices")) {
            _ = try await StubAPI.uiTest().getDevices()
        }
    }
}
