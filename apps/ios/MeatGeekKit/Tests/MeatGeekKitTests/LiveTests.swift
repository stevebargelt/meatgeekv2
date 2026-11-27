import Foundation
import MeatGeekAPI
import Testing
@testable import MeatGeekKit

/// The live temperatures: `LiveConnection` (a port of
/// apps/web/src/live/live-connection.spec.ts), `LivePanelModel`
/// (live-panel.spec.tsx) and UI test mode's stub hub. The hub and negotiate
/// are fakes, retry waits run on `VirtualClock`, and readings are aged on an
/// injected clock: nothing here waits in real time. A test waits for the
/// connection's background steps with `until`, which re-checks its condition
/// until it holds, and fails naming the wait if it never does.

// MARK: - Fakes

/// Waits until `condition` holds, letting the code under test run between
/// checks. It is a hang guard, not a timing bet: a wait that has not come true
/// after `limit` (far longer than any of these waits takes) never will, so it
/// records an issue naming `what` and returns, instead of spinning until the
/// test plan's 300 s allowance with no word on which wait stuck.
@MainActor
func until(
    _ what: String,
    limit: Duration = .seconds(30),
    sourceLocation: SourceLocation = #_sourceLocation,
    _ condition: () -> Bool
) async {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: limit)
    while !condition() {
        if clock.now >= deadline {
            Issue.record("Waited \(limit) for \"\(what)\"; it never came true", sourceLocation: sourceLocation)
            return
        }
        await Task.yield()
    }
}

/// Retry waits on a clock the test moves: `sleep(for:)` returns once
/// `advance(by:)` has passed its deadline, and throws when its task is
/// cancelled.
final class VirtualClock: @unchecked Sendable {
    private struct Sleeper {
        let deadline: Duration
        let continuation: CheckedContinuation<Void, any Error>
    }

    private let lock = NSLock()
    private var now: Duration = .zero
    private var sleepers: [UUID: Sleeper] = [:]
    private var cancelledEarly: Set<UUID> = []

    /// The time left on each pending sleep, soonest first.
    var pending: [Duration] {
        lock.withLock { sleepers.values.map { $0.deadline - now }.sorted() }
    }

    var sleep: LiveSleep { { [self] duration in try await self.sleep(for: duration) } }

    func sleep(for duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let cancelled = lock.withLock {
                    if cancelledEarly.remove(id) != nil { return true }
                    sleepers[id] = Sleeper(deadline: now + duration, continuation: continuation)
                    return false
                }
                if cancelled { continuation.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let sleeper = lock.withLock {
                let sleeper = sleepers.removeValue(forKey: id)
                if sleeper == nil { cancelledEarly.insert(id) }
                return sleeper
            }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by duration: Duration) {
        let due = lock.withLock {
            now += duration
            let due = sleepers.filter { $0.value.deadline <= now }
            for id in due.keys { sleepers.removeValue(forKey: id) }
            return Array(due.values)
        }
        for sleeper in due { sleeper.continuation.resume() }
    }
}

/// A hub the test drives: it records start and stop, and emits what the test
/// tells it to.
@MainActor
final class FakeHub: LiveHub {
    let info: SignalRConnectionInfo
    var failStart = false
    private(set) var starts = 0
    private(set) var stops = 0
    private var temperature: [@MainActor (TemperatureMessage) -> Void] = []
    private var cookStopped: [@MainActor (CookStoppedMessage) -> Void] = []
    private var reconnectingHandlers: [@MainActor () -> Void] = []
    private var reconnectedHandlers: [@MainActor () -> Void] = []
    private var closeHandlers: [@MainActor () -> Void] = []

    init(info: SignalRConnectionInfo) {
        self.info = info
    }

    func onTemperature(_ handler: @escaping @MainActor (TemperatureMessage) -> Void) { temperature.append(handler) }
    func onCookStopped(_ handler: @escaping @MainActor (CookStoppedMessage) -> Void) { cookStopped.append(handler) }
    func onReconnecting(_ handler: @escaping @MainActor () -> Void) { reconnectingHandlers.append(handler) }
    func onReconnected(_ handler: @escaping @MainActor () -> Void) { reconnectedHandlers.append(handler) }
    func onClose(_ handler: @escaping @MainActor () -> Void) { closeHandlers.append(handler) }

    struct StartFailed: Error {}

    func start() async throws {
        starts += 1
        if failStart { throw StartFailed() }
    }

    func stop() { stops += 1 }

    func emit(_ message: TemperatureMessage) { temperature.forEach { $0(message) } }
    func emit(_ message: CookStoppedMessage) { cookStopped.forEach { $0(message) } }
    func reconnecting() { reconnectingHandlers.forEach { $0() } }
    func reconnected() { reconnectedHandlers.forEach { $0() } }
    func close() { closeHandlers.forEach { $0() } }
}

/// The hubs a connection built, in order.
@MainActor
final class FakeHubs {
    private(set) var hubs: [FakeHub] = []
    /// Set on the next hub built.
    var failNextStart = false

    var latest: FakeHub? { hubs.last }

    var factory: LiveHubFactory {
        { [self] info in
            let hub = FakeHub(info: info)
            hub.failStart = failNextStart
            failNextStart = false
            hubs.append(hub)
            return hub
        }
    }
}

/// `POST /negotiate`: answers from `answers` in turn, then 200s with a token
/// numbered by call. `hold` keeps the next call waiting until `release()`.
@MainActor
final class FakeNegotiate {
    var answers: [NegotiateResult]
    private(set) var calls = 0
    /// Calls that have returned their answer.
    private(set) var answered = 0
    var hold = false
    private var held: CheckedContinuation<Void, Never>?

    init(_ answers: [NegotiateResult] = []) {
        self.answers = answers
    }

    var isHeld: Bool { held != nil }

    func release() {
        held?.resume()
        held = nil
    }

    func callAsFunction() async -> NegotiateResult {
        calls += 1
        let call = calls
        if hold {
            hold = false
            await withCheckedContinuation { held = $0 }
        }
        answered += 1
        return answers.isEmpty ? .ok(LiveFixtures.info(call)) : answers.removeFirst()
    }
}

enum LiveFixtures {
    static func info(_ n: Int) -> SignalRConnectionInfo {
        .init(url: "https://mg.service.signalr.net/client/?hub=temperatureHub", accessToken: "tok-\(n)")
    }

    /// `fixedNow` plus `seconds`, as the API writes a reading's timestamp.
    static func iso(_ seconds: TimeInterval = 0) -> String {
        (try? APIDateTranscoder().encode(fixedNow.addingTimeInterval(seconds))) ?? ""
    }

