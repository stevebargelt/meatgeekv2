import XCTest

/// Microsoft's real sign-in pages, in the app's system browser sheet
/// (ASWebAuthenticationSession, which XCUITest sees as web views inside the
/// app), from the system "wants to use … to sign in" alert to the app's
/// signed-in screen.
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

    func run() throws {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Continue"]
        let first = try Live.firstOf("sign-in consent", bound: LiveBound.consent, [
            ("the system sign-in alert", { allow.exists }),
            ("Microsoft's UPN page", { textField.exists }),
        ])
        if first == "the system sign-in alert" {
            allow.tap()
            note("Accepted the system alert to sign in with login.microsoftonline.com")
        }

        // UPN
        try Live.waitFor(textField, "Microsoft's UPN page (its text field)", bound: LiveBound.signInStep)
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
        let appError = app.staticTexts["signedOut.error"]
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
