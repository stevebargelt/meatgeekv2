# The active cook reaches the Pi as IoT Hub device twin state, and live temperatures reach clients by push through Event Hub, a Function and SignalR in Serverless mode

- **Status:** Accepted
- **Date:** 2026-11-19 (the owner's decision); implemented 2026-11-20.
- **Ticket:** goal HAR-55, implemented by HAR-56 to HAR-68:
  HAR-56 (#90), HAR-57 (#91), HAR-58 (#92, #93), HAR-59 (#95), HAR-60 (#94),
  HAR-61 (#96), HAR-62 (#97), HAR-63 (#98), HAR-64 (#99), HAR-65 (#100),
  HAR-66 (#101), HAR-67 (#102), HAR-68 (#103). Recorded by HAR-69.
- **Scope:** `apps/data-pusher` (`internal/iothub/twin.go`,
  `internal/cooksession`, `cmd/main.go`), `apps/api` (`functions/cooks`,
  `shared/iothub`, `functions/signalr`, `shared/signalr`),
  `apps/infrastructure` (the twin-writer grant, the `api-broadcast` consumer
  group, `IOTHUB_SERVICE_HOSTNAME`, SignalR `Serverless`, prod sizing), and the
  live acceptance proofs in `apps/api/acceptance/proofs/`. The architecture
  model in `docs/architecture/likec4/` describes the result.

## Decision 1 — the active cook is device state, carried by IoT Hub device twin desired properties

The API writes the device's active cook into the device twin's desired
properties (`activeCookId`, `correlationId`). The data-pusher on the Pi reads
the whole twin on every connect, applies each desired patch in `$version`
order, persists the result to `cooksession`, and reports `activeCookId`,
`correlationId` and `appliedDesiredVersion` back as reported properties. The
twin shares the telemetry MQTT connection, because IoT Hub allows one per
device.

**Why.** A twin persists. A Pi that is offline when the cook starts gets the
cook when it reconnects, without anyone resending it. The reported properties
acknowledge it: the cloud can read which desired version the device applied.
The `device twin` acceptance proof shows this live, with the simulated device
offline when the cook starts.

**Alternatives considered:**

- **A SignalR message to the Pi** (the previous design). A message sent while
  the Pi is offline is lost, and nothing acknowledges it. The Pi's SignalR
  client never worked live: it posted negotiate straight to the hub URL and did
  not speak the API's negotiate handshake (MG-29), and since MG-30 cook events
  go to the owning user, not the device.
- **An IoT Hub cloud-to-device message.** It is queued only up to its TTL, so a
  Pi offline for longer misses it. It is a message, not current state, so the
  device cannot ask "what is my cook now?", and its feedback is not a queryable
  acknowledgement of what the device applied.
- **A direct method.** It needs the device online when the cook starts.
- **The Pi polling `GET /cooks`.** It needs a user-API credential on the Pi.
  The Pi has none, which is why the startup reconcile (`cooksession.Reconcile`)
  always got 401.

**Consequences:**

- Start and stop sync the desired properties to the Cosmos device lock (the
  MG-84 lock) under the twin's etag (`If-Match`), after the Cosmos write, so
  the twin follows what Cosmos stores (HAR-66).
- A failed sync answers **503 `DEVICE_TWIN_UPDATE_FAILED`**. The cook stays
  written; retrying the same request heals the twin.
- The data-pusher's startup REST reconcile, its SignalR client and the
  `SIGNALR_HUB_URL` and `API_BASE_URL` settings were removed (HAR-58).
  `cooksession` is now a restart cache whose only writer is the twin client.
- The Function App's managed identity holds **`IoT Hub Twin Contributor`** on
  the hub, where `api_device_twin_writer_enabled` is on (dev since HAR-64).

## Decision 2 — live temperatures reach clients by push: Event Hub → `broadcastTemperature` → SignalR (Serverless)

IoT Hub's `eventhub-realtime-route` copies every reading to the
`temperature-data` Event Hub. `broadcastTemperature`, an Event Hub trigger in
the API, sends each reading to the SignalR group `device-{id}` through the
SignalR output binding (HAR-60). `POST /negotiate` puts a caller in
`device-{id}` for each device it owns (HAR-57, HAR-59). Cook events go to the
owning userId. The `signalr negotiate`, `signalr live temperature` and
`signalr isolation` acceptance proofs show this live, including that a
non-owner receives nothing (HAR-63, HAR-67).

**Alternatives considered:**

- **Clients polling `GET /temperatures/current`.** Each client sees a reading
  only on its next poll, and every poll by every client costs a request and
  Cosmos RU, whether or not a new reading has arrived.
- **SignalR in Default mode.** Default mode needs a hub server, and there is
  none, so no client could connect (HAR-57). The owner approved Serverless.
- **Per-user fan-out**: look up the device's owners on every reading and send
  to each user. That is a Cosmos read per reading. `device-{id}` groups move
  the ownership check to negotiate, once per connection.
  **Reversed by HAR-81.** Group membership cost one SignalR REST call per owned
  device on every negotiate. With the acceptance owner at 98 devices, two
  negotiates in a row sent about 200 REST calls in under 2 s, and the Free_F1
  service throttled the whole instance: 429 on group adds and on client
  connects (runs 44771533751 and 44777459208; neither connection nor message
  quota was near its cap). `broadcastTemperature` now reads each device's owner
  once per batch, not once per reading, and sends to that userId; negotiate
  only mints the token.
- **Azure Web PubSub.** It offers no capability this path needs that SignalR
  lacks, and the SignalR output binding, the service and its client library
  were already in place.

**Consequences:**

- `negotiate` mints client tokens through the SignalR data-plane REST API under
  managed identity, because the negotiate binding cannot express the userId
  `"<tid>:<oid>"`.
- A user's group membership is reset on every negotiate, to exactly the devices
  it owns, so a device that changed hands drops out.
- The broadcast reads on its own consumer group, `api-broadcast`
  (`TEMPERATURE_BROADCAST_CONSUMER_GROUP`).
- Dev runs SignalR on the Free tier (`Free_F1`), which caps at 20 concurrent
  connections and 20,000 messages a day.
- Measured delay from send to a SignalR client: **18.4 s**
  (`METRIC signalr-delivery-ms 18424`, run 44673261258), one dev sample.
- Prod sizing (HAR-62): IoT Hub `S1` × 5 (2,000,000 messages a day for the
  1,728,000 a day of 100 devices at one reading every 5 s) and SignalR
  `Standard_S1` × 1 (1,000 concurrent connections, 1,000,000 messages a day
  included, overage billed rather than refused). The Pis hold no SignalR
  connection. At US pay-as-you-go list price that is $125 a month for IoT Hub
  (5 × $25) and $1.61 a day, about $49 a month, for the SignalR unit, plus $1
  per million SignalR messages above the included million a day.
- The mobile and web apps do not call `negotiate` or connect to SignalR yet.
  Their UI is outside HAR-55, so the architecture model keeps their SignalR
  edges `#decided`.
