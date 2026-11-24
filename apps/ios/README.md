# MeatGeek iOS app

The native iPhone client for MeatGeek: Swift 6, SwiftUI, iOS 18 and later,
iPhone only. It builds and tests in the simulator (HAR-158), calls the API
through a client generated from the OpenAPI contract (HAR-161, see
[API client](#api-client)), and signs users in with Entra in the system
browser (HAR-162, see [Sign-in](#sign-in)). Signed in, it shows a placeholder
home with the user's name from `GET /users/me`. Until the iOS client id is in
the config, it shows "Sign-in is not configured" instead. Goal HAR-157 adds
devices, cooks, the live screen and the chart. The web app in
[`apps/web`](../web) is the reference for how those behave.

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
│   ├── Dev.xcconfig          # Sign-in and API settings, see Sign-in below
│   ├── MeatGeek-Info.plist   # Info.plist keys build settings cannot generate
│   └── Signing.local.xcconfig.example
├── MeatGeek/                 # App target: a thin SwiftUI shell
├── MeatGeekUITests/          # UI tests (XCTest/XCUITest)
└── MeatGeekKit/              # Local Swift package: all the app's logic
    ├── Sources/MeatGeekAPI/      # Generated API client: openapi.yaml + generator config
    ├── Sources/MeatGeekKit/      # Config, session, token provider protocol, stub API
    ├── Sources/MeatGeekMSAL/     # MSALTokenProvider: the only code that links MSAL
    └── Tests/MeatGeekKitTests/   # Unit tests (Swift Testing)
```

- **All logic goes in MeatGeekKit.** Models, formatting, the API client and
  the sign-in session live in the package, where they are unit tested with
  Swift Testing (`import Testing`). The app target only holds views, the
  `@main` entry point and `AppComposition`, which picks the session's token
  provider and API. Screen state is `@Observable`, `@MainActor` models:
  `RootModel` (name and version), `SessionModel` (sign-in), `HomeModel`.
- **Adding a file needs no project edit.** `MeatGeek/` and `MeatGeekUITests/`
  are synchronized folders: drop a Swift file (or an asset) into the folder and
  it is part of the target. `project.pbxproj` only changes when you add a
  target, a package or a build setting.
- **Build settings live in `Config/`.** Platform and language settings
  (`IPHONEOS_DEPLOYMENT_TARGET = 18.0`, `SWIFT_VERSION = 6.0`,
  `SWIFT_STRICT_CONCURRENCY = complete`, `TARGETED_DEVICE_FAMILY = 1`, the
  version numbers) are in `Base.xcconfig`. Only per-target settings (bundle id,
  Info.plist keys, test host) are in the project file.
- **Packages**: Apple's `swift-openapi-generator` (build plugin),
  `swift-openapi-runtime`, `swift-openapi-urlsession` and `swift-http-types`,
  for the API client, and Microsoft's MSAL for iOS
  (`microsoft-authentication-library-for-objc`, a binary package) for
  sign-in. The generator, runtime and MSAL packages are pinned exactly in
  `MeatGeekKit/Package.swift`; every resolved version is in the committed
  `MeatGeek.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.

| Target | Kind | Bundle id |
|---|---|---|
| `MeatGeek` | iOS app, display name "MeatGeek", portrait and landscape | `com.meatgeek.ios` |
| `MeatGeekUITests` | UI tests | `com.meatgeek.ios.uitests` |
| `MeatGeekKit` | Swift package library, `platforms: [.iOS(.v18)]`, Swift 6 mode | |
| `MeatGeekAPI` | Swift package target in MeatGeekKit: the generated API client | |
| `MeatGeekMSAL` | Swift package library in MeatGeekKit: `MSALTokenProvider`; the app links it, the tests do not | |
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
resolves the packages on its own. The first build asks you to trust the
`OpenAPIGenerator` build plugin: choose **Trust & Enable**.

From the command line, from the repository root:

```sh
# Build for the simulator
xcodebuild build -project apps/ios/MeatGeek.xcodeproj -scheme MeatGeek \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' \
  -skipPackagePluginValidation

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
  -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO
```

The `MeatGeek` scheme's test action runs the `MeatGeek` test plan, which runs
both test targets: `MeatGeekKitTests` (Swift Testing, reported as
`✔ Test run with N tests … passed`) and `MeatGeekUITests` (XCTest, reported as
`Executed N tests, with 0 failures`). The command exits 0 only if both pass.
`CODE_SIGNING_ALLOWED=NO` skips signing, which the simulator does not need.
`-skipPackagePluginValidation` lets the `OpenAPIGenerator` build plugin run
without the trust prompt Xcode shows; without it `xcodebuild` stops at
"Validate plug-in “OpenAPIGenerator”" and exits 65.

To run one target or one test, add `-only-testing:MeatGeekKitTests` or
`-only-testing:MeatGeekUITests/MeatGeekUITests/testLaunchShowsTitleAndVersion`.

`swift build` / `swift test` in `MeatGeekKit/` are not supported: the package
is iOS only (`platforms: [.iOS(.v18)]`), so always test it through the scheme.

Tests follow the repository's
[deterministic test rule](../../docs/development/deterministic-tests.md): no
sleeps and no timeouts that decide a result. The unit tests await every step
(the fakes answer in process). A UI test waits for an element with
`waitUntilExists`, which has no deadline of its own: the hang guard is the
test plan's execution time allowance (`defaultTestExecutionTimeAllowance`,
300 s, in `MeatGeek.xctestplan`), as Jest's `testTimeout` is for the web.

The UI tests launch the app in [UI test mode](#ui-test-mode), so they never
touch MSAL or the network. One of them reads the built app's Info.plist, whose
path the test plan passes in as `MEATGEEK_APP_INFOPLIST`; run the UI tests
through the scheme (its test plan), not on their own.

## API client

The app calls the API only through a client generated from the OpenAPI
contract in [`libs/api-specs`](../../libs/api-specs). Nothing in the app
builds a URL or a request for an API route by hand.

**Where it comes from.**

1. `libs/api-specs/spec/**` is the contract, split across files.
2. `npx nx run api-specs:bundle-ios` (`libs/api-specs/scripts/bundle-for-ios.ts`)
   bundles it into one file, committed at
   `MeatGeekKit/Sources/MeatGeekAPI/openapi.yaml`. Do not edit that file.
   The bundle inlines the few `$ref`s that do not point at
   `#/components/<kind>/<name>` and drops `not: {enum: [0]}` (the spec's way
   of saying "greater than 0"); the generator supports neither.
3. On every build, the `OpenAPIGenerator` build plugin in the `MeatGeekAPI`
   target generates Swift from it (`openapi-generator-config.yaml`: `types`
   and `client`, `public`, idiomatic names). The generated code is not
   committed; it lives in DerivedData.

**Using it.** `APIClientFactory.makeClient(baseURL:tokenProvider:)` in
MeatGeekKit returns the generated `Client` (module `MeatGeekAPI`) with a
middleware that sets `Authorization: Bearer <token>` from the token provider's
`accessToken()`, called once per request (`makeClient(baseURL:accessToken:)`
takes a closure instead). Screens do not hold the client: they call it through
`SessionModel.perform`, which ends the session on a 401 (see
[Sign-in](#sign-in)). Each operation is a method named after its
`operationId`, returning an enum with one case per documented status:

```swift
let output = try await session.perform { api in try await api.getDevices() }
switch output {
case .ok(let ok): let devices = try ok.body.json.devices
case .unauthorized: session.endSession()   // the handler's 401
default: ...
}
```

Bodies are `Components.Schemas.*`, including the SignalR hub messages
(`TemperatureMessage`, `CookStartedMessage`, `CookStoppedMessage`) and the
negotiate response (`SignalRConnectionInfo`). Decode hub messages with
`APIClientFactory.makeJSONDecoder()`, which reads dates the way the client
does: the API writes `toISOString()` dates with milliseconds, which the
runtime's default date decoding rejects.

App Service Authentication answers a missing or invalid token with its own
401 and no body. The spec's 401 declares a JSON body, so the client cannot
build `.unauthorized` from it and throws a `ClientError` whose `response?.status`
is `.unauthorized`. `SessionModel.perform` handles that one; the caller handles
`.unauthorized`.

**After changing the spec**, run

```sh
npx nx run api-specs:bundle-ios
```

and commit the updated `openapi.yaml` with the spec change.

**What fails, and when.**

- `npx nx test api-specs` (CI's `lint-and-test`) fails while the committed
  `openapi.yaml` differs from a fresh bundle of the spec, and says to run the
  command above.
- Once re-bundled, the next build regenerates the Swift types, and app code
  that no longer matches them (a renamed field, a removed operation, a new
  required parameter) fails to compile, so CI's `ios` job fails.
- The generator prints a warning, not an error, for a schema it cannot
  represent and leaves that part out. Read the build log's
  `warning: ... is not supported` lines after a spec change.

## Sign-in

The app signs in with Entra ID through MSAL for iOS: the authorization-code
flow with PKCE, in the system browser (`ASWebAuthenticationSession`, MSAL's
`.authenticationSession` webview). It is a public client, so there is no
secret anywhere in the app. Tokens are in MSAL's keychain cache; the app keeps
no other copy.

### Config

`Config/Dev.xcconfig` (included by `Base.xcconfig`, so Debug and Release both
use it) holds four build settings. `Config/MeatGeek-Info.plist` copies each
into an Info.plist key, and `AppConfig.parse(infoDictionary:)` in MeatGeekKit
reads and checks them, listing every problem it finds (like the web app's
`apps/web/src/config/config.ts`). They are the same public values as
`apps/web/public/config.json`.

| Build setting | Info.plist key | Value |
|---|---|---|
| `MEATGEEK_API_BASE_URL` | `MeatGeekAPIBaseURL` | The API, with `/api`: the dev Function App |
| `MEATGEEK_TENANT_ID` | `MeatGeekTenantID` | The Entra tenant; the authority is `https://login.microsoftonline.com/<tenant id>` |
| `MEATGEEK_CLIENT_ID` | `MeatGeekClientID` | The iOS public-client registration. **Empty for now** |
| `MEATGEEK_API_SCOPE` | `MeatGeekAPIScope` | `api://348570b2-…/access_as_user`; MSAL adds `openid`, `profile` and `offline_access` |

An xcconfig reads `//` as the start of a comment, even inside a value, so the
URL and the scope are written `https:/$()/…` and `api:/$()/…` (`$()` expands
to nothing). A UI test checks the values in the built app's Info.plist.

**The client id.** `bootstrap.sh` (HAR-159) creates the iOS registration
(redirect URI `msauth.com.meatgeek.ios://auth`) and publishes its client id
as the `DEV_IOS_CLIENT_ID` variable on the repository's `development`
environment:

```sh
gh variable get DEV_IOS_CLIENT_ID --env development
```

That value goes in `MEATGEEK_CLIENT_ID`. Until it does, the app starts on
"Sign-in is not configured" and never creates MSAL. The API also has to accept
the app's tokens (Easy Auth's allowed client applications), which bootstrap
lists as a follow-up; a later issue does both.

### How it works

- `TokenProvider` (MeatGeekKit) is the seam: `signIn()`, `signOut()`,
  `accessToken()` and `currentAccount`. `MSALTokenProvider` (MeatGeekMSAL) is
  the real one; `FakeTokenProvider` is for tests and UI test mode.
- `accessToken()` is MSAL's `acquireTokenSilent`. When MSAL says the user must
  interact, or there is no account, it throws `TokenProviderError.signInRequired`.
- `SessionModel` is `notConfigured`, `signedOut(message:)`, `signingIn`,
  `signedIn(account)` or `failed(message)`. At launch, `restore()` picks up a
  cached account silently. A 401 from the API, or `signInRequired` from the
  provider, moves it to `signedOut` with "Your session ended. Sign in again."
  Sign-out removes the account from MSAL's cache.
- The URL scheme `msauth.com.meatgeek.ios` (`CFBundleURLTypes`) and the query
  schemes `msauthv2`/`msauthv3` (`LSApplicationQueriesSchemes`) are in
  `Config/MeatGeek-Info.plist`. `.onOpenURL` hands redirects to
  `MSALPublicClientApplication.handleMSALResponse`; with the system browser,
  that only happens when Microsoft Authenticator answers.

### Keychain

MSAL's default cache is in the keychain group `com.microsoft.adalcache`, which
needs a keychain-sharing entitlement. The app sets MSAL's
`keychainSharingGroup` to its own bundle id instead. Every app may use its own
application-identifier group (`<team id>.com.meatgeek.ios`) without any
entitlement, so **a device build needs no keychain entitlement and no
`.entitlements` file**: only signing with your team (below). Add the Keychain
Sharing capability only if another app should share the sign-in.

The simulator needs nothing either. CI builds and tests with
`CODE_SIGNING_ALLOWED=NO`, and neither the unit tests nor the UI tests touch
MSAL: the unit tests do not link `MeatGeekMSAL`, and the UI tests run in UI
test mode.

### UI test mode

Launched with the environment variable `MEATGEEK_UI_TEST=1`, the app uses
`FakeTokenProvider` and `StubAPI.uiTest()` (MeatGeekKit), an in-process
implementation of the generated `APIProtocol`, instead of MSAL and the real
client. Sign-in always succeeds, and `GET /users/me` returns "Pat Pitmaster".
`MEATGEEK_UI_TEST_NOT_CONFIGURED=1` starts on the not-configured screen.

`StubAPI` has one handler per operation, `<operationId>Handler`; an unset one
throws `StubAPI.NotStubbed`. To give a new screen data in UI test mode, set
its operations' handlers in `StubAPI.uiTest()`. When the spec gains an
operation, the compiler asks for its handler and method in `StubAPI`.

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
