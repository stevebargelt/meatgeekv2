import MSAL
import MeatGeekKit
import MeatGeekMSAL
import XCTest

/// `MSALTokenProvider` against the real MSAL (HAR-171).
///
/// Hosted in the MeatGeek app, not an SPM test target: MSAL's init checks the
/// main bundle's Info.plist for the `msauth.<bundle id>` URL scheme, and only
/// the app has it.
final class MSALTokenProviderTests: XCTestCase {
    /// Interactive sign-in must use the system browser, never the Microsoft
    /// Authenticator broker: MSAL hands sign-in to the broker whenever it is
    /// installed unless `brokerAvailability` is `.none`. The simulator has no
    /// Authenticator, so only this setting shows it.
    @MainActor
    func testConstructingTheProviderTurnsTheBrokerOff() throws {
        // The host app may already have built a provider at launch; start from
        // MSAL's default so the assertion is about this construction.
        MSALGlobalConfig.brokerAvailability = .auto
        let bundleIdentifier = try XCTUnwrap(Bundle.main.bundleIdentifier)
        XCTAssertEqual(bundleIdentifier, "com.meatgeek.ios", "not hosted in the MeatGeek app")
        let config = AppConfig(
            apiBaseURL: URL(string: "https://api.example.test/api")!,
            tenantID: "00000000-0000-0000-0000-000000000001",
            clientID: "00000000-0000-0000-0000-000000000002",
            apiScope: "api://00000000-0000-0000-0000-000000000003/access_as_user"
        )

        _ = try MSALTokenProvider(config: config, bundleIdentifier: bundleIdentifier)

        XCTAssertEqual(MSALGlobalConfig.brokerAvailability, MSALBrokeredAvailability.none)
    }
}
