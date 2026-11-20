# Web App

`apps/web` is the React (Vite) web client. It signs in with Entra ID, calls the
API through a client generated from the OpenAPI contract, and today manages
devices (list, register, rename) and cooks (start from a device, list, open,
stop). The live panel and the chart come later.

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
is not configured yet": that is the state until the SPA app registration exists.

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
| `/cooks/:id` | `src/cooks/cook-detail-page.tsx` | One cook, and Stop while it is active                    |
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

Two empty regions are left for later issues: `data-testid="cook-live-panel"`
(rendered only while the cook is active) and `data-testid="cook-chart"`.

## Commands

```bash
npx nx serve web                       # http://localhost:3000
npx nx test web                        # component tests (RTL, MSAL and fetch mocked)
npx nx lint web
npx nx run web:typecheck               # tsc over app and spec sources
npx nx build web --skip-nx-cache       # dist/apps/web
```

If Nx fails with a socket path that is too long (deep worktree paths), set
`NX_SOCKET_DIR=/tmp/nx` or `NX_DAEMON=false`.

## Deploy

Vercel's Git integration builds every push to `main` with the repo-root
`vercel.json`: `npm ci`, `npx nx build web --skip-nx-cache`, output
`dist/apps/web`, and a rewrite of every path to `/index.html` for client-side
routing. Vercel serves real files before applying rewrites, so `/config.json`
and `/assets/*` still resolve. No GitHub workflow deploys the web app, and
there is no `nx deploy web` target.
