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

    func testAPastedFieldHoldsTheSameText() {
        XCTAssertTrue(Live.holds("someone@example.com", "someone@example.com", shown: .asIs))
        XCTAssertFalse(Live.holds("", "someone@example.com", shown: .asIs))
        XCTAssertFalse(Live.holds("Email, phone, or Skype", "someone@example.com", shown: .asIs))
        XCTAssertFalse(Live.holds(nil, "someone@example.com", shown: .asIs))
        XCTAssertFalse(Live.holds("", "", shown: .asIs), "an empty secret never counts as pasted")
    }

    func testAPastedSecureFieldHoldsOneBulletPerCharacter() {
        XCTAssertTrue(Live.holds("••••••", "hunter", shown: .bullets))
        XCTAssertFalse(Live.holds("•••••", "hunter", shown: .bullets))
        XCTAssertFalse(Live.holds("", "hunter", shown: .bullets))
        XCTAssertFalse(Live.holds("Password", "hunter", shown: .bullets))
    }

    func testAPastedClaimCodeHoldsTheSameSymbolsReformatted() {
        XCTAssertTrue(Live.holds("ABCD-EFGH-JKLM", "abcd efgh jklm", shown: .reformatted))
        XCTAssertTrue(Live.holds("ABCD-EFGH-JKLM", "ABCDEFGHJKLM", shown: .reformatted))
        XCTAssertFalse(Live.holds("ABCD-EFGH-JKL", "abcd efgh jklm", shown: .reformatted))
        XCTAssertFalse(Live.holds("XXXX-XXXX-XXXX", "abcd efgh jklm", shown: .reformatted))
        XCTAssertFalse(Live.holds("", "abcd efgh jklm", shown: .reformatted))
        XCTAssertFalse(Live.holds("-", "--", shown: .reformatted))
    }

    func testAFieldShowingItsPlaceholderIsEmpty() {
        XCTAssertTrue(Live.isEmpty(nil, placeholder: nil))
        XCTAssertTrue(Live.isEmpty("", placeholder: "Email, phone, or Skype"))
        XCTAssertTrue(Live.isEmpty("Email, phone, or Skype", placeholder: "Email, phone, or Skype"))
        XCTAssertFalse(Live.isEmpty("someone", placeholder: "Email, phone, or Skype"))
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

    /// A fake clock for `LivePoll`: time moves only when a look or a sleep
    /// moves it.
    final class FakeClock {
        var now = Date(timeIntervalSince1970: 0)
        var seconds: TimeInterval { now.timeIntervalSince1970 }
        func advance(_ by: TimeInterval) { now = now.addingTimeInterval(by) }
    }

    /// Deploy Dev App 45465463113: one sweep of the "second factor" outcomes
    /// took 47 s, as XCUITest hung on a page being replaced. The look that
    /// started before the 30 s deadline is not the last: the next one, on the
    /// settled page, finds it.
    func testAPollLooksAgainAfterALookThatRanPastTheDeadline() {
        let clock = FakeClock()
        var looks: [TimeInterval] = []
        let found = LivePoll.find(by: Date(timeIntervalSince1970: 30), now: { clock.now }, sleep: clock.advance) { () -> String? in
            looks.append(clock.seconds)
            if looks.count == 1 {
                clock.advance(47)
                return nil
            }
            return "stay signed in"
        }
        XCTAssertEqual(found, "stay signed in")
        XCTAssertEqual(looks, [0, 47.25])
    }

    /// It fails only after a look that started at or after the deadline found
    /// nothing, and looks no more after that.
    func testAPollFailsAfterOneLookStartedAtTheDeadline() {
        let clock = FakeClock()
        var looks: [TimeInterval] = []
        let slow: Int? = LivePoll.find(by: Date(timeIntervalSince1970: 30), now: { clock.now }, sleep: clock.advance) {
            looks.append(clock.seconds)
            clock.advance(47)
            return nil
        }
        XCTAssertNil(slow)
        XCTAssertEqual(looks, [0, 47.25])

        let fast = FakeClock()
        var fastLooks: [TimeInterval] = []
        let held = LivePoll.holds(by: Date(timeIntervalSince1970: 1), now: { fast.now }, sleep: fast.advance) {
            fastLooks.append(fast.seconds)
            return false
        }
        XCTAssertFalse(held)
        XCTAssertEqual(fastLooks, [0, 0.25, 0.5, 0.75, 1], "every 0.25 s, the last at the deadline")
    }

    func testAPollReturnsAtTheFirstLookThatFindsWithoutSleeping() {
        let clock = FakeClock()
        var slept = 0
        let held = LivePoll.holds(by: Date(timeIntervalSince1970: 30), now: { clock.now }, sleep: { _ in slept += 1 }) {
            true
        }
        XCTAssertTrue(held)
        XCTAssertEqual(slept, 0)
    }

    /// A sign-in that does not reach Microsoft's first page says which of the
    /// app's states it was stuck in, so a red run names the cause.
    func testSignInScreenSaysWhereSignInStopped() {
        let spinning = SignInScreen(
            signInButton: false, signingIn: true, appError: nil, alerts: [], webViews: 0, webTextFields: 0
        )
        XCTAssertEqual(spinning.summary, "the app still says \"Signing in…\"; no system alert; no sign-in sheet")
        let untapped = SignInScreen(
            signInButton: true, signingIn: false, appError: nil, alerts: [], webViews: 0, webTextFields: 0
        )
        XCTAssertEqual(
            untapped.summary, "the app's signed-out screen with Sign in with Microsoft; no system alert; no sign-in sheet"
        )
        let loading = SignInScreen(
            signInButton: false, signingIn: true, appError: nil, alerts: ["“MeatGeek” Wants to Use “microsoftonline.com” to Sign In"],
            webViews: 1, webTextFields: 0
        )
        XCTAssertEqual(
            loading.summary,
            "the app still says \"Signing in…\"; the system alert \"“MeatGeek” Wants to Use “microsoftonline.com” to Sign In\";"
                + " a sign-in sheet with no text field yet"
        )
        let failed = SignInScreen(
            signInButton: true, signingIn: false, appError: "Sign-in failed. The request timed out.", alerts: [],
            webViews: 0, webTextFields: 0
        )
        XCTAssertEqual(
            failed.summary, "the app says \"Sign-in failed. The request timed out.\"; no system alert; no sign-in sheet"
        )
        let page = SignInScreen(signInButton: false, signingIn: false, appError: nil, alerts: [], webViews: 1, webTextFields: 1)
        XCTAssertEqual(page.summary, "none of the app's sign-in screens; no system alert; a sign-in sheet with a text field")
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
