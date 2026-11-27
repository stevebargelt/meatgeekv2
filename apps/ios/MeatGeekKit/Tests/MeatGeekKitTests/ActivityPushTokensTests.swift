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
        let model = ActivityPushTokensModel(port: port)
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
        port.shown = [.init(id: "a-1", cookID: "cook-1"), .init(id: "a-2", cookID: "cook-2")]
        let model = ActivityPushTokensModel(port: port)
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
        port.shown = [.init(id: "a-1", cookID: "cook-1")]
        let model = ActivityPushTokensModel(port: port)
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

    @Test("Starting twice reads the start token stream once")
    func startOnce() {
        let port = FakeLiveActivities()
        let model = ActivityPushTokensModel(port: port)
        model.start()
        model.start()
        #expect(port.startTokenReads == 1)
    }
}
