# SignalR Cook-Events — End-to-End Smoke-Test Runbook (MG-14 AC5)

> **Status: BLOCKED on MG-24 bootstrap.** This is a **manual, operator-run**
> acceptance procedure that lives **outside** CI — mirroring the live-operator
> steps documented for MG-21 / MG-23 / MG-25. It cannot run until the MG-24
> greenfield SignalR Service + Function App are live in the target environment.
> **AC5 is deferred:** no automated CI assertion covers the end-to-end SignalR
> cook-event path. Until an operator runs this runbook against a live
> environment, the producer→consumer→telemetry chain is verified only by unit
> tests on each side (`apps/api/src/functions/signalr/*.spec.ts`,
> `apps/api/src/functions/cooks/*.spec.ts`, and
> `apps/data-pusher/internal/signalr/client_test.go`) — **not** end to end.

This runbook proves the MG-14 producer wiring against a real Azure SignalR
Service: an authenticated cook-start emits `cook_started`, the Go data-pusher
consumes it and sets the active cook id, subsequent telemetry carries that cook
id, and a cook-stop clears it again.

It is grounded in the shipped code on branch
`build/mg-14-signalr-cook-events` (commit `d243beb`):

- **Producer (API):** `apps/api/src/functions/signalr/negotiate.ts`,
  `apps/api/src/functions/signalr/envelope.ts`,
  `apps/api/src/functions/cooks/start-cook.ts`,
  `apps/api/src/functions/cooks/stop-cook.ts`, and the registrations in
  `apps/api/src/main.ts`.
- **Consumer (data-pusher):** `apps/data-pusher/internal/signalr/` and
  `apps/data-pusher/cmd/main.go`.

---

## ⚠️ Read this first — Known reconciliation

Three decisions from MG-14 mean the "happy path" below **will not work
unmodified on the first pass**. Validate/reconcile these before or during the
live run — do not treat a failure here as a regression.

### DEC-1 — negotiate handshake mismatch (**validate/fix FIRST**; tracked as MG-29)

The producer and consumer do **not** yet agree on the negotiate contract:

- **Producer** (`negotiate.ts`) returns the Azure SignalR Service
  `SignalRConnectionInfo` shape — `{ url, accessToken }` — resolved by the
  Functions `signalRConnectionInfo` **input binding**. `url` is an absolute URL
  to the SignalR Service and `accessToken` is the JWT the client must present
  when it dials.
- **Consumer** (`apps/data-pusher/internal/signalr/protocol.go` →
  `negotiateResponse`, and `client.go` → `negotiate()`) expects the self-hosted
  ASP.NET-style shape — `{ connectionId }` — and then dials the WebSocket
  **tokenless**, appending only `?id=<connectionId>`. It hard-errors with
  `negotiate response missing connectionId` against the producer's response.

**This is the first thing to validate and fix during the live pass.** The Go
client must be adapted to consume `{ url, accessToken }` and dial the returned
`url` with the `accessToken`. Tracked as **MG-29**
(`backlog/stories/MG-29-*.md`). Until MG-29 lands, the consumer cannot complete
negotiate against the real Function App and the rest of the procedure is
gated on it.

### DEC-3 — `start-cook` / `stop-cook` are still mocks (persistence pending)

`start-cook.ts` mints a mock cook (`id: cook-${Date.now()}`, `userId: 'user-1'`
hard-coded — see the `TODO: Extract from auth token`) and `stop-cook.ts`
returns a mock completed cook. **Neither writes durable state.** Consequences
for this smoke test:

- The `cookId` from `cook_started` is real on the SignalR wire and is correctly
  consumed by the pusher, **but it will not appear in `GET /cooks`
  (`list-cooks`)** and **will not be recoverable by
  `cooksession.Reconcile`** — there is nothing persisted for Reconcile to read
  back. Do not assert the started cook via the list/reconcile path.
- Verification of the started/stopped cook id must be done **on the SignalR
  event and on the outbound telemetry**, not via the API's read side.

### DEC-4 — negotiate trusts a `deviceId` query param, not the caller's identity (tracked as MG-30)

`negotiate.ts` binds the SignalR user group to `userId: '{query.deviceId}'` —
the per-device fan-out group is taken from the **`deviceId` request query
param**, not from the authenticated Entra identity. The caller is authenticated
at the platform layer (Easy Auth), but **device ownership is not bound to the
caller**: a caller could negotiate for a `deviceId` they do not own. This is a
known authz gap, **not** a bug to fix inside this smoke test. Hardening is
tracked as **MG-30** (`backlog/stories/MG-30-*.md`).

---

## Prerequisites

An **away-operator bootstrap** must have stood up the MG-24 greenfield
environment. None of this can be created by CI — see
[bootstrap-runbook.md](../infrastructure/bootstrap-runbook.md).

