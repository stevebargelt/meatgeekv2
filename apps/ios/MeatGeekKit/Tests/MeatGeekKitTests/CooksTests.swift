import Foundation
import MeatGeekAPI
import Testing
@testable import MeatGeekKit

/// The cooks screens' logic, on `StubAPI` and a fixed clock. Mirrors the web
/// app's specs in apps/web/src/cooks. Every step is awaited; no test reads
/// the wall clock.

// MARK: - Validation and text

@Suite("Start cook validation and request")
struct CookValidationTests {
    nonisolated static let id = "0b6f1d2e-6a51-4c3e-9f6e-8a1d2c3b4a5f"

    @Test("a minimal valid input passes")
    func minimal() {
        #expect(CookValidation.validate(StartCookInput(name: "Ribs", meatType: "pork")).isEmpty)
    }

    @Test("every message: required, too long, weight and each target's range, non-numeric")
    func messages() {
        let errors = CookValidation.validate(StartCookInput(
            name: " ",
            meatType: String(repeating: "x", count: 101),
            weight: "1000.5",
            targets: [.grill: "-1", .probe1: "hot", .probe2: "1000", .probe3: "0", .probe4: "1000.01"]
        ))
        #expect(errors == StartCookFieldErrors(
            name: "Name is required.",
            meatType: "Meat type must be at most 100 characters.",
            weight: "Weight must be a number greater than 0 and at most 1000.",
            targets: [
                .grill: "Grill target must be a number from 0 to 1000.",
                .probe1: "Probe 1 target must be a number from 0 to 1000.",
                .probe4: "Probe 4 target must be a number from 0 to 1000.",
            ]
        ))
        #expect(CookValidation.validate(StartCookInput()) == StartCookFieldErrors(
            name: "Name is required.", meatType: "Meat type is required."
        ))
    }

    @Test("weight: greater than 0 and at most 1000, and a number", arguments: [
        ("0", false), ("-1", false), ("0.01", true), ("1000", true), ("1000.001", false),
        ("abc", false), ("12lb", false), ("inf", false), ("nan", false), (" 4.25 ", true), ("", true),
    ])
    func weight(value: String, valid: Bool) {
        let errors = CookValidation.validate(StartCookInput(name: "a", meatType: "b", weight: value))
        #expect(errors.weight == (valid ? nil : CookValidation.weightMessage))
    }

    @Test("targets: 0 to 1000; anything but a finite number is rejected", arguments: TargetKey.allCases)
    func target(key: TargetKey) {
        for (value, valid) in [("0", true), ("1000", true), ("225.5", true), ("-0.1", false), ("1001", false),
                               ("hot", false), ("1,000", false), ("  ", true)] {
            let errors = CookValidation.validate(StartCookInput(name: "a", meatType: "b", targets: [key: value]))
            #expect(errors.targets[key] == (valid ? nil : CookValidation.targetMessage(key)), "\(key) \(value)")
        }
    }

    @Test("the labels are TARGET_LABELS")
    func labels() {
        #expect(TargetKey.allCases.map(\.label)
            == ["Grill target", "Probe 1 target", "Probe 2 target", "Probe 3 target", "Probe 4 target"])
        #expect(TargetKey.allCases.map(\.rawValue) == ["grill", "probe1", "probe2", "probe3", "probe4"])
    }

    @Test("the body: trimmed text, parsed numbers, blank fields left out")
    func request() {
        let body = CookValidation.request(id: Self.id, deviceID: "meatgeek3", input: StartCookInput(
            name: " Ribs ", meatType: " pork", weight: " 4.25 ", targets: [.probe3: "195", .grill: " "]
        ))
        #expect(body == Components.Schemas.StartCookRequest(
            id: Self.id, name: "Ribs", deviceId: "meatgeek3", meatType: "pork", weight: 4.25,
            targetTemps: .init(probe3: 195)
        ))
    }

    @Test("no targets at all: no targetTemps; no weight: no weight")
    func blanks() {
        let body = CookValidation.request(id: Self.id, deviceID: "d", input: StartCookInput(
            name: "a", meatType: "b", targets: [.grill: "", .probe1: "  "]
        ))
        #expect(body.targetTemps == nil)
        #expect(body.weight == nil)
        #expect(body.notes == nil)
    }
}

@Suite("Cook text")
struct CookTextTests {
    @Test("elapsed is H:MM:SS and never negative", arguments: [
        (0.0, "0:00:00"), (3_723.999, "1:02:03"), (30.0 * 3600, "30:00:00"), (-5.0, "0:00:00"), (59.9, "0:00:59"),
    ])
    func elapsed(seconds: Double, text: String) {
        #expect(CookText.elapsed(seconds) == text)
    }

