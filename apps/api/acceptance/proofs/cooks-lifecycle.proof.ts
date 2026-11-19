import { randomUUID } from 'crypto';

import type {
  Cook,
  CookListResponse,
  Device,
  RegisterDeviceRequest,
  StartCookRequest,
} from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { defineProofs } from '../lib/proof';

/**
 * HAR-11 proofs 2–5 — a cook written through the deployed API reads back, stops,
 * and reads back as stopped, as the authenticated caller. MG-87 adds the
 * data-pusher's `deviceId` + `status=active` filter: it finds exactly the new
 * cook while it runs and nothing once it is stopped.
 *
 * HAR-26 (MG-88, MG-83): a cook may only start on a device the caller owns. The
 * first proof registers `acceptance-cook-<runId>` (a run-unique name too; the
 * devices proof owns `acceptance-<runId>`) and the lifecycle runs on it. The
 * last proof starts a cook on `acceptance-unowned-<runId>`, which nobody
 * registered, and expects 403 DEVICE_NOT_OWNED with no cook written.
 *
 * The cook uses a client-generated UUID id as MG-84 requires (the id is the
 * start's idempotency key). Acceptance devices and cooks are not deleted: there
 * is no delete route yet.
 */

const COOK_STATUSES = ['planning', 'active', 'paused', 'completed', 'cancelled'];
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

/** Fail unless `value` is shaped like an api-interfaces Cook with no Cosmos
 *  system property on it. */
function expectCook(api: AcceptanceApi, response: AcceptanceResponse, value: unknown): Cook {
  api.check(response, value !== null && typeof value === 'object', 'body is not a JSON object');
  const cook = value as Record<string, unknown>;
  for (const field of ['id', 'userId', 'deviceId', 'name', 'startTime']) {
    api.check(response, typeof cook[field] === 'string', `cook.${field} is not a string`);
  }
  api.check(
    response,
    COOK_STATUSES.includes(cook['status'] as string),
    `cook.status ${JSON.stringify(cook['status'])} is not a CookStatus`
  );
  // Cosmos system properties (_rid, _self, _etag, _attachments, _ts) all start
  // with an underscore; no Cook field does.
  const leaked = Object.keys(cook).filter(key => key.startsWith('_'));
  api.check(
    response,
    leaked.length === 0,
    `cook carries Cosmos system properties: ${leaked.join(', ')}`
  );
  return cook as unknown as Cook;
}

/** MG-87: the data-pusher's reconcile query — the caller's active cooks on one
 *  device. Returns every cook on the first page (a device holds at most one
 *  active cook, so one page is the whole answer). */
async function activeCooksOnDevice(
  api: AcceptanceApi,
  deviceId: string
): Promise<{ cooks: Cook[]; response: AcceptanceResponse }> {
  return cooksOnDevice(api, deviceId, 'active');
}

/** The caller's cooks on one device, optionally in one status (first page). */
async function cooksOnDevice(
  api: AcceptanceApi,
  deviceId: string,
  status?: string
): Promise<{ cooks: Cook[]; response: AcceptanceResponse }> {
  const query = new URLSearchParams({ deviceId, ...(status ? { status } : {}) });
  const response = await api.request<CookListResponse>({
    method: 'GET',
    path: `/cooks?${query.toString()}`,
    route: '/cooks',
  });
  api.expectStatus(response, 200);
  api.check(response, Array.isArray(response.body?.cooks), 'body.cooks is not an array');
  api.check(response, response.body.hasMore === false, 'filtered list unexpectedly has more pages');
  const cooks = response.body.cooks.map(cook => expectCook(api, response, cook));
  return { cooks, response };
}

/** Page through GET /cooks until the cook is found or the list ends. */
async function findCook(
  api: AcceptanceApi,
  cookId: string
): Promise<{ cook: Cook | undefined; response: AcceptanceResponse }> {
  let continuationToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (continuationToken !== undefined) {
      query.set('continuationToken', continuationToken);
    }
    const response = await api.request<CookListResponse>({
      method: 'GET',
      path: `/cooks?${query.toString()}`,
      route: '/cooks',
    });
    api.expectStatus(response, 200);
    api.check(response, Array.isArray(response.body?.cooks), 'body.cooks is not an array');

    const match = response.body.cooks.find(cook => cook.id === cookId);
    if (match) {
      return { cook: expectCook(api, response, match), response };
    }
    if (!response.body.hasMore || !response.body.continuationToken) {
      return { cook: undefined, response };
    }
    continuationToken = response.body.continuationToken;
  }
  throw new Error(`cook not found in the first ${MAX_PAGES} pages of GET /cooks`);
}

