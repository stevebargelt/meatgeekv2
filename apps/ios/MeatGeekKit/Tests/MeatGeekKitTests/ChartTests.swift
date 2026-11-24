import Foundation
import MeatGeekAPI
import Testing
@testable import MeatGeekKit

/// The cook chart: `ChartSeries` (a port of
/// apps/web/src/cooks/chart-series.spec.ts), `CookChartModel`
/// (cook-chart.spec.tsx), its wiring into the cook screen, and UI test mode's
/// chart route. The API is a stub answering in process and every load is
/// awaited: nothing here waits in real time.

enum ChartFixtures {
    static let hour: TimeInterval = 3600
    /// 2026-11-20T14:00:00Z.
    static let t0 = Date(timeIntervalSince1970: 1_795_183_200)

    static func iso(_ date: Date) -> String {
        (try? APIDateTranscoder().encode(date)) ?? ""
    }

    static func chart(_ points: [Components.Schemas.CookChartPoint], bucket: CookChart.BucketSecondsPayload = ._3600) -> CookChart {
        CookChart(cookId: "cook-1", deviceId: "box", startTime: t0, bucketSeconds: bucket, points: points)
    }

    static func channel(_ min: Double, _ max: Double, _ avg: Double) -> Components.Schemas.CookChartChannel {
        .init(min: min, max: max, avg: avg)
    }

    /// Two hourly buckets of grill and probe 1 (`TWO_HOURS`).
    static let twoHours = chart([
        .init(t: t0, grill: channel(220, 240, 230), probe1: channel(40, 120, 80)),
        .init(t: t0.addingTimeInterval(hour), grill: channel(225, 235, 229.5), probe1: channel(120, 150, 135)),
    ])

    /// `makeTemperature`: grill 225 and probe 1 150 unless given, on "box".
    static func reading(
        at date: Date, device: String = "box", grill: Double? = 225, probe1: Double? = 150,
        probe2: Double? = nil, probe3: Double? = nil, probe4: Double? = nil
    ) -> TemperatureMessage {
        TemperatureMessage(
            deviceId: device, timestamp: iso(date), grillTemp: grill, probe1Temp: probe1,
            probe2Temp: probe2, probe3Temp: probe3, probe4Temp: probe4, enqueuedTimeUtc: date
        )
    }

    static func value(_ v: Double) -> ChannelValue { ChannelValue(avg: v, lo: v, hi: v) }
}

// MARK: - ChartSeries

@Suite("ChartSeries")
struct ChartSeriesTests {
    typealias F = ChartFixtures

