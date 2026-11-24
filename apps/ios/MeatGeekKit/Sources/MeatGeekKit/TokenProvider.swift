/// The account a user is signed in with, as the sign-in library knows it.
public struct SignedInAccount: Sendable, Equatable {
    /// The name to show for the account (the token's `name` claim, or the
    /// username when there is none).
    public let displayName: String

    public init(displayName: String) {
        self.displayName = displayName
    }
}

/// Why a `TokenProvider` call failed.
public enum TokenProviderError: Error, Equatable, Sendable {
    /// There is no signed-in account, or the cached one can no longer get a
    /// token without the user (expired refresh token, revoked consent, …).
    /// The session ends and the user signs in again.
    case signInRequired
    /// The user closed the sign-in browser sheet.
    case cancelled
    /// Anything else, with a message to show.
    case failed(String)
}

/// Signs the user in and hands out access tokens for the API.
///
/// `MSALTokenProvider` (target MeatGeekMSAL) is the real one: Entra in the
/// system browser, tokens in MSAL's keychain cache. `FakeTokenProvider` is for
/// unit tests and the app's UI test mode.
public protocol TokenProvider: Sendable {
    /// Signs in interactively and returns the account.
    /// Throws `TokenProviderError.cancelled` if the user backs out.
    func signIn() async throws -> SignedInAccount
    /// Forgets the signed-in account and its cached tokens.
    func signOut() async throws
    /// An access token for the API scope, without user interaction (from the
    /// cache, or refreshed). Throws `TokenProviderError.signInRequired` when
    /// there is no account or the user has to sign in again.
    func accessToken() async throws -> String
    /// The cached account, if any. Does not touch the network.
    var currentAccount: SignedInAccount? { get async }
}

/// A `TokenProvider` with no identity provider behind it. Signing in always
/// succeeds as `signInAccount` (unless `signInError` is set) and tokens are
/// `token`. Used by the unit tests and by the app when launched with
/// `MEATGEEK_UI_TEST=1`.
public actor FakeTokenProvider: TokenProvider {
    public private(set) var account: SignedInAccount?
    public var signInAccount: SignedInAccount
    public var token: String
    /// When set, `signIn()` throws it.
    public var signInError: TokenProviderError?
    /// When set, `accessToken()` throws it, signed in or not.
    public var tokenError: TokenProviderError?

    public private(set) var signInCount = 0
    public private(set) var signOutCount = 0
    public private(set) var tokenRequestCount = 0

    /// - Parameters:
    ///   - account: the account already cached at launch; nil means signed out.
    ///   - signInAccount: who `signIn()` signs in as.
    ///   - token: what `accessToken()` returns while signed in.
    public init(
        account: SignedInAccount? = nil,
        signInAccount: SignedInAccount = SignedInAccount(displayName: "Fake Account"),
        token: String = "fake-access-token",
        signInError: TokenProviderError? = nil,
        tokenError: TokenProviderError? = nil
    ) {
        self.account = account
        self.signInAccount = signInAccount
        self.token = token
        self.signInError = signInError
        self.tokenError = tokenError
    }

    public func setTokenError(_ error: TokenProviderError?) {
        tokenError = error
    }

    public func signIn() async throws -> SignedInAccount {
        signInCount += 1
        if let signInError { throw signInError }
        account = signInAccount
        return signInAccount
    }

    public func signOut() async throws {
        signOutCount += 1
        account = nil
    }

    public func accessToken() async throws -> String {
        tokenRequestCount += 1
        if let tokenError { throw tokenError }
        guard account != nil else { throw TokenProviderError.signInRequired }
        return token
    }

    public var currentAccount: SignedInAccount? { account }
}
