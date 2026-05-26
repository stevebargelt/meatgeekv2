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
IoT Hub → Direct Route → CosmosDB
                         │
                         └─→ Collection: temperatures
                             Partition: /cookId
                             TTL: 2 years
```

**Data Organization**:
```json
// Stored exactly as received from device
{
  "id": "temp-2025-01-26-10-05-00-abc123",
  "messageType": "temperature",
  "deviceId": "meatgeek3",
  "cookId": "cook-abc123",
  "timestamp": "2025-01-26T10:05:00Z", 
  "grillTemp": 225.5,
  "probe1Temp": 160.2,
  // ... all temperature readings
  "_ts": 1737876300
}
```

**Partitioning Strategy**:
- **Partition Key**: `/cookId` 
- **Benefits**: All temperatures for a cook are co-located
- **Queries**: Efficient retrieval of cook temperature history
- **Scaling**: Distributes across partitions by cook sessions

### 4. Real-time Path Details

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
Mobile App → API Function → CosmosDB Cook Record → SignalR Notification → Device
    │             │              │                    │                    │
    ▼             ▼              ▼                    ▼                    ▼
Start Cook    Create Cook     Store cook          Notify device       Cache cookId
Request       with unique ID   metadata           about new cook      for telemetry
```

**Sequence**:
1. User starts cook in mobile app
2. API Function creates cook record in CosmosDB:
   ```json
   {
     "id": "cook-abc123",
     "deviceId": "meatgeek3", 
     "userId": "user-456",
     "status": "active",
     "startTime": "2025-01-26T10:00:00Z",
     "name": "Saturday Brisket"
   }
   ```
3. Function sends SignalR notification to device group
4. Data Pusher receives notification and caches cookId
5. All subsequent temperature messages include cookId

### During Active Cook

```
Every 5 seconds:
Device → Enriched Temps → IoT Hub → Parallel Processing
  │                         │
  ▼                         ├─→ CosmosDB (with cookId)
cookId cached               └─→ SignalR (real-time updates)
```

### Ending a Cook

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
- **Storage**: ~100ms (direct route)
- **Real-time**: ~500ms (Event Hub + Function + SignalR)
- **Client Updates**: Sub-second for temperature changes

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