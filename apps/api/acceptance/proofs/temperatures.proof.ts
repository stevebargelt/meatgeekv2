import type { TemperatureHistoryResponse } from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { expectErrorCode } from '../lib/checks';
import { claimDevice, cleanupFreshDevice, enrolFreshDevice, FreshDevice } from '../lib/enrolment';
import { defineProofs } from '../lib/proof';

/**
 * HAR-28 (MG-79 part 1) — GET /temperatures/current/{deviceId} reads the real
 * temperatures container behind device ownership. Read-only, as the owner
 * decided for goal HAR-18: nothing here writes telemetry, so a freshly
 * claimed device has no readings.
 *
 *   1. (HAR-140) enrol a fresh device, `acceptance-temp-<runId>`, through DPS
 *      and claim it with its own claim code (../lib/enrolment); its
 *      registration sends no reading;
 *   2. its current reading is 404 NO_READINGS (owned, nothing routed);
 *   3. `acceptance-temp-unowned-<runId>`, never registered, is 404
 *      DEVICE_NOT_FOUND;
 *   4. (HAR-35, MG-79 part 2) the new device's history is an empty first page,
 *      exactly `{ readings: [], limit: 100, hasMore: false }`: no
 *      `continuationToken`, and (HAR-75) no `total` or `offset`;
 *   5. (HAR-75) `offset=0` is 400 VALIDATION_ERROR: history pages by
 *      continuation token only;
 *   6. the unowned device's history is 404 DEVICE_NOT_FOUND.
 *
 * Every step but the 400 reaches Cosmos, so those responses must carry their
 * request charge (the runner's default). The 400 is answered before any read.
 *
 * HAR-85, HAR-140: the last step, run even after a failure, releases
 * `acceptance-temp-<runId>`, deletes its DPS enrollment and hub identity, and
 * removes its state dir.
 */

export default defineProofs('temperatures', () => {
  let fresh: FreshDevice | undefined;
  /** POST /devices/claim answered 201. */
  let claimed = false;
  const registered = (): FreshDevice | undefined => (claimed ? fresh : undefined);

  const current = (api: AcceptanceApi, deviceId: string) =>
    api.request({
      method: 'GET',
      path: `/temperatures/current/${encodeURIComponent(deviceId)}`,
      route: '/temperatures/current/{deviceId}',
    });

  const history = (api: AcceptanceApi, deviceId: string, query = '', expectRequestCharge = true) =>
    api.request<TemperatureHistoryResponse>({
      method: 'GET',
      path: `/temperatures/history?deviceId=${encodeURIComponent(deviceId)}${query}`,
      route: '/temperatures/history',
      expectRequestCharge,
    });

  return [
    {
      name: 'a fresh device acceptance-temp-<runId> is enrolled through DPS',
      async run(api: AcceptanceApi) {
        await enrolFreshDevice(api, 'temp', device => {
          fresh = device;
        });
      },
    },
    {
      name: 'POST /devices/claim claims acceptance-temp-<runId> with its own claim code',
      async run(api: AcceptanceApi) {
        if (!fresh) {
          throw new Error('no device was enrolled by an earlier proof');
        }
        const response = await claimDevice(api, fresh, {
          name: `Acceptance temperatures ${api.runId}`,
          model: 'Acceptance Rig',
        });
        api.expectStatus(response, 201);
        claimed = true;
      },
    },
    {
      name: 'GET /temperatures/current/{deviceId} is 404 NO_READINGS for the new device',
      async run(api: AcceptanceApi) {
        const device = registered();
        if (!device) {
          throw new Error('no device was claimed by an earlier proof');
        }
        const response = await current(api, device.deviceId);
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
    {
      name: 'GET /temperatures/history is an empty first page for the new device',
      async run(api: AcceptanceApi) {
        const device = registered();
        if (!device) {
          throw new Error('no device was claimed by an earlier proof');
        }
        const response = await history(api, device.deviceId);
        api.expectStatus(response, 200);
        const expected: TemperatureHistoryResponse = {
          readings: [],
          limit: 100,
          hasMore: false,
        };
        const body = response.body as unknown;
        const matches =
          body !== null &&
          typeof body === 'object' &&
          Object.keys(body).sort().join() === Object.keys(expected).sort().join() &&
          Object.entries(expected).every(
            ([key, value]) =>
              JSON.stringify((body as Record<string, unknown>)[key]) === JSON.stringify(value)
          );
        api.check(
          response,
          matches,
          `body is ${JSON.stringify(body)}, not ${JSON.stringify(expected)}`
        );
      },
    },
    {
      name: 'GET /temperatures/history with offset=0 is 400 VALIDATION_ERROR',
      async run(api: AcceptanceApi) {
        const device = registered();
        if (!device) {
          throw new Error('no device was claimed by an earlier proof');
        }
        const response = await history(api, device.deviceId, '&offset=0', false);
        api.expectStatus(response, 400);
        expectErrorCode(api, response, 'VALIDATION_ERROR');
      },
    },
    {
      name: 'GET /temperatures/history is 404 DEVICE_NOT_FOUND for an unowned device',
      async run(api: AcceptanceApi) {
        const response = await history(api, `acceptance-temp-unowned-${api.runId}`);
        api.expectStatus(response, 404);
        expectErrorCode(api, response, 'DEVICE_NOT_FOUND');
      },
    },
    cleanupFreshDevice(
      'always: acceptance-temp-<runId> is released and its enrollment and hub identity deleted',
      () => ({ device: fresh, claimed })
    ),
  ];
});