    @Test("maps min, max and avg to lo, hi and avg for each channel, at the bucket start")
    func buckets() {
        let series = ChartSeries(chart: F.twoHours, pushed: [], unit: .fahrenheit)
        #expect(series.rows == [
            ChartRow(t: F.t0, values: [
                .grill: .init(avg: 230, lo: 220, hi: 240), .probe1: .init(avg: 80, lo: 40, hi: 120),
            ]),
            ChartRow(t: F.t0.addingTimeInterval(F.hour), values: [
                .grill: .init(avg: 229.5, lo: 225, hi: 235), .probe1: .init(avg: 135, lo: 120, hi: 150),
            ]),
        ])
        #expect(series.channels == [.grill, .probe1])
    }

    @Test("omits a channel absent from every point, and keeps one present in only some")
    func channels() {
        let chart = F.chart([
            .init(t: F.t0, grill: F.channel(1, 3, 2)),
            .init(t: F.t0.addingTimeInterval(F.hour), grill: F.channel(1, 3, 2), probe3: F.channel(5, 5, 5)),
        ])
        let series = ChartSeries(chart: chart, pushed: [], unit: .fahrenheit)
        #expect(series.channels == [.grill, .probe3])
        #expect(series.rows[0][.probe3] == nil)
        for row in series.rows {
            #expect(row[.probe1] == nil)
            #expect(row[.probe2] == nil)
            #expect(row[.probe4] == nil)
        }
    }

    @Test("drops a pushed reading inside the last bucket and appends ones at and after its end")
    func pushedAroundTheEnd() {
        let lastBucketEnd = F.t0.addingTimeInterval(2 * F.hour)
        let inside = F.reading(at: lastBucketEnd.addingTimeInterval(-1), grill: 999)
        let atEnd = F.reading(at: lastBucketEnd, grill: 231)
        let after = F.reading(at: lastBucketEnd.addingTimeInterval(30), grill: 232, probe1: nil, probe2: 70)

        let series = ChartSeries(chart: F.twoHours, pushed: [after, inside, atEnd], unit: .fahrenheit)

        #expect(series.rows.count == 4)
        #expect(series.rows[2] == ChartRow(t: lastBucketEnd, values: [.grill: F.value(231), .probe1: F.value(150)]))
        #expect(series.rows[3] == ChartRow(t: lastBucketEnd.addingTimeInterval(30), values: [.grill: F.value(232), .probe2: F.value(70)]))
        #expect(!series.rows.contains { $0[.grill]?.avg == 999 })
        #expect(series.channels == [.grill, .probe1, .probe2])
    }

    @Test("appends every pushed reading when the chart has no points")
    func noPoints() {
        let pushed = [F.reading(at: F.t0, grill: 200, probe1: nil)]
        let series = ChartSeries(chart: F.chart([]), pushed: pushed, unit: .fahrenheit)
        #expect(series.rows == [ChartRow(t: F.t0, values: [.grill: F.value(200)])])
        #expect(series.channels == [.grill])
    }

    @Test("an empty chart with nothing pushed has no rows and no channels")
    func empty() {
        let series = ChartSeries(chart: F.chart([]), pushed: [], unit: .fahrenheit)
        #expect(series.rows.isEmpty)
        #expect(series.channels.isEmpty)
    }

    @Test("caps pushed rows at 2000, keeping the newest, oldest first")
    func cap() {
        #expect(ChartSeries.maxPushedRows == 2000)
        let start = F.t0.addingTimeInterval(2 * F.hour)
        let pushed = (0..<(ChartSeries.maxPushedRows + 50)).map { i in
            F.reading(at: start.addingTimeInterval(Double(i)), grill: Double(i))
        }
        let series = ChartSeries(chart: F.twoHours, pushed: pushed.reversed(), unit: .fahrenheit)
        #expect(series.rows.count == 2 + ChartSeries.maxPushedRows)
        let live = Array(series.rows.dropFirst(2))
        #expect(live.first?[.grill]?.avg == 50)
        #expect(live.last?[.grill]?.avg == Double(ChartSeries.maxPushedRows + 49))
        #expect(zip(live, live.dropFirst()).allSatisfy { $0.t < $1.t })
    }

    @Test("converts server and pushed values to celsius with the live panel's rounding")
    func celsius() {
        let pushed = [F.reading(at: F.t0.addingTimeInterval(2 * F.hour), grill: 225, probe1: 32)]
        let series = ChartSeries(chart: F.twoHours, pushed: pushed, unit: .celsius)
        // 230 °F = 110 °C, 220 °F = 104.4 °C, 240 °F = 115.6 °C.
        #expect(series.rows[0][.grill] == ChannelValue(avg: 110, lo: 104.4, hi: 115.6))
        #expect(series.rows[1][.grill] == ChannelValue(avg: 109.7, lo: 107.2, hi: 112.8))
        #expect(series.rows[2] == ChartRow(
            t: F.t0.addingTimeInterval(2 * F.hour), values: [.grill: F.value(107.2), .probe1: F.value(0)]
        ))
    }

    @Test("a pushed reading whose timestamp does not parse is dropped")
    func unparsable() {
        var bad = F.reading(at: F.t0)
        bad.timestamp = "not a date"
        let series = ChartSeries(chart: F.chart([]), pushed: [bad], unit: .fahrenheit)
        #expect(series.rows.isEmpty)
    }

    @Test("a channel missing from a row is a gap: its line breaks there, and a lone value is its own run")
    func gaps() {
        let chart = F.chart([
            .init(t: F.t0, grill: F.channel(1, 3, 2), probe2: F.channel(10, 10, 10)),
            .init(t: F.t0.addingTimeInterval(F.hour), grill: F.channel(1, 3, 2), probe2: F.channel(11, 11, 11)),
            .init(t: F.t0.addingTimeInterval(2 * F.hour), grill: F.channel(1, 3, 2)),
            .init(t: F.t0.addingTimeInterval(3 * F.hour), grill: F.channel(1, 3, 2), probe2: F.channel(12, 12, 12)),
        ])
        let series = ChartSeries(chart: chart, pushed: [], unit: .fahrenheit)
        let probe2 = series.segments(of: .probe2)
        #expect(probe2.map(\.id) == ["probe2-0", "probe2-1"])
        #expect(probe2.map { $0.points.map(\.value.avg) } == [[10, 11], [12]])
        #expect(probe2[1].points[0].t == F.t0.addingTimeInterval(3 * F.hour))
        #expect(series.segments(of: .grill).map(\.points.count) == [4])
        #expect(series.segments(of: .probe4).isEmpty)
    }

    @Test("the nearest row to a time, and each channel's value there with the bucket's range")
    func selection() throws {
        let pushed = [F.reading(at: F.t0.addingTimeInterval(2 * F.hour), grill: 231, probe1: nil)]
        let series = ChartSeries(chart: F.twoHours, pushed: pushed, unit: .fahrenheit)
        #expect(series.row(nearest: F.t0.addingTimeInterval(-600))?.t == F.t0)
        #expect(series.row(nearest: F.t0.addingTimeInterval(0.4 * F.hour))?.t == F.t0)
        #expect(series.row(nearest: F.t0.addingTimeInterval(0.6 * F.hour))?.t == F.t0.addingTimeInterval(F.hour))
        let last = try #require(series.row(nearest: F.t0.addingTimeInterval(9 * F.hour)))
        #expect(last.t == F.t0.addingTimeInterval(2 * F.hour))

        let first = series.values(in: series.rows[1], unit: .fahrenheit)
        #expect(first.map(\.channel) == [.grill, .probe1])
        #expect(first.map(\.text) == ["229.5 °F (225–235)", "135 °F (120–150)"])
        // A pushed reading has no range, and lists only the channels it has.
        #expect(series.values(in: last, unit: .fahrenheit).map(\.text) == ["231 °F"])
        #expect(ChartSeries(chart: F.chart([]), pushed: [], unit: .fahrenheit).row(nearest: F.t0) == nil)
    }

    @Test("the summary names the channels, counts the points, and gives each channel's latest value")
    func summary() {
        let pushed = [F.reading(at: F.t0.addingTimeInterval(2 * F.hour), grill: 231, probe1: nil)]
        let series = ChartSeries(chart: F.twoHours, pushed: pushed, unit: .fahrenheit)
        #expect(series.summary(unit: .fahrenheit) == "Grill, Probe 1; 3 points; latest Grill 231 °F, Probe 1 135 °F")
        let one = ChartSeries(chart: F.chart([]), pushed: [F.reading(at: F.t0, grill: 212, probe1: nil)], unit: .celsius)
        #expect(one.summary(unit: .celsius) == "Grill; 1 point; latest Grill 100 °C")
    }
}