    static func temperature(
        device: String = "box", at seconds: TimeInterval = 0, grill: Double? = 225,
        probe1: Double? = 150, probe2: Double? = nil, probe3: Double? = nil, probe4: Double? = nil
    ) -> TemperatureMessage {
        TemperatureMessage(
            deviceId: device, timestamp: iso(seconds), grillTemp: grill, probe1Temp: probe1,
            probe2Temp: probe2, probe3Temp: probe3, probe4Temp: probe4,
            enqueuedTimeUtc: fixedNow.addingTimeInterval(seconds)
        )
    }

    static func cookStopped(_ cook: Cook) -> CookStoppedMessage {
        CookStoppedMessage(
            _type: .cookStopped, timestamp: fixedNow, messageId: "6c0f8a43-8d9b-4f4f-9d3e-2b1d7a1f0c11",
            deviceId: cook.deviceId, userId: cook.userId, correlation: .init(id: "req-1"), payload: cook
        )
    }
}

/// A `LiveConnection` on fakes, recording what it reports.
@MainActor
final class ConnectionHarness {
    let hubs = FakeHubs()
    let negotiate: FakeNegotiate
    let clock = VirtualClock()
    private(set) var statuses: [LiveConnectionStatus] = []
    private(set) var connected = 0
    private(set) var temperatures: [TemperatureMessage] = []
    private(set) var cookStops: [CookStoppedMessage] = []
    private(set) var connection: LiveConnection!

    init(_ answers: [NegotiateResult] = []) {
        negotiate = FakeNegotiate(answers)
        connection = LiveConnection(
            negotiate: { [negotiate] in await negotiate() },
            createHub: hubs.factory,
            sleep: clock.sleep,
            handlers: .init(
                onStatus: { [unowned self] in self.statuses.append($0) },
                onConnected: { [unowned self] in self.connected += 1 },
                onTemperature: { [unowned self] in self.temperatures.append($0) },
                onCookStopped: { [unowned self] in self.cookStops.append($0) }
            )
        )
    }

    var status: LiveConnectionStatus? { statuses.last }

    /// Starts the connection and waits until its first hub has started.
    func open() async {
        connection.start()
        await until("connected") { status == .connected }
    }

    /// Waits for the retry task to start sleeping `delay`, moves the clock
    /// past it, and waits until that retry's negotiate is called.
    func retry(after delay: Duration, thenCalls calls: Int) async {
        await until("the retry wait") { clock.pending == [delay] }
        clock.advance(by: delay)
        await until("negotiate call \(calls)") { negotiate.calls >= calls }
        #expect(negotiate.calls == calls)
    }
}

// MARK: - LiveConnection

@Suite("LiveConnection")
@MainActor
struct LiveConnectionTests {
    @Test("negotiates, builds the hub from the negotiate answer, starts it, then reports connected")
    func connects() async throws {
        let c = ConnectionHarness()
        c.connection.start()
        #expect(c.statuses == [.connecting])
        await until("connected") { c.status == .connected }

        #expect(c.negotiate.calls == 1)
        #expect(c.hubs.hubs.count == 1)
        let hub = try #require(c.hubs.latest)
        #expect(hub.info == LiveFixtures.info(1))
        #expect(hub.starts == 1)
        #expect(c.statuses == [.connecting, .connected])
        #expect(c.connected == 1)

        let reading = LiveFixtures.temperature()
        hub.emit(reading)
        #expect(c.temperatures == [reading])
        c.connection.stop()
    }

    @Test("reports an automatic reconnect, and calls onConnected again after it")
    func automaticReconnect() async throws {
        let c = ConnectionHarness()
        await c.open()
        let hub = try #require(c.hubs.latest)

        hub.reconnecting()
        #expect(c.status == .reconnecting)
        hub.reconnected()
        #expect(c.status == .connected)
        #expect(c.connected == 2)
        #expect(c.negotiate.calls == 1)
        c.connection.stop()
    }

    @Test("after a close, negotiates again 2 s later and starts a new connection with the new token")
    func closeThenNegotiateAgain() async throws {
        let c = ConnectionHarness()
        await c.open()
        try #require(c.hubs.latest).close()
        #expect(c.status == .reconnecting)
        await until("the retry wait") { c.clock.pending == [.seconds(2)] }

        c.clock.advance(by: .milliseconds(1_999))
        #expect(c.clock.pending == [.milliseconds(1)])
        #expect(c.negotiate.calls == 1)
        c.clock.advance(by: .milliseconds(1))
        await until("the second connection") { c.connected >= 2 }
        #expect(c.connected == 2)

        #expect(c.negotiate.calls == 2)
        #expect(c.hubs.hubs.count == 2)
        #expect(c.hubs.latest?.info.accessToken == "tok-2")
        #expect(c.hubs.latest?.starts == 1)
        #expect(c.status == .connected)
        c.connection.stop()
    }

    @Test("retries a failing negotiate (429, 503, network) after 2, 5, 10, then every 30 s")
    func backoff() async throws {
        let c = ConnectionHarness([
            .failed(status: 503), .failed(status: 429), .failed(status: 503),
            .failed(status: nil), .failed(status: 500), .failed(status: 503),
        ])
        c.connection.start()
        await until("the first retry wait") { c.clock.pending.count == 1 }
        #expect(c.negotiate.calls == 1)
        #expect(c.status == .reconnecting)

        let steps: [(Duration, Int)] = [
            (.seconds(2), 2), (.seconds(5), 3), (.seconds(10), 4), (.seconds(30), 5), (.seconds(30), 6), (.seconds(30), 7),
        ]
        for (delay, callsAfter) in steps {
            #expect(c.clock.pending == [delay], "waiting before call \(callsAfter)")
            c.clock.advance(by: delay - .milliseconds(1))
            #expect(c.negotiate.calls == callsAfter - 1)
            c.clock.advance(by: .milliseconds(1))
            await until("negotiate call \(callsAfter) answered") {
                c.negotiate.calls >= callsAfter && (c.clock.pending.count == 1 || c.status == .connected)
            }
            #expect(c.negotiate.calls == callsAfter)
        }
        await until("connected") { c.status == .connected }
        #expect(c.hubs.hubs.count == 1)
        #expect(c.clock.pending.isEmpty)
        c.connection.stop()
    }

    @Test("starts the backoff over after a successful connection")
    func resetAfterSuccess() async throws {
        let c = ConnectionHarness([.failed(status: 503), .failed(status: 503)])
        c.connection.start()
        await until("retry 1") { c.clock.pending == [.seconds(2)] }
        c.clock.advance(by: .seconds(2))
        await until("retry 2") { c.clock.pending == [.seconds(5)] }
        c.clock.advance(by: .seconds(5))
        await until("connected") { c.status == .connected }

        try #require(c.hubs.latest).close()
        await c.retry(after: .seconds(2), thenCalls: 4)
        await until("connected again") { c.connected >= 2 }
        #expect(c.connected == 2)
        c.connection.stop()
    }

