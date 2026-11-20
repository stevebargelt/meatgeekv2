import { app } from '@azure/functions';

// Initialise Azure Monitor OpenTelemetry BEFORE any handler registration so the
// SDK instruments the Functions host from the first invocation. No-op locally /
// in CI when APPLICATIONINSIGHTS_CONNECTION_STRING is unset.
import { initializeTelemetry } from './shared/telemetry/setup';

initializeTelemetry();

// Import function handlers
import { getCookHandler } from './functions/cooks/get-cook';
import { getCookChartHandler } from './functions/cooks/get-cook-chart';
import { getCooksHandler } from './functions/cooks/list-cooks';
import { startCookHandler } from './functions/cooks/start-cook';
import { stopCookHandler } from './functions/cooks/stop-cook';
import { negotiateHandler } from './functions/signalr/negotiate';
import { signalROutput } from './functions/signalr/envelope';
import {
  broadcastTemperatureHandler,
  TEMPERATURE_EVENT_HUB,
} from './functions/signalr/broadcast-temperature';
import { getCurrentTemperaturesHandler } from './functions/temperatures/get-current';
import { getTemperatureHistoryHandler } from './functions/temperatures/get-history';
import {
  ROLLUP_TRIGGER_SETTINGS,
  rollupTemperaturesHandler,
} from './functions/temperatures/rollup-temperatures';
import { getDevicesHandler } from './functions/devices/get-devices';
import { getDeviceHandler } from './functions/devices/get-device';
import { registerDeviceHandler } from './functions/devices/register-device';
import { updateDeviceHandler } from './functions/devices/update-device';
import { getUserProfileHandler } from './functions/users/get-user-profile';
import { putUserProfileHandler } from './functions/users/put-user-profile';
import { listRecipesHandler } from './functions/recipes/list-recipes';
import { createRecipeHandler } from './functions/recipes/create-recipe';
import { getRecipeHandler } from './functions/recipes/get-recipe';
import { updateRecipeHandler } from './functions/recipes/update-recipe';
import { deleteRecipeHandler } from './functions/recipes/delete-recipe';
import { cosmosHealthHandler } from './functions/health/cosmos-health';
import {
  STORAGE_HEARTBEAT_SCHEDULE,
  storageHeartbeatHandler,
} from './functions/health/storage-heartbeat';

// Register HTTP triggers
app.http('getCooks', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cooks',
  handler: getCooksHandler,
});

app.http('startCook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cooks',
  extraOutputs: [signalROutput],
  handler: startCookHandler,
});

// HAR-75: one of the caller's cooks. A point read in the caller's partition,
// so another user's cook and an absent one are the same 404.
app.http('getCook', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cooks/{cookId}',
  handler: getCookHandler,
});

// HAR-86: the whole cook as at most 720 points, read from the rollup documents
// rollupTemperatures (below) writes. Ownership is the cook point read, as for
// getCook: another user's cook is a 404.
app.http('getCookChart', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cooks/{cookId}/chart',
  handler: getCookChartHandler,
});

app.http('stopCook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cooks/{cookId}/stop',
  extraOutputs: [signalROutput],
  handler: stopCookHandler,
});

// SignalR client negotiate endpoint.
//
// AC4: authLevel stays 'anonymous' at the Functions runtime ON PURPOSE. The
// MG-24 platform layer (Easy Auth / auth_settings_v2 with
// require_authentication=true and unauthenticated_action=Return401) validates
// the Entra bearer token BEFORE any function executes, so negotiate is NOT
// anonymous end-to-end. Adding a per-function key here would be a competing,
// redundant auth gate — do NOT do it.
//
// DEC-4 (HAR-57, MG-30): a negotiated connection is scoped to the caller, not
// to a device the caller names. The handler takes the userId from the Easy Auth
// principal ("<tid>:<oid>"), mints the client token for that userId through the
// SignalR data-plane REST API (managed identity; the SignalR connection-info
// input binding cannot express this userId), and resets the user's group membership
// to `device-{id}` for exactly the devices the caller owns. Any `deviceId` query
// parameter is ignored. Cook events (startCook, stopCook) are sent to the owning
// user's userId; device readings go to the `device-{id}` groups.
app.http('negotiate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'negotiate',
  handler: negotiateHandler,
});

// HAR-60: live readings by push. IoT Hub routes every device message to the
// temperature-data event hub; this trigger reads it on the API's own consumer
// group and sends each reading to its device's `device-{id}` SignalR group, the
// groups negotiate puts each owner in. The connection is identity-based
// (IOTHUB_EVENTS__fullyQualifiedNamespace; the app identity holds Azure Event
// Hubs Data Receiver), so no Event Hub key is in app settings.
app.eventHub('broadcastTemperature', {
  connection: 'IOTHUB_EVENTS',
  eventHubName: TEMPERATURE_EVENT_HUB,
  consumerGroup: '%TEMPERATURE_BROADCAST_CONSUMER_GROUP%',
  cardinality: 'many',
  extraOutputs: [signalROutput],
  handler: broadcastTemperatureHandler,
});

