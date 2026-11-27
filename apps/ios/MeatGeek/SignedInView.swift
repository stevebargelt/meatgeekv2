import MeatGeekKit
import SwiftUI

/// Signed in: the app's tabs, Cooks then Devices. Each tab's navigation bar
/// carries the account menu. The tabs share one devices model and one cooks
/// model, so a cook started on the Devices tab is on the Cooks tab too.
///
/// A running cook started here gets a lock-screen activity (the cooks
/// model's `CookActivityTracker`); tapping it opens `meatgeek://cook/<id>`,
/// which `MeatGeekApp` puts in `openCook`; this shows that cook's screen on
/// the Cooks tab.
struct SignedInView: View {
    private enum TabID: Hashable { case cooks, devices }

    let session: SessionModel
    @State private var profile: ProfileModel
    @State private var devices: DevicesModel
    @State private var cooks: CooksModel
    @State private var tab: TabID = .cooks
    @State private var cooksPath: [Route] = []
    @Environment(\.scenePhase) private var scenePhase
    /// A cook to open, from a tapped lock-screen activity. Cleared once shown.
    @Binding var openCook: String?

    init(
        session: SessionModel, now: @escaping @Sendable () -> Date, live: LiveServices?,
        activities: (any LiveActivities)? = nil, activityLive: LiveServices? = nil,
        openCook: Binding<String?> = .constant(nil)
    ) {
        self.session = session
        _openCook = openCook
        let devices = DevicesModel(session: session, now: now)
        _profile = State(initialValue: ProfileModel(session: session))
        _devices = State(initialValue: devices)
        _cooks = State(initialValue: CooksModel(
            devices: devices, now: now, live: live, activities: activities, activityLive: activityLive
        ))
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Cooks", systemImage: "list.bullet.rectangle", value: TabID.cooks) {
                CooksView(model: cooks, profile: profile, session: session, path: $cooksPath)
            }
            .accessibilityIdentifier(AccessibilityID.cooksTab)
            Tab("Devices", systemImage: "flame", value: TabID.devices) {
                DevicesView(model: devices, cooks: cooks, profile: profile, session: session)
            }
            .accessibilityIdentifier(AccessibilityID.devicesTab)
        }
        .task { await profile.load() }
        .onChange(of: openCook, initial: true) { _, cookID in
            guard let cookID else { return }
            tab = .cooks
            cooksPath = [.cook(cookID)]
            openCook = nil
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            cooks.activities?.setAppActive(phase == .active)
        }
        .onDisappear { cooks.activities?.stop() }
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