    @Test("status, temperature and weight")
    func words() {
        #expect(CookText.status(.active) == "Active")
        #expect(CookText.status(.completed) == "Completed")
        #expect(CookText.temperature(225) == "225 °F")
        #expect(CookText.temperature(202.5) == "202.5 °F")
        #expect(CookText.weight(4.25) == "4.25 lb")
        #expect(CookText.weight(10) == "10 lb")
    }

    @Test("a date and time in the given locale and time zone")
    func dateTime() {
        let text = CookText.dateTime(fixedNow, locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "UTC")!)
        #expect(text.contains("Nov 22, 2026"))
        #expect(text.contains("6:00"))
    }
}

// MARK: - Fixtures

/// Records values from any task.
final class Recorder<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Value] = []
    func record(_ value: Value) { lock.withLock { values.append(value) } }
    var all: [Value] { lock.withLock { values } }
}

/// Holds a value a test changes between calls.
final class Box<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

enum CookFixtures {
    typealias Query = Operations.ListCooks.Input.Query

    static func cook(
        _ id: String, device: String = "box", status: Components.Schemas.CookStatus = .completed,
        name: String? = nil, started: Date = before(7200)
    ) -> Cook {
        Cook(
            id: id, userId: "tid:oid", deviceId: device, name: name ?? "Cook \(id)", status: status,
            startTime: started, endTime: status == .active ? nil : started.addingTimeInterval(3600), meatType: "pork"
        )
    }

    static func page(_ cooks: [Cook], token: String? = nil) -> Operations.ListCooks.Output {
        .ok(.init(body: .json(.init(cooks: cooks, limit: 20, hasMore: token != nil, continuationToken: token))))
    }

    static func error(_ code: Components.Schemas.ErrorCode, _ message: String, _ requestID: String = "req-1")
        -> Components.Schemas.ErrorResponse {
        .init(error: code, message: message, requestId: requestID)
    }

    /// A stub whose devices are box and kettle, whose active-cook lookup
    /// (`status=active&limit=100`) answers `active`, and whose cook list
    /// answers `list(query)`, recording the list's queries.
    static func api(
        queries: Recorder<Query> = Recorder(),
        active: [Cook] = [],
        list: @escaping @Sendable (Query) async -> Operations.ListCooks.Output = { _ in page([]) }
    ) -> StubAPI {
        var api = StubAPI()
        api.getDevicesHandler = { _ in .ok(.init(body: .json(.init(devices: [DeviceFixtures.box, DeviceFixtures.kettle])))) }
        api.listCooksHandler = { input in
            if input.query.status == .active && input.query.limit == 100 {
                return .ok(.init(body: .json(.init(cooks: active, limit: 100, hasMore: false))))
            }
            queries.record(input.query)
            return await list(input.query)
        }
        return api
    }

    /// A signed-in session over `api` with its devices read, and a cooks
    /// model on `fixedNow` that has not started.
    @MainActor
    static func models(_ api: StubAPI) async -> (SessionModel, DevicesModel, CooksModel) {
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let devices = DevicesModel(session: session, now: { fixedNow })
        await devices.start()
        return (session, devices, CooksModel(devices: devices, now: { fixedNow }))
    }
}

/// Lets a test hold a stub call until it says so, and know it has started.
final class Gate: @unchecked Sendable {
    private let entered: AsyncStream<Void>
    private let enteredContinuation: AsyncStream<Void>.Continuation
    private let released: AsyncStream<Void>
    private let releasedContinuation: AsyncStream<Void>.Continuation

    init() {
        (entered, enteredContinuation) = AsyncStream.makeStream()
        (released, releasedContinuation) = AsyncStream.makeStream()
    }

    /// In the stub: say the call started, then wait for `open()`.
    func pass() async {
        enteredContinuation.yield()
        for await _ in released { return }
    }

    /// In the test: wait until the stub call has started.
    func waitUntilEntered() async {
        for await _ in entered { return }
    }

    func open() { releasedContinuation.yield() }
}

// MARK: - CooksModel

@Suite("CooksModel")
@MainActor
struct CooksModelTests {
    typealias F = CookFixtures

    @Test("page one: GET /cooks?limit=20 with no filters or token; newest first as the API sends them")
    func firstPage() async {
        let queries = Recorder<F.Query>()
        let cooks = [F.cook("c2"), F.cook("c1", device: "kettle")]
        let (_, _, model) = await F.models(F.api(queries: queries) { _ in F.page(cooks) })
        await model.start()

        #expect(queries.all == [.init(limit: 20)])
        #expect(model.list == .loaded(cooks: cooks, continuationToken: nil, hasMore: false))
        #expect(model.deviceName(for: "box") == "Brisket Box")
        #expect(model.deviceName(for: "kettle") == "Kettle")
        #expect(model.deviceName(for: "gone") == "gone")
        await model.start()
        #expect(queries.all.count == 1)
    }

