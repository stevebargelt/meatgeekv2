import Foundation
import MeatGeekAPI
import MeatGeekKit
@testable import MeatGeekLive
@preconcurrency import SignalRClient
import Testing

/// Hub frames, as SignalR Service delivers them, through the decoding path
/// `SignalRLiveHub` uses: the client's JSON hub protocol with the API's date
/// decoding, then the invocation's argument as the generated type.
@Suite("Live hub protocol")
struct LiveHubProtocolTests {
    /// A JSON hub protocol invocation frame: the message, then the record
    /// separator (0x1E).
    static func frame(target: String, argument: String) -> Data {
        Data(#"{"type":1,"target":"\#(target)","arguments":[\#(argument)]}"#.utf8) + Data([0x1E])
    }

    /// The second reading of the producer test "sends a 3-event, 2-device
    /// batch to each device's owner" (apps/api/src/functions/signalr/
    /// broadcast-temperature.spec.ts): the hub-stamped device id, the body's
    /// timestamp, grill and cook id, and the enqueued time.
    static let temperature = """
    {"deviceId":"smoker-b","timestamp":"2026-11-19T10:00:05.000Z","cookId":"cook-1","grillTemp":250,"enqueuedTimeUtc":"2026-11-19T10:00:05.000Z"}
    """

    static func argument<T: Decodable>(_ type: T.Type, from frame: Data, protocol hubProtocol: JSONHubProtocol) throws -> T {
        let messages = try hubProtocol.parseMessages(input: frame)
        #expect(messages.count == 1)
        let invocation = try #require(messages.first as? ClientInvocationMessage)
        return try invocation.getArgument(type: type)
    }

    @Test("a temperature frame decodes into the generated TemperatureMessage")
    func temperatureMessage() throws {
        let frame = Self.frame(target: LiveHubProtocol.temperatureTarget, argument: Self.temperature)
        let message = try Self.argument(TemperatureMessage.self, from: frame, protocol: LiveHubProtocol.make())

        #expect(message.deviceId == "smoker-b")
        #expect(message.timestamp == "2026-11-19T10:00:05.000Z")
        #expect(message.cookId == "cook-1")
        #expect(message.grillTemp == 250)
        #expect(message.probe1Temp == nil)
        #expect(message.probe2Temp == nil)
        #expect(message.enqueuedTimeUtc == Date(timeIntervalSince1970: 1_795_082_405))
        #expect(LiveReading(message).value(.grill) == 250)
        #expect(LiveText.temperature(LiveReading(message).value(.probe2), unit: .fahrenheit) == "—")
    }

    @Test("the client's default decoder cannot read the API's dates: the hub uses the API's")
    func defaultDecoderFails() throws {
        let frame = Self.frame(target: LiveHubProtocol.temperatureTarget, argument: Self.temperature)
        #expect(throws: (any Error).self) {
            try Self.argument(TemperatureMessage.self, from: frame, protocol: JSONHubProtocol(logger: NullLogger()))
        }
    }

    @Test("a cook_stopped frame decodes into the generated CookStoppedMessage")
    func cookStoppedMessage() throws {
        let argument = """
        {"type":"cook_stopped","timestamp":"2026-11-20T23:15:00.000Z",\
        "messageId":"6c0f8a43-8d9b-4f4f-9d3e-2b1d7a1f0c11","deviceId":"meatgeek3","userId":"tid:oid",\
        "correlation":{"id":"req-1"},"payload":{"id":"cook-1","userId":"tid:oid","deviceId":"meatgeek3",\
        "name":"Brisket","status":"completed","startTime":"2026-11-20T15:00:00.000Z",\
        "endTime":"2026-11-20T23:15:00.000Z","meatType":"beef"}}
        """
        let frame = Self.frame(target: LiveHubProtocol.cookStoppedTarget, argument: argument)
        let message = try Self.argument(CookStoppedMessage.self, from: frame, protocol: LiveHubProtocol.make())

        #expect(message.payload.id == "cook-1")
        #expect(message.payload.status == .completed)
        #expect(message.payload.endTime == Date(timeIntervalSince1970: 1_795_216_500))
        #expect(message.deviceId == "meatgeek3")
    }

    @Test("a hub built from a negotiate answer that is not a URL fails to start, and stop is safe")
    @MainActor
    func badURL() async {
        let hub = SignalRLiveHub(info: .init(url: "", accessToken: "t"))
        await #expect(throws: (any Error).self) { try await hub.start() }
        hub.stop()
        hub.stop()
    }
}
