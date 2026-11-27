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

/// What the lock-screen and Dynamic Island views show: plain text and a
/// start date, nothing to decide. Made by `CookActivityPresenter.present`.
public struct CookActivityPresentation: Equatable, Sendable {
    public let cookName: String
    /// The elapsed time ticks from here; nil when the start time does not
    /// parse, and once the cook has ended (nothing ticks then).
    public let startedAt: Date?
    /// "224° / 225°": the grill's reading against its target; "224°" with no
    /// target, "—" with no reading. Never a reached mark.
    public let grill: String
    /// Each probe that has a reading, in order: "187° → 203°", "187°" with
    /// no target, or "204° · 203° ✓ 3:42 PM" once reached (until it re-arms).
    public let probes: [Probe]
    /// What the Dynamic Island shows.
    public let island: Island
    /// The compact island's trailing side: the island's text ("187° → 203°",
    /// "204° ✓"); "as of 3:42 PM" when stale; "Ended" once the cook has ended.
    public let islandTrailing: String
    /// The minimal island: the island channel's reading alone ("187°");
    /// "Ended" once the cook has ended.
    public let islandMinimal: String
    /// Current, stale ("as of 3:42 PM") or ended ("Cook ended").
    public let status: Status
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

    /// One channel in the Dynamic Island: "Probe 1" / "P1", "187° → 203°"
    /// (a reached probe: "204° ✓", the mark and no time).
    public struct Island: Equatable, Sendable {
        public let label: String
        /// For the compact island: "Grill" or "P1".
        public let shortLabel: String
        public let text: String

        public init(label: String, shortLabel: String, text: String) {
            self.label = label
            self.shortLabel = shortLabel
            self.text = text
        }
    }

    public enum Status: Equatable, Sendable {
        /// Updated in the last three minutes.
        case current
        /// No update for three minutes: "as of 3:42 PM", the last update's
        /// time. It does not say why.
        case stale(asOf: String)
        /// The cook has stopped; the temperatures are its last.
        case ended

        /// The line the views show for it; nil when current.
        public var note: String? {
            switch self {
            case .current: nil
            case .stale(let asOf): "as of \(asOf)"
            case .ended: "Cook ended"
            }
        }
    }

    public init(
        cookName: String, startedAt: Date?, grill: String, probes: [Probe],
        island: Island, islandTrailing: String, islandMinimal: String, status: Status = .current, url: URL
    ) {
        self.cookName = cookName
        self.startedAt = startedAt
        self.grill = grill
        self.probes = probes
        self.island = island
        self.islandTrailing = islandTrailing
        self.islandMinimal = islandMinimal
        self.status = status
        self.url = url
    }
}

/// Everything that decides what the lock-screen activity holds and shows.
public enum CookActivityPresenter {
    /// The probes, in order.
    static let probeChannels: [LiveChannel] = [.probe1, .probe2, .probe3, .probe4]

    /// An activity goes stale this long after its last update (#272).
    public static let staleAfter: TimeInterval = 3 * 60
    /// An ended activity leaves the lock screen this long after it ended.
    public static let endedDismissAfter: TimeInterval = 15 * 60

    /// A cook's attributes: its id, name and start.
    public static func attributes(for cook: Cook) -> CookActivityAttributes {
        CookActivityAttributes(
            cookId: cook.id,
            cookName: cook.name,
            startTime: (try? APIDateTranscoder().encode(cook.startTime)) ?? ""
        )
    }

    /// The cook's targets and reached probes and the latest reading (nil:
    /// none yet), with the device's unit, as sent at `now`. A cook that is
    /// not running is ended, at its `endTime`.
    public static func content(for cook: Cook, reading: LiveReading?, unit: TemperatureUnit, now: Date) -> CookActivityContentState {
        CookActivityContentState(
            grillTemp: reading?.grill,
            probe1Temp: reading?.probe1,
            probe2Temp: reading?.probe2,
            probe3Temp: reading?.probe3,
            probe4Temp: reading?.probe4,
            targetTemps: cook.targetTemps,
            temperatureUnit: unit,
            readingTime: reading?.timestamp,
            targetsReached: reached(cook),
            updatedAt: iso(now),
            ended: cook.status == .active ? nil : true,
            endedAt: cook.status == .active ? nil : cook.endTime.map(iso)
        )
    }

