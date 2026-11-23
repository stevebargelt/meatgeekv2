import { randomUUID } from 'crypto';

import type { Device } from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { expectErrorCode, expectNoSystemProperties } from '../lib/checks';
import { deleteDevice } from '../lib/devices';
import {
  ClaimBody,
  claimDevice,
  cleanupFreshDevice,
  enrolFreshDevice,
  FreshDevice,
} from '../lib/enrolment';
import { defineProofs } from '../lib/proof';

/**
 * HAR-20 (MG-80) — a device claimed through the deployed API is a real Cosmos
 * document owned by the authenticated caller: it reads back by id, appears in the
 * caller's list, takes a PATCH, and reads the change back. An unknown id is a
 * 404. Every response is checked for Cosmos system properties, and every route
 * must report its request charge (the runner's default).
 *
 * HAR-85: then `DELETE /devices/{id}`. The acceptance peer deleting the owner's
 * device is 403 DEVICE_NOT_OWNED and the device is still there; the owner's
 * delete is 204, after which a GET is 404 and a second delete is 404
 * DEVICE_NOT_FOUND. If an earlier step failed, the always-run last step deletes
 * the device instead, so no run leaves it behind.
 *
 * HAR-140: the device is a real one. A fresh device,
 * `acceptance-device-<runId>`, is enrolled through DPS (../lib/enrolment) and
 * claimed with the claim code it minted (`POST /devices/claim`, 201). Its name
 * is run-unique, so repeated runs never collide on id or name. The always-run
 * last step releases it if it is still held, deletes its DPS enrollment and
 * hub identity (`delete-device.sh --only-prefix acceptance-`), and removes its
 * state dir.
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
  let fresh: FreshDevice | undefined;
  let registered: (ClaimBody & { deviceId: string }) | undefined;
  let owner: string | undefined;
  /** POST /devices/claim answered 201. */
  let claimed = false;
  /** The DELETE step answered 204. */
  let deleted = false;

  const registeredDevice = (): ClaimBody & { deviceId: string } => {
    if (!registered) {
      throw new Error('no device was claimed by an earlier proof');
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
      name: 'a fresh device acceptance-device-<runId> is enrolled through DPS and mints a claim code',
      async run(api: AcceptanceApi) {
        await enrolFreshDevice(api, 'device', device => {
          fresh = device;
        });
      },
    },
    {
      name: 'POST /devices/claim claims the device for the caller with its own claim code',
      async run(api: AcceptanceApi) {
        if (!fresh) {
          throw new Error('no device was enrolled by an earlier proof');
        }
        const body: ClaimBody = {
          name: `Acceptance ${api.runId}`,
          model: 'Acceptance Rig',
          location: 'CI',
        };
        const response = await claimDevice(api, fresh, body);
        api.expectStatus(response, 201);
        claimed = true;
        registered = { ...body, deviceId: fresh.deviceId };
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
        api.check(response, device.userId === owner, 'device.userId is not the claiming caller');
      },
    },
    {
      name: 'GET /devices includes the device',
      async run(api: AcceptanceApi) {
        const { deviceId } = registeredDevice();
        const list = { method: 'GET', path: '/devices' } as const;
        const response = await api.request<{ devices: unknown[] }>(list);
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
    {
      name: 'DELETE /devices/{id} as the peer is 403 DEVICE_NOT_OWNED and the device stays',
      async run(api: AcceptanceApi) {
        const { deviceId } = registeredDevice();
        const refused = await deleteDevice(api, deviceId, 'peer');
        api.expectStatus(refused, 403);
        expectErrorCode(api, refused, 'DEVICE_NOT_OWNED');
        const response = await getById(api, deviceId);
        api.expectStatus(response, 200);
        const device = expectDevice(api, response, response.body);
        api.check(response, device.userId === owner, 'device.userId is not the claiming caller');
      },
    },
    {
      name: 'DELETE /devices/{id} deletes the caller’s device',
      async run(api: AcceptanceApi) {
        const { deviceId } = registeredDevice();
        const response = await deleteDevice(api, deviceId);
        api.expectStatus(response, 204);
        deleted = true;
      },
    },
    {
      name: 'GET /devices/{id} is 404 after the delete',
      async run(api: AcceptanceApi) {
        const { deviceId } = registeredDevice();
        const response = await getById(api, deviceId);
        api.expectStatus(response, 404);
      },
    },
    {
      name: 'DELETE /devices/{id} again is 404 DEVICE_NOT_FOUND',
      async run(api: AcceptanceApi) {
        const { deviceId } = registeredDevice();
        const response = await deleteDevice(api, deviceId);
        api.expectStatus(response, 404);
        expectErrorCode(api, response, 'DEVICE_NOT_FOUND');
      },
    },
    cleanupFreshDevice(
      'always: acceptance-device-<runId> is released and its enrollment and hub identity deleted',
      () => ({ device: fresh, claimed, released: deleted })
    ),
  ];
});
