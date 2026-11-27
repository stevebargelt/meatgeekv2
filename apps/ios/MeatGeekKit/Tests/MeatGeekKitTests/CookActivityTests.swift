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
    private(set) var states: [String: CookActivityContentState] = [:]
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

    func end(_ id: String, _ state: CookActivityContentState) {
        calls.append(.end(id: id))
        states[id] = state
        shown.removeAll { $0.id == id }
    }

    var pushToStartTokens: AsyncStream<Data> { AsyncStream { $0.finish() } }
    func pushTokens(_ id: String) -> AsyncStream<Data> { AsyncStream { $0.finish() } }
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

        let empty = CookActivityPresenter.content(for: cook, reading: nil, unit: .celsius)
        #expect(empty == .init(targetTemps: .init(grill: 225, probe2: 203), temperatureUnit: .celsius))

        let reading = LiveReading(LiveFixtures.temperature(at: 5, grill: 224, probe1: 150, probe2: 180))
        let state = CookActivityPresenter.content(for: cook, reading: reading, unit: .fahrenheit)
        #expect(state.grillTemp == 224)
        #expect(state.probe1Temp == 150)
        #expect(state.probe2Temp == 180)
        #expect(state.readingTime == LiveFixtures.iso(5))
        #expect(state.temperatureUnit == .fahrenheit)
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
        let apiCook = self.apiCook, apiFails = self.apiFails, reads = self.reads
        api.getCookHandler = { _ in
            reads.value += 1
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
        h.apiCook.value = Self.stopped(Self.active())
        h.tracker.setAppActive(true)
        await until("ended") { h.port.calls == [.end(id: "earlier")] }
        #expect(h.tracker.trackedCookIDs.isEmpty)
        #expect(!h.tracker.isConnected)

        h.port.shown = [.init(id: "other-account", cookID: "cook-9")]
        h.apiCook.value = nil
        h.tracker.setAppActive(false)
        h.tracker.setAppActive(true)
        await until("ended") { h.port.calls.last == .end(id: "other-account") }
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
        // Let the read's answer reach the tracker; the activity stays.
        for _ in 0..<20 { await Task.yield() }
        #expect(h.port.calls == [.start(cookID: "cook-1")])
        #expect(h.tracker.trackedCookIDs == ["cook-1"])
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
