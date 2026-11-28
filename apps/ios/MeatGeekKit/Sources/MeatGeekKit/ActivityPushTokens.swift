import Foundation
import Observation

/// What a sender needs to reach this phone's lock-screen activities by push
/// (#248): the token that starts an activity by push, and each running
/// activity's update token, as lower-case hex (what APNs takes in its URL).
///
/// Debug builds show it, for the hand-sent trial pushes of
/// `apps/ios/scripts/live-activity-push.mjs` (see the README's "Test pushes
/// by hand"). Read from the `LiveActivities` port. Nothing here logs or sends
/// a token: it is shown on screen, for the owner to copy.
@MainActor
@Observable
public final class ActivityPushTokensModel {
    /// One running activity.
    public struct Entry: Equatable, Sendable, Identifiable {
        public let id: String
        public let cookID: String
        /// Nil until the system issues one. An activity the app started
        /// itself has none: only one started by push takes push updates.
        public var updateToken: String?
        /// When this model received `updateToken`. Compared with
        /// `activeSince`, it shows whether the token came while the app was
        /// away (#249's question) or only once it was opened.
        public var updateTokenReceivedAt: Date?
    }

    /// Nil until the system issues one.
    public private(set) var startToken: String?
    /// The running activities, in the order the system lists them.
    public private(set) var activities: [Entry] = []
    /// When the app last became active (the last `start()`).
    public private(set) var activeSince: Date?

    @ObservationIgnored private let port: any LiveActivities
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var tokenTasks: [String: Task<Void, Never>] = [:]

    public init(port: any LiveActivities, now: @escaping @Sendable () -> Date) {
        self.port = port
        self.now = now
    }

    /// Follows the start token and lists the running activities. Again: refreshes.
    /// Called each time the app becomes active.
    public func start() {
        activeSince = now()
        if startTask == nil {
            let tokens = port.pushToStartTokens
            startTask = Task { [weak self] in
                for await token in tokens {
                    self?.startToken = Self.hex(token)
                }
            }
        }
        refresh()
    }

    /// Re-reads the running activities: one new since the last read (started
    /// by push while the app was away) is listed and its update token
    /// followed; one no longer running is dropped.
    public func refresh() {
        let running = port.running()
        let known = Dictionary(activities.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        activities = running.map { known[$0.id] ?? Entry(id: $0.id, cookID: $0.cookID, updateToken: nil) }
        let ids = Set(running.map(\.id))
        for (id, task) in tokenTasks where !ids.contains(id) {
            task.cancel()
            tokenTasks[id] = nil
        }
        for activity in running where tokenTasks[activity.id] == nil {
            let id = activity.id
            let tokens = port.pushTokens(id)
            tokenTasks[id] = Task { [weak self] in
                for await token in tokens {
                    self?.received(Self.hex(token), for: id)
                }
                // A stream that ends (the system did not list the activity
                // yet) is followed again on the next refresh. A cancelled
                // one was already removed, and may have been replaced.
                if !Task.isCancelled { self?.tokenTasks[id] = nil }
            }
        }
    }

    /// The activities whose update tokens are being followed (for tests).
    var followed: Set<String> { Set(tokenTasks.keys) }

    /// Stops following every token.
    public func stop() {
        startTask?.cancel()
        startTask = nil
        tokenTasks.values.forEach { $0.cancel() }
        tokenTasks = [:]
    }

    private func received(_ token: String, for id: String) {
        guard let index = activities.firstIndex(where: { $0.id == id }) else { return }
        activities[index].updateToken = token
        activities[index].updateTokenReceivedAt = now()
    }

    /// A token as APNs takes it: lower-case hex, two digits a byte.
    public nonisolated static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}