export default defineProofs('cooks lifecycle', () => {
  let device: RegisterDeviceRequest | undefined;
  let started: StartCookRequest | undefined;

  const registeredDevice = (): RegisterDeviceRequest => {
    if (!device) {
      throw new Error('no device was registered by an earlier proof');
    }
    return device;
  };

  const startedCook = (): StartCookRequest => {
    if (!started) {
      throw new Error('no cook was started by an earlier proof');
    }
    return started;
  };

  return [
    {
      name: 'POST /devices registers the device the cook runs on',
      async run(api: AcceptanceApi) {
        device = {
          deviceId: `acceptance-cook-${api.runId}`,
          name: `Acceptance cook ${api.runId}`,
          model: 'Acceptance Rig',
          location: 'CI',
        };
        const response = await api.request<Device>({
          method: 'POST',
          path: '/devices',
          body: device,
        });
        api.expectStatus(response, 201);
        api.check(
          response,
          response.body?.id === device.deviceId,
          `device.id ${response.body?.id} is not the id sent`
        );
      },
    },
    {
      name: 'POST /cooks starts a cook on the owned device and returns a Cook',
      async run(api: AcceptanceApi) {
        started = {
          id: randomUUID(),
          name: `Acceptance ${api.runId}`,
          deviceId: registeredDevice().deviceId,
          meatType: 'acceptance',
          notes: 'Synthetic cook written by the live acceptance suite.',
        };
        const response = await api.request({ method: 'POST', path: '/cooks', body: started });
        api.expectStatus(response, '2xx');
        const cook = expectCook(api, response, response.body);
        api.check(response, cook.id === started.id, `cook.id ${cook.id} is not the id sent`);
        api.check(
          response,
          cook.deviceId === started.deviceId,
          'cook.deviceId is not the one sent'
        );
        api.check(response, cook.status === 'active', `cook.status is ${cook.status}, not active`);
      },
    },
    {
      name: 'GET /cooks includes the new cook',
      async run(api: AcceptanceApi) {
        const { id } = startedCook();
        const { cook, response } = await findCook(api, id);
        api.check(response, cook !== undefined, `cook ${id} is not in the list`);
        api.check(response, cook.status === 'active', `cook.status is ${cook.status}, not active`);
      },
    },
    {
      name: 'GET /cooks?deviceId&status=active returns exactly the new cook',
      async run(api: AcceptanceApi) {
        const { id, deviceId } = startedCook();
        const { cooks, response } = await activeCooksOnDevice(api, deviceId);
        api.check(
          response,
          cooks.length === 1 && cooks[0].id === id,
          `expected only cook ${id}, got [${cooks.map(cook => cook.id).join(', ')}]`
        );
        api.check(response, cooks[0].deviceId === deviceId, 'cook.deviceId is not the filter');
        api.check(response, cooks[0].status === 'active', 'cook.status is not active');
      },
    },
    {
      name: 'POST /cooks/{cookId}/stop stops the cook',
      async run(api: AcceptanceApi) {
        const { id } = startedCook();
        const response = await api.request({
          method: 'POST',
          path: `/cooks/${encodeURIComponent(id)}/stop`,
          route: '/cooks/{cookId}/stop',
        });
        api.expectStatus(response, '2xx');
        const cook = expectCook(api, response, response.body);
        api.check(response, cook.id === id, `cook.id ${cook.id} is not the cook stopped`);
        api.check(
          response,
          cook.status === 'completed',
          `cook.status is ${cook.status}, not completed`
        );
        api.check(response, typeof cook.endTime === 'string', 'cook.endTime is not set');
      },
    },
    {
      name: 'GET /cooks reads the cook back as stopped',
      async run(api: AcceptanceApi) {
        const { id } = startedCook();
        const { cook, response } = await findCook(api, id);
        api.check(response, cook !== undefined, `cook ${id} is not in the list`);
        api.check(
          response,
          cook.status === 'completed',
          `cook.status is ${cook.status}, not completed`
        );
        api.check(response, typeof cook.endTime === 'string', 'cook.endTime is not set');
      },
    },
    {
      name: 'GET /cooks?deviceId&status=active returns no cook after the stop',
      async run(api: AcceptanceApi) {
        const { deviceId } = startedCook();
        const { cooks, response } = await activeCooksOnDevice(api, deviceId);
        api.check(
          response,
          cooks.length === 0,
          `expected no active cook, got [${cooks.map(cook => cook.id).join(', ')}]`
        );
      },
    },
    {
      name: 'POST /cooks on an unregistered device is 403 DEVICE_NOT_OWNED',
      async run(api: AcceptanceApi) {
        const unowned: StartCookRequest = {
          id: randomUUID(),
          name: `Acceptance unowned ${api.runId}`,
          deviceId: `acceptance-unowned-${api.runId}`,
          meatType: 'acceptance',
        };
        const response = await api.request<{ error?: string }>({
          method: 'POST',
          path: '/cooks',
          body: unowned,
        });
        api.expectStatus(response, 403);
        api.check(
          response,
          response.body?.error === 'DEVICE_NOT_OWNED',
          `error is ${JSON.stringify(response.body?.error)}, not DEVICE_NOT_OWNED`
        );
      },
    },
    {
      name: 'GET /cooks?deviceId on the unregistered device returns no cook',
      async run(api: AcceptanceApi) {
        const { cooks, response } = await cooksOnDevice(api, `acceptance-unowned-${api.runId}`);
        api.check(
          response,
          cooks.length === 0,
          `expected no cook, got [${cooks.map(cook => cook.id).join(', ')}]`
        );
      },
    },
  ];
});