    @Test("Load more sends the previous page's token and appends; hasMore false ends it")
    func loadMore() async {
        let queries = Recorder<F.Query>()
        let first = (1...20).map { F.cook("p1-\($0)") }
        let second = [F.cook("p2-1"), F.cook("p2-2")]
        let (_, _, model) = await F.models(F.api(queries: queries) { query in
            query.continuationToken == "t1" ? F.page(second) : F.page(first, token: "t1")
        })
        await model.start()
        #expect(model.hasMore)

        await model.loadMore()

        #expect(queries.all == [.init(limit: 20), .init(limit: 20, continuationToken: "t1")])
        #expect(model.cooks.map(\.id) == first.map(\.id) + second.map(\.id))
        #expect(!model.hasMore)
        #expect(!model.loadingMore)
        await model.loadMore()
        #expect(queries.all.count == 2)
    }

    @Test("a failed Load more keeps the list and says why apart from it; trying again appends")
    func loadMoreFails() async {
        let fail = Box(true)
        let first = [F.cook("a")]
        let (_, _, model) = await F.models(F.api { query in
            guard query.continuationToken != nil else { return F.page(first, token: "t1") }
            if fail.value {
                return .internalServerError(.init(body: .json(F.error(.internalServerError, "Boom", "req-500"))))
            }
            return F.page([F.cook("b")])
        })
        await model.start()

        await model.loadMore()
        #expect(model.list == .loaded(cooks: first, continuationToken: "t1", hasMore: true))
        #expect(model.moreProblem == APIProblem(status: 500, code: "INTERNAL_SERVER_ERROR", message: "Boom", requestID: "req-500"))

        fail.value = false
        await model.loadMore()
        #expect(model.moreProblem == nil)
        #expect(model.cooks.map(\.id) == ["a", "b"])
    }

