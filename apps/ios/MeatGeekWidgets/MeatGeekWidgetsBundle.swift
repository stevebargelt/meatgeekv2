import MeatGeekActivity
import SwiftUI
import WidgetKit

/// The MeatGeekWidgets extension: the cook's lock-screen activity (#271).
/// Everything it draws is in MeatGeekKit's MeatGeekActivity target.
@main
struct MeatGeekWidgetsBundle: WidgetBundle {
    var body: some Widget {
        CookActivityWidget()
    }
}