    /// The ended content of an activity whose cook no longer exists: what it
    /// `shown` last (its temperatures, targets and unit), ended at `now`.
    public static func gone(shown: CookActivityContentState?, now: Date) -> CookActivityContentState {
        var state = shown ?? CookActivityContentState(temperatureUnit: .fahrenheit)
        state.updatedAt = iso(now)
        state.ended = true
        state.endedAt = nil
        return state
    }

    /// The content an activity ends with: `end`, keeping the temperatures
    /// it `shown` last when `end` has no reading of its own (an activity
    /// ended before the app followed a reading for it).
    public static func ending(_ end: CookActivityContentState, shown: CookActivityContentState?) -> CookActivityContentState {
        guard let shown, !hasReading(end) else { return end }
        var state = end
        state.grillTemp = shown.grillTemp
        state.probe1Temp = shown.probe1Temp
        state.probe2Temp = shown.probe2Temp
        state.probe3Temp = shown.probe3Temp
        state.probe4Temp = shown.probe4Temp
        state.readingTime = shown.readingTime
        return state
    }

    private static func hasReading(_ state: CookActivityContentState) -> Bool {
        state.readingTime != nil || state.grillTemp != nil
            || probeChannels.contains { value($0, in: state) != nil }
    }

    /// When an update with `state` goes stale: three minutes after it was
    /// sent. Nil when it has no send time, or the cook has ended.
    public static func staleDate(for state: CookActivityContentState) -> Date? {
        guard state.ended != true, let updated = date(state.updatedAt) else { return nil }
        return updated.addingTimeInterval(staleAfter)
    }

    /// When an activity ended with `state` leaves the lock screen: 15
    /// minutes after the cook ended (`endedAt`; the send time without it),
    /// so one ended long after its cook stopped leaves at once. Nil (the
    /// system's default) with neither.
    public static func dismissalDate(for state: CookActivityContentState) -> Date? {
        (date(state.endedAt) ?? date(state.updatedAt)).map { $0.addingTimeInterval(endedDismissAfter) }
    }

    /// - Parameters:
    ///   - isStale: the system says the stale date has passed.
    ///   - locale, timeZone: how a time reads; the user's own by default.
    public static func present(
        _ attributes: CookActivityAttributes, _ state: CookActivityContentState, isStale: Bool = false,
        locale: Locale = .autoupdatingCurrent, timeZone: TimeZone = .autoupdatingCurrent
    ) -> CookActivityPresentation {
        let unit = state.temperatureUnit
        let grill = row(state.grillTemp, target: state.targetTemps?.grill, unit: unit, separator: " / ")
        let shown = probeChannels.compactMap { channel -> ShownProbe? in
            guard let value = value(channel, in: state) else { return nil }
            let target = channel.targetKey.value(in: state.targetTemps)
            let reachedAt = target == nil ? nil : date(reachedTime(channel, in: state.targetsReached))
            return ShownProbe(channel: channel, value: value, target: target, reachedAt: reachedAt)
        }
        let probes = shown.map { probe -> CookActivityPresentation.Probe in
            var text = row(probe.value, target: probe.target, unit: unit, separator: probe.reachedAt == nil ? " → " : " · ")
            if let at = probe.reachedAt {
                text += " ✓ " + LiveText.time(at, locale: locale, timeZone: timeZone)
            }
            return .init(label: probe.channel.label, text: text)
        }
        let status: CookActivityPresentation.Status
        if state.ended == true {
            status = .ended
        } else if isStale, let updated = date(state.updatedAt) {
            status = .stale(asOf: LiveText.time(updated, locale: locale, timeZone: timeZone))
        } else {
            status = .current
        }
        let chosen = island(shown, grill: grill, grillReading: degrees(state.grillTemp, unit: unit), unit: unit)
        let trailing: String
        let minimal: String
        switch status {
        case .current:
            trailing = chosen.island.text
            minimal = chosen.reading
        case .stale:
            trailing = status.note ?? chosen.island.text
            minimal = chosen.reading
        case .ended:
            trailing = "Ended"
            minimal = "Ended"
        }
        return CookActivityPresentation(
            cookName: attributes.cookName,
            startedAt: status == .ended ? nil : date(attributes.startTime),
            grill: grill,
            probes: probes,
            island: chosen.island,
            islandTrailing: trailing,
            islandMinimal: minimal,
            status: status,
            url: CookLink.url(cookID: attributes.cookId)
        )
    }

