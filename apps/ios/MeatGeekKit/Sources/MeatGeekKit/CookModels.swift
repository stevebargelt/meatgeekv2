import Foundation
public import MeatGeekAPI
import Observation

/// Starting a cook on one device: name, meat type, weight and targets,
/// checked before `POST /cooks`. Mirrors apps/web/src/cooks/start-cook-form.tsx.
///
/// The cook id is made once, with the model (one start intent), and sent on
/// every submit and retry of it: it is the API's idempotency key. A new form
/// is a new model and a new id.
@MainActor
@Observable
public final class StartCookModel {
    /// Why the cook did not start.
    public enum Outcome: Equatable, Sendable {
        case problem(APIProblem)
        /// 409 COOK_ALREADY_ACTIVE: the device's active cook, to open.
        case alreadyActive(activeCookID: String, problem: APIProblem)
        /// 503 DEVICE_TWIN_UPDATE_FAILED: the cook was saved, the device was
        /// not told. Retry resends the same request.
        case twinFailed(cookID: String, problem: APIProblem)
    }

    public nonisolated static let alreadyActiveMessage = "This device already has an active cook."
    public nonisolated static let twinFailedMessage =
        "The cook was saved, but the device was not told about it. Retry to tell the device."

    public let deviceID: String
    public let deviceName: String
    /// The start intent's id, sent on every submit and retry.
    public let cookID: String
    public var input = StartCookInput()

    public private(set) var fieldErrors = StartCookFieldErrors()
    public private(set) var outcome: Outcome?
    public private(set) var sending = false

    @ObservationIgnored private let cooks: CooksModel
    /// The body last sent, for Retry after a 503.
    @ObservationIgnored private var sent: Components.Schemas.StartCookRequest?

    public init(device: Device, cooks: CooksModel, makeID: () -> String = { UUID().uuidString.lowercased() }) {
        self.deviceID = device.id
        self.deviceName = device.name
        self.cookID = makeID()
        self.cooks = cooks
    }

    /// Checks the fields, then starts the cook. Returns it once started
    /// (201, or 200 for a replay), after the lists have it; nil while the
    /// form stays.
    public func submit() async -> Cook? {
        guard !sending else { return nil }
        fieldErrors = CookValidation.validate(input)
        guard fieldErrors.isEmpty else { return nil }
        return await send(CookValidation.request(id: cookID, deviceID: deviceID, input: input))
    }

    /// After a 503: the same request again, which replays the cook and
    /// retries telling the device.
    public func retry() async -> Cook? {
        guard !sending, case .twinFailed = outcome, let sent else { return nil }
        return await send(sent)
    }

    private func send(_ body: Components.Schemas.StartCookRequest) async -> Cook? {
        sending = true
        defer { sending = false }
        sent = body
        let output: Operations.StartCook.Output
        do {
            output = try await cooks.session.perform { api in try await api.startCook(body: .json(body)) }
        } catch SessionError.sessionEnded {
            return nil
        } catch {
            outcome = .problem(APIProblem(error: error))
            return nil
        }
        switch output {
        case .created(let created):
            return started(try? created.body.json)
        case .ok(let ok):
            return started(try? ok.body.json)
        case .unauthorized:
            cooks.session.endSession()
        case .conflict(let response):
            if let body = try? response.body.json {
                outcome = .alreadyActive(activeCookID: body.activeCookId, problem: APIProblem(status: 409, body: body))
            } else {
                outcome = .problem(APIProblem(status: 409, body: nil))
            }
        case .serviceUnavailable(let response):
            if let body = try? response.body.json {
                outcome = .twinFailed(cookID: body.cookId, problem: APIProblem(status: 503, body: body))
            } else {
                outcome = .problem(APIProblem(status: 503, body: nil))
            }
        case .badRequest(let response):
            outcome = .problem(APIProblem(status: 400, body: try? response.body.json))
        case .forbidden(let response):
            outcome = .problem(APIProblem(status: 403, body: try? response.body.json))
        case .unprocessableContent(let response):
            outcome = .problem(APIProblem(status: 422, body: try? response.body.json))
        case .internalServerError(let response):
            outcome = .problem(APIProblem(status: 500, body: try? response.body.json))
        case .undocumented(let status, _):
            outcome = .problem(APIProblem(status: status, body: nil))
        }
        return nil
    }