// MARK: - CookChartModel

/// A chart model for "cook-1" over a stub whose chart route answers
/// `answer(call)`, counting calls from 1.
@MainActor
final class ChartHarness {
    let calls = Box(0)
    let unit = Box<TemperatureUnit>(.fahrenheit)
    private(set) var session: SessionModel!
    private(set) var model: CookChartModel!

    func open(_ answer: @escaping @Sendable (Int) -> Operations.GetCookChart.Output) async {
        var api = StubAPI()
        let calls = self.calls
        api.getCookChartHandler = { input in
            #expect(input.path.cookId == "cook-1")
            calls.value += 1
            return answer(calls.value)
        }
        session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let unit = self.unit
        model = CookChartModel(cookID: "cook-1", session: session) { unit.value }
    }

    nonisolated static func ok(_ chart: CookChart = ChartFixtures.twoHours) -> Operations.GetCookChart.Output {
        .ok(.init(body: .json(chart)))
    }
}

@Suite("CookChartModel")
@MainActor
struct CookChartModelTests {
    typealias F = ChartFixtures

    @Test("loading, then loaded with the series, once the cook's status is known")
    func loads() async throws {
        let h = ChartHarness()
        await h.open { _ in ChartHarness.ok() }
        #expect(h.model.state == .loading)
        #expect(h.model.series == nil)
        #expect(h.calls.value == 0)

        h.model.cookStatus(.completed)
        #expect(h.model.state == .loading)
        await h.model.waitForLoad()
        #expect(h.model.state == .loaded(F.twoHours))
        let series = try #require(h.model.series)
        #expect(series.rows.count == 2)
        #expect(series.channels == [.grill, .probe1])
        #expect(h.calls.value == 1)

        // The same status again reads nothing.
        h.model.cookStatus(.completed)
        await h.model.waitForLoad()
        #expect(h.calls.value == 1)
    }

