import Foundation
public import MeatGeekAPI
import Observation

/// One reading as the panel shows it: a pushed `TemperatureMessage` or the
/// backfilled `TemperatureReading` (the same fields, in °F).
public struct LiveReading: Equatable, Sendable {
    public let deviceID: String
    /// The reading's `timestamp` as the API sent it.
    public let timestamp: String
    /// `timestamp` as a date; nil if it does not parse (the API says it does).
    public let date: Date?
    public let grill: Double?
    public let probe1: Double?
    public let probe2: Double?
    public let probe3: Double?
    public let probe4: Double?

    public init(_ message: TemperatureMessage) {
        self.init(
            deviceID: message.deviceId, timestamp: message.timestamp, grill: message.grillTemp,
            probe1: message.probe1Temp, probe2: message.probe2Temp, probe3: message.probe3Temp, probe4: message.probe4Temp
        )
    }

    public init(_ reading: TemperatureReading) {
        self.init(
            deviceID: reading.deviceId, timestamp: reading.timestamp, grill: reading.grillTemp,
            probe1: reading.probe1Temp, probe2: reading.probe2Temp, probe3: reading.probe3Temp, probe4: reading.probe4Temp
        )
    }

    init(
        deviceID: String, timestamp: String, grill: Double?,
        probe1: Double?, probe2: Double?, probe3: Double?, probe4: Double?
    ) {
        self.deviceID = deviceID
        self.timestamp = timestamp
        self.date = try? APIDateTranscoder().decode(timestamp)
        self.grill = grill
        self.probe1 = probe1
        self.probe2 = probe2
        self.probe3 = probe3
        self.probe4 = probe4
    }

    /// The value of `channel`, in °F; nil when the device sent none.
    public func value(_ channel: LiveChannel) -> Double? {
        switch channel {
        case .grill: grill
        case .probe1: probe1
        case .probe2: probe2
        case .probe3: probe3
        case .probe4: probe4
        }
    }
}

/// The panel's channels, in order (`CHANNELS`).
public enum LiveChannel: String, CaseIterable, Sendable {
    case grill, probe1, probe2, probe3, probe4

    /// The channel's key in a cook's targets.
    public var targetKey: TargetKey {
        switch self {
        case .grill: .grill
        case .probe1: .probe1
        case .probe2: .probe2
        case .probe3: .probe3
        case .probe4: .probe4
        }
    }

    /// When the server recorded this channel reaching its target; nil when
    /// it has not.
    public func reachedAt(in reached: Components.Schemas.TargetsReached?) -> Date? {
        guard let reached else { return nil }
        switch self {
        case .grill: return reached.grill?.reachedAt
        case .probe1: return reached.probe1?.reachedAt
        case .probe2: return reached.probe2?.reachedAt
        case .probe3: return reached.probe3?.reachedAt
        case .probe4: return reached.probe4?.reachedAt
        }
    }

    public var label: String {
        switch self {
        case .grill: "Grill"
        case .probe1: "Probe 1"
        case .probe2: "Probe 2"
        case .probe3: "Probe 3"
        case .probe4: "Probe 4"
        }
    }
}

/// `waiting`, `live` and `stale` are the panel's states; `connecting` is only
/// the first connect (`PanelState`).
public enum LivePanelState: String, Equatable, Sendable {
    case connecting, waiting, live, stale
}

/// What the panel shows at one moment.
public struct LivePanelDisplay: Equatable, Sendable {
    public let state: LivePanelState
    public let badge: String
    /// Each channel's label and value, "—" when there is none.
    public let channels: [Channel]
    /// "Reading at <time> (<age> ago)", or "No reading yet".
    public let readingTime: String
    /// Waiting for the first reading.
    public let showsWaitingNote: Bool
    /// Negotiate answered 401.
    public let showsSignedOutNote: Bool

