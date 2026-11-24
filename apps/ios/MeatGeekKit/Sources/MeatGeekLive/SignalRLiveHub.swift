import Foundation
public import MeatGeekKit
import MeatGeekAPI
@preconcurrency public import SignalRClient

/// A `LiveHub` over the SignalR client (SignalR-Client-Swift): the URL and
/// the access token come from `POST /negotiate`, the token goes to the hub's
/// access-token provider, messages use the JSON hub protocol and decode into
/// the generated `TemperatureMessage` and `CookStoppedMessage`. Mirrors
/// `createSignalRHub` in apps/web/src/live/hub.ts.
///
/// The client's automatic reconnect (0, 2, 10, 30 s) handles short drops.
/// When the negotiate token expires (60 minutes) reconnecting fails, the
/// connection closes, and `LiveConnection` negotiates again for a new token.
///
/// The client calls back on the main queue (its default callback queue, set
/// here explicitly), so every handler runs on the main actor.
@MainActor
public final class SignalRLiveHub: LiveHub {
    /// The app's hub factory.
    public static let factory: LiveHubFactory = { info in SignalRLiveHub(info: info) }

    private enum Phase {
        case idle, starting, started, closed, stopped
    }

    private let connection: HubConnection?
    private let events: Events
    private var phase = Phase.idle
    private var startContinuation: CheckedContinuation<Void, any Error>?
    private var reconnecting: [@MainActor () -> Void] = []
    private var reconnected: [@MainActor () -> Void] = []
    private var closed: [@MainActor () -> Void] = []

    public init(info: SignalRConnectionInfo) {
        let events = Events()
        self.events = events
        let token = info.accessToken
        connection = URL(string: info.url).map { url in
            HubConnectionBuilder(url: url)
                .withHubProtocol(hubProtocolFactory: { logger in LiveHubProtocol.make(logger: logger) })
                .withHttpConnectionOptions { options in
                    options.accessTokenProvider = { token }
                }
                .withHubConnectionOptions { options in
                    options.callbackQueue = .main
                }
                .withAutoReconnect()
                .withHubConnectionDelegate(delegate: events)
                .withLogging(minLogLevel: .warning)
                .build()
        }
        events.hub = self
    }

    public func onTemperature(_ handler: @escaping @MainActor (TemperatureMessage) -> Void) {
        on(LiveHubProtocol.temperatureTarget, TemperatureMessage.self, handler)
    }

    public func onCookStopped(_ handler: @escaping @MainActor (CookStoppedMessage) -> Void) {
        on(LiveHubProtocol.cookStoppedTarget, CookStoppedMessage.self, handler)
    }

    public func onReconnecting(_ handler: @escaping @MainActor () -> Void) { reconnecting.append(handler) }
    public func onReconnected(_ handler: @escaping @MainActor () -> Void) { reconnected.append(handler) }
    public func onClose(_ handler: @escaping @MainActor () -> Void) { closed.append(handler) }

    public func start() async throws {
        guard phase == .idle else { throw SignalRError.invalidOperation(message: "The hub was already started.") }
        guard let connection else {
            phase = .closed
            throw SignalRError.invalidOperation(message: "The negotiate URL is not a URL.")
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            startContinuation = continuation
            phase = .starting
            connection.start()
        }
    }

    public func stop() {
        guard phase != .stopped else { return }
        let wasOpen = phase == .starting || phase == .started
        phase = .stopped
        finishStart(throwing: CancellationError())
        if wasOpen { connection?.stop() }
    }

    /// Registers `handler` for `target`, decoding its one argument as `type`.
    /// A message that does not decode is dropped (the client logs it).
    private func on<Message: Decodable & Sendable>(
        _ target: String, _ type: Message.Type, _ handler: @escaping @MainActor (Message) -> Void
    ) {
        connection?.on(method: target) { [weak self] arguments in
            let message = try arguments.getArgument(type: type)
            MainActor.assumeIsolated {
                guard let self, self.phase == .started else { return }
                handler(message)
            }
        }
    }

    private func finishStart(throwing error: (any Error)?) {
        guard let continuation = startContinuation else { return }
        startContinuation = nil
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }

    // MARK: Connection events, on the main queue

    fileprivate func didOpen() {
        guard phase == .starting else { return }
        phase = .started
        finishStart(throwing: nil)
    }

    fileprivate func didFailToOpen(_ error: any Error) {
        switch phase {
        case .starting:
            phase = .closed
            finishStart(throwing: error)
        case .started:
            // A reconnect whose handshake failed: the client will not try again.
            didClose()
        case .idle, .closed, .stopped:
            break
        }
    }

    fileprivate func didClose(_ error: (any Error)? = nil) {
        switch phase {
        case .starting:
            phase = .closed
            finishStart(throwing: error ?? SignalRError.connectionIsBeingClosed)
        case .started:
            phase = .closed
            for handler in closed { handler() }
        case .idle, .closed, .stopped:
            break
        }
    }

    fileprivate func willReconnect() {
        guard phase == .started else { return }
        for handler in reconnecting { handler() }
    }

    fileprivate func didReconnect() {
        guard phase == .started else { return }
        for handler in reconnected { handler() }
    }

    /// The client's delegate, on the main actor: the client calls it on its
    /// callback queue, the main queue. It holds the hub weakly: the hub holds
    /// the connection, which holds its delegate only weakly, so the hub keeps
    /// this alive.
    @MainActor
    private final class Events: @preconcurrency HubConnectionDelegate {
        weak var hub: SignalRLiveHub?

        func connectionDidOpen(hubConnection: HubConnection) { hub?.didOpen() }
        func connectionDidFailToOpen(error: any Error) { hub?.didFailToOpen(error) }
        func connectionDidClose(error: (any Error)?) { hub?.didClose(error) }
        func connectionWillReconnect(error: any Error) { hub?.willReconnect() }
        func connectionDidReconnect() { hub?.didReconnect() }
    }
}

/// The JSON hub protocol the app's hub connection uses, with the API's date
/// decoding (`APIClientFactory.makeJSONDecoder()`): hub messages carry
/// `toISOString()` dates with milliseconds, which a plain `JSONDecoder`
/// rejects.
public enum LiveHubProtocol {
    /// The SignalR targets the panel listens to (`x-signalr` messages).
    public static let temperatureTarget = "temperature"
    public static let cookStoppedTarget = "cook_stopped"

    public static func make(logger: any Logger = NullLogger()) -> JSONHubProtocol {
        JSONHubProtocol(logger: logger, decoder: APIClientFactory.makeJSONDecoder())
    }
}
