import type { Cook, CookListResponse } from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse, Caller, Proof } from './proof';

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

/** What a proof group registered, as its cleanup step sees it. */
export interface RegisteredDevice {
  /** The id sent to `POST /devices`, once the registration was attempted. */
  readonly deviceId: string | undefined;
  /** `POST /devices` answered 201. */
  readonly created: boolean;
  /** An earlier step deleted it already. */
  readonly deleted?: boolean;
}

/**
 * The last step of a group that registers a device: delete it. It runs even
 * after an earlier step failed (`always`), so a failed run leaves nothing
 * behind either.
 *
 *   - registered (201) and not yet deleted: `DELETE` must answer 204;
 *   - registration attempted but not confirmed (the POST failed, or its answer
 *     never arrived): `DELETE` may answer 204 or 404, since the device may or
 *     may not exist;
 *   - never attempted, or already deleted: nothing to do.
 *
 * HAR-136: a group that starts cooks on its device passes `stopCooksFirst`, so
 * the step stops any cook still active there (an earlier step failed before
 * its stop) before the `DELETE`, which would otherwise be 409 COOK_ACTIVE.
 */
export function deleteRegisteredDevice(
  name: string,
  registered: () => RegisteredDevice,
  options: { readonly stopCooksFirst?: boolean } = {}
): Proof {
  return {
    name,
    always: true,
    async run(api: AcceptanceApi) {
      const { deviceId, created, deleted } = registered();
      if (deviceId === undefined || deleted) {
        return;
      }
      if (options.stopCooksFirst) {
        await stopActiveCooks(api, deviceId);
      }
      const response = await deleteDevice(api, deviceId);
      if (created) {
        api.expectStatus(response, 204);
      } else {
        api.check(
          response,
          response.status === 204 || response.status === 404,
          `expected 204 or 404, got ${response.status}`
        );
      }
    },
  };
}
