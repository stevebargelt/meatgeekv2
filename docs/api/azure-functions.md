# Azure Functions API

## Overview

MeatGeek V2 uses Azure Functions for two distinct purposes within the parallel processing architecture:

1. **Lightweight Real-time Functions**: SignalR broadcasting only (no database operations)
2. **API Functions**: Cook management, device management, and data queries

## Function Architecture

### **Real-time Processing Functions**

These functions handle **Event Hub triggers** from IoT Hub and focus solely on real-time broadcasting.

#### Temperature Broadcasting Function

**Purpose**: Receive temperature telemetry and broadcast via SignalR (no storage)

```typescript
// apps/api/src/functions/temperatures/broadcast-temperature.ts
import { EventHubHandler } from '@azure/functions';
import { EventDataAdapter } from '@meatgeekv2/azure-client';
import { SignalRService } from '../shared/services/signalr-service';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const signalRService = new SignalRService();

export const broadcastTemperature: EventHubHandler = async (messages, context) => {
  const tracer = trace.getTracer('meatgeek.realtime');
  
  return tracer.startActiveSpan('temperature.broadcast', async (span) => {
    try {
      span.setAttributes({
        'message.count': messages.length,
        'function.type': 'realtime'
      });

      // Process messages in parallel for better performance
      const broadcastPromises = messages.map(async (eventData, index) => {
        return tracer.startActiveSpan(`temperature.broadcast.${index}`, async (msgSpan) => {
          try {
            // Extract temperature data from EventData
            const temp = EventDataAdapter.extractTemperatureData(eventData);
            const deviceMetadata = EventDataAdapter.getDeviceMetadata(eventData);
            
            msgSpan.setAttributes({
              'device.id': deviceMetadata.deviceId,
              'cook.id': temp.cookId || 'none',
              'temperature.grill': temp.grillTemp || 0
            });

            // Broadcast to device group (all users watching this device)
            await signalRService.sendToGroup(
              `device-${temp.deviceId}`, 
              'temperatureUpdate', 
              temp
            );

            // If part of active cook, broadcast to cook group
            if (temp.cookId) {
              await signalRService.sendToGroup(
                `cook-${temp.cookId}`, 
                'temperatureUpdate', 
                temp
              );
            }

            msgSpan.addEvent('temperature.broadcasted');
            msgSpan.setStatus({ code: SpanStatusCode.OK });
          } catch (error) {
            msgSpan.recordException(error);
            msgSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
            context.log.error(`Failed to broadcast temperature: ${error.message}`);
            // Don't throw - continue processing other messages
          } finally {
            msgSpan.end();
          }
        });
      });

      await Promise.all(broadcastPromises);
      
      span.setAttributes({
        'broadcast.success_count': broadcastPromises.length
      });
      span.setStatus({ code: SpanStatusCode.OK });
      
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      context.log.error('Temperature broadcast failed:', error);
    } finally {
      span.end();
    }
  });
};
```

**Function Configuration** (`broadcast-temperature/function.json`):
```json
{
  "bindings": [
    {
      "type": "eventHubTrigger",
      "name": "messages",
      "direction": "in",
      "eventHubName": "temperature-realtime",
      "connection": "IOTHUB_EVENTS",
      "cardinality": "many",
      "consumerGroup": "realtime-functions"
    }
  ],
  "scriptFile": "../dist/temperatures/broadcast-temperature.js",
  "entryPoint": "broadcastTemperature"
}
```

### **API Functions** 

These functions handle **HTTP triggers** for cook management and data queries.

#### Cook Management Functions

**Start Cook Function**:
```typescript
// apps/api/src/functions/cooks/start-cook.ts
import { HttpTrigger } from '@azure/functions';
import { StartCookRequest, Cook } from '@meatgeekv2/api-interfaces';
import { JWTMiddleware } from '@meatgeekv2/auth';
import { OpenAPIMiddleware } from '../../shared/middleware/openapi-validation';
import { CookManager } from '@meatgeekv2/data-models';
import { SignalRService } from '../../shared/services/signalr-service';

const authMiddleware = new JWTMiddleware();

async function startCookHandler(
  request: StartCookRequest,
  context: Context,
  req: HttpRequest
): Promise<Cook> {
  // Authenticate and authorize user
  const user = await authMiddleware.requireAuth(context, req);
  await authMiddleware.requirePermission(user, 'cook:create', request.deviceId);
  
  const cookManager = new CookManager();
  const signalRService = new SignalRService();
  
  // Create new cook record in CosmosDB with authenticated user
  const newCook = await cookManager.createCook({
    deviceId: request.deviceId,
    userId: user.sub,
    name: request.name,
    meatType: request.meatType,
    targetTemps: request.targetTemps,
    status: 'active',
    startTime: new Date()
  });
  
  // Notify device via SignalR about new cook
  await signalRService.sendToGroup(`device-${request.deviceId}`, 'cookStarted', {
    cookId: newCook.id,
    deviceId: request.deviceId,
    name: newCook.name
  });
  
  return newCook;
}

export const startCook: HttpTrigger = async (context, req) => {
  return await OpenAPIMiddleware.validateAndExecute<StartCookRequest, Cook>(
    context,
    req,
    {
      method: 'POST',
      path: '/cooks',
      successStatusCode: 201,
      operationId: 'startCook'
    },
    (request) => startCookHandler(request, context, req)
  );
};
```

