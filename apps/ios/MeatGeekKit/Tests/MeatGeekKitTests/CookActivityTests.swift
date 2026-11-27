import Foundation
import MeatGeekAPI
import Testing
@testable import MeatGeekKit

/// The lock-screen activity (#271): what it shows (`CookActivityPresenter`),
/// the link a tap opens (`CookLink`), and which activities the app starts,
/// updates and ends (`CookActivityTracker`, through `CooksModel`), over a
/// fake `LiveActivities` port, the fake hub and the stub API. Nothing here
/// waits in real time.

// MARK: - Fake port

@MainActor
final class FakeLiveActivities: LiveActivities {
    enum Call: Equatable {
        case start(cookID: String)
        case update(id: String)
        case end(id: String)
    }

    struct Refused: Error {}

    /// Live Activities off in Settings: every start throws.
    var refuses = false
    /// What the system is already showing (e.g. from an earlier launch).
    var shown: [RunningCookActivity] = []
    private(set) var calls: [Call] = []
    var states: [String: CookActivityContentState] = [:]
    private(set) var attributes: [String: CookActivityAttributes] = [:]
    private var next = 0

    func running() -> [RunningCookActivity] { shown }

    func start(_ attributes: CookActivityAttributes, _ state: CookActivityContentState) throws -> String {
        calls.append(.start(cookID: attributes.cookId))
        if refuses { throw Refused() }
        next += 1
        let id = "activity-\(next)"
        self.attributes[id] = attributes
        states[id] = state
        shown.append(.init(id: id, cookID: attributes.cookId))
        return id
    }

    func update(_ id: String, _ state: CookActivityContentState) {
        calls.append(.update(id: id))
        states[id] = state
    }

    func state(_ id: String) -> CookActivityContentState? { states[id] }

    func end(_ id: String, _ state: CookActivityContentState) {
        calls.append(.end(id: id))
        states[id] = state
        shown.removeAll { $0.id == id }
    }

    /// Push-to-start tokens: what `issueStartToken(_:)` yields. One stream,
    /// as the system has one; each read of `pushToStartTokens` counts.
    private let startTokens = AsyncStream<Data>.makeStream()
    private(set) var startTokenReads = 0
    var pushToStartTokens: AsyncStream<Data> {
        startTokenReads += 1
        return startTokens.stream
    }
    func issueStartToken(_ token: Data) { startTokens.continuation.yield(token) }

    /// Each activity's update tokens: what `issuePushToken(_:for:)` yields.
    private var pushTokenStreams: [String: (stream: AsyncStream<Data>, continuation: AsyncStream<Data>.Continuation)] = [:]
    private(set) var pushTokenReads: [String] = []
    func pushTokens(_ id: String) -> AsyncStream<Data> {
        pushTokenReads.append(id)
        return pushTokenStream(id).stream
    }
    func issuePushToken(_ token: Data, for id: String) { pushTokenStream(id).continuation.yield(token) }
    private func pushTokenStream(_ id: String) -> (stream: AsyncStream<Data>, continuation: AsyncStream<Data>.Continuation) {
        if let existing = pushTokenStreams[id] { return existing }
        let made = AsyncStream<Data>.makeStream()
        pushTokenStreams[id] = (made.stream, made.continuation)
        return (made.stream, made.continuation)
    }
}

// MARK: - Presenter

@Suite("Lock-screen activity: what it shows")
struct CookActivityPresenterTests {
    static let attributes = CookActivityAttributes(
        cookId: "cook-1", cookName: "Brisket", startTime: "2026-11-22T12:00:00.000Z"
    )

    static func state(
        grill: Double? = 224, probe1: Double? = nil, probe2: Double? = nil, probe3: Double? = nil, probe4: Double? = nil,
        targets: Components.Schemas.TargetTemperatures? = nil, unit: TemperatureUnit = .fahrenheit
    ) -> CookActivityContentState {
        CookActivityContentState(
            grillTemp: grill, probe1Temp: probe1, probe2Temp: probe2, probe3Temp: probe3, probe4Temp: probe4,
            targetTemps: targets, temperatureUnit: unit
        )
    }

    @Test("the cook's name, its start, the grill against its target and each probe against its target")
    func full() {
        let shown = CookActivityPresenter.present(
            Self.attributes,
            Self.state(grill: 224, probe1: 187, probe2: 150.4, targets: .init(grill: 225, probe1: 203))
        )
        #expect(shown.cookName == "Brisket")
        #expect(shown.startedAt == Date(timeIntervalSince1970: 1_795_348_800))
        #expect(shown.grill == "224° / 225°")
        #expect(shown.probes == [.init(label: "Probe 1", text: "187° → 203°"), .init(label: "Probe 2", text: "150°")])
        #expect(shown.url == URL(string: "meatgeek://cook/cook-1"))
    }

