# Cooks persistence lands on ONE shared Cosmos adapter (`libs/azure-client` deleted); managed identity only, fail-loud Terraform-sourced config, and partition-scoped read/write under the Easy Auth principal

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** MG-59 (cooks persistence — production-activation blocker; the V2
  API had never persisted anything)
- **Scope:** `apps/api/src/shared/cosmos/cosmos-adapter.ts`,
  `apps/api/src/shared/cosmos/cooks-repository.ts`,
  `apps/api/src/shared/auth/principal.ts`,
  `apps/api/src/functions/cooks/{list-cooks,start-cook,stop-cook}.ts`,
  `apps/api/src/functions/health/cosmos-health.ts`,
  `apps/api/src/functions/no-inline-fixtures.spec.ts`,
  `apps/infrastructure/modules/functions` (the three `COSMOSDB*` app
  settings), `apps/infrastructure/modules/cosmos-db` (the `cooks_shared`
  container this ticket reads/writes). `libs/azure-client` is deleted as part
  of this scope, not edited.

## Context

Before this ticket, the V2 API had never persisted anything. `libs/azure-client`'s
`cosmos-client.ts` was a no-op shell: no `@azure/cosmos` import, every method a
`console.log` plus a TODO, and a `healthCheck()` that returned hardcoded green —
an MG-51-class defect, since a dependency that cannot fail can never report
unhealthy. It was not wired into any handler. The cooks handlers instead carried
their own inline mocks (`list-cooks.ts` fabricated an array, `start-cook.ts` and
`stop-cook.ts` minted synthetic `Cook` objects stamped with the hardcoded tenant
`userId: 'user-1'`) and re-declared the `Cook`/`StartCookRequest`/
`CookListResponse` contracts locally instead of importing the canonical shapes
from `@meatgeekv2/api-interfaces`. The only code in the API that actually reached
Cosmos was the MG-51 health probe, which built its own `CosmosClient` and its own
hand-rolled managed-identity token fetch — sharing no code with the (mocked)
request path. That asymmetry is exactly how the MG-51 outage shipped behind a
green health check: the probe and the handlers could point at two different
Cosmos configurations without either side knowing.

MG-59's acceptance criterion 1 requires a recorded decision on four things: the
fate of `libs/azure-client`, the Cosmos client's lifecycle, the configuration
discipline the cooks path follows, and the cooks read/write model. Each is
recorded below.

## Decision

### 1. The fate of `libs/azure-client` — deleted

`libs/azure-client` is **deleted**, not patched. The API builds on `@azure/cosmos`
directly through one shared adapter (`apps/api/src/shared/cosmos/cosmos-adapter.ts`)
that both the cooks handlers and the health route consume. The old shell's
problem was not a missing feature; it was that its existence let the health
probe and the handlers diverge onto two different Cosmos paths while both
compiled and both looked wired. Keeping one seam — `getCosmosAdapter()` — that
every Cosmos consumer in the API goes through makes that divergence structurally
impossible rather than relying on the next contributor to keep them in sync by
convention.

### 2. Client lifecycle — a lazily-initialised module-level singleton

`getCosmosAdapter()` (`cosmos-adapter.ts:211`) holds a single `CosmosAdapter`
instance for the life of the host process. The adapter itself defers
constructing its `CosmosClient` and its `TokenCredential` until the first call to
`getClient()` (`cosmos-adapter.ts:158`); importing the module — and therefore
importing a handler or the host's `main.ts` registration path, as the Jest
suite does without setting the Cosmos env — reads no configuration and
constructs nothing. The first real invocation that reaches Cosmos resolves
config, builds the client and credential once, and every subsequent warm
invocation on Flex Consumption reuses that same client/credential pair — so the
connection pool and the credential's token cache (with its refresh-before-expiry
behaviour) survive across warm invocations instead of being rebuilt per request.
The health route shares this exact instance (`cosmos-health.ts` calls
`getCosmosAdapter()` directly rather than constructing anything of its own), so
the client/credential/database/container a health check exercises are, by
construction, the ones a cooks request handler exercises.

### 3. Configuration discipline — MG-51 fail-loud, Terraform-owned, injected credential