    private func started(_ cook: Cook?) -> Cook? {
        guard let cook else {
            outcome = .problem(APIProblem(message: "The cook was started, but the answer could not be read."))
            return nil
        }
        outcome = nil
        cooks.apply(cook)
        return cook
    }
}

/// One cook: its fields, Stop while it is active, the live panel of an
/// active cook, and the chart. Mirrors apps/web/src/cooks/cook-detail-page.tsx.
@MainActor
@Observable
public final class CookDetailModel {
    public enum State: Equatable, Sendable {
        case loading
        /// 404: no such cook for this user.
        case notFound
        case failed(APIProblem)
        case loaded(Cook)
    }

    public enum StopState: Equatable, Sendable {
        case idle
        case stopping
        /// 503 DEVICE_TWIN_UPDATE_FAILED: the cook is completed, the device
        /// was not told. Stopping again is safe and retries it.
        case twinFailed(APIProblem)
        case failed(APIProblem)
    }

    public nonisolated static let notFoundMessage = "This cook was not found"
    public nonisolated static let stopTwinFailedMessage =
        "The cook was stopped, but the device was not told. Retry to tell the device."

    /// The stop confirmation: "Stop <name>?", then what stopping does.
    public nonisolated static func stopConfirmTitle(name: String) -> String { "Stop \(name)?" }
    public nonisolated static let stopConfirmMessage = "The cook is marked completed and the device is told to stop."

    public let cookID: String
    public private(set) var state: State = .loading
    public private(set) var stopState: StopState = .idle
    /// The live temperatures, while the cook is active and the app has live
    /// services (`CooksModel.live`). A `cook_stopped` for this cook ends it
    /// and shows the cook as it stopped.
    public private(set) var live: LivePanelModel?
    /// The cook's chart, once the cook has loaded: shown for active and
    /// ended cooks, reloaded when the cook's status changes, with the live
    /// panel's pushed readings appended.
    public private(set) var chart: CookChartModel?

    @ObservationIgnored private let cooks: CooksModel
    @ObservationIgnored private var started = false
    /// The screen is showing, and the app is active: passed on to the live
    /// panel, including one made after the cook loads.
    @ObservationIgnored private var visible = false
    @ObservationIgnored private var appActive = true

    public init(cookID: String, cooks: CooksModel) {
        self.cookID = cookID
        self.cooks = cooks
    }

    /// The first time the screen shows: `GET /cooks/{cookId}`. Later calls
    /// do nothing; `reload()` reads it again.
    public func start() async {
        guard !started else { return }
        started = true
        await reload()
    }

    /// `GET /cooks/{cookId}`. A re-read keeps the cook on screen until it
    /// answers.
    public func reload() async {
        let id = cookID
        do {
            let output = try await cooks.session.perform { api in try await api.getCook(path: .init(cookId: id)) }
            switch output {
            case .ok(let ok):
                show(try ok.body.json)
            case .notFound:
                state = .notFound
            case .unauthorized:
                cooks.session.endSession()
            case .badRequest(let response):
                state = .failed(APIProblem(status: 400, body: try? response.body.json))
            case .internalServerError(let response):
                state = .failed(APIProblem(status: 500, body: try? response.body.json))
            case .undocumented(let status, _):
                state = .failed(APIProblem(status: status, body: nil))
            }
        } catch SessionError.sessionEnded {
            // Signed out; the root screen says why.
        } catch {
            state = .failed(APIProblem(error: error))
        }
    }