    @Test("404 is Chart not available")
    func notAvailable() async {
        let h = ChartHarness()
        await h.open { _ in .notFound(.init(body: .json(CookFixtures.error(.notFound, "Cook not found")))) }
        h.model.cookStatus(.completed)
        await h.model.waitForLoad()
        #expect(h.model.state == .notAvailable)
        #expect(CookChartModel.notAvailableText == "Chart not available")
    }

    @Test("an error shows the API's problem; Retry shows loading and reads it again")
    func retry() async {
        let h = ChartHarness()
        await h.open { call in
            call == 1
                ? .internalServerError(.init(body: .json(CookFixtures.error(.internalServerError, "Something broke", "req-500"))))
                : ChartHarness.ok()
        }
        h.model.cookStatus(.completed)
        await h.model.waitForLoad()
        guard case .failed(let problem) = h.model.state else {
            Issue.record("expected an error, got \(h.model.state)")
            return
        }
        #expect(problem.message == "Something broke")
        #expect(problem.requestID == "req-500")
        #expect(problem.status == 500)

        h.model.retry()
        #expect(h.model.state == .loading)
        await h.model.waitForLoad()
        #expect(h.model.state == .loaded(F.twoHours))
        #expect(h.calls.value == 2)
    }

    @Test("a network error is a problem too")
    func networkError() async {
        var api = StubAPI()
        api.getCookChartHandler = { _ in throw URLError(.notConnectedToInternet) }
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let model = CookChartModel(cookID: "cook-1", session: session) { .fahrenheit }
        model.cookStatus(.active)
        await model.waitForLoad()
        guard case .failed = model.state else {
            Issue.record("expected an error, got \(model.state)")
            return
        }
    }

    @Test("a 401 ends the session")
    func unauthorized() async {
        let h = ChartHarness()
        await h.open { _ in .unauthorized(DeviceFixtures.unauthorized) }
        h.model.cookStatus(.completed)
        await h.model.waitForLoad()
        #expect(h.session.state == DeviceFixtures.ended)
        #expect(h.model.state == .loading)
    }

    @Test("no points and nothing pushed: loaded, with no rows (No readings yet)")
    func noReadings() async throws {
        let h = ChartHarness()
        await h.open { _ in ChartHarness.ok(F.chart([])) }
        h.model.cookStatus(.active)
        await h.model.waitForLoad()
        #expect(try #require(h.model.series).rows.isEmpty)
        #expect(CookChartModel.emptyText == "No readings yet")
    }

