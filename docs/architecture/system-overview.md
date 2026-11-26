# MeatGeek V2 System Overview

## Project Vision

MeatGeek V2 is a comprehensive cloud-based BBQ temperature monitoring and cook management system that transforms the existing device controller into a modern, scalable IoT solution.

## Design Goals

- **Collect temperature data** from the existing device controller
- **Store data** in Azure CosmosDB for scalability and global distribution
- **Provide client apps**: a React web app on Vercel, and a native iOS (Swift) app that runs against dev from Xcode (not distributed)
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
| **Real-time** | SignalR (Serverless) | Live temperatures and cook events pushed to clients (on `main` since HAR-60; the web app's and the iOS app's live panels receive them; see [`watchCook`](https://stevebargelt.github.io/meatgeekv2/#/view/watchCook/)) |
| **Device state** | IoT Hub device twin | The active cook, in desired properties; the Pi reports what it applied (HAR-58, HAR-66; see [`cookStart`](https://stevebargelt.github.io/meatgeekv2/#/view/cookStart/)) |
| **API** | Azure Functions | REST API with OpenAPI specs |
| **Web** | React 18, Vite, on Vercel | Live at `https://meatgeekv2-web.vercel.app`: devices, cooks, a live panel by push and a chart of the whole cook |
| **Mobile** | Swift 6, SwiftUI (native iOS) | Live against dev, run from Xcode, not distributed: sign-in (HAR-162), the Devices tab (HAR-165), the Cooks tab (HAR-166), a live panel by push (HAR-167) and a chart of the whole cook (HAR-168); proven against dev once a day by the iOS Live Proof workflow, not a deploy gate (HAR-169, HAR-170). Shares only the OpenAPI contract with the web app. See [iOS app](../applications/ios-app.md) |
| **Infrastructure** | Terraform | Infrastructure as Code |
| **Monitoring** | Azure Monitor + OTEL | Observability and tracing |

### Data Flow

What runs today is the [`system` view](https://stevebargelt.github.io/meatgeekv2/#/view/system/) of the architecture site; the [`telemetry` view](https://stevebargelt.github.io/meatgeekv2/#/view/telemetry/) follows one reading from the RTD sensors through the data pusher and IoT Hub's `cosmos-storage-route` into Cosmos DB, and on through `broadcastTemperature` to SignalR, and the [`cookStart` view](https://stevebargelt.github.io/meatgeekv2/#/view/cookStart/) shows how a cook reaches the Pi through the device twin. The same views render on GitHub in [Architecture Diagrams](diagrams.md).

The Event Hub → Functions → SignalR broadcast path is **live end to end**: IoT Hub routes to the Event Hub (HAR-60), the API's `broadcastTemperature` consumes it and pushes each reading to its device owner's SignalR user (HAR-81), and the web app's live panel shows it. The web app calls the REST API and SignalR in production (HAR-71); the [`watchCook` view](https://stevebargelt.github.io/meatgeekv2/#/view/watchCook/) follows it. Deploy Dev App's `web-acceptance` job proves it live in a real browser: a pushed reading reached the page in 510 ms (`METRIC web-push-ms 510`, run 44837747351). The acceptance proofs are SignalR clients too; their first measurement, 18.4 s (`METRIC signalr-delivery-ms 18424`, run 44673261258), was a cold start. The native iOS app (`apps/ios`) is a second live client: its cook screen negotiates, connects as the signed-in user and shows pushed readings (HAR-167), and the daily iOS Live Proof workflow proves it in a simulator against dev (HAR-169, HAR-170): `METRIC ios-push-ms 10918` (run 45429145737), measured from the tap on Start, so it includes starting the cook, where the web's 510 ms starts at the reading. The Pi holds no SignalR connection: it learns its cook from the device twin. Both decisions are recorded in [`learnings/decisions/har-55-device-twin-cook-state-and-signalr-push.md`](../../learnings/decisions/har-55-device-twin-cook-state-and-signalr-push.md).

### Core Components

#### 1. Device Layer
- **Device Controller**: Enhanced version of existing Go application
- **Data Pusher**: New service for reliable IoT Hub communication
- **Local Buffering**: Handles network outages with store-and-forward capability

#### 2. Cloud Infrastructure
- **IoT Hub**: Device connectivity with **parallel message routing**
  - Direct route → CosmosDB for guaranteed storage
  - Event Hub route → Functions for real-time processing (on `main` since HAR-60: `broadcastTemperature` in the API app reads `temperature-data` and pushes each reading to its device owner's SignalR user; the web app's live panel receives it)
- **Azure Functions**: Two distinct roles
  - **Lightweight Functions**: SignalR broadcasting only, no database writes (`broadcastTemperature`, on `main` since HAR-60)
  - **Target rule**: `recordTargetsReached` reads the same readings on its own consumer group (`api-targets`) and records on each running cook which channels have reached their target. It writes the cook, and only when a channel's state changes; it never delays the live push (see [Data Flow](data-flow.md#6-target-rule))
  - **API Functions**: Cook management and queries
- **CosmosDB**: Document database receiving telemetry directly from IoT Hub

**API persistence on `main`.** The API reads and writes one shared-throughput Cosmos database, `<prefix>-shared-db`, holding seven containers: `devices` (`/id`), `temperatures` (`/deviceId`), `cooks` (`/userId`), `users` (`/id`), `recipes` (`/userId`), `temperature-rollups` (`/deviceId`) and `leases` (`/id`, the change-feed trigger's leases). It reaches them with the Function App's system-assigned managed identity, never a key, and finds each one by an app setting: `COSMOSDB_DATABASE_NAME` plus `COSMOSDB_{COOKS,DEVICES,TEMPERATURES,USERS,RECIPES}_CONTAINER_NAME`. `temperatures` is read-only for the API; only IoT Hub's Cosmos route writes it. The `rollupTemperatures` change-feed trigger folds its readings into per-device, per-hour documents in `temperature-rollups`, which `GET /cooks/{cookId}/chart` reads (HAR-86; see [Data Flow](data-flow.md#5-chart-read-model)). The caller is the Easy Auth principal `"<tid>:<oid>"`. Routes that name a device first do one point read on `devices` to check the caller owns it: `GET` and `PATCH /devices/{id}` and the temperature routes answer 404 for a foreign or unknown device alike, cook start and stop answer 403 `DEVICE_NOT_OWNED`, and `DELETE /devices/{id}` (HAR-100) answers 403 `DEVICE_NOT_OWNED` for a foreign device, with nothing deleted, and 404 `DEVICE_NOT_FOUND` for an unknown one. User profiles and recipes live in the caller's own partition.
- **SignalR**: Real-time communication hub
- **Application Insights**: Monitoring and observability

#### 3. Client Applications
- **Web App (React, live)**: On Vercel production at `https://meatgeekv2-web.vercel.app`, built from `main`. Entra sign-in (MSAL, auth code + PKCE); claim a device with its code, list, rename and release devices, and see whether each is connected; start and stop a cook; list cooks; a cook's page with a live panel by push and a chart of the whole cook from the rollups
- **Mobile App (native iOS, Swift, live against dev)**: `apps/ios` (HAR-158). Entra sign-in through MSAL in the system browser with the dev registration `meatgeek-v2-dev-ios` (HAR-159, HAR-162, HAR-164), which Easy Auth accepts (HAR-163); a Devices tab to list, claim, rename and release devices (HAR-165); a Cooks tab to list, start, open and stop cooks (HAR-166); a cook screen with a live panel by push (HAR-167) and a Swift Charts chart of the whole cook (HAR-168). CI's `ios` job tests it on every pull request, and the iOS Live Proof workflow (`ios-live-proof.yml`) proves it against dev once a day; a failure of it does not block a deploy (HAR-169, HAR-170). It is not distributed (no TestFlight): it runs in the simulator or on a developer's iPhone from Xcode. It shares no code with the web app; the two clients share only the OpenAPI contract in `libs/api-specs/spec`. See [iOS app](../applications/ios-app.md)
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
- **SignalR broadcasts** for immediate client updates (the API sends cook lifecycle events to the owner and, since HAR-60, `temperature` readings to the device owner; the web app's live panel receives `temperature` and `cook_stopped`)
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
- **Clients**: the web app (production on Vercel) and the native iOS app (live against dev, run from Xcode, not distributed)

### What the web app does today
- **Live readings** pushed to the cook's page, with a `stale` state when the device goes quiet
- **A chart of the whole cook** from server-side rollups: at most 720 points, 6.19 RU for a 12-hour cook
- **Cook history**: the cooks list, paged by continuation token, and each cook's chart
- **Devices**: claim one with the device's code, rename, release, see whether each is connected and when it was last heard from, and which has an active cook

### Device provisioning and ownership

A Pi gets its cloud identity from the Device Provisioning Service (DPS) with an X.509 certificate it generated itself; the key never leaves the Pi, and no device uses a connection string or SAS key (HAR-146). `apps/data-pusher/deploy/onboard-pi.sh`, run from the operator's laptop, installs the Pi, enrols its certificate in DPS and prints a claim code. A user owns a device only by claiming it with that code in the web app (`POST /devices/claim`; HAR-145 removed `POST /devices`), and releasing it makes the device mint a fresh code. `revoke-device.sh` disables a lost device's DPS enrollment and hub identity. The views [`onboardDevice`](https://stevebargelt.github.io/meatgeekv2/#/view/onboardDevice/), [`claimDevice`](https://stevebargelt.github.io/meatgeekv2/#/view/claimDevice/) and [`revokeDevice`](https://stevebargelt.github.io/meatgeekv2/#/view/revokeDevice/) show the three flows; the procedures are in [`docs/devices/runbook.md`](../devices/runbook.md), and the decision in [`learnings/decisions/har-130-device-provisioning-and-claim.md`](../../learnings/decisions/har-130-device-provisioning-and-claim.md).

## Next Steps

1. **Review detailed architecture**: See [Monorepo Structure](monorepo-structure.md)
2. **Understand data flow**: Review [Data Flow](data-flow.md) documentation
3. **Infrastructure setup**: Follow [Terraform Setup](../infrastructure/terraform-setup.md)
4. **Development workflow**: Check [NX Commands](../development/nx-commands.md)

---

> **Note**: This system architecture builds upon the proven foundation of the existing MeatGeek device controller while modernizing it with cloud-native practices and a web app in a browser.