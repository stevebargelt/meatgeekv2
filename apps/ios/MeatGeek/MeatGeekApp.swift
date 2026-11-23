import MeatGeekKit
import SwiftUI

@main
struct MeatGeekApp: App {
    @State private var model = RootModel(
        appVersion: AppVersion(infoDictionary: Bundle.main.infoDictionary)
    )

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
        }
    }
}
