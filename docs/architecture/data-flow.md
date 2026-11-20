# Data Flow Architecture

## Overview

MeatGeek V2 uses a **parallel processing architecture** where temperature telemetry follows two independent paths for optimal resilience, performance, and cost efficiency.

## High-Level Flow

The [`ingest`](https://stevebargelt.github.io/meatgeekv2/#/view/ingest/) and [`telemetry`](https://stevebargelt.github.io/meatgeekv2/#/view/telemetry/) views show this flow: IoT Hub routes each message both directly to Cosmos DB (storage) and to an Event Hub (real-time).

The real-time leg (Event Hub → Function → SignalR) is **on `main` since HAR-60**: `broadcastTemperature` in `apps/api` consumes the Event Hub and pushes each reading to its device's SignalR group. No app connects to SignalR yet; the acceptance proofs are the only live client.

## Detailed Data Flow

### 1. Device Layer Processing

The [`edge`](https://stevebargelt.github.io/meatgeekv2/#/view/edge/) view shows the device layer: 5 RTD readings, averaged in the Device Controller, enriched with the cookId by the Data Pusher, sent to IoT Hub.

**Device Controller (Enhanced)**:
- Reads 5 RTD sensors every 10ms
- Maintains 100-sample averaging queues
- Writes a startup banner to the LCD (the per-probe readout is commented out in `main.go`)
- Provides HTTP API for Data Pusher

**Data Pusher Service (New)**:
- Polls Device Controller every 5 seconds
- **Maintains active cook session state**
- Enriches temperature data with cookId
- Sends enriched telemetry to IoT Hub

**Temperature Message Structure**:
```json
{
  "messageType": "temperature",
  "deviceId": "meatgeek3", 
  "cookId": "cook-abc123",
  "timestamp": "2025-01-26T10:05:00Z",
  "grillTemp": 225.5,
  "probe1Temp": 160.2,
  "probe2Temp": 145.8,
  "probe3Temp": null,
  "probe4Temp": 200.1
}
```

### 2. IoT Hub Parallel Routing

IoT Hub routes each message to **two destinations simultaneously**:

#### **Route 1: Storage Path (Direct)**
```yaml
route_name: "TemperatureStorage"
source: "DeviceMessages"  
condition: "messageType = 'temperature'"
endpoint_type: "cosmosdb"
endpoint: "meatgeek-temperatures"
```

**Benefits**:
- ✅ **Guaranteed storage** - IoT Hub handles retries automatically
- ✅ **No Function overhead** - Direct path, lowest latency
- ✅ **Cost efficient** - No Function execution costs for storage
- ✅ **Always available** - Even if Functions are down

#### **Route 2: Real-time Path (Event Hub)**

**On `main` since HAR-60.** The `eventhub-realtime-route` and the `temperature-data` Event Hub are defined in `apps/infrastructure/modules/iot-hub/main.tf`; the API's `broadcastTemperature` consumes them (see [§4](#4-real-time-path-details)).

```yaml
route_name: "eventhub-realtime-route"
source: "DeviceMessages"
condition: "true"
endpoint_type: "eventhub"
endpoint: "eventhub-realtime"   # -> temperature-data
```

**Benefits**:
- ✅ **Batch processing** - Function processes multiple messages
- ✅ **Lightweight** - No database operations in Function
- ✅ **Fast execution** - Only SignalR broadcasting
- ✅ **Scalable** - Event Hub handles high throughput

### 3. Storage Path Details

See the [`data`](https://stevebargelt.github.io/meatgeekv2/#/view/data/) view. IoT Hub's `cosmos-storage-route` writes into the `temperatures` container, partitioned on `/deviceId` with the value stamped from `{deviceid}`. Readings expire by the container's `default_ttl`, set from `temperature_data_ttl_days` × 86400 s (`var.temperature_data_ttl`; 7 days in dev, 90 in prod).

**Data Organization**: IoT Hub stores its message envelope, not the bare device payload. The endpoint stamps a top-level `deviceId` from the authenticated device id (`partition_key_template = "{deviceid}"`):
```json
{
  "id": "…",
  "deviceId": "meatgeek3",
  "iothub_name": "…",
  "Body": {
    "deviceId": "meatgeek3",
    "cookId": "cook-abc123",
    "timestamp": "2025-01-26T10:05:00Z",
    "grillTemp": 225.5,
    "probe1Temp": 160.2
    // ... all temperature readings, in the data-pusher wire shape
  },
  "Properties": { "messageId": "…", "correlation.id": "corr-xyz", "traceparent": "00-…" },
  "SystemProperties": {
    "iothub-connection-device-id": "meatgeek3",
    "iothub-content-type": "application/json",
    "iothub-content-encoding": "utf-8",
    "iothub-enqueuedtime": "2025-01-26T10:05:00.123Z"
  },
  "_ts": 1737876300
}
```

`Body` is a JSON object only because the data-pusher sets the content type `application/json` and content encoding `utf-8` system properties on every message (`$.ct` / `$.ce` in the MQTT topic, MG-68). Without both, IoT Hub stores `Body` as a base64 string and the API skips the document.

The dev simulated device (`meatgeek-dev-simulated-smoker`, sent by `simdevice` from the dev acceptance job through the data-pusher's own publish code) takes this same route, with the same payload and properties.

The API only reads this container. A reading's device is `SystemProperties["iothub-connection-device-id"]`, never `Body.deviceId`, because `Body` is whatever the device chose to send.

**Partitioning Strategy**:
- **Partition Key**: `/deviceId`
- **Benefits**: All readings for one device are co-located, and the partition value comes from the hub, not the device payload
- **Queries**: Per device, single-partition: the current reading is the newest by `iothub-enqueuedtime` (`GET /temperatures/current/{deviceId}`); history is one page per request ordered by `iothub-enqueuedtime`, paged by continuation token (no `COUNT`, no `OFFSET`), with an optional time window and `cookId` as a tag filter on `Body.cookId` (`GET /temperatures/history`)
- **Ownership**: Both routes first point-read the device in `devices`; a device the caller does not own, or that does not exist, is a 404

### 4. Real-time Path Details

**On `main` since HAR-60:** `broadcastTemperature`, an Event Hub trigger on `temperature-data` (consumer group `api-broadcast`, `cardinality: 'many'`, identity-based `IOTHUB_EVENTS` connection), sends each reading to its device's owner through the SignalR output binding on `temperatureHub`, addressed by `userId` (HAR-81). The client apps that receive it are not built yet. No message goes to a SignalR group.

The [`telemetry`](https://stevebargelt.github.io/meatgeekv2/#/view/telemetry/) view shows this path, up to SignalR.

**Measured live delay** (send to client, one dev sample, `signalr live temperature` proof): `METRIC signalr-delivery-ms 18424` (run 44673261258).

**What is sent** (`apps/api/src/functions/signalr/broadcast-temperature.ts`):
- One message per event: target `temperature`, `userId` = the `userId` stored on the device, one argument — the `TemperatureReading` plus `enqueuedTimeUtc` (the Event Hub enqueued time, ISO 8601).
- The owner is read once per distinct device per batch (a point read on `devices`, partition key = device id), so a change of owner takes effect at the next reading. A device with no stored owner is not pushed (`unowned`); a failed owner read drops that device's readings from the batch's push (`lookupFailed`). The readings are stored either way.
- The device is the hub-stamped `iothub-connection-device-id` system property, never `Body.deviceId`.
- The reading is `toTemperatureReading` of the event shaped as the stored IoT Hub document, so it equals what `GET /temperatures/current` returns for the same message.
- An event with no device id, a non-JSON body or no timestamp is skipped and counted, never thrown; each batch logs `broadcastTemperature sent=<n> skipped=<m> unowned=<u> lookupFailed=<f>`.
- `POST /negotiate` only mints a client token for the caller's `userId`; it reads no devices and manages no groups. Before HAR-81, readings went to `device-{deviceId}` groups that negotiate refilled on every call, one SignalR REST call per owned device, which tripped the Free_F1 service's throttling.

## Cook Session Management Flow

### Starting a Cook

The [`cookStart`](https://stevebargelt.github.io/meatgeekv2/#/view/cookStart/) view shows this sequence.

**Sequence**:
1. A client calls `POST /cooks` with a `deviceId` (the mobile and web apps are scaffolds and do not call the API yet)
2. The API resolves the caller from the Easy Auth principal, `"<tid>:<oid>"`
3. The API point-reads the device in the `devices` container. A device registered to someone else, or not registered at all, gets **403 `DEVICE_NOT_OWNED`**: no write, no SignalR event
4. For an owned device, the API creates the cook record in the `cooks` container, partitioned on the caller's `userId`:
   ```json
   {
     "id": "cook-abc123",
     "deviceId": "meatgeek3",
     "userId": "<tid>:<oid>",
     "status": "active",
     "startTime": "2025-01-26T10:00:00Z",
     "name": "Saturday Brisket"
   }
   ```
5. After the write, the API emits `cook_started` on the `temperatureHub` SignalR hub to the owning user's `userId` (`"<tid>:<oid>"`), never to the device (MG-30). It reaches the owner's client connections; the Pi does not receive it
6. After the write, the API sets the device twin's desired `activeCookId` and `correlationId`, synced to the Cosmos device lock under the twin etag (HAR-66). If that fails, the answer is **503 `DEVICE_TWIN_UPDATE_FAILED`**: the cook stays written, and retrying the same request heals the twin
7. The Data Pusher learns the active cook from the device twin's desired properties: a full read on every connect and a patch on every change, so a Pi that was offline when the cook started gets it when it reconnects (HAR-58). It persists the cook in `cooksession` and reports `activeCookId`, `correlationId` and `appliedDesiredVersion` back as reported properties
8. All subsequent temperature messages include cookId and the cook-scoped `correlation.id`

### During Active Cook

Every 5 seconds the Data Pusher sends a reading enriched with the cached cookId; IoT Hub stores it in Cosmos DB, and `broadcastTemperature` pushes it to the device's SignalR group. See the [`telemetry`](https://stevebargelt.github.io/meatgeekv2/#/view/telemetry/) view.

### Ending a Cook

Stopping goes through the same ownership read: `POST /cooks/{cookId}/stop` on a device the caller does not own is a 403 `DEVICE_NOT_OWNED`.

For an owned device the API marks the cook completed, clears the device twin's desired `activeCookId` and `correlationId` (a failed sync is the same 503 `DEVICE_TWIN_UPDATE_FAILED`, healed by a retry), and emits `cook_stopped` on `temperatureHub` to the owning user's `userId`, like `cook_started`. The Pi does not receive the SignalR event; it learns the cook has ended from the twin, on change or on its next connect, and reports the cleared state back. The path has the same shape as starting a cook; see the [`cookStart`](https://stevebargelt.github.io/meatgeekv2/#/view/cookStart/) view.

## Cook-Temperature Association Strategy

### Option 1: Device-Managed (Chosen Approach)
- **Device tracks active cook** in Data Pusher service
- **Includes cookId** in all temperature messages
- **Benefits**: Simple, reliable, single source of truth
- **Source**: the IoT Hub device twin's desired properties, read on every connect and patched on change (HAR-58); the device reports what it applied
- **Recovery**: `cooksession.json` caches the last applied cook across a restart; the twin read on the next connect overwrites it

**Implementation**: `apps/data-pusher/internal/iothub/twin.go` applies the twin to `internal/cooksession` (`cooksession.Store`), and `cmd/main.go` stamps each reading with the cook id and correlation id from one `cooksession` snapshot. The decision and its alternatives are recorded in [`learnings/decisions/har-55-device-twin-cook-state-and-signalr-push.md`](../../learnings/decisions/har-55-device-twin-cook-state-and-signalr-push.md).

### Alternative Approaches (Not Chosen)

#### Option 2: Server-Side Association
- Store raw temps without cookId
- Use Change Feed to enrich with cookId
- More complex, eventual consistency

#### Option 3: Client-Side Join  
- Query temps and cooks separately
- Join data in client applications
- More client complexity, multiple queries

## Error Handling & Resilience

### Storage Path Resilience
- **IoT Hub retries** failed deliveries automatically
- **Dead letter queue** for permanent failures
- **Monitoring** via IoT Hub metrics

### Real-time Path Resilience  
- **Event Hub buffering** handles temporary Function outages
- **Function retries** for transient failures
- **Graceful degradation** - storage continues even if real-time fails

### Device Resilience
- **Local buffering** in Data Pusher for network outages
- **State recovery** on restart (`cooksession.json`, then the device twin on connect)
- **Fallback behavior** if cook association fails

## Performance Characteristics

### Throughput
- **Storage Path**: Direct routing, no processing overhead
- **Real-time Path**: Batch processing in Functions
- **Combined**: Parallel processing maximizes throughput

### Latency
- **Storage**: ~1.2 s from send to readable through the API, measured in dev by `apps/api/acceptance/proofs/telemetry-roundtrip.proof.ts` (`METRIC roundtrip-ms`): 1211 ms (run 44603121177) and 1235 ms (run 44612029684). It times one `simdevice` reading from send, through IoT Hub's `cosmos-storage-route`, until `GET /temperatures/current/{deviceId}` returns it. Single dev samples, not targets; each `Deploy Dev App` run's summary carries the current value.
- **Real-time push**: ~18.4 s from send to a SignalR client, measured in dev by `apps/api/acceptance/proofs/signalr-live-temperature.proof.ts` (`METRIC signalr-delivery-ms`): 18424 ms (run 44673261258). It times one `simdevice` reading from send, through the Event Hub and `broadcastTemperature`, until the owner's SignalR client receives it. A single dev sample, not a target. No app receives the pushes yet.

### History read cost
Before HAR-75, history paged by `OFFSET` and every request also paid a `COUNT(1)` over the device's partition for `total`. Measured in dev by `apps/api/acceptance/proofs/telemetry-volume.proof.ts` (run 44612029684) on the simulated device holding 8700 readings:

| Request (before HAR-75) | Request charge |
|---|---|
| `GET /temperatures/history`, limit 100, offset 0 | 11.95 RU |
| `GET /temperatures/history`, limit 100, offset 8600 | 24.12 RU |
| `GET /temperatures/history`, 12 h window, limit 5000, 5000 readings | 238.26 RU |

`OFFSET` cost grows with the skip: the same 100-reading page cost twice as much at offset 8,600. Since HAR-75 history pages by continuation token (`maxItemCount` = `limit`, at most 1,000) with no `COUNT`, so a deep page costs what the first does. The volume proof walks the device 1,000 readings a page and fails unless the last page costs at most 1.5 × the first; each `Deploy Dev App` run's summary carries `history-ru-first-page`, `history-ru-last-page` and `history-pages`.

### Cost Optimization
- **Reduced Function executions** (no storage operations)
- **Consumption plan viable** for real-time Function
- **Direct routing** eliminates compute costs for storage

## Monitoring & Observability

### Key Metrics
- **Storage success rate**: IoT Hub → CosmosDB delivery
- **Real-time latency**: Event Hub → SignalR broadcast time  
- **Cook association rate**: Percentage of messages with cookId
- **Function execution time**: Real-time processing performance

### Tracing Strategy
- **End-to-end traces** from device to client
- **Separate spans** for storage and real-time paths
- **Cook correlation** in all telemetry
- **Custom metrics** for BBQ-specific KPIs

---

This parallel architecture provides the reliability of direct storage with the responsiveness of real-time updates, while maintaining cost efficiency and operational simplicity.