    @Test("the device and status filters go to the API as query parameters, from page one")
    func filters() async {
        let queries = Recorder<F.Query>()
        let (_, _, model) = await F.models(F.api(queries: queries) { _ in F.page([F.cook("x")], token: "t1") })
        await model.start()
        await model.loadMore()

        await model.setDeviceFilter("kettle")
        await model.setStatusFilter(.active)
        await model.setStatusFilter(.active)
        await model.clearFilters()

        #expect(queries.all == [
            .init(limit: 20),
            .init(limit: 20, continuationToken: "t1"),
            .init(deviceId: "kettle", limit: 20),
            .init(deviceId: "kettle", status: .active, limit: 20),
            .init(limit: 20),
        ])
        #expect(!model.isFiltered)
    }

    @Test("empty: the no-cooks message; filtered and empty: the filters message")
    func empty() async {
        let (_, _, model) = await F.models(F.api { _ in F.page([]) })
        await model.start()
        #expect(model.list == .loaded(cooks: [], continuationToken: nil, hasMore: false))
        #expect(model.emptyText == "You have no cooks yet. Start one from a device on the Devices tab.")
        await model.setStatusFilter(.completed)
        #expect(model.emptyText == "No cooks match these filters.")
    }

    @Test("a failed list shows the API's message and request id")
    func listFails() async {
        let (_, _, model) = await F.models(F.api { _ in
            .badRequest(.init(body: .json(F.error(.validationError, "status is invalid", "req-400"))))
        })
        await model.start()
        #expect(model.list == .failed(APIProblem(
            status: 400, code: "VALIDATION_ERROR", message: "status is invalid", requestID: "req-400"
        )))
    }

    @Test("pull to refresh starts again at page one")
    func refresh() async {
        let queries = Recorder<F.Query>()
        let (_, _, model) = await F.models(F.api(queries: queries) { query in
            query.continuationToken == nil ? F.page([F.cook("a")], token: "t1") : F.page([F.cook("b")])
        })
        await model.start()
        await model.loadMore()
        await model.refresh()
        #expect(queries.all.last == .init(limit: 20))
        #expect(model.cooks.map(\.id) == ["a"])
        #expect(model.hasMore)
    }

    @Test("a page for an old filter is dropped, not shown")
    func stalePage() async {
        let gate = Gate()
        let (_, _, model) = await F.models(F.api { query in
            if query.deviceId == nil {
                await gate.pass()
                return F.page([F.cook("all")])
            }
            return F.page([F.cook("kettle-only", device: "kettle")])
        })
        let first = Task { await model.start() }
        await gate.waitUntilEntered()

        await model.setDeviceFilter("kettle")
        gate.open()
        await first.value

        #expect(model.cooks.map(\.id) == ["kettle-only"])
    }

    @Test("a cook started or stopped while Load more waits stays when the page arrives, and is not listed twice")
    func applyDuringLoadMore() async {
        let gate = Gate()
        let running = F.cook("running", status: .active)
        let started = F.cook("new", device: "kettle", status: .active, name: "Pork butt", started: fixedNow)
        let (_, devices, model) = await F.models(F.api(active: [running]) { query in
            guard query.continuationToken == "t1" else { return F.page([running, F.cook("p1")], token: "t1") }
            await gate.pass()
            // The new cook shifted the server's pages, so page two repeats p1.
            return F.page([F.cook("p1"), F.cook("p2")])
        })
        await model.start()
        let more = Task { await model.loadMore() }
        await gate.waitUntilEntered()

        var stopped = running
        stopped.status = .completed
        stopped.endTime = fixedNow
        model.apply(stopped)
        model.apply(started)
        gate.open()
        await more.value

        #expect(model.cooks.map(\.id) == ["new", "running", "p1", "p2"])
        #expect(model.cooks.first == started)
        #expect(model.cooks[1] == stopped)
        #expect(!model.hasMore)
        #expect(!model.loadingMore)
        #expect(devices.activeCook(for: DeviceFixtures.box) == nil)
        #expect(devices.activeCook(for: DeviceFixtures.kettle) == started)
    }

    @Test("the device filter's choices: the devices, plus a filtered one that is not among them")
    func deviceOptions() async {
        let (_, _, model) = await F.models(F.api())
        #expect(model.deviceOptions.map(\.id) == ["box", "kettle"])
        await model.setDeviceFilter("released")
        #expect(model.deviceOptions == [
            .init(id: "box", name: "Brisket Box"), .init(id: "kettle", name: "Kettle"),
            .init(id: "released", name: "released"),
        ])
    }

    @Test("a started cook goes on top, a stopped one replaces it, and the devices' active cooks follow")
    func apply() async throws {
        let (_, devices, model) = await F.models(F.api { _ in F.page([F.cook("old")]) })
        await model.start()

        let started = F.cook("new", device: "kettle", status: .active, name: "Pork butt", started: fixedNow)
        model.apply(started)
        #expect(model.cooks.map(\.id) == ["new", "old"])
        #expect(devices.cookingText(for: DeviceFixtures.kettle) == "Cooking: Pork butt")
        #expect(devices.activeCook(for: DeviceFixtures.kettle) == started)

        var stopped = started
        stopped.status = .completed
        stopped.endTime = fixedNow
        model.apply(stopped)
        #expect(model.cooks.map(\.id) == ["new", "old"])
        #expect(model.cooks.first?.status == .completed)
        #expect(devices.activeCook(for: DeviceFixtures.kettle) == nil)
    }

    @Test("a changed cook that no longer matches the filters leaves the list; one that never did stays out")
    func applyFiltered() async {
        let active = F.cook("a", status: .active)
        let (_, _, model) = await F.models(F.api { _ in F.page([active]) })
        await model.setStatusFilter(.active)

        model.apply(F.cook("other", device: "kettle", status: .completed))
        #expect(model.cooks.map(\.id) == ["a"])
        model.apply(F.cook("a", status: .completed))
        #expect(model.cooks.isEmpty)
    }

    @Test("a 401 on the list signs the session out")
    func unauthorized() async {
        let (session, _, model) = await F.models(F.api { _ in .unauthorized(DeviceFixtures.unauthorized) })
        await model.start()
        #expect(session.state == DeviceFixtures.ended)
        #expect(model.list == .loading)
    }

    @Test("a 401 on Load more signs the session out and shows no problem")
    func loadMoreUnauthorized() async {
        let (session, _, model) = await F.models(F.api { query in
            query.continuationToken == nil ? F.page([F.cook("a")], token: "t1") : .unauthorized(DeviceFixtures.unauthorized)
        })
        await model.start()
        await model.loadMore()
        #expect(session.state == DeviceFixtures.ended)
        #expect(model.moreProblem == nil)
    }
}

// MARK: - StartCookModel

@Suite("StartCookModel")
@MainActor
struct StartCookModelTests {
    typealias F = CookFixtures
    nonisolated static let id = "0b6f1d2e-6a51-4c3e-9f6e-8a1d2c3b4a5f"

    static func api(
        bodies: Recorder<Components.Schemas.StartCookRequest>,
        answer: @escaping @Sendable (Components.Schemas.StartCookRequest) -> Operations.StartCook.Output
    ) -> StubAPI {
        var api = F.api { _ in F.page([F.cook("old")]) }
        api.startCookHandler = { input in
            guard case .json(let body) = input.body else { return .undocumented(statusCode: 415, .init()) }
            bodies.record(body)
            return answer(body)
        }
        return api
    }

