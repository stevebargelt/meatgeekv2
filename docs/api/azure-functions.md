# Azure Functions API

## Overview

MeatGeek V2 uses Azure Functions for two distinct purposes within the parallel processing architecture:

1. **Lightweight Real-time Functions**: SignalR broadcasting only (no database operations)
2. **API Functions**: Cook management, device management, and data queries

## Registered Functions

What `apps/api/src/main.ts` registers with the Functions host today. Everything
below the next heading describes the target architecture, some of which is not
yet wired.

| Function                 | Trigger       | Route / schedule                  | Purpose                                                       |
| ------------------------ | ------------- | --------------------------------- | ------------------------------------------------------------- |
| `getCooks`               | HTTP `GET`    | `cooks`                           | List cooks                                                    |
| `startCook`              | HTTP `POST`   | `cooks`                           | Start a cook (emits `cook_started` on SignalR)                |
| `getCook`                | HTTP `GET`    | `cooks/{cookId}`                  | One of the caller's cooks (404 for another user's)            |
| `stopCook`               | HTTP `POST`   | `cooks/{cookId}/stop`             | Stop a cook (emits `cook_stopped` on SignalR)                 |
| `negotiate`              | HTTP `POST`   | `negotiate`                       | SignalR client negotiate, scoped to the caller's own devices  |
| `getCurrentTemperatures` | HTTP `GET`    | `temperatures/current/{deviceId}` | Latest reading for a caller's device (404 else)               |
| `getTemperatureHistory`  | HTTP `GET`    | `temperatures/history`            | A page of a caller's device's readings, by continuation token |
| `getDevices`             | HTTP `GET`    | `devices`                         | List the caller's devices                                     |
| `registerDevice`         | HTTP `POST`   | `devices`                         | Register a device to the caller                               |
| `getDevice`              | HTTP `GET`    | `devices/{id}`                    | One of the caller's devices (404 otherwise)                   |
| `updateDevice`           | HTTP `PATCH`  | `devices/{id}`                    | Change name / location / configuration                        |
| `getUserProfile`         | HTTP `GET`    | `users/me`                        | The caller's profile (404 until the first PUT)                |
| `putUserProfile`         | HTTP `PUT`    | `users/me`                        | Create or replace the caller's profile                        |
| `listRecipes`            | HTTP `GET`    | `recipes`                         | List the caller's recipes, newest first                       |
| `createRecipe`           | HTTP `POST`   | `recipes`                         | Create a recipe owned by the caller                           |
| `getRecipe`              | HTTP `GET`    | `recipes/{id}`                    | One of the caller's recipes (404 otherwise)                   |
| `updateRecipe`           | HTTP `PATCH`  | `recipes/{id}`                    | Change any recipe field (409 on a race)                       |
| `deleteRecipe`           | HTTP `DELETE` | `recipes/{id}`                    | Delete one of the caller's recipes                            |
| `cosmosHealth`           | HTTP `GET`    | `health/cosmos`                   | MG-51 — probes the API's own path to Cosmos                   |
| `storageHeartbeat`       | **Timer**     | `0 */15 * * * *` (every 15 min)   | MG-58 — the host-storage proof path                           |
| `broadcastTemperature`   | **Event Hub** | `temperature-data`, many          | HAR-60 — pushes each device's newest reading to `device-{id}` |

`broadcastTemperature` is the live-reading producer. IoT Hub routes every device
message to the `temperature-data` event hub (`eventhub-realtime-route` in
`apps/infrastructure/modules/iot-hub/main.tf`); the trigger reads it in batches
(`cardinality: 'many'`) on the API's own consumer group,
`%TEMPERATURE_BROADCAST_CONSUMER_GROUP%` (`api-broadcast`), through the
identity-based `IOTHUB_EVENTS` connection. Each batch sends one SignalR message
per device in it, carrying that device's newest reading, on the shared output
binding (hub `temperatureHub`):

