import XCTest

/// The live iOS proof (HAR-169, goal HAR-157): the real app, in the
/// simulator, against dev. The acceptance user signs in through Microsoft's
/// real pages with a TOTP code, claims the iOS device with the code it
/// reports (unless an earlier run left it claimed), starts a cook on it, sees
/// a reading the device pushed, stops the cook and releases the device. The
/// iOS twin of apps/web-e2e/live/browser-proof.live.ts; see "Live iOS proof"
/// in docs/development/live-acceptance.md.
///
/// It runs only from the `Live` test plan (apps/ios/Live.xctestplan), which
/// the `MeatGeek` scheme does not run by default, through
/// apps/ios/scripts/run-live-proof.sh, which sends the device's readings for
/// the length of the run.
///
/// Nothing secret is written out. The password, the TOTP code and the claim
/// code are pasted, never typed (XCTest logs every typed string), and never
/// printed: a pasted field is read back only to compare it in the test runner. Screenshots are taken only before Microsoft's
/// sign-in sheet is open (a failure to open it) or once sign-in has finished
/// (Microsoft's pages show the UPN), and never of the claim form (it shows the
/// claim code); the test plan keeps no automatic screenshot.
final class LiveProofUITests: XCTestCase {
    /// `AccessibilityID` in MeatGeek/RootView.swift.
    enum ID {
        static let signIn = "signedOut.signIn"
        static let signedOutError = "signedOut.error"
        static let notConfigured = "notConfigured.title"
        static let accountMenu = "account.menu"
        static let signOut = "account.signOut"
        static let devicesTab = "tab.devices"
        static let devicesLoading = "devices.loading"
        static let devicesEmpty = "devices.empty"
        static let devicesError = "devices.error"
        static let claimDevice = "devices.claim"
        static func deviceRow(_ id: String) -> String { "device.row.\(id)" }
        static let claimDeviceID = "claim.deviceID"
        static let claimCode = "claim.claimCode"
        static let claimName = "claim.name"
        static let claimSubmit = "claim.submit"
        static let claimProblem = "claim.problem"
        static let detailStartCook = "deviceDetail.startCook"
        static let detailOpenCook = "deviceDetail.openCook"
        static let detailRelease = "deviceDetail.release"
        static let confirmRelease = "release.confirm"
        static let startName = "startCook.name"
        static let startMeatType = "startCook.meatType"
        static func startTarget(_ key: String) -> String { "startCook.target.\(key)" }
        static let startSubmit = "startCook.submit"
        static let startProblem = "startCook.problem"
        static let cookStatus = "cookDetail.status"
        static let cookStop = "cookDetail.stop"
        static let cookStopProblem = "cookDetail.stopProblem"
        static let confirmStop = "stop.confirm"
        static let liveBadge = "live.badge"
        static func liveChannel(_ channel: String) -> String { "live.channel.\(channel)" }
    }

    static let deviceName = "iOS acceptance smoker"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testLiveProof() throws {
        let steps = LiveSteps()
        let inputs = try steps.run("0. inputs") {
            try LiveInputs.read(ProcessInfo.processInfo.environment).get()
        }
        let app = XCUIApplication()
        let proof = Proof(app: app, inputs: inputs, steps: steps)
        do {
            try proof.run()
        } catch {
            proof.failureScreenshot()
            throw error
        }
    }
}

/// The proof's state across its steps: whether sign-in has finished and
/// whether the claim form is open decide whether a failure screenshot is safe.
@MainActor
final class Proof {
    typealias ID = LiveProofUITests.ID

    let app: XCUIApplication
    let inputs: LiveInputs
    let steps: LiveSteps
    private var signedIn = false
    /// Microsoft's UPN page is up: from here until signed in, a screen can
    /// show what was pasted.
    private var sheetOpen = false
    private var onClaimForm = false

    init(app: XCUIApplication, inputs: LiveInputs, steps: LiveSteps) {
        self.app = app
        self.inputs = inputs
        self.steps = steps
    }

    /// One line of the run's log: notes and METRIC lines, never an input's value.
    func log(_ line: String) { print(line) }

    private var row: XCUIElement { app.buttons[ID.deviceRow(inputs.deviceID)] }
    private var status: XCUIElement { app.staticTexts[ID.cookStatus] }

    func run() throws {
        try steps.run("1. sign in on the real Microsoft pages") { try signIn() }
        let listed = try steps.run("2. the Devices tab lists the acceptance user's devices") { try openDevices() }
        if listed {
            print("SKIP 3. claim the device with its code: \(inputs.deviceID) is already the acceptance user's")
        } else {
            try steps.run("3. claim the device with its code") { try claim() }
        }
        Live.screenshot(app, "1-devices-tab")
        let startedAt = try steps.run("4. start a cook") { try startCook() }
        try steps.run("5. a pushed reading reaches the cook screen") { try pushedReading(since: startedAt) }
        try steps.run("6. stop the cook") {
            try stopCook()
            Live.screenshot(app, "3-cook-ended")
        }
        try steps.run("7. release the device") { try release() }
    }

