import Foundation
import MeatGeekAPI

/// UI test mode's clock: `UITestMode.fixedNow` until a UI test moves it on
/// with `StubLive.advanceClock(by:)`. Read from any thread.
public final class StubClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    public init(start: Date = UITestMode.fixedNow) {
        current = start
    }

    public var now: Date { lock.withLock { current } }

    public func advance(by seconds: TimeInterval) {
        lock.withLock { current = current.addingTimeInterval(seconds) }
    }
}

/// The SignalR side of UI test mode, in process, over the same `StubCooks`
/// the cook routes use:
///
/// - `POST /negotiate` answers a stub URL and a numbered token;
/// - each hub it hands out, once started, is pushed a `temperature` message
///   for every device with an active cook: grill and probe 1 values (225 °F
///   and 150 °F, one degree more each push), probes 2–4 absent;
/// - `GET /temperatures/current/{deviceId}` answers the last reading pushed
///   for the device, or 404 NO_READINGS;
/// - the retry wait after a close lasts until `reconnectNow()`, so a UI test
///   sees "Reconnecting…" for as long as it needs.
///
/// The test hooks (`dropConnection()`, `reconnectNow()`,
/// `sendCookStopped(cookID:)`, `advanceClock(by:)`) are shown on the cook
/// screen in UI test mode only.
@MainActor
public final class StubLive {
    public nonisolated static let firstGrill = 225.0
    public nonisolated static let firstProbe1 = 150.0
    public nonisolated static let hubURL = "https://stub.invalid/client/?hub=temperatureHub"

    private let cooks: StubCooks
    private let clock: StubClock
    /// Started hubs that have not closed.
    private var open: [StubLiveHub] = []
    private var pushes = 0
    private var negotiations = 0
    private var latest: [String: TemperatureReading] = [:]
    private var retryWaiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
    /// `reconnectNow()` calls that came before the retry wait began.
    private var earlyReconnects = 0

    public init(cooks: StubCooks, clock: StubClock) {
        self.cooks = cooks
        self.clock = clock
    }

    /// What the live panel connects with in UI test mode.
    public var services: LiveServices {
        LiveServices(
            createHub: { [self] _ in StubLiveHub(owner: self) },
            sleep: { [self] _ in try await self.waitForReconnect() },
            testControls: self
        )
    }

    /// How many hubs are connected now.
    public var openConnections: Int { open.count }

    // MARK: Routes

    /// `POST /negotiate`.
    func negotiate() -> Operations.Negotiate.Output {
        negotiations += 1
        return .ok(.init(body: .json(.init(url: Self.hubURL, accessToken: "stub-token-\(negotiations)"))))
    }

    /// `GET /temperatures/current/{deviceId}`.
    func current(_ input: Operations.GetCurrentTemperatures.Input) -> Operations.GetCurrentTemperatures.Output {
        guard let reading = latest[input.path.deviceId] else {
            return .notFound(.init(body: .json(.init(
                error: .noReadings, message: "No readings for this device", requestId: StubDevices.requestID
            ))))
        }
        return .ok(.init(body: .json(reading)))
    }

    // MARK: Test hooks

    /// The connection drops and automatic reconnect gives up: every open hub
    /// closes. The panel then waits to negotiate again until `reconnectNow()`.
    public func dropConnection() {
        let closing = open
        open.removeAll()
        for hub in closing { hub.close() }
    }

    /// Ends the retry wait now: the panel negotiates again and starts a new
    /// connection. If the wait has not begun yet, it ends as soon as it does.
    public func reconnectNow() {
        guard !retryWaiters.isEmpty else {
            earlyReconnects += 1
            return
        }
        let waiters = retryWaiters
        retryWaiters.removeAll()
        for continuation in waiters.values { continuation.resume() }
    }