    @Test("a pushed reading after the last bucket appends a row; one inside it does not")
    func pushedRows() async throws {
        let h = ChartHarness()
        await h.open { _ in ChartHarness.ok() }
        h.model.cookStatus(.active)
        await h.model.waitForLoad()

        h.model.append(F.reading(at: F.t0.addingTimeInterval(1.5 * F.hour)))
        #expect(try #require(h.model.series).rows.count == 2)
        let pushedAt = F.t0.addingTimeInterval(2 * F.hour + 30)
        h.model.append(F.reading(at: pushedAt, probe2: 70))
        let series = try #require(h.model.series)
        #expect(series.rows.count == 3)
        #expect(series.rows.last?.t == pushedAt)
        #expect(series.channels == [.grill, .probe1, .probe2])
    }

    @Test("readings pushed before the chart loads are drawn once it has")
    func pushedBeforeLoad() async throws {
        let h = ChartHarness()
        await h.open { _ in ChartHarness.ok(F.chart([])) }
        h.model.append(F.reading(at: F.t0))
        h.model.cookStatus(.active)
        await h.model.waitForLoad()
        #expect(try #require(h.model.series).rows.count == 1)
    }

    @Test("keeps at most 2000 pushed readings, the newest")
    func pushedCap() async {
        let h = ChartHarness()
        await h.open { _ in ChartHarness.ok() }
        for i in 0..<(ChartSeries.maxPushedRows + 5) {
            h.model.append(F.reading(at: F.t0.addingTimeInterval(Double(i)), grill: Double(i)))
        }
        #expect(h.model.pushed.count == ChartSeries.maxPushedRows)
        #expect(h.model.pushed.first?.grillTemp == 5)
    }

    @Test("the series is in the device's unit, read when it is built")
    func unit() async throws {
        let h = ChartHarness()
        await h.open { _ in ChartHarness.ok() }
        h.model.cookStatus(.completed)
        await h.model.waitForLoad()
        #expect(try #require(h.model.series).rows[0][.grill]?.avg == 230)
        h.unit.value = .celsius
        #expect(h.model.unit == .celsius)
        #expect(try #require(h.model.series).rows[0][.grill]?.avg == 110)
    }

    @Test("a status change reads the chart again, keeping the old one until the new one answers")
    func statusChange() async throws {
        let h = ChartHarness()
        await h.open { call in
            call == 1 ? ChartHarness.ok(F.chart([])) : ChartHarness.ok()
        }
        h.model.cookStatus(.active)
        await h.model.waitForLoad()
        #expect(try #require(h.model.series).rows.isEmpty)

        h.model.cookStatus(.completed)
        #expect(h.model.state == .loaded(F.chart([])))
        await h.model.waitForLoad()
        #expect(h.model.state == .loaded(F.twoHours))
        #expect(h.calls.value == 2)
        #expect(h.model.loadsStarted == 2)
    }

    @Test("a load overtaken by a newer one is dropped")
    func overtaken() async {
        let h = ChartHarness()
        let gate = Gate()
        var api = StubAPI()
        let calls = h.calls
        api.getCookChartHandler = { _ in
            calls.value += 1
            if calls.value == 1 {
                await gate.pass()
                return .notFound(.init(body: .json(CookFixtures.error(.notFound, "late"))))
            }
            return ChartHarness.ok()
        }
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let model = CookChartModel(cookID: "cook-1", session: session) { .fahrenheit }
        model.cookStatus(.active)
        await gate.waitUntilEntered()
        model.cookStatus(.completed)
        await model.waitForLoad()
        #expect(model.state == .loaded(F.twoHours))

        #expect(model.loadsAnswered == 1)
        gate.open()
        await until("the overtaken load answered") { model.loadsAnswered == 2 }
        #expect(model.state == .loaded(F.twoHours))
    }
}

// MARK: - The cook screen

@Suite("Cook detail with the chart")
@MainActor
struct CookDetailChartTests {
    typealias F = ChartFixtures