```json
{
  "target": "temperature",
  "groupName": "device-{deviceId}",
  "arguments": [{ "...TemperatureReading": "", "enqueuedTimeUtc": "<ISO 8601>" }]
}
```

- The device id is the hub-stamped `iothub-connection-device-id` system
  property, never the body's `deviceId` (the MG-73 trust rule).
- The reading is `toTemperatureReading` of the event shaped as the stored IoT Hub
  document, so it is exactly what `GET /temperatures/current` returns for the same
  message. `enqueuedTimeUtc` is the Event Hub enqueued time, so a client can
  measure delivery delay.
- The body may arrive as an object, a JSON string or bytes; all three are decoded.
- **The push is coalesced (HAR-81).** Per batch, only the newest reading of each
  device is sent, newest by its `enqueuedTimeUtc` (on a tie, the later event in
  the batch). Every reading is still stored, by IoT Hub's own `cosmos-storage`
  route; only the live push is coalesced, and the message shape does not change.
  A real device sends every 5 s, so a batch normally holds one reading per device
  and nothing changes; a burst, such as the acceptance `telemetry-volume` top-up,
  costs one message per device per batch instead of one per reading. That keeps
  the dev SignalR (`Free_F1`, 20,000 messages a day) inside its daily quota.
- An event with no device id, a non-JSON body, or no timestamp is skipped and
  counted, never thrown, so one bad event does not fail or replay the batch, and
  never displaces a good reading. Each batch logs one line,
  `broadcastTemperature sent=<n> coalesced=<c> skipped=<m>` (`coalesced`: good
  readings not sent because a newer one of the same device was), with no ids and
  no bodies.
- negotiate (HAR-57) puts each user in the `device-{id}` groups of the devices
  they own, so a reading reaches only its device's owners. Nothing is sent to
  `cook-` groups. It adds at most 4 groups at a time, and every SignalR REST
  call retries a `429` or `503` answer up to 3 times (waiting for `Retry-After`,
  capped at 2 s, or 200/400/800 ms) before negotiate answers 503 (HAR-80).

`storageHeartbeat` exists because, when it was added, it was the **only**
registration that needed `AzureWebJobsStorage`: the Functions host keeps a timer's schedule status and
singleton lease in the host storage account, so the invocation appearing in
`FunctionAppLogs` is itself the proof that host storage authenticates — a proof
no HTTP trigger can give, which is why the host sat
`azure.functions.webjobs.storage: Unhealthy / AuthenticationFailed` for weeks
while all seven endpoints answered 200. The handler only logs; it writes no blob
and takes no Azure SDK dependency, because the storage dependency being proved is
the **host's**, not the handler's. See
[MG-58 host-storage verification](../infrastructure/mg58-host-storage-verification.md).
Since HAR-60, `broadcastTemperature` also uses host storage: the Event Hub
trigger keeps its partition leases and checkpoints there (the app identity holds
Storage Blob Data Owner on the host account). The heartbeat stays the dedicated
proof.

HTTP `authLevel` is `anonymous` at the Functions runtime throughout, on purpose:
the MG-24 platform layer (Easy Auth / `auth_settings_v2` with
`unauthenticated_action = Return401`) validates the Entra bearer token before any
function executes. That gate covers HTTP only — a timer is not reachable from the
edge at all, and neither is an Event Hub trigger.

## Function Architecture

### **Real-time Processing Functions**

These functions handle **Event Hub triggers** from IoT Hub and focus solely on real-time broadcasting.

#### Temperature Broadcasting Function

