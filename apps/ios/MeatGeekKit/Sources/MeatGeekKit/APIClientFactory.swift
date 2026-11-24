import Foundation
import HTTPTypes
public import MeatGeekAPI
public import OpenAPIRuntime
import OpenAPIURLSession

/// Supplies the bearer token for each API request: an Entra ID access token
/// for the API's audience. Called once per request, so it can refresh.
public typealias AccessTokenProvider = @Sendable () async throws -> String

/// Builds the generated API client (`MeatGeekAPI.Client`).
///
/// Every request it sends carries `Authorization: Bearer <token>` from
/// `accessToken`. The operations and their types are generated from the
/// OpenAPI contract (see apps/ios/README.md, "API client"); nothing here
/// knows a route.
public enum APIClientFactory {
    /// A client for the API at `baseURL` (the spec's server URL: the API's
    /// origin plus `/api`).
    ///
    /// - Parameters:
    ///   - baseURL: e.g. `https://<app>.azurewebsites.net/api`.
    ///   - accessToken: called before each request for the bearer token.
    ///   - transport: how requests are sent; URLSession unless a test passes
    ///     its own.
    public static func makeClient(
        baseURL: URL,
        accessToken: @escaping AccessTokenProvider,
        transport: any ClientTransport = URLSessionTransport()
    ) -> Client {
        Client(
            serverURL: baseURL,
            configuration: configuration,
            transport: transport,
            middlewares: [BearerTokenMiddleware(accessToken: accessToken)]
        )
    }

    /// A client whose bearer token comes from `tokenProvider.accessToken()`.
    /// When the provider throws `TokenProviderError.signInRequired`, the call
    /// throws a `ClientError` wrapping it and sends nothing;
    /// `SessionModel.perform(_:)` turns that into a signed-out session.
    public static func makeClient(
        baseURL: URL,
        tokenProvider: any TokenProvider,
        transport: any ClientTransport = URLSessionTransport()
    ) -> Client {
        makeClient(
            baseURL: baseURL,
            accessToken: { try await tokenProvider.accessToken() },
            transport: transport
        )
    }
}

extension APIClientFactory {
    /// The generated client's configuration: dates as the API writes them.
    public static let configuration = Configuration(dateTranscoder: APIDateTranscoder())

    /// A JSON decoder for API bodies that do not arrive through the client,
    /// such as SignalR hub messages (`Components.Schemas.TemperatureMessage`
    /// and the others listed under `x-signalr`). Decodes dates as the client does.
    public static func makeJSONDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        let transcoder = APIDateTranscoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            return try transcoder.decode(try container.decode(String.self))
        }
        return decoder
    }
}

/// ISO-8601 dates as the API writes them. The API writes JavaScript's
/// `Date.toISOString()` (`2026-11-20T15:00:00.500Z`), which the runtime's
/// default `.iso8601` transcoder rejects because of the fractional seconds;
/// this one reads a date with or without them and writes them.
public struct APIDateTranscoder: DateTranscoder {
    private let fractional = ISO8601DateTranscoder.iso8601WithFractionalSeconds
    private let whole = ISO8601DateTranscoder.iso8601

    public init() {}

    public func encode(_ date: Date) throws -> String {
        try fractional.encode(date)
    }

    public func decode(_ string: String) throws -> Date {
        if let date = try? fractional.decode(string) { return date }
        return try whole.decode(string)
    }
}

/// Sets `Authorization: Bearer <token>` on every request, replacing any
/// Authorization header already there. If `accessToken` throws, the request
/// is not sent and the call throws (as a `ClientError` wrapping the error).
public struct BearerTokenMiddleware: ClientMiddleware {
    private let accessToken: AccessTokenProvider

    public init(accessToken: @escaping AccessTokenProvider) {
        self.accessToken = accessToken
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let token = try await accessToken()
        var request = request
        request.headerFields[.authorization] = "Bearer \(token)"
        return try await next(request, body, baseURL)
    }
}
