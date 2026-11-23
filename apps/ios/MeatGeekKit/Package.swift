// swift-tools-version: 6.0
// MeatGeekKit holds the app's logic: models, formatting and (later) the API
// client. The MeatGeek app target is a thin SwiftUI shell over it.
// iOS only: `swift build` on macOS is not expected to work; build and test it
// through the MeatGeek scheme (see apps/ios/README.md).
import PackageDescription

let package = Package(
    name: "MeatGeekKit",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "MeatGeekKit", targets: ["MeatGeekKit"]),
    ],
    targets: [
        .target(name: "MeatGeekKit"),
        .testTarget(name: "MeatGeekKitTests", dependencies: ["MeatGeekKit"]),
    ],
    swiftLanguageModes: [.v6]
)