    /// On failure: a screenshot before Microsoft's sign-in sheet is open
    /// (nothing has been pasted) or once signed in, and never while the claim
    /// form (which can hold the claim code) is open.
    func failureScreenshot() {
        guard signedIn || !sheetOpen else { return }
        if onClaimForm || app.textFields[ID.claimCode].exists {
            log("No failure screenshot: the claim form can show the claim code")
            return
        }
        Live.screenshot(app, "failure")
    }

    // MARK: Steps

    private func signIn() throws {
        app.launch()
        let signInButton = app.buttons[ID.signIn]
        let menu = app.buttons[ID.accountMenu]
        let unavailable = app.staticTexts[ID.signedOutError]
        let atLaunch = try Live.firstOf("launch", bound: LiveBound.app, [
            ("signed out", { signInButton.exists }),
            ("signed in", { menu.exists }),
            ("sign-in unavailable", { unavailable.exists }),
            ("not configured", { self.app.staticTexts[ID.notConfigured].exists }),
        ])
        switch atLaunch {
        case "sign-in unavailable":
            throw LiveFailure("the app cannot sign in: \(unavailable.label)")
        case "not configured":
            throw LiveFailure("the app has no Entra client id (MEATGEEK_CLIENT_ID in apps/ios/Config/Dev.xcconfig)")
        case "signed in":
            // MSAL's cache kept an account from an earlier run on this simulator.
            log("Signed in at launch from an earlier run: signing out first")
            menu.tap()
            let signOut = app.buttons[ID.signOut]
            try Live.waitFor(signOut, "Sign out in the account menu")
            signOut.tap()
            try Live.waitFor(signInButton, "the signed-out screen after Sign out")
        default:
            break
        }
        signInButton.tap()
        let microsoft = MicrosoftSignIn(app: app, inputs: inputs, note: log)
        try microsoft.openSheet()
        sheetOpen = true
        try microsoft.run()
        signedIn = true
    }

    /// Opens the Devices tab and waits for its list. Returns whether the
    /// device is on it already (an earlier run stopped before releasing it).
    func openDevices() throws -> Bool {
        let tab = app.buttons[ID.devicesTab]
        try Live.waitFor(tab, "the Devices tab")
        tab.tap()
        let loading = app.descendants(matching: .any)[ID.devicesLoading]
        let empty = app.staticTexts[ID.devicesEmpty]
        let failed = app.staticTexts[ID.devicesError]
        let anyRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'device.row.'")).firstMatch
        let row = self.row
        let outcome = try Live.firstOf("devices list", bound: LiveBound.app, [
            ("loaded", { !loading.exists && (row.exists || empty.exists || anyRow.exists) }),
            ("error", { failed.exists }),
        ])
        if outcome == "error" {
            throw LiveFailure("GET /devices failed: the Devices tab says \"\(failed.label)\"")
        }
        let listed = row.exists
        switch (listed, inputs.claim) {
        case (true, _):
            log("Device \(inputs.deviceID) is still the acceptance user's from an earlier run: not claiming it again")
        case (false, .alreadyClaimed):
            throw LiveFailure(
                "simdevice claim-code reports \(inputs.deviceID) claimed, but it is not on the acceptance user's "
                    + "Devices tab: another user holds it. Release it as that user."
            )
        case (false, .code):
            log("Device \(inputs.deviceID) is not the acceptance user's: claiming it")
        }
        return listed
    }

    func claim() throws {
        guard case .code(let code) = inputs.claim else {
            throw LiveFailure("no claim code to claim \(inputs.deviceID) with")
        }
        app.buttons[ID.claimDevice].tap()
        onClaimForm = true
        let deviceID = app.textFields[ID.claimDeviceID]
        try Live.waitFor(deviceID, "the claim form")
        deviceID.tap()
        deviceID.typeText(inputs.deviceID)
        try Live.paste(code, into: app.textFields[ID.claimCode], of: app, "the claim code field", shown: .reformatted)
        let name = app.textFields[ID.claimName]
        name.tap()
        name.typeText(LiveProofUITests.deviceName)
        app.buttons[ID.claimSubmit].tap()
        let problem = app.staticTexts[ID.claimProblem]
        let row = self.row
        let outcome = try Live.firstOf("claim", bound: LiveBound.app, [
            ("claimed", { !deviceID.exists && row.exists }),
            ("refused", { problem.exists }),
        ])
        if outcome == "refused" {
            // The app has cleared the code field: the API answered.
            throw LiveFailure("claiming \(inputs.deviceID) was refused: \(problem.label)")
        }
        onClaimForm = false
        log("Claimed device \(inputs.deviceID)")
    }

