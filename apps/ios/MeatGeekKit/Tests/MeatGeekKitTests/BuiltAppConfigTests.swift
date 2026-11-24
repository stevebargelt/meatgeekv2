import Foundation
import Testing
@testable import MeatGeekKit

/// The committed config as the app sees it: the built app's Info.plist (filled
/// from Config/Dev.xcconfig through Config/MeatGeek-Info.plist), read by
/// `AppConfig.parse`, the same call the app makes at launch.
@Suite("Built app config")
struct BuiltAppConfigTests {
    /// The built app's Info.plist. MeatGeek.xctestplan sets
    /// `MEATGEEK_APP_INFOPLIST` to `$(BUILT_PRODUCTS_DIR)/$(INFOPLIST_PATH)` of
    /// the MeatGeek target, a path on the Mac's disk that the simulator can read.
    static func builtInfoDictionary() throws -> [String: Any] {
        let path = try #require(
            ProcessInfo.processInfo.environment["MEATGEEK_APP_INFOPLIST"],
            "MEATGEEK_APP_INFOPLIST is not set: run the tests through the MeatGeek scheme's test plan"
        )
        let data = try Data(contentsOf: URL(filePath: path))
        return try #require(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
            "\(path) is not a dictionary"
        )
    }

    @Test("parses to ready with the dev iOS client id, API, tenant and scope")
    func ready() throws {
        let result = AppConfig.parse(infoDictionary: try Self.builtInfoDictionary())
        #expect(
            result == .ready(AppConfig(
                apiBaseURL: URL(string: "https://meatgeek-v2-dev-func-259d4bf5b628.azurewebsites.net/api")!,
                tenantID: "7466b411-ac2e-49a0-b5d5-b1e866d26bac",
                // meatgeek-v2-dev-ios: DEV_IOS_CLIENT_ID on the `development` environment.
                clientID: "b422c945-cb04-4d97-a816-3f20eb54176b",
                apiScope: "api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user"
            ))
        )
    }
}
