import { randomUUID } from 'crypto';

import type { Device, RegisterDeviceRequest } from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { expectNoSystemProperties } from '../lib/checks';
import { defineProofs } from '../lib/proof';

/**
 * HAR-20 (MG-80) — a device registered through the deployed API is a real Cosmos
 * document owned by the authenticated caller: it reads back by id, appears in the
 * caller's list, takes a PATCH, and reads the change back. An unknown id is a
 * 404. Every response is checked for Cosmos system properties, and every route
 * must report its request charge (the runner's default).
 *
 * The device id is `acceptance-<runId>` and its name is run-unique, so repeated
 * runs never collide on id or name. Acceptance devices are not deleted: there is
 * no delete route.
 */

const CONNECTION_STATUSES = ['online', 'offline', 'unknown'];

/** Fail unless `value` is shaped like an api-interfaces Device. */
function expectDevice(api: AcceptanceApi, response: AcceptanceResponse, value: unknown): Device {
  api.check(response, value !== null && typeof value === 'object', 'body is not a JSON object');
  const device = value as Record<string, unknown>;
  for (const field of ['id', 'userId', 'name', 'model']) {
    api.check(response, typeof device[field] === 'string', `device.${field} is not a string`);
  }
  api.check(response, typeof device['isActive'] === 'boolean', 'device.isActive is not a boolean');
  api.check(
    response,
    CONNECTION_STATUSES.includes(device['connectionStatus'] as string),
    `device.connectionStatus ${JSON.stringify(device['connectionStatus'])} is not valid`
  );
  return device as unknown as Device;
}

export default defineProofs('devices', () => {
  let registered: RegisterDeviceRequest | undefined;
  let owner: string | undefined;

  const registeredDevice = (): RegisterDeviceRequest => {
    if (!registered) {
      throw new Error('no device was registered by an earlier proof');
    }
    return registered;
  };

  const getById = async (api: AcceptanceApi, id: string) => {
    const response = await api.request<Device>({
      method: 'GET',
      path: `/devices/${encodeURIComponent(id)}`,
      route: '/devices/{id}',
    });
    expectNoSystemProperties(api, response);
    return response;
  };

  return [
    {
      name: 'POST /devices registers a device to the caller',
      async run(api: AcceptanceApi) {
        registered = {
          deviceId: `acceptance-${api.runId}`,
          name: `Acceptance ${api.runId}`,
          model: 'Acceptance Rig',
          location: 'CI',
        };
        const response = await api.request({ method: 'POST', path: '/devices', body: registered });
        api.expectStatus(response, 201);
        expectNoSystemProperties(api, response);
        const device = expectDevice(api, response, response.body);
        api.check(
          response,
          device.id === registered.deviceId,
          `device.id ${device.id} is not the id sent`
        );
        api.check(response, device.name === registered.name, 'device.name is not the name sent');
        api.check(response, device.isActive === true, 'device.isActive is not true');
        api.check(
          response,
          device.connectionStatus === 'unknown',
          'connectionStatus is not unknown'
        );
        owner = device.userId;
      },
    },
    {
      name: 'GET /devices/{id} reads the device back',
      async run(api: AcceptanceApi) {
        const { deviceId, name } = registeredDevice();
        const response = await getById(api, deviceId);
        api.expectStatus(response, 200);
        const device = expectDevice(api, response, response.body);
        api.check(response, device.id === deviceId, `device.id ${device.id} is not ${deviceId}`);
        api.check(response, device.name === name, 'device.name does not match');
        api.check(response, device.userId === owner, 'device.userId is not the registering caller');
      },
    },
    {
      name: 'GET /devices includes the device',
      async run(api: AcceptanceApi) {
        const { deviceId } = registeredDevice();
        const response = await api.request<{ devices: unknown[] }>({
          method: 'GET',
          path: '/devices',
        });
        api.expectStatus(response, 200);
        expectNoSystemProperties(api, response);
        api.check(response, Array.isArray(response.body?.devices), 'body.devices is not an array');
        const devices = response.body.devices.map(item => expectDevice(api, response, item));
        api.check(
          response,
          devices.some(device => device.id === deviceId),
          `device ${deviceId} is not in the list`
        );
        api.check(
          response,
          devices.every(device => device.userId === owner),
          'the list holds a device owned by someone else'
        );
      },
    },
    {
      name: 'PATCH /devices/{id} changes the location',
      async run(api: AcceptanceApi) {
        const { deviceId } = registeredDevice();
        const location = `Patched ${api.runId}`;
        const response = await api.request({
          method: 'PATCH',
          path: `/devices/${encodeURIComponent(deviceId)}`,
          route: '/devices/{id}',
          body: { location },
        });
        api.expectStatus(response, 200);
        expectNoSystemProperties(api, response);
        const device = expectDevice(api, response, response.body);
        api.check(response, device.location === location, `device.location is ${device.location}`);
      },
    },
    {
      name: 'GET /devices/{id} reads the patched location back',
      async run(api: AcceptanceApi) {
        const { deviceId } = registeredDevice();
        const response = await getById(api, deviceId);
        api.expectStatus(response, 200);
        const device = expectDevice(api, response, response.body);
        api.check(
          response,
          device.location === `Patched ${api.runId}`,
          `device.location is ${device.location}, not the patched value`
        );
      },
    },
    {
      name: 'GET /devices/{id} is 404 for an unknown id',
      async run(api: AcceptanceApi) {
        const response = await getById(api, randomUUID());
        api.expectStatus(response, 404);
      },
    },
  ];
});
