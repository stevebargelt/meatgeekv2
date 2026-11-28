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
| `getCookChart`           | HTTP `GET`    | `cooks/{cookId}/chart`            | HAR-86 — the whole cook as ≤ 720 points, from the rollups     |
| `stopCook`               | HTTP `POST`   | `cooks/{cookId}/stop`             | Stop a cook (emits `cook_stopped` on SignalR)                 |
| `updateCookTargets`      | HTTP `PUT`    | `cooks/{cookId}/targets`          | #240 — set, change, clear a running cook's targets (re-arms)  |
| `negotiate`              | HTTP `POST`   | `negotiate`                       | SignalR client negotiate: a token for the caller's userId     |
| `getCurrentTemperatures` | HTTP `GET`    | `temperatures/current/{deviceId}` | Latest reading for a caller's device (404 else)               |
| `getTemperatureHistory`  | HTTP `GET`    | `temperatures/history`            | A page of a caller's device's readings, by continuation token |
| `getDevices`             | HTTP `GET`    | `devices`                         | List the caller's devices                                     |
| `claimDevice`            | HTTP `POST`   | `devices/claim`                   | HAR-130 — claim a device with the code it shows (403 else)    |
| `getDevice`              | HTTP `GET`    | `devices/{id}`                    | One of the caller's devices (404 otherwise)                   |
| `updateDevice`           | HTTP `PATCH`  | `devices/{id}`                    | Change name / location / configuration                        |
| `deleteDevice`           | HTTP `DELETE` | `devices/{id}`                    | HAR-136 — release one of the caller's devices                 |
| `getUserProfile`         | HTTP `GET`    | `users/me`                        | The caller's profile (404 until the first PUT)                |
| `putUserProfile`         | HTTP `PUT`    | `users/me`                        | Create or replace the caller's profile                        |
| `listPushTokens`         | HTTP `GET`    | `users/me/push-tokens`            | #244 — the caller's phones, by id (the token's SHA-256)       |
| `registerPushToken`      | HTTP `POST`   | `users/me/push-tokens`            | #244 — registers a phone's APNs token, sent in the body       |
| `deletePushToken`        | HTTP `DELETE` | `users/me/push-tokens/{tokenId}`  | #244 — removes a phone; 204 also when it is not registered    |
| `listRecipes`            | HTTP `GET`    | `recipes`                         | List the caller's recipes, newest first                       |
| `createRecipe`           | HTTP `POST`   | `recipes`                         | Create a recipe owned by the caller                           |
| `getRecipe`              | HTTP `GET`    | `recipes/{id}`                    | One of the caller's recipes (404 otherwise)                   |
| `updateRecipe`           | HTTP `PATCH`  | `recipes/{id}`                    | Change any recipe field (409 on a race)                       |
| `deleteRecipe`           | HTTP `DELETE` | `recipes/{id}`                    | Delete one of the caller's recipes                            |
| `cosmosHealth`           | HTTP `GET`    | `health/cosmos`                   | MG-51 — probes the API's own path to Cosmos                   |
| `apnsHealth`             | HTTP `GET`    | `health/apns`                     | #243 — signs a provider token through Key Vault and checks Apple accepts it |
| `storageHeartbeat`       | **Timer**     | `0 */15 * * * *` (every 15 min)   | MG-58 — the host-storage proof path                           |
| `broadcastTemperature`   | **Event Hub** | `temperature-data`, many          | HAR-60 — pushes each reading to its device's owner            |
| `recordTargetsReached`   | **Event Hub** | `temperature-data`, many          | Records on each running cook which targets are reached, and alerts the owner's phones (#244) |
| `rollupTemperatures`     | **Cosmos DB** | `temperatures` change feed        | HAR-86 — folds readings into per-device, per-hour rollups     |

`broadcastTemperature` is the live-reading producer. IoT Hub routes every device
message to the `temperature-data` event hub (`eventhub-realtime-route` in
`apps/infrastructure/modules/iot-hub/main.tf`); the trigger reads it in batches
(`cardinality: 'many'`) on the API's own consumer group,
`%TEMPERATURE_BROADCAST_CONSUMER_GROUP%` (`api-broadcast`), through the
identity-based `IOTHUB_EVENTS` connection. Each event becomes one SignalR message
on the shared output binding (hub `temperatureHub`):