    private struct ShownProbe {
        let channel: LiveChannel
        let value: Double
        let target: Double?
        let reachedAt: Date?
    }

    /// The probe closest to a target it has not reached; when every shown
    /// probe with a target has reached it, the most recently reached one,
    /// with the mark and no time; with no probe target, the grill.
    /// The island and its channel's reading alone ("187°"), for the minimal island.
    private static func island(
        _ probes: [ShownProbe], grill: String, grillReading: String, unit: TemperatureUnit
    ) -> (island: CookActivityPresentation.Island, reading: String) {
        let targeted = probes.filter { $0.target != nil }
        let unreached = targeted.filter { $0.reachedAt == nil }
        // Ties go to the lower probe: `min` keeps the first.
        if let closest = unreached.min(by: { distance($0) < distance($1) }) {
            return island(closest, text: row(closest.value, target: closest.target, unit: unit, separator: " → "), unit: unit)
        }
        if let latest = targeted.max(by: { ($0.reachedAt ?? .distantPast) < ($1.reachedAt ?? .distantPast) }) {
            return island(latest, text: degrees(latest.value, unit: unit) + " ✓", unit: unit)
        }
        let label = LiveChannel.grill.label
        return (.init(label: label, shortLabel: label, text: grill), grillReading)
    }

    private static func island(
        _ probe: ShownProbe, text: String, unit: TemperatureUnit
    ) -> (island: CookActivityPresentation.Island, reading: String) {
        (.init(label: probe.channel.label, shortLabel: "P" + probe.channel.label.suffix(1), text: text), degrees(probe.value, unit: unit))
    }

    private static func distance(_ probe: ShownProbe) -> Double {
        abs((probe.target ?? 0) - probe.value)
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

    private static func reached(_ cook: Cook) -> Components.Schemas.CookActivityTargetsReached? {
        guard let reached = cook.targetsReached else { return nil }
        let result = Components.Schemas.CookActivityTargetsReached(
            probe1: reached.probe1.map { iso($0.reachedAt) },
            probe2: reached.probe2.map { iso($0.reachedAt) },
            probe3: reached.probe3.map { iso($0.reachedAt) },
            probe4: reached.probe4.map { iso($0.reachedAt) }
        )
        return result == .init() ? nil : result
    }

    private static func reachedTime(_ channel: LiveChannel, in reached: Components.Schemas.CookActivityTargetsReached?) -> String? {
        switch channel {
        case .grill: nil
        case .probe1: reached?.probe1
        case .probe2: reached?.probe2
        case .probe3: reached?.probe3
        case .probe4: reached?.probe4
        }
    }

    private static func iso(_ date: Date) -> String {
        (try? APIDateTranscoder().encode(date)) ?? ""
    }

    private static func date(_ string: String?) -> Date? {
        string.flatMap { try? APIDateTranscoder().decode($0) }
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
    /// What the activity with this id shows now; nil when none is showing.
    func state(_ id: String) -> CookActivityContentState?
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

    public func state(_ id: String) -> CookActivityContentState? {
        activities[id]?.state
    }

    public func end(_ id: String, _ state: CookActivityContentState) {
        activities[id] = nil
    }

    public var pushToStartTokens: AsyncStream<Data> { AsyncStream { $0.finish() } }

    public func pushTokens(_ id: String) -> AsyncStream<Data> { AsyncStream { $0.finish() } }
}
