import ActivityKit
import MeatGeekKit
public import SwiftUI
import WidgetKit

/// The lock-screen activity's widget, held by the MeatGeekWidgets extension.
/// Every view is drawn from `CookActivityPresenter.present(_:_:)`, and a tap
/// opens the cook's live screen (`CookLink`).
///
/// The Dynamic Island here is a placeholder (ActivityKit requires one): the
/// cook's name and the grill. Choosing which probe it shows is a later issue
/// (#272).
public struct CookActivityWidget: Widget {
    public init() {}

    public var body: some WidgetConfiguration {
        ActivityConfiguration(for: CookActivityAttributes.self) { context in
            let presentation = CookActivityPresenter.present(context.attributes, context.state)
            CookActivityLockScreenView(presentation: presentation)
                .widgetURL(presentation.url)
        } dynamicIsland: { context in
            let presentation = CookActivityPresenter.present(context.attributes, context.state)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    CookActivityLockScreenView(presentation: presentation)
                }
            } compactLeading: {
                Image(systemName: "flame.fill")
            } compactTrailing: {
                Text(presentation.grill).monospacedDigit()
            } minimal: {
                Image(systemName: "flame.fill")
            }
            .widgetURL(presentation.url)
        }
    }
}