    @Test("an active cook's chart loads, appends the live panel's pushes, and reloads once the cook stops")
    func activeThenStopped() async throws {
        let active = CookFixtures.cook("c1", device: "box", status: .active, name: "Brisket")
        let hubs = FakeHubs()
        let clock = VirtualClock()
        let chartCalls = Box(0)
        var api = CookFixtures.api(active: [active]) { _ in CookFixtures.page([active]) }
        api.getCookHandler = { _ in .ok(.init(body: .json(active))) }
        var stopped = active
        stopped.status = .completed
        stopped.endTime = fixedNow
        api.stopCookHandler = { [stopped] _ in .ok(.init(body: .json(stopped))) }
        api.negotiateHandler = { _ in .ok(.init(body: .json(LiveFixtures.info(1)))) }
        api.getCurrentTemperaturesHandler = { _ in
            .ok(.init(body: .json(TemperatureReading(deviceId: "box", timestamp: F.iso(F.t0.addingTimeInterval(9 * F.hour)), grillTemp: 1))))
        }
        api.getCookChartHandler = { input in
            #expect(input.path.cookId == "c1")
            chartCalls.value += 1
            return ChartHarness.ok()
        }
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let devices = DevicesModel(session: session, now: { fixedNow })
        await devices.start()
        let cooks = CooksModel(devices: devices, now: { fixedNow }, live: LiveServices(createHub: hubs.factory, sleep: clock.sleep))

        let detail = CookDetailModel(cookID: "c1", cooks: cooks)
        #expect(detail.chart == nil)
        detail.appear()
        await detail.start()
        let chart = try #require(detail.chart)
        await chart.waitForLoad()
        #expect(chartCalls.value == 1)
        #expect(try #require(chart.series).rows.count == 2)

        let live = try #require(detail.live)
        await until("connected and backfilled") { live.status == .connected && live.backfillsAnswered == 1 }
        // The backfill is not a push: the chart does not draw it.
        #expect(chart.pushed.isEmpty)

        let hub = try #require(hubs.latest)
        hub.emit(F.reading(at: F.t0.addingTimeInterval(2 * F.hour + 30)))
        hub.emit(F.reading(at: F.t0.addingTimeInterval(2 * F.hour + 60), device: "kettle"))
        #expect(chart.pushed.count == 1)
        #expect(try #require(chart.series).rows.count == 3)
        // One connection for the screen: the chart opens none of its own.
        #expect(hubs.hubs.count == 1)

        await detail.stop()
        #expect(detail.cook?.status == .completed)
        #expect(detail.chart === chart)
        await chart.waitForLoad()
        #expect(chartCalls.value == 2)
        #expect(hubs.hubs.count == 1)
    }

    @Test("an ended cook's screen has a chart and no live panel")
    func ended() async throws {
        let done = CookFixtures.cook("c2", device: "box", status: .completed)
        var api = CookFixtures.api()
        api.getCookHandler = { _ in .ok(.init(body: .json(done))) }
        api.getCookChartHandler = { _ in ChartHarness.ok() }
        let (_, _, cooks) = await CookFixtures.models(api)
        let detail = CookDetailModel(cookID: "c2", cooks: cooks)
        await detail.start()
        let chart = try #require(detail.chart)
        await chart.waitForLoad()
        #expect(detail.live == nil)
        #expect(chart.state == .loaded(F.twoHours))
    }

    @Test("a celsius device's chart is in °C")
    func celsiusDevice() async throws {
        let done = CookFixtures.cook("c3", device: "box", status: .completed)
        var api = CookFixtures.api()
        var box = DeviceFixtures.box
        box.configuration = .init(temperatureUnit: .celsius)
        api.getDevicesHandler = { [box] _ in .ok(.init(body: .json(.init(devices: [box])))) }
        api.getCookHandler = { _ in .ok(.init(body: .json(done))) }
        api.getCookChartHandler = { _ in ChartHarness.ok() }
        let (_, _, cooks) = await CookFixtures.models(api)
        let detail = CookDetailModel(cookID: "c3", cooks: cooks)
        await detail.start()
        let chart = try #require(detail.chart)
        await chart.waitForLoad()
        #expect(chart.unit == .celsius)
        #expect(try #require(chart.series).rows[0][.grill]?.avg == 110)
    }
}

// MARK: - UI test mode's chart route

