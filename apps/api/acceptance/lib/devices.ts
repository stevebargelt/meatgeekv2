import type { Cook, CookListResponse } from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse, Caller } from './proof';

/**
 * HAR-85 — deleting the devices a proof registers. Every run registers its
 * devices under run-unique ids (`acceptance-<runId>`, `acceptance-temp-<runId>`,
 * `acceptance-cook-<runId>`); without these steps they pile up on the
 * acceptance owner, and every `GET /devices` and device-name check reads them
 * all.
 *
 * HAR-136: `DELETE /devices/{id}` is a release, and it answers 409
 * COOK_ACTIVE while the caller has an active cook on the device. A cleanup
 * never accepts that 409: a group that starts a cook stops every active cook
 * on its device first ({@link stopActiveCooks}), and so does the sweep.
 */

/** `DELETE /devices/{id}` as `as` (the owner unless told otherwise). */
export function deleteDevice(
  api: AcceptanceApi,
  deviceId: string,
  as: Caller = 'owner'
): Promise<AcceptanceResponse> {
  return api.request({
    method: 'DELETE',
    path: `/devices/${encodeURIComponent(deviceId)}`,
    route: '/devices/{id}',
    as,
  });
}

/**
 * HAR-136: stop every cook the owner has active on `deviceId`
 * (`GET /cooks?deviceId&status=active`, then `POST /cooks/{cookId}/stop` for
 * each, which must answer 2xx), so a release of the device is not refused with
 * 409 COOK_ACTIVE. Returns how many it stopped.
 */
export async function stopActiveCooks(api: AcceptanceApi, deviceId: string): Promise<number> {
  const query = new URLSearchParams({ deviceId, status: 'active' });
  const listed = await api.request<CookListResponse>({
    method: 'GET',
    path: `/cooks?${query.toString()}`,
    route: '/cooks',
  });
  api.expectStatus(listed, 200);
  api.check(listed, Array.isArray(listed.body?.cooks), 'body.cooks is not an array');
  const active: Cook[] = listed.body.cooks;
  for (const cook of active) {
    const stopped = await api.request({
      method: 'POST',
      path: `/cooks/${encodeURIComponent(cook.id)}/stop`,
      route: '/cooks/{cookId}/stop',
    });
    api.expectStatus(stopped, '2xx');
  }
  return active.length;
}
