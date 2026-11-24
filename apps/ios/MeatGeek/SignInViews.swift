import MeatGeekKit
import SwiftUI

/// Signed out: a "Sign in with Microsoft" button, with why the session ended
/// or why sign-in failed, if either.
struct SignedOutView: View {
    let root: RootModel
    let session: SessionModel
    let notice: String?
    let error: String?

    var body: some View {
        VStack(spacing: 24) {
            AppHeader(root: root)
            Text("Sign in to see and manage your devices.")
                .multilineTextAlignment(.center)
            if let notice {
                Text(notice)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier(AccessibilityID.signedOutNotice)
            }
            if let error {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier(AccessibilityID.signedOutError)
            }
            if session.canSignIn {
                Button("Sign in with Microsoft") {
                    Task { await session.signIn() }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier(AccessibilityID.signIn)
            }
        }
        .padding()
    }
}

/// No client id in the config: the iOS app registration does not exist yet.
struct NotConfiguredView: View {
    let root: RootModel

    var body: some View {
        VStack(spacing: 24) {
            AppHeader(root: root)
            Text("Sign-in is not configured")
                .font(.title2.bold())
                .accessibilityIdentifier(AccessibilityID.notConfigured)
            Text(
                "This build has no Entra app registration for the iOS app, so nobody can sign in. "
                    + "Once the registration exists, its client ID goes in MEATGEEK_CLIENT_ID "
                    + "(apps/ios/Config/Dev.xcconfig) and this screen goes away."
            )
            .multilineTextAlignment(.center)
            .foregroundStyle(.secondary)
        }
        .padding()
    }
}

/// The placeholder home: the signed-in user's name from GET /users/me, and
/// sign-out. Later issues replace it with tabs.
struct HomeView: View {
    let session: SessionModel
    @State private var model: HomeModel

    init(session: SessionModel) {
        self.session = session
        _model = State(initialValue: HomeModel(session: session))
    }

    var body: some View {
        VStack(spacing: 24) {
            switch model.state {
            case .loading:
                ProgressView("Loading your profile…")
            case .loaded(let name):
                Text("Signed in as")
                    .foregroundStyle(.secondary)
                Text(name)
                    .font(.title.bold())
                    .accessibilityIdentifier(AccessibilityID.homeDisplayName)
            case .noProfile(let name):
                Text("Signed in as")
                    .foregroundStyle(.secondary)
                Text(name)
                    .font(.title.bold())
                    .accessibilityIdentifier(AccessibilityID.homeDisplayName)
                Text("You have no MeatGeek profile yet.")
                    .foregroundStyle(.secondary)
            case .failed(let message):
                Text(message)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                Button("Try again") {
                    Task { await model.load() }
                }
            }
            Button("Sign out") {
                Task { await session.signOut() }
            }
            .accessibilityIdentifier(AccessibilityID.signOut)
        }
        .padding()
        .task { await model.load() }
    }
}