    nonisolated static func created(_ body: Components.Schemas.StartCookRequest) -> Cook {
        Cook(
            id: body.id, userId: "tid:oid", deviceId: body.deviceId, name: body.name, status: .active,
            startTime: fixedNow, meatType: body.meatType
        )
    }

    static func form(_ api: StubAPI, device: Device = DeviceFixtures.box) async -> (SessionModel, DevicesModel, CooksModel, StartCookModel) {
        let (session, devices, cooks) = await F.models(api)
        await cooks.start()
        return (session, devices, cooks, StartCookModel(device: device, cooks: cooks) { Self.id })
    }

    @Test("checks the fields before posting")
    func validation() async {
        let bodies = Recorder<Components.Schemas.StartCookRequest>()
        let (_, _, _, form) = await Self.form(Self.api(bodies: bodies) { .created(.init(body: .json(Self.created($0)))) })
        form.input = StartCookInput(name: " ", meatType: "pork", weight: "0")
        #expect(await form.submit() == nil)
        #expect(form.fieldErrors == StartCookFieldErrors(
            name: "Name is required.", weight: "Weight must be a number greater than 0 and at most 1000."
        ))
        #expect(bodies.all.isEmpty)
    }

    @Test("201: posts the form with the intent's id, blank targets left out; the lists have the cook", arguments: [201, 200])
    func starts(status: Int) async throws {
        let bodies = Recorder<Components.Schemas.StartCookRequest>()
        let (_, devices, cooks, form) = await Self.form(Self.api(bodies: bodies) { body in
            status == 201 ? .created(.init(body: .json(Self.created(body)))) : .ok(.init(body: .json(Self.created(body))))
        })
        form.input = StartCookInput(name: " Brisket ", meatType: "beef", targets: [.probe1: "203", .grill: ""])

        let cook = try #require(await form.submit())

        #expect(bodies.all == [.init(
            id: Self.id, name: "Brisket", deviceId: "box", meatType: "beef", targetTemps: .init(probe1: 203)
        )])
        #expect(cook.id == Self.id)
        #expect(form.outcome == nil)
        #expect(cooks.cooks.map(\.id) == [Self.id, "old"])
        #expect(devices.cookingText(for: DeviceFixtures.box) == "Cooking: Brisket")
    }

    @Test("the same form sends the same id every time; a new form a new one")
    func idempotencyKey() async {
        let bodies = Recorder<Components.Schemas.StartCookRequest>()
        let (_, _, cooks, _) = await Self.form(Self.api(bodies: bodies) { _ in
            .internalServerError(.init(body: .json(F.error(.internalServerError, "Boom"))))
        })
        let ids = Recorder<String>()
        let form = StartCookModel(device: DeviceFixtures.box, cooks: cooks) {
            ids.record("made")
            return "id-\(ids.all.count)"
        }
        form.input = StartCookInput(name: "a", meatType: "b")
        _ = await form.submit()
        _ = await form.submit()
        let again = StartCookModel(device: DeviceFixtures.box, cooks: cooks) { "id-new" }
        again.input = form.input
        _ = await again.submit()
        #expect(bodies.all.map(\.id) == ["id-1", "id-1", "id-new"])
        #expect(UUID(uuidString: StartCookModel(device: DeviceFixtures.box, cooks: cooks).cookID) != nil)
    }

    @Test("409 COOK_ALREADY_ACTIVE: says so and names the active cook to open")
    func alreadyActive() async {
        let (_, _, _, form) = await Self.form(Self.api(bodies: Recorder()) { _ in
            .conflict(.init(body: .json(.init(
                error: .cookAlreadyActive, message: "Device already has an active cook", requestId: "req-409",
                activeCookId: "active-1"
            ))))
        })
        form.input = StartCookInput(name: "a", meatType: "b")
        #expect(await form.submit() == nil)
        #expect(form.outcome == .alreadyActive(activeCookID: "active-1", problem: APIProblem(
            status: 409, code: "COOK_ALREADY_ACTIVE", message: "Device already has an active cook", requestID: "req-409"
        )))
        #expect(StartCookModel.alreadyActiveMessage == "This device already has an active cook.")
    }

    @Test("503 DEVICE_TWIN_UPDATE_FAILED: the cook was saved; Retry resends the same id and body")
    func twinFailed() async throws {
        let bodies = Recorder<Components.Schemas.StartCookRequest>()
        let fail = Box(true)
        let (_, _, cooks, form) = await Self.form(Self.api(bodies: bodies) { body in
            fail.value
                ? .serviceUnavailable(.init(body: .json(.init(
                    error: .deviceTwinUpdateFailed, message: "Twin update failed", cookId: body.id,
                    reason: "iothub_patch_twin_status_412", requestId: "req-503"
                ))))
                : .ok(.init(body: .json(Self.created(body))))
        })
        form.input = StartCookInput(name: "a", meatType: "b", weight: "3")
        #expect(await form.submit() == nil)
        #expect(form.outcome == .twinFailed(cookID: Self.id, problem: APIProblem(
            status: 503, code: "DEVICE_TWIN_UPDATE_FAILED", message: "Twin update failed", requestID: "req-503"
        )))
        #expect(StartCookModel.twinFailedMessage
            == "The cook was saved, but the device was not told about it. Retry to tell the device.")

        fail.value = false
        form.input.name = "changed after the 503"
        let cook = try #require(await form.retry())
        #expect(bodies.all.count == 2)
        #expect(bodies.all[0] == bodies.all[1])
        #expect(cook.name == "a")
        #expect(form.outcome == nil)
        #expect(cooks.cooks.first?.id == Self.id)
    }

    @Test("Retry does nothing unless the last answer was a 503")
    func retryOnlyAfterTwinFailure() async {
        let bodies = Recorder<Components.Schemas.StartCookRequest>()
        let (_, _, _, form) = await Self.form(Self.api(bodies: bodies) { _ in
            .forbidden(.init(body: .json(F.error(.deviceNotOwned, "Device not owned"))))
        })
        form.input = StartCookInput(name: "a", meatType: "b")
        #expect(await form.retry() == nil)
        _ = await form.submit()
        #expect(await form.retry() == nil)
        #expect(bodies.all.count == 1)
    }

    @Test("400, 403, 422 and 500 keep the API's message and request id", arguments: [
        (400, Operations.StartCook.Output.badRequest(.init(body: .json(CookFixtures.error(.validationError, "name is too long"))))),
        (403, .forbidden(.init(body: .json(CookFixtures.error(.deviceNotOwned, "Device not owned"))))),
        (422, .unprocessableContent(.init(body: .json(CookFixtures.error(.cookIdReused, "Cook id reused"))))),
        (500, .internalServerError(.init(body: .json(CookFixtures.error(.internalServerError, "Internal server error"))))),
    ])
    func refused(status: Int, answer: Operations.StartCook.Output) async throws {
        let (_, _, _, form) = await Self.form(Self.api(bodies: Recorder()) { _ in answer })
        form.input = StartCookInput(name: "a", meatType: "b")
        #expect(await form.submit() == nil)
        guard case .problem(let problem) = try #require(form.outcome) else {
            Issue.record("expected a problem, got \(String(describing: form.outcome))")
            return
        }
        #expect(problem.status == status)
        #expect(problem.requestID == "req-1")
        #expect(!problem.message.isEmpty)
    }

    @Test("a start that could not be sent says why")
    func offline() async {
        var api = Self.api(bodies: Recorder()) { _ in .undocumented(statusCode: 418, .init()) }
        api.startCookHandler = { _ in throw URLError(.notConnectedToInternet) }
        let (_, _, _, form) = await Self.form(api)
        form.input = StartCookInput(name: "a", meatType: "b")
        #expect(await form.submit() == nil)
        guard case .problem(let problem) = form.outcome else {
            Issue.record("expected a problem")
            return
        }
        #expect(problem.status == nil)
    }

    @Test("a 401 signs the session out")
    func unauthorized() async {
        let (session, _, _, form) = await Self.form(Self.api(bodies: Recorder()) { _ in
            .unauthorized(DeviceFixtures.unauthorized)
        })
        form.input = StartCookInput(name: "a", meatType: "b")
        #expect(await form.submit() == nil)
        #expect(session.state == DeviceFixtures.ended)
        #expect(form.outcome == nil)
    }
}