    @Test("a hub that fails to start is retried like a close")
    func failedStart() async throws {
        let c = ConnectionHarness()
        c.hubs.failNextStart = true
        c.connection.start()
        await until("the retry wait") { c.clock.pending == [.seconds(2)] }
        #expect(c.hubs.hubs.count == 1)
        #expect(c.status == .reconnecting)

        c.clock.advance(by: .seconds(2))
        await until("connected") { c.status == .connected }
        #expect(c.hubs.hubs.count == 2)
        c.connection.stop()
    }

    @Test("a 401 from negotiate reports signed-out and stops retrying")
    func unauthorized() async {
        let c = ConnectionHarness([.failed(status: 401)])
        c.connection.start()
        await until("signed out") { c.status == .signedOut }
        #expect(c.clock.pending.isEmpty)
        c.clock.advance(by: .seconds(120))
        #expect(c.negotiate.calls == 1)
        #expect(c.hubs.hubs.isEmpty)
    }

    @Test("a 401 when negotiating again after a close also stops")
    func unauthorizedAfterClose() async throws {
        let c = ConnectionHarness()
        await c.open()
        c.negotiate.answers = [.failed(status: 401)]
        try #require(c.hubs.latest).close()
        await c.retry(after: .seconds(2), thenCalls: 2)
        await until("signed out") { c.status == .signedOut }
        #expect(c.clock.pending.isEmpty)
        c.clock.advance(by: .seconds(120))
        #expect(c.negotiate.calls == 2)
    }

    @Test("stop() stops the hub, cancels a pending retry, and ignores later callbacks")
    func stop() async throws {
        let c = ConnectionHarness()
        await c.open()
        let hub = try #require(c.hubs.latest)
        c.connection.stop()
        #expect(hub.stops == 1)

        hub.emit(LiveFixtures.temperature())
        hub.close()
        hub.reconnecting()
        #expect(c.temperatures.isEmpty)
        #expect(c.clock.pending.isEmpty)
        #expect(c.statuses == [.connecting, .connected])

        let d = ConnectionHarness([.failed(status: 503)])
        d.connection.start()
        await until("the retry wait") { d.clock.pending.count == 1 }
        d.connection.stop()
        #expect(d.clock.pending.isEmpty)
        d.clock.advance(by: .seconds(60))
        #expect(d.negotiate.calls == 1)
        d.connection.stop()
    }

    @Test("stop() during negotiate never builds a hub")
    func stopDuringNegotiate() async {
        let c = ConnectionHarness()
        c.negotiate.hold = true
        c.connection.start()
        await until("negotiate in flight") { c.negotiate.isHeld }
        c.connection.stop()
        c.negotiate.release()
        // The connection reads the answer in the same main-actor job.
        await until("negotiate answered") { c.negotiate.answered >= 1 }
        #expect(c.negotiate.answered == 1)
        #expect(c.negotiate.calls == 1)
        #expect(c.hubs.hubs.isEmpty)
        #expect(c.statuses == [.connecting])
    }

    @Test("ignores a replaced connection")
    func replaced() async throws {
        let c = ConnectionHarness()
        await c.open()
        let first = try #require(c.hubs.latest)
        first.close()
        await c.retry(after: .seconds(2), thenCalls: 2)
        await until("the second connection") { c.connected >= 2 }
        #expect(c.connected == 2)

        first.emit(LiveFixtures.temperature())
        first.reconnecting()
        first.close()
        #expect(c.temperatures.isEmpty)
        #expect(c.status == .connected)
        #expect(c.clock.pending.isEmpty)
        c.connection.stop()
    }

    @Test("the retry delays are RETRY_DELAYS_MS")
    func delays() {
        #expect(LiveConnection.retryDelays == [.seconds(2), .seconds(5), .seconds(10), .seconds(30)])
    }
}

// MARK: - Text

@Suite("Live text")
struct LiveTextTests {
    @Test("°F as sent, rounded to one decimal; °C converted; — for no value")
    func temperature() {
        #expect(LiveText.temperature(225.04, unit: .fahrenheit) == "225 °F")
        #expect(LiveText.temperature(98.6, unit: .fahrenheit) == "98.6 °F")
        #expect(LiveText.temperature(98.65, unit: .fahrenheit) == "98.7 °F")
        #expect(LiveText.temperature(212, unit: .celsius) == "100 °C")
        #expect(LiveText.temperature(32, unit: .celsius) == "0 °C")
        #expect(LiveText.temperature(31.99, unit: .celsius) == "0 °C") // -0.005… rounds to -0, shown as 0
        #expect(LiveText.temperature(nil, unit: .fahrenheit) == "—")
        #expect(LiveText.temperature(nil, unit: .celsius) == "—")
    }

    @Test("rounds half up, as Math.round does")
    func halfUp() {
        #expect(LiveText.displayValue(-0.25, unit: .fahrenheit) == -0.2)
        #expect(LiveText.displayValue(0.25, unit: .fahrenheit) == 0.3)
    }

    @Test("the state and badge for each status and age")
    func panelState() {
        typealias M = LivePanelModel
        #expect(M.panelState(status: .connecting, hasReading: true, age: 0, staleAfter: 90) == (.connecting, "Connecting…"))
        #expect(M.panelState(status: .reconnecting, hasReading: true, age: 0, staleAfter: 90) == (.stale, "Reconnecting…"))
        #expect(M.panelState(status: .signedOut, hasReading: false, age: nil, staleAfter: 90) == (.stale, "Sign in again"))
        #expect(M.panelState(status: .connected, hasReading: false, age: nil, staleAfter: 90) == (.waiting, "Waiting"))
        #expect(M.panelState(status: .connected, hasReading: true, age: 90, staleAfter: 90) == (.live, "Live"))
        #expect(M.panelState(status: .connected, hasReading: true, age: 91, staleAfter: 90) == (.stale, "No reading for 1 min 31 s"))
    }
}

// MARK: - LivePanelModel

/// A live panel for an active cook on "box", over a stub whose negotiate and
/// current reading the test controls.
@MainActor
final class PanelHarness {
    let hubs = FakeHubs()
    let clock = VirtualClock()
    let negotiations = Box(0)
    let backfills = Box(0)
    /// What `GET /temperatures/current/box` answers; nil: 404 NO_READINGS.
    let current = Box<TemperatureReading?>(nil)
    let negotiateStatus = Box<Int?>(nil)
    let now = Box(fixedNow)
    var device: Device
    let cook: Cook
    private(set) var stoppedCooks: [Cook] = []
    private(set) var session: SessionModel!
    private(set) var model: LivePanelModel!

