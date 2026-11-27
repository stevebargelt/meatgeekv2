import XCTest

/// The app in UI test mode (`MEATGEEK_UI_TEST=1`): `FakeTokenProvider` and the
/// in-process `StubAPI` stand in for MSAL and the network, so nothing here
/// reaches Entra.
final class MeatGeekUITests: XCTestCase {
    /// Element ids, from AccessibilityID in MeatGeek/RootView.swift.
    enum ID {
        static let title = "root.title"
        static let version = "root.version"
        static let notConfigured = "notConfigured.title"
        static let signIn = "signedOut.signIn"
        static let accountMenu = "account.menu"
        static let accountName = "account.displayName"
        static let signOut = "account.signOut"
        static let claimDevice = "devices.claim"
        static func deviceRow(_ id: String) -> String { "device.row.\(id)" }
        static func deviceName(_ id: String) -> String { "device.name.\(id)" }
        static func deviceConnection(_ id: String) -> String { "device.connection.\(id)" }
        static func deviceRelease(_ id: String) -> String { "device.release.\(id)" }
        static let detailRename = "deviceDetail.rename"
        static let confirmRelease = "release.confirm"
        static let claimDeviceID = "claim.deviceID"
        static let claimCode = "claim.claimCode"
        static let claimName = "claim.name"
        static let claimLocation = "claim.location"
        static let claimSubmit = "claim.submit"
        static let renameName = "rename.name"
        static let renameSave = "rename.save"
        static let detailStartCook = "deviceDetail.startCook"
        static func deviceCooking(_ id: String) -> String { "device.cooking.\(id)" }
        static func cookName(_ id: String) -> String { "cook.name.\(id)" }
        static let cooksLoadMore = "cooks.loadMore"
        static let cookDetailStatus = "cookDetail.status"
        static let cookDetailEnded = "cookDetail.ended"
        static let cookDetailStop = "cookDetail.stop"
        static let cookDetailEditTargets = "cookDetail.editTargets"
        static let cookDetailAlertsOff = "cookDetail.alertsOff"
        static let cookDetailOpenSettings = "cookDetail.openSettings"
        static func editTarget(_ key: String) -> String { "editTargets.target.\(key)" }
        static let editTargetsSave = "editTargets.save"
        static let chart = "chart.chart"
        static let chartNotAvailable = "chart.notAvailable"
        static let chartError = "chart.error"
        static let chartRetry = "chart.retry"
        static let liveBadge = "live.badge"
        static func liveChannel(_ channel: String) -> String { "live.channel.\(channel)" }
        static func liveTarget(_ channel: String) -> String { "live.target.\(channel)" }
        static func liveReached(_ channel: String) -> String { "live.reached.\(channel)" }
        static let liveTestMenu = "live.test.menu"
        static let liveTestDrop = "live.test.drop"
        static let liveTestReconnect = "live.test.reconnect"
        static let liveTestAdvanceClock = "live.test.advanceClock"
        static let liveTestCookStopped = "live.test.cookStopped"
        static let confirmStop = "stop.confirm"
        static let startName = "startCook.name"
        static let startMeatType = "startCook.meatType"
        static func startTarget(_ key: String) -> String { "startCook.target.\(key)" }
        static let startSubmit = "startCook.submit"
    }

    /// The devices `StubDevices` (MeatGeekKit) serves in UI test mode.
    enum Stub {
        static let connectedID = "sim-device-1"
        static let connectedName = "Backyard Smoker"
        static let neverHeardID = "sim-device-2"
        static let neverHeardName = "Garage Kettle"
        static let claimableID = "sim-device-3"
        static let claimCode = "ABCD-EFGH-JKLM"
        /// `StubCooks`: the newest of its seeded completed cooks.
        static let newestSeededCookID = "seeded-cook-1"
        static let newestSeededCookName = "Seeded cook 1"
        /// `StubCooks.noChartCookID`: its chart is 404.
        static let noChartCookID = "seeded-cook-2"
        /// `StubCooks.failsOnceCookID`: its first chart request is 500.
        static let failsOnceCookID = "seeded-cook-3"
    }

