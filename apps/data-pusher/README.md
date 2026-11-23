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

### Provisioning a Pi

A real device is set up with one command from the owner's laptop,
`apps/data-pusher/deploy/onboard-pi.sh pi@<lan ip>`. It installs the
controller and the pusher as services, enrols the device in DPS and prints its
claim code. The **[device runbook](../../docs/devices/runbook.md)** covers
onboarding, claiming, releasing and revoking. The device runs in DPS mode
(below) and needs no connection string.

### Connection string (per device)

The pusher still accepts a **device-scoped** IoT Hub connection string
(`IOTHUB_CONNECTION_STRING`). It parses the `DeviceId` out of it and refuses to
start with a hub-owner string. Onboarding no longer uses this mode, and it is
removed later in goal HAR-130. The string is a device credential: it is never
stored in Terraform state or outputs (MG-24 S1).

### DPS mode (the device's own X.509 identity)

In DPS mode the device needs no connection string and no person copies a key:
it creates its own key, which never leaves it, and a self-signed certificate,
an operator enrols that certificate as an X.509 individual enrollment in the
Azure IoT Hub Device Provisioning Service (DPS), and the device registers with
DPS and connects to the hub DPS assigns, authenticating with the certificate.
Set `MEATGEEK_DPS_ID_SCOPE` to turn it on. The connection-string mode above
stays until it is removed later in goal HAR-130.