    init(cook: Cook = CookFixtures.cook("cook-1", device: "box", status: .active), configuration: Components.Schemas.DeviceConfiguration? = nil) {
        self.cook = cook
        device = Device(
            id: "box", userId: "tid:oid", name: "Brisket Box", model: "MeatGeek V1", isActive: true,
            configuration: configuration
        )
    }

    func api() -> StubAPI {
        var api = StubAPI()
        let (negotiations, backfills, current, negotiateStatus) = (negotiations, backfills, current, negotiateStatus)
        api.negotiateHandler = { _ in
            negotiations.value += 1
            switch negotiateStatus.value {
            case 401?:
                return .unauthorized(DeviceFixtures.unauthorized)
            case let status?:
                return .undocumented(statusCode: status, .init())
            case nil:
                return .ok(.init(body: .json(LiveFixtures.info(negotiations.value))))
            }
        }
        api.getCurrentTemperaturesHandler = { input in
            backfills.value += 1
            guard input.path.deviceId == "box", let reading = current.value else {
                return .notFound(.init(body: .json(CookFixtures.error(.noReadings, "No readings"))))
            }
            return .ok(.init(body: .json(reading)))
        }
        return api
    }

    /// Signs in, makes the model, shows the screen, and waits until its first
    /// hub has started and the first backfill has answered.
    func open() async {
        session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api())
        await session.restore()
        let now = self.now
        model = LivePanelModel(
            cook: cook,
            session: session,
            device: { [unowned self] in self.device },
            services: LiveServices(createHub: hubs.factory, sleep: clock.sleep),
            now: { now.value },
            onCookStopped: { [unowned self] in self.stoppedCooks.append($0) }
        )
        model.appear()
        await until("connected and backfilled") { model.status == .connected && model.backfillsAnswered >= 1 }
        #expect(model.backfillsAnswered == 1)
    }

    var hub: FakeHub { hubs.latest! }
    var display: LivePanelDisplay { model.display() }

    func channel(_ channel: LiveChannel) -> String? {
        display.channels.first { $0.channel == channel }?.text
    }
}

@Suite("LivePanelModel")
@MainActor
struct LivePanelModelTests {
    @Test("waiting until the first reading, then live with the pushed values of the cook's device only")
    func waitingThenLive() async {
        let p = PanelHarness()
        await p.open()
        #expect(p.display.state == .waiting)
        #expect(p.display.badge == "Waiting")
        #expect(p.display.showsWaitingNote)
        #expect(LivePanelModel.waitingNote.contains("up to about 20 s"))
        #expect(p.channel(.grill) == "—")
        #expect(p.display.readingTime == "No reading yet")
        #expect(p.negotiations.value == 1)
        #expect(p.backfills.value == 1)
        #expect(p.hub.info.accessToken == "tok-1")

        p.hub.emit(LiveFixtures.temperature(device: "kettle", grill: 999))
        #expect(p.display.state == .waiting)
        #expect(p.channel(.grill) == "—")

        p.hub.emit(LiveFixtures.temperature(grill: 225.04, probe1: 150, probe3: 98.6))
        #expect(p.display.state == .live)
        #expect(p.display.badge == "Live")
        #expect(p.display.channels.map(\.label) == ["Grill", "Probe 1", "Probe 2", "Probe 3", "Probe 4"])
        #expect(p.display.channels.map(\.text) == ["225 °F", "150 °F", "—", "98.6 °F", "—"])
        #expect(!p.display.showsWaitingNote)

        p.hub.emit(LiveFixtures.temperature(at: 1, grill: 231, probe1: nil))
        #expect(p.channel(.grill) == "231 °F")
        #expect(p.channel(.probe1) == "—")
        p.model.disappear()
    }

    @Test("readings in a celsius device's unit")
    func celsius() async {
        let p = PanelHarness(configuration: .init(temperatureUnit: .celsius))
        await p.open()
        p.hub.emit(LiveFixtures.temperature(grill: 212, probe1: 32))
        #expect(p.channel(.grill) == "100 °C")
        #expect(p.channel(.probe1) == "0 °C")
        p.model.disappear()
    }

    /// en_US in UTC, so a reached time reads the same on every machine.
    static let enUS = Locale(identifier: "en_US")
    static let utc = TimeZone(identifier: "UTC")!

    func cook(
        targets: Components.Schemas.TargetTemperatures?, reached: Components.Schemas.TargetsReached? = nil
    ) -> Cook {
        var cook = CookFixtures.cook("cook-1", device: "box", status: .active)
        cook.targetTemps = targets
        cook.targetsReached = reached
        return cook
    }

    @Test("a channel with a target and a reading shows the target, in the device's unit, converted as readings are")
    func targets() async {
        let p = PanelHarness(
            cook: cook(targets: .init(grill: 225, probe1: 203, probe2: 180)),
            configuration: .init(temperatureUnit: .celsius)
        )
        await p.open()
        // No reading yet: every channel looks as it does without a target.
        #expect(p.display.channels.allSatisfy { $0.target == nil && $0.reached == nil })

        p.hub.emit(LiveFixtures.temperature(grill: 212, probe1: 150, probe2: nil, probe3: 98.6))
        let channels = p.display.channels
        #expect(channels.map(\.text) == ["100 °C", "65.6 °C", "—", "37 °C", "—"])
        #expect(channels.map(\.target) == ["Target 107.2 °C", "Target 95 °C", nil, nil, nil])
        #expect(channels.allSatisfy { $0.reached == nil })
        p.model.disappear()
    }

    @Test("targets in °F on a fahrenheit device, or one not read yet")
    func targetsFahrenheit() async {
        let p = PanelHarness(cook: cook(targets: .init(probe1: 203.5)))
        await p.open()
        p.hub.emit(LiveFixtures.temperature(grill: 225, probe1: 150))
        #expect(p.display.channels.map(\.target) == [nil, "Target 203.5 °F", nil, nil, nil])
        p.model.disappear()
    }