- [ ] **SignalR Service (greenfield, live).** Provisioned by MG-24 Terraform;
      access is **identity-based** (no access keys). The Function App reaches it
      via `AzureSignalRConnectionString` configured in the **serviceUri /
      managed-identity** form (e.g.
      `Endpoint=https://<signalr>.service.signalr.net;AuthType=azure.msi;...`),
      **not** an `AccessKey=` connection string. The hub name is
      **`temperatureHub`** and the connection-string **app-setting name** is
      **`AzureSignalRConnectionString`** — both are defined once in
      `envelope.ts` (`HUB_NAME`, `SIGNALR_CONNECTION_SETTING`) and the platform
      config must match those exact names.
- [ ] **Function App (greenfield, live)** with the MG-14 functions deployed:
      `negotiate`, `startCook`, `stopCook` (confirm in `main.ts`). The Function
      App's managed identity must hold the **SignalR App Server** role on the
      SignalR Service so the output/input bindings can mint tokens.
- [ ] **Easy Auth (Entra) enabled** on the Function App
      (`auth_settings_v2` / `active_directory_v2`, `require_authentication =
      true`, `unauthenticated_action = Return401`). At the Functions runtime the
      MG-14 HTTP triggers are `authLevel: 'anonymous'` **on purpose** (see the
      AC4 note in `main.ts`) — auth is enforced by the platform **before** any
      function runs, not by a per-function key. See
      [authentication.md](./authentication.md).
- [ ] **Entra API registration** exposing the delegated scope
      **`api://<api-app-id>/access_as_user`**, with the Function App's
      `allowed_audiences` set to the API App ID URI (`api://<api-app-id>`).
      Created by the MG-24 bootstrap, not by this runbook.