**Temperature History Function**:
```typescript
// apps/api/src/functions/temperatures/get-cook-history.ts
import { HttpTrigger } from '@azure/functions';
import { CosmosClient } from '@meatgeekv2/azure-client';
import { TemperatureReading } from '@meatgeekv2/api-interfaces';

async function getCookHistoryHandler(cookId: string, context: Context): Promise<TemperatureReading[]> {
  const cosmosClient = new CosmosClient();
  
  // Query temperatures for specific cook
  // Data is already stored with cookId from direct IoT Hub routing
  const query = {
    query: 'SELECT * FROM c WHERE c.cookId = @cookId ORDER BY c.timestamp ASC',
    parameters: [{ name: '@cookId', value: cookId }]
  };
  
  const temperatures = await cosmosClient.queryTemperatures(query);
  return temperatures;
}

export const getCookHistory: HttpTrigger = async (context, req) => {
  const authMiddleware = new JWTMiddleware();
  
  try {
    // Authenticate user
    const user = await authMiddleware.requireAuth(context, req);
    
    const cookId = req.params.cookId;
    if (!cookId) {
      return { status: 400, body: { error: 'cookId parameter required' } };
    }
    
    // Authorize access to cook data
    await authMiddleware.requirePermission(user, 'cook:view', cookId);
    
    const history = await getCookHistoryHandler(cookId, context);
    return { status: 200, body: history };
  } catch (error) {
    if (error.message === 'Unauthorized') {
      return { status: 401, body: { error: 'Authentication required' } };
    }
    if (error.message === 'Insufficient permissions') {
      return { status: 403, body: { error: 'Access denied' } };
    }
    context.log.error('Failed to get cook history:', error);
    return { status: 500, body: { error: 'Internal server error' } };
  }
};
```

## EventData Adapter

**Purpose**: Extract and enrich data from Event Hub messages for real-time processing

```typescript
// libs/azure-client/src/lib/event-data-adapter.ts
import { EventData } from '@azure/event-hubs';
import { TemperatureReading } from '@meatgeekv2/api-interfaces';
import { TracingHelper } from '@meatgeekv2/tracing';

export class EventDataAdapter {
  /**
   * Extract temperature data from EventData body
   */
  static extractTemperatureData(eventData: EventData): TemperatureReading {
    const body = eventData.body;
    
    if (typeof body === 'string') {
      return JSON.parse(body);
    }
    
    return body as TemperatureReading;
  }

  /**
   * Extract trace context for OpenTelemetry correlation
   */
  static extractTraceContext(eventData: EventData): any {
    const traceParent = eventData.systemProperties?.['traceparent'] ||
                       eventData.properties?.['traceparent'] ||
                       eventData.applicationProperties?.['traceparent'];
    
    return TracingHelper.extractTraceContext(traceParent);
  }

  /**
   * Get device metadata from Event Hub message
   */
  static getDeviceMetadata(eventData: EventData): { deviceId: string; cookId?: string } {
    // IoT Hub enriches messages with device metadata
    const deviceId = eventData.systemProperties?.['iothub-connection-device-id'] ||
                    eventData.properties?.['device.id'] ||
                    eventData.applicationProperties?.['device.id'];

    const cookId = eventData.properties?.['cook.id'] ||
                  eventData.applicationProperties?.['cook.id'];

    return { deviceId, cookId };
  }

  /**
   * Extract message timestamp from Event Hub
   */
  static getMessageTimestamp(eventData: EventData): Date {
    return eventData.enqueuedTimeUtc || new Date();
  }
}
```

## Function App Configuration

### **Host Configuration** (`host.json`):
```json
{
  "version": "2.0",
  "functionTimeout": "00:05:00",
  "extensions": {
    "eventHubs": {
      "batchCheckpointFrequency": 5,
      "eventProcessorOptions": {
        "maxBatchSize": 100,
        "prefetchCount": 300
      }
    },
    "http": {
      "maxConcurrentRequests": 100
    }
  },
  "logging": {
    "applicationInsights": {
      "samplingSettings": {
        "isEnabled": true,
        "excludedTypes": "Request"
      }
    }
  }
}
```

### **Application Settings**:

The Function App runs under a **system-assigned managed identity**, and every
backing service (Cosmos DB, IoT/Event Hub telemetry, SignalR, host storage) is
reached **identity-based**: the settings carry only **non-secret endpoints**, and
data-plane access is granted by RBAC role assignments on the identity. **No
connection strings or primary keys** are placed in app settings or Terraform
state. These are exactly the settings Terraform configures on the Function App:

```bash
# Runtime
FUNCTIONS_WORKER_RUNTIME=node
WEBSITE_NODE_DEFAULT_VERSION=~20

# Application Insights — identity-based (AAD) telemetry ingestion. The managed
# identity holds "Monitoring Metrics Publisher" on the App Insights resource and
# the host authenticates with an AAD token (APPLICATIONINSIGHTS_AUTHENTICATION_STRING).
# APPLICATIONINSIGHTS_CONNECTION_STRING is the FULL connection string —
# InstrumentationKey included, because Microsoft requires the ikey as the
# destination-resource identifier even under Entra-only ingestion — but that ikey
# CANNOT authenticate: local_authentication_disabled=true on the App Insights
# resource forces AAD-only ingestion, so the ikey is an inert, non-credential
# identifier, not a secret to protect.
APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD
APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=<ikey>;IngestionEndpoint=<insights-ingestion-endpoint>;LiveEndpoint=<insights-live-endpoint>
APPLICATIONINSIGHTS_SAMPLING_PERCENTAGE=50

# Cosmos DB — identity-based. NON-SECRET account endpoint only; the managed
# identity holds a Cosmos SQL data-plane role assignment.
COSMOSDB__accountEndpoint=<cosmos-account-endpoint>

# IoT telemetry (Event Hubs-compatible) — identity-based. NON-SECRET
# fully-qualified namespace only; the managed identity holds Azure Event Hubs
# Data Receiver.
IOTHUB_EVENTS__fullyQualifiedNamespace=<iot-eventhub-namespace-fqdn>

# SignalR — identity-based. NON-SECRET service URI only; the managed identity
# holds SignalR Service Owner.
AzureSignalRConnectionString__serviceUri=<signalr-service-uri>
```

> The `__accountEndpoint` / `__fullyQualifiedNamespace` / `__serviceUri` suffixes
> are the Functions host's convention for identity-based bindings: the host
> resolves each service using the app's managed identity against the non-secret
> endpoint, so there is no secret to leak. Host storage is likewise identity-based
> (`storage_uses_managed_identity`), so no storage account key is written either.
>
> Application Insights follows the same identity-based model: telemetry is
> published with an AAD token — `APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD`
> plus a **Monitoring Metrics Publisher** role assignment on the App Insights
> resource. `APPLICATIONINSIGHTS_CONNECTION_STRING` is the **full**
> Terraform-managed connection string, **`InstrumentationKey` included** —
> Microsoft requires the ikey as the **destination-resource identifier** even
> under Entra-only ingestion, so the endpoint-only value is not used. That ikey
> **cannot authenticate ingestion**: the App Insights resource sets
> **`local_authentication_disabled = true`**, so only an AAD token (Monitoring
> Metrics Publisher) is accepted and an ikey-only client is rejected. The ikey
> therefore lands in this app setting and in Terraform state as an **inert,
> non-credential** telemetry-destination identifier — an accepted residual that
> is safe **only while local auth stays disabled**, a coupling enforced by the
> pre-apply secret-inspection gate. See
> [ADR: App Insights instrumentation key remains in Terraform state](../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md).

## Function Deployment

### **Development Deployment**:
```bash
# Build and deploy to development environment
nx build api --configuration=development
nx deploy api --env=dev
```

### **Production Deployment**:
```bash
# Build optimized production bundle
nx build api --configuration=production
nx deploy api --env=prod
```

> In production this runs from CI, not by hand. The `app-deploy-prod.yml` workflow invokes `nx deploy api --env=prod` automatically **after the CI/CD Pipeline completes green on a push to `main`**, gated by the `PROD_DEPLOY_ENABLED` repository variable. See [CI/CD Pipeline → Prod](../development/ci-cd.md#prod).

## Performance Optimizations

### **Real-time Functions**:
- **Event Hub batching**: Process multiple messages simultaneously
- **No database operations**: Only SignalR broadcasting for minimal latency
- **Parallel processing**: Handle multiple temperature updates concurrently
- **Error isolation**: Failed broadcasts don't affect other messages

### **API Functions**:
- **Connection pooling**: Reuse CosmosDB connections
- **OpenAPI validation**: Early request validation
- **Structured logging**: Easy debugging and monitoring
- **Caching**: Cache frequently accessed cook data

### **Cost Optimization**:
- **Consumption plan viable**: Lightweight real-time functions
- **Separate scaling**: Real-time and API functions scale independently  
- **Efficient batching**: Minimize Function executions
- **Direct storage**: No Function costs for temperature persistence

## Monitoring & Observability

### **Key Metrics**:
- **Real-time latency**: Event Hub → SignalR broadcast time
- **Function execution time**: Performance monitoring
- **Error rates**: Failed broadcasts or API calls
- **Throughput**: Messages processed per second

### **Custom Telemetry**:
- **Cook session metrics**: Active cooks, average cook time
- **Temperature metrics**: Average temperatures, alert frequencies
- **Device metrics**: Device connectivity, message rates

---

This architecture separates concerns effectively: **storage is guaranteed** via IoT Hub direct routing, while **real-time updates are optimized** for minimal latency and cost through lightweight Functions.