    @Test("a reached probe shows the mark and the local time it was reached; the grill never shows a mark")
    func reached() async {
        let at = Components.Schemas.TargetReached(reachedAt: fixedNow.addingTimeInterval(60))
        let p = PanelHarness(cook: cook(
            targets: .init(grill: 225, probe1: 203, probe2: 180, probe3: 160),
            // probe3 has no reading: no mark. probe4 has no target: the
            // server's state alone does not make a mark.
            reached: .init(grill: at, probe1: at, probe3: at, probe4: at)
        ))
        await p.open()
        p.hub.emit(LiveFixtures.temperature(grill: 230, probe1: 204, probe2: 170, probe4: 120))
        let channels = p.model.display(at: fixedNow, locale: Self.enUS, timeZone: Self.utc).channels
        #expect(channels.map(\.reached) == [nil, "✓ Reached 6:01\u{202F}PM", nil, nil, nil])
        #expect(channels.map(\.target) == ["Target 225 °F", "Target 203 °F", "Target 180 °F", nil, nil])
        #expect(channels.map(\.text) == ["230 °F", "204 °F", "170 °F", "—", "120 °F"])

        let tokyo = p.model.display(at: fixedNow, locale: Self.enUS, timeZone: TimeZone(identifier: "Asia/Tokyo")!)
        #expect(tokyo.channels[1].reached == "✓ Reached 3:01\u{202F}AM")
        p.model.disappear()
    }

    @Test("the cook as re-read replaces the targets and reached state: a mark appears, then goes when the probe re-arms")
    func cookChanged() async {
        let p = PanelHarness(cook: cook(targets: .init(probe1: 203)))
        await p.open()
        p.hub.emit(LiveFixtures.temperature(grill: 225, probe1: 204))
        func probe1() -> LivePanelDisplay.Channel {
            p.model.display(at: fixedNow, locale: Self.enUS, timeZone: Self.utc).channels[1]
        }
        #expect(probe1().reached == nil)

        let at = Components.Schemas.TargetReached(reachedAt: fixedNow)
        p.model.cookChanged(cook(targets: .init(probe1: 203), reached: .init(probe1: at)))
        #expect(probe1().reached == "✓ Reached 6:00\u{202F}PM")

        p.model.cookChanged(cook(targets: .init(probe1: 203)))
        #expect(probe1().reached == nil)
        #expect(probe1().target == "Target 203 °F")

        // Another cook's state is not this panel's.
        var other = cook(targets: .init(probe1: 250), reached: .init(probe1: at))
        other.id = "cook-2"
        p.model.cookChanged(other)
        #expect(probe1().target == "Target 203 °F")
        #expect(probe1().reached == nil)
        p.model.disappear()
    }

    @Test("the reading time and its age, on the injected clock")
    func readingTime() async {
        let p = PanelHarness(configuration: .init(pollingInterval: 10))
        await p.open()
        p.hub.emit(LiveFixtures.temperature(at: -12))
        #expect(p.display.readingTime == "Reading at \(CookText.dateTime(fixedNow.addingTimeInterval(-12))) (12 s ago)")
        p.now.value = fixedNow.addingTimeInterval(1)
        #expect(p.display.readingTime.hasSuffix("(13 s ago)"))
        p.model.disappear()
    }

    @Test("live, stale once older than 3 × pollingInterval, live again on a new reading")
    func stale() async {
        let p = PanelHarness(configuration: .init(pollingInterval: 10))
        await p.open()
        #expect(p.model.staleAfter == 30)
        p.hub.emit(LiveFixtures.temperature())
        #expect(p.display.state == .live)

        p.now.value = fixedNow.addingTimeInterval(30)
        #expect(p.display.state == .live)
        p.now.value = fixedNow.addingTimeInterval(31)
        #expect(p.display.state == .stale)
        #expect(p.display.badge == "No reading for 31 s")

        p.hub.emit(LiveFixtures.temperature(at: 31))
        #expect(p.display.state == .live)
        #expect(p.display.badge == "Live")
        p.model.disappear()
    }

    @Test("a 30 s polling interval (90 s stale threshold) when the device sets none, or is not read yet")
    func defaultInterval() async {
        let p = PanelHarness()
        await p.open()
        #expect(p.model.staleAfter == 90)
        p.hub.emit(LiveFixtures.temperature())
        p.now.value = fixedNow.addingTimeInterval(90)
        #expect(p.display.state == .live)
        p.now.value = fixedNow.addingTimeInterval(100)
        #expect(p.display.badge == "No reading for 1 min 40 s")
        p.model.disappear()
    }

    @Test("stale with Reconnecting… during an automatic reconnect, then live again after a backfill")
    func reconnecting() async {
        let p = PanelHarness()
        await p.open()
        p.hub.emit(LiveFixtures.temperature(grill: 225))
        #expect(p.display.state == .live)

        p.hub.reconnecting()
        #expect(p.display.state == .stale)
        #expect(p.display.badge == "Reconnecting…")
        #expect(p.channel(.grill) == "225 °F")

        p.current.value = TemperatureReading(deviceId: "box", timestamp: LiveFixtures.iso(1), grillTemp: 240)
        p.hub.reconnected()
        await until("the backfilled reading") { p.channel(.grill) == "240 °F" }
        #expect(p.backfills.value == 2)
        #expect(p.display.state == .live)
        #expect(p.negotiations.value == 1)
        p.model.disappear()
    }

    @Test("the backfilled reading on connect; an older backfill never replaces a newer push")
    func backfill() async {
        let p = PanelHarness()
        p.current.value = TemperatureReading(deviceId: "box", timestamp: LiveFixtures.iso(), grillTemp: 210, probe2Temp: 120)
        await p.open()
        await until("the backfill shown") { p.channel(.grill) == "210 °F" }
        #expect(p.channel(.probe2) == "120 °F")
        #expect(p.display.state == .live)

        p.hub.emit(LiveFixtures.temperature(at: 5, grill: 215))
        p.current.value = TemperatureReading(deviceId: "box", timestamp: LiveFixtures.iso(), grillTemp: 1)
        p.hub.reconnected()
        await until("the second backfill applied") { p.model.backfillsAnswered >= 2 }
        #expect(p.model.backfillsAnswered == 2)
        #expect(p.channel(.grill) == "215 °F")
        p.model.disappear()
    }

    @Test("after a close, negotiates again and backfills on the new connection")
    func closeThenNewConnection() async {
        let p = PanelHarness()
        await p.open()
        p.hub.close()
        #expect(p.display.badge == "Reconnecting…")
        await until("the retry wait") { p.clock.pending == [.seconds(2)] }

        p.clock.advance(by: .seconds(2))
        await until("the second connection, backfilled") { p.hubs.hubs.count >= 2 && p.model.backfillsAnswered >= 2 }
        #expect(p.hubs.hubs.count == 2)
        #expect(p.model.backfillsAnswered == 2)
        #expect(p.negotiations.value == 2)
        #expect(p.hub.info.accessToken == "tok-2")
        await until("connected") { p.model.status == .connected }
        #expect(p.display.state == .waiting)
        p.model.disappear()
    }

