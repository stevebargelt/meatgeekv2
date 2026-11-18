# Live Acceptance Suite

The live acceptance suite proves the **deployed** API works: it calls the real
Function App over HTTPS, as a real Entra-authenticated caller, writes data
through it, and reads it back. It replaces hand-run "live dev proofs" in
tickets.

It will run automatically after each dev deploy of the API (that wiring is a
later ticket; until then, run it by hand as below). Once it is wired, a ticket
whose behaviour is visible through the API can state its acceptance criterion as
**"the acceptance run on the merge commit is green"**, backed by a proof the
ticket adds.

## What it checks today

| Proof file                       | Proof                                                                          | Expects                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cooks-unauthenticated.proof.ts` | `GET /cooks` with no `Authorization` header                                    | `401`                                                                                                                                     |
| `cooks-lifecycle.proof.ts`       | `POST /cooks` with a new UUID `id` and a synthetic device `acceptance-<runId>` | `2xx`; body is an api-interfaces `Cook` with no Cosmos system property (`_rid`, `_self`, `_etag`, `_attachments`, `_ts`), status `active` |
|                                  | `GET /cooks`                                                                   | the new cook is listed (pages via `continuationToken`)                                                                                    |
|                                  | `POST /cooks/{cookId}/stop`                                                    | `2xx`; the cook is `completed` with an `endTime`                                                                                          |
|                                  | `GET /cooks`                                                                   | the cook reads back `completed`                                                                                                           |

Every authenticated cooks response must carry the `x-meatgeek-request-charge`
header (the Cosmos RU the call cost, as a decimal). A response without it fails
the proof. Responses that make no Cosmos call, such as a 401, carry no header.

Acceptance cooks are not cleaned up: there is no delete route yet. Each run uses
its own device id, so runs never trip the one-active-cook-per-device rule.

## Output

One line per request, then a per-route RU table and a total:

```
acceptance run 20261118153521-6cacc5 against https://<function-app-host>/api
RUN  cooks lifecycle › POST /cooks starts a cook and returns a Cook
  POST   /cooks                         201    412 ms  RU 11.43
PASS cooks lifecycle › POST /cooks starts a cook and returns a Cook
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
**your** user's partition. The target is never cached by Nx, so every invocation
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
│   └── cooks-unauthenticated.proof.ts
└── acceptance-runner.spec.ts   # self-test, runs under `nx test api`
```

- `npx nx test api` never calls a live system. The api unit-test config does not
  match `live.acceptance.ts`. It does run `acceptance-runner.spec.ts`, which
  starts an in-process stub HTTP server imitating the cooks routes and drives the
  real runner and the real proof files against it: a passing stub, a wrong status
  on each route, a missing RU header on each route, missing environment
  variables, and a server that echoes the token back.
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
