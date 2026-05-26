# MeatGeek V2 System Overview

## Project Vision

MeatGeek V2 is a comprehensive cloud-based BBQ temperature monitoring and cook management system that transforms the existing device controller into a modern, scalable IoT solution.

## Design Goals

- **Collect temperature data** from the existing device controller
- **Store data** in Azure CosmosDB for scalability and global distribution
- **Provide mobile-first interfaces** with React Native (primary) and React (secondary)
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
| **Real-time** | SignalR | Live updates to clients |
| **API** | Azure Functions | REST API with OpenAPI specs |
| **Mobile** | React Native | Primary user interface |
| **Web** | React | Secondary interface |
| **Infrastructure** | Terraform | Infrastructure as Code |
| **Monitoring** | Azure Monitor + OTEL | Observability and tracing |

### Data Flow

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│ RTD Sensors (5) │───▶│ Device       │───▶│ Data Pusher     │
│ - Grill         │    │ Controller   │    │ Service         │
│ - Probe 1-4     │    │ (Go/Gobot)   │    │ (Go + CookID)   │
└─────────────────┘    └──────────────┘    └─────────────────┘
                              │                      │
                              ▼                      ▼
                    ┌──────────────┐    ┌─────────────────┐
                    │ LCD Display  │    │ Azure IoT Hub   │
                    │ (Local UI)   │    │ (Message Routes)│
                    └──────────────┘    └─────────────────┘
                                                  │
                                        ┌─────────┴─────────┐
                                        ▼                   ▼
                               ┌─────────────────┐ ┌─────────────────┐
                               │ Direct Route    │ │ Event Hub Route │
                               │ → CosmosDB      │ │ → Functions     │
                               │ (Storage)       │ │ (Real-time)     │
                               └─────────────────┘ └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐    ┌──────────────┐    ┌─────────────────────────┐
│ Mobile App      │◀───│ SignalR Hub  │◀───│ Lightweight Function    │
│ (React Native)  │    │ (Real-time)  │    │ (Broadcast Only)        │
└─────────────────┘    └──────────────┘    └─────────────────────────┘

┌─────────────────┐    ┌──────────────┐
│ Web App         │◀───│ REST API     │
│ (React)         │    │ Functions    │
└─────────────────┘    └──────────────┘
```

### Core Components

#### 1. Device Layer
- **Device Controller**: Enhanced version of existing Go application
- **Data Pusher**: New service for reliable IoT Hub communication
- **Local Buffering**: Handles network outages with store-and-forward capability

#### 2. Cloud Infrastructure
- **IoT Hub**: Device connectivity with **parallel message routing**
  - Direct route → CosmosDB for guaranteed storage
  - Event Hub route → Functions for real-time processing
- **Azure Functions**: Two distinct roles
  - **Lightweight Functions**: SignalR broadcasting only (no database writes)
  - **API Functions**: Cook management and queries
- **CosmosDB**: Document database receiving telemetry directly from IoT Hub
- **SignalR**: Real-time communication hub
- **Application Insights**: Monitoring and observability

#### 3. Client Applications
- **Mobile App (React Native)**: Primary interface for real-time monitoring
- **Web App (React)**: Secondary interface with advanced analytics
- **Shared Libraries**: TypeScript libraries for consistent API integration

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
- **Event Hub triggers** for lightweight real-time processing
- **SignalR broadcasts** for immediate client updates
- **Cook session events** for business logic coordination

#### Device Cook Session Management
- **Device tracks active cook**: Data Pusher maintains cookId in memory
- **Enriched telemetry**: All temperature messages include cookId when cook is active
- **State recovery**: Device can recover cook state from API on restart
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