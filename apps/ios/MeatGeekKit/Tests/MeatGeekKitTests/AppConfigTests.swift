import Foundation
import Testing
@testable import MeatGeekKit

@Suite("AppConfig")
struct AppConfigTests {
    /// The values Config/Dev.xcconfig puts in the built Info.plist (see the
    /// UI test that reads the built app's Info.plist), with a client id.
    static var valid: [String: Any] { [
        "MeatGeekAPIBaseURL": "https://meatgeek-v2-dev-func-259d4bf5b628.azurewebsites.net/api",
        "MeatGeekTenantID": "7466b411-ac2e-49a0-b5d5-b1e866d26bac",
        "MeatGeekClientID": "11111111-2222-3333-4444-555555555555",
        "MeatGeekAPIScope": "api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user",
    ] }

    static func info(_ changes: [String: Any?]) -> [String: Any] {
        var info = valid
        for (key, value) in changes {
            info[key] = value
        }
        return info
    }

    @Test("a complete config is ready")
    func valid() throws {
        let result = AppConfig.parse(infoDictionary: Self.valid)
        guard case .ready(let config) = result else {
            Issue.record("expected .ready, got \(result)")
            return
        }
        #expect(config.apiBaseURL == URL(string: "https://meatgeek-v2-dev-func-259d4bf5b628.azurewebsites.net/api"))
        #expect(config.apiBaseURL.host() == "meatgeek-v2-dev-func-259d4bf5b628.azurewebsites.net")
        #expect(config.apiBaseURL.path() == "/api")
        #expect(config.tenantID == "7466b411-ac2e-49a0-b5d5-b1e866d26bac")
        #expect(config.clientID == "11111111-2222-3333-4444-555555555555")
        #expect(config.apiScope == "api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user")
        #expect(
            config.authorityURL.absoluteString
                == "https://login.microsoftonline.com/7466b411-ac2e-49a0-b5d5-b1e866d26bac"
        )
    }

    @Test("values are trimmed and the base URL loses trailing slashes")
    func trimmed() {
        let result = AppConfig.parse(infoDictionary: Self.info([
            "MeatGeekAPIBaseURL": "  https://api.example.test/api//  ",
            "MeatGeekTenantID": " tenant ",
            "MeatGeekClientID": " client ",
            "MeatGeekAPIScope": " scope ",
        ]))
        #expect(
            result == .ready(AppConfig(
                apiBaseURL: URL(string: "https://api.example.test/api")!,
                tenantID: "tenant",
                clientID: "client",
                apiScope: "scope"
            ))
        )
    }

    @Test("an empty client id is not configured", arguments: ["", "   "])
    func emptyClientID(clientID: String) {
        let result = AppConfig.parse(infoDictionary: Self.info(["MeatGeekClientID": clientID]))
        guard case .notConfigured(let config) = result else {
            Issue.record("expected .notConfigured, got \(result)")
            return
        }
        #expect(config.clientID == "")
        #expect(config.tenantID == "7466b411-ac2e-49a0-b5d5-b1e866d26bac")
    }

    @Test("every missing key is listed")
    func missingKeys() {
        #expect(
            AppConfig.parse(infoDictionary: [:]) == .invalid([
                "MEATGEEK_API_BASE_URL (Info.plist MeatGeekAPIBaseURL) is missing or empty.",
                "MEATGEEK_TENANT_ID (Info.plist MeatGeekTenantID) is missing or empty.",
                "MEATGEEK_CLIENT_ID (Info.plist MeatGeekClientID) is missing or not a string.",
                "MEATGEEK_API_SCOPE (Info.plist MeatGeekAPIScope) is missing or empty.",
            ])
        )
        #expect(AppConfig.parse(infoDictionary: nil) == AppConfig.parse(infoDictionary: [:]))
    }

    @Test("empty and non-string values are problems")
    func emptyAndWrongTypes() {
        let result = AppConfig.parse(infoDictionary: Self.info([
            "MeatGeekTenantID": "",
            "MeatGeekClientID": 42,
            "MeatGeekAPIScope": ["not", "a", "string"],
        ]))
        #expect(
            result == .invalid([
                "MEATGEEK_TENANT_ID (Info.plist MeatGeekTenantID) is missing or empty.",
                "MEATGEEK_CLIENT_ID (Info.plist MeatGeekClientID) is missing or not a string.",
                "MEATGEEK_API_SCOPE (Info.plist MeatGeekAPIScope) is missing or empty.",
            ])
        )
    }

    @Test(
        "a malformed base URL is a problem",
        arguments: [
            "https:", // an unescaped // in the xcconfig: the rest is a comment
            "meatgeek-v2-dev-func.azurewebsites.net/api", // no scheme
            "ftp://api.example.test/api",
            "https://",
            "not a url",
        ]
    )
    func malformedBaseURL(value: String) {
        let result = AppConfig.parse(infoDictionary: Self.info(["MeatGeekAPIBaseURL": value]))
        guard case .invalid(let problems) = result else {
            Issue.record("expected .invalid for \(value), got \(result)")
            return
        }
        #expect(problems.count == 1)
        #expect(problems.first?.hasPrefix(
            "MEATGEEK_API_BASE_URL (Info.plist MeatGeekAPIBaseURL) is not an http(s) URL with a host: \(value)"
        ) == true)
    }

    @Test("a malformed base URL and a missing key are both listed")
    func severalProblems() {
        let result = AppConfig.parse(infoDictionary: Self.info([
            "MeatGeekAPIBaseURL": "https:",
            "MeatGeekTenantID": nil,
        ]))
        guard case .invalid(let problems) = result else {
            Issue.record("expected .invalid, got \(result)")
            return
        }
        #expect(problems.count == 2)
        #expect(problems.contains("MEATGEEK_TENANT_ID (Info.plist MeatGeekTenantID) is missing or empty."))
        #expect(problems.contains { $0.contains("is not an http(s) URL with a host: https:") })
    }
}
