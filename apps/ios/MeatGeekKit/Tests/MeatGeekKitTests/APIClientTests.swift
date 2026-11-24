import Foundation
import HTTPTypes
import MeatGeekAPI
import OpenAPIRuntime
import Testing
@testable import MeatGeekKit

/// The generated client, built by `APIClientFactory`, against a fake
/// transport: no network. The bodies are the API's (`apps/web/src/test/fakes.ts`
/// and `apps/api` tests), so a spec change that renames or retypes a field these
/// use fails to compile here or fails to decode.
@Suite("API client")
struct APIClientTests {
    static let baseURL = URL(string: "https://api.example.test/api")!

    @Test("GET /devices sends the bearer token and decodes the device list")
    func getDevices() async throws {
        let transport = FakeTransport(response: .json(status: .ok, Fixtures.deviceList))
        let client = APIClientFactory.makeClient(
            baseURL: Self.baseURL,
            accessToken: { "token-from-closure" },
            transport: transport
        )

        let output = try await client.getDevices()

        let sent = try #require(await transport.requests.first)
        #expect(await transport.requests.count == 1)
        #expect(sent.request.method == .get)
        #expect(sent.request.path == "/devices")
        #expect(sent.baseURL == Self.baseURL)
        #expect(sent.operationID == "getDevices")
        #expect(sent.request.headerFields[.authorization] == "Bearer token-from-closure")

        let devices = try output.ok.body.json.devices
        #expect(devices.count == 2)
        let brisketBox = try #require(devices.first)
        #expect(brisketBox.id == "meatgeek3")
        #expect(brisketBox.userId == "tid:oid")
        #expect(brisketBox.name == "Brisket Box")
        #expect(brisketBox.model == "MeatGeek V1")
        #expect(brisketBox.location == "Backyard")
        #expect(brisketBox.isActive)
        #expect(brisketBox.connection?.state == .connected)
        #expect(
            brisketBox.connection?.lastActivityAt
                == Date(timeIntervalSince1970: 1_795_186_800.5) // 2026-11-20T15:00:00.500Z
        )
        let offset = devices[1]
        #expect(offset.location == nil)
        #expect(offset.connection?.state == .unknown)
        #expect(offset.connection?.lastActivityAt == nil)
    }

    @Test("asks the token closure once per request")
    func tokenPerRequest() async throws {
        let tokens = TokenSequence(["first", "second"])
        let transport = FakeTransport(response: .json(status: .ok, Fixtures.deviceList))
        let client = APIClientFactory.makeClient(
            baseURL: Self.baseURL,
            accessToken: { try await tokens.next() },
            transport: transport
        )

        _ = try await client.getDevices()
        _ = try await client.getDevices()

        let headers = await transport.requests.map { $0.request.headerFields[.authorization] }
        #expect(headers == ["Bearer first", "Bearer second"])
    }

    @Test("a token closure that throws sends nothing")
    func tokenFailure() async throws {
        let transport = FakeTransport(response: .json(status: .ok, Fixtures.deviceList))
        let client = APIClientFactory.makeClient(
            baseURL: Self.baseURL,
            accessToken: { throw TokenUnavailable() },
            transport: transport
        )

        let error = await #expect(throws: ClientError.self) { _ = try await client.getDevices() }
        #expect(error?.underlyingError is TokenUnavailable)
        #expect(await transport.requests.isEmpty)
    }

    @Test("the handler's 401 maps to .unauthorized with its reason")
    func unauthorized() async throws {
        let transport = FakeTransport(response: .json(status: .unauthorized, Fixtures.unauthenticated))
        let client = APIClientFactory.makeClient(
            baseURL: Self.baseURL,
            accessToken: { "expired" },
            transport: transport
        )

        let output = try await client.getUserProfile()

        let body = try output.unauthorized.body.json
        #expect(body.error == .unauthenticated)
        #expect(body.reason == .principalHeaderMissing)
        #expect(body.requestId == "req-401")
        let sent = try #require(await transport.requests.first)
        #expect(sent.request.path == "/users/me")
        #expect(sent.request.method == .get)
    }

    @Test("Easy Auth's bodiless 401 throws a ClientError carrying the 401")
    func platformUnauthorized() async throws {
        // App Service Authentication answers 401 itself, with no body, before
        // the API runs. The spec's 401 declares a JSON body, so the generated
        // client cannot build `.unauthorized` and throws; the status is on the
        // error's response.
        let transport = FakeTransport(response: .init(status: .unauthorized, body: nil))
        let client = APIClientFactory.makeClient(
            baseURL: Self.baseURL,
            accessToken: { "expired" },
            transport: transport
        )

        let error = await #expect(throws: ClientError.self) { _ = try await client.getUserProfile() }
        #expect(error?.response?.status == .unauthorized)
    }
}

@Suite("SignalR messages")
struct SignalRMessageTests {
    @Test("a temperature message decodes, with absent and null probes as nil")
    func temperatureMessage() throws {
        let message = try APIClientFactory.makeJSONDecoder().decode(
            Components.Schemas.TemperatureMessage.self,
            from: Fixtures.temperatureMessage
        )

        #expect(message.deviceId == "meatgeek3")
        #expect(message.timestamp == "2026-11-20T15:00:00.000Z")
        #expect(message.enqueuedTimeUtc == Date(timeIntervalSince1970: 1_795_186_800.5))
        #expect(message.cookId == "cook-7")
        #expect(message.grillTemp == 225.5)
        #expect(message.probe1Temp == 140)
        #expect(message.probe2Temp == nil) // null
        #expect(message.probe3Temp == nil) // absent
        #expect(message.probe4Temp == nil) // absent
    }