// HAR-86: the cook chart's read model. A change-feed trigger on `temperatures`
// folds each batch of stored readings into per-device, per-hour documents in
// `temperature-rollups`. Identity-based (COSMOSDB__accountEndpoint; the app
// identity holds Cosmos DB Built-in Data Contributor at account scope). The
// `leases` container is Terraform's (HAR-74): data-plane RBAC cannot create
// containers, so createLeaseContainerIfNotExists is false. startFromBeginning
// rolls up the readings already stored when the lease is first created. The
// batch size and poll delay are explained at ROLLUP_TRIGGER_SETTINGS. The change
// feed is at-least-once; see temperature-rollups-repository.ts.
app.cosmosDB('rollupTemperatures', {
  connection: 'COSMOSDB',
  databaseName: '%COSMOSDB_DATABASE_NAME%',
  containerName: '%COSMOSDB_TEMPERATURES_CONTAINER_NAME%',
  leaseContainerName: '%COSMOSDB_LEASES_CONTAINER_NAME%',
  createLeaseContainerIfNotExists: false,
  startFromBeginning: true,
  maxItemsPerInvocation: ROLLUP_TRIGGER_SETTINGS.maxItemsPerInvocation,
  feedPollDelay: ROLLUP_TRIGGER_SETTINGS.feedPollDelay,
  handler: rollupTemperaturesHandler,
});

app.http('getCurrentTemperatures', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'temperatures/current/{deviceId}',
  handler: getCurrentTemperaturesHandler,
});

// HAR-35 (MG-79 part 2): a page of an owned device's readings. The query
// parameters carry the filter; there is no {deviceId} in the route.
app.http('getTemperatureHistory', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'temperatures/history',
  handler: getTemperatureHistoryHandler,
});

app.http('getDevices', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'devices',
  handler: getDevicesHandler,
});

app.http('registerDevice', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'devices',
  handler: registerDeviceHandler,
});

app.http('getDevice', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'devices/{id}',
  handler: getDeviceHandler,
});

app.http('updateDevice', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'devices/{id}',
  handler: updateDeviceHandler,
});

// HAR-27 (MG-81): the caller's own profile. Identity is the Easy Auth
// principal; there is no {id} in the route.
app.http('getUserProfile', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'users/me',
  handler: getUserProfileHandler,
});

app.http('putUserProfile', {
  methods: ['PUT'],
  authLevel: 'anonymous',
  route: 'users/me',
  handler: putUserProfileHandler,
});

// HAR-36 (MG-82): the caller's recipes, private to the owner. The recipes
// container is partitioned on /userId, so every call stays in the caller's
// partition.
app.http('listRecipes', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'recipes',
  handler: listRecipesHandler,
});

app.http('createRecipe', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'recipes',
  handler: createRecipeHandler,
});

app.http('getRecipe', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'recipes/{id}',
  handler: getRecipeHandler,
});

app.http('updateRecipe', {
  methods: ['PATCH'],
  authLevel: 'anonymous',
  route: 'recipes/{id}',
  handler: updateRecipeHandler,
});

app.http('deleteRecipe', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'recipes/{id}',
  handler: deleteRecipeHandler,
});

// Cosmos health probe (MG-51). Registered alongside the business endpoints on
// purpose: it must run inside the deployed app, with the app's own settings and
// managed identity, or it proves nothing about the API's path to Cosmos.
//
// authLevel stays 'anonymous' for the same reason as the endpoints above — the
// platform-layer Easy Auth gate (auth_settings_v2) validates the bearer token
// before any function executes, so this is not anonymous end-to-end.
app.http('cosmosHealth', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health/cosmos',
  handler: cosmosHealthHandler,
});

// Host-storage heartbeat (MG-58). The ONLY timer in this app: the host keeps
// this timer's schedule status and singleton lease in the host storage account,
// so the invocation itself is the proof that host storage authenticates. When it
// was added, every other registration was an HTTP trigger, which needs no host
// storage — which is why the host sat Unhealthy for weeks while all of them
// answered 200. Since HAR-60, broadcastTemperature also uses host storage (Event
// Hub partition leases and checkpoints); the heartbeat stays the dedicated proof.
app.timer('storageHeartbeat', {
  schedule: STORAGE_HEARTBEAT_SCHEDULE,
  handler: storageHeartbeatHandler,
});

console.log('MeatGeek V2 API Functions registered successfully');