    /// `StubAPI.uiTestUserName`: the name `GET /users/me` returns in UI test mode.
    static let stubUserName = "Pat Pitmaster"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func launchInTestMode(_ extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["MEATGEEK_UI_TEST": "1"].merging(extra) { $1 }
        app.launch()
        return app
    }

    /// Waits for `element` to exist, with no deadline of its own: the hang
    /// guard is the test plan's execution time allowance (MeatGeek.xctestplan),
    /// as the repository's deterministic test rule asks
    /// (docs/development/deterministic-tests.md). The wait ends as soon as the
    /// element appears.
    @MainActor
    func waitUntilExists(_ element: XCUIElement, _ what: String) {
        XCTAssertTrue(element.waitForExistence(timeout: 24 * 60 * 60), "\(what) never appeared")
    }

    /// Waits for `element` to be gone, bounded like `waitUntilExists`.
    @MainActor
    func waitUntilGone(_ element: XCUIElement, _ what: String) {
        XCTAssertTrue(element.waitForNonExistence(timeout: 24 * 60 * 60), "\(what) never went away")
    }

    /// Waits for `element`'s value to be `value`, bounded like `waitUntilExists`.
    @MainActor
    func waitUntilValue(_ element: XCUIElement, _ value: String, _ what: String) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", value), object: element
        )
        let result = XCTWaiter().wait(for: [expectation], timeout: 24 * 60 * 60)
        XCTAssertEqual(result, .completed, "\(what) never became \(value): \(element.value ?? "nil")")
    }

    /// Waits for `element`'s label to be `label`, bounded like `waitUntilExists`.
    @MainActor
    func waitUntilLabel(_ element: XCUIElement, _ label: String, _ what: String) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", label), object: element
        )
        let result = XCTWaiter().wait(for: [expectation], timeout: 24 * 60 * 60)
        XCTAssertEqual(result, .completed, "\(what) never became \(label): \(element.label)")
    }

    /// Keeps a screenshot of the app in the test's result bundle, under `name`.
    @MainActor
    func screenshot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Taps one of the cook screen's UI test hooks (MeatGeek/LivePanelView.swift,
    /// `LiveTestMenu`), in the navigation bar's "UI test" menu.
    @MainActor
    func liveTestHook(_ app: XCUIApplication, _ id: String) {
        let menu = app.buttons[ID.liveTestMenu]
        waitUntilExists(menu, "the UI test menu")
        menu.tap()
        let hook = app.buttons[id]
        waitUntilExists(hook, "the \(id) hook")
        hook.tap()
    }

    /// Scrolls the screen up until `element` exists: a list builds its rows as
    /// they scroll into view. No deadline of its own, like `waitUntilExists`.
    @MainActor
    func scrollUntilExists(_ app: XCUIApplication, _ element: XCUIElement, _ what: String) {
        while !element.exists {
            app.swipeUp()
        }
        XCTAssertTrue(element.exists, "\(what) never appeared")
    }

    /// Waits for the chart's accessibility value (`ChartSeries.summary`:
    /// channels, point count, latest values) to match `predicate`, bounded
    /// like `waitUntilExists`.
    @MainActor
    func waitUntilChart(_ app: XCUIApplication, _ predicate: String, _ what: String) {
        let chart = app.descendants(matching: .any)[ID.chart]
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: chart)
        let result = XCTWaiter().wait(for: [expectation], timeout: 24 * 60 * 60)
        XCTAssertEqual(result, .completed, "\(what): the chart never matched \(predicate): \(chart.exists ? String(describing: chart.value) : "no chart")")
    }

    /// Scrolls the screen down (back towards the top) until `element`
    /// exists. No deadline of its own, like `waitUntilExists`.
    @MainActor
    func scrollDownUntilExists(_ app: XCUIApplication, _ element: XCUIElement, _ what: String) {
        while !element.exists {
            app.swipeDown()
        }
        XCTAssertTrue(element.exists, "\(what) never appeared")
    }

    /// Opens a tab by its title.
    @MainActor
    func openTab(_ app: XCUIApplication, _ title: String) {
        let tab = app.tabBars.buttons[title]
        waitUntilExists(tab, "the \(title) tab")
        tab.tap()
    }

    /// Signs in on the fakes and waits for the signed-in tabs.
    @MainActor
    func signIn(_ app: XCUIApplication) {
        let signIn = app.buttons[ID.signIn]
        waitUntilExists(signIn, "the Sign in with Microsoft button")
        signIn.tap()
        waitUntilExists(app.buttons[ID.accountMenu], "the account menu on the signed-in screen")
    }

    @MainActor
    func testLaunchShowsTitleAndVersion() throws {
        let app = launchInTestMode()

        let title = app.staticTexts[ID.title]
        waitUntilExists(title, "the root title")
        XCTAssertEqual(title.label, "MeatGeek")

        let version = app.staticTexts[ID.version]
        XCTAssertTrue(version.exists, "the version line is not on screen")
        XCTAssertTrue(
            version.label.hasPrefix("Version "),
            "unexpected version line: \(version.label)"
        )
    }

    /// Signed out → Sign in → the account menu has the stub user's name from
    /// GET /users/me → Sign out → signed out again.
    @MainActor
    func testSignInShowsProfileNameThenSignOut() throws {
        let app = launchInTestMode()

        let signIn = app.buttons[ID.signIn]
        waitUntilExists(signIn, "the Sign in with Microsoft button")
        XCTAssertEqual(signIn.label, "Sign in with Microsoft")
        signIn.tap()

        let menu = app.buttons[ID.accountMenu]
        waitUntilExists(menu, "the account menu")
        menu.tap()
        let name = app.descendants(matching: .any)[ID.accountName]
        waitUntilExists(name, "the signed-in user's name in the account menu")
        XCTAssertEqual(name.label, Self.stubUserName)

        app.buttons[ID.signOut].tap()

        waitUntilExists(app.buttons[ID.signIn], "the signed-out screen after sign-out")
        XCTAssertFalse(app.buttons[ID.accountMenu].exists)
    }

    /// Devices: the two seeded devices with their connection → claim
    /// sim-device-3 → it is listed → rename it on its detail screen → release
    /// it from the list with confirmation → it is gone.
    @MainActor
    func testDevicesClaimRenameRelease() throws {
        let app = launchInTestMode()
        signIn(app)
        openTab(app, "Devices")

        // The list, with "last heard" aged on UI test mode's fixed clock.
        let connected = app.staticTexts[ID.deviceConnection(Stub.connectedID)]
        waitUntilExists(connected, "the connected device's status")
        XCTAssertEqual(connected.label, "Connected · last heard 12 s ago")
        XCTAssertEqual(app.staticTexts[ID.deviceName(Stub.connectedID)].label, Stub.connectedName)
        XCTAssertEqual(
            app.staticTexts[ID.deviceConnection(Stub.neverHeardID)].label, "Offline · never heard from"
        )
        XCTAssertEqual(app.staticTexts[ID.deviceName(Stub.neverHeardID)].label, Stub.neverHeardName)
        XCTAssertFalse(app.staticTexts[ID.deviceName(Stub.claimableID)].exists)

        // Claim: the code is typed lower case with spaces and shows formatted.
        app.buttons[ID.claimDevice].tap()
        let deviceID = app.textFields[ID.claimDeviceID]
        waitUntilExists(deviceID, "the claim form")
        deviceID.tap()
        deviceID.typeText(Stub.claimableID)
        let code = app.textFields[ID.claimCode]
        code.tap()
        code.typeText("abcd efgh jklm")
        waitUntilValue(code, Stub.claimCode, "the formatted claim code")
        let claimName = app.textFields[ID.claimName]
        claimName.tap()
        claimName.typeText("Brisket Box")
        let location = app.textFields[ID.claimLocation]
        location.tap()
        location.typeText("Shed")
        app.buttons[ID.claimSubmit].tap()

        let claimed = app.staticTexts[ID.deviceName(Stub.claimableID)]
        waitUntilExists(claimed, "the claimed device in the list")
        XCTAssertEqual(claimed.label, "Brisket Box")
        XCTAssertEqual(
            app.staticTexts[ID.deviceConnection(Stub.claimableID)].label, "Connected · last heard 3 s ago"
        )

        // Rename, from the device's detail screen.
        app.buttons[ID.deviceRow(Stub.claimableID)].tap()
        let rename = app.buttons[ID.detailRename]
        waitUntilExists(rename, "the device detail screen")
        rename.tap()
        let newName = app.textFields[ID.renameName]
        waitUntilExists(newName, "the rename form")
        newName.tap()
        let current = newName.value as? String ?? ""
        newName.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        newName.typeText("Pork Shed")
        app.buttons[ID.renameSave].tap()
        waitUntilGone(newName, "the rename form")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        let renamed = app.staticTexts[ID.deviceName(Stub.claimableID)]
        waitUntilExists(renamed, "the renamed device in the list")
        XCTAssertEqual(renamed.label, "Pork Shed")

        // Release, from the row's swipe action, with confirmation.
        app.buttons[ID.deviceRow(Stub.claimableID)].swipeLeft()
        let release = app.buttons[ID.deviceRelease(Stub.claimableID)]
        waitUntilExists(release, "the row's Release action")
        release.tap()
        // iOS lists a confirmation dialog's button twice in the accessibility
        // tree; either one confirms.
        let confirm = app.buttons.matching(identifier: ID.confirmRelease).firstMatch
        waitUntilExists(confirm, "the release confirmation")
        XCTAssertEqual(confirm.label, "Yes, release")
        confirm.tap()

        // The list is back (the dialog has gone) and the released row is not on it.
        waitUntilExists(app.buttons[ID.deviceRow(Stub.connectedID)], "the list after the release")
        waitUntilGone(app.buttons[ID.deviceRow(Stub.claimableID)], "the released device's row")
        XCTAssertTrue(app.buttons[ID.deviceRow(Stub.neverHeardID)].exists)
    }

    /// Cooks, the main path: the Cooks tab lists the seeded history → Devices
    /// → Start cook on a device with a name and a probe target → its detail
    /// shows it active, a pushed reading in the live panel and a point for it
    /// on the chart → the device row says it is cooking → the Cooks tab lists
    /// it on top → an ended seeded cook's chart shows its bucketed series →
    /// open the new cook → Stop, confirmed → it is completed and its chart is
    /// read again.
    @MainActor
    func testStartCookListOpenStop() throws {
        let app = launchInTestMode()
        signIn(app)

        // Cooks is the first tab: the seeded history, one page and "Load more".
        let seeded = app.staticTexts[ID.cookName(Stub.newestSeededCookID)]
        waitUntilExists(seeded, "the seeded cooks on the Cooks tab")
        XCTAssertEqual(seeded.label, Stub.newestSeededCookName)

        // Start a cook from the device's detail screen.
        openTab(app, "Devices")
        let row = app.buttons[ID.deviceRow(Stub.connectedID)]
        waitUntilExists(row, "the connected device's row")
        row.tap()
        let start = app.buttons[ID.detailStartCook]
        waitUntilExists(start, "Start cook on the device detail screen")
        start.tap()

        let name = app.textFields[ID.startName]
        waitUntilExists(name, "the start cook form")
        name.tap()
        name.typeText("UI Test Brisket")
        let meatType = app.textFields[ID.startMeatType]
        meatType.tap()
        meatType.typeText("beef")
        let probe1 = app.textFields[ID.startTarget("probe1")]
        probe1.tap()
        probe1.typeText("203")
        screenshot(app, "2-start-cook-form")
        app.buttons[ID.startSubmit].tap()

        // The new cook's detail, active, with its target.
        let status = app.staticTexts[ID.cookDetailStatus]
        waitUntilExists(status, "the new cook's detail screen")
        // LabeledContent reads as one element: "<label>, <value>".
        XCTAssertEqual(status.label, "Status, Active")

        // Live readings, pushed by the stub hub once the panel connects:
        // grill and probe 1, and "—" for the probes the device did not send.
        let badge = app.staticTexts[ID.liveBadge]
        let grill = app.staticTexts[ID.liveChannel("grill")]
        waitUntilLabel(grill, "Grill, 225 °F", "the pushed grill reading")
        XCTAssertEqual(app.staticTexts[ID.liveChannel("probe1")].label, "Probe 1, 150 °F")
        XCTAssertEqual(app.staticTexts[ID.liveChannel("probe2")].label, "Probe 2, —")
        XCTAssertEqual(app.staticTexts[ID.liveChannel("probe4")].label, "Probe 4, —")
        // The probe 1 target set on the form, beside its reading; no other
        // channel has one, and nothing has reached its target.
        let probe1Target = app.staticTexts[ID.liveTarget("probe1")]
        waitUntilExists(probe1Target, "probe 1's target on the live screen")
        XCTAssertEqual(probe1Target.label, "Probe 1, Target 203 °F")
        XCTAssertFalse(app.staticTexts[ID.liveTarget("grill")].exists)
        XCTAssertFalse(app.staticTexts[ID.liveReached("probe1")].exists)
        waitUntilLabel(badge, "Live", "the live badge")
        screenshot(app, "4-live-panel-live")

        // Below the live panel, the chart: the stub's chart of an active cook
        // is empty, so what it draws is the pushed reading, one point.
        let chart = app.descendants(matching: .any)[ID.chart]
        waitUntilExists(chart, "the chart")
        XCTAssertEqual(chart.label, "Temperature chart")
        waitUntilChart(
            app, "value == 'Grill, Probe 1; 1 point; latest Grill 225 °F, Probe 1 150 °F'", "the pushed point"
        )

        // The connection drops and automatic reconnect gives up: the panel
        // says so and keeps the last reading until it negotiates again.
        liveTestHook(app, ID.liveTestDrop)
        waitUntilLabel(badge, "Reconnecting…", "the reconnecting badge")
        XCTAssertEqual(grill.label, "Grill, 225 °F")
        screenshot(app, "5-live-panel-reconnecting")
        liveTestHook(app, ID.liveTestReconnect)
        waitUntilLabel(grill, "Grill, 226 °F", "a reading on the new connection")
        waitUntilLabel(badge, "Live", "the live badge after recovering")
        waitUntilChart(
            app, "value == 'Grill, Probe 1; 2 points; latest Grill 226 °F, Probe 1 151 °F'", "the second pushed point"
        )
        screenshot(app, "7-chart-active-cook")

        // Three minutes with no reading: stale, saying for how long.
        liveTestHook(app, ID.liveTestAdvanceClock)
        let stale = app.staticTexts.matching(
            NSPredicate(format: "identifier == %@ AND label BEGINSWITH 'No reading for '", ID.liveBadge)
        ).firstMatch
        waitUntilExists(stale, "the stale badge")
        screenshot(app, "6-live-panel-stale")

        // Below the live panel and the chart: the cook's fields.
        let target = app.staticTexts["Probe 1 target, 203 °F"]
        scrollUntilExists(app, target, "the probe 1 target")
        screenshot(app, "3-active-cook-detail")

        // Back on the device list, the device is cooking it.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let cooking = app.buttons[ID.deviceCooking(Stub.connectedID)]
        waitUntilExists(cooking, "Cooking: on the device row")
        XCTAssertEqual(cooking.label, "Cooking: UI Test Brisket")
        // It opens the cook, not the device.
        cooking.tap()
        let fromRow = app.staticTexts[ID.cookDetailStatus]
        waitUntilExists(fromRow, "the cook's detail screen from the device row")
        XCTAssertEqual(fromRow.label, "Status, Active")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        waitUntilExists(app.buttons[ID.deviceCooking(Stub.connectedID)], "the device list again")

        // The Cooks tab lists it first; open it there.
        openTab(app, "Cooks")
        let listed = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH 'cook.row.' AND label CONTAINS 'UI Test Brisket'")
        ).firstMatch
        waitUntilExists(listed, "the new cook on the Cooks tab")
        screenshot(app, "1-cooks-list")

        // An ended seeded cook: its chart is the stored series, 6 h of
        // one-minute buckets with probe 2 unplugged for two stretches.
        app.staticTexts[ID.cookName(Stub.newestSeededCookID)].tap()
        waitUntilChart(
            app, "value BEGINSWITH 'Grill, Probe 1, Probe 2; 360 points; latest Grill '", "the seeded cook's buckets"
        )
        // Touch and hold it where probe 2 has a gap (2:00 to 2:45 of 6 h): a
        // rule and each channel's value there, which stay after the finger lifts.
        app.descendants(matching: .any)[ID.chart]
            .coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.5)).press(forDuration: 1)
        screenshot(app, "8-chart-ended-cook-selection")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        waitUntilExists(listed, "the Cooks tab again")
        listed.tap()

        let openedStatus = app.staticTexts[ID.cookDetailStatus]
        waitUntilExists(openedStatus, "the cook's detail screen from the list")
        XCTAssertEqual(openedStatus.label, "Status, Active")
        // This screen's own push (the fourth hub start, 228 °F), one point.
        waitUntilChart(
            app, "value == 'Grill, Probe 1; 1 point; latest Grill 228 °F, Probe 1 153 °F'", "this screen's pushed point"
        )

        // Change probe 1's target on the running cook: the live screen shows
        // the new one once the sheet closes, with no refresh.
        scrollUntilExists(app, app.buttons[ID.cookDetailEditTargets], "Edit targets")
        app.buttons[ID.cookDetailEditTargets].tap()
        let editProbe1 = app.textFields[ID.editTarget("probe1")]
        waitUntilExists(editProbe1, "the edit targets form")
        XCTAssertEqual(editProbe1.value as? String, "203")
        // The cursor at the end of "203", then the new value over it.
        editProbe1.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        editProbe1.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3) + "165")
        screenshot(app, "10-edit-targets")
        app.buttons[ID.editTargetsSave].tap()
        let changedTarget = app.staticTexts[ID.liveTarget("probe1")]
        scrollDownUntilExists(app, changedTarget, "probe 1's target on the live screen")
        waitUntilLabel(changedTarget, "Probe 1, Target 165 °F", "the changed target on the live screen")

        // Stop, with confirmation: below the chart and the fields.
        scrollUntilExists(app, app.buttons[ID.cookDetailStop], "Stop cook")
        app.buttons[ID.cookDetailStop].tap()
        // iOS lists a confirmation dialog's button twice in the accessibility
        // tree; either one confirms.
        let confirm = app.buttons.matching(identifier: ID.confirmStop).firstMatch
        waitUntilExists(confirm, "the stop confirmation")
        XCTAssertEqual(confirm.label, "Yes, stop cook")
        confirm.tap()

        waitUntilLabel(app.staticTexts[ID.cookDetailStatus], "Status, Completed", "the cook's status")
        XCTAssertTrue(app.staticTexts[ID.cookDetailEnded].exists, "the end time is not shown")
        XCTAssertFalse(app.buttons[ID.cookDetailStop].exists, "Stop is still offered")
        XCTAssertFalse(app.buttons[ID.cookDetailEditTargets].exists, "Edit targets is offered on an ended cook")

        // Completed: the chart is read again, and is now the stored series:
        // the stub buckets the four pushes by minute (225 and 226 at 18:00,
        // 227 and 228 after the clock moved 3 min). The pushed point falls
        // inside the last bucket, so it is not drawn twice.
        let stoppedChart = app.descendants(matching: .any)[ID.chart]
        scrollDownUntilExists(app, stoppedChart, "the chart")
        // All of it, below the navigation bar, for the screenshot.
        while stoppedChart.frame.minY < app.navigationBars.firstMatch.frame.maxY {
            app.swipeDown()
        }
        waitUntilChart(
            app, "value == 'Grill, Probe 1; 2 points; latest Grill 227.5 °F, Probe 1 152.5 °F'", "the reloaded chart"
        )
        screenshot(app, "9-chart-after-stop")
    }

    /// The chart's other states on the stub: a cook with no chart says so; a
    /// failed read shows the problem, and Retry reads it again.
    @MainActor
    func testChartNotAvailableAndRetry() throws {
        let app = launchInTestMode()
        signIn(app)

        let noChart = app.staticTexts[ID.cookName(Stub.noChartCookID)]
        waitUntilExists(noChart, "the seeded cook with no chart")
        noChart.tap()
        let notAvailable = app.staticTexts[ID.chartNotAvailable]
        waitUntilExists(notAvailable, "Chart not available")
        XCTAssertEqual(notAvailable.label, "Chart not available")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        let failsOnce = app.staticTexts[ID.cookName(Stub.failsOnceCookID)]
        waitUntilExists(failsOnce, "the seeded cook whose chart fails once")
        failsOnce.tap()
        let problem = app.staticTexts[ID.chartError]
        waitUntilExists(problem, "the chart's problem")
        XCTAssertTrue(problem.label.contains("Internal server error"), "unexpected problem: \(problem.label)")
        screenshot(app, "chart-error")
        app.buttons[ID.chartRetry].tap()
        waitUntilChart(app, "value BEGINSWITH 'Grill, Probe 1, Probe 2; 360 points;'", "the chart after Retry")
        XCTAssertFalse(app.staticTexts[ID.chartError].exists, "the problem is still shown")
    }

    /// Another client stops the cook while its screen is open: `cook_stopped`
    /// ends it here, and the live panel goes.
    @MainActor
    func testCookStoppedEndsTheLiveCook() throws {
        let app = launchInTestMode()
        signIn(app)
        openTab(app, "Devices")
        let row = app.buttons[ID.deviceRow(Stub.connectedID)]
        waitUntilExists(row, "the connected device's row")
        row.tap()
        let start = app.buttons[ID.detailStartCook]
        waitUntilExists(start, "Start cook on the device detail screen")
        start.tap()
        let name = app.textFields[ID.startName]
        waitUntilExists(name, "the start cook form")
        name.tap()
        name.typeText("Stopped Elsewhere")
        let meatType = app.textFields[ID.startMeatType]
        meatType.tap()
        meatType.typeText("pork")
        app.buttons[ID.startSubmit].tap()

        waitUntilLabel(app.staticTexts[ID.liveChannel("grill")], "Grill, 225 °F", "the pushed grill reading")
        liveTestHook(app, ID.liveTestCookStopped)

        waitUntilLabel(app.staticTexts[ID.cookDetailStatus], "Status, Completed", "the cook's status")
        XCTAssertTrue(app.staticTexts[ID.cookDetailEnded].exists, "the end time is not shown")
        XCTAssertFalse(app.staticTexts[ID.liveBadge].exists, "the live panel is still shown")
        XCTAssertFalse(app.buttons[ID.cookDetailStop].exists, "Stop is still offered")
    }

    /// Notification permission declined (`StubNotifications`,
    /// MEATGEEK_UI_TEST_NOTIFICATIONS=denied): a running cook's screen says
    /// alerts are off and links to Settings.
    @MainActor
    func testDeclinedAlertsSayOffOnTheCookScreen() throws {
        let app = launchInTestMode(["MEATGEEK_UI_TEST_NOTIFICATIONS": "denied"])
        signIn(app)
        openTab(app, "Devices")
        let row = app.buttons[ID.deviceRow(Stub.connectedID)]
        waitUntilExists(row, "the connected device's row")
        row.tap()
        let start = app.buttons[ID.detailStartCook]
        waitUntilExists(start, "Start cook on the device detail screen")
        start.tap()
        let name = app.textFields[ID.startName]
        waitUntilExists(name, "the start cook form")
        name.tap()
        name.typeText("No Alerts")
        let meatType = app.textFields[ID.startMeatType]
        meatType.tap()
        meatType.typeText("pork")
        app.buttons[ID.startSubmit].tap()

        let off = app.staticTexts[ID.cookDetailAlertsOff]
        scrollUntilExists(app, off, "the alerts-off notice")
        XCTAssertTrue(off.label.hasPrefix("Alerts are off."), off.label)
        XCTAssertTrue(app.buttons[ID.cookDetailOpenSettings].exists, "no link to Settings")
        screenshot(app, "alerts-off")
    }

    /// A tapped alert that launched the app (`StubNotifications`,
    /// MEATGEEK_UI_TEST_TAPPED_ALERT) opens its cook once signed in.
    @MainActor
    func testTappedAlertOpensItsCook() throws {
        let app = launchInTestMode(["MEATGEEK_UI_TEST_TAPPED_ALERT": "seeded-cook-1"])
        // Not `signIn(app)`: the cook's screen opens at once, over the list
        // whose navigation bar has the account menu.
        let signIn = app.buttons[ID.signIn]
        waitUntilExists(signIn, "the Sign in with Microsoft button")
        signIn.tap()
        let status = app.staticTexts[ID.cookDetailStatus]
        waitUntilExists(status, "the tapped alert's cook")
        XCTAssertEqual(status.label, "Status, Completed")
        XCTAssertTrue(app.navigationBars[Stub.newestSeededCookName].exists, "not the tapped alert's cook")
    }

    @MainActor
    func testNotConfiguredShowsNoSignIn() throws {
        let app = launchInTestMode(["MEATGEEK_UI_TEST_NOT_CONFIGURED": "1"])

        let heading = app.staticTexts[ID.notConfigured]
        waitUntilExists(heading, "the not-configured screen")
        XCTAssertEqual(heading.label, "Sign-in is not configured")
        XCTAssertFalse(app.buttons[ID.signIn].exists)
    }

    /// The built app's Info.plist: MSAL's redirect scheme, no Authenticator
    /// query schemes (the broker is off, HAR-171), and the config from
    /// Config/Dev.xcconfig with each `//` intact (xcconfig would read an
    /// unescaped one as a comment).
    func testBuiltInfoPlistHasSchemesAndConfig() throws {
        // Set by MeatGeek.xctestplan from the MeatGeek target's build settings:
        // $(BUILT_PRODUCTS_DIR)/$(INFOPLIST_PATH), the Info.plist in the build
        // products (on the Mac's disk, which the simulator can read).
        let path = try XCTUnwrap(
            ProcessInfo.processInfo.environment["MEATGEEK_APP_INFOPLIST"],
            "MEATGEEK_APP_INFOPLIST is not set: run through the MeatGeek scheme's test plan"
        )
        let plistURL = URL(filePath: path)
        let data = try Data(contentsOf: plistURL)
        let info = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
            "\(plistURL.path) is not a dictionary"
        )

        let urlTypes = try XCTUnwrap(info["CFBundleURLTypes"] as? [[String: Any]])
        let schemes = urlTypes.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertEqual(schemes, ["msauth.com.meatgeek.ios"])
        XCTAssertNil(info["LSApplicationQueriesSchemes"], "MSAL needs msauthv2/msauthv3 only for the broker")

        let baseURL = try XCTUnwrap(info["MeatGeekAPIBaseURL"] as? String)
        XCTAssertEqual(baseURL, "https://meatgeek-v2-dev-func-259d4bf5b628.azurewebsites.net/api")
        XCTAssertEqual(URL(string: baseURL)?.host(), "meatgeek-v2-dev-func-259d4bf5b628.azurewebsites.net")
        XCTAssertEqual(
            info["MeatGeekAPIScope"] as? String,
            "api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user"
        )
        XCTAssertEqual(info["MeatGeekTenantID"] as? String, "7466b411-ac2e-49a0-b5d5-b1e866d26bac")
        // The client id, and that the whole config parses to ready, are checked
        // by BuiltAppConfigTests in MeatGeekKitTests through AppConfig.parse.
    }
}