    @Test("a probe with no reading is left out, even with a target")
    func probeWithoutReading() {
        let shown = CookActivityPresenter.present(
            Self.attributes, Self.state(probe1: nil, probe3: 160, targets: .init(probe1: 203, probe3: 195))
        )
        #expect(shown.probes == [.init(label: "Probe 3", text: "160° → 195°")])
    }

    @Test("the grill with no target is its reading; with no reading, a dash")
    func grillWithoutTargetOrReading() {
        #expect(CookActivityPresenter.present(Self.attributes, Self.state(grill: 224.6)).grill == "225°")
        #expect(CookActivityPresenter.present(Self.attributes, Self.state(grill: nil, targets: .init(grill: 225))).grill == "— / 225°")
    }

    @Test("temperatures are in the device's unit")
    func celsius() {
        let shown = CookActivityPresenter.present(
            Self.attributes,
            Self.state(grill: 224, probe1: 187, targets: .init(grill: 225, probe1: 203), unit: .celsius)
        )
        #expect(shown.grill == "107° / 107°")
        #expect(shown.probes == [.init(label: "Probe 1", text: "86° → 95°")])
        #expect(CookActivityPresenter.degrees(32, unit: .celsius) == "0°")
        #expect(CookActivityPresenter.degrees(31.5, unit: .celsius) == "0°")
    }

    @Test("a cook's attributes and content hold its id, name, start, targets, reading and unit")
    func fromCook() throws {
        var cook = CookFixtures.cook("cook-1", status: .active, name: "Brisket", started: fixedNow)
        cook.targetTemps = .init(grill: 225, probe2: 203)
        let attributes = CookActivityPresenter.attributes(for: cook)
        #expect(attributes == .init(cookId: "cook-1", cookName: "Brisket", startTime: "2026-11-22T18:00:00.000Z"))

        let empty = CookActivityPresenter.content(for: cook, reading: nil, unit: .celsius, now: fixedNow)
        #expect(empty == .init(
            targetTemps: .init(grill: 225, probe2: 203), temperatureUnit: .celsius, updatedAt: "2026-11-22T18:00:00.000Z"
        ))

        let reading = LiveReading(LiveFixtures.temperature(at: 5, grill: 224, probe1: 150, probe2: 180))
        let state = CookActivityPresenter.content(for: cook, reading: reading, unit: .fahrenheit, now: fixedNow)
        #expect(state.grillTemp == 224)
        #expect(state.probe1Temp == 150)
        #expect(state.probe2Temp == 180)
        #expect(state.readingTime == LiveFixtures.iso(5))
        #expect(state.temperatureUnit == .fahrenheit)
        #expect(state.ended == nil)
    }

    @Test("a cook's reached probes go into the content with their times; the grill's does not; a stopped cook is ended")
    func reachedAndEndedFromCook() {
        var cook = CookFixtures.cook("cook-1", status: .active, name: "Brisket", started: fixedNow)
        cook.targetTemps = .init(grill: 225, probe1: 203, probe3: 165)
        cook.targetsReached = .init(
            grill: .init(reachedAt: fixedNow), probe1: .init(reachedAt: fixedNow.addingTimeInterval(60))
        )
        let state = CookActivityPresenter.content(for: cook, reading: nil, unit: .fahrenheit, now: fixedNow)
        #expect(state.targetsReached == .init(probe1: "2026-11-22T18:01:00.000Z"))

        cook.targetsReached = .init(grill: .init(reachedAt: fixedNow))
        #expect(CookActivityPresenter.content(for: cook, reading: nil, unit: .fahrenheit, now: fixedNow).targetsReached == nil)

        cook.status = .completed
        #expect(CookActivityPresenter.content(for: cook, reading: nil, unit: .fahrenheit, now: fixedNow).ended == true)
        #expect(CookActivityPresenter.content(for: cook, reading: nil, unit: .fahrenheit, now: fixedNow).endedAt == nil)
        cook.endTime = fixedNow.addingTimeInterval(-3600)
        let ended = CookActivityPresenter.content(for: cook, reading: nil, unit: .fahrenheit, now: fixedNow)
        #expect(ended.endedAt == "2026-11-22T17:00:00.000Z")
        #expect(CookActivityPresenter.gone(shown: nil, now: fixedNow) == .init(
            temperatureUnit: .fahrenheit, updatedAt: "2026-11-22T18:00:00.000Z", ended: true
        ))
    }

    @Test("an activity ended with no reading of its own keeps the temperatures it shows; a gone cook's keeps all it shows")
    func endingKeepsLastTemperatures() {
        let shown = CookActivityContentState(
            grillTemp: 224, probe1Temp: 204, targetTemps: .init(probe1: 203), temperatureUnit: .celsius,
            readingTime: "2026-11-22T17:59:00.000Z", updatedAt: "2026-11-22T17:59:00.000Z"
        )
        let end = CookActivityContentState(
            targetTemps: .init(probe1: 203), temperatureUnit: .celsius, updatedAt: "2026-11-22T18:00:00.000Z", ended: true
        )
        let kept = CookActivityPresenter.ending(end, shown: shown)
        #expect(kept.grillTemp == 224)
        #expect(kept.probe1Temp == 204)
        #expect(kept.readingTime == "2026-11-22T17:59:00.000Z")
        #expect(kept.updatedAt == "2026-11-22T18:00:00.000Z")
        #expect(kept.ended == true)
        #expect(CookActivityPresenter.ending(end, shown: nil) == end)

        // An end with its own reading keeps it.
        var withReading = end
        withReading.grillTemp = 230
        #expect(CookActivityPresenter.ending(withReading, shown: shown) == withReading)

        let gone = CookActivityPresenter.gone(shown: shown, now: fixedNow)
        #expect(gone.grillTemp == 224)
        #expect(gone.probe1Temp == 204)
        #expect(gone.targetTemps == .init(probe1: 203))
        #expect(gone.temperatureUnit == .celsius)
        #expect(gone.ended == true)
        #expect(gone.updatedAt == "2026-11-22T18:00:00.000Z")
    }
}