    /// `POST /cooks/{cookId}/stop`, after the screen has asked. The stopped
    /// cook replaces the shown one, and the lists have it.
    public func stop() async {
        guard case .loaded(let cook) = state, stopState != .stopping else { return }
        stopState = .stopping
        let id = cook.id
        let output: Operations.StopCook.Output
        do {
            output = try await cooks.session.perform { api in try await api.stopCook(path: .init(cookId: id)) }
        } catch SessionError.sessionEnded {
            stopState = .idle
            return
        } catch {
            stopState = .failed(APIProblem(error: error))
            return
        }
        switch output {
        case .ok(let ok):
            guard let stopped = try? ok.body.json else {
                stopState = .failed(APIProblem(message: "The cook was stopped, but the answer could not be read."))
                return
            }
            show(stopped)
            stopState = .idle
            cooks.apply(stopped)
        case .unauthorized:
            stopState = .idle
            cooks.session.endSession()
        case .serviceUnavailable(let response):
            let body = try? response.body.json
            stopState = body?.error == .deviceTwinUpdateFailed
                ? .twinFailed(APIProblem(status: 503, body: body))
                : .failed(APIProblem(status: 503, body: body))
        case .badRequest(let response):
            stopState = .failed(APIProblem(status: 400, body: try? response.body.json))
        case .forbidden(let response):
            stopState = .failed(APIProblem(status: 403, body: try? response.body.json))
        case .notFound(let response):
            stopState = .failed(APIProblem(status: 404, body: try? response.body.json))
        case .internalServerError(let response):
            stopState = .failed(APIProblem(status: 500, body: try? response.body.json))
        case .undocumented(let status, _):
            stopState = .failed(APIProblem(status: status, body: nil))
        }
    }

    /// The screen is showing: the live panel connects.
    public func appear() {
        visible = true
        live?.appear()
    }

    /// The screen went away: the live panel disconnects.
    public func disappear() {
        visible = false
        live?.disappear()
    }

    /// The scene phase: the live panel disconnects in the background and
    /// connects again in the foreground.
    public func setAppActive(_ active: Bool) {
        appActive = active
        live?.setAppActive(active)
    }

    /// Shows `cook`, and keeps the live panel in step: one for an active
    /// cook, none once it has ended.
    private func show(_ cook: Cook) {
        state = .loaded(cook)
        if chart == nil {
            let devices = cooks.devices
            let deviceID = cook.deviceId
            chart = CookChartModel(cookID: cook.id, session: cooks.session) {
                devices.device(id: deviceID)?.configuration?.temperatureUnit ?? .fahrenheit
            }
        }
        chart?.cookStatus(cook.status)
        if cook.status == .active {
            guard live == nil, let services = cooks.live else { return }
            let devices = cooks.devices
            let deviceID = cook.deviceId
            live = LivePanelModel(
                cook: cook,
                session: cooks.session,
                device: { devices.device(id: deviceID) },
                services: services,
                now: cooks.now,
                onCookStopped: { [weak self] stopped in self?.cookStopped(stopped) },
                onReading: { [weak self] message in self?.chart?.append(message) }
            )
            live?.setAppActive(appActive)
            if visible { live?.appear() }
        } else if let live {
            live.end(with: cook)
            self.live = nil
        }
    }

    /// `cook_stopped` for this cook arrived: it is ended here and in the lists.
    private func cookStopped(_ cook: Cook) {
        show(cook)
        cooks.apply(cook)
    }

    // MARK: What the screen shows

    public var cook: Cook? {
        if case .loaded(let cook) = state { return cook }
        return nil
    }

    public var isActive: Bool { cook?.status == .active }

    public func deviceName(for cook: Cook) -> String {
        cooks.deviceName(for: cook.deviceId)
    }

    /// The targets the cook has, in TARGET_KEYS order, as "225 °F".
    public func targets(of cook: Cook) -> [(key: TargetKey, text: String)] {
        TargetKey.allCases.compactMap { key in
            key.value(in: cook.targetTemps).map { (key, CookText.temperature($0)) }
        }
    }

    /// An active cook's elapsed time on the injected clock, `H:MM:SS`.
    public func elapsedText(for cook: Cook) -> String {
        CookText.elapsed(cooks.now().timeIntervalSince(cook.startTime))
    }
}