Built in HAR-60 as `broadcastTemperature`:
`apps/api/src/functions/signalr/broadcast-temperature.ts`, registered in
`apps/api/src/main.ts` with `app.eventHub(...)` (Functions v4 programming model,
no `function.json`). What it does and what it sends is described under
[Registered Functions](#registered-functions). It stores nothing; the Cosmos copy
of each reading is written by IoT Hub's own `cosmos-storage` route.

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
    startTime: new Date(),
  });

  // Notify device via SignalR about new cook
  await signalRService.sendToGroup(`device-${request.deviceId}`, 'cookStarted', {
    cookId: newCook.id,
    deviceId: request.deviceId,
    name: newCook.name,
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
      operationId: 'startCook',
    },
    request => startCookHandler(request, context, req)
  );
};
```

**Temperature History Function**:

```typescript
// apps/api/src/functions/temperatures/get-cook-history.ts
import { HttpTrigger } from '@azure/functions';
import { CosmosClient } from '@meatgeekv2/azure-client';
import { TemperatureReading } from '@meatgeekv2/api-interfaces';

async function getCookHistoryHandler(
  cookId: string,
  context: Context
): Promise<TemperatureReading[]> {
  const cosmosClient = new CosmosClient();

  // Query temperatures for specific cook
  // Data is already stored with cookId from direct IoT Hub routing
  const query = {
    query: 'SELECT * FROM c WHERE c.cookId = @cookId ORDER BY c.timestamp ASC',
    parameters: [{ name: '@cookId', value: cookId }],
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
    const traceParent =
      eventData.systemProperties?.['traceparent'] ||
      eventData.properties?.['traceparent'] ||
      eventData.applicationProperties?.['traceparent'];

    return TracingHelper.extractTraceContext(traceParent);
  }

  /**
   * Get device metadata from Event Hub message
   */
  static getDeviceMetadata(eventData: EventData): { deviceId: string; cookId?: string } {
    // IoT Hub enriches messages with device metadata
    const deviceId =
      eventData.systemProperties?.['iothub-connection-device-id'] ||
      eventData.properties?.['device.id'] ||
      eventData.applicationProperties?.['device.id'];

    const cookId =
      eventData.properties?.['cook.id'] || eventData.applicationProperties?.['cook.id'];

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
reached **identity-based**: those settings carry only **non-secret endpoints**,
and data-plane access is granted by RBAC role assignments on the identity. **No
service data-plane credential or key VALUE is USED** — no Cosmos/Storage/IoT/SignalR
connection string or primary key is placed in `app_settings` or surfaced as a
Terraform output.

Those keys are **not, however, absent from Terraform state**. Every TF-managed
data service exposes its own key / connection-string as an **inherent computed
attribute**, and Terraform reads those attributes back into state on each apply
**by construction** — no `azurerm` argument suppresses them. So the Cosmos
account's keys, the Storage account's access keys, the SignalR service's access
key, the Event Hubs namespace's auto-created `RootManageSharedAccessKey`, and the
IoT Hub's SAS policy keys are all present in state. The security
posture is not "no keys in state," it is **keys that cannot authenticate**:
local/key auth is **disabled** on the services where doing so is safe —
`local_authentication_enabled = false` on Cosmos, `local_auth_enabled = false`
on SignalR, `shared_access_key_enabled = false` on the Functions storage account
(Flex deployment storage is `storage_authentication_type = "SystemAssignedIdentity"`), and
`local_authentication_enabled = false` on the Event Hubs namespace (both its
producer — the identity-based IoT Hub routing endpoint — and its consumer — the
Function App via _Azure Event Hubs Data Receiver_ — are AAD, so the RootManage key
is unused). For those four the in-state
key is a **present-but-non-authenticating residual**. **IoT Hub is the SOLE
documented exception:** its SAS keys stay **live** because real devices, the
data-pusher, and the device-controller authenticate with them (the device SDKs'
supported path), so disabling local auth would sever device connectivity; that
residual is mitigated by **restricted, container-scoped RBAC state access** and
SAS-key rotation. The App Insights connection string is the same class of
residual: the full App Insights value **including its `InstrumentationKey`** is
present in the Flex `site_config.application_insights_connection_string` field
(surfaced to the host, unchanged, as the `APPLICATIONINSIGHTS_CONNECTION_STRING`
runtime env var) and state, but that ikey is a **non-authenticating
destination identifier**, not a credential —
`local_authentication_enabled = false` on the App Insights resource forces
AAD-only ingestion, so the ikey cannot authenticate anything (see the detailed
note below). Each acceptance holds **only while local/key auth stays disabled**
on Cosmos / SignalR / Storage / Event Hubs namespace / App Insights, a coupling
**fail-closed enforced** by the pre-apply `tf-plan-secret-inspection.sh` gate
(which also accepts the IoT Hub keys with a printed note as the acknowledged
exception). See
[ADR: Data-service keys in Terraform state](../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md).

These are exactly the settings Terraform configures on the Function App:

```bash
# Runtime — declared natively on the Flex resource, NOT via app settings. Node 24
# is set through runtime_name = "node" / runtime_version = "24". FUNCTIONS_WORKER_RUNTIME
# is intentionally NOT present: Flex Consumption REJECTS it as an app setting, failing
# the create with 400 BadRequest (ExtendedCode 51021, "app setting … is invalid for
# Flex Consumption sites"). WEBSITE_NODE_DEFAULT_VERSION is likewise Flex-deprecated
# and not set (MG-24).

# Host storage — identity-based, account-name form (MG-58). A NAME, not a
# credential: the host resolves it with the managed identity, so it works with
# allowSharedKeyAccess=false. The scalar AzureWebJobsStorage connection string is
# deliberately ABSENT (the host reads it before this form, and with shared keys
# disabled it kills host storage); the module tests assert both.
AzureWebJobsStorage__accountName=<functions-storage-account-name>

# Application Insights — identity-based (AAD) telemetry ingestion. The managed
# identity holds "Monitoring Metrics Publisher" on the App Insights resource and
# the host authenticates with an AAD token (APPLICATIONINSIGHTS_AUTHENTICATION_STRING,
# an app setting). The connection string itself is NOT an app setting: it is wired
# via the Flex resource's NATIVE site_config.application_insights_connection_string
# field (moved there to kill a perpetual second-plan diff — Azure reflects the value
# into that computed field), and Azure surfaces it to the host UNCHANGED as the
# APPLICATIONINSIGHTS_CONNECTION_STRING runtime env var shown below. It is the FULL
# connection string — InstrumentationKey included, because Microsoft requires the
# ikey as the destination-resource identifier even under Entra-only ingestion — but
# that ikey CANNOT authenticate: local_authentication_enabled=false on the App
# Insights resource forces AAD-only ingestion, so the ikey is an inert, non-credential
# identifier, not a secret to protect.
APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD
APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=<ikey>;IngestionEndpoint=<insights-ingestion-endpoint>;LiveEndpoint=<insights-live-endpoint>
APPLICATIONINSIGHTS_SAMPLING_PERCENTAGE=50

# Cosmos DB — identity-based. NON-SECRET account endpoint only; the managed
# identity holds a Cosmos SQL data-plane role assignment.
COSMOSDB__accountEndpoint=<cosmos-account-endpoint>

# Which database inside that account. A plain app setting (not a `__`-suffixed
# identity binding) — the API reads it itself via `environment.cosmosDb.databaseName`.
# Terraform-owned (module.cosmos_db.destination_database_name — the MG-53
# shared-throughput destination the MG-62 cutover repointed both dev consumers
# onto) and REQUIRED: the module input has no default and validates non-empty,
# so a caller that omits it fails at `terraform plan` rather than shipping an
# app pointed at a database that does not exist (MG-51).
COSMOSDB_DATABASE_NAME=<cosmos-database-name>

# Which container inside that database the cooks handlers read and write
# (MG-59). A plain app setting (not a `__`-suffixed identity binding) — the API
# reads it itself. Terraform-owned (module.cosmos_db.destination_container_names.cooks)
# and REQUIRED: no default, so a caller that omits it fails at `terraform plan`
# rather than shipping a cooks adapter pointed at a container that does not exist.
COSMOSDB_COOKS_CONTAINER_NAME=<cosmos-cooks-container-name>

# The other entity containers in the same database (HAR-19), published the same
# way: Terraform-owned (module.cosmos_db.destination_container_names.<entity>),
# required, no default. The devices handlers read COSMOSDB_DEVICES_CONTAINER_NAME
# (HAR-20), GET /temperatures/current and /temperatures/history read
# COSMOSDB_TEMPERATURES_CONTAINER_NAME (HAR-28, HAR-35), the users handlers read
# COSMOSDB_USERS_CONTAINER_NAME (HAR-27) and the recipes handlers read
# COSMOSDB_RECIPES_CONTAINER_NAME (HAR-36); the shared adapter fails loud without
# each (cosmos_devices_container_not_configured,
# cosmos_temperatures_container_not_configured, cosmos_users_container_not_configured,
# cosmos_recipes_container_not_configured).
COSMOSDB_DEVICES_CONTAINER_NAME=<cosmos-devices-container-name>
COSMOSDB_TEMPERATURES_CONTAINER_NAME=<cosmos-temperatures-container-name>
COSMOSDB_USERS_CONTAINER_NAME=<cosmos-users-container-name>
COSMOSDB_RECIPES_CONTAINER_NAME=<cosmos-recipes-container-name>

# The cook chart read model (HAR-74): per-device, per-hour temperature rollups,
# and the lease container for the Cosmos DB change-feed trigger. Terraform-owned
# (module.cosmos_db.destination_container_names.temperature_rollups / .leases).
# Nothing in the API reads them yet; the change-feed function is a later issue.
COSMOSDB_TEMPERATURE_ROLLUPS_CONTAINER_NAME=<cosmos-temperature-rollups-container-name>
COSMOSDB_LEASES_CONTAINER_NAME=<cosmos-leases-container-name>

# IoT telemetry (Event Hubs-compatible) — identity-based. NON-SECRET
# fully-qualified namespace only; the managed identity holds Azure Event Hubs
# Data Receiver.
IOTHUB_EVENTS__fullyQualifiedNamespace=<iot-eventhub-namespace-fqdn>

# The API's own consumer group on the temperature-data Event Hub (HAR-56), for
# the live-reading broadcast trigger. A non-secret name, Terraform-owned
# (module.iot_hub.temperature_broadcast_consumer_group_name, "api-broadcast").
# The trigger connects through the IOTHUB_EVENTS__ prefix above, so there is no
# second Event Hub setting. Read by broadcastTemperature (HAR-60) as the
# binding expression %TEMPERATURE_BROADCAST_CONSUMER_GROUP%.
TEMPERATURE_BROADCAST_CONSUMER_GROUP=api-broadcast

# IoT Hub service hostname (HAR-56), a bare hostname such as
# <name>.azure-devices.net. Non-secret, Terraform-owned (module.iot_hub.hostname).
# Read by startCook and stopCook (HAR-66), which write the device twin's desired
# activeCookId / correlationId through the IoT Hub service REST API
# (api-version 2021-04-12) under the managed identity; see
# apps/api/src/shared/iothub/device-twin.ts. Missing or not a bare hostname, a
# start or stop answers 503 DEVICE_TWIN_UPDATE_FAILED with reason
# iothub_configuration_failed (the cook is still written). The identity's
# IoT Hub Twin Contributor grant is switched by api_device_twin_writer_enabled
# (default false): ON in dev since HAR-64, OFF in prod, where twin writes fail.
IOTHUB_SERVICE_HOSTNAME=<iot-hub-hostname>

# SignalR — identity-based. NON-SECRET service URI only; the managed identity
# holds SignalR Service Owner.
AzureSignalRConnectionString__serviceUri=<signalr-service-uri>

# Which environment the app runs in: "dev" or "prod" (HAR-17). A plain,
# non-secret label from the root's `environment` variable; the functions module
# input has no default and validates dev/prod. No app code reads it yet.
MEATGEEK_ENVIRONMENT=<dev|prod>
```

> The `__accountEndpoint` / `__fullyQualifiedNamespace` / `__serviceUri` suffixes
> are the Functions host's convention for identity-based bindings: the host
> resolves each service using the app's managed identity against the non-secret
> endpoint, so **no service key is written to app settings**. The Flex deployment
> storage is likewise identity-based (`storage_authentication_type =
"SystemAssignedIdentity"`), so no storage account
> key reaches app settings either. (The services' inherent keys still exist as
> computed attributes in Terraform state, made non-authenticating by disabling
> local/key auth — IoT Hub excepted — as described above.)
>
> Application Insights follows the same identity-based model: telemetry is
> published with an AAD token — `APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD`
> plus a **Monitoring Metrics Publisher** role assignment on the App Insights
> resource. `APPLICATIONINSIGHTS_CONNECTION_STRING` is the **full**
> Terraform-managed connection string, **`InstrumentationKey` included** —
> Microsoft requires the ikey as the **destination-resource identifier** even
> under Entra-only ingestion, so the endpoint-only value is not used. That ikey
> **cannot authenticate ingestion**: the App Insights resource sets
> **`local_authentication_enabled = false`**, so only an AAD token (Monitoring
> Metrics Publisher) is accepted and an ikey-only client is rejected. It is
> wired via the Flex `site_config.application_insights_connection_string` field
> (not an app setting) and Azure surfaces it to the host unchanged as the
> `APPLICATIONINSIGHTS_CONNECTION_STRING` env var. The ikey
> therefore lands in that `site_config` field and in Terraform state as an **inert,
> non-credential** telemetry-destination identifier — an accepted residual that
> is safe **only while local auth stays disabled**, a coupling enforced by the
> pre-apply secret-inspection gate. See
> [ADR: App Insights instrumentation key remains in Terraform state](../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md).

## Function Deployment

### **Development Deployment**:

**Do not use `nx deploy api` against dev.** The `deploy` target in
`apps/api/project.json` runs a bare `func azure functionapp publish` — no
`--javascript`, no `--no-build`, and no `--omit=dev` install inside
`dist/apps/api` — and that does **not** work on Flex Consumption. The recipe that
does (MG-21) is written out once, in the deployment section of the MG-58 runbook,
and this page deliberately does not copy it: a deploy recipe duplicated across
three files is a recipe with three chances to go stale, and it had already gone
stale here.

➡️ **[MG-58 runbook → §3 Deploy the app build](../infrastructure/mg58-host-storage-verification.md#3-deploy-the-app-build-carrying-the-timer-probe)** — the authoritative dev deploy sequence (`nx build api` → `npm install --omit=dev` inside `dist/apps/api` → `func azure functionapp publish <app> --javascript --no-build`).

### **Production Deployment**:

```bash
# Build optimized production bundle
nx build api --configuration=production
nx deploy api --functionApp=<prod Function App name>
```

> In production this runs from CI, not by hand. The `app-deploy-prod.yml` workflow invokes `nx deploy api --functionApp=<prod Function App name>` automatically **after the CI/CD Pipeline completes green on a push to `main`**, gated by the `PROD_DEPLOY_ENABLED` repository variable. See [CI/CD Pipeline → Prod](../development/ci-cd.md#prod).
>
> ⚠️ **UNVERIFIED ON FLEX CONSUMPTION.** This is the command the prod workflow
> actually runs today, so it is recorded as-is rather than quietly rewritten —
> but it is the same bare `nx deploy api` target that fails on Flex in dev, and
> no prod deploy has been observed succeeding against a Flex-hosted prod app. It
> is written down here as the current state, **not** as a validated path. Before
> the first prod deploy, either the target is brought up to the MG-58 §3 recipe
> or this path is proven on Flex and the warning removed.

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