@Suite("UI test mode's chart")
@MainActor
struct StubChartTests {
    static func chart(_ api: StubAPI, _ id: String) async throws -> Operations.GetCookChart.Output {
        try await api.getCookChart(path: .init(cookId: id))
    }

    @Test("a seeded cook: 360 one-minute buckets with probe 2 missing from some; 404 and fail-once cooks")
    func seeded() async throws {
        let api = StubAPI.uiTest()
        guard case .ok(let ok) = try await Self.chart(api, "seeded-cook-1") else {
            Issue.record("expected 200")
            return
        }
        let chart = try ok.body.json
        #expect(chart.bucketSeconds == ._60)
        #expect(chart.points.count == 360)
        #expect(chart.points.first?.t == chart.startTime)
        #expect(chart.points.allSatisfy { $0.grill != nil && $0.probe1 != nil && $0.probe3 == nil })
        #expect(chart.points.filter { $0.probe2 == nil }.count == 55)
        let series = ChartSeries(chart: chart, pushed: [], unit: .fahrenheit)
        #expect(series.channels == [.grill, .probe1, .probe2])
        #expect(series.segments(of: .probe2).map(\.points.count) == [110, 195])

        guard case .notFound = try await Self.chart(api, StubCooks.noChartCookID) else {
            Issue.record("expected 404 for \(StubCooks.noChartCookID)")
            return
        }
        guard case .internalServerError = try await Self.chart(api, StubCooks.failsOnceCookID),
              case .ok = try await Self.chart(api, StubCooks.failsOnceCookID) else {
            Issue.record("expected 500 then 200 for \(StubCooks.failsOnceCookID)")
            return
        }
        guard case .notFound = try await Self.chart(api, "no-such-cook") else {
            Issue.record("expected 404 for an unknown cook")
            return
        }
    }

    @Test("a started cook's chart is empty while active, and buckets its pushed readings once stopped")
    func started() async throws {
        let clock = StubClock()
        let (api, live) = StubAPI.uiTestWithLive(clock: clock)
        let session = SessionModel(tokenProvider: FakeTokenProvider(account: DeviceFixtures.account), api: api)
        await session.restore()
        let devices = DevicesModel(session: session, now: { clock.now })
        await devices.start()
        let cooks = CooksModel(devices: devices, now: { clock.now }, live: live.services)
        let device = try #require(devices.device(id: StubDevices.connectedID))
        let form = StartCookModel(device: device, cooks: cooks)
        form.input = StartCookInput(name: "Chart Brisket", meatType: "beef")
        let cook = try #require(await form.submit())

        let detail = CookDetailModel(cookID: cook.id, cooks: cooks)
        detail.appear()
        await detail.start()
        let chart = try #require(detail.chart)
        await chart.waitForLoad()
        #expect(chart.state == .loaded(CookChart(
            cookId: cook.id, deviceId: cook.deviceId, startTime: cook.startTime, bucketSeconds: ._60, points: []
        )))
        await until("the first push on the chart") { chart.series?.rows.count == 1 }
        #expect(chart.series?.summary(unit: .fahrenheit) == "Grill, Probe 1; 1 point; latest Grill 225 °F, Probe 1 150 °F")
        live.dropConnection()
        live.reconnectNow()
        await until("the second push on the chart") { chart.series?.rows.count == 2 }

        await detail.stop()
        await chart.waitForLoad()
        let series = try #require(chart.series)
        // One bucket of the two pushes (225 and 226; 150 and 151); the pushed
        // rows fall inside it, so they are not drawn again.
        #expect(series.rows.count == 1)
        #expect(series.rows[0].t == cook.startTime)
        #expect(series.rows[0][.grill] == ChannelValue(avg: 225.5, lo: 225, hi: 226))
        #expect(series.rows[0][.probe1] == ChannelValue(avg: 150.5, lo: 150, hi: 151))
        #expect(series.summary(unit: .fahrenheit) == "Grill, Probe 1; 1 point; latest Grill 225.5 °F, Probe 1 150.5 °F")
    }
}
