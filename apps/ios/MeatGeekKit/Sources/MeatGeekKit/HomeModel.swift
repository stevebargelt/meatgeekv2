import MeatGeekAPI
import Observation

/// The placeholder home screen: who is signed in, from `GET /users/me`.
/// Later issues replace the home screen with tabs.
@MainActor
@Observable
public final class HomeModel {
    public enum State: Equatable, Sendable {
        case loading
        /// The profile's name.
        case loaded(displayName: String)
        /// No MeatGeek profile yet (404 USER_NOT_FOUND, until the first
        /// PUT /users/me): the account's own name stands in.
        case noProfile(displayName: String)
        case failed(String)
    }

    public private(set) var state: State = .loading

    @ObservationIgnored private let session: SessionModel

    public init(session: SessionModel) {
        self.session = session
    }

    /// Loads the profile. A 401 or a token that needs sign-in ends the
    /// session (see `SessionModel.perform(_:)`) instead of showing an error.
    public func load() async {
        state = .loading
        do {
            let output = try await session.perform { api in try await api.getUserProfile() }
            switch output {
            case .ok(let ok):
                state = .loaded(displayName: try ok.body.json.name)
            case .unauthorized:
                session.endSession()
            case .notFound:
                state = .noProfile(displayName: accountName)
            case .internalServerError:
                state = .failed("The server could not load your profile. Try again later.")
            case .undocumented(let statusCode, _):
                state = .failed("Your profile could not be loaded (HTTP \(statusCode)).")
            }
        } catch SessionError.sessionEnded {
            // The session is signed out; the root screen shows why.
        } catch {
            state = .failed("Your profile could not be loaded. \(SessionModel.describe(error))")
        }
    }

    private var accountName: String {
        if case .signedIn(let account) = session.state { return account.displayName }
        return ""
    }
}
