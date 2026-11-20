# MeatGeek Data Pusher Service

The IoT integration service for the MeatGeek V2 system, responsible for collecting temperature data from the device controller and pushing it to Azure IoT Hub.

## Overview

This Go service runs on the Pi alongside the device controller and acts as the
local-to-cloud bridge:

- **Polls device controller**: fetches temperature + hardware status from the local HTTP API every 5s (configurable).
- **V1 -> V2 wire translation**: the api-interfaces integration boundary lives here, in the pusher. The device controller continues to emit its legacy V1-shaped JSON over local HTTP port 3000; the pusher translates it to the V2 `TemperatureReading` and `DeviceStatus` shapes from `@meatgeekv2/api-interfaces` before publishing.
- **Cook session state**: the active cook id and correlation id, plus the twin desired `$version` they came from (`internal/cooksession`, restart-cached to disk so a boot with no network still stamps the last cook).
- **IoT Hub publish**: MQTT over TLS, per-device connection string, deterministic message IDs.
- **Local buffering**: disk-backed FIFO queue persists outbound payloads across restarts and network outages. Replay-on-reconnect with at-least-once semantics (sink-side upsert via the deterministic `messageId`).
- **Device twin**: the active cook arrives as IoT Hub device twin desired properties over the same MQTT connection. The pusher connects at startup and stays connected, reads the whole twin on every (re)connect, applies desired patches as they arrive, and reports what it applied. A twin persists, so a Pi that was offline when a cook started gets it when it reconnects. See [Device twin](#device-twin-active-cook).
- **OpenTelemetry**: tracing skeleton in place; Azure Monitor exporter wiring + trace propagation across IoT Hub is ticket #6's scope.

## Architecture

```
Device Controller (V1 HTTP API) ──┐
                                  │  poll, V1->V2 translate, enrich w/ cookId
                                  ▼
                          ┌──────────────┐
                          │ Data Pusher  │
                          │              │
                          │  on-disk     │
                          │  FIFO queue  │
                          └──────┬───────┘
                                 │  one MQTT/TLS connection:
                                 │   ▲ telemetry, QoS 1, msg properties:
                                 │   │   messageId (deterministic)
                                 │   │   correlation.id
                                 │   │ twin GET + reported patches
                                 │   ▼ twin desired (activeCookId, correlationId)
                          ┌──────────────┐
                          │ Azure IoT Hub│
                          └──────┬───────┘
                                 │
                  ┌──────────────┴──────────────┐
                  │ direct route                │ Event Hub route
                  ▼                             ▼
              CosmosDB                       Functions (real-time path,
              (storage path)                  pending — see #6)
```

## Configuration

### Connection string (per device)

The pusher requires a **device-scoped** IoT Hub connection string (it parses the
`DeviceId` out of it and refuses to start with a hub-owner string). This string
is a **device credential**: it is **retrieved on demand from IoT Hub via the
Azure CLI at provisioning time and is NEVER stored in Terraform state or exported
as a Terraform output**. The former `iot_hub_device_connection_strings` output
was removed in MG-24 S1 precisely so no device SAS key persists in state/outputs.
IoT Hub device SAS auth is the one documented key-auth exception (see the
[ADR](../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md)), so
the device legitimately needs this string — but it is minted/read straight from
the hub, not from Terraform.

Create the device identity once (idempotent — safe to skip if it already exists),
then read its connection string. The hub name is the non-secret `iot_hub_name`
Terraform output:

```bash
cd apps/infrastructure
HUB="$(terraform output -raw iot_hub_name)"
DEVICE=meatgeek3

# Create the device identity first if it does not exist yet:
az iot hub device-identity create --hub-name "$HUB" --device-id "$DEVICE"

# Retrieve the device-scoped connection string on demand (never stored in TF):
az iot hub device-identity connection-string show \
  --hub-name "$HUB" --device-id "$DEVICE" -o tsv
```

Treat the output as a secret — it carries the device SAS-signing key. Do not
capture it into Terraform state, an output, a log, or version control: read it at
provisioning time and write it straight into the pusher's env file (below).

### Environment variables

| Variable                       | Purpose                                                          | Default                |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------- |
| `IOTHUB_CONNECTION_STRING`     | Device-scoped IoT Hub connection string (REQUIRED on production) | (none)                 |
| `DEVICE_URL`                   | Device controller URL                                            | `http://localhost:3000`|
| `POLL_INTERVAL`                | Polling interval for the device controller (Go duration)         | `5s`                   |
| `DEBUG`                        | Enable debug logging                                             | `false`                |
| `MOCK_IOT`                     | Use mock IoT Hub (development only; no device twin, so the cook session keeps its persisted state) | `false`                |
| `MOCK_DEVICE_ID`               | Device id used with `MOCK_IOT` (production reads it from the connection string) | `meatgeek-mock`        |
| `QUEUE_DIR`                    | Directory for the disk-backed outbound queue (falls back to `~/.meatgeek-pusher/queue` if not writable) | `/var/lib/meatgeek-pusher/queue` |
| `COOKSESSION_STATE_PATH`       | Persisted cook-session state file (falls back to `~/.meatgeek-pusher/cooksession.json` if not writable) | `/var/lib/meatgeek-pusher/cooksession.json` |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | OTLP endpoint of the OTel Collector; when set, spans export via OTLP/HTTP — no-op exporter when unset | (none)                 |

All variables can be overridden as CLI flags (`--device-url`, `--poll-interval`,
`--queue-dir`, `--cooksession-state-path`, etc.).

### Device twin: active cook

The active cook is device state, so it travels in the IoT Hub device twin
(`internal/iothub/twin.go`), over the same MQTT connection as telemetry: IoT
Hub allows one connection per device id, so a second one would knock the
telemetry connection off.

| Section  | Written by | Properties |
| -------- | ---------- | ---------- |
| desired  | the API    | `activeCookId`: string, or absent/`null` for no cook. `correlationId`: string, or absent/`null`. Plus IoT Hub's `$version`. |
| reported | the device | `activeCookId`: string or `null`. `correlationId`: string or `null`. `appliedDesiredVersion`: the desired `$version` the device applied. |

- **On every connect** (startup, a dropped connection, and the SAS-token refresh
  reconnect 5 minutes before expiry): subscribe to `$iothub/twin/res/#` and
  `$iothub/twin/PATCH/properties/desired/#` (the session is clean, so
  subscriptions do not survive a reconnect), GET the twin, apply its whole
  desired section, and report. The GET is the reconcile; there is no REST call
  to the API.
- **Desired patches** carry only changed properties (`null` removes one) and
  are merged onto the applied state, but only when their `$version` is exactly
  one more than the applied version. An older or equal version is ignored; a
  version that skips ahead means a patch was missed, so the pusher GETs the
  whole twin instead.
- **After applying**, the pusher publishes a reported patch with all three
  reported properties. A failed report (non-2xx) is logged and retried by the
  GET on the next connect.
- **State** (`cookId`, `correlationId`, `appliedDesiredVersion`) is persisted
  in `COOKSESSION_STATE_PATH` with an atomic write. Every reading takes both
  ids from one snapshot of it: `cookId` in the body and `correlation.id` as a
  message property.

### Local queue tuning

The disk-backed queue (`internal/queue`) protects against IoT Hub disconnects.
Defaults are sized for the ARM64 Pi flash budget:

| Option              | Default | Notes                                                      |
| ------------------- | ------- | ---------------------------------------------------------- |
| `MaxBytes`          | 100 MB  | Soft cap. Exceeding it drops the oldest segment and logs a warning. |
| `MaxSegmentBytes`   | 4 MB    | Rotation threshold for a single segment file.              |
| `FlushInterval`     | 2s      | Background fsync cadence.                                  |
| `FlushEveryN`       | 64      | Force fsync after N enqueues since the last sync.          |

Tune via the queue's `Options` struct in `cmd/main.go`. For long-disconnect
scenarios on devices with ample storage, raising `MaxBytes` lowers eviction
risk; for low-write devices you can stretch `FlushInterval` to reduce wear.

### IoT Hub message properties

Payload and properties are built in `internal/publish` (`ReadingPayload`,
`MessageID`, `Properties`), shared by the pusher and [`simdevice`](#simdevice-a-software-device-for-dev).
Every published message carries:

- `$.ct` = `application/json` and `$.ce` = `utf-8` — the IoT Hub content type and content encoding **system** properties (MG-68). IoT Hub stores a routed body as JSON only when both are set; without them the Cosmos route stores `Body` as a base64 string, which the API skips. On MQTT they ride in the topic property bag as `devices/{id}/messages/events/$.ct=application%2Fjson&$.ce=utf-8&…`: the `$.` keys are literal, only values are URL-encoded (`internal/iothub` `buildPublishTopic`).
- `traceparent` — W3C trace context of the per-reading publish span (absent only when no span is active).
- `messageId` — deterministic id minted from `(deviceId, timestamp, sequence)`. The sequence is persisted in the queue so the id stays unique across restarts. Sink-side consumers should upsert on `messageId` (the IoT Hub built-in dedupe window is per-connection only).
- `correlation.id` — the twin's desired `correlationId` for the active cook, when set. Placeholder name for the cross-service correlation id propagation. **The exact property name + propagation contract is finalized in ticket #6**; the constant is defined in a single place (`internal/iothub`) so the rename is one-touch. Do not depend on the literal `correlation.id` name from downstream code yet.

## Development

### Prerequisites
- Go 1.21+
- Make
- Running device controller (for integration testing)

### Building

```bash
make build       # native architecture: dist/meatgeek-pusher and dist/simdevice
make build-arm   # ARM64 cross-compile for Raspberry Pi (pusher only)
```

`npx nx run data-pusher:build` runs the same `make build`.

### Local development server

```bash
make dev
```

Runs the pusher against `http://localhost:3000` with the mock IoT Hub client
(no Azure required) and debug logging on.

### simdevice: a software device for dev

`cmd/simdevice` sends synthetic temperature readings to IoT Hub as **one
device**, so dev has a standing sender that behaves exactly like a Pi. Each
reading is a plausible `V1Status` (pit near 225°F, two probes climbing,
`smokerid` = the connection string's device id) built into a payload and
properties by the same `internal/publish` functions the pusher uses, then sent
with the pusher's MQTT client (`iothub.AzureClient`). Tracing is set up the
same way, so every message carries its own `traceparent`. It does not touch
the disk queue and sends no device status. Without `--twin` its readings carry
no cook.

```bash
make build
export SIMDEVICE_CONNECTION_STRING='HostName=…;DeviceId=…;SharedAccessKey=…'
dist/simdevice --count 3 --interval 2s
dist/simdevice --twin --count 3      # read the twin first; readings carry its cook
```

| Input | Meaning | Default |
| ----- | ------- | ------- |
| `SIMDEVICE_CONNECTION_STRING` (env) | Device-scoped IoT Hub connection string. The **only** source of the credential; there is no flag for it. | (required) |
| `--count N` | Readings to send | `1` |
| `--interval D` | Go duration between sends (`500ms`, `2s`). With `--inflight` above 1, between send **starts**, so it caps the rate at one send per `D` whatever the acknowledgement latency. | `0s` |
| `--inflight N` | How many sends may await IoT Hub's QoS 1 acknowledgement at once. `1` is the pusher's own send: publish, wait for the ack, wait `--interval`, repeat. Above 1, sends are pipelined over the one MQTT connection. | `1` |
| `--twin` | Device twin mode, run through the pusher's own twin code (`iothub.WithCookTwin`) on an in-memory cook session: connect, GET the twin, apply its desired cook and report it, GET the twin again and print it (below), then send `--count` readings carrying the applied `cookId` and `correlation.id`. `--count 0` only reads the twin. | off |
| `--timeout D` | With `--twin`, how long to wait for the twin (both GETs and the report). No twin response in time exits `1`. | `30s` |
| `--start T` | With `--step`: stamp reading _i_ (0-based) `T + i × step` instead of the wall clock. `T` is RFC 3339 (`2026-11-01T06:00:07.250Z`), cut to milliseconds. Pacing is unchanged: `--interval` and `--inflight` still decide when each reading is sent. One of `--start`/`--step` without the other exits `2`. | (wall clock) |
| `--step D` | With `--start`: the gap between consecutive readings' timestamps, at least `1ms` (`5s`). | (none) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (env) | Export spans, as for the pusher | (no-op) |

**Stdout** carries nothing but one JSON line per message IoT Hub accepted:

```json
{"messageId":"<64 hex>","deviceId":"sim-device-1","timestamp":"2026-11-19T16:47:33.120Z","sentAt":"2026-11-19T16:47:33.402Z"}
```

With `--twin`, one line comes first, the twin as read back after the report:

```json
{"event":"twin","desired":{"activeCookId":"c1","correlationId":"r1","$version":2},"reported":{"activeCookId":"c1","correlationId":"r1","appliedDesiredVersion":2}}
```

Ids with no value are `null`. A cook started through the API while simdevice
was not running shows up here, which is the reconnect case the Pi relies on.

`timestamp` is the reading's `timestamp` in the payload (with `--start`/`--step`,
the synthetic stamp); `sentAt` is when the publish was acknowledged. Both are RFC 3339 UTC with milliseconds. Every
reading in a run has a distinct `timestamp` and `messageId`. Logs and errors go
to stderr.

With `--inflight N` above 1 a line is written when that reading's
acknowledgement arrives, so lines may come out of send order. A failed
acknowledgement is retried once with the blocking send the pusher uses
(`PublishTelemetry`); if that fails too, simdevice starts no more sends, waits
for the ones in flight, and exits `1`. On every path the number of stdout lines
equals the number of acknowledged readings. The dev acceptance top-up runs
`--inflight 32 --interval 50ms`: 20 readings/s
([live-acceptance.md](../../docs/development/live-acceptance.md)). The
cook-chart proof's one-time top-up adds `--start <cook startTime> --step 5s`, so
12 hours of readings land in a cook that started minutes ago (HAR-87).

**Exit codes:** `0` all sent; `1` a send failed, the run was interrupted, or
`--twin` got no twin response within `--timeout` —
nothing is printed for a reading that was not acknowledged; `2` usage or configuration error,
including a missing or malformed `SIMDEVICE_CONNECTION_STRING`. No output
contains the connection string or its key: parse errors never echo their
input, and every error is redacted before it is printed.

### Tests

```bash
make test                 # full suite
go test -race ./...       # with race detector
```

## Deployment

### Service unit

The systemd unit file is checked in at `deploy/meatgeek-pusher.service`. It
sets `Restart=on-failure`, `RestartSec=10`, sends stdout/stderr to journald,
orders the service `After=network-online.target meatgeek-controller.service`,
and reads secrets from an `EnvironmentFile` rather than inlining them.

### Operator install procedure (on the Pi)

1. **Provision the per-device IoT Hub connection string.** Retrieve it on demand
   from IoT Hub via the Azure CLI (`az iot hub device-identity connection-string
   show --hub-name "$(terraform output -raw iot_hub_name)" --device-id <device>`;
   create the identity first with `az iot hub device-identity create` if it does
   not exist — see "Connection string (per device)" above). It is a device
   credential fetched at provisioning time, never a Terraform output/state value.
2. **Write the secret file** (one shot, before first `make install`):

   ```bash
   sudo mkdir -p /etc/meatgeek-pusher
   sudo tee /etc/meatgeek-pusher/env > /dev/null <<'EOF'
   IOTHUB_CONNECTION_STRING=HostName=<host>;DeviceId=<id>;SharedAccessKey=<key>
   DEVICE_URL=http://localhost:3000
   EOF
   sudo chmod 600 /etc/meatgeek-pusher/env
   sudo chown root:root /etc/meatgeek-pusher/env
   ```

   The `chmod 600` is intentional — the file holds a SAS-signing key. Never
   put the connection string on an `Environment=` line (visible via
   `systemctl show` and `ps auxe`).
3. **Cross-compile and install** from a build host:

   ```bash
   make build-arm
   make deploy-to-pi PI_HOST=pi@<your-pi>
   # then on the Pi itself:
   sudo make -C apps/data-pusher install
   ```

   `make install` copies the ARM binary into `/usr/local/bin`, creates
   `/var/lib/meatgeek-pusher` (queue + cook-session state) and
   `/etc/meatgeek-pusher` (env dir), copies `deploy/meatgeek-pusher.service`
   into `/etc/systemd/system/`, then enables and starts the unit.
4. **Confirm the service is running**:

   ```bash
   make status
   make logs
   ```

### Service dependency order

```
meatgeek-controller.service   (device controller, V1 HTTP API on port 3000)
              ▼
meatgeek-pusher.service       (this service)
```

## Operator smoke test

This procedure validates the local→cloud data path **once** after install. It
requires Azure access and so is operator-scoped — **it has NOT been run from
the build pipeline. The pusher has not been verified on Pi hardware or
against live Azure as part of this change.**

```bash
# On a workstation with Azure CLI:
az login
az account set --subscription <subscription-id>

# 1. Confirm the IoT Hub sees device-to-cloud messages.
#    In the Azure portal: IoT Hub -> Metrics -> "Telemetry messages sent".
#    The chart should tick up within ~30s of the pusher coming online.

# 2. Confirm the storage path landed a document.
#    In the Azure portal: Cosmos DB account -> Data Explorer -> the
#    TemperatureReadings container -> Items. A document with deviceId =
#    <your-device-id> and a recent timestamp should be visible.

# 3. Confirm the real-time path saw the message.
#    In the Azure portal: IoT Hub -> Message routing -> the Event Hub route
#    -> "Routing endpoint health" / metrics. Expected outcome:
#    "Event Hub route received the message". (A telemetry-ingest Function
#    on the consumer end is NOT in scope yet — that's ticket #6.)
```

If step 1 fails: check the pusher journal (`make logs`) — most often it's a
connection-string problem (hub-scoped instead of device-scoped) or the env
file isn't being read. The pusher logs an actionable error on startup if the
connection-string shape is wrong (hub-scoped instead of device-scoped).

If step 1 succeeds but step 2 doesn't: the IoT Hub route configuration is
the suspect, not the pusher. See `apps/infrastructure` for the route
declarations.

## Data flow

### V1 input (from device controller)

```json
{
  "id": "...",
  "smokerid": "meatgeek3",
  "type": "status",
  "augerOn": false,
  "blowerOn": true,
  "igniterOn": false,
  "fireHealthy": true,
  "mode": "smoking",
  "setPoint": 225,
  "temps": {
    "grillTemp": 225.0,
    "probe1Temp": 160.0,
    "probe2Temp": 145.0,
    "probe3Temp": null,
    "probe4Temp": 200.0
  },
  "modeTime": "...",
  "currentTime": "2026-05-26T10:30:00Z"
}
```

NaN-valued temps in the V1 wire format mean "probe unplugged" and map to
nullable `*float64` (i.e. JSON `null`) in V2.

### V2 output (to IoT Hub)

```json
{
  "deviceId": "meatgeek3",
  "timestamp": "2026-05-26T10:30:15.123Z",
  "cookId": "cook-456",
  "grillTemp": 225.0,
  "probe1Temp": 160.0,
  "probe2Temp": 145.0,
  "probe3Temp": null,
  "probe4Temp": 200.0
}
```

Plus IoT Hub message properties: `messageId`, `$.ct`, `$.ce`, `traceparent`, and `correlation.id` when set.

## Troubleshooting

- **"connection string is not device-scoped"** — you used a hub-owner
  (`iothubowner`) string. Retrieve the **device-scoped** string instead with
  `az iot hub device-identity connection-string show --hub-name "$(terraform
  output -raw iot_hub_name)" --device-id <device-id>` (see "Connection string
  (per device)").
- **"failed to read /etc/meatgeek-pusher/env"** — file missing, wrong owner,
  or wrong mode. The unit runs as `pi`; the file should be `root:root` /
  `0600` and at the documented path.
- **Pusher running but no IoT Hub messages** — check the queue is draining
  (look for `queue: enqueued`/`queue: published` log fields). A growing
  queue with no publishes points at MQTT auth or connectivity.

## NX integration

```bash
nx test data-pusher       # calls make test
nx serve data-pusher      # calls make dev
nx build data-pusher      # calls make build (pusher + simdevice)
```

## Roadmap (other tickets)

- **#6** — OpenTelemetry Azure Monitor exporter + cross-service trace
  propagation across the IoT Hub seam. Will finalize the `correlation.id`
  property contract.
- **#8** — Workspace ESLint config repair so `nx build data-pusher` works.
