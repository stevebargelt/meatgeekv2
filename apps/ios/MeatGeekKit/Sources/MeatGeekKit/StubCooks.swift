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
/// - `GET /cooks/{id}/chart`: a seeded cook's 6 h in 1-minute buckets (grill,
///   probe 1, and probe 2 with gaps: unplugged for its first 10 minutes and
///   from 2:00 to 2:45); `noChartCookID` is 404; `failsOnceCookID` answers
///   500 the first time, so Retry can be seen. A started cook's chart is
///   empty while it is active (the live readings append on screen) and, once
///   stopped, buckets the readings `StubLive` pushed for its device.
///
/// Every timestamp comes from `now`.
public actor StubCooks {
    public static let seededCount = 24
    /// The newest seeded cook, on `StubDevices.connectedID`.
    public static let newestSeededName = "Seeded cook 1"
    static let maxLimit = 100
    /// A seeded cook the chart route answers 404 for: "Chart not available".
    public static let noChartCookID = "seeded-cook-2"
    /// A seeded cook whose first chart request answers 500; later ones 200.
    public static let failsOnceCookID = "seeded-cook-3"
    /// A seeded cook's chart buckets.
    public static let seededBucketSeconds = CookChart.BucketSecondsPayload._60

    private let now: @Sendable () -> Date
    private let devices: StubDevices
    /// Newest first.
    private var cooks: [Cook]
    /// Each started cook's request, to tell a replay from a reused id.
    private var requests: [String: Components.Schemas.StartCookRequest] = [:]
    /// The readings pushed for each device, for a stopped cook's chart.
    private var readings: [String: [(at: Date, message: TemperatureMessage)]] = [:]
    private var chartFailed = false

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

    /// `PUT /cooks/{cookId}/targets`: the body's targets replace the cook's,
    /// and a channel whose target changed loses its reached mark, as the API
    /// does. A cook that is not running is 409 COOK_NOT_ACTIVE.
    public func updateTargets(_ input: Operations.UpdateCookTargets.Input) -> Operations.UpdateCookTargets.Output {
        guard case .json(let request) = input.body else { return .undocumented(statusCode: 415, .init()) }
        guard let index = cooks.firstIndex(where: { $0.id == input.path.cookId }) else {
            return .notFound(.init(body: .json(error(.notFound, "Cook not found"))))
        }
        guard cooks[index].status == .active else {
            return .conflict(.init(body: .json(error(.cookNotActive, "Targets can be changed only on a running cook"))))
        }
        let new = request.targetTemps
        let targets = Components.Schemas.TargetTemperatures(
            grill: new.grill, probe1: new.probe1, probe2: new.probe2, probe3: new.probe3, probe4: new.probe4
        )
        let old = cooks[index].targetTemps
        if var reached = cooks[index].targetsReached {
            for key in TargetKey.allCases where key.value(in: old) != key.value(in: targets) {
                switch key {
                case .grill: reached.grill = nil
                case .probe1: reached.probe1 = nil
                case .probe2: reached.probe2 = nil
                case .probe3: reached.probe3 = nil
                case .probe4: reached.probe4 = nil
                }
            }
            let none = TargetKey.allCases.allSatisfy { key in
                switch key {
                case .grill: reached.grill == nil
                case .probe1: reached.probe1 == nil
                case .probe2: reached.probe2 == nil
                case .probe3: reached.probe3 == nil
                case .probe4: reached.probe4 == nil
                }
            }
            cooks[index].targetsReached = none ? nil : reached
        }
        let any = TargetKey.allCases.contains { $0.value(in: targets) != nil }
        cooks[index].targetTemps = any ? targets : nil
        return .ok(.init(body: .json(cooks[index])))
    }

    /// `GET /cooks/{cookId}/chart`.
    public func chart(_ input: Operations.GetCookChart.Input) -> Operations.GetCookChart.Output {
        let id = input.path.cookId
        guard let cook = cooks.first(where: { $0.id == id }), id != Self.noChartCookID else {
            return .notFound(.init(body: .json(error(.notFound, "Cook not found"))))
        }
        if id == Self.failsOnceCookID, !chartFailed {
            chartFailed = true
            return .internalServerError(.init(body: .json(error(.internalServerError, "Internal server error"))))
        }
        let points: [Components.Schemas.CookChartPoint]
        if id.hasPrefix("seeded-cook-") {
            points = Self.seededPoints(from: cook.startTime)
        } else if cook.status == .active {
            points = []
        } else {
            points = bucketed(cook)
        }
        return .ok(.init(body: .json(CookChart(
            cookId: cook.id,
            deviceId: cook.deviceId,
            startTime: cook.startTime,
            endTime: cook.endTime,
            bucketSeconds: Self.seededBucketSeconds,
            points: points
        ))))
    }

    /// A reading `StubLive` pushed.
    public func record(_ message: TemperatureMessage, at: Date) {
        readings[message.deviceId, default: []].append((at, message))
    }

    /// A seeded cook's 360 one-minute buckets: grill around 225 °F, probe 1
    /// rising towards 200 °F, probe 2 rising more slowly with two gaps.
    static func seededPoints(from start: Date) -> [Components.Schemas.CookChartPoint] {
        func channel(_ avg: Double, spread: Double) -> Components.Schemas.CookChartChannel {
            func round(_ value: Double) -> Double { (value * 10).rounded() / 10 }
            return .init(min: round(avg - spread), max: round(avg + spread), avg: round(avg))
        }
        return (0..<360).map { minute in
            let m = Double(minute)
            let probe2Unplugged = minute < 10 || (120..<165).contains(minute)
            return .init(
                t: start.addingTimeInterval(m * 60),
                grill: channel(225 + 10 * sin(m / 20), spread: 4),
                probe1: channel(40 + 160 * (1 - exp(-m / 120)), spread: 0.5),
                probe2: probe2Unplugged ? nil : channel(38 + 150 * (1 - exp(-m / 150)), spread: 0.5)
            )
        }
    }

    /// The readings pushed for `cook`'s device from its start to the end of
    /// the minute it ended in, in one-minute buckets from the start of the
    /// first minute. (The API stops at `endTime` itself; UI test mode's clock
    /// stands still, so a cook can end in the very instant of its readings.)
    private func bucketed(_ cook: Cook) -> [Components.Schemas.CookChartPoint] {
        let bucket = TimeInterval(Self.seededBucketSeconds.rawValue)
        let first = (cook.startTime.timeIntervalSince1970 / bucket).rounded(.down) * bucket
        let end = cook.endTime.map {
            Date(timeIntervalSince1970: (($0.timeIntervalSince1970 / bucket).rounded(.down) + 1) * bucket)
        } ?? .distantFuture
        var buckets: [Int: [TemperatureMessage]] = [:]
        for (at, message) in readings[cook.deviceId] ?? [] where at >= cook.startTime && at < end {
            buckets[Int(((at.timeIntervalSince1970 - first) / bucket).rounded(.down)), default: []].append(message)
        }
        func channel(_ values: [Double]) -> Components.Schemas.CookChartChannel? {
            guard let low = values.min(), let high = values.max() else { return nil }
            return .init(min: low, max: high, avg: values.reduce(0, +) / Double(values.count))
        }
        return buckets.keys.sorted().map { k in
            let messages = buckets[k] ?? []
            return .init(
                t: Date(timeIntervalSince1970: first + Double(k) * bucket),
                grill: channel(messages.compactMap(\.grillTemp)),
                probe1: channel(messages.compactMap(\.probe1Temp)),
                probe2: channel(messages.compactMap(\.probe2Temp)),
                probe3: channel(messages.compactMap(\.probe3Temp)),
                probe4: channel(messages.compactMap(\.probe4Temp))
            )
        }
    }

    /// The devices that have an active cook: where `StubLive` pushes readings.
    public func activeDeviceIDs() -> [String] {
        cooks.filter { $0.status == .active }.map(\.deviceId)
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
