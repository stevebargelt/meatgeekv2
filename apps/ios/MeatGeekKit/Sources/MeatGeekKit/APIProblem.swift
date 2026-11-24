import Foundation
public import MeatGeekAPI

/// What a screen shows when an API call fails: the API's message (or one the
/// screen chose for that status), and the request id a user can quote to
/// support. Mirrors `ApiProblem` in apps/web/src/api/problem.ts.
///
/// A 401 is never shown as a problem: the models hand it to
/// `SessionModel.endSession()` (a documented `.unauthorized`) or let
/// `SessionModel.perform(_:)` end the session (Easy Auth's bodiless 401).
public struct APIProblem: Error, Equatable, Sendable {
    /// The HTTP status, when the API answered.
    public var status: Int?
    /// The body's `error` code (`ErrorCode`), e.g. "CLAIM_REFUSED".
    public var code: String?
    public var message: String
    /// The body's `requestId`.
    public var requestID: String?

    public init(status: Int? = nil, code: String? = nil, message: String, requestID: String? = nil) {
        self.status = status
        self.code = code
        self.message = message
        self.requestID = requestID
    }

    /// From an answer with `status` and, when it had one, its error body.
    /// Without a body the message says the status, as the web app does.
    public init(status: Int, body: (any ProblemBody)?) {
        self.init(
            status: status,
            code: body?.problemCode,
            message: body?.problemMessage ?? "The request failed with HTTP \(status).",
            requestID: body?.problemRequestID
        )
    }

    /// From a thrown error: no answer (offline, a token failure) or a body
    /// that did not decode.
    public init(error: any Error) {
        if let problem = error as? APIProblem {
            self = problem
        } else {
            self.init(message: SessionModel.describe(error))
        }
    }

    /// The same problem with another message (a screen's own words for a
    /// status), keeping the status, code and request id.
    public func with(message: String) -> APIProblem {
        var copy = self
        copy.message = message
        return copy
    }

    /// The line a screen shows: the message, then "Request ID: <id>" when
    /// known (apps/web/src/api/problem-message.tsx).
    public var text: String {
        guard let requestID else { return message }
        return "\(message) Request ID: \(requestID)"
    }
}

/// An API error body: `ErrorResponse` and its variants that add fields.
public protocol ProblemBody: Sendable {
    var problemCode: String { get }
    var problemMessage: String { get }
    var problemRequestID: String { get }
}

extension Components.Schemas.ErrorResponse: ProblemBody {
    public var problemCode: String { error.rawValue }
    public var problemMessage: String { message }
    public var problemRequestID: String { requestId }
}

extension Components.Schemas.DeviceClaimTwinFailedError: ProblemBody {
    public var problemCode: String { error.rawValue }
    public var problemMessage: String { message }
    public var problemRequestID: String { requestId }
}
