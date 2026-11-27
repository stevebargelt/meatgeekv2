import MeatGeekKit
import SwiftUI

/// Signed in: the app's tabs, Cooks then Devices. Each tab's navigation bar
/// carries the account menu. The tabs share one devices model and one cooks
/// model, so a cook started on the Devices tab is on the Cooks tab too.
///
/// A running cook started here gets a lock-screen activity (the cooks
/// model's `CookActivityTracker`); tapping it opens `meatgeek://cook/<id>`,
/// which `MeatGeekApp` puts in `openCook`; this shows that cook's screen on
/// the Cooks tab. A tapped alert opens its cook on the Cooks tab too,
/// whichever tab showed.
struct SignedInView: View {
    enum TabID: Hashable { case cooks, devices, pushTokens }

    let session: SessionModel
    let notifications: NotificationsModel?
    @State private var profile: ProfileModel
    @State private var devices: DevicesModel
    @State private var cooks: CooksModel
    @State private var tab = TabID.cooks
    @State private var cooksPath: [Route] = []
    @Environment(\.scenePhase) private var scenePhase
    #if DEBUG
    /// Debug builds only: the push tokens for hand-sent test pushes (#248).
    @State private var pushTokens: ActivityPushTokensModel?
    #endif
    /// A cook to open, from a tapped lock-screen activity. Cleared once shown.
    @Binding var openCook: String?

    init(
        session: SessionModel,
        now: @escaping @Sendable () -> Date,
        live: LiveServices?,
        notifications: NotificationsModel? = nil,
        activities: (any LiveActivities)? = nil,
        activityLive: LiveServices? = nil,
        openCook: Binding<String?> = .constant(nil)
    ) {
        self.session = session
        self.notifications = notifications
        _openCook = openCook
        let devices = DevicesModel(session: session, now: now)
        _profile = State(initialValue: ProfileModel(session: session))
        _devices = State(initialValue: devices)
        _cooks = State(initialValue: CooksModel(
            devices: devices, now: now, live: live, notifications: notifications,
            activities: activities, activityLive: activityLive
        ))
        #if DEBUG
        _pushTokens = State(initialValue: activities.map { ActivityPushTokensModel(port: $0, now: now) })
        #endif
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
            #if DEBUG
            if let pushTokens {
                Tab("Push", systemImage: "antenna.radiowaves.left.and.right", value: TabID.pushTokens) {
                    PushTokensView(model: pushTokens)
                }
            }
            #endif
        }
        .task { await profile.load() }
        // Signed in, and each time the app comes back: the permission may
        // have changed in Settings, and a granted one registers the phone.
        // The lock-screen activities follow readings only while active.
        .onChange(of: scenePhase, initial: true) { _, phase in
            if phase == .active { notifications?.refresh() }
            cooks.activities?.setAppActive(phase == .active)
            #if DEBUG
            if phase == .active { pushTokens?.start() }
            #endif
        }
        .onChange(of: notifications?.openCookID, initial: true) { _, cookID in
            guard let cookID else { return }
            tab = .cooks
            cooksPath = [.cook(cookID)]
            notifications?.cookOpened()
        }
        .onChange(of: openCook, initial: true) { _, cookID in
            guard let cookID else { return }
            tab = .cooks
            cooksPath = [.cook(cookID)]
            openCook = nil
        }
        .onDisappear {
            cooks.activities?.stop()
            #if DEBUG
            pushTokens?.stop()
            #endif
        }
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
