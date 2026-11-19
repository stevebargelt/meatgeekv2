# Data Flow Architecture

## Overview

MeatGeek V2 uses a **parallel processing architecture** where temperature telemetry follows two independent paths for optimal resilience, performance, and cost efficiency.

## High-Level Flow

```
Device → Data Pusher → IoT Hub → Parallel Routes
                         │
                         ├─→ Direct Route → CosmosDB (Storage)
                         └─→ Event Hub → Function → SignalR (Real-time)
```

The real-time leg (Event Hub → Function → SignalR) is **planned, not on `main`**: IoT Hub routes to the Event Hub today, but no function in `apps/api` consumes it.

## Detailed Data Flow

### 1. Device Layer Processing

```
RTD Sensors → Device Controller → Data Pusher → IoT Hub
    ↓              ↓                 ↓
 5 temp         Averaging        Enrichment    
 readings      (100 samples)     + CookID      
```

**Device Controller (Enhanced)**:
- Reads 5 RTD sensors every 10ms
- Maintains 100-sample averaging queues
- Updates LCD display every 5 seconds
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

**Planned, not on `main`.** The `eventhub-realtime-route` and the `temperature-data` Event Hub exist in `apps/infrastructure/modules/iot-hub/main.tf`, but nothing consumes them; the design below is the intended consumer.

```yaml
route_name: "RealTimeUpdates"
source: "DeviceMessages"
condition: "messageType = 'temperature'"  
endpoint_type: "eventhub"
endpoint: "realtime-events"
```

**Benefits**:
- ✅ **Batch processing** - Function processes multiple messages
- ✅ **Lightweight** - No database operations in Function
- ✅ **Fast execution** - Only SignalR broadcasting
- ✅ **Scalable** - Event Hub handles high throughput

### 3. Storage Path Details

```
IoT Hub → cosmos-storage-route → CosmosDB
                                 │
                                 └─→ Container: temperatures
                                     Partition: /deviceId (stamped from {deviceid})
                                     TTL: default_ttl (var.temperature_data_ttl)
```

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
- **Queries**: Per device, single-partition: the current reading is the newest by `iothub-enqueuedtime` (`GET /temperatures/current/{deviceId}`); history is a count plus a page ordered by `iothub-enqueuedtime`, with an optional time window and `cookId` as a tag filter on `Body.cookId` (`GET /temperatures/history`)
- **Ownership**: Both routes first point-read the device in `devices`; a device the caller does not own, or that does not exist, is a 404

### 4. Real-time Path Details

**Planned, not on `main`.** There is no `broadcastTemperature` function and no `device-{deviceId}` or `cook-{cookId}` SignalR group; the only SignalR output on `main` is the cook lifecycle event described below.

```
IoT Hub → Event Hub → Lightweight Function → SignalR
                          │
                          └─→ Broadcasts only (no storage)
```

**Function Implementation**:
```typescript
// Simplified function - broadcast only
export const broadcastTemperature: EventHubHandler = async (messages, context) => {
  const signalRService = new SignalRService();
  
  // Process messages in batch
  const promises = messages.map(async (eventData) => {
    const temp = EventDataAdapter.extractTemperatureData(eventData);
    
    // Broadcast to device group (all users watching this device)
    await signalRService.sendToGroup(`device-${temp.deviceId}`, 'temperature', temp);
    
    // If part of active cook, broadcast to cook group  
    if (temp.cookId) {
      await signalRService.sendToGroup(`cook-${temp.cookId}`, 'temperature', temp);
    }
  });
  
  await Promise.all(promises);
};
```

**SignalR Groups**:
- `device-{deviceId}`: All users monitoring a device
- `cook-{cookId}`: All users following a specific cook session

## Cook Session Management Flow

### Starting a Cook