```json
{
  "target": "temperature",
  "userId": "<the device owner's userId>",
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
- An event with no device id, a non-JSON body, or no timestamp is skipped and
  counted, never thrown, so one bad event does not fail or replay the batch.
- **Addressed to the owner (HAR-81).** `userId` is the `userId` stored on the
  device, read once per distinct device per batch (a point read, partition key =
  device id). A device with no stored owner is not pushed (`unowned`); a failed
  owner read drops that device's readings from this batch's push
  (`lookupFailed`). The readings are still stored either way. A change of owner
  takes effect at the next reading.
- Each batch logs one line,
  `broadcastTemperature sent=<n> skipped=<m> unowned=<u> lookupFailed=<f>`, with
  no ids, owners or bodies.
- negotiate makes one SignalR REST call, the token. Before HAR-81 readings went
  to `device-{id}` groups, and negotiate re-added the caller to one group per
  owned device on every call. With the acceptance owner's 98 devices, two
  negotiates in a row sent about 200 REST calls in under 2 s, and the Free_F1
  service answered 429 to group adds and to client connects alike. The token
  call still retries a `429` or `503` answer up to 3 times (waiting for
  `Retry-After`, capped at 2 s, or 200/400/800 ms) before negotiate answers 503
  (HAR-80).

`rollupTemperatures` and `getCookChart` are the cook chart (HAR-86). A 12-hour
cook is about 8,640 readings, and reading them all would cost hundreds of RU per
chart against the shared 400 RU/s offer, so the chart reads a reduced series
instead.

- **The trigger.** `app.cosmosDB` on the `temperatures` container
  (`%COSMOSDB_TEMPERATURES_CONTAINER_NAME%` in `%COSMOSDB_DATABASE_NAME%`),
  through the identity-based `COSMOSDB` connection (`COSMOSDB__accountEndpoint`;
  the app identity holds Cosmos DB Built-in Data Contributor at account scope).
  Its leases live in the Terraform-made `leases` container
  (`%COSMOSDB_LEASES_CONTAINER_NAME%`, HAR-74) and
  `createLeaseContainerIfNotExists` is `false`, because data-plane RBAC cannot
  create containers. `startFromBeginning: true` rolls up the readings already
  stored the first time the lease is created; after that it has no effect.
- **The documents.** One per device per UTC hour in `temperature-rollups`
  (`COSMOSDB_TEMPERATURE_ROLLUPS_CONTAINER_NAME`, partition `/deviceId`), id
  `<deviceId>:<yyyy-mm-ddThh>` (the device id URI-encoded), with `deviceId`,
  `hourStart` (ISO, UTC) and `slots` keyed by minute `0`..`59`. Each slot holds,
  per channel (`grill`, `probe1`..`probe4`), `{n, min, max, sum}`. A channel a
  reading does not carry is not counted.
- **The fold.** Each changed document goes through `toTemperatureReading` with its
  own `deviceId`, so the device is the hub identity and the time is
  `Body.timestamp`, else the enqueued time (MG-73). Documents that do not map are
  skipped. The whole batch is folded in memory, then each touched hour document
  gets **one** read-merge-replace with `IfMatch` on its etag. A 412 (replaced
  since the read) or a 409 (created since the read) starts again from a fresh
  read, at most 5 times; then the batch throws.
- **Failure.** Any failure is logged as a fixed code
  (`rollupTemperatures failed: <code>`) and thrown. With the Cosmos DB extension
  4.x an unhandled exception leaves the lease un-checkpointed, so the change feed
  delivers the batch again. Each batch logs one line,
  `rollupTemperatures documents=<n> readings=<r> skipped=<s> buckets=<b> requestCharge=<ru>`,
  with no ids.
- **At-least-once.** The change feed delivers each reading at least once. A batch
  that was written but not checkpointed (a host crash between the two, or a
  failure part-way through a batch) is folded again, which double-counts `n` and
  `sum` for those readings and leans that minute's average towards them. `min`
  and `max` are unaffected. This is accepted: exactly-once would need a write per
  reading, which is the cost the read model exists to avoid.
- **Throughput.** `maxItemsPerInvocation: 100` keeps each backfill batch to one
  or two hour documents and about 5 RU of change-feed read.
  `feedPollDelay: 30000` makes a drained feed poll every 30 s, so a device
  reporting every 5 s costs one document write per 30 s rather than per 5 s; the
  chart can lag by up to 30 s. Because the poll delay does not apply while a
  backlog drains, the handler also paces itself: it does not return until its
  writes' RU at 100 RU/s have elapsed, a quarter of the shared offer.
- **The chart.** `GET /cooks/{cookId}/chart` point-reads the cook in the caller's
  partition, as `GET /cooks/{cookId}` does (absent, another user's and a lock id
  are 404 `NOT_FOUND`; a bad id is 400). A stopped cook covers
  `[startTime, endTime)`; an active cook covers every reading from `startTime`
  on, with no upper bound. One single-partition query reads the device's hour
  documents from the hour containing `startTime` (and before `endTime`), minute
  slots outside the window are dropped, and the minutes are merged into the
  smallest of 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400 and 21600 s
  buckets that keeps the chart at 720 points or fewer. Each channel of a point is
  `{min, max, avg}` with `avg = Σsum / Σn`; empty buckets and channels are left
  out. `x-meatgeek-request-charge` is the cook and device point reads plus every
  query page. HAR-136: for a device the caller claimed, the window starts no
  earlier than the first whole minute at or after its `claimedAt`.

`deleteDevice` releases a device (HAR-85, made a release by HAR-136; see
[the HAR-130 decision](../../learnings/decisions/har-130-device-provisioning-and-claim.md)).
In order:

- `403 DEVICE_NOT_OWNED`: someone else owns it; `404 DEVICE_NOT_FOUND`: no
  device has that id, a second release included. One point read decides both.
- `409 COOK_ACTIVE`: the caller has an active cook on it (the MG-84
  `active-device:<deviceId>` lock in the caller's partition, a point read, and
  the cook it names when there is one, so a stale lock does not block). Stop the
  cook first; nothing changes.
- The device twin: desired `claimGeneration` + 1 (absent counts as `"0"`) and
  `claimClaimantHash: null` under `If-Match`, keeping `claimConsumedCodeHash`;
  a 412 re-reads once. The device mints a fresh code for the new generation, and
  the old code can never claim again. A device with no IoT Hub identity (IoT
  Hub 404, registered through the first-come `POST /devices` before HAR-145
  removed it) skips this step. Any other twin
  failure is `503 DEVICE_TWIN_UPDATE_FAILED`, and the document is kept, so a
  retry is safe.
- `204`, no body: the document is deleted.

Unlike `getDevice` and `updateDevice`, which answer `404` for both, a release
tells a foreign device from an unknown one, as the cook routes' `403` does.
Every answer after the principal check carries `x-meatgeek-request-charge`.
Only the device document goes. Its cooks stay in the owner's history (`getCooks`
and `getCook` still return them), and its readings expire on the `temperatures`
readings' own TTL ([ADR 0001](../adr/0001-readings-are-short-lived-charts-are-permanent.md):
7 days in a cook, 24 hours outside one).

**Readings from the claim onward (HAR-136).** A device with `claimedAt` (claimed
through `claimDevice`) bounds every route that returns its readings below by
`claimedAt`, inside the query: `getCurrentTemperatures` counts only a reading
enqueued at or after it (none is `404 NO_READINGS`), `getTemperatureHistory`
uses the later of `startTime` and `claimedAt`, and `getCookChart` starts at the
first whole minute at or after it. Readings from before the claim, while the
device was unclaimed or another owner's, never reach the new owner. A device
without `claimedAt` (registered through `POST /devices` before HAR-145 removed
it) is not bounded.

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

#### Target rule

`recordTargetsReached`
(`apps/api/src/functions/cooks/record-targets-reached.ts`) reads the same
`temperature-data` event hub on its own consumer group,
`%TARGETS_CONSUMER_GROUP%` (`api-targets`), and records on each running cook
which channels have reached their target (`targetsReached` on the cook). It has
no SignalR output and is a separate invocation from `broadcastTemperature`, so
it can never delay or drop a live push. Each reach is sent as an alert through
APNs to every phone the cook's owner registered (#244). A batch whose cook
write failed, or whose alert Apple gave no answer for, throws and is retried
by the host. The rule, its state and its failure handling are in
[Data Flow](../architecture/data-flow.md#6-target-rule).

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
# Since HAR-86 the shared adapter reads COSMOSDB_TEMPERATURE_ROLLUPS_CONTAINER_NAME
# (the rollupTemperatures trigger writes it, GET /cooks/{cookId}/chart reads it;
# cosmos_temperature_rollups_container_not_configured without it), and the trigger
# names COSMOSDB_LEASES_CONTAINER_NAME as %COSMOSDB_LEASES_CONTAINER_NAME%.
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

# The target rule's own consumer group on the same Event Hub. Non-secret,
# Terraform-owned (module.iot_hub.targets_consumer_group_name, "api-targets").
# Read by recordTargetsReached as %TARGETS_CONSUMER_GROUP%.
TARGETS_CONSUMER_GROUP=api-targets

# IoT Hub service hostname (HAR-56), a bare hostname such as
# <name>.azure-devices.net. Non-secret, Terraform-owned (module.iot_hub.hostname).
# Read by startCook and stopCook (HAR-66), which write the device twin's desired
# activeCookId / correlationId through the IoT Hub service REST API
# (api-version 2021-04-12) under the managed identity; see
# apps/api/src/shared/iothub/device-twin.ts. Missing or not a bare hostname, a
# start or stop answers 503 DEVICE_TWIN_UPDATE_FAILED with reason
# iothub_configuration_failed (the cook is still written). claimDevice
# (HAR-130) reads the twin's reported claim-code hash and patches its desired
# claim properties through the same client; without the setting a claim
# answers 503 DEVICE_TWIN_UPDATE_FAILED and nothing is stored. The identity's
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
>
> Only the Functions **host** reads `APPLICATIONINSIGHTS_AUTHENTICATION_STRING`.
> The Node worker's Azure Monitor distro does not; it authenticates only when
> given a credential. `apps/api/src/shared/telemetry/setup.ts` therefore reads
> the same setting and, when it says `Authorization=AAD`, passes a
> `ManagedIdentityCredential` (with `ClientId=` for a user-assigned identity) as
> `azureMonitorExporterOptions.credential`. Without it every span, log and
> metric the worker exports (including the `meatgeek.reading.*` histograms) is
> rejected by the resource (HAR-150).

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