// MARK: - CookDetailModel

@Suite("CookDetailModel")
@MainActor
struct CookDetailModelTests {
    typealias F = CookFixtures

    nonisolated static let active = Cook(
        id: "c1", userId: "tid:oid", deviceId: "box", name: "Brisket", status: .active,
        startTime: before(3_723), meatType: "beef", weight: 12.5, targetTemps: .init(grill: 225, probe2: 203)
    )

    static func api(
        get: @escaping @Sendable (String) -> Operations.GetCook.Output = { _ in .ok(.init(body: .json(active))) },
        stop: @escaping @Sendable (String) -> Operations.StopCook.Output = { _ in
            var stopped = active
            stopped.status = .completed
            stopped.endTime = fixedNow
            return .ok(.init(body: .json(stopped)))
        }
    ) -> StubAPI {
        var api = F.api(active: [active]) { _ in F.page([active, F.cook("old")]) }
        api.getCookHandler = { input in get(input.path.cookId) }
        api.stopCookHandler = { input in stop(input.path.cookId) }
        return api
    }

    static func detail(_ api: StubAPI, id: String = "c1") async -> (SessionModel, DevicesModel, CooksModel, CookDetailModel) {
        let (session, devices, cooks) = await F.models(api)
        await cooks.start()
        let model = CookDetailModel(cookID: id, cooks: cooks)
        await model.start()
        return (session, devices, cooks, model)
    }

