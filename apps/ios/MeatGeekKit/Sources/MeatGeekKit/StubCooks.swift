import Foundation
public import MeatGeekAPI

/// The cooks UI test mode serves, held in memory for one launch of the app.
/// Behaves like the API's cook routes for the cases the UI tests drive
/// (apps/api/src/functions/cooks):
///
/// - a seeded history of `seededCount` completed cooks across both seeded
///   devices, one a day going back from `now`, so the list has more than one
///   page;
/// - `GET /cooks` newest first, paged by an opaque continuation token, with
///   the `deviceId` and `status` filters;
/// - `POST /cooks` makes an active cook on a device the user owns, which the
///   devices' active-cook lookup then returns; a second start on the same
///   device is 409 COOK_ALREADY_ACTIVE naming it; the same id and body again
///   is a 200 replay;
/// - `POST /cooks/{id}/stop` completes it; `GET /cooks/{id}` for an unknown
///   id is 404.
///
/// Every timestamp comes from `now`.
public actor StubCooks {
    public static let seededCount = 24
    /// The newest seeded cook, on `StubDevices.connectedID`.
    public static let newestSeededName = "Seeded cook 1"
    static let maxLimit = 100

    private let now: @Sendable () -> Date
    private let devices: StubDevices
    /// Newest first.
    private var cooks: [Cook]
    /// Each started cook's request, to tell a replay from a reused id.
    private var requests: [String: Components.Schemas.StartCookRequest] = [:]

    public init(now: @escaping @Sendable () -> Date, devices: StubDevices) {
        self.now = now
        self.devices = devices
        let at = now()
        cooks = (1...Self.seededCount).map { n in
            let start = at.addingTimeInterval(-Double(n) * 86_400)
            return Cook(
                id: "seeded-cook-\(n)",
                userId: StubDevices.userID,
                deviceId: n.isMultiple(of: 2) ? StubDevices.neverHeardID : StubDevices.connectedID,
                name: "Seeded cook \(n)",
                status: .completed,
                startTime: start,
                endTime: start.addingTimeInterval(6 * 3600),
                meatType: n.isMultiple(of: 3) ? "pork" : "brisket",
                weight: 10,
                targetTemps: .init(grill: 225, probe1: 203)
            )
        }
    }

    /// `GET /cooks`. The continuation token is the index of the next cook in
    /// the filtered list; the API's is opaque, and so is this one to the app.
    public func list(_ input: Operations.ListCooks.Input) -> Operations.ListCooks.Output {
        let query = input.query
        let limit = min(Self.maxLimit, max(1, query.limit ?? 20))
        let matching = cooks.filter { cook in
            (query.deviceId == nil || query.deviceId == cook.deviceId)
                && (query.status == nil || query.status == cook.status)
        }
        var offset = 0
        if let token = query.continuationToken {
            guard let parsed = Self.offset(token), parsed <= matching.count else {
                return .internalServerError(.init(body: .json(error(.internalServerError, "Internal server error"))))
            }
            offset = parsed
        }
        let end = min(matching.count, offset + limit)
        let hasMore = end < matching.count
        return .ok(.init(body: .json(.init(
            cooks: Array(matching[offset..<end]),
            limit: limit,
            hasMore: hasMore,
            continuationToken: hasMore ? Self.token(end) : nil
        ))))
    }

    /// `POST /cooks`.
    public func start(_ input: Operations.StartCook.Input) async -> Operations.StartCook.Output {
        guard case .json(let request) = input.body else { return .undocumented(statusCode: 415, .init()) }
        if let existing = cooks.first(where: { $0.id == request.id }) {
            return requests[request.id] == request
                ? .ok(.init(body: .json(existing)))
                : .unprocessableContent(.init(body: .json(error(.cookIdReused, "Cook id reused with a different body"))))
        }
        guard await devices.owns(request.deviceId) else {
            return .forbidden(.init(body: .json(error(.deviceNotOwned, "Device not owned"))))
        }
        if let active = cooks.first(where: { $0.deviceId == request.deviceId && $0.status == .active }) {
            return .conflict(.init(body: .json(.init(
                error: .cookAlreadyActive,
                message: "Device already has an active cook",
                requestId: StubDevices.requestID,
                activeCookId: active.id
            ))))
        }
        let cook = Cook(
            id: request.id,
            userId: StubDevices.userID,
            deviceId: request.deviceId,
            name: request.name,
            status: .active,
            startTime: now(),
            meatType: request.meatType,
            weight: request.weight,
            targetTemps: request.targetTemps.map {
                .init(grill: $0.grill, probe1: $0.probe1, probe2: $0.probe2, probe3: $0.probe3, probe4: $0.probe4)
            },
            notes: request.notes
        )
        cooks.insert(cook, at: 0)
        requests[request.id] = request
        return .created(.init(body: .json(cook)))
    }

    /// `GET /cooks/{cookId}`.
    public func get(_ input: Operations.GetCook.Input) -> Operations.GetCook.Output {
        guard let cook = cooks.first(where: { $0.id == input.path.cookId }) else {
            return .notFound(.init(body: .json(error(.notFound, "Cook not found"))))
        }
        return .ok(.init(body: .json(cook)))
    }

    /// `POST /cooks/{cookId}/stop`. Stopping a completed cook returns it again.
    public func stop(_ input: Operations.StopCook.Input) -> Operations.StopCook.Output {
        guard let index = cooks.firstIndex(where: { $0.id == input.path.cookId }) else {
            return .notFound(.init(body: .json(error(.notFound, "Cook not found"))))
        }
        if cooks[index].status == .active {
            cooks[index].status = .completed
            cooks[index].endTime = now()
        }
        return .ok(.init(body: .json(cooks[index])))
    }

    static func token(_ offset: Int) -> String { "stub-offset-\(offset)" }

    static func offset(_ token: String) -> Int? {
        guard token.hasPrefix("stub-offset-") else { return nil }
        return Int(token.dropFirst("stub-offset-".count))
    }

    private func error(_ code: Components.Schemas.ErrorCode, _ message: String) -> Components.Schemas.ErrorResponse {
        .init(error: code, message: message, requestId: StubDevices.requestID)
    }
}
