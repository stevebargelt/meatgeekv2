import XCTest

/// Microsoft's real sign-in pages, in the app's system browser sheet
/// (ASWebAuthenticationSession, which XCUITest sees as web views inside the
/// app), from the tap on Sign in with Microsoft (`openSheet()`) to the app's
/// signed-in screen (`run()`).
///
/// The web content does not expose Microsoft's element ids (`#i0116` and the
/// rest, which apps/web-e2e/live/microsoft-sign-in.ts uses), so the pages are
/// told apart by what is on them, not by copy where that can be helped:
///
/// | Page                 | Recognised by                                                    |
/// |----------------------|------------------------------------------------------------------|
/// | UPN                  | the web view's only text field                                   |
/// | Password             | a secure text field                                              |
/// | Authenticator code   | a text field and no secure text field, after the password        |
/// | Choose a method      | an element labelled "…verification code…" (copy)                 |
/// | Sign in another way  | an element labelled "…another way…" (copy)                       |
/// | Stay signed in?      | a "No" button (copy)                                             |
/// | An error             | text inside Microsoft's `role="alert"` container                 |
///
/// Each field is filled by `Live.paste`, never typed, and submitted with the
/// keyboard's Return once it holds the value, so no button copy is needed
/// until "Stay signed in?".
/// See "When Microsoft changes its sign-in pages" in
/// docs/development/live-acceptance.md (Live iOS proof).
@MainActor
struct MicrosoftSignIn {
    let app: XCUIApplication
    let inputs: LiveInputs
    let note: (String) -> Void

    private var web: XCUIElementQuery { app.webViews }
    private var textField: XCUIElement { web.textFields.firstMatch }
    private var secureField: XCUIElement { web.secureTextFields.firstMatch }
    private var signedIn: XCUIElement { app.buttons["account.menu"] }
    private var stayNo: XCUIElement { web.buttons["No"] }
    /// Text inside Microsoft's error container (`role="alert"`), which is on
    /// every page and empty until there is an error.
    private var errorText: XCUIElement {
        web.otherElements.matching(NSPredicate(format: "label == %@", "alert")).staticTexts.firstMatch
    }
    private func labelled(_ fragment: String) -> XCUIElement {
        web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", fragment)).firstMatch
    }

    /// Microsoft's error text, for a failure message. It never holds a typed
    /// value: Microsoft does not echo passwords or codes.
    private func microsoftSays() -> String {
        errorText.exists ? ": Microsoft says \"\(errorText.label)\"" : ""
    }

    /// The app's signed-out and "Signing in…" screens (`AccessibilityID` in
    /// MeatGeek/RootView.swift).
    private var signInButton: XCUIElement { app.buttons["signedOut.signIn"] }
    private var signingIn: XCUIElement { app.descendants(matching: .any)["root.signingIn"] }
    private var appError: XCUIElement { app.staticTexts["signedOut.error"] }
    private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    /// From the tap on Sign in with Microsoft to Microsoft's first page, by
    /// what the app shows at each point, not by one window over the end
    /// result:
    ///
    /// 1. The tap is taken: the app shows "Signing in…" (MSAL is starting), or
    ///    is already past it.
    /// 2. MSAL's own outcome: the system "wants to use … to sign in" alert,
    ///    Microsoft's UPN page, the app's sign-in error, or the signed-out
    ///    screen again (MSAL reported the sign-in cancelled).
    /// 3. After Continue on the alert: Microsoft's UPN page, or the same two
    ///    app outcomes.
    ///
    /// Nothing has been pasted yet, so a failure here says what is on screen
    /// (`SignInScreen`), and the proof keeps a screenshot of it.
    func openSheet() throws {
        let allow = springboard.alerts.buttons["Continue"]
        let started = Date()
        let mustDecide: [(String, () -> Bool)] = [
            ("the system sign-in alert", { allow.exists }),
            ("Microsoft's UPN page", { textField.exists }),
            ("the app's sign-in error", { appError.exists }),
        ]
        let taken = try Live.firstOf(
            "sign-in start (the tap on Sign in with Microsoft)", bound: LiveBound.app,
            [("the app's Signing in…", { signingIn.exists })] + mustDecide, onScreen: screen
        )
        note("Sign-in started: \(taken) after \(LiveSteps.seconds(since: started)) s")
        let cancelled: (String, () -> Bool) = ("the signed-out screen", { signInButton.exists && !signingIn.exists })
        var first = taken
        if first == "the app's Signing in…" {
            first = try Live.firstOf("sign-in consent", bound: LiveBound.consent, mustDecide + [cancelled], onScreen: screen)
            note("MSAL's outcome: \(first) after \(LiveSteps.seconds(since: started)) s")
        }
        try failOnAppOutcome(first)
        if first == "the system sign-in alert" {
            allow.tap()
            note("Accepted the system alert to sign in with login.microsoftonline.com")
            let page = try Live.firstOf(
                "Microsoft's UPN page", bound: LiveBound.signInStep,
                [("Microsoft's UPN page", { textField.exists }), mustDecide[2], cancelled], onScreen: screen
            )
            try failOnAppOutcome(page)
            note("Microsoft's UPN page after \(LiveSteps.seconds(since: started)) s")
        }
    }

    /// Throws for the two outcomes in which the app, not Microsoft, ended
    /// sign-in before its first page.
    private func failOnAppOutcome(_ outcome: String) throws {
        switch outcome {
        case "the app's sign-in error":
            throw LiveFailure("the app could not open Microsoft's sign-in: it says \"\(appError.label)\"")
        case "the signed-out screen":
            throw LiveFailure(
                "sign-in ended before Microsoft's first page: the app is back on its signed-out screen with no error"
                    + " (MSAL reported it cancelled)"
            )
        default:
            return
        }
    }

