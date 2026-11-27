import ActivityKit
import MeatGeekKit
public import SwiftUI
import WidgetKit

/// The lock-screen activity's widget, held by the MeatGeekWidgets extension.
/// Every view is drawn from `CookActivityPresenter.present(_:_:isStale:)`,
/// and a tap opens the cook's live screen (`CookLink`). The system says
/// when the stale date has passed (`context.isStale`); the presenter decides
/// what that shows.
public struct CookActivityWidget: Widget {
    public init() {}

    public var body: some WidgetConfiguration {
        ActivityConfiguration(for: CookActivityAttributes.self) { context in
            let presentation = CookActivityPresenter.present(context.attributes, context.state, isStale: context.isStale)
            CookActivityLockScreenView(presentation: presentation)
                .widgetURL(presentation.url)
        } dynamicIsland: { context in
            let presentation = CookActivityPresenter.present(context.attributes, context.state, isStale: context.isStale)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    CookActivityIslandExpandedView(presentation: presentation)
                }
            } compactLeading: {
                CookActivityIslandLeadingView(presentation: presentation)
            } compactTrailing: {
                CookActivityIslandTrailingView(presentation: presentation)
            } minimal: {
                CookActivityIslandMinimalView(presentation: presentation)
            }
            .widgetURL(presentation.url)
        }
    }
}
