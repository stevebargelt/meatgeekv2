import Foundation
public import MeatGeekAPI
import Observation
import OpenAPIRuntime

/// Whether the user is signed in, and the API client to use while they are.
///
/// On launch, `restore()` picks up a cached account silently. Any API call
/// made through `perform(_:)` that gets a 401, or a token request that needs
/// the user to sign in again, ends the session: the state goes to
/// `.signedOut(message: SessionModel.sessionEndedMessage)`. This mirrors the
/// web app (apps/web/src/auth/token.ts, apps/web/src/app/app.tsx).
@MainActor
@Observable
public final class SessionModel {
    public enum State: Equatable, Sendable {
        /// The config has no client id: nobody can sign in.
        case notConfigured
        /// Signed out; `message` says why when the session ended on its own.
        case signedOut(message: String?)
        /// Interactive sign-in, or the silent restore at launch, is running.
        case signingIn
        case signedIn(SignedInAccount)
        /// Sign-in failed, or the app cannot start sign-in at all.
        case failed(String)
    }

    /// Shown on the signed-out screen after a 401 or an expired session.
    public nonisolated static let sessionEndedMessage = "Your session ended. Sign in again."

    public private(set) var state: State

    @ObservationIgnored private let tokenProvider: (any TokenProvider)?
    @ObservationIgnored private let api: (any APIProtocol)?
    /// Runs at the start of `signOut()`, while the session can still call
    /// the API: `NotificationsModel` removes this phone's push token here.
    @ObservationIgnored public var beforeSignOut: (@MainActor () async -> Void)?

    /// A session that signs in with `tokenProvider` and calls `api`. Starts in
    /// `.signingIn` until `restore()` has looked for a cached account.
    public init(tokenProvider: any TokenProvider, api: any APIProtocol) {
        self.tokenProvider = tokenProvider
        self.api = api
        self.state = .signingIn
    }

    private init(state: State) {
        self.tokenProvider = nil
        self.api = nil
        self.state = state
    }

    /// A session for an app with no client id configured.
    public static func notConfigured() -> SessionModel {
        SessionModel(state: .notConfigured)
    }

    /// A session that cannot start, with the reason (e.g. an invalid config).
    public static func unavailable(_ message: String) -> SessionModel {
        SessionModel(state: .failed(message))
    }

    /// Whether `signIn()` can do anything (there is a token provider).
    public var canSignIn: Bool { tokenProvider != nil }

    /// Restores a cached account without user interaction: signed in if a
    /// token can be had silently, signed out otherwise.
    public func restore() async {
        guard let tokenProvider else { return }
        state = .signingIn
        guard let account = await tokenProvider.currentAccount else {
            state = .signedOut(message: nil)
            return
        }
        do {
            _ = try await tokenProvider.accessToken()
            state = .signedIn(account)
        } catch {
            if Self.endsSession(error) {
                state = .signedOut(message: Self.sessionEndedMessage)
            } else {
                state = .failed(Self.describe(error))
            }
        }
    }

    /// Interactive sign-in in the system browser.
    public func signIn() async {
        guard let tokenProvider, state != .signingIn else { return }
        state = .signingIn
        do {
            state = .signedIn(try await tokenProvider.signIn())
        } catch TokenProviderError.cancelled {
            state = .signedOut(message: nil)
        } catch {
            state = .failed("Sign-in failed. \(Self.describe(error))")
        }
    }

    /// Forgets the account and its tokens, after `beforeSignOut`.
    public func signOut() async {
        guard let tokenProvider else { return }
        if case .signedIn = state, let beforeSignOut {
            await beforeSignOut()
        }
        // Signed out either way: a cache that cannot be cleared must not keep
        // the user on a signed-in screen.
        try? await tokenProvider.signOut()
        state = .signedOut(message: nil)
    }

    /// Ends the session because the API refused it (a 401).
    public func endSession() {
        guard tokenProvider != nil else { return }
        state = .signedOut(message: Self.sessionEndedMessage)
    }

    /// Runs `operation` against the API. If it fails because the session is
    /// over (a 401, or a token that needs sign-in), the state moves to
    /// signed out and this throws `SessionError.sessionEnded`; other errors
    /// are rethrown as they are. A documented 401 *response* is not an
    /// error: callers handle `.unauthorized` by calling `endSession()`.
    public func perform<Output>(
        _ operation: (any APIProtocol) async throws -> Output
    ) async throws -> Output {
        guard let api, case .signedIn = state else { throw SessionError.notSignedIn }
        do {
            return try await operation(api)
        } catch {
            if Self.endsSession(error) {
                endSession()
                throw SessionError.sessionEnded
            }
            throw error
        }
    }

    /// True for errors that mean "sign in again": `TokenProviderError.signInRequired`
    /// (also when the generated client wraps it in a `ClientError`), and a
    /// `ClientError` carrying a 401 (App Service Authentication's bodiless 401).
    public nonisolated static func endsSession(_ error: any Error) -> Bool {
        if let error = error as? TokenProviderError {
            return error == .signInRequired
        }
        if let error = error as? ClientError {
            return error.response?.status == .unauthorized || endsSession(error.underlyingError)
        }
        return false
    }

    nonisolated static func describe(_ error: any Error) -> String {
        if let error = error as? TokenProviderError {
            switch error {
            case .signInRequired: return sessionEndedMessage
            case .cancelled: return "Sign-in was cancelled."
            case .failed(let message): return message
            }
        }
        if let error = error as? ClientError {
            return describe(error.underlyingError)
        }
        return error.localizedDescription
    }
}

/// Thrown by `SessionModel.perform(_:)`.
public enum SessionError: Error, Equatable, Sendable {
    /// Called while not signed in.
    case notSignedIn
    /// The call failed because the session is over; the session is now
    /// signed out with `SessionModel.sessionEndedMessage`.
    case sessionEnded
}
