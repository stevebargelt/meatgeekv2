# Live Acceptance Suite

The live acceptance suite proves the **deployed** API works: it calls the real
Function App over HTTPS, as a real Entra-authenticated caller, writes data
through it, and reads it back. It replaces hand-run "live dev proofs" in
tickets.

It runs automatically after each dev deploy of the API: the `acceptance` job in
`.github/workflows/app-deploy-dev.yml` (see
[CI/CD → Dev app deploy and live acceptance](ci-cd.md#dev-app-deploy-and-live-acceptance-mg-36)).
A ticket whose behaviour is visible through the API can state its acceptance
criterion as **"the acceptance run on the merge commit is green"**, backed by a
proof the ticket adds. You can also run it by hand, as below.

## What it checks today

| Proof file                       | Proof                                                                          | Expects                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cooks-unauthenticated.proof.ts` | `GET /cooks` with no `Authorization` header                                    | `401`                                                                                                                                     |
| `cooks-lifecycle.proof.ts`       | `POST /devices` registering `acceptance-cook-<runId>` with a run-unique name   | `201`; the device id is the one sent                                                                                                      |
|                                  | `POST /cooks` with a new UUID `id` on `acceptance-cook-<runId>`                | `2xx`; body is an api-interfaces `Cook` with no Cosmos system property (`_rid`, `_self`, `_etag`, `_attachments`, `_ts`), status `active` |
|                                  | `GET /cooks`                                                                   | the new cook is listed (pages via `continuationToken`)                                                                                    |
|                                  | `GET /cooks?deviceId=<device>&status=active`                                   | `200`; returns exactly the new cook, `active`, on that device, in one page                                                                |
|                                  | `POST /cooks/{cookId}/stop`                                                    | `2xx`; the cook is `completed` with an `endTime`                                                                                          |
|                                  | `GET /cooks`                                                                   | the cook reads back `completed`                                                                                                           |
|                                  | `GET /cooks?deviceId=<device>&status=active`                                   | `200`; returns no cook after the stop                                                                                                     |
|                                  | `POST /cooks` on the unregistered `acceptance-unowned-<runId>`                 | `403`; `error` is `DEVICE_NOT_OWNED`                                                                                                      |
|                                  | `GET /cooks?deviceId=acceptance-unowned-<runId>`                               | `200`; returns no cook (the refused start wrote nothing)                                                                                  |
| `devices.proof.ts`               | `POST /devices` registering `acceptance-<runId>` with a run-unique name        | `201`; body is an api-interfaces `Device` with the id and name sent, `isActive: true`, `connectionStatus: unknown`                        |
|                                  | `GET /devices/{id}` for the registered device                                  | `200`; the same device, owned by the registering caller                                                                                   |
|                                  | `GET /devices`                                                                 | `200`; the device is listed, and every listed device has the caller as owner                                                              |
|                                  | `PATCH /devices/{id}` with a new `location`                                    | `200`; the device carries the new location                                                                                                |
|                                  | `GET /devices/{id}` for the registered device                                  | `200`; the patched location reads back                                                                                                    |
|                                  | `GET /devices/<random uuid>`                                                   | `404`                                                                                                                                     |
| `temperatures.proof.ts`          | `POST /devices` registering `acceptance-temp-<runId>` with a run-unique name   | `201`                                                                                                                                     |
|                                  | `GET /temperatures/current/acceptance-temp-<runId>`                            | `404` with `error: NO_READINGS` (owned, but nothing has been routed for it)                                                               |
|                                  | `GET /temperatures/current/acceptance-temp-unowned-<runId>` (never registered) | `404` with `error: DEVICE_NOT_FOUND`                                                                                                      |
| `users.proof.ts`                 | `PUT /users/me` with a run-unique `name` and `acceptance@example.invalid`      | `200` or `201` (the profile persists between runs); body is an api-interfaces `User` with the name and email sent and a `<tid>:<oid>` id  |
|                                  | `GET /users/me`                                                                | `200`; this run's name reads back, with the same `id` and `createdAt` as the PUT returned                                                 |

Every `devices.proof.ts` and `users.proof.ts` response body is also checked for
keys starting with `_` at any depth (Cosmos system properties).

Every authenticated cooks, devices, temperatures and users response must carry the
`x-meatgeek-request-charge` header (the Cosmos RU the call cost, as a decimal),
including the devices `404` and the cooks `403`, which still cost a point read,
and both temperatures `404`s (the ownership point read, plus the readings query
for `NO_READINGS`). The users figure includes the devices owner query that fills
`User.devices`. A response without
it fails the proof. Responses that make no Cosmos call, such as a 401, carry no
header.

Acceptance cooks and devices are not cleaned up: there is no delete route for
either yet (no `DELETE /cooks`, no `DELETE /devices`). Each run uses its own
device ids. `devices.proof.ts` registers `acceptance-<runId>`.
`cooks-lifecycle.proof.ts` registers `acceptance-cook-<runId>` and runs the
cook lifecycle on it, because a cook may only start on a device the caller
owns (HAR-26); a fresh device per run also means runs never trip the
one-active-cook-per-device rule. Both register a run-unique name, so runs never
collide on device id or on the `(userId, name)` pair. The cooks proof's last
two steps use `acceptance-unowned-<runId>`, which is never registered.

`temperatures.proof.ts` registers its own device, `acceptance-temp-<runId>`, and
is read-only otherwise: nothing in the suite writes telemetry (only IoT Hub
does), so a fresh device always answers `NO_READINGS`.

The acceptance profile is not cleaned up either: there is no `DELETE /users/me`.
It is keyed by the caller's identity, so every run writes the same document,
the CI service principal's profile. The first run creates it (`201`) and later
runs replace it (`200`); each run writes its own `Acceptance <runId>` name, so
the read-back proves that run's write. Its `devices` lists every acceptance
device the identity has registered.

## Output

One line per request, then a per-route RU table and a total:

```
acceptance run 20261118153521-6cacc5 against https://<function-app-host>/api
RUN  cooks lifecycle › POST /cooks starts a cook on the owned device and returns a Cook
  POST   /cooks                         201    412 ms  RU 11.43
PASS cooks lifecycle › POST /cooks starts a cook on the owned device and returns a Cook
...
RUN  cooks lifecycle › POST /cooks/{cookId}/stop stops the cook
  POST   /cooks/{cookId}/stop           500    233 ms  RU 20.1
FAIL cooks lifecycle › POST /cooks/{cookId}/stop stops the cook — POST /cooks/{cookId}/stop → 500: expected 2xx, got 500 (INTERNAL_SERVER_ERROR)
SKIP cooks lifecycle › GET /cooks reads the cook back as stopped (an earlier proof in this group failed)

RU per route
  ROUTE                                    CALLS  RU TOTAL   RU AVG
  GET /cooks                                   1      2.83     2.83
  GET /cooks (no auth)                         1         -        -
  POST /cooks                                  1     11.43    11.43
  POST /cooks/{cookId}/stop                    1      20.1     20.1

acceptance: 3 passed, 1 failed, 1 skipped
```

Any failed proof makes the process exit non-zero, and the `FAIL` line names the
proof, the route, and the status received. The bearer token is never printed:
the suite logs no request or response headers or bodies (only a bare upper-case
`error` code from an error body), and masks the token value in every line as a
second guard.

## Running it locally against dev

The suite takes exactly two inputs, both from the environment. If either is
missing it fails at once and names the variable; it never skips silently.

| Variable                  | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `ACCEPTANCE_BASE_URL`     | The API root, including `/api`, e.g. `https://<function-app-host>/api` |
| `ACCEPTANCE_BEARER_TOKEN` | An Entra access token for the API audience                             |

```bash
az login   # once, as a user the dev tenant knows

# The dev Function App's host name.
HOST=$(az functionapp list -g meatgeek-v2-dev-rg --query '[0].defaultHostName' -o tsv)

export ACCEPTANCE_BASE_URL="https://${HOST}/api"
export ACCEPTANCE_BEARER_TOKEN=$(az account get-access-token \
  --scope api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user \
  --query accessToken -o tsv)

npx nx run api:acceptance
```

The token is a delegated token for the `access_as_user` scope on the dev API
registration, which the dev Function App's Easy Auth accepts (see
[Authentication](../api/authentication.md)). Cooks written by the run land in
**your** user's partition.

In CI the caller is the dev app-publish identity instead: the `acceptance` job
mints an app-only token for `<audience>/.default`, so its cooks land in that
service principal's partition. The proof results and the RU-per-route table
also go to the workflow run's summary page. The target is never cached by Nx, so every invocation
calls the live system.

## How it is built

```
apps/api/acceptance/
├── jest.config.ts              # its own jest config: matches live.acceptance.ts only
├── live.acceptance.ts          # entry point for `nx run api:acceptance`
├── lib/
│   ├── proof.ts                # the proof contract: defineProofs, AcceptanceApi
│   └── runner.ts               # env check, HTTP client, output, RU table, exit code
├── proofs/
│   ├── cooks-lifecycle.proof.ts
│   ├── cooks-unauthenticated.proof.ts
│   ├── devices.proof.ts
│   ├── temperatures.proof.ts
│   └── users.proof.ts
└── acceptance-runner.spec.ts   # self-test, runs under `nx test api`
```

- `npx nx test api` never calls a live system. The api unit-test config does not
  match `live.acceptance.ts`. It does run `acceptance-runner.spec.ts`, which
  starts an in-process stub HTTP server imitating the cooks, devices, temperatures and users routes
  and drives the real runner and the real proof files against it: a passing
  stub, a wrong status on each route, a missing RU header on each route, missing
  environment variables, and a server that echoes the token back.
- The acceptance code is not part of the API build; `dist/apps/api` contains
  none of it.
- It uses only Node built-ins (`fetch`, `http`, `crypto`); no extra
  dependencies.

## Adding a proof for your ticket

1. **Create one file** in `apps/api/acceptance/proofs/`, named
   `<area>-<what>.proof.ts`. The runner loads every `*.proof.ts` there, in
   file-name order; you do not edit the runner.
2. **Default-export a group** built with `defineProofs`. Proofs in a group run
   in order and can share state through the closure; after a failure the rest of
   the group is skipped. Groups are independent of each other.

   ```ts
   import type { AcceptanceApi } from '../lib/proof';
   import { defineProofs } from '../lib/proof';

   export default defineProofs('cooks paging', () => [
     {
       name: 'GET /cooks?limit=1 returns at most one cook',
       async run(api: AcceptanceApi) {
         const response = await api.request<{ cooks: unknown[] }>({
           method: 'GET',
           path: '/cooks?limit=1',
           route: '/cooks',
         });
         api.expectStatus(response, 200);
         api.check(response, response.body.cooks.length <= 1, 'more than one cook returned');
       },
     },
   ]);
   ```

   - `api.request` sends the bearer token by default (`authenticated: false` to
     omit it). It requires the `x-meatgeek-request-charge` header by default; pass
     `expectRequestCharge: false` only for a response that makes no Cosmos call.
     For a path with an id in it, pass `route: '/cooks/{cookId}/stop'` so the
     output and RU table group by route, not by id.
   - `api.expectStatus(response, 201)` or `api.expectStatus(response, '2xx')`.
   - `api.check(response, condition, message)` fails the proof with the route
     and status attached. Annotate the parameter as `api: AcceptanceApi` so
     `check` can narrow types.
   - Name synthetic data with `api.runId` (e.g. `acceptance-${api.runId}`) so
     reruns never collide. Do not touch real devices or other users' data.

3. **Make the stub serve it.** The self-test runs every proof file against the
   stub in `acceptance-runner.spec.ts`. If your proof calls a route the stub does
   not implement, add that route to the stub, so `nx test api` keeps proving the
   proof passes against a correct server and fails against a broken one.
4. **If the route reads or writes Cosmos, return the RU header** from the
   handler: merge `requestChargeHeaders(charge)` from
   `apps/api/src/shared/cosmos/request-charge.ts` into its response headers, and
   unit-test it in the handler's `*.spec.ts`.
5. **Run it** against dev as above, and quote the run in the PR.
6. **Write the acceptance criterion** as: "the acceptance run on the merge
   commit is green, including `<proof name>`".