    @Test("a 503 from negotiate is retried; a 401 says Sign in again, stops, and ends the session")
    func negotiateFailures() async {
        let p = PanelHarness()
        p.negotiateStatus.value = 503
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: p.api())
        await session.restore()
        let model = LivePanelModel(
            cook: p.cook, session: session, device: { nil },
            services: LiveServices(createHub: p.hubs.factory, sleep: p.clock.sleep), now: { fixedNow }
        )
        model.appear()
        await until("the retry wait") { p.clock.pending == [.seconds(2)] }
        #expect(model.display().badge == "Reconnecting…")

        p.negotiateStatus.value = 401
        p.clock.advance(by: .seconds(2))
        await until("signed out") { model.status == .signedOut }
        #expect(model.display().badge == "Sign in again")
        #expect(model.display().state == .stale)
        #expect(model.display().showsSignedOutNote)
        #expect(session.state == DeviceFixtures.ended)
        #expect(p.clock.pending.isEmpty)
        #expect(p.negotiations.value == 2)
        #expect(p.hubs.hubs.isEmpty)
    }

    @Test("cook_stopped for this cook stops the connection and ends the cook; another cook's is ignored")
    func cookStopped() async {
        let p = PanelHarness()
        await p.open()
        let hub = p.hub

        var other = CookFixtures.cook("cook-2", device: "box")
        other.status = .completed
        hub.emit(LiveFixtures.cookStopped(other))
        #expect(hub.stops == 0)
        #expect(p.stoppedCooks.isEmpty)
        #expect(p.model.stoppedCook == nil)

        var stopped = p.cook
        stopped.status = .completed
        stopped.endTime = fixedNow
        hub.emit(LiveFixtures.cookStopped(stopped))
        #expect(hub.stops == 1)
        #expect(p.stoppedCooks == [stopped])
        #expect(p.model.stoppedCook == stopped)
        #expect(!p.model.isConnected)

        // Ended: coming back to the screen opens nothing.
        p.model.disappear()
        p.model.appear()
        #expect(p.hubs.hubs.count == 1)
    }

    @Test("background stops the connection; foreground opens a new one and backfills")
    func backgroundAndForeground() async {
        let p = PanelHarness()
        await p.open()
        let first = p.hub
        p.hub.emit(LiveFixtures.temperature(grill: 225))

        p.model.setAppActive(false)
        #expect(first.stops == 1)
        #expect(!p.model.isConnected)
        first.emit(LiveFixtures.temperature(at: 1, grill: 999))
        #expect(p.channel(.grill) == "225 °F")

        p.current.value = TemperatureReading(deviceId: "box", timestamp: LiveFixtures.iso(2), grillTemp: 230)
        p.model.setAppActive(true)
        #expect(p.model.status == .connecting)
        await until("the new connection, backfilled") { p.model.status == .connected && p.model.backfillsAnswered >= 2 }
        #expect(p.model.backfillsAnswered == 2)
        #expect(p.channel(.grill) == "230 °F")
        #expect(p.negotiations.value == 2)
        #expect(p.hubs.hubs.count == 2)
        #expect(p.model.connectionsOpened == 2)
        #expect(p.hub.info.accessToken == "tok-2")

        // A second activation while connected opens nothing more.
        p.model.setAppActive(true)
        #expect(p.model.connectionsOpened == 2)
        p.model.disappear()
        #expect(p.hub.stops == 1)
    }

    @Test("connects only while the screen shows and the app is active")
    func visibility() async {
        let p = PanelHarness()
        await p.open()
        p.model.disappear()
        #expect(p.hub.stops == 1)
        p.model.setAppActive(false)
        p.model.setAppActive(true)
        #expect(p.model.connectionsOpened == 1)
        p.model.appear()
        #expect(p.model.connectionsOpened == 2)
        p.model.disappear()
    }
}

// MARK: - The cook screen

@Suite("Cook detail with the live panel")
@MainActor
struct CookDetailLiveTests {
    /// `getCook` answers `GET /cooks/{cookId}`: `active`, unless the test says otherwise.
    static func models(
        active: Cook,
        getCook: (@Sendable (Operations.GetCook.Input) async -> Operations.GetCook.Output)? = nil,
        updateTargets: (@Sendable (Operations.UpdateCookTargets.Input) async -> Operations.UpdateCookTargets.Output)? = nil
    ) async -> (CooksModel, CookDetailModel, FakeHubs) {
        let hubs = FakeHubs()
        let clock = VirtualClock()
        var api = CookFixtures.api(active: [active]) { _ in CookFixtures.page([active]) }
        api.getCookHandler = getCook ?? { _ in .ok(.init(body: .json(active))) }
        if let updateTargets { api.updateCookTargetsHandler = updateTargets }
        api.negotiateHandler = { _ in .ok(.init(body: .json(LiveFixtures.info(1)))) }
        api.getCurrentTemperaturesHandler = { _ in .notFound(.init(body: .json(CookFixtures.error(.noReadings, "none")))) }
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let devices = DevicesModel(session: session, now: { fixedNow })
        await devices.start()
        let cooks = CooksModel(
            devices: devices, now: { fixedNow },
            live: LiveServices(createHub: hubs.factory, sleep: clock.sleep)
        )
        await cooks.start()
        return (cooks, CookDetailModel(cookID: active.id, cooks: cooks), hubs)
    }

    @Test("an active cook's screen connects; cook_stopped ends it on the screen and in the lists")
    func cookStopped() async throws {
        let active = CookFixtures.cook("c1", device: "box", status: .active, name: "Brisket")
        let (cooks, detail, hubs) = await Self.models(active: active)
        detail.appear()
        await detail.start()
        let live = try #require(detail.live)
        await until("connected") { live.status == .connected }
        #expect(hubs.hubs.count == 1)

        var stopped = active
        stopped.status = .completed
        stopped.endTime = fixedNow
        try #require(hubs.latest).emit(LiveFixtures.cookStopped(stopped))

        #expect(detail.cook == stopped)
        #expect(!detail.isActive)
        #expect(detail.live == nil)
        #expect(try #require(hubs.latest).stops == 1)
        #expect(cooks.cooks.first == stopped)
        #expect(cooks.devices.activeCook(for: try #require(cooks.devices.device(id: "box"))) == nil)
    }