    /// Starts a cook from the device's screen, stopping one an earlier run
    /// left running first. Returns when Start was tapped.
    func startCook() throws -> Date {
        row.tap()
        let start = app.buttons[ID.detailStartCook]
        let open = app.buttons[ID.detailOpenCook]
        let found = try Live.firstOf("device screen", bound: LiveBound.app, [
            ("Start cook", { start.exists }),
            ("a cook left running", { open.exists }),
        ])
        if found == "a cook left running" {
            log("Stopping a cook an earlier run left running on \(inputs.deviceID)")
            open.tap()
            try Live.waitLabel(status, "Status, Active", "the leftover cook's status")
            try stopCook()
            app.navigationBars.buttons.element(boundBy: 0).tap()
            try Live.waitFor(start, "Start cook on the device screen after stopping the leftover cook")
        }
        start.tap()
        let cookName = "acceptance ios \(inputs.runID)"
        let name = app.textFields[ID.startName]
        try Live.waitFor(name, "the start cook form")
        name.tap()
        name.typeText(cookName)
        let meatType = app.textFields[ID.startMeatType]
        meatType.tap()
        meatType.typeText("Brisket")
        let grill = app.textFields[ID.startTarget("grill")]
        grill.tap()
        grill.typeText("225")
        let startedAt = Date()
        app.buttons[ID.startSubmit].tap()
        let problem = app.staticTexts[ID.startProblem]
        let outcome = try Live.firstOf("start", bound: LiveBound.app, [
            ("the cook screen", { self.status.exists }),
            ("refused", { problem.exists }),
        ])
        if outcome == "refused" {
            throw LiveFailure("starting the cook was refused: \(problem.label)")
        }
        try Live.waitLabel(status, "Status, Active", "the new cook's status")
        log("Started cook \"\(cookName)\" on \(inputs.deviceID)")
        return startedAt
    }

    /// The live panel is live with a grill value, then shows a newer reading
    /// than the first it showed: one that reached the screen while it was
    /// open, which only a push does (the panel reads
    /// `GET /temperatures/current` once, when it connects). simdevice's
    /// synthetic probe 1 climbs 0.5 °F a reading, so every reading reads
    /// differently.
    private func pushedReading(since startedAt: Date) throws {
        let badge = app.staticTexts[ID.liveBadge]
        let grill = app.staticTexts[ID.liveChannel("grill")]
        let probe1 = app.staticTexts[ID.liveChannel("probe1")]
        let deadline = startedAt.addingTimeInterval(LiveBound.push)
        var first: String?
        while true {
            if badge.exists, badge.value as? String == "live", grill.exists, !grill.label.hasSuffix("—") {
                let shown = "\(grill.label); \(probe1.exists ? probe1.label : "Probe 1, —")"
                if first == nil {
                    first = shown
                    log("The cook screen is live, showing \(shown)")
                } else if shown != first {
                    let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
                    log("The cook screen shows a newer reading, \(shown): pushed while it was open")
                    log("METRIC ios-push-ms \(ms)")
                    Live.screenshot(app, "2-cook-pushed-reading")
                    return
                }
            }
            if Date() > deadline {
                let state = badge.exists ? "\(badge.label) (\(badge.value as? String ?? "?"))" : "no live panel"
                let seen = grill.exists ? grill.label : "no grill"
                throw LiveFailure(
                    "the cook screen did not show a pushed reading within \(Int(LiveBound.push)) s of Start "
                        + "(badge \(state), \(seen))"
                        + (first.map { "; it showed \($0) and no newer reading arrived" } ?? "")
                )
            }
            Thread.sleep(forTimeInterval: LiveBound.poll)
        }
    }

    /// Stop cook, confirmed, on the open cook's screen: it shows Completed.
    func stopCook() throws {
        let stop = app.buttons[ID.cookStop]
        var swipes = 0
        while !stop.exists && swipes < 5 {
            app.swipeUp()
            swipes += 1
        }
        try Live.waitFor(stop, "Stop cook on the cook screen")
        stop.tap()
        // iOS lists a confirmation dialog's button twice; either confirms.
        let confirm = app.buttons.matching(identifier: ID.confirmStop).firstMatch
        try Live.waitFor(confirm, "the stop confirmation")
        confirm.tap()
        let problem = app.staticTexts[ID.cookStopProblem]
        let outcome = try Live.firstOf("stop", bound: LiveBound.app, [
            ("completed", { self.status.exists && self.status.label == "Status, Completed" }),
            ("refused", { problem.exists }),
        ])
        if outcome == "refused" {
            throw LiveFailure("stopping the cook failed: \(problem.label)")
        }
        log("Stopped the cook")
    }

    /// Release, from the device's screen, confirmed: back on the list, the
    /// device is gone.
    func release() throws {
        // From the cook's screen back to the device's.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let release = app.buttons[ID.detailRelease]
        try Live.waitFor(release, "Release on the device screen")
        release.tap()
        let confirm = app.buttons.matching(identifier: ID.confirmRelease).firstMatch
        try Live.waitFor(confirm, "the release confirmation")
        confirm.tap()
        try Live.waitFor(app.buttons[ID.claimDevice], "the Devices list after the release")
        try Live.waitGone(row, "\(inputs.deviceID)'s row on the Devices tab")
        log("Released device \(inputs.deviceID)")
    }
}
