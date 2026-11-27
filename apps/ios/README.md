# MeatGeek iOS app

For the overview (what the app does, its architecture, CI and the live proof,
config and auth, and what TestFlight would need), see
[iOS app](../../docs/applications/ios-app.md). This README is the developer
guide.

The native iPhone client for MeatGeek: Swift 6, SwiftUI, iOS 18 and later,
iPhone only. It builds and tests in the simulator (HAR-158), calls the API
through a client generated from the OpenAPI contract (HAR-161, see
[API client](#api-client)), and signs users in with Entra in the system
browser (HAR-162, see [Sign-in](#sign-in)) with the dev iOS registration's
client id (HAR-164). Signed in, it shows two tabs, [Cooks](#cooks) (HAR-166:
the list with filters and paging, start, stop, a cook's detail) and
[Devices](#devices) (HAR-165: each device's connection, claim, rename and
release), with the user's name and Sign out in the account menu. An active
cook's screen shows its [live temperatures](#live-temperatures), pushed over
SignalR (HAR-167), and every cook's screen draws the whole cook as a
[chart](#cook-chart) (HAR-168). The web app in
[`apps/web`](../web) is the reference for how those behave.

This is not an Nx project. `nx` does not build or test it; use Xcode or
`xcodebuild` as below.

## Layout

```
apps/ios/
├── MeatGeek.xcodeproj        # The app project (shared scheme: MeatGeek)
├── MeatGeek.xctestplan       # Test plan: MeatGeekKitTests, MeatGeekLiveTests, MeatGeekActivityTests, MeatGeekMSALTests, MeatGeekUITests
├── Live.xctestplan           # Test plan: MeatGeekLiveUITests, the live proof against dev
├── Config/                   # Build settings (xcconfig), see Signing below
│   ├── Base.xcconfig         # Shared by every target and configuration
│   ├── Debug.xcconfig
│   ├── Release.xcconfig
│   ├── Dev.xcconfig          # Sign-in and API settings, see Sign-in below
│   ├── MeatGeek-Info.plist   # Info.plist keys build settings cannot generate
│   ├── MeatGeek.entitlements # Push Notifications and Time Sensitive Notifications, see Alerts
│   └── Signing.local.xcconfig.example
├── MeatGeek/                 # App target: a thin SwiftUI shell
├── MeatGeekWidgets/          # Widget extension: holds the lock-screen activity
├── MeatGeekUITests/          # UI tests (XCTest/XCUITest)
├── MeatGeekMSALTests/        # MSALTokenProvider against the real MSAL (XCTest, hosted in the app)
├── MeatGeekLiveUITests/      # The live iOS proof (XCUITest), see Run the tests
├── scripts/run-live-proof.sh # Runs the live proof (ios-live-proof.yml, daily)
└── MeatGeekKit/              # Local Swift package: all the app's logic
    ├── Sources/MeatGeekAPI/      # Generated API client: openapi.yaml + generator config
    ├── Sources/MeatGeekKit/      # Config, session, screen models, token provider protocol, stub API
    ├── Sources/MeatGeekMSAL/     # MSALTokenProvider: the only code that links MSAL
    ├── Sources/MeatGeekLive/     # SignalRLiveHub: the only code that links the SignalR client
    ├── Sources/MeatGeekActivity/ # The lock-screen activity: ActivityKit adapter, views, widget
    ├── Tests/MeatGeekKitTests/   # Unit tests (Swift Testing)
    ├── Tests/MeatGeekLiveTests/  # Hub message decoding through the SignalR client (Swift Testing)
    └── Tests/MeatGeekActivityTests/ # Renders the lock-screen view (Swift Testing)
```

- **All logic goes in MeatGeekKit.** Models, formatting, the API client and
  the sign-in session live in the package, where they are unit tested with
  Swift Testing (`import Testing`). The app target only holds views, the
  `@main` entry point and `AppComposition`, which picks the session's token
  provider and API. Screen state is `@Observable`, `@MainActor` models:
  `RootModel` (name and version), `SessionModel` (sign-in), `ProfileModel`
  (the account menu's name), the devices models (see [Devices](#devices)),
  the cooks models (see [Cooks](#cooks)), `LivePanelModel` (see
  [Live temperatures](#live-temperatures)), `CookChartModel` (see
  [Cook chart](#cook-chart)) and `NotificationsModel` (see [Alerts](#alerts)).
  `CookActivityTracker`, which the cooks model owns, keeps the lock-screen
  activities (see [Lock-screen activity](#lock-screen-activity)).
- **Adding a file needs no project edit.** `MeatGeek/`, `MeatGeekUITests/`,
  `MeatGeekMSALTests/` and `MeatGeekLiveUITests/` are synchronized folders:
  drop a Swift file (or an asset) into the folder and it is part of the target. `project.pbxproj` only changes when you add a
  target, a package or a build setting.
- **Build settings live in `Config/`.** Platform and language settings
  (`IPHONEOS_DEPLOYMENT_TARGET = 18.0`, `SWIFT_VERSION = 6.0`,
  `SWIFT_STRICT_CONCURRENCY = complete`, `TARGETED_DEVICE_FAMILY = 1`, the
  version numbers) are in `Base.xcconfig`. Only per-target settings (bundle id,
  Info.plist keys, test host) are in the project file.
- **Packages**: Apple's `swift-openapi-generator` (build plugin),
  `swift-openapi-runtime`, `swift-openapi-urlsession` and `swift-http-types`,
  for the API client, Microsoft's MSAL for iOS
  (`microsoft-authentication-library-for-objc`, a binary package) for
  sign-in, and `SignalR-Client-Swift` (MIT, pure Swift) for the live
  temperatures. The chart is Apple's Swift Charts (`import Charts`, in the
  app target only); there is no third-party chart package. The generator,
  runtime, MSAL and SignalR packages are pinned exactly in
  `MeatGeekKit/Package.swift`; every resolved version is in the committed
  `MeatGeek.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.

| Target | Kind | Bundle id |
|---|---|---|
| `MeatGeek` | iOS app, display name "MeatGeek", portrait and landscape | `com.meatgeek.ios` |
| `MeatGeekUITests` | UI tests | `com.meatgeek.ios.uitests` |
| `MeatGeekLiveUITests` | UI tests: the live iOS proof, in `Live.xctestplan` only | `com.meatgeek.ios.liveuitests` |
| `MeatGeekWidgets` | Widget extension, embedded in the app: the lock-screen activity | `com.meatgeek.ios.widgets` |
| `MeatGeekKit` | Swift package library, `platforms: [.iOS(.v18)]`, Swift 6 mode | |
| `MeatGeekAPI` | Swift package target in MeatGeekKit: the generated API client | |
| `MeatGeekMSAL` | Swift package library in MeatGeekKit: `MSALTokenProvider`; the app links it, the tests do not | |
| `MeatGeekLive` | Swift package library in MeatGeekKit: `SignalRLiveHub`; the app links it, `MeatGeekKitTests` does not | |
| `MeatGeekActivity` | Swift package library in MeatGeekKit: the lock-screen activity's ActivityKit adapter, views and widget; the app and `MeatGeekWidgets` link it | |
| `MeatGeekKitTests` | Swift package test target | |
| `MeatGeekLiveTests` | Swift package test target: `MeatGeekLive`'s decoding | |
| `MeatGeekActivityTests` | Swift package test target: renders the lock-screen view | |

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
  -skipPackagePluginValidation
```

The `MeatGeek` scheme's test action runs the `MeatGeek` test plan, which runs
the five test targets: `MeatGeekKitTests`, `MeatGeekLiveTests` and
`MeatGeekActivityTests` (Swift Testing, each reported as `✔ Test run with N tests … passed`),
`MeatGeekMSALTests` and `MeatGeekUITests` (XCTest, reported as
`Executed N tests, with 0 failures`). The command exits 0 only if all pass.
Do not add `CODE_SIGNING_ALLOWED=NO`: `MeatGeekMSALTests` runs inside the app
and creates MSAL, whose keychain cache needs the entitlements that simulator
signing ("Sign to Run Locally", no team or account) gives the build. Without
them MSAL fails with "Failed to retrieve teamId from keychain".
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
(the fakes answer in process); where they poll, they use MeatGeekKit's
`until`, whose one fixed 30 s hang guard names the wait that stuck (the rule's
one exception; see [Swift (iOS)](../../docs/development/deterministic-tests.md#swift-ios)).
A UI test waits for an element with
`waitUntilExists`, which has no deadline of its own: the hang guard is the
test plan's execution time allowance (`defaultTestExecutionTimeAllowance`,
300 s, in `MeatGeek.xctestplan`), as Jest's `testTimeout` is for the web.

The UI tests launch the app in [UI test mode](#ui-test-mode), so they never
touch MSAL or the network. One of them reads the built app's Info.plist, whose
path the test plan passes in as `MEATGEEK_APP_INFOPLIST`; run the UI tests
through the scheme (its test plan), not on their own.

The live iOS proof, `MeatGeekLiveUITests`, is not in the `MeatGeek` test plan:
it runs the real app against dev, signed in as the acceptance user, from its
own plan `Live.xctestplan`, through `scripts/run-live-proof.sh` (HAR-169).
CI's `ios` job only compiles it; the `iOS Live Proof` workflow
(`.github/workflows/ios-live-proof.yml`) runs it once a day and on demand,
against dev, and its result does not block a deploy. To run it by hand, see
[Live iOS proof](../../docs/development/live-acceptance.md#live-ios-proof).

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
| `MEATGEEK_CLIENT_ID` | `MeatGeekClientID` | The iOS public-client registration `meatgeek-v2-dev-ios`: `b422c945-cb04-4d97-a816-3f20eb54176b` |
| `MEATGEEK_API_SCOPE` | `MeatGeekAPIScope` | `api://348570b2-…/access_as_user`; MSAL adds `openid`, `profile` and `offline_access` |

An xcconfig reads `//` as the start of a comment, even inside a value, so the
URL and the scope are written `https:/$()/…` and `api:/$()/…` (`$()` expands
to nothing). The unit test `BuiltAppConfigTests` (MeatGeekKitTests) reads the
built app's Info.plist and checks that `AppConfig.parse` returns `ready` with
these values; a UI test checks the URL schemes. Both find the Info.plist
through `MEATGEEK_APP_INFOPLIST`, which the test plan sets, so run them
through the scheme.

**The client id.** `bootstrap.sh` (HAR-159) creates the iOS registration
`meatgeek-v2-dev-ios` (redirect URI `msauth.com.meatgeek.ios://auth`) and
publishes its client id as the `DEV_IOS_CLIENT_ID` variable on the
repository's `development` environment:

```sh
gh variable get DEV_IOS_CLIENT_ID --env development
```

`MEATGEEK_CLIENT_ID` in `Config/Dev.xcconfig` is that value (HAR-164). It is a
public client id, not a secret, like `clientId` in `apps/web/public/config.json`.
**If the registration is recreated or replaced, its client id changes: update
`MEATGEEK_CLIENT_ID` and the expected value in `BuiltAppConfigTests`.** The dev
API accepts the app's tokens because the same id is in Easy Auth's allowed
client applications (HAR-163). With an empty client id the app starts on
"Sign-in is not configured" and never creates MSAL.

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
- Sign-in never opens Microsoft Authenticator, even when it is installed:
  `MSALTokenProvider` sets `MSALGlobalConfig.brokerAvailability = .none`
  before it creates MSAL (HAR-171), so MSAL never hands sign-in to the
  Authenticator broker. Brokered auth is a separate decision.
- The URL scheme `msauth.com.meatgeek.ios` (`CFBundleURLTypes`, in
  `Config/MeatGeek-Info.plist`) is the redirect URI's. There are no query
  schemes (`LSApplicationQueriesSchemes`): MSAL 2.18.1 needs `msauthv2` and
  `msauthv3` only to look for the broker, and with the broker on its init
  fails without them; with it off it never checks. `.onOpenURL` still hands
  any URL to `MSALPublicClientApplication.handleMSALResponse`; with the system
  browser MSAL gets its redirect itself, so it is not expected to be called.
- `MeatGeekMSALTests` (an XCTest target hosted in the app, because MSAL's init
  checks the app's Info.plist for the redirect scheme) creates an
  `MSALTokenProvider` against the real MSAL and checks the broker is off. The
  UI test `testBuiltInfoPlistHasSchemesAndConfig` checks the built Info.plist
  has the redirect scheme and no query schemes.

### Keychain

MSAL's default cache is in the keychain group `com.microsoft.adalcache`, which
needs a keychain-sharing entitlement. The app sets MSAL's
`keychainSharingGroup` to its own bundle id instead. Every app may use its own
application-identifier group (`<team id>.com.meatgeek.ios`) without any
entitlement, so **a device build needs no keychain entitlement**: only signing
with your team (below). Its only entitlements are the two push capabilities
(see [Alerts](#alerts)). Add the Keychain Sharing capability only if another
app should share the sign-in.

The simulator needs no team either: Xcode signs every simulator build "to
run locally", which gives the app its keychain group. CI builds and tests that
way. `MeatGeekMSALTests` is the only test that touches MSAL: the package's
unit tests do not link `MeatGeekMSAL`, and the UI tests run in UI test mode.

### UI test mode

Launched with the environment variable `MEATGEEK_UI_TEST=1`, the app uses
`FakeTokenProvider` and `StubAPI.uiTest()` (MeatGeekKit), an in-process
implementation of the generated `APIProtocol`, instead of MSAL and the real
client, whatever the client id in the config (`AppComposition` checks UI test
mode before it reads the config). Sign-in always succeeds, and
`GET /users/me` returns "Pat Pitmaster".
`MEATGEEK_UI_TEST_NOT_CONFIGURED=1` starts on the not-configured screen.

The device routes are served by `StubDevices`, an actor holding one launch's
devices in memory:

| Device | State |
|---|---|
| `sim-device-1` "Backyard Smoker" | connected, last heard 12 s before the clock |
| `sim-device-2` "Garage Kettle" | offline, never heard from |

Claiming `sim-device-3` with code `ABCD-EFGH-JKLM` (any case, spaces or
hyphens) adds it, connected and last heard 3 s before the clock; any other
device or code is 403. Rename and release change the list. The clock is
injected: in UI test mode both the stubs and the screens read
`UITestMode.fixedNow` (2026-11-22T18:00:00Z), so "last heard" and elapsed
text are the same on every run.

The cook routes are served by `StubCooks`, an actor over the same devices:

- 24 seeded completed cooks, "Seeded cook 1" (`seeded-cook-1`, a day before
  the clock) to "Seeded cook 24", alternating `sim-device-1` and
  `sim-device-2`, so the list has two pages of 20.
- `GET /cooks`: newest first, `limit` (default 20, at most 100), `deviceId`
  and `status` filters, and a `continuationToken` for the next page.
- `POST /cooks` on a device the user has makes an active cook started at the
  clock, which the devices' active-cook lookup then returns. A second start on
  that device is 409 `COOK_ALREADY_ACTIVE` with its id; the same id and body
  again is a 200 replay; another user's device is 403.
- `POST /cooks/{id}/stop` completes it, ended at the clock.
  `GET /cooks/{id}` (and stop) for an unknown id is 404.
- `GET /cooks/{id}/chart`: a seeded cook's 6 h as 360 one-minute buckets of
  grill, probe 1 and probe 2, with probe 2 missing from the first 10 minutes
  and from 2:00 to 2:45 (a gap in its line). `seeded-cook-2`
  (`StubCooks.noChartCookID`) is 404; `seeded-cook-3`
  (`StubCooks.failsOnceCookID`) answers 500 the first time and 200 after, so
  Retry can be seen. A started cook's chart has no points while it is active
  (the pushed readings append on screen); once stopped, it is the readings
  `StubLive` pushed for its device, in one-minute buckets up to the end of
  the minute it ended in (the stub's clock stands still, so a cook can end in
  the instant of its last reading).

The push-token routes are served by `StubPushTokens`, one launch's phones in
memory. Notifications run on `StubNotifications` (see [Alerts](#alerts)):
`MEATGEEK_UI_TEST_NOTIFICATIONS=granted` or `denied` sets the permission
(otherwise it is not asked yet, and the prompt is answered Allow), and
`MEATGEEK_UI_TEST_TAPPED_ALERT=<cook id>` launches as if from a tap on that
cook's alert.

`StubAPI` has one handler per operation, `<operationId>Handler`; an unset one
throws `StubAPI.NotStubbed`. To give a new screen data in UI test mode, set
its operations' handlers in `StubAPI.uiTest()`. When the spec gains an
operation, the compiler asks for its handler and method in `StubAPI`.

## Devices

The Devices tab (HAR-165) ports the web app's devices page
(`apps/web/src/devices`): its behaviour and copy, not its layout.

- **List**: one row per device with name, model, location, connection and
  "Cooking: <cook name>" when the device has an active cook. Pull to refresh
  re-reads it. The connection text is the web's `connectionText`
  (`ConnectionText` in MeatGeekKit): "Connected", "Connected · last heard
  <age> ago", "Offline · last heard <age> ago", "Offline · never heard from"
  or "Status unknown", aged against the moment the list was read, not a
  ticking clock. Active cooks come from one `GET /cooks?status=active&limit=100`;
  if that fails the list still shows, under "Could not check which devices
  are cooking: …".
- **Claim** (the + button): device ID, claim code (`XXXX-XXXX-XXXX`, formatted
  as typed by a `UITextField` wrapper so the caret stays put), name and
  location, checked as the web checks them (`DeviceValidation`). A 403, 409 or
  503 gets the web's message; a 400 keeps the API's. The code is cleared once
  the API has answered, accepted or refused. A claim re-reads the list.
- **Rename and release**: swipe a row, long-press it, or open its detail
  screen. Rename checks 1–100 characters after trimming, then re-reads the
  list. Release asks first; a 204 takes the row off without a re-read. A 404
  on either says "Device <id> was not found. The list has been refreshed." and
  re-reads the list.
- **Errors**: `APIProblem` maps an error body to the message and request id a
  screen shows (`apps/web/src/api/problem.ts`). A 401 from any call goes
  through `SessionModel.endSession()` and the signed-out screen.

The logic is in `DevicesModel`, `ClaimDeviceModel` and `RenameDeviceModel`
(MeatGeekKit), unit tested in `DevicesTests.swift`; the views
(`MeatGeek/DevicesView.swift`, `DeviceFormViews.swift`) only bind to them.
`MeatGeekUITests.testDevicesClaimRenameRelease` drives the whole path on the
stub.

## Cooks

The Cooks tab, the first tab (HAR-166), ports the web app's cooks pages
(`apps/web/src/cooks`): their behaviour and copy, not their layout.

- **List** (`CooksModel`): name, device name, status and start time, newest
  first, 20 at a time (`GET /cooks?limit=20`). "Load more" sends the last
  page's `continuationToken` and appends; if it fails the list stays and the
  problem shows under it. The toolbar's filter menu sets the device and the
  status (Active, Completed), which go to the API as `deviceId` and `status`
  and restart at page one; a page that arrives for an old filter is dropped.
  Pull to refresh restarts at page one. Empty: "You have no cooks yet. Start
  one from a device on the Devices tab." or, filtered, "No cooks match these
  filters."
- **Start** (`StartCookModel`): from a device's detail screen ("Start cook"),
  its row's leading swipe or its context menu, hidden while the device has an
  active cook. A sheet with name, meat type, weight and the five targets,
  checked as the web checks them (`CookValidation`: `validateStartCook` and
  `toStartCookRequest`, blank fields left out). The cook id is made once per
  form and sent on every submit and retry: the API's idempotency key. On 201
  or 200 the sheet closes and the cook's detail opens. A 409
  `COOK_ALREADY_ACTIVE` says "This device already has an active cook." with a
  button that opens it; a 503 `DEVICE_TWIN_UPDATE_FAILED` says the cook was
  saved but the device was not told, with Retry (same id and body) and Open
  the cook. Other refusals keep the API's message.
- **Detail** (`CookDetailModel`): status, meat type, device, start, end (or the
  elapsed time while active, `H:MM:SS` on the injected clock), weight, the
  targets the cook has, notes; "This cook was not found" on a 404. **Stop
  cook** asks first (`confirmationDialog`, "Yes, stop cook"), then
  `POST /cooks/{id}/stop`; the stopped cook replaces the shown one. A 503
  says the device was not told and offers Retry. An active cook shows its
  [live temperatures](#live-temperatures) on top, then its
  [chart](#cook-chart); an ended cook starts with the chart.
- **One source of truth**: a started or stopped cook goes through
  `CooksModel.apply(_:)`, which updates the list (on top, in place, or out
  when it no longer matches the filters) and the devices' active cooks, so the
  device row's "Cooking: <name>" (a link to the cook) and Start cook follow
  without a re-read.

A 401 from any cook call signs the session out, as for devices. The logic is
unit tested in `CooksTests.swift`; the views are `MeatGeek/CooksView.swift`.
`MeatGeekUITests.testStartCookListOpenStop` drives the main path on the stub:
start a cook from a device, see it active, open it from the device row and
from the Cooks tab, stop it, with the live panel's path and the chart's in
between (see [Live temperatures](#live-temperatures) and
[Cook chart](#cook-chart)). It keeps screenshots (cooks list, start form,
active cook, the live panel live, reconnecting and stale, and the charts) in
the result bundle; `xcrun xcresulttool export attachments --path <bundle>
--output-path <dir>` writes them out.

## Live temperatures

An active cook's screen shows the live readings of its device, pushed over
SignalR (HAR-167). It ports the web app's `apps/web/src/live`: `hub.ts`,
`live-connection.ts`, `live-panel.tsx` and `format.ts`, behaviour and copy.

- **Hub** (`LiveHub`, MeatGeekKit): `onTemperature`, `onCookStopped`,
  `onReconnecting`, `onReconnected`, `onClose`, `start()`, `stop()`, all on the
  main actor. The app's is `SignalRLiveHub` (MeatGeekLive): `SignalR-Client-Swift`
  to the URL `POST /negotiate` returns, its access token from the hub's
  access-token provider, the JSON hub protocol with the API's date decoding
  (`LiveHubProtocol.make()`), automatic reconnect, and the messages decoded
  into the generated `TemperatureMessage` and `CookStoppedMessage`.
- **Connection** (`LiveConnection`): automatic reconnect handles short drops.
  When it gives up and the connection closes, or negotiate or start fails (a
  429, a 503, a network error), it negotiates again for a fresh token after 2,
  5, 10, then every 30 s, and starts over after a successful start. A 401 from
  negotiate stops it ("Sign in again") and, as for any API call, ends the
  session. Callbacks from a replaced or stopped connection are ignored. Each
  retry wait is a `Task` on an injected sleeper (`LiveSleep`); stopping
  cancels it.
- **Panel** (`LivePanelModel`, view `MeatGeek/LivePanelView.swift`): Grill and
  Probes 1–4 in the device's unit, "—" for a channel the device did not send.
  Only the cook's device's messages count. After every start and reconnect it
  backfills with `GET /temperatures/current/{deviceId}`, keeping the newer
  reading. The badge: "Connecting…", "Waiting", "Live", "Reconnecting…",
  "Sign in again", or "No reading for <duration>" once the reading is older
  than 3 × the device's `pollingInterval` (30 s when unset). The view re-reads
  the panel every second (`TimelineView`), so the age advances without a new
  message. `cook_stopped` for this cook stops the connection and shows the cook
  as ended, here and in the lists.
- **Targets and reached marks** (#239): a channel with a target and a reading
  shows "Target 203 °F" under its reading, in the device's unit, converted
  and rounded as readings are. A probe the server reports in the cook's
  `targetsReached` shows "✓ Reached 3:42 PM", the local time it was reached;
  the grill never shows a mark. A channel with no target or no reading shows
  only its reading. The app runs no target rule: after each pushed reading
  `CookDetailModel` reads `GET /cooks/{cookId}` again and hands the cook to
  the panel (`cookChanged(_:)`), so a mark appears and clears with no
  refresh. The server records the rule from the same readings on its own
  consumer, so a mark can show one reading late. One re-read is in flight at a
  time; readings during it cost one more. A failed re-read changes nothing,
  and one answered after the cook was shown again (stopped, reloaded) is
  dropped.
- **Changing targets** (#240): a running cook's screen has "Edit targets",
  a sheet with the grill and the four probes filled from the cook, checked
  with the start form's messages (`EditTargetsModel`,
  `CookValidation.validateTargets`). Save sends the whole set to
  `PUT /cooks/{cookId}/targets`; a blank field clears its target. The saved
  cook replaces the shown one at once, live panel included. A second phone
  with the cook open sees the change on its next re-read, which the next
  pushed reading starts. 409 `COOK_NOT_ACTIVE` says the cook has ended and
  reads it again. An ended cook offers no editing.
- **Foreground and background**: the panel is connected only while the cook
  screen shows and the scene is active. Leaving `.active` stops the
  connection; coming back negotiates again, starts a new one and backfills.

The logic is unit tested in `LiveTests.swift` (MeatGeekKitTests) with a fake
hub, a fake negotiate and a virtual clock, so no test waits for the retry
delays; `LiveHubProtocolTests.swift` (MeatGeekLiveTests) decodes a real
`temperature` frame through the SignalR client's JSON hub protocol.

**UI test mode.** `UITestMode.makeApp` runs the panel on `StubLive`, over the
same `StubCooks`: negotiate answers a stub URL and a numbered token; once a hub
starts, it is pushed a reading for every device with an active cook (grill
225 °F and probe 1 150 °F, one degree more each push, probes 2–4 absent);
`GET /temperatures/current` answers the last one pushed. The clock is
`StubClock`, `UITestMode.fixedNow` until moved. The cook screen's navigation
bar has a "UI test" menu, in UI test mode only, with the hooks the UI tests
use: Drop connection (every hub closes; the retry wait then lasts until)
Reconnect now, Advance clock 3 min (the reading goes stale), and Send
cook_stopped (stops the cook as another client would).
`testStartCookListOpenStop` drives push → drop → "Reconnecting…" → reconnect →
a new reading → stale, and sees the probe 1 target set on the start form
beside its reading, then changes it to 165 °F with Edit targets and sees the
new target on the live panel; `testCookStoppedEndsTheLiveCook` drives
`cook_stopped`. `StubCooks` serves `PUT /cooks/{cookId}/targets` as the API
does (409 on an ended cook, a changed target loses its reached mark).
The stub runs no target rule, so no reached mark shows in UI test mode; the
marks are unit tested.

## Lock-screen activity

A cook started in the app shows on the lock screen as a Live Activity, kept
current while the app runs, and ends when the cook stops (#271), with reached
marks, the Dynamic Island and the stale and ended states (#272). Nothing here
uses push, so it works in the simulator; starting and updating by push are
later issues of #237.

- **Data.** The activity's attributes (`cookId`, `cookName`, `startTime`) and
  content state (the latest reading's grill and probes in °F, the cook's
  targets, the device's unit, the reading's time, the probes' reached times
  (`targetsReached`), the update's send time (`updatedAt`), `ended` and the
  cook's end (`endedAt`)) are the spec's
  `CookActivityAttributes` and `CookActivityContentState`
  (`libs/api-specs/spec/components/schemas/live-activity.yaml`), generated
  into `MeatGeekAPI` like every other type. `MeatGeekActivity` makes the
  generated attributes ActivityKit's `ActivityAttributes`, so a push and the
  app carry the same JSON. Dates in them are ISO strings, not `date-time`:
  ActivityKit decodes a push with a default `JSONDecoder`.
- **What it shows** (`CookActivityPresenter`, MeatGeekKit): the cook's name;
  the elapsed time, ticking from the cook's start; the grill as reading
  against target (`224° / 225°`, `224°` with no target, `—` with no reading);
  and each probe that has a reading next to its target (`187° → 203°`). A
  probe with no reading is left out. A reached probe shows the mark and the
  local time it was reached (`204° · 203° ✓ 3:42 PM`) until it re-arms; the
  grill never shows a mark. Whole degrees in the device's unit, converted
  from °F as the live panel converts.
  - The **Dynamic Island** shows the probe closest to a target it has not
    reached (a tie goes to the lower probe); when every shown probe with a
    target has reached it, the most recently reached one with the mark and
    no time (`204° ✓`); with no probe target, the grill.
  - **Stale**: each update's stale date is three minutes after its
    `updatedAt` (`CookActivityPresenter.staleDate`). When the system says it
    has passed (`context.isStale`), the activity shows `as of 3:42 PM`, the
    last update's time, in place of the elapsed time. It does not say why.
  - **Ended**: a stopped (or missing) cook's activity ends showing `Cook
    ended` with the last temperatures (the ones it shows, when the app
    followed no reading for it: `CookActivityPresenter.ending`), stops
    ticking, and leaves the lock screen 15 minutes after the cook's
    `endTime`, or after it ended without one
    (`CookActivityPresenter.dismissalDate`).
  - The compact island's trailing side and the minimal island have their
    own text (`islandTrailing`, `islandMinimal`): `as of 3:42 PM` when
    stale, `Ended` once ended.

  The views (`CookActivityLockScreenView` and the `CookActivityIsland*Views`,
  MeatGeekActivity) take only the resulting `CookActivityPresentation`.
- **When** (`CookActivityTracker`, MeatGeekKit, owned by `CooksModel`): every
  cook `CooksModel.apply(_:)` sees, which is every cook started, stopped or
  changed in the app. A running cook gets an activity (one the system already
  shows for it, from an earlier launch, is taken over); a changed target
  updates it; a stopped cook ends it, at once. The cook screen's re-read of a
  running cook after each reading goes to `cookRead(_:)`, so the activity
  takes the cook's reached probes as the server records them; with the cook
  screen closed nothing re-reads the cook, so a mark waits for the cook screen
  to open again or for the server's updates by push (a later issue of #237).
  While it tracks an activity and the app is active, the tracker holds its
  own `LiveConnection`, separate from
  the cook screen's, and each `temperature` message from a tracked cook's
  device updates that activity; `cook_stopped` ends it. Each time the app
  becomes active (launch included), the tracker reads the cook of every
  activity the system shows: a running cook's activity is taken over and
  followed, and a stopped or missing cook's is ended, so an activity from an
  earlier launch keeps up and one for a cook stopped elsewhere while the app
  was in the background goes. It never starts one there (#251 does). A
  stopped cook also ends an activity the tracker had not taken over yet (an
  earlier launch's whose read failed). Signing out stops the tracker for
  good: a read still out is dropped, and it starts, takes over and follows
  nothing after that; the activities themselves stay.
- **The port** (`LiveActivities`, MeatGeekKit): `running`, `start`, `update`,
  `end`, and the token streams (`pushToStartTokens`, `pushTokens`). The app's
  is `ActivityKitLiveActivities` (MeatGeekActivity), local activities with no
  push type; UI test mode's is `StubLiveActivities`, in memory, with no
  connection of its own (a second stub connection would change the readings
  the live panel's UI tests expect); unit tests use `FakeLiveActivities`.
- **Live Activities off in Settings**: `start` throws, the tracker drops it,
  and the app says nothing.
- **A tap** opens `meatgeek://cook/<id>` (`CookLink`; the `meatgeek` URL
  scheme is in `Config/MeatGeek-Info.plist`). `MeatGeekApp` holds the id until
  the signed-in screens show it, then the Cooks tab opens that cook's screen.
- **The extension**: `MeatGeekWidgets` (`com.meatgeek.ios.widgets`) holds only
  `@main` `MeatGeekWidgetsBundle` over `CookActivityWidget`. Its Info.plist
  keys are in `Config/MeatGeekWidgets-Info.plist`. The app's Info.plist sets
  `NSSupportsLiveActivities` and `NSSupportsLiveActivitiesFrequentUpdates`.

`CookActivityTests.swift` (MeatGeekKitTests) tests the text, the unit, the
reached marks, the Dynamic Island's choice, the stale and ended states, the
link and the tracker over the fake port, fake hubs and a virtual clock.
`CookActivityViewTests.swift` (MeatGeekActivityTests) renders the lock-screen
and every Dynamic Island view, current, stale and ended, from presentation
values with `ImageRenderer`, on CI's unsigned simulator build.

## Alerts

When a channel of a running cook reaches its target, the API sends a Time
Sensitive alert to every phone the cook's owner has registered (#244, see
[the path to Apple](../../docs/infrastructure/apns-key-vault.md#the-path-to-apple)).
The app asks for permission, registers the phone and presents the alerts
(#245).

- **Capabilities**: `Config/MeatGeek.entitlements` (the `MeatGeek` target's
  `CODE_SIGN_ENTITLEMENTS`) has `aps-environment` = `development` (Push
  Notifications, the APNs sandbox the dev API sends to) and
  `com.apple.developer.usernotifications.time-sensitive` (Time Sensitive
  Notifications, so an alert breaks through Focus). A simulator build is
  signed to run locally with these, with no team, as before. A device build
  needs a team in the paid Apple Developer Program; automatic signing adds
  both capabilities to the `com.meatgeek.ios` App ID.
- **Port** (`NotificationsPort`, MeatGeekKit): the permission as it is, the
  permission request, asking APNs for the device token and the tokens iOS
  hands back, and the cook id of a tapped alert. The app's is
  `SystemNotifications` (`MeatGeek/SystemNotifications.swift`), a thin
  adapter over `UNUserNotificationCenter` and `UIApplication`, with the
  `AppDelegate` that receives the token. UI test mode's is
  `StubNotifications`; unit tests use `FakeNotifications`. As with
  `LiveHub`, nothing decides anything in the adapters.
- **When it asks** (`NotificationsModel`): the first time a running cook's
  screen shows: opening a running cook, or starting one, which opens its
  screen. Never at launch. iOS shows its prompt once per install; after that
  the model only reads the answer.
- **Registering**: once permission is granted, the app asks APNs for the
  token and sends it to `POST /users/me/push-tokens` as lowercase hex. It
  reads the permission again at sign-in and every time the app comes to the
  foreground (it can change in Settings), and asks APNs for the token then.
  It POSTs once per sign-in (also after a 401 ended the last one) and again
  whenever the token changes. The last token it registered is kept in
  `UserDefaults`, so the token it replaces is removed with
  `DELETE /users/me/push-tokens/{tokenId}` even when it changed between
  launches. A failed registration is
  tried again on the next foreground or cook screen. The app knows a phone at
  the API by its id, the SHA-256 of the token's hex
  (`NotificationsModel.tokenID`), as the API does. No token is logged.
- **Declined**: a running cook's screen says "Alerts are off. Turn on
  notifications for MeatGeek in Settings to be alerted when a target is
  reached." with **Open Settings**, which opens the app's page in Settings.
  The live panel works as before.
- **Sign-out**: `SessionModel.signOut()` first runs `beforeSignOut`, where the
  model deletes this phone's tokens (the current one and the last one it
  registered, so a sign-out before iOS hands over the token still removes
  it) while the session can still call the API, then signs out. The deletes
  run after any step already queued, and nothing registers again until the
  next sign-in. A failed delete does not stop the sign-out, and is not tried
  again: the signed-out phone can no longer call the API as that user.
- **Presenting**: `SystemNotifications` is the notification center's
  delegate from launch, so an alert that arrives while the app is open shows
  its banner and plays its sound on any screen, the cook's own included
  (`[.banner, .list, .sound]`).
- **Tapping**: the payload's top-level `cookId` (`AlertPayload`) opens that
  cook's screen on the Cooks tab, live panel and all, from the background or
  from a closed app (the launching tap is held until the screens are ready,
  and until sign-in when the session is restoring).
- **Device screen**: it no longer shows the device's "Push notifications"
  setting, which nothing acts on.

**Tests.** `NotificationsTests.swift` (MeatGeekKitTests) drives the model on
`FakeNotifications` and `StubAPI`: not asking at sign-in, asking once on a
running cook's screen and not on an ended one, declined and the alerts-off
state, permission turned on in Settings, registering, the same token not
registered twice, a changed token, a failed registration retried, a 401,
a token from before sign-in, the token id, sign-out (with and without a
failed delete), a tap, the payload, and UI test mode's stub.
`testDeclinedAlertsSayOffOnTheCookScreen` and `testTappedAlertOpensItsCook`
(MeatGeekUITests) drive the screens on `StubNotifications`. No automated test
shows delivery or the real adapter: the simulator on a GitHub-hosted runner
never gets a device token. That is checked on a real iPhone, below.

### Checking alerts on a real iPhone

Needs: an iPhone on iOS 18 or later with a cable or on the same network as
the Mac; the Mac with Xcode 26; the Apple Developer Program team; the owner's
steps in [the APNs key page](../../docs/infrastructure/apns-key-vault.md#the-owners-steps)
done, so `GET /health/apns` on dev answers 200; a claimed device that is
sending readings (a Raspberry Pi, or `simdevice`, see the
[devices runbook](../../docs/devices/runbook.md)).

1. **Build.** Set your team in `Config/Signing.local.xcconfig` (see
   [Signing for a physical iPhone](#signing-for-a-physical-iphone)). Open
   `apps/ios/MeatGeek.xcodeproj`, pick the **MeatGeek** scheme and your
   iPhone, and Run (⌘R). On the first run, trust the developer on the phone
   (Settings → General → VPN & Device Management) and run again. Check
   Xcode's Signing & Capabilities tab lists Push Notifications and Time
   Sensitive Notifications. A build from Xcode uses the APNs sandbox, which
   is what dev sends to.
2. **Sign in** with your Microsoft account. The app does not ask for
   notifications yet.
3. **Grant permission.** Open a running cook, or start one from the Devices
   tab. Choose **Allow** at the prompt. Settings → MeatGeek → Notifications
   now shows **Time Sensitive Notifications**; leave it on.
4. **Close the app**: swipe it away in the app switcher, and lock the phone.
5. **Start a cook on the web** (<https://meatgeekv2-web.vercel.app>) on the
   same device, with a probe target (or the grill's) at or below that
   channel's current reading. Within about 30 seconds (two readings, 5 s
   apart, then Apple) the lock screen shows "Probe 1 reached 203 °F" (or
   "Grill reached 225 °F"), with the cook's name, and the phone sounds.
6. **Repeat with a Focus on.** Stop that cook on the web. Turn on a Focus
   (Do Not Disturb) that does not allow MeatGeek but keeps Time Sensitive
   notifications allowed (the Focus default), lock the phone, and start
   another cook on the web with a target at or below the reading. The alert
   still shows and sounds, marked Time Sensitive.
7. **Tap the alert.** With the app closed, tap the alert from step 6 on the
   lock screen: after Face ID the app opens on that cook's live screen. Do it
   once more from the background: open the app, go to the home screen, stop
   the cook and start another on the web with a target at or below the
   reading, and tap its alert: the app opens on the new cook.
8. **Open app.** On a running cook's screen, Edit targets: change a probe's
   target to another value at or below its reading, Save, and go straight
   back to the Cooks list. Within about 10 seconds the banner shows and the
   sound plays. Do it again and stay on the cook's screen: the alert shows
   there too.
9. **Sign out** from the account menu, lock the phone, and start a cook on the
   web with a target at or below the reading: no alert arrives on this phone.

If no alert arrives: check Settings → MeatGeek → Notifications is on, that
the cook's target is at or below the reading on two readings in a row, the
cook's reached marks in the app (the server records them whether or not
Apple accepted the push), and the Function App's logs for the APNs answer.

## Cook chart

Every cook's screen draws the whole cook from the API's reduced series,
`GET /cooks/{cookId}/chart`, with Swift Charts (HAR-168). It ports the web
app's `apps/web/src/cooks/chart-series.ts`, `cook-chart.tsx` and
`cook-chart-view.tsx`: behaviour and copy.

- **Series** (`ChartSeries`, MeatGeekKit, a pure function of the generated
  `CookChart` and `TemperatureMessage` types): one row per server bucket at
  its start (`avg`, `min` → `lo`, `max` → `hi` per channel), then each pushed
  reading at or after the last bucket's end (`t + bucketSeconds`) as one row
  (`avg = lo = hi`), oldest first, at most 2,000 (the newest kept). Values
  are in the device's unit, converted and rounded as the live panel does.
  `channels` is the channels with a value in some row, in Grill, Probe 1–4
  order. A channel missing from a row is a gap, never zero: `segments(of:)`
  splits its line there.
- **States** (`CookChartModel`): "Loading chart…", "Chart not available" on
  404, the API's problem with **Retry** on any other failure, "No readings
  yet" when there are no rows, else the chart. It loads once the cook is
  known and again when the cook's status changes (after Stop or
  `cook_stopped`), keeping the old chart until the new one answers; an
  overtaken load is dropped. A 401 ends the session.
- **Live rows**: the readings come from the screen's one hub connection:
  `LivePanelModel` hands every `temperature` message it accepts (the cook's
  device's) to `onReading`, as the web's `onReading` does, and the chart keeps
  the last 2,000. Backfilled readings are not drawn.
- **View** (`MeatGeek/CookChartView.swift`): per channel a min–max band
  (`AreaPlot`, 15 % of the channel's colour) and an average line (`LinePlot`),
  broken at gaps; a lone point is marked (`PointPlot`). A legend, a time
  x-axis, a y-axis labelled °F or °C. Touch and hold (`chartXSelection`)
  selects the nearest time: a rule and a callout with each channel's value
  there (and the bucket's range), which stay after the finger lifts. The
  colours are fixed per channel, the web chart's (the dataviz palette's
  categorical slots 1–5), each with a dark-mode step, checked with the
  palette validator. VoiceOver reads it as "Temperature chart" with the
  channels, the number of points and each channel's latest value.

The logic is unit tested in `ChartTests.swift` (MeatGeekKitTests): every case
of `chart-series.spec.ts`, the model's states, the cook screen's wiring and
the stub's chart route. `testStartCookListOpenStop` checks the chart's
accessibility value at each step of the main path (a pushed point on an
active cook, a seeded cook's buckets, the reload after Stop);
`testChartNotAvailableAndRetry` drives the 404 and Retry.

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
