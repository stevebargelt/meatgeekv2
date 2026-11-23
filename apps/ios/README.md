# MeatGeek iOS app

The native iPhone client for MeatGeek: Swift 6, SwiftUI, iOS 18 and later,
iPhone only. For now it is a skeleton (HAR-158). It builds and tests in the
simulator and shows only a placeholder screen with the app name and version.
Goal HAR-157 adds the generated API client, sign-in, devices, cooks, the live
screen and the chart. The web app in [`apps/web`](../web) is the reference for
how those behave.

This is not an Nx project. `nx` does not build or test it; use Xcode or
`xcodebuild` as below.

## Layout

```
apps/ios/
├── MeatGeek.xcodeproj        # The app project (shared scheme: MeatGeek)
├── MeatGeek.xctestplan       # Test plan: MeatGeekKitTests + MeatGeekUITests
├── Config/                   # Build settings (xcconfig), see Signing below
│   ├── Base.xcconfig         # Shared by every target and configuration
│   ├── Debug.xcconfig
│   ├── Release.xcconfig
│   └── Signing.local.xcconfig.example
├── MeatGeek/                 # App target: a thin SwiftUI shell
├── MeatGeekUITests/          # UI tests (XCTest/XCUITest)
└── MeatGeekKit/              # Local Swift package: all the app's logic
    ├── Sources/MeatGeekKit/
    └── Tests/MeatGeekKitTests/   # Unit tests (Swift Testing)
```

- **All logic goes in MeatGeekKit.** Models, formatting and, later, the API
  client live in the package, where they are unit tested with Swift Testing
  (`import Testing`). The app target only holds views and the `@main` entry
  point. The root screen's state is `RootModel` (`@Observable`, `@MainActor`).
- **Adding a file needs no project edit.** `MeatGeek/` and `MeatGeekUITests/`
  are synchronized folders: drop a Swift file (or an asset) into the folder and
  it is part of the target. `project.pbxproj` only changes when you add a
  target, a package or a build setting.
- **Build settings live in `Config/`.** Platform and language settings
  (`IPHONEOS_DEPLOYMENT_TARGET = 18.0`, `SWIFT_VERSION = 6.0`,
  `SWIFT_STRICT_CONCURRENCY = complete`, `TARGETED_DEVICE_FAMILY = 1`, the
  version numbers) are in `Base.xcconfig`. Only per-target settings (bundle id,
  Info.plist keys, test host) are in the project file.
- **No third-party packages** yet.

| Target | Kind | Bundle id |
|---|---|---|
| `MeatGeek` | iOS app, display name "MeatGeek", portrait and landscape | `com.meatgeek.ios` |
| `MeatGeekUITests` | UI tests | `com.meatgeek.ios.uitests` |
| `MeatGeekKit` | Swift package library, `platforms: [.iOS(.v18)]`, Swift 6 mode | |
| `MeatGeekKitTests` | Swift package test target | |

## Prerequisites

- A Mac with **Xcode 26.x** (26.6 is what this was built and tested with),
  selected with `xcode-select` if you have more than one Xcode.
- An iOS **Simulator** runtime. The commands below use an **iPhone 17** on the
  latest installed runtime, which Xcode 26 installs by default. List what you
  have with `xcrun simctl list devices available`.

No Apple account is needed for the simulator.

## Open, build and run

```sh
open apps/ios/MeatGeek.xcodeproj
```

Pick the **MeatGeek** scheme and an iPhone simulator, then Run (⌘R). Xcode
resolves the local `MeatGeekKit` package on its own.

From the command line, from the repository root:

```sh
# Build for the simulator
xcodebuild build -project apps/ios/MeatGeek.xcodeproj -scheme MeatGeek \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest'

# Install and launch it in a booted simulator
xcrun simctl boot 'iPhone 17' || true
open -a Simulator
xcrun simctl install booted \
  ~/Library/Developer/Xcode/DerivedData/MeatGeek-*/Build/Products/Debug-iphonesimulator/MeatGeek.app
xcrun simctl launch booted com.meatgeek.ios
```

## Run the tests

From the repository root:

```sh
xcodebuild test -project apps/ios/MeatGeek.xcodeproj -scheme MeatGeek \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' \
  CODE_SIGNING_ALLOWED=NO
```

The `MeatGeek` scheme's test action runs the `MeatGeek` test plan, which runs
both test targets: `MeatGeekKitTests` (Swift Testing, reported as
`✔ Test run with N tests … passed`) and `MeatGeekUITests` (XCTest, reported as
`Executed N tests, with 0 failures`). The command exits 0 only if both pass.
`CODE_SIGNING_ALLOWED=NO` skips signing, which the simulator does not need.

To run one target or one test, add `-only-testing:MeatGeekKitTests` or
`-only-testing:MeatGeekUITests/MeatGeekUITests/testLaunchShowsTitleAndVersion`.

`swift build` / `swift test` in `MeatGeekKit/` are not supported: the package
is iOS only (`platforms: [.iOS(.v18)]`), so always test it through the scheme.

Tests follow the repository's
[deterministic test rule](../../docs/development/deterministic-tests.md): no
sleeps and no timeouts that decide a result. A UI test relies on
`XCUIApplication.launch()` returning once the app is idle and checks
elements straight away, rather than `waitForExistence(timeout:)`.

## Signing for a physical iPhone

Nothing that identifies an Apple account is committed: no team id,
certificate or provisioning profile. `Config/Base.xcconfig` ends with

```
#include? "Signing.local.xcconfig"
```

which includes `Config/Signing.local.xcconfig` if it exists. That file is
gitignored. To build for your own device:

```sh
cp apps/ios/Config/Signing.local.xcconfig.example apps/ios/Config/Signing.local.xcconfig
```

and set your team id in it:

```
DEVELOPMENT_TEAM = ABCDE12345
CODE_SIGN_STYLE = Automatic
```

Your team id is under Membership details at
<https://developer.apple.com/account>, or in Xcode → Settings → Accounts.
With automatic signing Xcode creates the provisioning profile for
`com.meatgeek.ios` the first time you run on a device.

Check that Xcode picked it up:

```sh
xcodebuild -showBuildSettings -project apps/ios/MeatGeek.xcodeproj -target MeatGeek \
  | grep -E 'DEVELOPMENT_TEAM|CODE_SIGN_STYLE'
```

Do not put signing settings in the project file: a team id set on a target
there overrides the local file and would be committed.
