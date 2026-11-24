import UIKit
import XCTest

/// Every real-time bound the live proof uses. Each is a row of "Real-time
/// waits" in docs/development/live-acceptance.md ("The iOS proof's waits");
/// change one only with a reason there.
enum LiveBound {
    /// One app screen or one API round trip after sign-in: a list, a form
    /// closing, a status changing. A dev Function App cold start is about 10 s.
    static let app: TimeInterval = 30
    /// One of Microsoft's sign-in pages showing its element.
    static let signInStep: TimeInterval = 30
    /// The system "wants to use … to sign in" alert, or Microsoft's first
    /// page, after Sign in with Microsoft.
    static let consent: TimeInterval = 30
    /// The edit menu's Paste item, after a tap on a field (re-tapped every
    /// `pasteRetap`).
    static let pasteMenu: TimeInterval = 10
    static let pasteRetap: TimeInterval = 2
    /// From the tap on Start to the cook screen showing a pushed reading.
    static let push: TimeInterval = 90
    /// A code typed with less than this left in its window can expire before
    /// Microsoft checks it: wait for the next window instead (at most
    /// `totpMargin` + `totpSlack`).
    static let totpMargin: TimeInterval = 5
    static let totpSlack: TimeInterval = 0.25
    /// How often a poll (`firstOf`, the pushed-reading watch) looks again.
    static let poll: TimeInterval = 0.25
}

/// A failed step of the live proof. Its message names what was awaited, never
/// a value that was typed or pasted.
struct LiveFailure: LocalizedError, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
    /// What XCTest prints for a thrown error.
    var errorDescription: String? { description }
}

/// Runs the proof's numbered steps, printing one `PASS <step> (<s> s)` or
/// `FAIL <step> (<s> s): <why>` line each, which the CI job copies to the run
/// summary, as the web proof's step reporter does.
@MainActor
final class LiveSteps {
    private(set) var failed: String?

    func run<T>(_ name: String, _ body: () throws -> T) throws -> T {
        let started = Date()
        do {
            let value = try XCTContext.runActivity(named: name) { _ in try body() }
            print("PASS \(name) (\(Self.seconds(since: started)) s)")
            return value
        } catch {
            print("FAIL \(name) (\(Self.seconds(since: started)) s): \(error)")
            failed = name
            throw error
        }
    }

    static func seconds(since date: Date) -> String {
        String(format: "%.1f", Date().timeIntervalSince(date))
    }
}

@MainActor
enum Live {
    /// Waits up to `bound` for `element` to exist; throws naming `what`.
    static func waitFor(_ element: XCUIElement, _ what: String, bound: TimeInterval = LiveBound.app) throws {
        guard element.waitForExistence(timeout: bound) else {
            throw LiveFailure("\(what) did not appear within \(Int(bound)) s")
        }
    }

    /// Waits up to `bound` for `element` to be gone; throws naming `what`.
    static func waitGone(_ element: XCUIElement, _ what: String, bound: TimeInterval = LiveBound.app) throws {
        guard element.waitForNonExistence(timeout: bound) else {
            throw LiveFailure("\(what) was still there after \(Int(bound)) s")
        }
    }

    /// Waits up to `bound` for `element`'s label to be `label`. Only for
    /// elements that hold no secret: a failure quotes the label it saw.
    static func waitLabel(_ element: XCUIElement, _ label: String, _ what: String, bound: TimeInterval = LiveBound.app) throws {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", label), object: element)
        guard XCTWaiter().wait(for: [expectation], timeout: bound) == .completed else {
            let seen = element.exists ? "\"\(element.label)\"" : "nothing"
            throw LiveFailure("\(what) did not become \"\(label)\" within \(Int(bound)) s (it shows \(seen))")
        }
    }

    /// Polls `outcomes` in order every `LiveBound.poll` until one holds, for
    /// at most `bound`, and returns its key. Throws naming `step` and every key.
    static func firstOf<K: Sendable>(
        _ step: String, bound: TimeInterval, _ outcomes: [(K, () -> Bool)]
    ) throws -> K {
        let deadline = Date().addingTimeInterval(bound)
        while true {
            for (key, holds) in outcomes where holds() {
                return key
            }
            guard Date() < deadline else {
                let keys = outcomes.map { "\($0.0)" }.joined(separator: ", ")
                throw LiveFailure("\(step): none of \(keys) within \(Int(bound)) s")
            }
            Thread.sleep(forTimeInterval: LiveBound.poll)
        }
    }

    /// Puts `secret` into `field` by the edit menu's Paste, never by typing:
    /// XCTest writes every `typeText` value to the xcodebuild log
    /// (`Type '<text>' into …`), and a paste logs only `Tap "Paste" MenuItem`.
    /// The pasteboard is emptied again before this returns. Nothing reads the
    /// field's value back.
    static func paste(_ secret: String, into field: XCUIElement, of app: XCUIApplication, _ what: String) throws {
        UIPasteboard.general.string = secret
        defer { UIPasteboard.general.items = [] }
        let paste = app.menuItems["Paste"]
        let deadline = Date().addingTimeInterval(LiveBound.pasteMenu)
        while !paste.exists {
            guard Date() < deadline else {
                throw LiveFailure("the Paste menu did not appear on \(what) within \(Int(LiveBound.pasteMenu)) s")
            }
            field.tap()
            _ = paste.waitForExistence(timeout: LiveBound.pasteRetap)
        }
        paste.tap()
    }

    /// Keeps a screenshot of the app in the result bundle, whatever the outcome.
    static func screenshot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        XCTContext.runActivity(named: "Screenshot \(name)") { $0.add(attachment) }
    }
}
