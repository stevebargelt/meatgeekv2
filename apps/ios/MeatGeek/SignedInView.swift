import MeatGeekKit
import SwiftUI

/// Signed in: the app's tabs. Devices is the only one so far; the cooks
/// issue adds Cooks. Each tab's navigation bar carries the account menu.
struct SignedInView: View {
    let session: SessionModel
    @State private var profile: ProfileModel
    @State private var devices: DevicesModel

    init(session: SessionModel, now: @escaping @Sendable () -> Date) {
        self.session = session
        _profile = State(initialValue: ProfileModel(session: session))
        _devices = State(initialValue: DevicesModel(session: session, now: now))
    }

    var body: some View {
        TabView {
            Tab("Devices", systemImage: "flame") {
                DevicesView(model: devices, profile: profile, session: session)
            }
            .accessibilityIdentifier(AccessibilityID.devicesTab)
        }
        .task { await profile.load() }
    }
}

/// The signed-in user's name (from `GET /users/me`) and Sign out, in a menu
/// on the navigation bar.
struct AccountMenu: View {
    let profile: ProfileModel
    let session: SessionModel

    var body: some View {
        Menu {
            Section {
                switch profile.state {
                case .loading:
                    Text("Loading your profile…")
                case .loaded(let name):
                    Text(name).accessibilityIdentifier(AccessibilityID.accountName)
                case .noProfile(let name):
                    Text(name).accessibilityIdentifier(AccessibilityID.accountName)
                    Text("You have no MeatGeek profile yet.")
                case .failed(let message):
                    Text(message)
                    Button("Try again") { Task { await profile.load() } }
                }
            } header: {
                Text("Signed in as")
            }
            Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                Task { await session.signOut() }
            }
            .accessibilityIdentifier(AccessibilityID.signOut)
        } label: {
            Label("Account", systemImage: "person.crop.circle")
        }
        .accessibilityIdentifier(AccessibilityID.accountMenu)
    }
}

/// An API problem's message and request id, in red.
struct ProblemText: View {
    let problem: APIProblem

    var body: some View {
        Text(problem.text)
            .foregroundStyle(.red)
            .textSelection(.enabled)
    }
}