    public struct Channel: Equatable, Sendable, Identifiable {
        public let channel: LiveChannel
        public let label: String
        public let text: String
        /// "Target 203 °F", in the device's unit; nil when the channel has
        /// no target or no reading.
        public let target: String?
        /// "✓ Reached 3:42 PM", the local time the server recorded; nil
        /// unless this probe has a target, a reading, and the server says
        /// it is reached. Never set for the grill.
        public let reached: String?
        public var id: String { channel.rawValue }

        public init(channel: LiveChannel, label: String, text: String, target: String? = nil, reached: String? = nil) {
            self.channel = channel
            self.label = label
            self.text = text
            self.target = target
            self.reached = reached
        }
    }
}

/// The live readings of an active cook's device, pushed over SignalR. A port
/// of apps/web/src/live/live-panel.tsx.
///
/// Owns one `LiveConnection` while the cook screen is on screen and the app
/// is active: `appear()`/`disappear()` follow the screen, `setAppActive(_:)`
/// the scene phase. Leaving the foreground stops the connection; coming back
/// opens a new one (negotiate again) and backfills, so a trip to the
/// background leaves neither a dead socket nor two connections.
///
/// Shows `temperature` messages for the cook's device only, and after every
/// start and reconnect backfills with `GET /temperatures/current/{deviceId}`,
/// keeping whichever reading is newer. On `cook_stopped` for this cook it
/// stops the connection and hands the stopped cook to `onCookStopped`.
///
/// Beside each reading it shows the channel's target and, for a probe, the
/// reached mark: both from the cook as the server last returned it
/// (`cookChanged(_:)`). The app runs no target rule of its own.
@MainActor
@Observable
public final class LivePanelModel {
    /// A device with no `pollingInterval` is polled every 30 s (the API's default).
    public nonisolated static let defaultPollingInterval = 30
    /// A reading older than this many polling intervals is stale.
    public nonisolated static let staleAfterIntervals = 3

    public nonisolated static let waitingNote =
        "Waiting for the first reading… After a quiet period the first one can take up to about 20 s."
    public nonisolated static let signedOutNote = "Your sign-in has expired. Sign out and sign in again."

    public let cookID: String
    public let deviceID: String

    public private(set) var status: LiveConnectionStatus = .connecting
    public private(set) var reading: LiveReading?
    /// The cook as `cook_stopped` delivered it, once this cook has stopped.
    public private(set) var stoppedCook: Cook?
    /// The cook's targets, in °F, as the server last returned them.
    public private(set) var targets: Components.Schemas.TargetTemperatures?
    /// The channels the server says have reached their target.
    public private(set) var reached: Components.Schemas.TargetsReached?

    @ObservationIgnored private let session: SessionModel
    @ObservationIgnored private let device: @MainActor () -> Device?
    @ObservationIgnored private let services: LiveServices
    /// The clock a reading's age is measured on.
    @ObservationIgnored public let now: @Sendable () -> Date
    @ObservationIgnored private let onCookStopped: @MainActor (Cook) -> Void
    @ObservationIgnored private let onReading: @MainActor (TemperatureMessage) -> Void
    @ObservationIgnored private var connection: LiveConnection?
    @ObservationIgnored private var visible = false
    @ObservationIgnored private var appActive = true
    /// Opened connections, for tests: one per foreground stretch on screen.
    @ObservationIgnored public private(set) var connectionsOpened = 0
    /// Backfills that have answered and been applied (or dropped), for tests.
    @ObservationIgnored public private(set) var backfillsAnswered = 0

    /// - Parameters:
    ///   - cook: the active cook.
    ///   - device: the cook's device, for its unit and polling interval; nil
    ///     until the devices are read.
    ///   - onCookStopped: called once with the stopped cook.
    ///   - onReading: called with each pushed `temperature` message the
    ///     panel accepts (the cook's device's), as the web's `onReading`:
    ///     the chart appends them. Backfilled readings are not passed on.
    public init(
        cook: Cook,
        session: SessionModel,
        device: @escaping @MainActor () -> Device?,
        services: LiveServices,
        now: @escaping @Sendable () -> Date,
        onCookStopped: @escaping @MainActor (Cook) -> Void = { _ in },
        onReading: @escaping @MainActor (TemperatureMessage) -> Void = { _ in }
    ) {
        self.cookID = cook.id
        self.deviceID = cook.deviceId
        self.targets = cook.targetTemps
        self.reached = cook.targetsReached
        self.session = session
        self.device = device
        self.services = services
        self.now = now
        self.onCookStopped = onCookStopped
        self.onReading = onReading
    }

