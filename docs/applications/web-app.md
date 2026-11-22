# Web App

`apps/web` is the React (Vite) web client. It signs in with Entra ID, calls the
API through a client generated from the OpenAPI contract, and today manages
devices (list, register, rename) and cooks (start from a device, list, open,
stop), shows an active cook's readings live over SignalR, and draws each
cook's temperatures as one chart.

Production: `https://meatgeekv2-web.vercel.app`, built from `main`
by Vercel.

## Runtime config

The app fetches `/config.json` before it renders anything. The committed file is
`apps/web/public/config.json`; Vite copies it to `dist/apps/web/config.json`.
None of the values is a secret.

| Field        | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `apiBaseUrl` | API base URL including `/api`                                            |
| `tenantId`   | Entra tenant; MSAL's authority is `login.microsoftonline.com/<tenantId>` |
| `clientId`   | The SPA app registration's client id                                     |
| `apiScope`   | The API's delegated scope, `api://<api-app-id>/access_as_user`           |

The shape is validated at load (`src/config/config.ts`). A missing or malformed
file renders a page listing each problem. An empty `clientId` renders "Sign-in
is not configured yet".

Production sign-in is configured in two places: HAR-95 puts the SPA app
registration's client id in `config.json`, and HAR-94 sets the API's CORS
(the web origin) and Easy Auth (the SPA client as an allowed audience/client).
The app needs both: the id to sign in, and CORS plus Easy Auth for the API and
SignalR to accept its calls.

## Sign-in

`@azure/msal-browser` + `@azure/msal-react`, authorization code + PKCE, no
client secret. `PublicClientApplication` uses
`redirectUri = window.location.origin` and the sessionStorage cache.

- **Sign in**: `loginRedirect({scopes: [apiScope]})`.
- **Tokens**: every API call gets its token from
  `acquireTokenSilent({scopes: [apiScope], account})`. On
  `InteractionRequiredAuthError` it falls back to `acquireTokenRedirect`
  (`src/auth/token.ts`).
- **Sign out**: `logoutRedirect`.

## API client

`src/api/client.ts` is `openapi-fetch` over the types `openapi-typescript`
generates from `libs/api-specs/spec/openapi.yaml`, imported as
`@meatgeekv2/api-specs/types`. A middleware adds `Authorization: Bearer <token>`
and a fresh `X-Request-ID` (UUID) to every request.

The generated types are gitignored. `web:build`, `web:test`, `web:lint` and
`web:typecheck` depend on `api-specs:generate-types`, so they always compile
against the spec as it is. `src/api/client.spec.ts` holds `@ts-expect-error`
lines that call paths and methods the spec does not declare; if the types ever
accepted them, `tsc` would fail. `src/cooks/validation.spec.ts` does the same for
the start-cook body: the form builds the spec's `StartCookRequest`, and a body
missing `meatType`, with a string weight, or with a field the schema does not
list fails `tsc`.

Errors follow the API's flat `{error, message, requestId}` body. The UI shows
`message` and keeps `requestId` visible so a user can quote it.

## Pages

| Route        | File                             | What it does                                             |
| ------------ | -------------------------------- | -------------------------------------------------------- |
| `/`          | `src/devices/devices-page.tsx`   | Devices: list, register, rename, start a cook            |
| `/cooks`     | `src/cooks/cooks-page.tsx`       | Cooks list, newest first, with device and status filters |
| `/cooks/:id` | `src/cooks/cook-detail-page.tsx` | One cook, its chart, and Stop while it is active         |
| `*`          |                                  | Redirects to `/`                                         |

Times show in the browser's local time zone.

### Start a cook (devices page)

Each device row has **Start cook**, which opens a form: name and meat type
(required, 1-100 characters after trimming), weight in lb (optional, > 0 and
≤ 1000) and grill/probe 1-4 targets in °F (optional, 0-1000). The checks mirror
`StartCookRequest`; the server stays authoritative.

The cook `id` is `crypto.randomUUID()`, generated once when the form opens. It
is the API's idempotency key, so every submit and retry from that form sends
it; closing and reopening the form is a new start intent with a new id.