    @Test("shows the cook: device name, targets present in order, elapsed on the clock")
    func fields() async throws {
        let (_, _, _, model) = await Self.detail(Self.api())
        let cook = try #require(model.cook)
        #expect(model.state == .loaded(Self.active))
        #expect(model.isActive)
        #expect(model.deviceName(for: cook) == "Brisket Box")
        #expect(model.targets(of: cook).map(\.key) == [.grill, .probe2])
        #expect(model.targets(of: cook).map(\.text) == ["225 °F", "203 °F"])
        #expect(model.elapsedText(for: cook) == "1:02:03")
    }

    @Test("404: not found")
    func notFound() async {
        let (_, _, _, model) = await Self.detail(Self.api(get: { _ in
            .notFound(.init(body: .json(F.error(.notFound, "Cook not found"))))
        }), id: "nope")
        #expect(model.state == .notFound)
        #expect(CookDetailModel.notFoundMessage == "This cook was not found")
    }

    @Test("500: the API's message")
    func fails() async {
        let (_, _, _, model) = await Self.detail(Self.api(get: { _ in
            .internalServerError(.init(body: .json(F.error(.internalServerError, "Internal server error", "req-500"))))
        }))
        #expect(model.state == .failed(APIProblem(
            status: 500, code: "INTERNAL_SERVER_ERROR", message: "Internal server error", requestID: "req-500"
        )))
    }

    @Test("stop: the stopped cook replaces the shown one, the list and the device")
    func stop() async throws {
        let stops = Recorder<String>()
        let (_, devices, cooks, model) = await Self.detail(Self.api(stop: { id in
            stops.record(id)
            var stopped = Self.active
            stopped.status = .completed
            stopped.endTime = fixedNow
            return .ok(.init(body: .json(stopped)))
        }))
        #expect(devices.cookingText(for: DeviceFixtures.box) == "Cooking: Brisket")

        await model.stop()

        #expect(stops.all == ["c1"])
        #expect(model.cook?.status == .completed)
        #expect(model.cook?.endTime == fixedNow)
        #expect(!model.isActive)
        #expect(model.stopState == .idle)
        #expect(cooks.cooks.first?.status == .completed)
        #expect(devices.cookingText(for: DeviceFixtures.box) == nil)
        await model.stop()
        #expect(stops.all.count == 2)
    }

    @Test("stop 503 DEVICE_TWIN_UPDATE_FAILED says so; stopping again retries")
    func stopTwinFailed() async {
        let fail = Box(true)
        let (_, _, _, model) = await Self.detail(Self.api(stop: { id in
            if fail.value {
                return .serviceUnavailable(.init(body: .json(.init(
                    error: .deviceTwinUpdateFailed, message: "Twin update failed", cookId: id,
                    reason: "iothub_failure", requestId: "req-503"
                ))))
            }
            var stopped = Self.active
            stopped.status = .completed
            return .ok(.init(body: .json(stopped)))
        }))
        await model.stop()
        #expect(model.stopState == .twinFailed(APIProblem(
            status: 503, code: "DEVICE_TWIN_UPDATE_FAILED", message: "Twin update failed", requestID: "req-503"
        )))
        #expect(model.isActive)
        #expect(CookDetailModel.stopTwinFailedMessage
            == "The cook was stopped, but the device was not told. Retry to tell the device.")
        fail.value = false
        await model.stop()
        #expect(model.stopState == .idle)
        #expect(model.cook?.status == .completed)
    }

    @Test("stop 404 or 403 keeps the cook and says why")
    func stopRefused() async {
        let (_, _, _, model) = await Self.detail(Self.api(stop: { _ in
            .forbidden(.init(body: .json(F.error(.deviceNotOwned, "Device not owned", "req-403"))))
        }))
        await model.stop()
        #expect(model.stopState == .failed(APIProblem(
            status: 403, code: "DEVICE_NOT_OWNED", message: "Device not owned", requestID: "req-403"
        )))
        #expect(model.cook == Self.active)
    }

    @Test("the stop confirmation's words are the web's")
    func confirmation() {
        #expect(CookDetailModel.stopConfirmTitle(name: "Brisket") == "Stop Brisket?")
        #expect(CookDetailModel.stopConfirmMessage == "The cook is marked completed and the device is told to stop.")
    }

    @Test("a 401 on the read or the stop signs the session out")
    func unauthorized() async {
        let (readSession, _, _, read) = await Self.detail(Self.api(get: { _ in .unauthorized(DeviceFixtures.unauthorized) }))
        #expect(readSession.state == DeviceFixtures.ended)
        #expect(read.state == .loading)

        let (stopSession, _, _, stop) = await Self.detail(Self.api(stop: { _ in .unauthorized(DeviceFixtures.unauthorized) }))
        await stop.stop()
        #expect(stopSession.state == DeviceFixtures.ended)
        #expect(stop.stopState == .idle)
        #expect(stop.cook == Self.active)
    }
}