    @Test("each pushed reading re-reads the cook: a reached mark appears and clears with no refresh")
    func reachedFollowsTheServer() async throws {
        var active = CookFixtures.cook("c1", device: "box", status: .active, name: "Brisket")
        active.targetTemps = .init(grill: 225, probe1: 203)
        var reached = active
        // The server says the grill and probe 1 are reached; the app shows
        // what it says and runs no rule of its own.
        reached.targetsReached = .init(
            grill: .init(reachedAt: fixedNow), probe1: .init(reachedAt: fixedNow.addingTimeInterval(5))
        )
        let served = Box(active)
        let reads = Box(0)
        let (_, detail, hubs) = await Self.models(active: active) { _ in
            reads.value += 1
            return .ok(.init(body: .json(served.value)))
        }
        detail.appear()
        await detail.start()
        let live = try #require(detail.live)
        await until("connected") { live.status == .connected }
        #expect(reads.value == 1)
        func marks() -> [String?] {
            live.display(at: fixedNow, locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "UTC")!)
                .channels.map(\.reached)
        }

        // A reading 210 °F against 203 °F: the app does not decide on its own.
        served.value = reached
        let hub = try #require(hubs.latest)
        hub.emit(LiveFixtures.temperature(at: 5, grill: 230, probe1: 210))
        #expect(marks() == [nil, nil, nil, nil, nil])
        await until("the reached mark") { detail.cook == reached }
        #expect(reads.value == 2)
        #expect(marks() == [nil, "✓ Reached 6:00\u{202F}PM", nil, nil, nil])
        #expect(live.display().channels.map(\.target).prefix(2) == ["Target 225 °F", "Target 203 °F"])

        // The probe re-armed on the server: the mark goes on the next reading.
        var rearmed = active
        rearmed.targetsReached = .init(grill: .init(reachedAt: fixedNow))
        served.value = rearmed
        hub.emit(LiveFixtures.temperature(at: 10, grill: 230, probe1: 180))
        await until("the mark cleared") { detail.cook == rearmed }
        #expect(reads.value == 3)
        #expect(marks() == [nil, nil, nil, nil, nil])
        #expect(detail.isActive)
        detail.disappear()
    }

    @Test("a target saved on one phone shows on its live panel at once, and on a second phone's with its next reading")
    func targetChangedOnAnotherPhone() async throws {
        var active = CookFixtures.cook("c1", device: "box", status: .active, name: "Brisket")
        active.targetTemps = .init(probe1: 165)
        active.targetsReached = .init(probe1: .init(reachedAt: fixedNow))
        // One server for both phones: the cook as it is stored.
        let served = Box(active)
        let reads = Box(0)
        let getCook: @Sendable (Operations.GetCook.Input) async -> Operations.GetCook.Output = { _ in
            reads.value += 1
            return .ok(.init(body: .json(served.value)))
        }
        let updateTargets: @Sendable (Operations.UpdateCookTargets.Input) async -> Operations.UpdateCookTargets.Output = { input in
            guard case .json(let body) = input.body else { return .undocumented(statusCode: 415, .init()) }
            var saved = served.value
            saved.targetTemps = .init(probe1: body.targetTemps.probe1)
            saved.targetsReached = nil
            served.value = saved
            return .ok(.init(body: .json(saved)))
        }
        let (_, phoneA, hubsA) = await Self.models(active: active, getCook: getCook, updateTargets: updateTargets)
        let (_, phoneB, hubsB) = await Self.models(active: active, getCook: getCook, updateTargets: updateTargets)
        for phone in [phoneA, phoneB] {
            phone.appear()
            await phone.start()
        }
        let liveA = try #require(phoneA.live)
        let liveB = try #require(phoneB.live)
        await until("both connected") { liveA.status == .connected && liveB.status == .connected }
        try #require(hubsA.latest).emit(LiveFixtures.temperature(at: 5, grill: 230, probe1: 170))
        try #require(hubsB.latest).emit(LiveFixtures.temperature(at: 5, grill: 230, probe1: 170))
        func probe1(_ live: LivePanelModel) -> LivePanelDisplay.Channel { live.display().channels[1] }
        // Each reading re-reads its phone's cook; the edit starts once both have answered.
        await until("both re-read") { !phoneA.isReReading && !phoneB.isReReading }
        // Two reads to open the screens, one re-read per reading.
        #expect(reads.value == 4)
        #expect(probe1(liveA).target == "Target 165 °F")
        #expect(probe1(liveB).reached != nil)

        // Wrap done: phone A sets the finish target.
        let edit = try #require(phoneA.editTargets())
        edit[target: .probe1] = "203"
        _ = try #require(await edit.save())
        #expect(probe1(liveA).target == "Target 203 °F")
        #expect(probe1(liveA).reached == nil)
        // Phone B has not read the cook since: it still shows the old target.
        #expect(probe1(liveB).target == "Target 165 °F")

        // Its next reading re-reads the cook, with no refresh.
        try #require(hubsB.latest).emit(LiveFixtures.temperature(at: 10, grill: 230, probe1: 171))
        await until("phone B re-read") { phoneB.cook?.targetTemps?.probe1 == 203 }
        #expect(probe1(liveB).target == "Target 203 °F")
        #expect(probe1(liveB).reached == nil)
        phoneA.disappear()
        phoneB.disappear()
    }

    @Test("readings during a re-read cost one more re-read, not one each; a failed re-read keeps the cook on screen")
    func reReadsAreSingleFlight() async throws {
        let active = CookFixtures.cook("c1", device: "box", status: .active)
        let reads = Box(0)
        let gate = Gate()
        let (_, detail, hubs) = await Self.models(active: active) { _ in
            reads.value += 1
            if reads.value == 2 { await gate.pass() }
            if reads.value == 3 { return .internalServerError(.init(body: .json(CookFixtures.error(.internalServerError, "boom")))) }
            return .ok(.init(body: .json(active)))
        }
        detail.appear()
        await detail.start()
        let live = try #require(detail.live)
        await until("connected") { live.status == .connected }
        let hub = try #require(hubs.latest)

        hub.emit(LiveFixtures.temperature(at: 5))
        await gate.waitUntilEntered()
        hub.emit(LiveFixtures.temperature(at: 10))
        hub.emit(LiveFixtures.temperature(at: 15))
        #expect(reads.value == 2)
        gate.open()
        await until("the re-reads finished") { reads.value >= 3 && !detail.isReReading }
        #expect(reads.value == 3)
        #expect(detail.cook == active)
        #expect(detail.live === live)
        detail.disappear()
    }

    @Test("a re-read answered after the cook stopped on this screen is dropped: the cook stays stopped")
    func staleReReadIsDropped() async throws {
        let active = CookFixtures.cook("c1", device: "box", status: .active)
        var stopped = active
        stopped.status = .completed
        stopped.endTime = fixedNow
        let reads = Box(0)
        let gate = Gate()
        let (_, detail, hubs) = await Self.models(active: active) { _ in
            reads.value += 1
            if reads.value == 2 { await gate.pass() }
            return .ok(.init(body: .json(active)))
        }
        detail.appear()
        await detail.start()
        let live = try #require(detail.live)
        await until("connected") { live.status == .connected }

        try #require(hubs.latest).emit(LiveFixtures.temperature(at: 5))
        await gate.waitUntilEntered()
        try #require(hubs.latest).emit(LiveFixtures.cookStopped(stopped))
        #expect(detail.cook == stopped)
        gate.open()
        await until("the re-read answered") { !detail.isReReading }
        #expect(detail.cook == stopped)
        #expect(detail.live == nil)
        #expect(hubs.hubs.count == 1)
        detail.disappear()
    }

    @Test("a re-read answered after a reload of the still-active cook is dropped: the newer cook stays")
    func reReadOlderThanReloadIsDropped() async throws {
        var active = CookFixtures.cook("c1", device: "box", status: .active)
        active.targetTemps = .init(probe1: 203)
        var older = active
        older.targetsReached = .init(probe1: .init(reachedAt: fixedNow))
        var newer = active
        newer.targetTemps = .init(probe1: 210)
        let served = (active: active, older: older, newer: newer)
        let reads = Box(0)
        let gate = Gate()
        let (_, detail, hubs) = await Self.models(active: active) { _ in
            reads.value += 1
            switch reads.value {
            case 2:
                // The re-read after the reading: held, then answers with
                // the cook as it was before the reload.
                await gate.pass()
                return .ok(.init(body: .json(served.older)))
            case 3: return .ok(.init(body: .json(served.newer)))
            default: return .ok(.init(body: .json(served.active)))
            }
        }
        detail.appear()
        await detail.start()
        let live = try #require(detail.live)
        await until("connected") { live.status == .connected }

        try #require(hubs.latest).emit(LiveFixtures.temperature(at: 5, probe1: 205))
        await gate.waitUntilEntered()
        await detail.reload()
        #expect(detail.cook == newer)
        gate.open()
        await until("the re-read answered") { !detail.isReReading }
        #expect(reads.value == 3)
        #expect(detail.cook == newer)
        #expect(detail.live === live)
        #expect(live.targets == newer.targetTemps)
        #expect(live.reached == nil)
        detail.disappear()
    }

    @Test("a completed cook has no live panel; without live services there is none")
    func noPanel() async {
        let done = CookFixtures.cook("c2", device: "box", status: .completed)
        let (_, detail, hubs) = await Self.models(active: done)
        detail.appear()
        await detail.start()
        #expect(detail.live == nil)
        #expect(hubs.hubs.isEmpty)

        let active = CookFixtures.cook("c3", device: "box", status: .active)
        var api = CookFixtures.api(active: [active])
        api.getCookHandler = { _ in .ok(.init(body: .json(active))) }
        let (_, _, plain) = await CookFixtures.models(api)
        let noLive = CookDetailModel(cookID: "c3", cooks: plain)
        await noLive.start()
        #expect(noLive.isActive)
        #expect(noLive.live == nil)
    }

    @Test("the screen in the background: the panel made after the cook loads follows the scene phase")
    func backgroundBeforeLoad() async throws {
        let active = CookFixtures.cook("c1", device: "box", status: .active)
        let (_, detail, hubs) = await Self.models(active: active)
        detail.setAppActive(false)
        detail.appear()
        await detail.start()
        let live = try #require(detail.live)
        #expect(!live.isConnected)
        #expect(hubs.hubs.isEmpty)
        detail.setAppActive(true)
        await until("connected") { live.status == .connected }
        detail.disappear()
        #expect(try #require(hubs.latest).stops == 1)
    }
}

