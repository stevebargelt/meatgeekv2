import Foundation

/// - `connecting`: the first negotiate and start are in flight.
/// - `connected`: the hub is connected.
/// - `reconnecting`: automatic reconnect is running, or the connection closed
///   and the next negotiate is waiting for its backoff.
/// - `signedOut`: negotiate answered 401; nothing more is tried.
public enum LiveConnectionStatus: Equatable, Sendable {
    case connecting
    case connected
    case reconnecting
    case signedOut
}

/// What `POST /negotiate` answered.
public enum NegotiateResult: Sendable {
    case ok(SignalRConnectionInfo)
    /// Any failure: `status` is the HTTP status, nil for a network error or
    /// an answer that could not be read.
    case failed(status: Int?)
}

/// Keeps one hub connection open until `stop()`. A port of
/// `openLiveConnection` in apps/web/src/live/live-connection.ts.
///
/// The hub's own automatic reconnect handles short drops. When it gives up
/// and the connection closes, or when negotiate or start fails (a 429, a 503,
/// a network error), this negotiates again for a fresh token and starts a new
/// connection after 2, 5, 10, then every 30 s (`retryDelays`), and starts the
/// backoff over after a successful start. A 401 from negotiate stops it: only
/// signing in again can fix that. Callbacks from a connection that was
/// replaced or stopped are ignored.
///
/// Each retry wait is a `Task` sleeping on the injected `LiveSleep`; `stop()`
/// cancels it.
@MainActor
public final class LiveConnection {
    /// Waits before each new negotiate after a failure or a close; the last
    /// repeats forever (`RETRY_DELAYS_MS`).
    public nonisolated static let retryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(10), .seconds(30)]

    public struct Handlers {
        public var onStatus: @MainActor (LiveConnectionStatus) -> Void
        /// After every successful start and every automatic reconnect.
        public var onConnected: @MainActor () -> Void
        public var onTemperature: @MainActor (TemperatureMessage) -> Void
        public var onCookStopped: @MainActor (CookStoppedMessage) -> Void

        public init(
            onStatus: @escaping @MainActor (LiveConnectionStatus) -> Void = { _ in },
            onConnected: @escaping @MainActor () -> Void = {},
            onTemperature: @escaping @MainActor (TemperatureMessage) -> Void = { _ in },
            onCookStopped: @escaping @MainActor (CookStoppedMessage) -> Void = { _ in }
        ) {
            self.onStatus = onStatus
            self.onConnected = onConnected
            self.onTemperature = onTemperature
            self.onCookStopped = onCookStopped
        }
    }

    private let negotiate: @MainActor () async -> NegotiateResult
    private let createHub: LiveHubFactory
    private let sleep: LiveSleep
    private let handlers: Handlers

    private var started = false
    private var stopped = false
    private var hub: (any LiveHub)?
    /// The negotiate-and-start in flight, or the retry wait before the next.
    private var task: Task<Void, Never>?
    private var failures = 0

    /// - Parameters:
    ///   - negotiate: `POST /negotiate`.
    ///   - createHub: builds a connection from the negotiate answer.
    ///   - sleep: the wait before each retry.
    public init(
        negotiate: @escaping @MainActor () async -> NegotiateResult,
        createHub: @escaping LiveHubFactory,
        sleep: @escaping LiveSleep,
        handlers: Handlers
    ) {
        self.negotiate = negotiate
        self.createHub = createHub
        self.sleep = sleep
        self.handlers = handlers
    }

    /// Reports `connecting` and starts the first negotiate. Once only.
    public func start() {
        guard !started, !stopped else { return }
        started = true
        handlers.onStatus(.connecting)
        task = Task { [weak self] in await self?.connect() }
    }

    /// Stops the hub, cancels a pending retry, and ignores every later
    /// callback. Safe to call more than once.
    public func stop() {
        guard !stopped else { return }
        stopped = true
        task?.cancel()
        task = nil
        let last = hub
        hub = nil
        last?.stop()
    }

    private func connect() async {
        let result = await negotiate()
        if stopped { return }
        let info: SignalRConnectionInfo
        switch result {
        case .failed(status: 401):
            handlers.onStatus(.signedOut)
            return
        case .failed:
            retryLater()
            return
        case .ok(let answer):
            info = answer
        }

        let current = createHub(info)
        hub = current
        let id = ObjectIdentifier(current)
        // Handlers hold the connection weakly: the hub holds them, and this
        // holds the hub.
        let isCurrent: @MainActor () -> Bool = { [weak self] in
            guard let self, !self.stopped, let hub = self.hub else { return false }
            return ObjectIdentifier(hub) == id
        }
        let dropAndRetry: @MainActor () -> Void = { [weak self] in
            guard let self, isCurrent() else { return }
            self.hub = nil
            self.retryLater()
        }

        current.onTemperature { [weak self] message in
            if isCurrent() { self?.handlers.onTemperature(message) }
        }
        current.onCookStopped { [weak self] message in
            if isCurrent() { self?.handlers.onCookStopped(message) }
        }
        current.onReconnecting { [weak self] in
            if isCurrent() { self?.handlers.onStatus(.reconnecting) }
        }
        current.onReconnected { [weak self] in
            guard let self, isCurrent() else { return }
            self.handlers.onStatus(.connected)
            self.handlers.onConnected()
        }
        current.onClose(dropAndRetry)

        do {
            try await current.start()
        } catch {
            dropAndRetry()
            return
        }
        guard isCurrent() else { return }
        failures = 0
        handlers.onStatus(.connected)
        handlers.onConnected()
    }

    private func retryLater() {
        guard !stopped else { return }
        let delay = Self.retryDelays[min(failures, Self.retryDelays.count - 1)]
        failures += 1
        handlers.onStatus(.reconnecting)
        let sleep = self.sleep
        task = Task { [weak self] in
            do {
                try await sleep(delay)
            } catch {
                return
            }
            guard let self, !Task.isCancelled, !self.stopped else { return }
            await self.connect()
        }
    }
}

extension SessionModel {
    /// `POST /negotiate` through the generated client and the session, so a
    /// 401 here ends the session as it does for every other call.
    func negotiateLive() async -> NegotiateResult {
        do {
            let output = try await perform { api in try await api.negotiate() }
            switch output {
            case .ok(let ok):
                guard let info = try? ok.body.json else { return .failed(status: nil) }
                return .ok(info)
            case .unauthorized:
                endSession()
                return .failed(status: 401)
            case .serviceUnavailable:
                return .failed(status: 503)
            case .undocumented(let status, _):
                return .failed(status: status)
            }
        } catch SessionError.sessionEnded, SessionError.notSignedIn {
            return .failed(status: 401)
        } catch {
            return .failed(status: nil)
        }
    }
}
