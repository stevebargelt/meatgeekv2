import Foundation
public import MeatGeekAPI

/// The lock-screen activity's data (#271), generated from the spec's
/// `CookActivityAttributes` and `CookActivityContentState`
/// (libs/api-specs/spec/components/schemas/live-activity.yaml), so a push
/// from the server and the app's own updates carry the same JSON.
public typealias CookActivityAttributes = Components.Schemas.CookActivityAttributes
public typealias CookActivityContentState = Components.Schemas.CookActivityContentState

/// `meatgeek://cook/<id>`: what tapping a cook's lock-screen activity opens.
public enum CookLink {
    public static let scheme = "meatgeek"
    static let host = "cook"

    public static func url(cookID: String) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.path = "/" + cookID
        // A cook id is a UUID, so this cannot fail; the fallback is the bare scheme.
        return components.url ?? URL(string: "\(scheme)://\(host)")!
    }

    /// The cook a link opens; nil for any other URL.
    public static func cookID(from url: URL) -> String? {
        guard url.scheme == scheme, url.host() == host else { return nil }
        let id = url.path().split(separator: "/").first.map(String.init) ?? ""
        return id.isEmpty ? nil : id.removingPercentEncoding ?? id
    }
}

/// What the lock-screen view shows: plain text and a start date, nothing to
/// decide. Made by `CookActivityPresenter.present(_:_:)`.
public struct CookActivityPresentation: Equatable, Sendable {
    public let cookName: String
    /// The elapsed time ticks from here; nil when the start time does not parse.
    public let startedAt: Date?
    /// "224° / 225°": the grill's reading against its target; "224°" with no
    /// target, "—" with no reading.
    public let grill: String
    /// Each probe that has a reading, in order: "187° → 203°", or "187°"
    /// with no target.
    public let probes: [Probe]
    /// Opens the cook's live screen.
    public let url: URL

    public struct Probe: Equatable, Sendable, Identifiable {
        public let label: String
        public let text: String
        public var id: String { label }

        public init(label: String, text: String) {
            self.label = label
            self.text = text
        }
    }

    public init(cookName: String, startedAt: Date?, grill: String, probes: [Probe], url: URL) {
        self.cookName = cookName
        self.startedAt = startedAt
        self.grill = grill
        self.probes = probes
        self.url = url
    }
}

/// Everything that decides what the lock-screen activity holds and shows.
public enum CookActivityPresenter {
    /// The probes, in order.
    static let probeChannels: [LiveChannel] = [.probe1, .probe2, .probe3, .probe4]

    /// A cook's attributes: its id, name and start.
    public static func attributes(for cook: Cook) -> CookActivityAttributes {
        CookActivityAttributes(
            cookId: cook.id,
            cookName: cook.name,
            startTime: (try? APIDateTranscoder().encode(cook.startTime)) ?? ""
        )
    }

    /// The cook's targets and the latest reading (nil: none yet), with the
    /// device's unit.
    public static func content(for cook: Cook, reading: LiveReading?, unit: TemperatureUnit) -> CookActivityContentState {
        CookActivityContentState(
            grillTemp: reading?.grill,
            probe1Temp: reading?.probe1,
            probe2Temp: reading?.probe2,
            probe3Temp: reading?.probe3,
            probe4Temp: reading?.probe4,
            targetTemps: cook.targetTemps,
            temperatureUnit: unit,
            readingTime: reading?.timestamp
        )
    }

    public static func present(_ attributes: CookActivityAttributes, _ state: CookActivityContentState) -> CookActivityPresentation {
        let unit = state.temperatureUnit
        let grill = row(state.grillTemp, target: state.targetTemps?.grill, unit: unit, separator: " / ")
        let probes = probeChannels.compactMap { channel -> CookActivityPresentation.Probe? in
            guard let value = value(channel, in: state) else { return nil }
            let target = channel.targetKey.value(in: state.targetTemps)
            return .init(label: channel.label, text: row(value, target: target, unit: unit, separator: " → "))
        }
        return CookActivityPresentation(
            cookName: attributes.cookName,
            startedAt: try? APIDateTranscoder().decode(attributes.startTime),
            grill: grill,
            probes: probes,
            url: CookLink.url(cookID: attributes.cookId)
        )
    }

    /// A °F value in `unit`, whole degrees with the degree sign: "224°";
    /// "—" for no value.
    public static func degrees(_ fahrenheit: Double?, unit: TemperatureUnit) -> String {
        guard let fahrenheit else { return "—" }
        let value = unit == .celsius ? (fahrenheit - 32) * 5 / 9 : fahrenheit
        // Half up, as the live panel rounds; never "-0°".
        let whole = Int((value + 0.5).rounded(.down))
        return "\(whole)°"
    }

    private static func row(_ value: Double?, target: Double?, unit: TemperatureUnit, separator: String) -> String {
        let reading = degrees(value, unit: unit)
        guard let target else { return reading }
        return reading + separator + degrees(target, unit: unit)
    }

    private static func value(_ channel: LiveChannel, in state: CookActivityContentState) -> Double? {
        switch channel {
        case .grill: state.grillTemp
        case .probe1: state.probe1Temp
        case .probe2: state.probe2Temp
        case .probe3: state.probe3Temp
        case .probe4: state.probe4Temp
        }
    }
}

/// An activity the system is showing.
public struct RunningCookActivity: Equatable, Sendable {
    public let id: String
    public let cookID: String

    public init(id: String, cookID: String) {
        self.id = id
        self.cookID = cookID
    }
}

/// The port to the lock-screen activities. The app's is
/// `ActivityKitLiveActivities` (MeatGeekActivity, over ActivityKit); UI test
/// mode's is `StubLiveActivities`; unit tests use a fake.
@MainActor
public protocol LiveActivities: AnyObject {
    /// The activities showing now, including any from an earlier launch.
    func running() -> [RunningCookActivity]
    /// Shows a new activity; returns its id. Throws when the system refuses,
    /// as it does when Live Activities are off in Settings.
    func start(_ attributes: CookActivityAttributes, _ state: CookActivityContentState) throws -> String
    func update(_ id: String, _ state: CookActivityContentState)
    /// Ends the activity, showing `state`, and takes it off the lock screen.
    func end(_ id: String, _ state: CookActivityContentState)
    /// The tokens for starting an activity by push, as the system issues them.
    var pushToStartTokens: AsyncStream<Data> { get }
    /// An activity's tokens for updating it by push.
    func pushTokens(_ id: String) -> AsyncStream<Data>
}

/// UI test mode's activities: in memory, never shown, never refused.
@MainActor
public final class StubLiveActivities: LiveActivities {
    public private(set) var activities: [String: (attributes: CookActivityAttributes, state: CookActivityContentState)] = [:]
    private var next = 0

    public init() {}

    public func running() -> [RunningCookActivity] {
        activities.map { RunningCookActivity(id: $0.key, cookID: $0.value.attributes.cookId) }
    }

    public func start(_ attributes: CookActivityAttributes, _ state: CookActivityContentState) throws -> String {
        next += 1
        let id = "stub-activity-\(next)"
        activities[id] = (attributes, state)
        return id
    }

    public func update(_ id: String, _ state: CookActivityContentState) {
        activities[id]?.state = state
    }

    public func end(_ id: String, _ state: CookActivityContentState) {
        activities[id] = nil
    }

    public var pushToStartTokens: AsyncStream<Data> { AsyncStream { $0.finish() } }

    public func pushTokens(_ id: String) -> AsyncStream<Data> { AsyncStream { $0.finish() } }
}
