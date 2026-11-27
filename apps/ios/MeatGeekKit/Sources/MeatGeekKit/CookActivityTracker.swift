import Foundation

/// Keeps one lock-screen activity per running cook the app started or
/// stopped (#271), through the `LiveActivities` port.
///
/// - A running cook handed to `cookChanged(_:)` gets an activity: one the
///   system is already showing for it (from an earlier launch) is taken
///   over, otherwise a new one is started. A later call with the same cook
///   (its targets changed) updates it.
/// - A cook that is no longer running ends its activity.
/// - Each time the app becomes active, every activity the system shows is
///   checked against its cook on the API: a running cook's is taken over and
///   followed, a stopped or missing cook's is ended. So an activity from an
///   earlier launch keeps up, and a cook stopped elsewhere while the app was
///   in the background ends.
/// - While any activity is tracked and the app is active, it holds its own
///   live connection (`LiveConnection`, as the cook screen's panel does), and
///   each `temperature` message from a tracked cook's device updates that
///   cook's activity; `cook_stopped` ends it and goes to `onCookStopped`.
///   With no live services (UI test mode) activities are started and ended
///   but never updated with readings.
///
/// The system refusing an activity (Live Activities off in Settings) is not
/// an error the user sees: the cook simply has none.
@MainActor
public final class CookActivityTracker {
    private struct Tracked {
        let activityID: String
        var cook: Cook
        var reading: LiveReading?
    }

    private let session: SessionModel
    private let activities: any LiveActivities
    private let live: LiveServices?
    private let unit: @MainActor (String) -> TemperatureUnit
    private let now: @Sendable () -> Date
    private var tracked: [String: Tracked] = [:]
    private var connection: LiveConnection?
    private var appActive = true
    /// The check of the shown activities in progress, if any.
    private var reconciling: Task<Void, Never>?
    /// Activities the tracker has ended, so a check that read their cook
    /// before they ended does not take them over again.
    private var ended: Set<String> = []
    /// `stop()` was called (signed out): nothing is taken over, started or
    /// followed after it.
    private var stopped = false

    /// A `cook_stopped` for a tracked cook arrived on the tracker's connection.
    public var onCookStopped: @MainActor (Cook) -> Void = { _ in }

    /// - Parameters:
    ///   - now: the clock each update's send time (`updatedAt`) is read
    ///     from: the activity goes stale three minutes after it.
    ///   - unit: the unit of the device with this id.
    public init(
        session: SessionModel,
        activities: any LiveActivities,
        live: LiveServices?,
        now: @escaping @Sendable () -> Date = { Date() },
        unit: @escaping @MainActor (String) -> TemperatureUnit
    ) {
        self.session = session
        self.activities = activities
        self.live = live
        self.now = now
        self.unit = unit
    }

    /// The ids of the cooks with an activity.
    public var trackedCookIDs: Set<String> { Set(tracked.keys) }

    /// Whether the tracker's own live connection is open (or retrying).
    public var isConnected: Bool { connection != nil }

    /// Whether the check of the shown activities is still out (after
    /// `stop()`, until its dropped read has come back).
    public var isReconciling: Bool { reconciling != nil }

    /// A cook was started, stopped or changed in the app.
    public func cookChanged(_ cook: Cook) {
        guard !stopped else { return }
        if cook.status == .active {
            if var current = tracked[cook.id] {
                current.cook = cook
                tracked[cook.id] = current
                activities.update(current.activityID, content(current))
            } else if let id = activityID(for: cook) {
                tracked[cook.id] = Tracked(activityID: id, cook: cook, reading: nil)
            }
        } else if let current = tracked.removeValue(forKey: cook.id) {
            var ended = current
            ended.cook = cook
            end(current.activityID, content(ended))
        } else {
            // Not taken over yet (an earlier launch's, whose check failed).
            for shown in activities.running() where shown.cookID == cook.id {
                end(shown.id, content(Tracked(activityID: shown.id, cook: cook)))
            }
        }
        updateConnection()
    }

    /// The cook as the API returned it again (the cook screen re-reads it
    /// after each reading): a tracked running cook's activity takes its
    /// targets and reached probes, so a reached mark shows and clears. Starts
    /// nothing; a cook that is not running goes to `cookChanged(_:)`.
    public func cookRead(_ cook: Cook) {
        guard !stopped else { return }
        guard cook.status == .active else {
            if tracked[cook.id] != nil { cookChanged(cook) }
            return
        }
        guard var current = tracked[cook.id], current.cook != cook else { return }
        current.cook = cook
        tracked[cook.id] = current
        activities.update(current.activityID, content(current))
    }

    /// The scene phase: active, or not. Readings are followed only while
    /// active. Each time the app becomes active, every activity the system
    /// shows is checked against its cook (see `reconcile()`).
    public func setAppActive(_ active: Bool) {
        guard !stopped else { return }
        appActive = active
        updateConnection()
        if active { reconcile() }
    }

