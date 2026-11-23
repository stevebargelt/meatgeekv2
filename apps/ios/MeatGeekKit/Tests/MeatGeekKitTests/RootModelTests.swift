import Testing
@testable import MeatGeekKit

@Suite("RootModel")
@MainActor
struct RootModelTests {
    @Test("shows the app name and its version")
    func titleAndVersion() {
        let model = RootModel(appVersion: AppVersion(marketingVersion: "0.1.0", buildNumber: "1"))
        #expect(model.title == "MeatGeek")
        #expect(model.versionText == "Version 0.1.0 (1)")
    }
}