// MARK: - Reached, the Dynamic Island, stale and ended (#272)

@Suite("Lock-screen activity: reached marks, the Dynamic Island, stale and ended")
struct CookActivityStatesTests {
    static let attributes = CookActivityPresenterTests.attributes
    static let utc = TimeZone(identifier: "UTC")!
    static let enUS = Locale(identifier: "en_US")

    /// 18:00:00 UTC on the test day, plus `seconds`.
    static func iso(_ seconds: TimeInterval) -> String {
        (try? APIDateTranscoder().encode(fixedNow.addingTimeInterval(seconds))) ?? ""
    }

    static func state(
        grill: Double? = 224, probe1: Double? = nil, probe2: Double? = nil, probe3: Double? = nil, probe4: Double? = nil,
        targets: Components.Schemas.TargetTemperatures? = nil,
        reached: Components.Schemas.CookActivityTargetsReached? = nil,
        updatedAt: String? = iso(0), ended: Bool? = nil, unit: TemperatureUnit = .fahrenheit
    ) -> CookActivityContentState {
        CookActivityContentState(
            grillTemp: grill, probe1Temp: probe1, probe2Temp: probe2, probe3Temp: probe3, probe4Temp: probe4,
            targetTemps: targets, temperatureUnit: unit, targetsReached: reached, updatedAt: updatedAt, ended: ended
        )
    }

    static func present(_ state: CookActivityContentState, isStale: Bool = false) -> CookActivityPresentation {
        CookActivityPresenter.present(attributes, state, isStale: isStale, locale: enUS, timeZone: utc)
    }

