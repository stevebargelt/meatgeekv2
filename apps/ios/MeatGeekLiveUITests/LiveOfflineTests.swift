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

    /// `Deploy Dev App` run 45476412767 (HAR-171): Microsoft's UPN page was
    /// there when the step's failure looked at the screen, but the last look
    /// counted had started before the 30 s were up and, on the CI simulator,
    /// ended after. Here the page shows at 29 s and each look takes 15 s.
    @MainActor
    func testAStepFindsAPageThatIsThereByTheDeadlineThoughEachLookIsSlow() throws {
        let fake = FakeClock()
        let page: () -> Bool = {
            let shown = fake.seconds >= 29
            fake.seconds += 15
            return shown
        }
        let found = try Live.firstOf("Microsoft's UPN page", bound: 30, [("the UPN page", page)], clock: fake.clock)
        XCTAssertEqual(found, "the UPN page")
    }

    @MainActor
    func testAStepFailsOnlyAfterALookThatStartedOnceTheBoundWasUp() {
        let fake = FakeClock()
        var lookedAt: [TimeInterval] = []
        let page: () -> Bool = {
            lookedAt.append(fake.seconds)
            fake.seconds += 15
            return false
        }
        XCTAssertThrowsError(
            try Live.firstOf("Microsoft's UPN page", bound: 30, [("the UPN page", page)], onScreen: { "no sign-in sheet" }, clock: fake.clock)
        ) { error in
            XCTAssertEqual(
                "\(error)",
                "Microsoft's UPN page: none of the UPN page within 30 s (3 looks, the longest 15.0 s); on screen: no sign-in sheet"
            )
        }
        XCTAssertEqual(lookedAt, [0, 15.25, 30.5])
    }

    @MainActor
    func testAStepReturnsTheFirstOutcomeThatHoldsInOrder() throws {
        // Looks take no time here; both later outcomes hold from 2 s.
        let fake = FakeClock()
        let found = try Live.firstOf("sign-in consent", bound: 30, [
            ("the system sign-in alert", { false }),
            ("Microsoft's UPN page", { fake.seconds >= 2 }),
            ("the app's sign-in error", { fake.seconds >= 2 }),
        ], clock: fake.clock)
        XCTAssertEqual(found, "Microsoft's UPN page")
        XCTAssertEqual(fake.seconds, 2, "polled every LiveBound.poll until the page showed")
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

/// A clock that moves only when a look moves it or a poll pauses.
@MainActor
private final class FakeClock {
    var seconds: TimeInterval = 0

    var clock: LiveClock {
        LiveClock(now: { Date(timeIntervalSince1970: self.seconds) }, pause: { self.seconds += $0 })
    }
}
