import { app } from '@azure/functions';

// Import function handlers
import { getCooksHandler } from './functions/cooks/list-cooks';
import { startCookHandler } from './functions/cooks/start-cook';
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
  handler: startCookHandler,
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