Three settings are read from `process.env` directly and thrown on if missing or
blank, inventing no default: `COSMOSDB__accountEndpoint`,
`COSMOSDB_DATABASE_NAME`, `COSMOSDB_COOKS_CONTAINER_NAME`
(`cosmos-adapter.ts:32-34`, `resolveCosmosConfig`). This deliberately does
**not** route through `apps/api/src/environments/environment.ts` /
`environment.production.ts`, which still carry the V1 `|| 'meatgeek'` database
fallback and a `connectionString` field read from
`process.env['COSMOSDB_CONNECTION_STRING']` — that silent-wrong-name fallback is
exactly the failure mode MG-51 exists to refuse, and reconciling those files is
MG-55's scope, not this ticket's. The cooks container name is Terraform-owned:
`apps/infrastructure/modules/functions/main.tf` publishes
`COSMOSDB_COOKS_CONTAINER_NAME` from `var.cooks_container_name`, and that
variable is documented (`variables.tf:106`) as sourced from the `cosmos-db`
module's `destination_container_names.cooks` output rather than restated as a
literal, so there is one source of truth for the deployed container name.

The credential is an **injected** `TokenCredential`
(`CosmosAdapterSeams.credentialFactory`), not a hardcoded choice baked into the
client construction call. The production seam
(`cosmos-adapter.ts:124`, `productionSeams`) constructs a
`ManagedIdentityCredential` — **never** an unrestricted `DefaultAzureCredential`,
whose fallback chain could let an environment or developer credential bind
around the workload identity. No account key and no connection string appear
anywhere in this file. The seam exists so a unit test (or deliberate local
tooling) can inject a fake or a `DefaultAzureCredential` explicitly; the
deployed path can never reach that branch.

### 4. The cooks read/write model

The cooks container (`cooks_shared`,
`apps/infrastructure/modules/cosmos-db/main.tf:264-270`) is partitioned on
`/userId`. `userId` is derived **solely** from the validated Easy Auth
`X-MS-CLIENT-PRINCIPAL` header (`apps/api/src/shared/auth/principal.ts`): the
tenant id (`tid` claim) and object id (`oid` claim) are composed as
`"<tenantId>:<objectId>"`, because an Entra object id is only unique *within*
its tenant — not globally — so the tenant id must travel with it as the
partition namespace. This value is never request-supplied and never the retired
`user-1` tenant; a missing, unparseable, or claim-incomplete header fails closed
to an `UNAUTHENTICATED` result with a fixed reason code, with no fallback
identity (`principal.ts:31-34`). All three cooks handlers resolve the principal
before doing any other work, so an unauthenticated caller triggers no body
parse, no query, and no write.

- **Point reads** address `(id, userId)` directly
  (`cooks-repository.ts:154`, `getCook` / `readCookWithEtag`), routing the SDK to
  exactly one partition rather than a cross-partition scan filtered down to one
  document.
- **`listCooksByUser`** (`cooks-repository.ts:270`) is a single-partition query —
  both the `WHERE c.userId = @userId` predicate and the `partitionKey` option pin
  it to one partition — with a bounded page size (`clampPageSize`, default 20,
  hard cap 100) and continuation-token pagination. There is no offset parameter
  and no `ReadAll`/cross-partition path anywhere in the repository, because the
  `cooks_shared` container draws on the same database-level 400 RU/s shared offer
  the IoT temperature-ingest path also spends against (see
  [`mg-53-cosmos-shared-throughput-destination`](mg-53-cosmos-shared-throughput-destination.md));
  offset pagination would re-charge every skipped document against that shared
  pool.
- **`stopCook`** (`cooks-repository.ts:213`) is read-then-replace with an
  `If-Match` on the ETag the read returned. A 412 (another writer replaced the
  document between the read and the write) triggers a bounded re-read-and-retry
  (`STOP_COOK_MAX_ATTEMPTS = 3`); the re-read sees the now-`completed` document
  and the idempotent guard returns it as-is, so two concurrent stops converge on
  the winner's `endTime` instead of racing a lost update. An already-completed
  cook is returned with `transitioned: false`, and `stop-cook.ts` emits no
  `COOK_STOPPED` envelope in that case — only a write that actually performed the
  transition announces it.
- **SignalR envelopes emit only after a successful write.** Both `start-cook.ts`
  and `stop-cook.ts` set the SignalR output binding after the repository call
  returns, never before, so a write failure throws to the handler's catch block
  with no envelope ever set. The envelope's delivery `userId` (the SignalR user
  group, set to the cook's `deviceId`) is a deliberately distinct axis from the
  persisted identity `userId` (the authenticated principal) — the two are never
  the same value and must not be confused when reading either handler.

The repo-wide fail-closed guard in `no-inline-fixtures.spec.ts` makes the
removal of mocks from the cooks handlers durable: it scans comment-stripped
handler source for fixture markers (a hardcoded `'user-1'`, a `mock*`-named
binding, an inline typed-array literal, hardcoded decimal telemetry) and fails
the build if any non-allowlisted handler — the cooks handlers are deliberately
**not** on the allowlist — carries one. `devices/get-devices.ts` and
`temperatures/get-current.ts` remain allowlisted pending MG-80/MG-79.

