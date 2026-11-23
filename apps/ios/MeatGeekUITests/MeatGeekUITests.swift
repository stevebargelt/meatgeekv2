import XCTest

final class MeatGeekUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// `launch()` returns once the app is idle with its first screen drawn, so
    /// the elements are checked straight away, with no wait or timeout.
    @MainActor
    func testLaunchShowsTitleAndVersion() throws {
        let app = XCUIApplication()
        app.launch()

        let title = app.staticTexts["root.title"]
        XCTAssertTrue(title.exists, "the root title is not on screen")
        XCTAssertEqual(title.label, "MeatGeek")

        let version = app.staticTexts["root.version"]
        XCTAssertTrue(version.exists, "the version line is not on screen")
        XCTAssertTrue(
            version.label.hasPrefix("Version "),
            "unexpected version line: \(version.label)"
        )
    }
}