    @Test("a reached probe shows its reading, its target, the mark and the local time it was reached")
    func reachedMark() {
        let shown = Self.present(Self.state(
            probe1: 204, probe2: 150, targets: .init(probe1: 203, probe2: 165), reached: .init(probe1: Self.iso(42 * 60))
        ))
        #expect(shown.probes == [
            .init(label: "Probe 1", text: "204° · 203° ✓ 6:42\u{202F}PM"),
            .init(label: "Probe 2", text: "150° → 165°"),
        ])
        let tokyo = CookActivityPresenter.present(
            Self.attributes,
            Self.state(probe1: 204, targets: .init(probe1: 203), reached: .init(probe1: Self.iso(42 * 60))),
            locale: Self.enUS, timeZone: TimeZone(identifier: "Asia/Tokyo")!
        )
        #expect(tokyo.probes.first?.text == "204° · 203° ✓ 3:42\u{202F}AM")
    }

    @Test("a probe that re-armed (no longer reached) loses the mark; a reached probe with no target shows none")
    func reArmed() {
        #expect(Self.present(Self.state(probe1: 185, targets: .init(probe1: 203))).probes.first?.text == "185° → 203°")
        #expect(Self.present(Self.state(probe1: 204, reached: .init(probe1: Self.iso(0)))).probes.first?.text == "204°")
    }

    @Test("the grill never shows a mark, even reached")
    func grillNoMark() {
        let shown = Self.present(Self.state(grill: 226, targets: .init(grill: 225)))
        #expect(shown.grill == "226° / 225°")
    }

    @Test("the Dynamic Island shows the probe closest to a target it has not reached")
    func islandClosest() {
        let shown = Self.present(Self.state(
            probe1: 204, probe2: 150, probe3: 190, probe4: 100,
            targets: .init(grill: 225, probe1: 203, probe2: 165, probe3: 203),
            reached: .init(probe1: Self.iso(0))
        ))
        #expect(shown.island == .init(label: "Probe 3", shortLabel: "P3", text: "190° → 203°"))
    }

    @Test("a probe at its target but not yet reached is the closest; a tie goes to the lower probe")
    func islandAtTargetAndTie() {
        let at = Self.present(Self.state(probe1: 190, probe2: 204, targets: .init(probe1: 203, probe2: 203)))
        #expect(at.island.label == "Probe 2")
        let tie = Self.present(Self.state(probe1: 193, probe2: 213, targets: .init(probe1: 203, probe2: 203)))
        #expect(tie.island.label == "Probe 1")
    }

    @Test("with every probe's target reached, the most recently reached one, with the mark and no time")
    func islandAllReached() {
        let shown = Self.present(Self.state(
            probe1: 204, probe2: 170, probe3: 120,
            targets: .init(probe1: 203, probe2: 165),
            reached: .init(probe1: Self.iso(60), probe2: Self.iso(600))
        ))
        #expect(shown.island == .init(label: "Probe 2", shortLabel: "P2", text: "170° ✓"))
    }

    @Test("with no targets, or targets only on probes with no reading, the grill")
    func islandGrill() {
        #expect(Self.present(Self.state(probe1: 150)).island == .init(label: "Grill", shortLabel: "Grill", text: "224°"))
        let unplugged = Self.present(Self.state(probe2: 150, targets: .init(grill: 225, probe1: 203)))
        #expect(unplugged.island == .init(label: "Grill", shortLabel: "Grill", text: "224° / 225°"))
    }

    @Test("the island is in the device's unit")
    func islandCelsius() {
        let shown = Self.present(Self.state(probe1: 187, targets: .init(probe1: 203), unit: .celsius))
        #expect(shown.island.text == "86° → 95°")
    }

    @Test("an update goes stale three minutes after it was sent, and an ended one never does")
    func staleDate() {
        #expect(CookActivityPresenter.staleDate(for: Self.state()) == fixedNow.addingTimeInterval(180))
        #expect(CookActivityPresenter.staleDate(for: Self.state(updatedAt: nil)) == nil)
        #expect(CookActivityPresenter.staleDate(for: Self.state(ended: true)) == nil)
    }

    @Test("stale, it shows \"as of\" the time of the last update, and says nothing about the device")
    func stale() {
        let current = Self.present(Self.state(updatedAt: Self.iso(42 * 60)))
        #expect(current.status == .current)
        #expect(current.status.note == nil)
        #expect(current.startedAt != nil)

        let stale = Self.present(Self.state(probe1: 187, updatedAt: Self.iso(42 * 60)), isStale: true)
        #expect(stale.status == .stale(asOf: "6:42\u{202F}PM"))
        #expect(stale.status.note == "as of 6:42\u{202F}PM")
        #expect(stale.grill == "224°")
        #expect(stale.probes == [.init(label: "Probe 1", text: "187°")])
    }

    @Test("an ended cook shows \"Cook ended\" with its last temperatures, stops ticking, and leaves 15 minutes later")
    func ended() {
        let state = Self.state(probe1: 204, targets: .init(probe1: 203), updatedAt: Self.iso(60), ended: true)
        let shown = Self.present(state, isStale: true)
        #expect(shown.status == .ended)
        #expect(shown.status.note == "Cook ended")
        #expect(shown.startedAt == nil)
        #expect(shown.grill == "224°")
        #expect(shown.probes == [.init(label: "Probe 1", text: "204° → 203°")])
        #expect(CookActivityPresenter.dismissalDate(for: state) == fixedNow.addingTimeInterval(60 + 15 * 60))
        #expect(CookActivityPresenter.dismissalDate(for: Self.state(updatedAt: nil, ended: true)) == nil)

        // Ended long after the cook stopped: 15 minutes after the stop.
        var late = state
        late.endedAt = Self.iso(-3600)
        #expect(CookActivityPresenter.dismissalDate(for: late) == fixedNow.addingTimeInterval(-3600 + 15 * 60))
    }

    @Test("the compact island shows the island's text, \"as of\" when stale, \"Ended\" once ended; the minimal one the reading alone")
    func islandCompactAndMinimal() {
        let targets = Components.Schemas.TargetTemperatures(grill: 225, probe1: 203)
        let current = Self.present(Self.state(probe1: 187, targets: targets, updatedAt: Self.iso(42 * 60)))
        #expect(current.islandTrailing == "187° → 203°")
        #expect(current.islandMinimal == "187°")

        let stale = Self.present(Self.state(probe1: 187, targets: targets, updatedAt: Self.iso(42 * 60)), isStale: true)
        #expect(stale.islandTrailing == "as of 6:42\u{202F}PM")
        #expect(stale.islandMinimal == "187°")

        let ended = Self.present(Self.state(probe1: 204, targets: targets, ended: true))
        #expect(ended.islandTrailing == "Ended")
        #expect(ended.islandMinimal == "Ended")

        let grill = Self.present(Self.state(targets: .init(grill: 225)))
        #expect(grill.islandTrailing == "224° / 225°")
        #expect(grill.islandMinimal == "224°")
    }
}