- [ ] A **data-pusher** build able to reach the Function App, configured with
      `SIGNALR_HUB_URL` and (optionally) `API_BASE_URL` — see
      [Negotiate wiring](#negotiate-wiring) below.
- [ ] A **device id** (`<deviceId>`) that both the pusher and the cook-start
      request will use. The pusher's device id is sourced from its IoT Hub
      connection string (or `--mock-device-id` under `--mock-iot`); the same id
      must be passed as `deviceId` in the cook-start body and on the negotiate
      query so both sides land in the same SignalR user group.

---

## Procedure

Throughout, `<funcapp>` is the Function App hostname
(`https://<funcapp>.azurewebsites.net`), `api` is the Functions route prefix
(the endpoints register as bare routes `negotiate`, `cooks`,
`cooks/{cookId}/stop`, served under `/api`), and `<deviceId>` is the shared
device id.

### 1. Acquire an Entra bearer token

```bash
export APP_ID_URI="api://<api-app-id>"
export BEARER="$(az account get-access-token \
  --scope "${APP_ID_URI}/access_as_user" \
  --query accessToken -o tsv)"
```

Every request below sends `Authorization: Bearer ${BEARER}`. A request without
it (or with a wrong-audience token) must be rejected by Easy Auth with **401**
before the function runs — a quick way to confirm the platform gate is live.

### 2. Start the data-pusher consumer and confirm it connects

Run the pusher with `SIGNALR_HUB_URL` pointed at the Function App (see
[Negotiate wiring](#negotiate-wiring)) and watch its logs. On a healthy
connection it completes negotiate + the SignalR JSON-protocol handshake and
begins reading. If DEC-1 is unresolved you will instead see the reconnect loop
log `negotiate response missing connectionId` on every attempt — **stop and
resolve MG-29 before continuing.**

> If `SIGNALR_HUB_URL` is empty the pusher runs **without** the SignalR
> consumer and `cooksession.Reconcile` is the sole cook-id authority (see the
> startup log line in `cmd/main.go`). For this smoke test the hub URL **must**
> be set.

### 3. Start a cook — observe `cook_started`

```bash
curl -sS -X POST "https://<funcapp>/api/cooks" \
  -H "Authorization: Bearer ${BEARER}" \
  -H "Content-Type: application/json" \
  -d '{"name":"AC5 smoke","deviceId":"<deviceId>","meatType":"brisket"}'
```

Expected — response is **HTTP 201** with the mock cook body, including
`id: cook-<epoch-ms>` and `status: "active"`. On the SignalR side, `startCook`
emits a message with `target: cook_started` scoped to `userId = <deviceId>`, and
the envelope carries `cookId = <the new cook id>` (see `buildCookEnvelope` —
`cookId` is **present** on `cook_started`).

Confirm on the **pusher**: its SignalR consumer goroutine receives the event and
calls `cooksession.SetActiveCookID(<new cookId>)` — log line
`cooksession: set active cook id  cookId=cook-<epoch-ms>`. The correlation id
from the envelope is also latched into the pusher's correlation holder.

### 4. Observe the cook id ride on outbound telemetry

After the active cook id is set, the pusher's enqueuer stamps
`cooksession.ActiveCookID()` onto every `TemperatureReading` it maps
(`wire.MapV1ToTemperatureReading(..., sess.ActiveCookID())`).

> **Precision note (verify against reality, do not assume):** in the shipped
> code the active **`cookId` is a field inside the `TemperatureReading`
> payload body** (`json:"cookId"`), **not** a standalone IoT Hub message
> property. The IoT Hub **message properties** the publisher stamps are
> **`messageId`** (`iothub.MessageIDPropertyName = "messageId"`) and, when a
> correlation id is present, **`correlation.id`**
> (`iothub.CorrelationIDPropertyName = "correlation.id"`) — the latter carrying
> the correlation id propagated from the `cook_started` envelope. Verify the
> cook id in the **telemetry payload** and the correlation id in the **message
> properties**; do not expect a `cookId` message property.

Confirm the new `cookId` appears in the reading payloads published to IoT Hub
after step 3 (and the SignalR-propagated `correlation.id` on the message
properties).

### 5. Stop the cook — observe `cook_stopped` and a cleared session

```bash
curl -sS -X POST "https://<funcapp>/api/cooks/<cookId>/stop" \
  -H "Authorization: Bearer ${BEARER}" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"<deviceId>"}'
```

Expected — response is **HTTP 200** with the mock completed cook
(`status: "completed"`, `endTime` set). On the SignalR side, `stopCook` emits
`target: cook_stopped` scoped to `userId = <deviceId>`, and the envelope
**omits** `cookId` entirely (`buildCookEnvelope` drops the key on `cook_stopped`
so it serializes absent, matching the Go consumer's `json:"cookId,omitempty"`
nil expectation).

Confirm on the **pusher**: the consumer treats `cook_stopped` as "clear the
active cook regardless of envelope contents" and calls
`cooksession.SetActiveCookID(nil)` — log line
`cooksession: cleared active cook id`. Telemetry mapped after this point
serializes with `cookId` **absent** again.

> **Timing tolerance (by design).** There is a brief window between the cloud
> emitting `cook_stopped` and the pusher observing it where a reading may still
> carry the old cook id. `TemperatureReading` consumers treat the cook id as
> informational and tolerate this; the pusher does not block telemetry to wait
> for reconciliation. See the package doc in
> `apps/data-pusher/internal/cooksession/store.go`.

---

## Negotiate wiring

The Go consumer derives its negotiate and WebSocket URLs from the single
`SIGNALR_HUB_URL` value (flag `--signalr-hub-url`, env `SIGNALR_HUB_URL`):

- `negotiate()` (via `buildNegotiateURL`) trims any trailing slash on the hub
  URL's path, appends **`/negotiate`**, and adds **`negotiateVersion=1`** —
  **preserving any existing query string**.
- The producer's `negotiate` handler **requires** a `deviceId` query param and
  returns **400 `VALIDATION_ERROR`** (`Missing required query parameter:
  deviceId`) without it.

Therefore `SIGNALR_HUB_URL` **must carry `?deviceId=<id>`** so it rides through
to the producer's negotiate call. Set the hub URL to the Functions route-prefix
base with the device id attached:

```bash
export SIGNALR_HUB_URL="https://<funcapp>.azurewebsites.net/api?deviceId=<deviceId>"
```

The consumer then POSTs
`https://<funcapp>.azurewebsites.net/api/negotiate?deviceId=<deviceId>&negotiateVersion=1`.
The `deviceId` on this query is what places the negotiated connection into the
per-device SignalR user group (`userId: '{query.deviceId}'` in `negotiate.ts`) —
the same group `startCook` / `stopCook` target with `userId = <deviceId>`. It is
also the DEC-4 authz surface (see above).

> Because Easy Auth gates the Function App, the negotiate POST must also carry
> the Entra bearer. Wiring the pusher's negotiate `HTTPClient` to attach that
> token is part of the DEC-1 / MG-29 adaptation.

---

## Exit criteria

AC5 is satisfied for a given environment when an operator has, against **live**
MG-24 infrastructure, observed **all** of:

1. A bearer-authenticated `POST /api/cooks` returns 201 and the pusher logs
   `cooksession: set active cook id` with the returned cook id.
2. Outbound telemetry payloads carry that cook id (and message properties carry
   the propagated `correlation.id`).
3. A bearer-authenticated `POST /api/cooks/<cookId>/stop` returns 200 and the
   pusher logs `cooksession: cleared active cook id`.
4. Telemetry after the stop serializes with `cookId` absent.

Until then, AC5 remains **deferred/blocked** and is **not** asserted by CI.
Record the run evidence (request/response transcripts + pusher log excerpts)
with the MG-14 acceptance notes. Any DEC-1 adaptation made to get here belongs
to **MG-29**; the DEC-4 identity binding belongs to **MG-30**.