| Answer                          | The form                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| 201, or 200 (replay)            | Goes to `/cooks/<id>`                                                                 |
| 409 `COOK_ALREADY_ACTIVE`       | Says so, with a link to `/cooks/<activeCookId>`                                       |
| 503 `DEVICE_TWIN_UPDATE_FAILED` | The cook is saved but the device was not told; **Retry** resends the same id and body |
| 400, 403, 422, anything else    | Shows the problem message and request id                                              |

The page reads active cooks with one `GET /cooks?status=active&limit=100` (not
one call per device) when it opens. A device with an active cook shows
"Cooking: <name>" linking to it instead of **Start cook**. If that lookup fails
the page says so and still offers **Start cook**; the API's 409 catches a
device that is already cooking.

### Cooks list (`/cooks`)

`GET /cooks?limit=20`, in the API's order (newest first). Columns: name, meat
type, device (its name from `GET /devices`, else the id), started, ended (or
"active"), status. **Load more** sends the previous page's `continuationToken`
and appends; it shows only while `hasMore` is true. The device and status
(`active`/`completed`) filters live in the URL (`/cooks?deviceId=…&status=…`)
and are sent as the API's query parameters. Each name links to the cook.

### Cook detail (`/cooks/:id`)

`GET /cooks/{cookId}`: name, status, meat type, device, start time, end time
(or elapsed time for an active cook, updated once a second), weight, targets
and notes. A 404 shows "This cook was not found" with a link back to `/cooks`.

An active cook has **Stop cook**, which asks for confirmation before
`POST /cooks/{cookId}/stop`. A 200 shows the cook completed with its end time.
A 503 `DEVICE_TWIN_UPDATE_FAILED` means the cook is completed but the device
was not told; **Retry** resends the stop, which the API makes safe. Other
answers (404, 403, …) show the problem.

An active cook also has the live panel (below). Every cook has the chart
(below).

### Live panel

`src/live/live-panel.tsx`, `data-testid="cook-live-panel"`, rendered only while
the cook is active. It shows the grill and probe 1-4 temperatures of the cook's
device, the reading's time and its age ("12 s ago", updated every second). A
channel with no value shows "—". Readings arrive in °F (the spec's
`TemperatureReading`); a device whose `configuration.temperatureUnit` is
`celsius` (from `GET /devices/{id}`) has them converted to °C.

**Connection** (`src/live/live-connection.ts`, `src/live/hub.ts`). One
connection per page: opened on mount, stopped on unmount.

1. `POST /negotiate` returns `{url, accessToken}`. The panel builds a
   `@microsoft/signalr` `HubConnection` with `.withUrl(url, {accessTokenFactory})`
   (the factory returns the negotiate token) and `.withAutomaticReconnect()`.
2. After every successful start and every automatic reconnect it calls
   `GET /temperatures/current/{deviceId}` and shows the answer if it is newer
   than what is on screen (404: no reading yet).
3. When the connection **closes** (automatic reconnect gave up), or negotiate or
   start fails (429, 503, 500, network), it negotiates again and starts a new
   connection after 2, 5, 10, then every 30 s, for as long as the page is open.
   Negotiating again gets a fresh 60-minute token.
4. A 401 from negotiate stops retrying and shows "Sign in again".

Messages are typed from the spec's `x-signalr` schemas. `temperature` messages
for another device are ignored; so is `cook_started`. `cook_stopped` for this
cook stops the connection and re-reads the cook, so the page shows it completed
and the panel goes away.

**States**, shown as a badge and as `data-state` on the panel:

| `data-state` | When                                                              | Badge                     |
| ------------ | ----------------------------------------------------------------- | ------------------------- |
| `connecting` | The first negotiate and start are in flight                       | Connecting…               |
| `waiting`    | Connected, no reading yet (the first can take up to about 20 s)   | Waiting                   |
| `live`       | Connected, and the reading is no older than 3 × `pollingInterval` | Live                      |
| `stale`      | Reconnecting or closed                                            | Reconnecting…             |
| `stale`      | Connected, but the reading is older than 3 × `pollingInterval`    | No reading for 1 min 40 s |
| `stale`      | Negotiate answered 401                                            | Sign in again             |

