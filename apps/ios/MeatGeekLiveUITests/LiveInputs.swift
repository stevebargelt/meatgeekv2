import Foundation

/// What the live proof runs with, from the test runner's environment.
///
/// `xcodebuild test` hands every variable named `TEST_RUNNER_<NAME>` in its own
/// environment to the test runner as `<NAME>`, so the runner script
/// (apps/ios/scripts/run-live-proof.sh) exports `TEST_RUNNER_MEATGEEK_LIVE_*`.
/// Nothing reaches the app: it is launched with its own, empty, environment.
///
/// Errors name variables, never their values.
struct LiveInputs: Sendable {
    /// Variables the proof cannot run without, in the order the docs list them.
    static let required = [
        "MEATGEEK_LIVE_UPN",
        "MEATGEEK_LIVE_PASSWORD",
        "MEATGEEK_LIVE_TOTP_SECRET",
        "MEATGEEK_LIVE_DEVICE_ID",
        "MEATGEEK_LIVE_CLAIM_CODE",
    ]
    /// Optional: names the cook (`acceptance ios <run id>`). The runner sets it
    /// to the GitHub run id, or a UTC timestamp locally.
    static let runIDKey = "MEATGEEK_LIVE_RUN_ID"
    /// What `MEATGEEK_LIVE_CLAIM_CODE` holds when `simdevice claim-code`
    /// reports the device `claimed`: an earlier run stopped before releasing
    /// it, so there is no code, and the device must already be the acceptance
    /// user's.
    static let alreadyClaimed = "already-claimed"

    enum Claim: Sendable, Equatable {
        case code(String)
        case alreadyClaimed
    }

    let upn: String
    let password: String
    let totpSecret: String
    let deviceID: String
    let claim: Claim
    let runID: String

    /// The inputs, or every problem with them: each missing variable, then
    /// any that is set but unusable.
    static func read(_ environment: [String: String]) -> Result<LiveInputs, InputsError> {
        let value = { (key: String) in environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        let missing = required.filter { value($0).isEmpty }
        var problems: [String] = []
        let secret = value("MEATGEEK_LIVE_TOTP_SECRET")
        if !secret.isEmpty, TOTP.decode(secret) == nil {
            problems.append("MEATGEEK_LIVE_TOTP_SECRET is not a base32 secret")
        }
        let code = value("MEATGEEK_LIVE_CLAIM_CODE")
        if !code.isEmpty, code != alreadyClaimed, !isClaimCode(code) {
            problems.append(
                "MEATGEEK_LIVE_CLAIM_CODE is neither a claim code (XXXX-XXXX-XXXX) nor \(alreadyClaimed)"
            )
        }
        guard missing.isEmpty, problems.isEmpty else {
            return .failure(InputsError(missing: missing, problems: problems))
        }
        let runID = value(runIDKey)
        return .success(LiveInputs(
            upn: value("MEATGEEK_LIVE_UPN"),
            password: environment["MEATGEEK_LIVE_PASSWORD"] ?? "",
            totpSecret: secret,
            deviceID: value("MEATGEEK_LIVE_DEVICE_ID"),
            claim: code == alreadyClaimed ? .alreadyClaimed : .code(code),
            runID: runID.isEmpty ? Self.utcStamp(Date()) : runID
        ))
    }

    /// A claim code as simdevice prints it: `XXXX-XXXX-XXXX` in Crockford
    /// base32 (no I, L, O or U).
    static func isClaimCode(_ text: String) -> Bool {
        text.range(of: "^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$", options: .regularExpression) != nil
    }

    static func utcStamp(_ date: Date) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(identifier: "UTC")
        format.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return format.string(from: date)
    }
}

/// Why the inputs cannot be used. Its description names variables only.
struct InputsError: LocalizedError, Equatable, CustomStringConvertible {
    let missing: [String]
    let problems: [String]

    /// What XCTest prints for a thrown error.
    var errorDescription: String? { description }

    var description: String {
        var parts: [String] = []
        if !missing.isEmpty {
            parts.append(
                "missing: " + missing.joined(separator: ", ")
                    + " (export each as TEST_RUNNER_<name> for xcodebuild, or run apps/ios/scripts/run-live-proof.sh)"
            )
        }
        parts.append(contentsOf: problems)
        return "The live iOS proof cannot run: " + parts.joined(separator: "; ")
    }
}