    /// The UI test mode controls, when the app runs on the stub.
    public var testControls: StubLive? { services.testControls }

    /// The cook screen is showing.
    public func appear() {
        visible = true
        update()
    }

    /// The cook screen went away.
    public func disappear() {
        visible = false
        update()
    }

    /// The scene phase: active, or not (inactive or background).
    public func setAppActive(_ active: Bool) {
        appActive = active
        update()
    }

    /// The cook ended some other way (stopped from this screen): no more
    /// connections.
    public func end(with cook: Cook) {
        guard stoppedCook == nil else { return }
        stoppedCook = cook
        update()
    }

    /// The cook as the server returned it again: its targets and reached
    /// state replace the shown ones. Another cook is ignored.
    public func cookChanged(_ cook: Cook) {
        guard cook.id == cookID else { return }
        targets = cook.targetTemps
        reached = cook.targetsReached
    }

    /// Whether a connection is open (or retrying).
    public var isConnected: Bool { connection != nil }

    private func update() {
        let wanted = visible && appActive && stoppedCook == nil
        if wanted, connection == nil {
            open()
        } else if !wanted, let connection {
            connection.stop()
            self.connection = nil
        }
    }

    private func open() {
        connectionsOpened += 1
        let deviceID = self.deviceID
        let cookID = self.cookID
        let connection = LiveConnection(
            negotiate: { [weak self] in await self?.negotiate() ?? .failed(status: nil) },
            createHub: services.createHub,
            sleep: services.sleep,
            handlers: .init(
                onStatus: { [weak self] status in self?.status = status },
                onConnected: { [weak self] in
                    guard let self else { return }
                    Task { await self.backfill() }
                },
                onTemperature: { [weak self] message in
                    guard let self, message.deviceId == deviceID else { return }
                    self.show(LiveReading(message))
                    self.onReading(message)
                },
                onCookStopped: { [weak self] message in
                    guard let self, message.payload.id == cookID, self.stoppedCook == nil else { return }
                    self.stoppedCook = message.payload
                    self.update()
                    self.onCookStopped(message.payload)
                }
            )
        )
        self.connection = connection
        connection.start()
    }

    /// Keeps whichever reading is newer: a backfill can race a push.
    private func show(_ next: LiveReading) {
        if let previous = reading, let at = next.date, let before = previous.date, at < before { return }
        reading = next
    }