// MARK: - Link

@Suite("Lock-screen activity: the link a tap opens")
struct CookLinkTests {
    @Test("meatgeek://cook/<id> opens that cook; any other URL opens none")
    func roundTrip() throws {
        let url = CookLink.url(cookID: "3f2b0c1e-9a4d-4b7e-8c1f-2d3e4f5a6b7c")
        #expect(url.absoluteString == "meatgeek://cook/3f2b0c1e-9a4d-4b7e-8c1f-2d3e4f5a6b7c")
        #expect(CookLink.cookID(from: url) == "3f2b0c1e-9a4d-4b7e-8c1f-2d3e4f5a6b7c")
        #expect(CookLink.cookID(from: try #require(URL(string: "meatgeek://cook/"))) == nil)
        #expect(CookLink.cookID(from: try #require(URL(string: "meatgeek://device/box"))) == nil)
        #expect(CookLink.cookID(from: try #require(URL(string: "msauth.com.meatgeek.ios://auth"))) == nil)
    }
}

// MARK: - Tracker

/// A cooks model whose devices are box (fahrenheit) and kettle, with the
/// activity port faked and the activities' own connection on fake hubs.
@MainActor
final class ActivityHarness {
    let port = FakeLiveActivities()
    let hubs = FakeHubs()
    let clock = VirtualClock()
    let negotiations = Box(0)
    /// What `GET /cooks/{id}` answers: the cook, a 404 when nil, or a 500
    /// while `apiFails` is set.
    let apiCook = Box<Cook?>(nil)
    let apiFails = Box(false)
    /// When set, `GET /cooks/{id}` waits at it before answering.
    let readGate = Box<Gate?>(nil)
    /// How many times `GET /cooks/{id}` was called.
    let reads = Box(0)
    private(set) var session: SessionModel!
    private(set) var cooks: CooksModel!

    func open(withLive: Bool = true, boxUnit: TemperatureUnit? = nil) async {
        var api = CookFixtures.api()
        let negotiations = self.negotiations
        api.negotiateHandler = { _ in
            negotiations.value += 1
            return .ok(.init(body: .json(LiveFixtures.info(negotiations.value))))
        }
        let apiCook = self.apiCook, apiFails = self.apiFails, reads = self.reads, readGate = self.readGate
        api.getCookHandler = { _ in
            reads.value += 1
            await readGate.value?.pass()
            if apiFails.value {
                return .internalServerError(.init(body: .json(CookFixtures.error(.internalServerError, "Down"))))
            }
            guard let cook = apiCook.value else {
                return .notFound(.init(body: .json(CookFixtures.error(.notFound, "Cook not found"))))
            }
            return .ok(.init(body: .json(cook)))
        }
        if let boxUnit {
            var box = DeviceFixtures.box
            box.configuration = .init(temperatureUnit: boxUnit)
            let devices = [box, DeviceFixtures.kettle]
            api.getDevicesHandler = { _ in .ok(.init(body: .json(.init(devices: devices)))) }
        }
        session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let devices = DevicesModel(session: session, now: { fixedNow })
        await devices.start()
        cooks = CooksModel(
            devices: devices, now: { fixedNow }, activities: port,
            activityLive: withLive ? LiveServices(createHub: hubs.factory, sleep: clock.sleep) : nil
        )
    }

    var tracker: CookActivityTracker { cooks.activities! }

    func connected() async {
        await until("the activities' hub started") { hubs.latest?.starts == 1 }
        await Task.yield()
    }
}

@Suite("Lock-screen activity: started, updated and ended with the cook")
@MainActor
struct CookActivityTrackerTests {
    static func active(_ id: String = "cook-1", device: String = DeviceFixtures.box.id) -> Cook {
        var cook = CookFixtures.cook(id, device: device, status: .active, name: "Brisket", started: fixedNow)
        cook.targetTemps = .init(grill: 225, probe1: 203)
        return cook
    }

    static func stopped(_ cook: Cook) -> Cook {
        var stopped = cook
        stopped.status = .completed
        stopped.endTime = fixedNow.addingTimeInterval(3600)
        return stopped
    }