// MARK: - UI test mode's hub

@Suite("UI test mode's live hub")
@MainActor
struct StubLiveTests {
    @Test("a started cook gets pushed readings; drop, reconnect, stale clock and cook_stopped hooks")
    func flow() async throws {
        let clock = StubClock()
        let (api, live) = StubAPI.uiTestWithLive(clock: clock)
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let devices = DevicesModel(session: session, now: { clock.now })
        await devices.start()
        let cooks = CooksModel(devices: devices, now: { clock.now }, live: live.services)
        let device = try #require(devices.device(id: StubDevices.connectedID))
        let form = StartCookModel(device: device, cooks: cooks)
        form.input = StartCookInput(name: "Live Brisket", meatType: "beef")
        let cook = try #require(await form.submit())

        let detail = CookDetailModel(cookID: cook.id, cooks: cooks)
        detail.appear()
        await detail.start()
        let panel = try #require(detail.live)
        #expect(panel.testControls === live)

        func grill() -> String? { panel.display().channels.first { $0.channel == .grill }?.text }
        await until("the first push") { grill() == "225 °F" }
        let shown = panel.display()
        #expect(shown.state == .live)
        #expect(shown.channels.map(\.text) == ["225 °F", "150 °F", "—", "—", "—"])
        #expect(live.openConnections == 1)

        live.dropConnection()
        #expect(panel.display().badge == "Reconnecting…")
        #expect(live.openConnections == 0)
        live.reconnectNow()
        await until("the push on the new connection") { grill() == "226 °F" }
        #expect(panel.display().state == .live)
        #expect(live.openConnections == 1)

        live.advanceClock(by: 180)
        #expect(panel.display().badge.hasPrefix("No reading for 2 min 59 s"))
        #expect(panel.display().state == .stale)

        await live.sendCookStopped(cookID: cook.id)
        #expect(detail.cook?.status == .completed)
        #expect(detail.live == nil)
        #expect(live.openConnections == 0)
        #expect(cooks.devices.activeCook(for: device) == nil)
        // Already stopped: nothing more is sent.
        await live.sendCookStopped(cookID: cook.id)
    }

    @Test("negotiate numbers its tokens; the current reading is 404 until a push")
    func routes() async throws {
        let (api, _) = StubAPI.uiTestWithLive(clock: StubClock())
        guard case .ok(let first) = try await api.negotiate(),
              case .ok(let second) = try await api.negotiate() else {
            Issue.record("negotiate did not answer 200")
            return
        }
        #expect(try first.body.json.accessToken == "stub-token-1")
        #expect(try second.body.json.accessToken == "stub-token-2")
        #expect(try first.body.json.url == StubLive.hubURL)
        guard case .notFound = try await api.getCurrentTemperatures(path: .init(deviceId: StubDevices.connectedID)) else {
            Issue.record("expected 404 before any push")
            return
        }
    }
}