`pollingInterval` is the device's `configuration.pollingInterval` in seconds,
30 when unset (the API's default), so the default stale threshold is 90 s.

Each `temperature` message the panel accepts (the cook's device only) is also
passed to its optional `onReading` prop. The detail page uses it to feed the
chart, so the page has exactly one hub connection.

Tests inject a fake hub through `HubFactoryProvider` (`src/live/hub-context.tsx`,
`FakeHub` in `src/test/fakes.ts`); no test opens a real connection.

### Cook chart

`src/cooks/cook-chart.tsx`, `data-testid="cook-chart"`, on every cook's detail
page. One `recharts` `ComposedChart`, 320 px high, as wide as the card. For each
channel with data (grill, probe 1-4, each its own colour, named in the legend)
it draws the bucket's average as a line over a faint min-max band. The x axis
is local time; the y axis and the tooltip (avg, min and max of each channel at
the hovered time) are in the device's unit (`configuration.temperatureUnit`
from `GET /devices`, °F when unset).

**Data.** `GET /cooks/{cookId}/chart` once when the page opens: the
server-reduced series (at most 720 buckets, each channel's `{min, max, avg}`,
in °F; see the API's `getCookChart`). It is read again once when the cook goes
from active to completed (stopped here, or a `cook_stopped` push).

| Answer          | The chart region                  |
| --------------- | --------------------------------- |
| 200 with points | The chart                         |
| 200, no points  | "No readings yet"                 |
| 404             | "Chart not available"             |
| anything else   | The problem message and **Retry** |

**Live appending.** While the cook is active, the readings the live panel
receives (`onReading`) are appended after the server series: a reading becomes
its own point (`avg = min = max`) if its timestamp is at or after the last
bucket's end (`t + bucketSeconds`); earlier ones are already in that bucket and
are dropped. At most 2,000 pushed points are kept, the newest. The server
series can lag the newest reading by about 30 s, so the newest few seconds may
be missing from the last bucket until the next read.

`src/cooks/chart-series.ts` does all of that as a pure function
(`buildChartSeries`): server points and pushed readings in, rows in the display
unit out (converted with `formatTemperature`'s rules), with channels that have
no data left out.

**Bundle.** The recharts view (`src/cooks/cook-chart-view.tsx`) is loaded with
`React.lazy`, so it is its own chunk (about 454 kB, 129 kB gzipped) and only the
cook detail page downloads it.

## Commands

```bash
npx nx serve web                       # http://localhost:3000
npx nx test web                        # component tests (RTL, MSAL and fetch mocked)
npx nx lint web
npx nx run web:typecheck               # tsc over app and spec sources
npx nx build web --skip-nx-cache       # dist/apps/web
npx nx e2e web-e2e                     # browser test of the main path (see below)
```

If Nx fails with a socket path that is too long (deep worktree paths), set
`NX_SOCKET_DIR=/tmp/nx` or `NX_DAEMON=false`.

## Browser tests

`apps/web-e2e` is a Playwright project (Chromium only) with one test,
`src/main-path.spec.ts`, of the main path in a real browser against the built
app: sign in, the devices page, start a cook, the live panel waiting, one pushed
reading making it live, the chart, stop, completed.

```bash
npx playwright install chromium        # once per machine
npx nx e2e web-e2e                     # builds web, serves dist/apps/web, runs headless
npx nx run-many -t lint typecheck -p web-e2e
```

The `e2e` target runs `nx build web` first, then Playwright's `webServer` serves
`dist/apps/web` with `vite preview` on port 4300 (it never reuses a server
already on that port, and a port already taken fails the run). Run it through
Nx: `playwright test` on its own serves whatever is in `dist/apps/web`, which
may be a stale build. On failure the trace and screenshot are kept under
`dist/.playwright/web-e2e/test-results`, and the HTML report under
`dist/.playwright/web-e2e/report`.

`WEB_E2E_PORT` serves on another port instead, with results and report under
`dist/.playwright/web-e2e/port-<port>/`; that is how test-repeat runs 8 copies
at once, on 4301 to 4308 (HAR-121). Unset, it is 4300.

No wait in the test has a deadline of its own (HAR-121). The browser's clock
and the fakes' are frozen on one instant (`src/fakes/clock.ts`), so a reading
the test seeds or pushes is exactly as old as it says however slow the run;
every `expect` waits for its event, bounded only by the 60 s test timeout
(`expect.timeout: 0` in `playwright.config.ts`).

It needs no network and no secret. Everything outside the app is faked at the
network edge, in `src/fakes/`; nothing in `apps/web/src` knows it is under test.
Every other request off the app's origin is aborted, and the test fails if any
was made.

| Faked          | How                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/config.json` | Routed to a test config: a fake tenant, client id and scope, and `apiBaseUrl` `https://api.test/api`.                                                                                                                                                                                                                                                                    |
| Entra ID       | `page.route` on `login.microsoftonline.com`. The app's real MSAL runs `loginRedirect` and the code + PKCE exchange: `authorize` redirects back with a code and the request's `state`; `token` checks the code, client, redirect URI and PKCE verifier, and returns an unsigned id token (the request's `nonce`, `aud` = client id), an access token and a refresh token. |
| The API        | `page.route` on `https://api.test/api/**`: an in-memory fake of the nine routes the path calls. Response bodies are typed from the generated spec types, so a fake that drifts from `openapi.yaml` fails `web-e2e:typecheck`. It records each request, and the test checks every one carried the fake access token.                                                      |
| SignalR        | `POST /negotiate` returns `https://hub.test/client/?hub=temperatureHub`. `page.route` answers the client's negotiate with WebSockets only, and `page.routeWebSocket` speaks the JSON hub protocol: the handshake, pings, and the `temperature` message the test pushes.                                                                                                  |

Why at the network edge: the test runs the same bundle Vercel serves, with no
test-only code path or flag, so it covers the wiring the component tests fake
(MSAL, `openapi-fetch`, the SignalR client, routing, the chart). Two
simplifications: a new cook's start is back-dated three minutes so its chart
already has three one-minute buckets before the pushed reading, and
`GET /temperatures/current` always answers 404 `NO_READINGS`, so the panel waits
for the push.

`vite preview` does not send the Content-Security-Policy from `vercel.json`,
so the page may reach `api.test` and `hub.test` here. That is expected; the
policy is checked by `src/csp.spec.ts`.

## Content-Security-Policy

`vercel.json` sends a `Content-Security-Policy` header on every path:

| Directive         | Sources                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `default-src`     | `'self'`                                                                                                                      |
| `connect-src`     | `'self'`, the API origin, `https://login.microsoftonline.com`, `https://*.service.signalr.net`, `wss://*.service.signalr.net` |
| `frame-src`       | `'self'`, `https://login.microsoftonline.com` (MSAL's silent token renew; see below)                                          |
| `img-src`         | `'self' data:`                                                                                                                |
| `object-src`      | `'none'`                                                                                                                      |
| `base-uri`        | `'self'`                                                                                                                      |
| `frame-ancestors` | `'none'`                                                                                                                      |

`frame-src` needs `'self'` as well as the sign-in origin. MSAL's silent renew
loads `login.microsoftonline.com/authorize` in a hidden iframe, and Entra then
redirects that iframe back to `redirectUri`, which is this site's own origin
(`src/auth/msal.ts`). Without `'self'` the browser blocks the redirect, MSAL
times out with a `BrowserAuthError`, and API calls fail until the user signs
out.

There is no `style-src` or `script-src`: the build has no inline script or
style, so `default-src 'self'` covers both.

The API origin is written out, so it must match `apiBaseUrl` in
`public/config.json`. `src/csp.spec.ts` reads both files and fails if they
differ: change them together.

## Deploy

Vercel's Git integration builds every push to `main` with the repo-root
`vercel.json`: `npm ci`, `npx nx build web --skip-nx-cache`, output
`dist/apps/web`, a rewrite of every path to `/index.html` for client-side
routing, and the Content-Security-Policy header above. Vercel serves real files before applying rewrites, so `/config.json`
and `/assets/*` still resolve. No GitHub workflow deploys the web app, and
there is no `nx deploy web` target.
