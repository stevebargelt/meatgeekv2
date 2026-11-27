# iOS App

`apps/ios` is the native iPhone client: Swift 6, SwiftUI, iOS 18.0 and later,
iPhone only. It signs in with Entra ID, calls the API through a client
generated from the OpenAPI contract, and manages devices (list with each
device's connection, claim with the code the device shows, rename, release)
and cooks (list with filters and paging, start from a device, open, stop). An
active cook's screen shows its readings live over SignalR, and every cook's
screen draws the whole cook as one chart. With the pitmaster's permission it
registers the phone for target alerts and presents them; tapping one opens
the cook. It is the iOS counterpart of the
[web app](web-app.md), which is the reference for how each screen behaves; the
two share only the OpenAPI contract in `libs/api-specs/spec`.

It was built by goal HAR-157 (HAR-158 to HAR-169). It runs against the **dev**
API only, and it is **not distributed**: there is no TestFlight or App Store
build (see [TestFlight](#testflight)). It runs in the simulator or on a
developer's own iPhone from Xcode. Every pull request tests it in CI, and a
daily scheduled workflow proves it live against dev in a simulator
(`ios-live-proof.yml`); that proof is not a deploy gate (HAR-170).

The detailed developer guide, with every model, state and copy rule, is
[`apps/ios/README.md`](../../apps/ios/README.md). This page is the overview.

## Architecture

All logic is in the local Swift package `MeatGeekKit`, where it is unit
tested. The app target holds only SwiftUI views, the `@main` entry point and
`AppComposition`, which picks the real or the test implementations at launch.
Screen state is `@Observable`, `@MainActor` models.

| Target                | Kind                                      | What it holds                                                                                                                                         |
| --------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MeatGeek`            | iOS app (`com.meatgeek.ios`)              | The views (`DevicesView`, `CooksView`, `LivePanelView`, `CookChartView`, sign-in), `AppComposition` and `SystemNotifications` (the notifications port's real adapter). The chart uses Apple's Swift Charts |
| `MeatGeekKit`         | Swift package library                     | `AppConfig`, `SessionModel`, `APIClientFactory`, the screen models, `LiveConnection`, `ChartSeries`, and the in-process stub API used in UI test mode |
| `MeatGeekAPI`         | Swift package target                      | The API client, generated on every build by the `swift-openapi-generator` build plugin from the committed bundle `openapi.yaml`                       |
| `MeatGeekMSAL`        | Swift package library                     | `MSALTokenProvider`: the only code that links MSAL for iOS (2.18.1). The app links it; of the tests, only `MeatGeekMSALTests` uses it                 |
| `MeatGeekLive`        | Swift package library                     | `SignalRLiveHub`: the only code that links `SignalR-Client-Swift` (1.2.1). The app links it; `MeatGeekKitTests` does not                              |
| `MeatGeekKitTests`    | Swift package tests (Swift Testing)       | Unit tests of every model, with fakes and a virtual clock                                                                                             |
| `MeatGeekLiveTests`   | Swift package tests (Swift Testing)       | Decodes a real `temperature` frame through the SignalR client's JSON hub protocol                                                                     |
| `MeatGeekActivity`    | Swift package library                     | The lock-screen activity (#271): the ActivityKit adapter behind `LiveActivities`, the lock-screen view and the widget. The app and `MeatGeekWidgets` link it |
| `MeatGeekActivityTests` | Swift package tests (Swift Testing)     | Renders the lock-screen view from its presentation value                                                                                              |
| `MeatGeekWidgets`     | Widget extension (`com.meatgeek.ios.widgets`) | Embedded in the app; holds the cook's lock-screen activity                                                                                       |
| `MeatGeekMSALTests`   | XCTest, hosted in the app                 | `MSALTokenProvider` against the real MSAL: creating it turns the Authenticator broker off (HAR-171)                                                   |
| `MeatGeekUITests`     | XCUITest (`com.meatgeek.ios.uitests`)     | The main paths, driven against the in-process stub API                                                                                                |
| `MeatGeekLiveUITests` | XCUITest (`com.meatgeek.ios.liveuitests`) | The live iOS proof against dev, in its own test plan `Live.xctestplan`; CI only compiles it                                                           |

The screens, and the models behind them:

| Screen      | Models                                                  | API calls                                                                                             |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Sign-in     | `SessionModel`, `MSALTokenProvider`                     | Entra, then `GET /users/me` for the account menu's name                                               |
| Devices tab | `DevicesModel`, `ClaimDeviceModel`, `RenameDeviceModel` | `GET /devices`, `GET /cooks?status=active`, `POST /devices/claim`, `PATCH` and `DELETE /devices/{id}` |
| Cooks tab   | `CooksModel`, `StartCookModel`, `CookDetailModel`       | `GET /cooks`, `POST /cooks`, `GET /cooks/{cookId}`, `POST /cooks/{cookId}/stop`, `PUT /cooks/{cookId}/targets`                     |
| Live panel  | `LiveConnection`, `LivePanelModel`                      | `POST /negotiate`, the SignalR hub, `GET /temperatures/current/{deviceId}` (backfill)                 |
| Cook chart  | `CookChartModel`, `ChartSeries`                         | `GET /cooks/{cookId}/chart`, plus the readings the live panel receives                                |
| Alerts      | `NotificationsModel`, `NotificationsPort`               | `POST /users/me/push-tokens`, `DELETE /users/me/push-tokens/{tokenId}`                                |

Every call goes through `SessionModel.perform`, so a 401 from any route ends
the session ("Your session ended. Sign in again."). The live panel negotiates,
opens one hub connection with automatic reconnect, and when that gives up
negotiates again after 2, 5, 10, then every 30 s. It backfills from
`GET /temperatures/current/{deviceId}` after every start and reconnect, shows
`waiting`, `live` or `stale` (no reading for 3 × the device's
`pollingInterval`), and is connected only while the cook screen is on screen
and the app is in the foreground. `cook_stopped` for the cook ends it on
screen. The architecture model shows these components and their connections in
the [`system`](https://stevebargelt.github.io/meatgeekv2/#/view/system/) and
[`cloud`](https://stevebargelt.github.io/meatgeekv2/#/view/cloud/) views; the
[`watchCook`](https://stevebargelt.github.io/meatgeekv2/#/view/watchCook/)
flow is the same for both apps.

Alerts (#245): the app asks for notification permission the first time a
running cook's screen shows, never at launch; once granted it registers the
phone's APNs token with the API, again whenever it changes, and removes it at
sign-out. A declined permission shows "Alerts are off" on a running cook's
screen with a link to Settings. Alerts show with banner and sound while the
app is open, and a tap opens the cook. The app has the Push Notifications and
Time Sensitive Notifications capabilities (`Config/MeatGeek.entitlements`);
the simulator build still needs no signing identity. How it is built and
tested, and the steps for checking alerts on a real iPhone, are in
[the developer guide](../../apps/ios/README.md#alerts).

## Config and auth

The config is compiled in. `Config/Dev.xcconfig` holds four build settings,
`Config/MeatGeek-Info.plist` copies each into an Info.plist key, and
`AppConfig` checks them at launch. They are the same public values as the web
app's `config.json`; none is a secret.

| Build setting           | Value                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `MEATGEEK_API_BASE_URL` | The dev Function App, with `/api`                                                  |
| `MEATGEEK_TENANT_ID`    | The Entra tenant                                                                   |
| `MEATGEEK_CLIENT_ID`    | The iOS registration `meatgeek-v2-dev-ios`: `b422c945-cb04-4d97-a816-3f20eb54176b` |
| `MEATGEEK_API_SCOPE`    | `api://348570b2-…/access_as_user`                                                  |

There is one configuration, dev; Debug and Release both use it.

- **Registration.** `bootstrap.sh` creates the public-client registration
  `meatgeek-v2-dev-ios` (HAR-159) with the redirect URI
  `msauth.com.meatgeek.ios://auth`, pre-authorized for `access_as_user`, and
  publishes its client id as the `DEV_IOS_CLIENT_ID` variable on the
  `development` environment. `MEATGEEK_CLIENT_ID` is that value (HAR-164).
- **Sign-in.** MSAL for iOS, authorization code + PKCE, in the system browser
  (`ASWebAuthenticationSession`), no secret (HAR-162). It never opens
  Microsoft Authenticator, even when installed: `MSALTokenProvider` sets
  `MSALGlobalConfig.brokerAvailability = .none` before creating MSAL, so the
  Info.plist has the `msauth.com.meatgeek.ios` redirect scheme and no
  `msauthv2`/`msauthv3` query schemes, which MSAL needs only for the broker
  (HAR-171). Tokens live only in
  MSAL's keychain cache, under the app's own keychain group, so a device build
  needs no keychain entitlement (its only entitlements are the two push
  capabilities). Every API call gets its token from
  `acquireTokenSilent`, and `BearerTokenMiddleware` adds
  `Authorization: Bearer <token>`.
- **Easy Auth.** The dev API accepts the app's tokens because its client id is
  the fifth entry in `functions_auth_allowed_client_app_ids` in
  `apps/infrastructure/environments/dev.tfvars` (HAR-163).

If the registration is ever recreated, its client id changes: update
`MEATGEEK_CLIENT_ID` and the expected value in `BuiltAppConfigTests` together.

## Build and run

You need a Mac with Xcode 26.x (26.6 is what CI uses) and an iOS simulator
runtime. No Apple account is needed for the simulator. This is not an Nx
project; use Xcode or `xcodebuild`.

**In Xcode:** `open apps/ios/MeatGeek.xcodeproj`, pick the **MeatGeek**
scheme and an iPhone simulator, and Run (⌘R). The first build asks you to
trust the `OpenAPIGenerator` build plugin: **Trust & Enable**.

**From the command line**, from the repository root:

```sh
xcodebuild build -project apps/ios/MeatGeek.xcodeproj -scheme MeatGeek \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' \
  -skipPackagePluginValidation

xcrun simctl boot 'iPhone 17' || true
open -a Simulator
xcrun simctl install booted \
  ~/Library/Developer/Xcode/DerivedData/MeatGeek-*/Build/Products/Debug-iphonesimulator/MeatGeek.app
xcrun simctl launch booted com.meatgeek.ios
```

The app signs in to dev with a real Entra account, and shows the devices and
cooks of that account.

**On an iPhone:** copy `apps/ios/Config/Signing.local.xcconfig.example` to
`Signing.local.xcconfig` (gitignored), set your `DEVELOPMENT_TEAM`, and run
from Xcode with the phone selected. Nothing that identifies an Apple account
is committed. See
[Signing for a physical iPhone](../../apps/ios/README.md#signing-for-a-physical-iphone).

**After a spec change**, re-bundle the contract for the app and commit the
result with the spec change:

```sh
npx nx run api-specs:bundle-ios
```

`npx nx test api-specs` fails while the committed bundle
(`MeatGeekKit/Sources/MeatGeekAPI/openapi.yaml`) differs from a fresh bundle
(HAR-161). Once re-bundled, app code that no longer matches the generated
types fails to compile.

## Test

**Unit and UI tests**, from the repository root:

```sh
xcodebuild test -project apps/ios/MeatGeek.xcodeproj -scheme MeatGeek \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' \
  -skipPackagePluginValidation
```

This runs the `MeatGeek` test plan: `MeatGeekKitTests`, `MeatGeekLiveTests`
and `MeatGeekActivityTests` (Swift Testing), `MeatGeekMSALTests` (XCTest, in the app, against the real
MSAL) and `MeatGeekUITests` (XCUITest). It needs Xcode's default simulator
signing, so do not add `CODE_SIGNING_ALLOWED=NO`: MSAL's keychain cache needs
the build's entitlements. The UI tests launch the app
in UI test mode (`MEATGEEK_UI_TEST=1`): a fake token provider and `StubAPI`, an
in-process implementation of the generated client with seeded devices, cooks,
charts and pushed readings, on a fixed clock. They touch neither MSAL nor the
network. Add `-only-testing:<target>[/<class>/<test>]` to run one. The tests
follow the [deterministic test rule](../development/deterministic-tests.md):
no sleeps, and no timeout decides a result.

**The live proof** (`MeatGeekLiveUITests`, HAR-169) runs the real app in a
throwaway simulator against dev: it signs in on Microsoft's real pages as the
acceptance user (password and TOTP), claims a simulated device, starts a cook,
waits for a reading pushed over SignalR, stops the cook and releases the
device. `apps/ios/scripts/run-live-proof.sh` runs it; to run it by hand you
need the acceptance user's credentials, a DPS-enrolled simulated device and a
built `simdevice`. See
[Live iOS proof](../development/live-acceptance.md#live-ios-proof) for the
inputs, the steps and what is and is not logged.

## CI

| Job              | Workflow             | When                                                                                                                                                                                                   | What                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ios`            | `ci.yml`             | Every pull request and push to `main`, no path filter                                                                                                                                                  | `macos-26`, Xcode 26.6, iPhone 17 simulator: `xcodebuild test` of the `MeatGeek` scheme; fails if `MeatGeekKitTests`, `MeatGeekLiveTests`, `MeatGeekActivityTests`, `MeatGeekMSALTests` or `MeatGeekUITests` ran no tests or if `MeatGeekLiveUITests` ran; then compiles `MeatGeekLiveUITests` without running it. Simulator signing only (no team, no certificate), no secret, `contents: read`. $0: the repository is public. Uploads `ios-xcresult` (7 days) |
| `ios-acceptance` | `ios-live-proof.yml` | Once a day (09:17 UTC) and on `workflow_dispatch` from `main`; never alongside Deploy Dev App's `web-acceptance` (both sign in as the same TOTP user). **Not a deploy gate**: a failure blocks nothing | Builds the app from `main`'s tip, enrols `<sim>-ios` through DPS, runs the live proof against whatever dev serves, prints `METRIC ios-push-ms` (10918 in run 45429145737), runs the leak check over the raw log, and uploads the `ios-acceptance-screenshots` artifact (30 days, on success too)                                                                                                                                       |

See [CI/CD: iOS job](../development/ci-cd.md#ios-job-har-160),
[CI/CD: Live iOS proof](../development/ci-cd.md#live-ios-proof-har-169-har-170) and
[Live iOS proof](../development/live-acceptance.md#live-ios-proof).

## TestFlight

Not built. Distributing the app through TestFlight would need: a paid Apple
Developer Program membership; an App Store Connect app record for the bundle
id `com.meatgeek.ios`; a distribution certificate and an App Store
provisioning profile, kept out of the repository (as encrypted CI secrets with
a temporary keychain on the runner, or by using Xcode Cloud instead); a job
that archives a Release build, exports it and uploads it with an App Store
Connect API key; the export compliance answer (the app uses only the system's
HTTPS, so `ITSAppUsesNonExemptEncryption = NO` in the Info.plist would answer
it); and the App Store privacy details (the app collects the user's Entra
account and stores cook and device data with the API), with a privacy
manifest. It would also need a decision on which API a distributed build talks
to: today the config is dev only.