    @Test("a date without fractional seconds decodes too")
    func wholeSecondDate() throws {
        let message = try APIClientFactory.makeJSONDecoder().decode(
            Components.Schemas.TemperatureMessage.self,
            from: Data(#"{"deviceId":"meatgeek3","timestamp":"t","enqueuedTimeUtc":"2026-11-20T15:00:00Z"}"#.utf8)
        )
        #expect(message.enqueuedTimeUtc == Date(timeIntervalSince1970: 1_795_186_800))
        #expect(message.grillTemp == nil)
    }

    @Test("a temperature message with a field the spec lacks is rejected")
    func unknownField() {
        // TemperatureMessage has additionalProperties: false.
        #expect(throws: DecodingError.self) {
            try APIClientFactory.makeJSONDecoder().decode(
                Components.Schemas.TemperatureMessage.self,
                from: Data(
                    #"{"deviceId":"d","timestamp":"t","enqueuedTimeUtc":"2026-11-20T15:00:00Z","extra":1}"#.utf8
                )
            )
        }
    }

    @Test("the hub message and negotiate schemas are generated")
    func generatedTypes() {
        // Compile-time: each `x-signalr` message and the negotiate response is
        // a generated type. Later issues decode hub messages with them.
        let types: [any Decodable.Type] = [
            Components.Schemas.TemperatureMessage.self,
            Components.Schemas.CookStartedMessage.self,
            Components.Schemas.CookStoppedMessage.self,
            Components.Schemas.SignalRConnectionInfo.self,
        ]
        #expect(types.count == 4)
    }
}

// MARK: - Fakes

/// A `ClientTransport` that records each request and answers with one canned
/// response. Never touches the network.
actor FakeTransport: ClientTransport {
    struct Sent: Sendable {
        let request: HTTPRequest
        let baseURL: URL
        let operationID: String
    }

    struct Response: Sendable {
        let status: HTTPResponse.Status
        let contentType: String?
        let body: Data?

        init(status: HTTPResponse.Status, contentType: String? = nil, body: Data?) {
            self.status = status
            self.contentType = contentType
            self.body = body
        }

        static func json(status: HTTPResponse.Status, _ body: Data) -> Self {
            .init(status: status, contentType: "application/json", body: body)
        }
    }

    private(set) var requests: [Sent] = []
    private let response: Response

    init(response: Response) {
        self.response = response
    }

    func send(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String
    ) async throws -> (HTTPResponse, HTTPBody?) {
        requests.append(Sent(request: request, baseURL: baseURL, operationID: operationID))
        var headers = HTTPFields()
        if let contentType = response.contentType { headers[.contentType] = contentType }
        return (
            HTTPResponse(status: response.status, headerFields: headers),
            response.body.map { HTTPBody($0) }
        )
    }
}

/// Hands out the given tokens in order.
actor TokenSequence {
    private var tokens: [String]

    init(_ tokens: [String]) {
        self.tokens = tokens
    }

    func next() throws -> String {
        guard !tokens.isEmpty else { throw TokenUnavailable() }
        return tokens.removeFirst()
    }
}

struct TokenUnavailable: Error {}

/// Bodies as the API sends them.
enum Fixtures {
    /// GET /devices: `BRISKET_BOX` and `OFFSET` from apps/web/src/test/fakes.ts,
    /// with the `connection` block the API adds.
    static let deviceList = Data(
        #"""
        {
          "devices": [
            {
              "id": "meatgeek3",
              "userId": "tid:oid",
              "name": "Brisket Box",
              "model": "MeatGeek V1",
              "location": "Backyard",
              "isActive": true,
              "connection": { "state": "connected", "lastActivityAt": "2026-11-20T15:00:00.500Z" }
            },
            {
              "id": "offset-1",
              "userId": "tid:oid",
              "name": "Offset",
              "model": "MeatGeek V1",
              "isActive": true,
              "connection": { "state": "unknown", "lastActivityAt": null }
            }
          ]
        }
        """#.utf8
    )

    /// The handler's 401 (apps/api/src/shared/auth/principal.ts).
    static let unauthenticated = Data(
        #"{"error":"UNAUTHENTICATED","reason":"principal_header_missing","requestId":"req-401"}"#.utf8
    )

    /// A `temperature` hub message as broadcast-temperature.ts builds it
    /// (apps/api/src/functions/signalr/broadcast-temperature.spec.ts), with
    /// probe 2 null and probes 3 and 4 absent.
    static let temperatureMessage = Data(
        #"""
        {
          "deviceId": "meatgeek3",
          "timestamp": "2026-11-20T15:00:00.000Z",
          "cookId": "cook-7",
          "grillTemp": 225.5,
          "probe1Temp": 140,
          "probe2Temp": null,
          "enqueuedTimeUtc": "2026-11-20T15:00:00.500Z"
        }
        """#.utf8
    )
}
