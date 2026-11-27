import Foundation
public import MeatGeekAPI
import Observation

// Lets SwiftUI list cooks and present them by id.
extension Components.Schemas.Cook: Identifiable {}

/// The Cooks tab: the caller's cooks, newest first, 20 at a time with "Load
/// more", filtered by device and status. Mirrors
/// apps/web/src/cooks/cooks-page.tsx.
///
/// It is also where a started or stopped cook is announced (`apply(_:)`), so
/// the list and the devices' active cooks show it without a re-read.
@MainActor
@Observable
public final class CooksModel {
    public enum ListState: Equatable, Sendable {
        case loading
        /// `continuationToken`: the last page's, sent for the next one.
        case loaded(cooks: [Cook], continuationToken: String?, hasMore: Bool)
        case failed(APIProblem)
    }

    /// A device the list can be filtered by.
    public struct DeviceOption: Equatable, Hashable, Sendable, Identifiable {
        public let id: String
        public let name: String
    }

    public nonisolated static let pageSize = 20
    /// The statuses the list can be filtered by (STATUS_FILTERS).
    public nonisolated static let statusFilters: [Components.Schemas.CookStatus] = [.active, .completed]
    public nonisolated static let emptyMessage = "You have no cooks yet. Start one from a device on the Devices tab."
    public nonisolated static let filteredEmptyMessage = "No cooks match these filters."

    public private(set) var list: ListState = .loading
    /// A "Load more" is running.
    public private(set) var loadingMore = false
    /// Why the last "Load more" failed. Shown under the list, which stays.
    public private(set) var moreProblem: APIProblem?
    public private(set) var deviceFilter: String?
    public private(set) var statusFilter: Components.Schemas.CookStatus?

    @ObservationIgnored public let session: SessionModel
    /// The devices, for their names and active cooks.
    @ObservationIgnored public let devices: DevicesModel
    /// The clock an active cook's elapsed time is measured on.
    @ObservationIgnored public let now: @Sendable () -> Date
    /// What an active cook's live panel connects with; nil: no live panel.
    @ObservationIgnored public let live: LiveServices?
    /// Alerts on this phone: a running cook's screen asks for permission and
    /// says when alerts are off. Nil: no alerts (some tests).
    @ObservationIgnored public let notifications: NotificationsModel?
    @ObservationIgnored private var started = false
    /// Bumped on every reload, so a page that arrives for an old filter is
    /// dropped instead of shown or appended.
    @ObservationIgnored private var generation = 0

    public init(
        devices: DevicesModel,
        now: @escaping @Sendable () -> Date = { Date() },
        live: LiveServices? = nil,
        notifications: NotificationsModel? = nil
    ) {
        self.session = devices.session
        self.devices = devices
        self.now = now
        self.live = live
        self.notifications = notifications
    }

    /// The first time the tab shows: page one. Later calls do nothing.
    public func start() async {
        guard !started else { return }
        started = true
        await reload(showLoading: true)
    }

    /// Pull to refresh: page one again, keeping the list on screen until it
    /// answers.
    public func refresh() async {
        await reload(showLoading: false)
    }

    /// Only cooks on this device (nil: every device); restarts at page one.
    public func setDeviceFilter(_ deviceID: String?) async {
        guard deviceID != deviceFilter else { return }
        deviceFilter = deviceID
        started = true
        await reload(showLoading: true)
    }

    /// Only cooks in this status (nil: any); restarts at page one.
    public func setStatusFilter(_ status: Components.Schemas.CookStatus?) async {
        guard status != statusFilter else { return }
        statusFilter = status
        started = true
        await reload(showLoading: true)
    }

    /// Every cook again; restarts at page one.
    public func clearFilters() async {
        guard isFiltered else { return }
        deviceFilter = nil
        statusFilter = nil
        started = true
        await reload(showLoading: true)
    }

