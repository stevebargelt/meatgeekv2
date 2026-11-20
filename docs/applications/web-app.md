# Web App

`apps/web` is the React (Vite) web client. It signs in with Entra ID, calls the
API through a client generated from the OpenAPI contract, and today manages
devices: list, register and rename. Cooks and the live panel come later.

Production: `https://meatgeekv2-device-controller.vercel.app`, built from `main`
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
accepted them, `tsc` would fail.

Errors follow the API's flat `{error, message, requestId}` body. The UI shows
`message` and keeps `requestId` visible so a user can quote it.

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
