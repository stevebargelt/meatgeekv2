import Foundation
public import MeatGeekAPI

/// The hub messages, typed from the spec's `x-signalr` schemas (generated,
/// like every other API type).
public typealias TemperatureMessage = Components.Schemas.TemperatureMessage
public typealias CookStoppedMessage = Components.Schemas.CookStoppedMessage
public typealias SignalRConnectionInfo = Components.Schemas.SignalRConnectionInfo
public typealias TemperatureReading = Components.Schemas.TemperatureReading
public typealias TemperatureUnit = Components.Schemas.TemperatureUnit

/// One SignalR connection: the slice of a hub connection the live panel uses.
/// Mirrors `LiveHub` in apps/web/src/live/hub.ts.
///
/// The app's is `SignalRLiveHub` (MeatGeekLive), over the SignalR client;
/// UI test mode's is `StubLiveHub`; unit tests use a fake. Everything happens
/// on the main actor: handlers are called there, in the order the hub
/// delivers them.
@MainActor
public protocol LiveHub: AnyObject {
    /// The `temperature` target.
    func onTemperature(_ handler: @escaping @MainActor (TemperatureMessage) -> Void)
    /// The `cook_stopped` target.
    func onCookStopped(_ handler: @escaping @MainActor (CookStoppedMessage) -> Void)
    /// Automatic reconnect has started.
    func onReconnecting(_ handler: @escaping @MainActor () -> Void)
    /// Automatic reconnect succeeded.
    func onReconnected(_ handler: @escaping @MainActor () -> Void)
    /// The connection closed for good: automatic reconnect gave up, or it
    /// dropped after starting.
    func onClose(_ handler: @escaping @MainActor () -> Void)
    /// Connects; throws if the connection cannot be opened.
    func start() async throws
    /// Disconnects. A `start()` still in flight throws.
    func stop()
}

/// Builds a connection from what `POST /negotiate` returned: the hub URL and
/// the access token the hub's access-token provider returns.
public typealias LiveHubFactory = @MainActor (SignalRConnectionInfo) -> any LiveHub

/// Waits `duration` before a new negotiate; throws `CancellationError` when
/// the waiting task is cancelled. The app's is `Task.sleep`; tests pass a
/// virtual clock, so no test waits in real time.
public typealias LiveSleep = @Sendable (Duration) async throws -> Void

/// What the live panel connects with: the hub factory and the retry sleeper,
/// plus, in UI test mode only, the stub's test hooks.
public struct LiveServices: Sendable {
    public let createHub: LiveHubFactory
    public let sleep: LiveSleep
    /// UI test mode's controls (drop the connection, reconnect, send
    /// `cook_stopped`, move the clock). Nil in the real app.
    public let testControls: StubLive?

    public init(createHub: @escaping LiveHubFactory, sleep: @escaping LiveSleep = LiveServices.realSleep, testControls: StubLive? = nil) {
        self.createHub = createHub
        self.sleep = sleep
        self.testControls = testControls
    }

    /// `Task.sleep`: the app's retry wait.
    public static let realSleep: LiveSleep = { duration in try await Task.sleep(for: duration) }
}