    /// `POST /negotiate` through the generated client and the session, so a
    /// 401 here ends the session as it does for every other call.
    private func negotiate() async -> NegotiateResult {
        do {
            let output = try await session.perform { api in try await api.negotiate() }
            switch output {
            case .ok(let ok):
                guard let info = try? ok.body.json else { return .failed(status: nil) }
                return .ok(info)
            case .unauthorized:
                session.endSession()
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

    /// `GET /temperatures/current/{deviceId}`. A 404 is "no reading yet"; any
    /// other failure leaves the screen as it is: pushes still arrive.
    private func backfill() async {
        let deviceID = self.deviceID
        defer { backfillsAnswered += 1 }
        guard let output = try? await session.perform({ api in
            try await api.getCurrentTemperatures(path: .init(deviceId: deviceID))
        }) else { return }
        switch output {
        case .ok(let ok):
            if let reading = try? ok.body.json { show(LiveReading(reading)) }
        case .unauthorized:
            session.endSession()
        default:
            break
        }
    }

    // MARK: What the panel shows

    public var unit: TemperatureUnit { device()?.configuration?.temperatureUnit ?? .fahrenheit }

    /// The device's polling interval in seconds, or the default.
    public var pollingInterval: Int { device()?.configuration?.pollingInterval ?? Self.defaultPollingInterval }

    /// A reading older than this is stale: 3 × the polling interval.
    public var staleAfter: TimeInterval { TimeInterval(Self.staleAfterIntervals * pollingInterval) }

    /// The panel at `now()`. The view re-reads it every second, so "No reading
    /// for …" advances without a new message.
    public func display() -> LivePanelDisplay {
        display(at: now())
    }

    /// - Parameters:
    ///   - locale, timeZone: how a reached time reads; the user's own by default.
    public func display(
        at now: Date, locale: Locale = .autoupdatingCurrent, timeZone: TimeZone = .autoupdatingCurrent
    ) -> LivePanelDisplay {
        let unit = self.unit
        let age = reading?.date.map { max(0, now.timeIntervalSince($0)) }
        let (state, badge) = Self.panelState(status: status, hasReading: reading != nil, age: age, staleAfter: staleAfter)
        let channels = LiveChannel.allCases.map { channel in
            let value = reading?.value(channel)
            // A channel with no reading, or no target, shows only its reading.
            let target = value == nil ? nil : channel.targetKey.value(in: targets)
            let reachedAt = target == nil || channel == .grill ? nil : channel.reachedAt(in: reached)
            return LivePanelDisplay.Channel(
                channel: channel, label: channel.label,
                text: LiveText.temperature(value, unit: unit),
                target: target.map { "Target \(LiveText.temperature($0, unit: unit))" },
                reached: reachedAt.map { "✓ Reached \(LiveText.time($0, locale: locale, timeZone: timeZone))" }
            )
        }
        let readingTime: String
        if let reading {
            let at = reading.date.map { CookText.dateTime($0) } ?? reading.timestamp
            readingTime = age.map { "Reading at \(at) (\(DurationText.text($0)) ago)" } ?? "Reading at \(at)"
        } else {
            readingTime = "No reading yet"
        }
        return LivePanelDisplay(
            state: state, badge: badge, channels: channels, readingTime: readingTime,
            showsWaitingNote: state == .waiting, showsSignedOutNote: status == .signedOut
        )
    }

    /// The state and badge (`panelState`).
    public nonisolated static func panelState(
        status: LiveConnectionStatus, hasReading: Bool, age: TimeInterval?, staleAfter: TimeInterval
    ) -> (LivePanelState, String) {
        switch status {
        case .connecting: return (.connecting, "Connecting…")
        case .reconnecting: return (.stale, "Reconnecting…")
        case .signedOut: return (.stale, "Sign in again")
        case .connected: break
        }
        guard hasReading else { return (.waiting, "Waiting") }
        if let age, age > staleAfter {
            return (.stale, "No reading for \(DurationText.text(age))")
        }
        return (.live, "Live")
    }
}

/// Temperatures in the live panel's style. Mirrors apps/web/src/live/format.ts.
public enum LiveText {
    /// A reading in the device's unit: readings arrive in °F, so a celsius
    /// device's are converted. Rounded to one decimal; "—" when the device
    /// sent no value for the channel (an unplugged probe shows blank).
    public static func temperature(_ fahrenheit: Double?, unit: TemperatureUnit) -> String {
        guard let fahrenheit else { return "—" }
        return "\(CookText.number(displayValue(fahrenheit, unit: unit))) \(symbol(unit))"
    }

    /// A °F value in the device's unit, rounded to one decimal as
    /// JavaScript's `Math.round` does (half up), never -0.
    public static func displayValue(_ fahrenheit: Double, unit: TemperatureUnit) -> Double {
        let value = unit == .celsius ? (fahrenheit - 32) * 5 / 9 : fahrenheit
        let rounded = (value * 10 + 0.5).rounded(.down) / 10
        return rounded == 0 ? 0 : rounded
    }

    /// A time of day in the user's locale and time zone, "3:42 PM".
    public static func time(_ date: Date, locale: Locale = .autoupdatingCurrent, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, timeZone: timeZone))
    }

    public static func symbol(_ unit: TemperatureUnit) -> String {
        unit == .celsius ? "°C" : "°F"
    }
}
