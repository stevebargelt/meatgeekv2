# SignalR Cook Events: Smoke Test

This runbook proves, against a deployed environment, that a signed-in client
can open a SignalR connection through `POST /negotiate` and receives
`cook_started` and `cook_stopped` for its own cooks.

The automated half runs on every dev deploy:
`apps/api/acceptance/proofs/signalr-negotiate.proof.ts` calls `POST /negotiate`
and opens a connection with the returned url and token (see
[Live Acceptance Suite](../development/live-acceptance.md)). The steps below add
what the proof does not: receiving the cook events.

## How delivery is scoped (HAR-57, MG-30)

Clients receive SignalR messages. The Raspberry Pi does not: it gets its active
cook from the IoT Hub device twin.

- **`POST /negotiate`** takes no parameters. The caller is the Easy Auth
  principal, and its SignalR user id is the principal's `userId`,
  `"<tid>:<oid>"`. The handler:
  1. mints a 60-minute client access token for that user id through the
     SignalR data-plane REST API (`POST /api/hubs/temperatureHub/:generateToken`,
     api-version `2024-12-01`) under the Function App's managed identity;
  2. returns `200 { url, accessToken }`. `url` is
     `https://<signalr>.service.signalr.net/client/?hub=temperatureHub`.

  It reads no devices and manages no groups (HAR-81): every message is sent to a
  user id, so the token is all a connection needs.

  A `deviceId` query parameter is ignored. With no principal the answer is
  `401` and no SignalR call is made. If a SignalR call fails the answer is
  `503 { error: "SIGNALR_UNAVAILABLE", reason }`. `reason` is a fixed code that
  names the failed call and, when the service answered, its status, for
  example `signalr_generate_token_status_429`. Neither the body nor the log
  carries the endpoint, a user id or a token. The live acceptance proof prints
  `reason` when negotiate fails.

- **`cook_started` and `cook_stopped`** are sent by `startCook` and `stopCook`
  through the Functions SignalR output binding with `userId` set to the
  authenticated principal's `userId`, the cook's owner. Both handlers check
  device ownership (HAR-26) before any write or event. The envelope is
  unchanged: `type`, `timestamp`, `messageId`, `deviceId`, `userId`, `cookId`
  (on `cook_started` only), `correlation.id` and the cook as `payload`.
- **`temperature`** readings are sent by `broadcastTemperature` with `userId`
  set to the device's stored owner (HAR-81).

## How the Pi gets its cook: the device twin (HAR-66)

The Pi does not listen to SignalR. `startCook` and `stopCook` write the active
cook into the device's IoT Hub twin, as desired properties, and data-pusher
reads them (HAR-58). The twin persists, so a Pi that was offline gets the cook
when it reconnects.

- **Contract.** `desired.activeCookId` and `desired.correlationId` are strings
  or absent. The API sends `null` for "absent", which IoT Hub turns into a
  deleted property. The Pi reports `activeCookId`, `correlationId` and
  `appliedDesiredVersion`; the API does not read them.
- **When.** After the Cosmos write: on a 201 start, on a 200 replay of the same
  start, and on every 200 stop, whether or not that call made the transition.
  Never on 400, 401, 403, 404, 409, 422 or 500.
- **What.** The twin follows the device's active cook in Cosmos, not the
  request: the MG-84 device lock and the non-terminal cook it names (two point
  reads). With no active cook both properties are removed. With an active cook
  that the twin already names, the twin's `correlationId` is kept. Otherwise
  the twin gets the cook id and this request's correlation id (`X-Request-ID`,
  else the invocation id).
- **How.** `GET /twins/{id}`, then the Cosmos read, then, only if the twin
  differs, `PATCH /twins/{id}` with `If-Match` on the etag just read, against
  `https://${IOTHUB_SERVICE_HOSTNAME}` (api-version `2021-04-12`) with a
  managed identity token for `https://iothubs.azure.net/.default`. After a
  PATCH the active cook is read again; if it changed, or the PATCH got 412, the
  whole attempt repeats, up to 3 attempts. So a late retried stop of cook A
  after cook B started leaves B, and a slow start that lost to a stop does not
  bring its cook back.
- **No twin.** A device with no IoT Hub identity has no twin (`GET` answers
  404). There is nothing to sync and the normal status is returned. Dev's
  acceptance devices are like this.
- **Failure.** If the twin update fails, the cook write stands and the answer is
  `503 { error: "DEVICE_TWIN_UPDATE_FAILED", message, cookId, reason,
  requestId }`. `reason` is a fixed code such as `iothub_patch_twin_status_403`;
  it never names the hub, the device or a token. Resend the same request:
  a start replays (200) and a stop finds the cook completed, and both sync the
  twin again. `cook_started` is still emitted when the failed call created the
  cook, and `cook_stopped` when it completed it.