```
Client → API Function → Ownership read (devices) → CosmosDB Cook Record → SignalR Notification → Device
   │          │                 │                          │                     │                  │
   ▼          ▼                 ▼                          ▼                     ▼                  ▼
Start Cook  Resolve        403 if the caller          Store cook in        cook_started to     Cache cookId
Request     principal      does not own the device    caller's partition   userId=deviceId     for telemetry
```

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
5. After the write, the API emits `cook_started` on the `temperatureHub` SignalR hub to `userId = deviceId`
6. Data Pusher receives the event and caches cookId (the live SignalR path is pending the MG-24 bootstrap; until then the Data Pusher recovers the active cook from the REST API on startup)
7. All subsequent temperature messages include cookId

### During Active Cook

```
Every 5 seconds:
Device → Enriched Temps → IoT Hub → Parallel Processing
  │                         │
  ▼                         ├─→ CosmosDB (with cookId)
cookId cached               └─→ SignalR (real-time updates; planned, not on `main`)
```

### Ending a Cook

Stopping goes through the same ownership read: `POST /cooks/{cookId}/stop` on a device the caller does not own is a 403 `DEVICE_NOT_OWNED`.

```
Mobile App → API Function → Update Cook Status → SignalR Notification → Device
                                │                     │                  │
                                ▼                     ▼                  ▼
                          Mark completed         Notify device      Clear cookId
```

## Cook-Temperature Association Strategy

### Option 1: Device-Managed (Chosen Approach)
- **Device tracks active cook** in Data Pusher service
- **Includes cookId** in all temperature messages
- **Benefits**: Simple, reliable, single source of truth
- **Recovery**: Device queries API on startup for active cook

**Implementation**:
```go
// Data Pusher maintains cook state
type DataPusher struct {
    activeCookId *string
    deviceUrl    string
    iotClient    IoTHubClient
    signalRConn  SignalRConnection
}

func (dp *DataPusher) onCookStarted(cookId string) {
    dp.activeCookId = &cookId
    // Persist to local file for recovery
    dp.saveState()
}

func (dp *DataPusher) enrichTemperatureData(temps TemperatureReading) TemperatureReading {
    if dp.activeCookId != nil {
        temps.CookId = dp.activeCookId
    }
    temps.MessageType = "temperature"
    temps.Timestamp = time.Now()
    return temps
}
```

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
- **State recovery** on restart (query active cook from API)
- **Fallback behavior** if cook association fails

## Performance Characteristics

### Throughput
- **Storage Path**: Direct routing, no processing overhead
- **Real-time Path**: Batch processing in Functions
- **Combined**: Parallel processing maximizes throughput

### Latency
- **Storage**: ~1.2 s from send to readable through the API, measured in dev by `apps/api/acceptance/proofs/telemetry-roundtrip.proof.ts` (`METRIC roundtrip-ms`): 1211 ms (run 44603121177) and 1235 ms (run 44612029684). It times one `simdevice` reading from send, through IoT Hub's `cosmos-storage-route`, until `GET /temperatures/current/{deviceId}` returns it. Single dev samples, not targets; each `Deploy Dev App` run's summary carries the current value.
- **Real-time and client updates**: not measured; the Event Hub has no consumer on `main` and no client calls the API yet.

### History read cost
Measured in dev by `apps/api/acceptance/proofs/telemetry-volume.proof.ts` (run 44612029684) on the simulated device holding 8700 readings (`history-total`; the proof tops it up to at least one 12 h cook at one reading every 5 s, 8,640):

| Request | Request charge |
|---|---|
| `GET /temperatures/history`, limit 100, offset 0 (`history-ru-first-page`) | 11.95 RU |
| `GET /temperatures/history`, limit 100, offset 8600 (`history-ru-last-page`) | 24.12 RU |
| `GET /temperatures/history`, 12 h window, limit 5000, 5000 readings (`history-ru-max-page`) | 238.26 RU |

`OFFSET` cost grows with the skip: the same 100-reading page costs 11.95 RU at offset 0 and 24.12 RU at offset 8,600. Every history request also pays the `COUNT(1)` over the device's partition that fills `total`. These are single dev samples, not targets; each run's summary carries the current values.

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