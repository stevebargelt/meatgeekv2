import Foundation
public import MeatGeekAPI
import Observation

/// `GET /cooks/{cookId}/chart` drawn as one chart, with the readings pushed
/// since it loaded appended after its last bucket. A port of
/// apps/web/src/cooks/cook-chart.tsx.
///
/// Loads when it first learns the cook's status, again whenever the status
/// changes (once a cook is completed, the stored series covers all of it),
/// and on Retry after an error. A load that a newer one has overtaken is
/// dropped. Pushed readings come from the cook screen's one live connection
/// (`LivePanelModel`'s `onReading`), kept to the chart's cap.
@MainActor
@Observable
public final class CookChartModel {
    public enum State: Equatable, Sendable {
        case loading
        /// 404: the API has no chart for this cook.
        case notAvailable
        case failed(APIProblem)
        case loaded(CookChart)
    }

    public nonisolated static let loadingText = "Loading chart…"
    public nonisolated static let notAvailableText = "Chart not available"
    public nonisolated static let emptyText = "No readings yet"

    public let cookID: String
    public private(set) var state: State = .loading
    /// Readings pushed while the screen showed, oldest first, at most
    /// `ChartSeries.maxPushedRows`: older ones can never be drawn.
    public private(set) var pushed: [TemperatureMessage] = []

    @ObservationIgnored private let session: SessionModel
    @ObservationIgnored private let unitSource: @MainActor () -> TemperatureUnit
    @ObservationIgnored private var status: Components.Schemas.CookStatus?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var task: Task<Void, Never>?
    /// Loads started, for tests.
    @ObservationIgnored public private(set) var loadsStarted = 0
    /// Loads that have answered, applied or dropped, for tests.
    @ObservationIgnored public private(set) var loadsAnswered = 0

    /// - Parameter unit: the device's temperature unit, read whenever the
    ///   series is built (the devices may be read after the chart).
    public init(cookID: String, session: SessionModel, unit: @escaping @MainActor () -> TemperatureUnit) {
        self.cookID = cookID
        self.session = session
        self.unitSource = unit
    }

    public var unit: TemperatureUnit { unitSource() }

    /// The rows to draw, once the chart has loaded.
    public var series: ChartSeries? {
        guard case .loaded(let chart) = state else { return nil }
        return ChartSeries(chart: chart, pushed: pushed, unit: unit)
    }

    /// The cook's status as the screen shows it. The first one loads the
    /// chart; a change (active to completed) loads it again, keeping the
    /// chart on screen until the new one answers.
    public func cookStatus(_ status: Components.Schemas.CookStatus) {
        guard status != self.status else { return }
        self.status = status
        load()
    }

    /// After an error: loading, then the chart again.
    public func retry() {
        state = .loading
        load()
    }

    /// A reading pushed over the cook screen's live connection.
    public func append(_ message: TemperatureMessage) {
        pushed.append(message)
        if pushed.count > ChartSeries.maxPushedRows {
            pushed.removeFirst(pushed.count - ChartSeries.maxPushedRows)
        }
    }

    /// Returns once the latest load has answered, for tests.
    public func waitForLoad() async {
        while let task {
            await task.value
            if task == self.task { return }
        }
    }

    private func load() {
        generation += 1
        loadsStarted += 1
        let current = generation
        task = Task { await fetch(current) }
    }

    private func fetch(_ current: Int) async {
        defer { loadsAnswered += 1 }
        let id = cookID
        let next: State
        do {
            let output = try await session.perform { api in try await api.getCookChart(path: .init(cookId: id)) }
            switch output {
            case .ok(let ok):
                next = .loaded(try ok.body.json)
            case .notFound:
                next = .notAvailable
            case .unauthorized:
                session.endSession()
                return
            case .badRequest(let response):
                next = .failed(APIProblem(status: 400, body: try? response.body.json))
            case .internalServerError(let response):
                next = .failed(APIProblem(status: 500, body: try? response.body.json))
            case .undocumented(let status, _):
                next = .failed(APIProblem(status: status, body: nil))
            }
        } catch SessionError.sessionEnded {
            // Signed out; the root screen says why.
            return
        } catch {
            next = .failed(APIProblem(error: error))
        }
        guard current == generation else { return }
        state = next
    }
}