    /// Checks every activity the system shows, including any from an earlier
    /// launch, against its cook on the API: one whose cook still runs is
    /// taken over and followed; one whose cook has stopped (while the app
    /// was in the background, or before this launch) or no longer exists is
    /// ended. A failed read leaves the activity as it is. Activities are
    /// never started here.
    private func reconcile() {
        guard reconciling == nil else { return }
        let shown = activities.running()
        guard !shown.isEmpty else { return }
        reconciling = Task { [weak self, session] in
            for activity in shown {
                let found = await Self.read(activity.cookID, session)
                guard !Task.isCancelled else { break }
                self?.reconciled(activity, found)
            }
            self?.reconciling = nil
        }
    }

    private enum Found {
        case cook(Cook)
        case gone
        case unknown
    }

    private static func read(_ cookID: String, _ session: SessionModel) async -> Found {
        guard let output = try? await session.perform({ api in try await api.getCook(path: .init(cookId: cookID)) })
        else { return .unknown }
        switch output {
        case .ok(let ok):
            guard let cook = try? ok.body.json else { return .unknown }
            return .cook(cook)
        case .notFound:
            return .gone
        default:
            return .unknown
        }
    }

    private func reconciled(_ activity: RunningCookActivity, _ found: Found) {
        // Ended in the meantime (by the app, while the read was out), or
        // signed out.
        guard !stopped, !ended.contains(activity.id) else { return }
        switch found {
        case .unknown:
            return
        case .gone:
            if let current = tracked[activity.cookID], current.activityID == activity.id {
                tracked[activity.cookID] = nil
                end(activity.id, content(current))
                updateConnection()
            } else {
                end(activity.id, CookActivityPresenter.gone(shown: activities.state(activity.id), now: now()))
            }
        case .cook(let cook) where cook.status != .active:
            if let current = tracked[cook.id], current.activityID == activity.id {
                // Stopped while the app was away: the lists still show it
                // running, as after a `cook_stopped`.
                cookChanged(cook)
                onCookStopped(cook)
            } else {
                // From an earlier launch: this launch's lists read it already.
                end(activity.id, content(Tracked(activityID: activity.id, cook: cook)))
            }
        case .cook(let cook):
            if let current = tracked[cook.id] {
                // A second activity for a cook that already has one.
                if current.activityID != activity.id {
                    end(activity.id, content(current))
                }
                return
            }
            let adopted = Tracked(activityID: activity.id, cook: cook, reading: nil)
            tracked[cook.id] = adopted
            activities.update(activity.id, content(adopted))
            updateConnection()
        }
    }

    /// Ends the activity with `state`, keeping the temperatures it shows
    /// when the tracker has followed no reading for it.
    private func end(_ activityID: String, _ state: CookActivityContentState) {
        ended.insert(activityID)
        activities.end(activityID, CookActivityPresenter.ending(state, shown: activities.state(activityID)))
    }

    /// Signed out: stops following readings, for good. A check still out is
    /// dropped, and later calls take over, start and end nothing. The
    /// activities stay.
    public func stop() {
        stopped = true
        reconciling?.cancel()
        closeConnection()
    }

    private func closeConnection() {
        connection?.stop()
        connection = nil
    }

    private func activityID(for cook: Cook) -> String? {
        if let running = activities.running().first(where: { $0.cookID == cook.id }) {
            activities.update(running.id, content(Tracked(activityID: running.id, cook: cook)))
            return running.id
        }
        let attributes = CookActivityPresenter.attributes(for: cook)
        let state = content(Tracked(activityID: "", cook: cook))
        return try? activities.start(attributes, state)
    }

    private func content(_ tracked: Tracked) -> CookActivityContentState {
        CookActivityPresenter.content(for: tracked.cook, reading: tracked.reading, unit: unit(tracked.cook.deviceId), now: now())
    }

    private func updateConnection() {
        let wanted = live != nil && appActive && !tracked.isEmpty
        if wanted, connection == nil {
            open()
        } else if !wanted {
            closeConnection()
        }
    }

    private func open() {
        guard let live else { return }
        let session = self.session
        let connection = LiveConnection(
            negotiate: { await session.negotiateLive() },
            createHub: live.createHub,
            sleep: live.sleep,
            handlers: .init(
                onTemperature: { [weak self] message in self?.reading(message) },
                onCookStopped: { [weak self] message in
                    guard let self, self.tracked[message.payload.id] != nil else { return }
                    self.cookChanged(message.payload)
                    self.onCookStopped(message.payload)
                }
            )
        )
        self.connection = connection
        connection.start()
    }

    private func reading(_ message: TemperatureMessage) {
        guard var current = tracked.values.first(where: { $0.cook.deviceId == message.deviceId }) else { return }
        let next = LiveReading(message)
        // Keep the newer reading: a late one does not replace it.
        if let previous = current.reading?.date, let at = next.date, at < previous { return }
        current.reading = next
        tracked[current.cook.id] = current
        activities.update(current.activityID, content(current))
    }
}
