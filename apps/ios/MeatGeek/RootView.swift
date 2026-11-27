import MeatGeekKit
import SwiftUI

/// The root screen: one of the sign-in states, or the signed-in tabs.
struct RootView: View {
    let root: RootModel
    let session: SessionModel
    /// The clock the screens read: the device's, or UI test mode's.
    var now: @Sendable () -> Date = { Date() }
    /// What an active cook's live panel connects with.
    var live: LiveServices?

    var body: some View {
        switch session.state {
        case .notConfigured:
            NotConfiguredView(root: root)
        case .signedOut(let message):
            SignedOutView(root: root, session: session, notice: message, error: nil)
        case .failed(let message):
            SignedOutView(root: root, session: session, notice: nil, error: message)
        case .signingIn:
            ProgressView("Signing in…")
                .accessibilityIdentifier(AccessibilityID.signingIn)
        case .signedIn:
            SignedInView(session: session, now: now, live: live)
        }
    }
}

/// Identifiers the UI tests find elements by.
enum AccessibilityID {
    static let title = "root.title"
    static let version = "root.version"
    static let signingIn = "root.signingIn"
    static let notConfigured = "notConfigured.title"
    static let signIn = "signedOut.signIn"
    static let signedOutNotice = "signedOut.notice"
    static let signedOutError = "signedOut.error"
    static let accountMenu = "account.menu"
    static let accountName = "account.displayName"
    static let signOut = "account.signOut"
    static let devicesTab = "tab.devices"
    static let claimDevice = "devices.claim"
    static let devicesLoading = "devices.loading"
    static let devicesEmpty = "devices.empty"
    static let devicesError = "devices.error"
    static let devicesNotice = "devices.notice"
    static let devicesCooksProblem = "devices.cooksProblem"
    static func deviceRow(_ id: String) -> String { "device.row.\(id)" }
    static func deviceName(_ id: String) -> String { "device.name.\(id)" }
    static func deviceConnection(_ id: String) -> String { "device.connection.\(id)" }
    static func deviceCooking(_ id: String) -> String { "device.cooking.\(id)" }
    static func deviceRename(_ id: String) -> String { "device.rename.\(id)" }
    static func deviceRelease(_ id: String) -> String { "device.release.\(id)" }
    static let detailRename = "deviceDetail.rename"
    static let detailRelease = "deviceDetail.release"
    static let confirmRelease = "release.confirm"
    static let claimDeviceID = "claim.deviceID"
    static let claimCode = "claim.claimCode"
    static let claimName = "claim.name"
    static let claimLocation = "claim.location"
    static let claimSubmit = "claim.submit"
    static let claimCancel = "claim.cancel"
    static let claimProblem = "claim.problem"
    static let renameName = "rename.name"
    static let renameSave = "rename.save"
    static let renameCancel = "rename.cancel"
    static let renameProblem = "rename.problem"
    static func deviceStartCook(_ id: String) -> String { "device.startCook.\(id)" }
    static let detailStartCook = "deviceDetail.startCook"
    static let detailOpenCook = "deviceDetail.openCook"
    static let cooksTab = "tab.cooks"
    static let cooksLoading = "cooks.loading"
    static let cooksEmpty = "cooks.empty"
    static let cooksError = "cooks.error"
    static let cooksMoreProblem = "cooks.moreProblem"
    static let cooksLoadMore = "cooks.loadMore"
    static let cooksFilter = "cooks.filter"
    static let cooksFilterSummary = "cooks.filterSummary"
    static let cooksClearFilters = "cooks.clearFilters"
    static func cookRow(_ id: String) -> String { "cook.row.\(id)" }
    static func cookName(_ id: String) -> String { "cook.name.\(id)" }
    static func cookStatus(_ id: String) -> String { "cook.status.\(id)" }
    static let cookDetailLoading = "cookDetail.loading"
    static let cookDetailNotFound = "cookDetail.notFound"
    static let cookDetailError = "cookDetail.error"
    static let cookDetailStatus = "cookDetail.status"
    static let cookDetailEnded = "cookDetail.ended"
    static let cookDetailStop = "cookDetail.stop"
    static let cookDetailStopProblem = "cookDetail.stopProblem"
    static let chart = "chart.chart"
    static let chartLoading = "chart.loading"
    static let chartNotAvailable = "chart.notAvailable"
    static let chartError = "chart.error"
    static let chartRetry = "chart.retry"
    static let chartEmpty = "chart.empty"
    static let liveBadge = "live.badge"
    static func liveChannel(_ channel: String) -> String { "live.channel.\(channel)" }
    static func liveTarget(_ channel: String) -> String { "live.target.\(channel)" }
    static func liveReached(_ channel: String) -> String { "live.reached.\(channel)" }
    static let liveReadingTime = "live.readingTime"
    static let liveWaiting = "live.waiting"
    static let liveSignedOut = "live.signedOut"
    static let liveTestMenu = "live.test.menu"
    static let liveTestDrop = "live.test.drop"
    static let liveTestReconnect = "live.test.reconnect"
    static let liveTestAdvanceClock = "live.test.advanceClock"
    static let liveTestCookStopped = "live.test.cookStopped"
    static let confirmStop = "stop.confirm"
    static let startName = "startCook.name"
    static let startMeatType = "startCook.meatType"
    static let startWeight = "startCook.weight"
    static func startTarget(_ key: String) -> String { "startCook.target.\(key)" }
    static let startSubmit = "startCook.submit"
    static let startCancel = "startCook.cancel"
    static let startProblem = "startCook.problem"
    static let startOpenActive = "startCook.openActive"
}

/// The app name and version, at the top of the signed-out screens.
struct AppHeader: View {
    let root: RootModel

    var body: some View {
        VStack(spacing: 8) {
            Text(root.title)
                .font(.largeTitle.bold())
                .accessibilityIdentifier(AccessibilityID.title)
            Text(root.versionText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(AccessibilityID.version)
        }
    }
}

#Preview("Not configured") {
    RootView(
        root: RootModel(appVersion: AppVersion(marketingVersion: "0.1.0", buildNumber: "1")),
        session: .notConfigured()
    )
}
