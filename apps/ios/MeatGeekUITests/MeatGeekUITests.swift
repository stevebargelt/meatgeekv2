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
    }

    /// The devices `StubDevices` (MeatGeekKit) serves in UI test mode.
    enum Stub {
        static let connectedID = "sim-device-1"
        static let connectedName = "Backyard Smoker"
        static let neverHeardID = "sim-device-2"
        static let neverHeardName = "Garage Kettle"
        static let claimableID = "sim-device-3"
        static let claimCode = "ABCD-EFGH-JKLM"
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

    /// Signs in on the fakes and waits for the devices list.
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

    @MainActor
    func testNotConfiguredShowsNoSignIn() throws {
        let app = launchInTestMode(["MEATGEEK_UI_TEST_NOT_CONFIGURED": "1"])

        let heading = app.staticTexts[ID.notConfigured]
        waitUntilExists(heading, "the not-configured screen")
        XCTAssertEqual(heading.label, "Sign-in is not configured")
        XCTAssertFalse(app.buttons[ID.signIn].exists)
    }

    /// The built app's Info.plist: MSAL's redirect scheme, the Authenticator
    /// query schemes, and the config from Config/Dev.xcconfig with each `//`
    /// intact (xcconfig would read an unescaped one as a comment).
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
        XCTAssertEqual(info["LSApplicationQueriesSchemes"] as? [String], ["msauthv2", "msauthv3"])

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
