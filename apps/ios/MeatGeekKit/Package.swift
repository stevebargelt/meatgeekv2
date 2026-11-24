// swift-tools-version: 6.0
// MeatGeekKit holds the app's logic: models, formatting and the API client.
// The MeatGeek app target is a thin SwiftUI shell over it.
// iOS only: `swift build` on macOS is not expected to work; build and test it
// through the MeatGeek scheme (see apps/ios/README.md).
import PackageDescription

let package = Package(
    name: "MeatGeekKit",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "MeatGeekKit", targets: ["MeatGeekKit"]),
    ],
    dependencies: [
        // Exact pins: the generated code is only as stable as the generator.
        // Bump deliberately, rebuild, and commit the updated Package.resolved.
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.14.4"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", exact: "1.13.4"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", exact: "1.4.0"),
        // HTTPRequest/HTTPResponse, used by the auth middleware; already a
        // dependency of swift-openapi-runtime, named here because it is imported.
        .package(url: "https://github.com/apple/swift-http-types", from: "1.8.0"),
    ],
    targets: [
        // The API client, generated on every build from Sources/MeatGeekAPI/openapi.yaml
        // (a bundle of libs/api-specs/spec, written by `npx nx run api-specs:bundle-ios`).
        // No hand-written code here: see openapi-generator-config.yaml.
        .target(
            name: "MeatGeekAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator"),
            ]
        ),
        .target(
            name: "MeatGeekKit",
            dependencies: [
                "MeatGeekAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ]
        ),
        .testTarget(
            name: "MeatGeekKitTests",
            dependencies: [
                "MeatGeekKit",
                "MeatGeekAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)
