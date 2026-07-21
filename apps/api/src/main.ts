import { app } from '@azure/functions';

// Import function handlers
import { getCooksHandler } from './functions/cooks/list-cooks';
import { startCookHandler } from './functions/cooks/start-cook';
import { stopCookHandler } from './functions/cooks/stop-cook';
import { negotiateHandler, signalRConnInfoInput } from './functions/signalr/negotiate';
import { signalROutput } from './functions/signalr/envelope';
import { getCurrentTemperaturesHandler } from './functions/temperatures/get-current';
import { getDevicesHandler } from './functions/devices/get-devices';

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
// DEC-4: per-device scoping uses userId = deviceId, taken from the request
// `deviceId` query param (see signalRConnInfoInput). The caller is
// authenticated at the platform layer, but device ownership is not yet bound to
// the caller's identity — a caller could negotiate for a deviceId they do not
// own. Binding ownership to identity is tracked as MG-30.
app.http('negotiate', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'negotiate',
  extraInputs: [signalRConnInfoInput],
  handler: negotiateHandler,
});

app.http('getCurrentTemperatures', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'temperatures/current/{deviceId}',
  handler: getCurrentTemperaturesHandler,
});

app.http('getDevices', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'devices',
  handler: getDevicesHandler,
});

console.log('MeatGeek V2 API Functions registered successfully');