    /// The next page, with the last page's continuation token, appended. A
    /// failure keeps the list and says why in `moreProblem`.
    ///
    /// The page goes onto the list as it is when the page arrives, not as it
    /// was when it was asked for, so a cook `apply(_:)` started or stopped
    /// meanwhile stays. A cook already listed (e.g. one `apply(_:)` put on
    /// top) is not listed twice.
    public func loadMore() async {
        guard case .loaded(_, let token, true) = list, !loadingMore else { return }
        let mine = generation
        loadingMore = true
        moreProblem = nil
        let page = await fetchPage(continuationToken: token)
        guard generation == mine else { return }
        loadingMore = false
        switch page {
        case .page(let page):
            let current = cooks
            let listed = Set(current.map(\.id))
            let added = page.cooks.filter { !listed.contains($0.id) }
            list = .loaded(cooks: current + added, continuationToken: page.continuationToken, hasMore: page.hasMore)
        case .problem(let problem):
            moreProblem = problem
        case .sessionEnded:
            break
        }
    }

    /// A cook was started or stopped here: it replaces the listed one with
    /// the same id, or goes on top when it is new, or leaves the list when it
    /// no longer matches the filters. The devices' active cooks follow.
    public func apply(_ cook: Cook) {
        devices.apply(cook)
        guard case .loaded(var cooks, let token, let hasMore) = list else { return }
        let matches = (deviceFilter == nil || deviceFilter == cook.deviceId)
            && (statusFilter == nil || statusFilter == cook.status)
        if let index = cooks.firstIndex(where: { $0.id == cook.id }) {
            if matches { cooks[index] = cook } else { cooks.remove(at: index) }
        } else if matches {
            cooks.insert(cook, at: 0)
        }
        list = .loaded(cooks: cooks, continuationToken: token, hasMore: hasMore)
    }

    // MARK: What the screens show

    public var cooks: [Cook] {
        if case .loaded(let cooks, _, _) = list { return cooks }
        return []
    }

    public var hasMore: Bool {
        if case .loaded(_, _, let hasMore) = list { return hasMore }
        return false
    }

    public var isFiltered: Bool { deviceFilter != nil || statusFilter != nil }

    /// What an empty list says: no cooks at all, or none for these filters.
    public var emptyText: String { isFiltered ? Self.filteredEmptyMessage : Self.emptyMessage }

    /// The device's name, or its id when it is not one of the caller's
    /// devices (released, or the devices are not read yet): `deviceLabel`.
    public func deviceName(for deviceID: String) -> String {
        devices.device(id: deviceID)?.name ?? deviceID
    }

    /// The caller's devices, plus the filtered one when it is not among them
    /// (e.g. released): `deviceOptions`.
    public var deviceOptions: [DeviceOption] {
        var options = devices.devices.map { DeviceOption(id: $0.id, name: $0.name) }
        if let deviceFilter, !options.contains(where: { $0.id == deviceFilter }) {
            options.append(DeviceOption(id: deviceFilter, name: deviceFilter))
        }
        return options
    }

    // MARK: Reads

    private enum Page {
        case page(Components.Schemas.CookListResponse)
        case problem(APIProblem)
        case sessionEnded
    }

    private func reload(showLoading: Bool) async {
        generation += 1
        let mine = generation
        loadingMore = false
        moreProblem = nil
        if showLoading { list = .loading }
        let page = await fetchPage(continuationToken: nil)
        guard generation == mine else { return }
        switch page {
        case .page(let page):
            list = .loaded(cooks: page.cooks, continuationToken: page.continuationToken, hasMore: page.hasMore)
        case .problem(let problem):
            list = .failed(problem)
        case .sessionEnded:
            break
        }
    }

    /// `GET /cooks?limit=20` with the filters and, after page one, the
    /// previous page's continuation token.
    private func fetchPage(continuationToken: String?) async -> Page {
        let query = Operations.ListCooks.Input.Query(
            deviceId: deviceFilter,
            status: statusFilter,
            limit: Self.pageSize,
            continuationToken: continuationToken
        )
        do {
            let output = try await session.perform { api in try await api.listCooks(query: query) }
            switch output {
            case .ok(let ok):
                return .page(try ok.body.json)
            case .unauthorized:
                session.endSession()
                return .sessionEnded
            case .badRequest(let response):
                return .problem(APIProblem(status: 400, body: try? response.body.json))
            case .internalServerError(let response):
                return .problem(APIProblem(status: 500, body: try? response.body.json))
            case .undocumented(let status, _):
                return .problem(APIProblem(status: status, body: nil))
            }
        } catch SessionError.sessionEnded {
            return .sessionEnded
        } catch {
            return .problem(APIProblem(error: error))
        }
    }
}
