import Foundation
public import MeatGeekKit
import MSAL
import UIKit

/// The real `TokenProvider`: Entra ID through MSAL.
///
/// - Sign-in runs the authorization-code flow with PKCE in the system browser
///   (`ASWebAuthenticationSession`, MSAL's `.authenticationSession` webview).
///   The app is a public client: there is no secret.
/// - Tokens live in MSAL's keychain cache; there is no other token store. The
///   cache's keychain group is the app's own bundle id, which every app may
///   use without a keychain-sharing entitlement (see apps/ios/README.md).
/// - `accessToken()` is `acquireTokenSilent` (cache, then refresh token). When
///   MSAL says the user must interact, or there is no account, it throws
///   `TokenProviderError.signInRequired`.
///
/// Main-actor isolated: MSAL's application object is not thread-safe to share,
/// and interactive sign-in presents from the key window.
@MainActor
public final class MSALTokenProvider: TokenProvider {
    private let application: MSALPublicClientApplication
    private let scopes: [String]

    /// - Parameters:
    ///   - config: a `.ready` config (non-empty client id).
    ///   - bundleIdentifier: the app's bundle id; the redirect URI is
    ///     `msauth.<bundleIdentifier>://auth`, as registered by bootstrap.sh.
    public init(config: AppConfig, bundleIdentifier: String) throws {
        let authority = try MSALAADAuthority(url: config.authorityURL)
        let msalConfig = MSALPublicClientApplicationConfig(
            clientId: config.clientID,
            redirectUri: Self.redirectURI(bundleIdentifier: bundleIdentifier),
            authority: authority
        )
        // The app's own keychain group: no keychain-access-groups entitlement
        // needed (MSAL's default group, com.microsoft.adalcache, needs one).
        msalConfig.cacheConfig.keychainSharingGroup = bundleIdentifier
        application = try MSALPublicClientApplication(configuration: msalConfig)
        // MSAL adds openid, profile and offline_access itself.
        scopes = [config.apiScope]
    }

    /// `msauth.<bundle id>://auth`, the registration's redirect URI.
    public nonisolated static func redirectURI(bundleIdentifier: String) -> String {
        "msauth.\(bundleIdentifier)://auth"
    }

    /// Hands a URL the app was opened with to MSAL (a response from the
    /// Microsoft Authenticator broker). Returns whether MSAL took it.
    @discardableResult
    public static func handle(url: URL) -> Bool {
        MSALPublicClientApplication.handleMSALResponse(url, sourceApplication: nil)
    }

    public func signIn() async throws -> SignedInAccount {
        guard let presenter = Self.presentingViewController() else {
            throw TokenProviderError.failed("There is no window to show the sign-in page in.")
        }
        let webview = MSALWebviewParameters(authPresentationViewController: presenter)
        webview.webviewType = .authenticationSession
        let parameters = MSALInteractiveTokenParameters(scopes: scopes, webviewParameters: webview)
        parameters.promptType = .selectAccount
        let result = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<SignedInAccount, any Error>) in
            application.acquireToken(with: parameters) { result, error in
                if let result {
                    continuation.resume(returning: Self.signedInAccount(result.account))
                } else {
                    continuation.resume(throwing: Self.map(error))
                }
            }
        }
        return result
    }

    public func signOut() async throws {
        do {
            for account in try application.allAccounts() {
                try application.remove(account)
            }
        } catch {
            throw Self.map(error)
        }
    }

    public func accessToken() async throws -> String {
        guard let account = cachedAccount() else { throw TokenProviderError.signInRequired }
        let parameters = MSALSilentTokenParameters(scopes: scopes, account: account)
        return try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<String, any Error>) in
            application.acquireTokenSilent(with: parameters) { result, error in
                if let result {
                    continuation.resume(returning: result.accessToken)
                } else {
                    continuation.resume(throwing: Self.map(error))
                }
            }
        }
    }

    public var currentAccount: SignedInAccount? {
        cachedAccount().map(Self.signedInAccount)
    }

    // MARK: - Helpers

    private func cachedAccount() -> MSALAccount? {
        (try? application.allAccounts())?.first
    }

    private nonisolated static func signedInAccount(_ account: MSALAccount) -> SignedInAccount {
        let name = account.accountClaims?["name"] as? String
        return SignedInAccount(displayName: name ?? account.username ?? "Signed in")
    }

    /// MSAL's errors as `TokenProviderError`.
    private nonisolated static func map(_ error: (any Error)?) -> TokenProviderError {
        guard let error = error as NSError? else {
            return .failed("Sign-in returned neither a result nor an error.")
        }
        if error.domain == MSALErrorDomain {
            switch error.code {
            case MSALError.interactionRequired.rawValue:
                return .signInRequired
            case MSALError.userCanceled.rawValue:
                return .cancelled
            default:
                break
            }
        }
        let description = error.userInfo[MSALErrorDescriptionKey] as? String ?? error.localizedDescription
        return .failed(description)
    }

    /// The top-most view controller of the foreground window, to present the
    /// browser sheet from.
    private static func presentingViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        let window = scene?.keyWindow ?? scene?.windows.first
        var top = window?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}
