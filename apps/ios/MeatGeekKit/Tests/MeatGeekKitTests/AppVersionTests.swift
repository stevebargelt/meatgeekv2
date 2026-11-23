import Testing
@testable import MeatGeekKit

@Suite("AppVersion")
struct AppVersionTests {
    @Test(
        "displayString",
        arguments: [
            (version: "0.1.0", build: "1", expected: "Version 0.1.0 (1)"),
            (version: " 2.3.4 ", build: "\n57\t", expected: "Version 2.3.4 (57)"),
            (version: "1.0", build: "1.0", expected: "Version 1.0"),
            (version: "1.0", build: nil, expected: "Version 1.0"),
            (version: "1.0", build: "  ", expected: "Version 1.0"),
            (version: nil, build: "12", expected: "Build 12"),
            (version: "", build: "12", expected: "Build 12"),
            (version: nil, build: nil, expected: "Version unknown"),
            (version: " ", build: "", expected: "Version unknown"),
        ] as [(version: String?, build: String?, expected: String)]
    )
    func displayString(version: String?, build: String?, expected: String) {
        let appVersion = AppVersion(marketingVersion: version, buildNumber: build)
        #expect(appVersion.displayString == expected)
    }

    @Test("reads CFBundleShortVersionString and CFBundleVersion")
    func readsInfoDictionary() {
        let info: [String: Any] = [
            "CFBundleShortVersionString": "0.1.0",
            "CFBundleVersion": "7",
            "CFBundleName": "MeatGeek",
        ]
        #expect(
            AppVersion(infoDictionary: info)
                == AppVersion(marketingVersion: "0.1.0", buildNumber: "7")
        )
    }

    @Test("a missing dictionary or non-string values count as unknown")
    func missingOrWrongTypes() {
        #expect(AppVersion(infoDictionary: nil).displayString == "Version unknown")
        let info: [String: Any] = ["CFBundleShortVersionString": 1, "CFBundleVersion": 2]
        #expect(AppVersion(infoDictionary: info).displayString == "Version unknown")
    }
}
