import type { RegisterDeviceRequest } from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { defineProofs } from '../lib/proof';

/**
 * HAR-28 (MG-79 part 1) — GET /temperatures/current/{deviceId} reads the real
 * temperatures container behind device ownership. Read-only, as the owner
 * decided for goal HAR-18: nothing here writes telemetry, so a freshly
 * registered device has no readings.
 *
 *   1. register `acceptance-temp-<runId>` (run-unique id and name);
 *   2. its current reading is 404 NO_READINGS (owned, nothing routed);
 *   3. `acceptance-temp-unowned-<runId>`, never registered, is 404
 *      DEVICE_NOT_FOUND.
 *
 * Every step reaches Cosmos, so every response must carry its request charge
 * (the runner's default). Acceptance devices are not deleted: there is no delete
 * route.
 */

function expectErrorCode(api: AcceptanceApi, response: AcceptanceResponse, code: string): void {
  const body = response.body as { error?: unknown } | null;
  api.check(
    response,
    body !== null && typeof body === 'object' && body.error === code,
    `body.error is ${JSON.stringify(body?.error)}, not ${code}`
  );
}

export default defineProofs('temperatures', () => {
  let registered: RegisterDeviceRequest | undefined;

  const current = (api: AcceptanceApi, deviceId: string) =>
    api.request({
      method: 'GET',
      path: `/temperatures/current/${encodeURIComponent(deviceId)}`,
      route: '/temperatures/current/{deviceId}',
    });

  return [
    {
      name: 'POST /devices registers acceptance-temp-<runId>',
      async run(api: AcceptanceApi) {
        registered = {
          deviceId: `acceptance-temp-${api.runId}`,
          name: `Acceptance temperatures ${api.runId}`,
          model: 'Acceptance Rig',
        };
        const response = await api.request({ method: 'POST', path: '/devices', body: registered });
        api.expectStatus(response, 201);
      },
    },
    {
      name: 'GET /temperatures/current/{deviceId} is 404 NO_READINGS for the new device',
      async run(api: AcceptanceApi) {
        if (!registered) {
          throw new Error('no device was registered by an earlier proof');
        }
        const response = await current(api, registered.deviceId);
        api.expectStatus(response, 404);
        expectErrorCode(api, response, 'NO_READINGS');
      },
    },
    {
      name: 'GET /temperatures/current/{deviceId} is 404 DEVICE_NOT_FOUND for an unowned device',
      async run(api: AcceptanceApi) {
        const response = await current(api, `acceptance-temp-unowned-${api.runId}`);
        api.expectStatus(response, 404);
        expectErrorCode(api, response, 'DEVICE_NOT_FOUND');
      },
    },
  ];
});