    @Test("starting a cook starts its activity with the cook's name, start and targets")
    func startsWithCook() async throws {
        let h = ActivityHarness()
        await h.open()
        h.cooks.apply(Self.active())

        #expect(h.port.calls == [.start(cookID: "cook-1")])
        let attributes = try #require(h.port.attributes["activity-1"])
        #expect(attributes.cookName == "Brisket")
        let shown = CookActivityPresenter.present(attributes, try #require(h.port.states["activity-1"]))
        #expect(shown.grill == "— / 225°")
        #expect(shown.probes.isEmpty)
        #expect(h.tracker.trackedCookIDs == ["cook-1"])
    }

    @Test("each new reading from the cook's device updates it; other devices' do not")
    func updatesWithReadings() async throws {
        let h = ActivityHarness()
        await h.open()
        h.cooks.apply(Self.active())
        await h.connected()
        let hub = try #require(h.hubs.latest)

        hub.emit(LiveFixtures.temperature(device: DeviceFixtures.box.id, at: 5, grill: 224, probe1: 187))
        var shown = CookActivityPresenter.present(try #require(h.port.attributes["activity-1"]), try #require(h.port.states["activity-1"]))
        #expect(shown.grill == "224° / 225°")
        #expect(shown.probes == [.init(label: "Probe 1", text: "187° → 203°")])

        hub.emit(LiveFixtures.temperature(device: DeviceFixtures.kettle.id, at: 10, grill: 300, probe1: 100))
        hub.emit(LiveFixtures.temperature(device: DeviceFixtures.box.id, at: 1, grill: 200, probe1: 100))
        shown = CookActivityPresenter.present(try #require(h.port.attributes["activity-1"]), try #require(h.port.states["activity-1"]))
        #expect(shown.grill == "224° / 225°")

        hub.emit(LiveFixtures.temperature(device: DeviceFixtures.box.id, at: 10, grill: 226, probe1: 190))
        shown = CookActivityPresenter.present(try #require(h.port.attributes["activity-1"]), try #require(h.port.states["activity-1"]))
        #expect(shown.grill == "226° / 225°")
        #expect(h.port.calls == [.start(cookID: "cook-1"), .update(id: "activity-1"), .update(id: "activity-1")])
    }

    @Test("readings are in the device's unit")
    func deviceUnit() async throws {
        let h = ActivityHarness()
        await h.open(boxUnit: .celsius)
        h.cooks.apply(Self.active())
        await h.connected()
        try #require(h.hubs.latest).emit(LiveFixtures.temperature(device: DeviceFixtures.box.id, at: 5, grill: 212, probe1: 167))
        let shown = CookActivityPresenter.present(try #require(h.port.attributes["activity-1"]), try #require(h.port.states["activity-1"]))
        #expect(shown.grill == "100° / 107°")
        #expect(shown.probes == [.init(label: "Probe 1", text: "75° → 95°")])
    }

    @Test("stopping the cook ends its activity with the last reading, and the connection closes")
    func endsWithCook() async throws {
        let h = ActivityHarness()
        await h.open()
        let cook = Self.active()
        h.cooks.apply(cook)
        await h.connected()
        let hub = try #require(h.hubs.latest)
        hub.emit(LiveFixtures.temperature(device: DeviceFixtures.box.id, at: 5, grill: 224, probe1: 187))

        h.cooks.apply(Self.stopped(cook))
        #expect(h.port.calls.last == .end(id: "activity-1"))
        #expect(h.port.states["activity-1"]?.grillTemp == 224)
        #expect(h.tracker.trackedCookIDs.isEmpty)
        #expect(!h.tracker.isConnected)
        #expect(hub.stops == 1)
    }

    @Test("cook_stopped on the activities' connection ends the activity and the cook in the list")
    func cookStoppedMessage() async throws {
        let h = ActivityHarness()
        await h.open()
        let cook = Self.active()
        h.cooks.apply(cook)
        await h.connected()
        try #require(h.hubs.latest).emit(LiveFixtures.cookStopped(Self.stopped(cook)))

        #expect(h.port.calls.last == .end(id: "activity-1"))
        #expect(h.cooks.devices.activeCook(for: DeviceFixtures.box) == nil)
    }

    @Test("a changed target updates the activity; the same cook again starts no second one")
    func targetsChanged() async throws {
        let h = ActivityHarness()
        await h.open()
        var cook = Self.active()
        h.cooks.apply(cook)
        cook.targetTemps = .init(grill: 250)
        h.cooks.apply(cook)

        #expect(h.port.calls == [.start(cookID: "cook-1"), .update(id: "activity-1")])
        #expect(h.port.states["activity-1"]?.targetTemps == .init(grill: 250))
    }

    @Test("each update carries its send time; stopping the cook ends it as \"Cook ended\" (#272)")
    func endedState() async throws {
        let h = ActivityHarness()
        await h.open()
        let cook = Self.active()
        h.cooks.apply(cook)
        let started = try #require(h.port.states["activity-1"])
        #expect(started.updatedAt == "2026-11-22T18:00:00.000Z")
        #expect(started.ended == nil)

        h.cooks.apply(Self.stopped(cook))
        let ended = try #require(h.port.states["activity-1"])
        #expect(ended.ended == true)
        let shown = CookActivityPresenter.present(try #require(h.port.attributes["activity-1"]), ended)
        #expect(shown.status.note == "Cook ended")
    }

    @Test("the cook as re-read gives the activity its reached probes; an unchanged one, or an untracked cook, sends nothing")
    func cookRead() async throws {
        let h = ActivityHarness()
        await h.open(withLive: false)
        var cook = Self.active()
        h.tracker.cookRead(cook)
        #expect(h.port.calls.isEmpty)

        h.cooks.apply(cook)
        h.tracker.cookRead(cook)
        #expect(h.port.calls == [.start(cookID: "cook-1")])

        cook.targetsReached = .init(probe1: .init(reachedAt: fixedNow.addingTimeInterval(60)))
        h.tracker.cookRead(cook)
        #expect(h.port.calls.last == .update(id: "activity-1"))
        #expect(h.port.states["activity-1"]?.targetsReached == .init(probe1: "2026-11-22T18:01:00.000Z"))

        h.tracker.cookRead(Self.stopped(cook))
        #expect(h.port.calls.last == .end(id: "activity-1"))
        #expect(h.port.states["activity-1"]?.ended == true)
    }

    @Test("an activity already showing for the cook (an earlier launch) is taken over, not doubled")
    func adoptsRunning() async throws {
        let h = ActivityHarness()
        await h.open()
        h.port.shown = [.init(id: "earlier", cookID: "cook-1")]
        h.cooks.apply(Self.active())
        #expect(h.port.calls == [.update(id: "earlier")])
        h.cooks.apply(Self.stopped(Self.active()))
        #expect(h.port.calls.last == .end(id: "earlier"))
    }

    @Test("with Live Activities off nothing fails: the cook starts and stops, and no connection opens")
    func refused() async throws {
        let h = ActivityHarness()
        await h.open()
        h.port.refuses = true
        let cook = Self.active()
        h.cooks.apply(cook)
        #expect(h.port.calls == [.start(cookID: "cook-1")])
        #expect(h.tracker.trackedCookIDs.isEmpty)
        #expect(!h.tracker.isConnected)
        #expect(h.cooks.devices.activeCook(for: DeviceFixtures.box) == cook)

        h.cooks.apply(Self.stopped(cook))
        #expect(h.port.calls == [.start(cookID: "cook-1")])
        #expect(h.negotiations.value == 0)
    }

    @Test("readings are followed only while the app is active")
    func appActive() async throws {
        let h = ActivityHarness()
        await h.open()
        h.apiCook.value = Self.active()
        h.cooks.apply(Self.active())
        await h.connected()
        h.tracker.setAppActive(false)
        #expect(!h.tracker.isConnected)
        #expect(h.hubs.latest?.stops == 1)
        h.tracker.setAppActive(true)
        await until("a second hub started") { h.hubs.hubs.count == 2 && h.hubs.latest?.starts == 1 }
        #expect(h.tracker.isConnected)
    }

    @Test("on becoming active, an activity from an earlier launch whose cook still runs is taken over and follows readings")
    func reconcileAdopts() async throws {
        let h = ActivityHarness()
        await h.open()
        h.port.shown = [.init(id: "earlier", cookID: "cook-1")]
        h.apiCook.value = Self.active()
        h.tracker.setAppActive(true)
        await until("taken over") { h.tracker.trackedCookIDs == ["cook-1"] }
        #expect(h.port.calls == [.update(id: "earlier")])

        await h.connected()
        try #require(h.hubs.latest).emit(LiveFixtures.temperature(device: DeviceFixtures.box.id, at: 5, grill: 224, probe1: 187))
        #expect(h.port.calls.last == .update(id: "earlier"))
        #expect(h.port.states["earlier"]?.grillTemp == 224)

        // Starting the same cook again in the app does not double it.
        h.cooks.apply(Self.active())
        #expect(!h.port.calls.contains(.start(cookID: "cook-1")))
    }

    @Test("on becoming active, an activity whose cook stopped elsewhere, or no longer exists, is ended")
    func reconcileEnds() async throws {
        let h = ActivityHarness()
        await h.open()
        h.port.shown = [.init(id: "earlier", cookID: "cook-1")]
        h.port.states["earlier"] = .init(grillTemp: 224, probe1Temp: 204, temperatureUnit: .fahrenheit)
        h.apiCook.value = Self.stopped(Self.active())
        h.tracker.setAppActive(true)
        await until("ended") { h.port.calls == [.end(id: "earlier")] }
        #expect(h.tracker.trackedCookIDs.isEmpty)
        #expect(!h.tracker.isConnected)
        // "Cook ended" with the last temperatures it showed, gone 15 minutes after the stop.
        let ended = try #require(h.port.states["earlier"])
        #expect(ended.ended == true)
        #expect(ended.grillTemp == 224)
        #expect(ended.probe1Temp == 204)
        #expect(CookActivityPresenter.dismissalDate(for: ended) == fixedNow.addingTimeInterval(3600 + 15 * 60))

        h.port.shown = [.init(id: "other-account", cookID: "cook-9")]
        h.port.states["other-account"] = .init(grillTemp: 230, temperatureUnit: .celsius)
        h.apiCook.value = nil
        h.tracker.setAppActive(false)
        h.tracker.setAppActive(true)
        await until("ended") { h.port.calls.last == .end(id: "other-account") }
        let gone = try #require(h.port.states["other-account"])
        #expect(gone.ended == true)
        #expect(gone.grillTemp == 230)
        #expect(gone.temperatureUnit == .celsius)
    }

    @Test("a cook stopped on the web while the app was in the background ends its activity on return")
    func reconcileStoppedWhileAway() async throws {
        let h = ActivityHarness()
        await h.open()
        let cook = Self.active()
        h.cooks.apply(cook)
        await h.connected()
        h.tracker.setAppActive(false)

        h.apiCook.value = Self.stopped(cook)
        h.tracker.setAppActive(true)
        await until("ended") { h.port.calls.last == .end(id: "activity-1") }
        #expect(h.tracker.trackedCookIDs.isEmpty)
        #expect(h.cooks.devices.activeCook(for: DeviceFixtures.box) == nil)
        await until("connection closed") { !h.tracker.isConnected }
    }

    @Test("a failed read leaves the activity as it is")
    func reconcileFails() async throws {
        let h = ActivityHarness()
        await h.open()
        let cook = Self.active()
        h.cooks.apply(cook)
        await h.connected()
        h.apiFails.value = true
        let before = h.reads.value
        h.tracker.setAppActive(false)
        h.tracker.setAppActive(true)
        await until("the cook was read") { h.reads.value == before + 1 }
        await until("a second hub started") { h.hubs.hubs.count == 2 && h.hubs.latest?.starts == 1 }
        await until("the read's answer reached the tracker") { !h.tracker.isReconciling }
        #expect(h.port.calls == [.start(cookID: "cook-1")])
        #expect(h.tracker.trackedCookIDs == ["cook-1"])
    }

    @Test("stopping a cook in the app ends an earlier launch's activity the failed check left alone")
    func stopEndsUnadopted() async throws {
        let h = ActivityHarness()
        await h.open()
        h.port.shown = [.init(id: "earlier", cookID: "cook-1")]
        h.apiFails.value = true
        h.tracker.setAppActive(true)
        await until("the check finished") { h.reads.value == 1 && !h.tracker.isReconciling }
        #expect(h.port.calls.isEmpty)
        #expect(h.tracker.trackedCookIDs.isEmpty)

        h.cooks.apply(Self.stopped(Self.active()))
        #expect(h.port.calls == [.end(id: "earlier")])
        #expect(h.port.states["earlier"]?.targetTemps == .init(grill: 225, probe1: 203))
    }

    @Test("after stop (signed out) a check still out, a late cook and the scene take over, start and connect nothing")
    func stopIsFinal() async throws {
        let h = ActivityHarness()
        await h.open()
        h.port.shown = [.init(id: "earlier", cookID: "cook-1")]
        h.apiCook.value = Self.active()
        let gate = Gate()
        h.readGate.value = gate
        h.tracker.setAppActive(true)
        await gate.waitUntilEntered()
        h.tracker.stop()

        h.cooks.apply(Self.active("cook-2"))
        h.tracker.setAppActive(false)
        h.tracker.setAppActive(true)
        gate.open()
        await until("the dropped check's read came back") { !h.tracker.isReconciling }
        #expect(h.reads.value == 1)
        #expect(h.port.calls.isEmpty)
        #expect(h.tracker.trackedCookIDs.isEmpty)
        #expect(!h.tracker.isConnected)
        #expect(h.hubs.hubs.isEmpty)
        #expect(h.negotiations.value == 0)
    }

    @Test("with no live services (UI test mode) the activity starts and ends but opens no connection")
    func noLive() async throws {
        let h = ActivityHarness()
        await h.open(withLive: false)
        let cook = Self.active()
        h.cooks.apply(cook)
        #expect(!h.tracker.isConnected)
        h.cooks.apply(Self.stopped(cook))
        #expect(h.port.calls == [.start(cookID: "cook-1"), .end(id: "activity-1")])
        #expect(h.negotiations.value == 0)
    }
}

@Suite("Lock-screen activity: UI test mode's stub")
@MainActor
struct StubLiveActivitiesTests {
    @Test("holds what it is given, and forgets an ended activity")
    func stub() throws {
        let stub = StubLiveActivities()
        let attributes = CookActivityAttributes(cookId: "cook-1", cookName: "Brisket", startTime: "2026-11-22T18:00:00.000Z")
        let id = try stub.start(attributes, .init(temperatureUnit: .fahrenheit))
        #expect(stub.running() == [.init(id: id, cookID: "cook-1")])
        stub.update(id, .init(grillTemp: 224, temperatureUnit: .fahrenheit))
        #expect(stub.activities[id]?.state.grillTemp == 224)
        stub.end(id, .init(temperatureUnit: .fahrenheit))
        #expect(stub.running().isEmpty)
    }
}
