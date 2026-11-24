import XCTest

/// The live proof's pure parts, which need no app, network or input: the
/// TOTP port (the same vectors as apps/web-e2e/live/helpers.test.ts) and the
/// input check. They run with the `Live` test plan, before the proof itself.
final class LiveOfflineTests: XCTestCase {
    /// RFC 6238 appendix B's SHA-1 secret, "12345678901234567890", in base32.
    static let rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

    func testTOTPMatchesTheRFC6238Vectors() {
        let vectors: [(TimeInterval, String)] = [
            (59, "94287082"), (1_111_111_109, "07081804"), (1_234_567_890, "89005924"), (20_000_000_000, "65353130"),
        ]
        for (seconds, code) in vectors {
            XCTAssertEqual(TOTP.code(secret: Self.rfcSecret, at: Date(timeIntervalSince1970: seconds), digits: 8), code, "T=\(seconds)")
        }
        XCTAssertEqual(TOTP.code(secret: Self.rfcSecret, at: Date(timeIntervalSince1970: 59)), "287082")
    }

    func testTOTPAcceptsTheSecretGroupedLowerCaseAndPadded() {
        XCTAssertEqual(TOTP.normalize("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq===="), Self.rfcSecret)
        XCTAssertEqual(TOTP.code(secret: "gezd gnbv gy3t qojq gezd gnbv gy3t qojq", at: Date(timeIntervalSince1970: 59)), "287082")
    }

    /// An Entra authenticator-app secret is 16 base32 characters: 10 bytes.
    func testTOTPAcceptsATenByteSecretAsEntraIssues() {
        XCTAssertEqual(TOTP.code(secret: "jbsw y3dp ehpk 3pxp", at: Date(timeIntervalSince1970: 59)), "996554")
        XCTAssertEqual(TOTP.code(secret: "jbsw y3dp ehpk 3pxp", at: Date(timeIntervalSince1970: 1_111_111_109)), "071271")
    }

    func testTOTPRefusesASecretThatIsNotBase32() {
        XCTAssertNil(TOTP.code(secret: "not base32!", at: Date(timeIntervalSince1970: 59)))
        XCTAssertNil(TOTP.code(secret: "", at: Date(timeIntervalSince1970: 59)))
    }

    func testTOTPCountsDownTheWindow() {
        XCTAssertEqual(TOTP.secondsLeftInWindow(at: Date(timeIntervalSince1970: 60)), 30)
        XCTAssertEqual(TOTP.secondsLeftInWindow(at: Date(timeIntervalSince1970: 89.75)), 0.25)
    }

    func testInputsNameEveryMissingVariableAndNoValue() {
        let password = "hunter2-not-real"
        guard case .failure(let error) = LiveInputs.read(["MEATGEEK_LIVE_PASSWORD": password]) else {
            return XCTFail("inputs with four variables missing were accepted")
        }
        XCTAssertEqual(
            error.missing,
            ["MEATGEEK_LIVE_UPN", "MEATGEEK_LIVE_TOTP_SECRET", "MEATGEEK_LIVE_DEVICE_ID", "MEATGEEK_LIVE_CLAIM_CODE"]
        )
        for name in error.missing {
            XCTAssertTrue(error.description.contains(name), name)
        }
        XCTAssertFalse(error.description.contains(password))
    }

    func testInputsWithNothingSetNameAllFive() {
        guard case .failure(let error) = LiveInputs.read([:]) else {
            return XCTFail("empty inputs were accepted")
        }
        XCTAssertEqual(error.missing, LiveInputs.required)
    }

    func testInputsRefuseAnUnusableSecretOrClaimCodeWithoutQuotingThem() {
        var env = Self.complete
        env["MEATGEEK_LIVE_TOTP_SECRET"] = "not base32!"
        env["MEATGEEK_LIVE_CLAIM_CODE"] = "ABCD-EFGH"
        guard case .failure(let error) = LiveInputs.read(env) else {
            return XCTFail("an unusable secret and claim code were accepted")
        }
        XCTAssertEqual(error.missing, [])
        XCTAssertEqual(error.problems.count, 2)
        XCTAssertFalse(error.description.contains("not base32!"))
        XCTAssertFalse(error.description.contains("ABCD-EFGH"))
    }

    func testInputsReadAClaimCodeOrAlreadyClaimed() throws {
        let inputs = try LiveInputs.read(Self.complete).get()
        XCTAssertEqual(inputs.claim, .code("ABCD-EFGH-JKMN"))
        XCTAssertEqual(inputs.runID, "42")
        var claimed = Self.complete
        claimed["MEATGEEK_LIVE_CLAIM_CODE"] = LiveInputs.alreadyClaimed
        claimed["MEATGEEK_LIVE_RUN_ID"] = nil
        let already = try LiveInputs.read(claimed).get()
        XCTAssertEqual(already.claim, .alreadyClaimed)
        XCTAssertFalse(already.runID.isEmpty)
    }

    static let complete = [
        "MEATGEEK_LIVE_UPN": "someone@example.test",
        "MEATGEEK_LIVE_PASSWORD": "not-a-real-password",
        "MEATGEEK_LIVE_TOTP_SECRET": "jbsw y3dp ehpk 3pxp",
        "MEATGEEK_LIVE_DEVICE_ID": "sim-device-ios",
        "MEATGEEK_LIVE_CLAIM_CODE": "ABCD-EFGH-JKMN",
        "MEATGEEK_LIVE_RUN_ID": "42",
    ]
}
