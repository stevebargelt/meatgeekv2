import Foundation
import Testing
@testable import MeatGeekKit

/// The debug screen's push tokens (#248): what a sender needs to reach this
/// phone, the token that starts an activity by push and each running
/// activity's update token, read from the `LiveActivities` port. Over the
/// fake port; nothing here waits in real time.
@MainActor
@Suite("Push tokens for test pushes")
struct ActivityPushTokensTests {
    @Test("A token reads as lower-case hex, as APNs takes it")
    func hex() {
        #expect(ActivityPushTokensModel.hex(Data([0x00, 0x0a, 0xff, 0x7b])) == "000aff7b")
        #expect(ActivityPushTokensModel.hex(Data()) == "")
    }

    @Test("Shows the push-to-start token, and the latest when the system issues a new one")
    func startToken() async {
        let port = FakeLiveActivities()
        let clock = SettableClock()
        let model = ActivityPushTokensModel(port: port, now: clock.now)
        #expect(model.startToken == nil)
        model.start()
        port.issueStartToken(Data([0xab, 0xcd]))
        await until("the start token shows") { model.startToken == "abcd" }
        port.issueStartToken(Data([0x01]))
        await until("the newer start token shows") { model.startToken == "01" }
    }

    @Test("Lists each running activity with its cook, and its update token once issued")
    func activityTokens() async {
        let port = FakeLiveActivities()
        let clock = SettableClock()
        port.shown = [.init(id: "a-1", cookID: "cook-1"), .init(id: "a-2", cookID: "cook-2")]
        let model = ActivityPushTokensModel(port: port, now: clock.now)
        model.start()
        #expect(model.activities.map(\.id) == ["a-1", "a-2"])
        #expect(model.activities.map(\.cookID) == ["cook-1", "cook-2"])
        #expect(model.activities.allSatisfy { $0.updateToken == nil })
        port.issuePushToken(Data([0x12, 0x34]), for: "a-2")
        await until("a-2's token shows") { model.activities.last?.updateToken == "1234" }
        #expect(model.activities.first?.updateToken == nil)
    }

    @Test("Refreshing picks up an activity started by push and drops an ended one, reading each token stream once")
    func refresh() async {
        let port = FakeLiveActivities()
        let clock = SettableClock()
        port.shown = [.init(id: "a-1", cookID: "cook-1")]
        let model = ActivityPushTokensModel(port: port, now: clock.now)
        model.start()
        port.issuePushToken(Data([0x01]), for: "a-1")
        await until("a-1's token shows") { model.activities.first?.updateToken == "01" }

        port.shown = [.init(id: "a-1", cookID: "cook-1"), .init(id: "a-2", cookID: "cook-1")]
        model.refresh()
        #expect(model.activities.map(\.id) == ["a-1", "a-2"])
        #expect(model.activities.first?.updateToken == "01")
        port.issuePushToken(Data([0x02]), for: "a-2")
        await until("a-2's token shows") { model.activities.last?.updateToken == "02" }

        port.shown = [.init(id: "a-2", cookID: "cook-1")]
        model.refresh()
        #expect(model.activities.map(\.id) == ["a-2"])
        #expect(port.pushTokenReads == ["a-1", "a-2"])
    }

    @Test("Records when each update token came, to compare with when the app became active")
    func receivedAt() async {
        let port = FakeLiveActivities()
        let clock = SettableClock()
        port.shown = [.init(id: "a-1", cookID: "cook-1")]
        let model = ActivityPushTokensModel(port: port, now: clock.now)
        clock.set(fixedNow)
        model.start()
        #expect(model.activeSince == fixedNow)
        #expect(model.activities.first?.updateTokenReceivedAt == nil)
        clock.set(fixedNow.addingTimeInterval(5))
        port.issuePushToken(Data([0x01]), for: "a-1")
        await until("a-1's token shows") { model.activities.first?.updateToken == "01" }
        #expect(model.activities.first?.updateTokenReceivedAt == fixedNow.addingTimeInterval(5))
    }

    @Test("A token stream that ends is followed again on the next refresh")
    func endedStream() async {
        let port = FakeLiveActivities()
        let clock = SettableClock()
        port.shown = [.init(id: "a-1", cookID: "cook-1")]
        let model = ActivityPushTokensModel(port: port, now: clock.now)
        model.start()
        port.finishPushTokens(for: "a-1")
        await until("the ended stream lets go of a-1") { !model.followed.contains("a-1") }
        model.refresh()
        #expect(port.pushTokenReads == ["a-1", "a-1"])
        port.issuePushToken(Data([0x07]), for: "a-1")
        await until("a-1's token shows") { model.activities.first?.updateToken == "07" }
    }

    @Test("Starting twice reads the start token stream once")
    func startOnce() {
        let port = FakeLiveActivities()
        let clock = SettableClock()
        let model = ActivityPushTokensModel(port: port, now: clock.now)
        model.start()
        model.start()
        #expect(port.startTokenReads == 1)
    }
}

/// A clock the test sets.
final class SettableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = fixedNow
    func set(_ date: Date) { lock.withLock { current = date } }
    var now: @Sendable () -> Date { { self.lock.withLock { self.current } } }
}