- **Prod.** The identity's `IoT Hub Twin Contributor` grant is on in dev only
  (`api_device_twin_writer_enabled`). Without it every twin call is refused,
  so in prod a start or stop answers 503 with the cook still written.

The code is `apps/api/src/shared/iothub/device-twin.ts` (the REST client),
`apps/api/src/shared/iothub/device-twin-sync.ts` (the sync) and
`apps/api/src/functions/cooks/device-twin-step.ts` (the handlers' 503).

The code is `apps/api/src/functions/signalr/negotiate.ts`,
`apps/api/src/shared/signalr/signalr-management.ts`,
`apps/api/src/functions/signalr/envelope.ts`, and the two cook handlers in
`apps/api/src/functions/cooks/`.

## Prerequisites

- The SignalR Service is reachable by the Function App identity-based: the app
  setting `AzureSignalRConnectionString__serviceUri` holds the service URI, and
  the Function App identity holds **SignalR Service Owner**. Local (key) auth is
  disabled on the service.
- The service runs in **Serverless** mode (HAR-57): there is no hub server, so
  in Default mode no client could connect and nothing sent to a user was
  delivered. No upstream is configured.
- An Entra bearer token for the API, scope `api://<api-app-id>/access_as_user`
  (see [authentication.md](./authentication.md)).
- A device that caller owns, claimed with the code it shows
  (`POST /devices/claim`; there is no `POST /devices`, HAR-145).
- Node 20 or later and this repository's `node_modules` (for
  `@microsoft/signalr`).

## Procedure

`<funcapp>` is the Function App hostname. Routes are served under `/api`.

### 1. Get a bearer token

```bash
export BEARER="$(az account get-access-token \
  --scope "api://<api-app-id>/access_as_user" \
  --query accessToken -o tsv)"
```

A request without it is rejected by Easy Auth with `401` before any function
runs.

### 2. Negotiate

```bash
curl -sS -X POST "https://<funcapp>/api/negotiate" \
  -H "Authorization: Bearer ${BEARER}"
```

Expected: `200` with `url` and `accessToken`, and an
`x-meatgeek-request-charge` header. Adding `?deviceId=<anything>` changes
nothing.

### 3. Listen for cook events

Save as `listen.mjs` in the repository root and run
`node listen.mjs` with `FUNCAPP` and `BEARER` set. It negotiates, connects, and
prints every cook event it receives.

```js
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';

const res = await fetch(`https://${process.env.FUNCAPP}/api/negotiate`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.BEARER}` },
});
if (res.status !== 200) throw new Error(`negotiate answered ${res.status}`);
const { url, accessToken } = await res.json();

const hub = new HubConnectionBuilder()
  .withUrl(url, { accessTokenFactory: () => accessToken })
  .configureLogging(LogLevel.Warning)
  .build();
for (const event of ['cook_started', 'cook_stopped']) {
  hub.on(event, envelope => console.log(event, JSON.stringify(envelope)));
}
await hub.start();
console.log('connected; waiting for cook events');
```

### 4. Start a cook

In another terminal:

```bash
COOK_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
curl -sS -X POST "https://<funcapp>/api/cooks" \
  -H "Authorization: Bearer ${BEARER}" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"${COOK_ID}\",\"name\":\"Smoke\",\"deviceId\":\"<deviceId>\",\"meatType\":\"brisket\"}"
```

Expected: `201` with the cook, `status: "active"`. The listener prints one
`cook_started` whose envelope has `cookId` equal to `${COOK_ID}`, `deviceId`
equal to `<deviceId>`, and `userId` equal to the caller's `"<tid>:<oid>"`.

Repeating the same request answers `200` with the same cook and the listener
prints nothing new (MG-84). A device the caller does not own answers
`403 DEVICE_NOT_OWNED` and nothing is printed.

### 5. Stop the cook

```bash
curl -sS -X POST "https://<funcapp>/api/cooks/${COOK_ID}/stop" \
  -H "Authorization: Bearer ${BEARER}"
```

Expected: `200` with the cook, `status: "completed"` and an `endTime`. The
listener prints one `cook_stopped`; its envelope has no `cookId` key and
`payload.id` is `${COOK_ID}`.

### 6. Check the scoping

Run the listener as a second user who does not own `<deviceId>`, and repeat
steps 4 and 5 as the first user. The second listener prints nothing.

## Exit criteria

The path works in an environment when steps 2 to 6 behave as described. Record
the request and response transcripts and the listener output with the ticket
that ran it.
