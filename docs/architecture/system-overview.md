# MeatGeek V2 System Overview

## Project Vision

MeatGeek V2 is a comprehensive cloud-based BBQ temperature monitoring and cook management system that transforms the existing device controller into a modern, scalable IoT solution.

## Design Goals

- **Collect temperature data** from the existing device controller
- **Store data** in Azure CosmosDB for scalability and global distribution
- **Provide client apps**: a React web app, and a native iOS (Swift) app that is planned and not built
- **Manage cooking sessions** with historical data tracking and analytics
- **Enable real-time monitoring** with live temperature updates
- **Replace NewRelic** with Azure-native monitoring and observability
- **Organize in NX monorepo** for unified development and code reuse

## Current Device Controller Analysis

The existing Go-based device controller provides a solid foundation:

### Hardware Integration
- **Temperature monitoring** from 5 RTD sensors (grill + 4 probes)
- **MCP3008 ADC** for analog-to-digital conversion
- **LCD display** for local temperature readouts
- **Raspberry Pi** hardware platform

### Software Capabilities
- **Local API** on port 3000 with REST endpoints:
  - `/api/robots/MeatGeekBot/commands/get_status` - Complete device status
  - `/api/robots/MeatGeekBot/commands/get_temps` - Temperature readings only
- **Temperature averaging** with 100-sample queues for stability
- **Real-time processing** with 10ms sensor polling, 5s display updates
- **NewRelic integration** for basic monitoring (to be replaced)

### Data Structures Available

**Temperature Data**:
```json
{
  "temps": {
    "grillTemp": 225.0,
    "probe1Temp": 160.0,
    "probe2Temp": 145.0,
    "probe3Temp": null,
    "probe4Temp": 200.0
  }
}
```

**Device Status**:
```json
{
  "status": {
    "smokerid": "meatgeek3",
    "augerOn": false,
    "blowerOn": false,
    "igniterOn": false,
    "fireHealthy": true,
    "mode": "test",
    "setPoint": 200,
    "currentTime": "2025-01-26T10:30:00Z"
  }
}
```

## High-Level Architecture

### Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Device** | Go + Gobot | Temperature monitoring on Raspberry Pi |
| **Data Ingestion** | Azure IoT Hub | Device-to-cloud telemetry |
| **Processing** | Azure Functions | Serverless data processing |
| **Storage** | CosmosDB | NoSQL document storage |
| **Real-time** | SignalR (Serverless) | Live temperatures and cook events pushed to clients (on `main` since HAR-60; no app connects yet; see [`telemetry`](https://stevebargelt.github.io/meatgeekv2/#/view/telemetry/)) |
| **Device state** | IoT Hub device twin | The active cook, in desired properties; the Pi reports what it applied (HAR-58, HAR-66; see [`cookStart`](https://stevebargelt.github.io/meatgeekv2/#/view/cookStart/)) |
| **API** | Azure Functions | REST API with OpenAPI specs |
| **Web** | React | User interface |
| **Mobile** | Swift (native iOS) | Planned, not built; shares only the OpenAPI contract with the web app |
| **Infrastructure** | Terraform | Infrastructure as Code |
| **Monitoring** | Azure Monitor + OTEL | Observability and tracing |

### Data Flow

What runs today is the [`system` view](https://stevebargelt.github.io/meatgeekv2/#/view/system/) of the architecture site; the [`telemetry` view](https://stevebargelt.github.io/meatgeekv2/#/view/telemetry/) follows one reading from the RTD sensors through the data pusher and IoT Hub's `cosmos-storage-route` into Cosmos DB, and on through `broadcastTemperature` to SignalR, and the [`cookStart` view](https://stevebargelt.github.io/meatgeekv2/#/view/cookStart/) shows how a cook reaches the Pi through the device twin. The same views render on GitHub in [Architecture Diagrams](diagrams.md).

The Event Hub → Functions → SignalR broadcast path is **on `main` up to SignalR** since HAR-60: IoT Hub routes to the Event Hub, and the API's `broadcastTemperature` consumes it and pushes each reading to its `device-{id}` SignalR group. The web app is a scaffold that does not call the REST API or SignalR yet, and the native iOS app is not built; the acceptance proofs are the only live SignalR client, and measured a send-to-client delay of 18.4 s (`METRIC signalr-delivery-ms 18424`, run 44673261258). The Pi holds no SignalR connection: it learns its cook from the device twin. Both decisions are recorded in [`learnings/decisions/har-55-device-twin-cook-state-and-signalr-push.md`](../../learnings/decisions/har-55-device-twin-cook-state-and-signalr-push.md).

### Core Components

#### 1. Device Layer
- **Device Controller**: Enhanced version of existing Go application
- **Data Pusher**: New service for reliable IoT Hub communication
- **Local Buffering**: Handles network outages with store-and-forward capability

#### 2. Cloud Infrastructure
- **IoT Hub**: Device connectivity with **parallel message routing**
  - Direct route → CosmosDB for guaranteed storage
  - Event Hub route → Functions for real-time processing (on `main` since HAR-60: `broadcastTemperature` in the API app reads `temperature-data` and pushes each reading to its `device-{id}` SignalR group; the client apps that receive it are not built)
- **Azure Functions**: Two distinct roles
  - **Lightweight Functions**: SignalR broadcasting only, no database writes (`broadcastTemperature`, on `main` since HAR-60)
  - **API Functions**: Cook management and queries
- **CosmosDB**: Document database receiving telemetry directly from IoT Hub

**API persistence on `main`.** The API reads and writes one shared-throughput Cosmos database, `<prefix>-shared-db`, holding five containers: `devices` (`/id`), `temperatures` (`/deviceId`), `cooks` (`/userId`), `users` (`/id`) and `recipes` (`/userId`). It reaches them with the Function App's system-assigned managed identity, never a key, and finds each one by an app setting: `COSMOSDB_DATABASE_NAME` plus `COSMOSDB_{COOKS,DEVICES,TEMPERATURES,USERS,RECIPES}_CONTAINER_NAME`. `temperatures` is read-only for the API; only IoT Hub's Cosmos route writes it. The caller is the Easy Auth principal `"<tid>:<oid>"`. Routes that name a device first do one point read on `devices` to check the caller owns it: device and temperature routes answer 404 for a foreign or unknown device alike, and cook start and stop answer 403 `DEVICE_NOT_OWNED`. User profiles and recipes live in the caller's own partition.
- **SignalR**: Real-time communication hub
- **Application Insights**: Monitoring and observability

#### 3. Client Applications
- **Web App (React)**: Interface for real-time monitoring and cook history
- **Mobile App (native iOS, Swift)**: Planned and not built. It shares no code with the web app; the two clients share only the OpenAPI contract in `libs/api-specs/spec`
- **Shared Libraries**: TypeScript libraries the web app and API use for consistent API integration

## Key Design Decisions

### Monorepo with NX
- **Unified development** across all applications and services
- **Code reuse** through shared libraries and components
- **Consistent tooling** and build processes
- **Type safety** across API boundaries with generated clients

### Azure-First Architecture
- **Serverless functions** for cost-effective scaling
- **Managed services** to reduce operational overhead
- **Global distribution** with CosmosDB multi-region capabilities
- **Native monitoring** with Azure Monitor replacing NewRelic

### Parallel Processing Architecture
- **Dual-path telemetry processing** for resilience and performance
- **Direct IoT Hub routing** to CosmosDB for guaranteed storage
- **Event Hub triggers** for lightweight real-time processing (on `main` since HAR-60: `broadcastTemperature` in the API app)
- **SignalR broadcasts** for immediate client updates (the API sends cook lifecycle events to the owner and, since HAR-60, `temperature` readings to `device-{id}` groups; no app receives them yet, only the acceptance proofs)
- **Cook session events** for business logic coordination

#### Device Cook Session Management
- **Device tracks active cook**: the Data Pusher applies the device twin's desired `activeCookId` and `correlationId`, read on every connect and patched on change, and reports them back (HAR-58)
- **Enriched telemetry**: All temperature messages include cookId when cook is active
- **State recovery**: `cooksession.json` keeps the last applied cook across a restart; the twin read on the next connect brings an offline Pi up to date
- **Separation of concerns**: Storage and real-time processing are independent

### Observability Strategy
- **OpenTelemetry** for distributed tracing across all services
- **W3C Trace Context** for end-to-end correlation
- **Azure Monitor** for metrics, logs, and dashboards
- **Custom telemetry** for BBQ-specific metrics

## Success Metrics

### Technical KPIs
- **Sub-second latency** from sensor reading to client display
- **99.9% uptime** for temperature monitoring
- **10-second recovery** from network outages
- **Cross-platform compatibility** (iOS, Android, Web)

### User Experience KPIs
- **Real-time updates** with live temperature charts
- **Historical analytics** for cook comparison and optimization
- **Mobile-first design** optimized for outdoor BBQ use
- **Offline capability** with local data caching

## Next Steps

1. **Review detailed architecture**: See [Monorepo Structure](monorepo-structure.md)
2. **Understand data flow**: Review [Data Flow](data-flow.md) documentation
3. **Infrastructure setup**: Follow [Terraform Setup](../infrastructure/terraform-setup.md)
4. **Development workflow**: Check [NX Commands](../development/nx-commands.md)

---

> **Note**: This system architecture builds upon the proven foundation of the existing MeatGeek device controller while modernizing it with cloud-native practices and mobile-first user experiences.