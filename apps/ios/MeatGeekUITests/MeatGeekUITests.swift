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
        static let homeDisplayName = "home.displayName"
        static let signOut = "home.signOut"
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

    /// Signed out → Sign in → the stub user's name from GET /users/me →
    /// Sign out → signed out again.
    @MainActor
    func testSignInShowsProfileNameThenSignOut() throws {
        let app = launchInTestMode()

        let signIn = app.buttons[ID.signIn]
        waitUntilExists(signIn, "the Sign in with Microsoft button")
        XCTAssertEqual(signIn.label, "Sign in with Microsoft")
        signIn.tap()

        let name = app.staticTexts[ID.homeDisplayName]
        waitUntilExists(name, "the signed-in user's name")
        XCTAssertEqual(name.label, Self.stubUserName)

        app.buttons[ID.signOut].tap()

        waitUntilExists(app.buttons[ID.signIn], "the signed-out screen after sign-out")
        XCTAssertFalse(app.staticTexts[ID.homeDisplayName].exists)
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
        // Empty until bootstrap has created the iOS registration (a later issue fills it).
        XCTAssertEqual(info["MeatGeekClientID"] as? String, "")
    }
}