// MARK: - UI test mode's cooks

@Suite("UI test mode's cooks")
@MainActor
struct StubCooksTests {
    static let environment = ["MEATGEEK_UI_TEST": "1"]

    static func signedIn() async -> (SessionModel, DevicesModel, CooksModel) {
        let session = UITestMode.makeSession(environment: environment)
        await session.restore()
        await session.signIn()
        let now = UITestMode.now(environment: environment)
        let devices = DevicesModel(session: session, now: now)
        await devices.start()
        let cooks = CooksModel(devices: devices, now: now)
        await cooks.start()
        return (session, devices, cooks)
    }

    @Test("more than 20 seeded cooks across both devices: two pages, filters honoured")
    func seeded() async {
        let (_, _, cooks) = await Self.signedIn()
        #expect(StubCooks.seededCount > CooksModel.pageSize)
        #expect(cooks.cooks.count == 20)
        #expect(cooks.cooks.first?.name == StubCooks.newestSeededName)
        #expect(cooks.cooks.map(\.startTime) == cooks.cooks.map(\.startTime).sorted(by: >))
        #expect(cooks.hasMore)

        await cooks.loadMore()
        #expect(cooks.cooks.count == StubCooks.seededCount)
        #expect(Set(cooks.cooks.map(\.id)).count == StubCooks.seededCount)
        #expect(!cooks.hasMore)

        await cooks.setDeviceFilter(StubDevices.neverHeardID)
        #expect(!cooks.cooks.isEmpty)
        #expect(cooks.cooks.allSatisfy { $0.deviceId == StubDevices.neverHeardID })
        await cooks.setStatusFilter(.active)
        #expect(cooks.list == .loaded(cooks: [], continuationToken: nil, hasMore: false))
    }

    @Test("start, then the device is cooking; a second start is 409 naming it; stop ends it; unknown is 404")
    func flow() async throws {
        let (_, devices, cooks) = await Self.signedIn()
        let device = try #require(devices.device(id: StubDevices.connectedID))
        #expect(devices.activeCook(for: device) == nil)

        let form = StartCookModel(device: device, cooks: cooks)
        form.input = StartCookInput(name: "UI Brisket", meatType: "beef", targets: [.probe1: "203"])
        let cook = try #require(await form.submit())
        #expect(cook.status == .active)
        #expect(cook.startTime == UITestMode.fixedNow)
        #expect(cook.targetTemps?.probe1 == 203)
        #expect(cooks.cooks.first?.id == cook.id)

        // A fresh read of the devices' active cooks finds it too.
        await devices.refresh()
        #expect(devices.cookingText(for: device) == "Cooking: UI Brisket")

        // Resending the same intent replays it.
        #expect(await form.submit()?.id == cook.id)

        let second = StartCookModel(device: device, cooks: cooks)
        second.input = StartCookInput(name: "Another", meatType: "pork")
        #expect(await second.submit() == nil)
        guard case .alreadyActive(let activeID, _) = second.outcome else {
            Issue.record("expected 409, got \(String(describing: second.outcome))")
            return
        }
        #expect(activeID == cook.id)

        let detail = CookDetailModel(cookID: cook.id, cooks: cooks)
        await detail.start()
        #expect(detail.cook == cook)
        await detail.stop()
        #expect(detail.cook?.status == .completed)
        #expect(detail.cook?.endTime == UITestMode.fixedNow)
        await devices.refresh()
        #expect(devices.cookingText(for: device) == nil)

        let missing = CookDetailModel(cookID: "no-such-cook", cooks: cooks)
        await missing.start()
        #expect(missing.state == .notFound)
    }

    @Test("a start on a device the user does not own is 403")
    func notOwned() async throws {
        let (_, _, cooks) = await Self.signedIn()
        let stranger = Device(id: "someone-elses", userId: "x", name: "Not mine", model: "M", isActive: true)
        let form = StartCookModel(device: stranger, cooks: cooks)
        form.input = StartCookInput(name: "a", meatType: "b")
        #expect(await form.submit() == nil)
        guard case .problem(let problem) = form.outcome else {
            Issue.record("expected a problem")
            return
        }
        #expect(problem.status == 403)
    }
}
