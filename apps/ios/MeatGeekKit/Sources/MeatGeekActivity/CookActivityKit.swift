public import ActivityKit
import Foundation
public import MeatGeekAPI
public import MeatGeekKit

/// The generated attributes are the activity's ActivityKit attributes, and
/// the generated content state its content state: the JSON a push would
/// carry is exactly the spec's (live-activity.yaml).
extension Components.Schemas.CookActivityAttributes: ActivityAttributes {
    public typealias ContentState = Components.Schemas.CookActivityContentState
}

/// The real `LiveActivities`: a thin adapter over ActivityKit. Nothing here
/// decides what an activity shows; `CookActivityTracker` and
/// `CookActivityPresenter` (MeatGeekKit) do.
///
/// Local activities only (`pushType: nil`): nothing here uses push, so the
/// token streams issue nothing until a later issue asks for push tokens.
@MainActor
public final class ActivityKitLiveActivities: LiveActivities {
    public init() {}

    public func running() -> [RunningCookActivity] {
        Activity<CookActivityAttributes>.activities
            .filter { $0.activityState == .active || $0.activityState == .stale }
            .map { RunningCookActivity(id: $0.id, cookID: $0.attributes.cookId) }
    }

    /// Throws when Live Activities are off (`ActivityAuthorizationError`) or
    /// the system refuses for any other reason.
    public func start(_ attributes: CookActivityAttributes, _ state: CookActivityContentState) throws -> String {
        let activity = try Activity.request(attributes: attributes, content: Self.content(state), pushType: nil)
        return activity.id
    }

    /// The last update or end handed to ActivityKit; the next waits for it.
    private var last: Task<Void, Never>?

    // Each update and end looks the activity up in its own task: an
    // `Activity` is not Sendable, so it is never handed across. The tasks run
    // one at a time in the order they were asked for, so an older reading
    // never lands after a newer one, nor an update after its end.
    public func update(_ id: String, _ state: CookActivityContentState) {
        enqueue { await Self.activity(id)?.update(Self.content(state)) }
    }

    /// What the system shows for the activity now (an update still queued
    /// is not in it yet).
    public func state(_ id: String) -> CookActivityContentState? {
        Self.activity(id)?.content.state
    }

    /// Shows "Cook ended" and leaves the lock screen 15 minutes later
    /// (`CookActivityPresenter.dismissalDate(for:)`).
    public func end(_ id: String, _ state: CookActivityContentState) {
        let policy: ActivityUIDismissalPolicy = CookActivityPresenter.dismissalDate(for: state).map { .after($0) } ?? .default
        enqueue { await Self.activity(id)?.end(Self.content(state), dismissalPolicy: policy) }
    }

    /// The state with its stale date: three minutes after it was sent
    /// (`CookActivityPresenter.staleDate(for:)`).
    private nonisolated static func content(_ state: CookActivityContentState) -> ActivityContent<CookActivityContentState> {
        ActivityContent(state: state, staleDate: CookActivityPresenter.staleDate(for: state))
    }

    private func enqueue(_ work: @escaping @Sendable () async -> Void) {
        let previous = last
        last = Task.detached {
            await previous?.value
            await work()
        }
    }

    public var pushToStartTokens: AsyncStream<Data> {
        AsyncStream { continuation in
            let task = Task.detached {
                for await token in Activity<CookActivityAttributes>.pushToStartTokenUpdates {
                    continuation.yield(token)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func pushTokens(_ id: String) -> AsyncStream<Data> {
        AsyncStream { continuation in
            let task = Task.detached {
                guard let activity = Self.activity(id) else {
                    continuation.finish()
                    return
                }
                for await token in activity.pushTokenUpdates {
                    continuation.yield(token)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private nonisolated static func activity(_ id: String) -> Activity<CookActivityAttributes>? {
        Activity<CookActivityAttributes>.activities.first { $0.id == id }
    }
}