| Variable                | Purpose                                                                 | Default |
| ----------------------- | ----------------------------------------------------------------------- | ------- |
| `MEATGEEK_DPS_ID_SCOPE` | The DPS ID scope. Set → DPS mode.                                       | (none)  |
| `MEATGEEK_DEVICE_ID`    | The device id: the certificate's CN, the DPS registration id and the IoT Hub device id (letters, digits, `-` `.` `_` `:`, at most 128). Required in DPS mode. | (none) |
| `MEATGEEK_DPS_ENDPOINT` | The DPS device endpoint                                                 | `global.azure-devices-provisioning.net` |
| `MEATGEEK_STATE_DIR`    | Where the identity and the cached assignment live                      | `/var/lib/meatgeek-pusher` (the unit's `WorkingDirectory`) |

Set **only one** of `MEATGEEK_DPS_ID_SCOPE` and `IOTHUB_CONNECTION_STRING`: with
both the pusher refuses to start and says so; with neither (and no
`--mock-iot`) it refuses as before.

**Files** under `<state dir>/identity/` (the directory is mode `0700`):

| File              | Mode   | What it is |
| ----------------- | ------ | ---------- |
| `device.key`      | `0600` | ECDSA P-256 private key, PKCS#8 PEM. Generated on the device; never logged, printed or sent anywhere. A key file with wider permissions is an error. |
| `device.crt`      | `0644` | Self-signed certificate: CN = device id, `ClientAuth`, valid from 5 minutes before creation for 5 years. This is what is enrolled. |
| `assignment.json` | `0644` | The cached DPS assignment, `{"assignedHub","deviceId","registeredAt"}`. |

Each file is written to a temporary file in the same directory and renamed (the
key and certificate are linked, so they are never replaced), so a crash never
leaves half a file. The key and certificate are created once; later runs load
them. If the stored certificate's CN is not `MEATGEEK_DEVICE_ID` the pusher
refuses to start, naming both ids: the device id must not change under an
existing key.

**`identity init`** creates the identity if there is none and prints **only**
the certificate PEM on stdout (no key, no logs), the same bytes on every run.
It is what the onboarding command reads over ssh. Run it as the service user
(`meatgeek`) so the files belong to the pusher:

```bash
meatgeek-pusher identity init --device-id meatgeek-pi-7 [--state-dir /var/lib/meatgeek-pusher]
```

`--device-id` and `--state-dir` default to `MEATGEEK_DEVICE_ID` and
`MEATGEEK_STATE_DIR`. Exit `0` printed, `1` the identity could not be created
or loaded (for example a `0644` key or a certificate for another id), `2` usage.

**At startup** the pusher loads the identity and, before connecting, uses the
cached assignment if there is one, otherwise registers with DPS over HTTPS with
the certificate as its TLS client certificate (`PUT
/<idScope>/registrations/<id>/register`, then polling the operation, honouring
DPS's `Retry-After`, default 2 s, at most 30 polls) and caches the result. It
connects over MQTT with user name `<hub>/<deviceId>/?api-version=2021-04-12`,
no password, and the certificate in the TLS handshake; no SAS token is
generated or refreshed. The collector and the queue run meanwhile, so readings
taken before the first connection are queued, not lost.

**On refusal:**

- **The hub refuses the connection as not authorised** (MQTT CONNACK 4 or 5,
  for example the device was moved to another hub): the pusher deletes
  `assignment.json`, registers with DPS once more, and reconnects to the hub DPS
  now assigns after the usual reconnect backoff.
- **DPS refuses the registration** (the enrollment is disabled, or DPS answers
  401/403 because it has no enrollment for this certificate): the pusher logs
  an error saying to enrol the certificate `identity init` prints, and keeps
  trying with the reconnect backoff (1 s doubling to 60 s), so an enrollment
  made later is picked up without a restart.
- **Anything else** (DPS unreachable, 5xx, still assigning after 30 polls) is
  logged and retried with the same backoff.

Errors name HTTP status codes and DPS `errorCode`s, never response bodies.
`simdevice` has the same DPS mode, with the same variables and the same
`simdevice identity init` (see below).

#### Claim code

A user claims a device (`POST /devices/claim`) only with a code the device
itself gives out. In DPS mode the device mints the code, keeps it on disk, and
reports only its hash in the twin; the API compares the hash of what the user
types with the reported one. Connection-string mode does none of this and
reports nothing about claims. The design is in
`learnings/decisions/har-130-device-provisioning-and-claim.md`.

- **The code:** 12 Crockford base32 symbols (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`)
  from `crypto/rand`, shown `XXXX-XXXX-XXXX`. Valid for 24 hours from minting.
- **The hash:** lowercase hex SHA-256 of
  `meatgeek-claim-v1:<deviceId>:<code without hyphens>`, the same as
  `apps/api/src/shared/devices/claim-code.ts`. Both sides test against
  `libs/api-interfaces/test-vectors/claim-code.json`.
- **Twin properties** (flat strings, in the same reported patch as the cook
  properties, so neither ever drops the other): the device reports
  `claimCodeHash`, `claimExpiresAt` (RFC 3339 UTC) and `claimGeneration`; it
  reads desired `claimGeneration` (absent = `"0"`) and `claimConsumedCodeHash`.
  It never reads desired `claimClaimantHash`.
- **The rule**, on every full twin sync and every desired patch:
  - **claimed** (the stored hash is desired `claimConsumedCodeHash` and the
    generations match): nothing changes;
  - **released** (desired `claimGeneration` differs from the stored one, as
    after the API raises it): a new code under the desired generation;
  - **at process start**, unclaimed: a new code if there is none or it has
    expired, otherwise the stored one is reported again (restoring a twin that
    lost it).

  A code that expires while the pusher runs is not replaced until the next
  start. The onboarding command restarts the service, so running it again
  always yields a valid code.

- **File:** `<state dir>/claim/claim.json` (the directory `0700`, the file
  `0600`), `{"deviceId","code","codeHash","expiresAt","generation","claimed"}`,
  written atomically and always **before** its hash is reported.
- The code never appears in a log line, a span or a telemetry message. Only
  `claim-code` prints it.

**`claim-code`** prints the current code as one JSON line. It only reads the
file: it never mints a code and never connects.

```bash
meatgeek-pusher claim-code [--state-dir /var/lib/meatgeek-pusher]
# {"deviceId":"meatgeek-pi-7","state":"unclaimed","claimCode":"7K3M-9QXR-2HTV","expiresAt":"2026-11-23T12:00:00Z"}
# {"deviceId":"meatgeek-pi-7","state":"claimed"}
# {"deviceId":"meatgeek-pi-7","state":"expired"}
```

Exit `0` for any of the three states, `1` the file cannot be read, `2` usage,
`3` there is no claim file yet (the device has not read its twin in DPS mode).
`--state-dir` defaults to `MEATGEEK_STATE_DIR`. `simdevice claim-code` is the
same; `simdevice --twin --count 0` in DPS mode mints and reports a code and
exits, and its `MEATGEEK_STATE_DIR` keeps the code between runs.

### Environment variables

| Variable                       | Purpose                                                          | Default                |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------- |
| `IOTHUB_CONNECTION_STRING`     | Device-scoped IoT Hub connection string (connection-string mode only; onboarded devices use DPS mode) | (none)                 |
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
| `SIMDEVICE_CONNECTION_STRING` (env) | Device-scoped IoT Hub connection string. The **only** source of the credential; there is no flag for it. | (required, unless DPS mode) |
| `MEATGEEK_DPS_ID_SCOPE`, `MEATGEEK_DEVICE_ID`, `MEATGEEK_DPS_ENDPOINT`, `MEATGEEK_STATE_DIR` (env) | [DPS mode](#dps-mode-the-devices-own-x509-identity), exactly as the pusher: the device's own identity under the state dir, registered with DPS. Set these **or** `SIMDEVICE_CONNECTION_STRING`, not both (both exits `2`). CI should set `MEATGEEK_STATE_DIR` to a writable directory. | (off) |
| `--count N` | Readings to send | `1` |
| `--interval D` | Go duration between sends (`500ms`, `2s`). With `--inflight` above 1, between send **starts**, so it caps the rate at one send per `D` whatever the acknowledgement latency. | `0s` |
| `--inflight N` | How many sends may await IoT Hub's QoS 1 acknowledgement at once. `1` is the pusher's own send: publish, wait for the ack, wait `--interval`, repeat. Above 1, sends are pipelined over the one MQTT connection. | `1` |
| `--twin` | Device twin mode, run through the pusher's own twin code (`iothub.WithCookTwin`) on an in-memory cook session: connect, GET the twin, apply its desired cook and report it, GET the twin again and print it (below), then send `--count` readings carrying the applied `cookId` and `correlation.id`. `--count 0` only reads the twin. | off |
| `--timeout D` | With `--twin`, how long to wait for the twin (both GETs and the report). No twin response in time exits `1`. | `30s` |
| `--start T` | With `--step`: stamp reading _i_ (0-based) `T + i × step` instead of the wall clock. `T` is RFC 3339 (`2026-11-01T06:00:07.250Z`), cut to milliseconds. Pacing is unchanged: `--interval` and `--inflight` still decide when each reading is sent. One of `--start`/`--step` without the other exits `2`. | (wall clock) |
| `--step D` | With `--start`: the gap between consecutive readings' timestamps, at least `1ms` (`5s`). | (none) |
| `--grill F` | Send grill temperature `F` (°F) on every reading in place of the synthetic curve, so a reader can tell this run's readings from older ones (the live browser proof, HAR-99). Must be a finite number; otherwise exits `2`. | (synthetic, near 225) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (env) | Export spans, as for the pusher | (no-op) |

`simdevice identity init --device-id <id> [--state-dir <dir>]` is the
pusher's `identity init`: it prints only the certificate PEM, the same bytes on
every run.

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
make test                 # full suite, with the race detector (go test -race)
```

Tests wait on events, never on the wall clock: no `time.Sleep`, no
`time.After` deadline, no `context.WithTimeout` around a wait.

- `internal/await` — `await.Until(t, what, cond, state, sources...)`
  re-checks `cond` each time a source signals a change. A source is anything
  with `Changed() <-chan struct{}`; embed `await.Signal` to make one. The only
  bound is the test binary's `-timeout`: just before `t.Deadline()` the wait
  fails, naming what it waited for and the last state it saw.
  `await.Context(t)` is a context for product calls that block until their
  context is done.
- `internal/clock` and `internal/clock/clocktest` — code that times itself
  (backoff, refresh, timeouts) takes a `clock.Clock`, `clock.Real()` in
  production: the IoT Hub client through `iothub.WithClock`, simdevice through
  `simdevice.Env.Clock` (its `--interval` gap, `--twin` timeout and send
  timeout). `clock.WithTimeout` is `context.WithTimeout` on a `Clock`. Tests
  pass `clocktest.New(start)`, whose timers fire only on `Advance`. The fake
  is an `await.Source`, so a test can wait until the code has reached a timer
  (`Pending()`) before advancing past it.
- `internal/iothub/iothubtest` — the fake IoT Hub is an `await.Source` that
  signals every connection, packet and twin change.

## Deployment

### Service units and install

Install a Pi with `deploy/onboard-pi.sh`, from the owner's laptop. The
[device runbook](../../docs/devices/runbook.md) has the steps. It installs
these files from `deploy/`:

| File                          | Installed as                                      |
| ----------------------------- | ------------------------------------------------- |
| `meatgeek-controller.service` | `/etc/systemd/system/meatgeek-controller.service` |
| `meatgeek-pusher.service`     | `/etc/systemd/system/meatgeek-pusher.service`     |
| `99-meatgeek.rules`           | `/etc/udev/rules.d/99-meatgeek.rules`             |

Both units run as the system user `meatgeek` with `Restart=on-failure`. The
pusher's unit is `After=` and `Wants=` the controller. It gets
`/var/lib/meatgeek-pusher` (mode `0700`) from `StateDirectory=`. It reads
`/etc/meatgeek-pusher/env` (mode `0640`, `root:meatgeek`), which holds
`MEATGEEK_DPS_ID_SCOPE`, `MEATGEEK_DEVICE_ID`, `MEATGEEK_STATE_DIR` and
`DEVICE_URL`, and no secret. `deploy/README.md` describes the scripts.

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
  or wrong mode. The unit runs as `meatgeek`; the file should be
  `root:meatgeek` / `0640`. Run `deploy/onboard-pi.sh` again to rewrite it.
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