## Consequences

- A green health check can no longer diverge from the path a cooks request
  takes: both go through `getCosmosAdapter()`, the same client, the same
  credential, the same database, the same container.
- An unconfigured Function App fails loudly on the first request that reaches
  Cosmos (cook route: a sanitized 500; health route: a 503 naming the missing
  setting's fixed code) rather than serving from an invented default or a stale
  fixture. Merely importing the handler registration path throws nothing, so an
  unconfigured app still starts and fails per-request, not at boot.
- RU cost per route was measured live in dev, not from platform metrics: on
  2026-10-02 the candidate (commit `2304e1d`) was published to the dev Function
  App and each route was exercised by authenticated requests in isolated
  minutes, with per-request charges read from the Log Analytics workspace
  `meatgeek-v2-dev-logs` from two independent sinks that agree exactly — the
  Function's own `FunctionAppLogs` lines (the handlers log `requestCharge` as
  a bare number) and the Cosmos account's `DataPlaneRequests` diagnostic
  category. Platform metrics (`TotalRequestUnits` in Azure Monitor) proved too
  coarse/sampled to attribute to a single request and were not used. Measured
  RU, one-document partition: `startCook` 8.19 RU (one Create); `listCooks`
  2.82 RU per page (one single-partition Query plus a 0 RU QueryPlan);
  `stopCook` 12.43 RU (1 RU point read plus 11.43 RU If-Match replace); a
  retried stop of an already-completed cook 1 RU (point read only, no write —
  live confirmation of the `transitioned: false` path); a cold client's first
  request adds a one-time 2 RU metadata read. Against the 400 RU/s shared
  database offer these are roughly 140 list pages/s, 48 starts/s, or 32
  stops/s before IoT ingest is accounted for; `listCooks` cost will grow with
  page size and document count, so re-measure when cooks carry real history.
  MG-37 (Application Insights emitting no telemetry from the Flex Consumption
  app) is why the `requestCharge` log line matters at all, but App Insights is
  not the only log path available — `FunctionAppLogs` via the diagnostic
  setting works, which is how this measurement was taken.
- `environment.ts` / `environment.production.ts` keep the V1 `|| 'meatgeek'`
  fallback and the `connectionString` field untouched by this ticket; they are
  dead code on the cooks path (which never imports them) but remain live for
  whatever still reads them, and MG-55 owns reconciling or removing them.
- The `no-inline-fixtures.spec.ts` allowlist is a shared, shrinking artifact
  across MG-79/80/81/82; a future ticket that migrates `devices` or
  `temperatures` onto real persistence removes its line rather than leaving a
  stale allowlist entry that could mask a future re-mock.
- The live dev proof (AC11) ran on this same build: a write, a separate
  partition-scoped read, a stop, and a final read-back, all under one Entra
  principal, with a request-supplied `userId` query parameter ignored and an
  unauthenticated list returning 401.

### Honest boundary

- **Legacy V1 cook `userId`s are NOT reconciled to the Entra `"<tid>:<oid>"`
  namespace.** Any cook persisted under the old `user-1`-style tenant (or any
  other pre-Easy-Auth identity scheme) is invisible to this partition model —
  it simply lives in a partition no authenticated principal will ever compute.
  MG-81 owns that mapping and must land **before** any legacy import or any
  production activation of this ticket's code path; this ADR does not claim
  that mapping exists.
- **The request-supplied `deviceId` used for SignalR delivery scope is
  unauthorised.** `start-cook.ts` takes `body.deviceId` straight from the
  request body to both persist on the cook and address the SignalR user group;
  nothing here verifies the caller actually owns that device. MG-83 (depends on
  MG-80, devices onto real persistence) owns closing that gap. Until it lands, a
  caller can address SignalR delivery at any `deviceId` it names.
- **`POST /cooks` (`start-cook.ts`) is not retry-idempotent.** A client retry
  after a timed-out-but-succeeded write creates a second `Cook` document with a
  new `id` (`cook-${Date.now()}`), not a no-op. MG-84 owns making the route
  idempotent.
- **Responses currently include Cosmos system properties.** `createCook`,
  `getCook`/`stopCook`, and `listCooksByUser` all return the Cosmos SDK's
  `response.resource` (or query results) unprojected, so fields like `_rid`,
  `_self`, `_etag`, and `_ts` reach the wire alongside the `Cook` shape. MG-85
  owns projecting responses down to the `@meatgeekv2/api-interfaces` contract.