    /// What is on screen, for a failure before anything is pasted.
    private func screen() -> String {
        SignInScreen(
            signInButton: signInButton.exists,
            signingIn: signingIn.exists,
            appError: appError.exists ? appError.label : nil,
            alerts: springboard.alerts.allElementsBoundByIndex.map(\.label),
            webViews: web.count,
            webTextFields: web.textFields.count
        ).summary
    }

    /// Signs in on Microsoft's pages, from the UPN page `openSheet()` reached
    /// to the app's signed-in screen.
    func run() throws {
        // UPN
        try Live.paste(inputs.upn, into: textField, of: app, "the UPN field")
        app.typeText("\n")
        let afterUpn = try Live.firstOf("password", bound: LiveBound.signInStep, [
            ("the password page", { secureField.exists }),
            ("an error on the UPN page", { errorText.exists }),
        ])
        if afterUpn != "the password page" {
            throw LiveFailure("Microsoft refused MEATGEEK_LIVE_UPN (step upn)\(microsoftSays())")
        }

        // Password
        try Live.paste(inputs.password, into: secureField, of: app, "the password field", shown: .bullets)
        app.typeText("\n")
        var next = try Live.firstOf("second factor", bound: LiveBound.signInStep, [
            ("the app", { signedIn.exists }),
            ("stay signed in", { stayNo.exists }),
            ("code", { textField.exists && !secureField.exists }),
            ("choose method", { labelled("verification code").exists }),
            ("other way", { labelled("another way").exists }),
            ("password error", { secureField.exists && errorText.exists }),
        ])
        if next == "password error" {
            throw LiveFailure("Microsoft rejected the password for MEATGEEK_LIVE_UPN (step password)\(microsoftSays())")
        }
        if next == "other way" {
            // A push the run cannot approve: ask for another method instead.
            labelled("another way").tap()
            next = try Live.firstOf("choose method", bound: LiveBound.signInStep, [
                ("code", { textField.exists }),
                ("choose method", { labelled("verification code").exists }),
            ])
        }
        if next == "choose method" {
            labelled("verification code").tap()
            next = try Live.firstOf("totp", bound: LiveBound.signInStep, [("code", { textField.exists })])
        }
        if next == "code" {
            try enterCode()
            next = try Live.firstOf("stay signed in", bound: LiveBound.signInStep, [
                ("the app", { signedIn.exists }),
                ("stay signed in", { stayNo.exists }),
                ("code error", { errorText.exists }),
            ])
            if next == "code error" {
                throw LiveFailure(
                    "Microsoft rejected the TOTP code (step totp): check MEATGEEK_LIVE_TOTP_SECRET and this Mac's clock"
                        + microsoftSays()
                )
            }
        } else {
            note("Microsoft did not ask for a second factor on this sign-in")
        }
        if next == "stay signed in" {
            stayNo.tap()
        }
        // Back in the app: signed in, or MSAL's error on the signed-out screen
        // (for one, a keychain the build cannot reach).
        let back = try Live.firstOf("return to the app", bound: LiveBound.signInStep, [
            ("signed in", { signedIn.exists }),
            ("a sign-in error", { appError.exists }),
        ])
        if back == "a sign-in error" {
            throw LiveFailure("the app did not sign in after Microsoft's last page: it says \"\(appError.label)\"")
        }
    }

    /// The authenticator-app code, from a fresh window when the current one
    /// is nearly over.
    private func enterCode() throws {
        let left = TOTP.secondsLeftInWindow(at: Date())
        if left < LiveBound.totpMargin {
            note(String(format: "Waiting %.1f s for the next TOTP window", left + LiveBound.totpSlack))
            Thread.sleep(forTimeInterval: left + LiveBound.totpSlack)
        }
        guard let code = TOTP.code(secret: inputs.totpSecret, at: Date()) else {
            throw LiveFailure("MEATGEEK_LIVE_TOTP_SECRET is not a base32 secret")
        }
        try Live.paste(code, into: textField, of: app, "the code field")
        app.typeText("\n")
    }
}

/// What is on screen while sign-in starts, for a failure message: the app's
/// sign-in screens, the system alerts and the sign-in sheet. It is read only
/// before anything is pasted, so it holds no input; the app's error and the
/// alerts' labels are the app's and Apple's own text.
struct SignInScreen: Equatable, Sendable {
    var signInButton: Bool
    var signingIn: Bool
    var appError: String?
    var alerts: [String]
    var webViews: Int
    var webTextFields: Int

    var summary: String {
        let app: String
        if let appError {
            app = "the app says \"\(appError)\""
        } else if signingIn {
            app = "the app still says \"Signing in…\""
        } else if signInButton {
            app = "the app's signed-out screen with Sign in with Microsoft"
        } else {
            app = "none of the app's sign-in screens"
        }
        let alert = alerts.isEmpty ? "no system alert" : alerts.map { "the system alert \"\($0)\"" }.joined(separator: ", ")
        let sheet: String
        if webViews == 0 {
            sheet = "no sign-in sheet"
        } else if webTextFields == 0 {
            sheet = "a sign-in sheet with no text field yet"
        } else {
            sheet = "a sign-in sheet with a text field"
        }
        return "\(app); \(alert); \(sheet)"
    }
}
