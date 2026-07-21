# MeatGeek Data Pusher Service

The IoT integration service for the MeatGeek V2 system, responsible for collecting temperature data from the device controller and pushing it to Azure IoT Hub.

## Overview

This Go service runs on the Pi alongside the device controller and acts as the
local-to-cloud bridge:

- **Polls device controller**: fetches temperature + hardware status from the local HTTP API every 5s (configurable).
- **V1 -> V2 wire translation**: the api-interfaces integration boundary lives here, in the pusher. The device controller continues to emit its legacy V1-shaped JSON over local HTTP port 3000; the pusher translates it to the V2 `TemperatureReading` and `DeviceStatus` shapes from `@meatgeekv2/api-interfaces` before publishing.
- **Cook session state**: in-memory active cook id (restart-cached to disk; reconciled against the V2 API on boot).
- **IoT Hub publish**: MQTT over TLS, per-device connection string, deterministic message IDs.
- **Local buffering**: disk-backed FIFO queue persists outbound payloads across restarts and network outages. Replay-on-reconnect with at-least-once semantics (sink-side upsert via the deterministic `messageId`).
- **SignalR consumer**: receives cook start/stop notifications from the cloud (optional — pusher falls back to API reconciliation if no hub URL is configured).
- **OpenTelemetry**: tracing skeleton in place; Azure Monitor exporter wiring + trace propagation across IoT Hub is ticket #6's scope.

## Architecture

```
Device Controller (V1 HTTP API) ──┐
                                  │  poll, V1->V2 translate, enrich w/ cookId
                                  ▼
                          ┌──────────────┐         ┌──────────────────┐
                          │ Data Pusher  │ ◄──────►│ SignalR (V2 hub) │
                          │              │  cook   └──────────────────┘
                          │  on-disk     │  events
                          │  FIFO queue  │
                          └──────┬───────┘
                                 │  MQTT/TLS, QoS 1
                                 │  msg properties:
                                 │    messageId (deterministic)
                                 │    correlation.id (#6 finalizes name)
                                 ▼
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
| `POLL_INTERVAL`                | Polling interval                                                 | `5s`                   |
| `DEBUG`                        | Enable debug logging                                             | `false`                |
| `MOCK_IOT`                     | Use mock IoT Hub (development only)                              | `false`                |
| `APPLICATIONINSIGHTS_CONNECTION_STRING`| Application Insights connection string (used by ticket #6)       | (none)                 |

All variables can be overridden as CLI flags (`--device-url`, `--poll-interval`, etc.).

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

Every published message carries two IoT Hub properties:

- `messageId` — deterministic id minted from `(deviceId, timestamp, sequence)`. The sequence is persisted in the queue so the id stays unique across restarts. Sink-side consumers should upsert on `messageId` (the IoT Hub built-in dedupe window is per-connection only).
- `correlation.id` — placeholder name for the cross-service correlation id propagation. **The exact property name + propagation contract is finalized in ticket #6**; the constant is defined in a single place (`internal/iothub`) so the rename is one-touch. Do not depend on the literal `correlation.id` name from downstream code yet.

## Development

### Prerequisites
- Go 1.21+
- Make
- Running device controller (for integration testing)

### Building

```bash
make build       # native architecture
make build-arm   # ARM64 cross-compile for Raspberry Pi
```

> Note: `nx build data-pusher` and `nx build-arm data-pusher` may fail because
> of the workspace ESLint config bug tracked in ticket #8. Use direct
> `make build` / `make build-arm` as the documented workaround until #8 lands.

### Local development server

```bash
make dev
```

Runs the pusher against `http://localhost:3000` with the mock IoT Hub client
(no Azure required) and debug logging on.

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

Plus IoT Hub message properties: `messageId`, `correlation.id`.

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
# nx build / nx build-arm currently blocked by #8 — use make targets directly.
```

## Roadmap (other tickets)

- **#6** — OpenTelemetry Azure Monitor exporter + cross-service trace
  propagation across the IoT Hub seam. Will finalize the `correlation.id`
  property contract.
- **#8** — Workspace ESLint config repair so `nx build data-pusher` works.
- **#11** — Rename the Go module path from `meatgeek-pusher` to the
  workspace convention.
