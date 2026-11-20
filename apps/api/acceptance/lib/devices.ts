import type { AcceptanceApi, AcceptanceResponse, Caller, Proof } from './proof';

/**
 * HAR-85 — deleting the devices a proof registers. Every run registers its
 * devices under run-unique ids (`acceptance-<runId>`, `acceptance-temp-<runId>`,
 * `acceptance-cook-<runId>`); without these steps they pile up on the
 * acceptance owner, and every `GET /devices` and device-name check reads them
 * all.
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
 */
export function deleteRegisteredDevice(name: string, registered: () => RegisteredDevice): Proof {
  return {
    name,
    always: true,
    async run(api: AcceptanceApi) {
      const { deviceId, created, deleted } = registered();
      if (deviceId === undefined || deleted) {
        return;
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