    /// Stops the cook, as another client would, and sends `cook_stopped` to
    /// every open hub. Does nothing for a cook that is not active.
    public func sendCookStopped(cookID: String) async {
        guard case .ok(let found) = await cooks.get(.init(path: .init(cookId: cookID))),
              let cook = try? found.body.json, cook.status == .active,
              case .ok(let stopped) = await cooks.stop(.init(path: .init(cookId: cookID))),
              let payload = try? stopped.body.json
        else { return }
        let message = CookStoppedMessage(
            _type: .cookStopped,
            timestamp: clock.now,
            messageId: UUID().uuidString.lowercased(),
            deviceId: payload.deviceId,
            userId: payload.userId,
            correlation: .init(id: StubDevices.requestID),
            payload: payload
        )
        for hub in open { hub.emit(message) }
    }

    /// Moves UI test mode's clock on: with no new reading, the panel goes
    /// stale ("No reading for …").
    public func advanceClock(by seconds: TimeInterval) {
        clock.advance(by: seconds)
    }

    // MARK: Hubs

    fileprivate func started(_ hub: StubLiveHub) {
        open.append(hub)
        // "Shortly after the panel connects": on the main actor's next turn,
        // after LiveConnection has seen the start succeed.
        Task { await self.push() }
    }

    fileprivate func stopped(_ hub: StubLiveHub) {
        open.removeAll { $0 === hub }
    }

    /// One reading for each device with an active cook, to every open hub.
    private func push() async {
        let devices = await cooks.activeDeviceIDs()
        for deviceID in devices {
            pushes += 1
            // A millisecond later each push, so the newest always wins over a
            // backfill on the same (fixed) clock.
            let at = clock.now.addingTimeInterval(Double(pushes) / 1000)
            let timestamp = (try? APIDateTranscoder().encode(at)) ?? ""
            let grill = Self.firstGrill + Double(pushes - 1)
            let probe1 = Self.firstProbe1 + Double(pushes - 1)
            latest[deviceID] = TemperatureReading(
                deviceId: deviceID, timestamp: timestamp, grillTemp: grill, probe1Temp: probe1
            )
            let message = TemperatureMessage(
                deviceId: deviceID, timestamp: timestamp, grillTemp: grill, probe1Temp: probe1, enqueuedTimeUtc: at
            )
            for hub in open { hub.emit(message) }
        }
    }

    private func waitForReconnect() async throws {
        if earlyReconnects > 0 {
            earlyReconnects -= 1
            return
        }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    retryWaiters[id] = continuation
                }
            }
        } onCancel: {
            Task { @MainActor in self.cancelWaiter(id) }
        }
    }

    private func cancelWaiter(_ id: UUID) {
        retryWaiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}

/// A hub UI test mode hands out: connects at once, and receives what
/// `StubLive` sends.
@MainActor
final class StubLiveHub: LiveHub {
    private weak var owner: StubLive?
    private var temperature: [@MainActor (TemperatureMessage) -> Void] = []
    private var cookStopped: [@MainActor (CookStoppedMessage) -> Void] = []
    private var reconnecting: [@MainActor () -> Void] = []
    private var reconnected: [@MainActor () -> Void] = []
    private var closed: [@MainActor () -> Void] = []
    private var isOpen = false

    init(owner: StubLive) {
        self.owner = owner
    }

    func onTemperature(_ handler: @escaping @MainActor (TemperatureMessage) -> Void) { temperature.append(handler) }
    func onCookStopped(_ handler: @escaping @MainActor (CookStoppedMessage) -> Void) { cookStopped.append(handler) }
    func onReconnecting(_ handler: @escaping @MainActor () -> Void) { reconnecting.append(handler) }
    func onReconnected(_ handler: @escaping @MainActor () -> Void) { reconnected.append(handler) }
    func onClose(_ handler: @escaping @MainActor () -> Void) { closed.append(handler) }

    func start() async throws {
        isOpen = true
        owner?.started(self)
    }

    func stop() {
        guard isOpen else { return }
        isOpen = false
        owner?.stopped(self)
    }

    func emit(_ message: TemperatureMessage) {
        guard isOpen else { return }
        for handler in temperature { handler(message) }
    }

    func emit(_ message: CookStoppedMessage) {
        guard isOpen else { return }
        for handler in cookStopped { handler(message) }
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
        for handler in closed { handler() }
    }
}
