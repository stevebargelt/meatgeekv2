import type { Device } from '@meatgeekv2/api-interfaces';

import { isDate } from '../lib/telemetry';
import { ClaimRefusals, mutateClaimCode, randomClaimCode } from '../lib/claim-refusal';
import {
  ClaimBody,
  cleanupFreshDevice,
  enrolFreshDevice,
  FreshDevice,
  postClaim,
  prepareClaim,
  sendClaim,
} from '../lib/enrolment';
import type { AcceptanceApi, Caller } from '../lib/proof';
import { defineProofs } from '../lib/proof';

/**
 * HAR-142 (goal HAR-130, DoD 7) — claiming a device needs proof of
 * possession: the claim code the device itself minted. One fresh device,
 * `acceptance-claim-<runId>`, enrolled through DPS (../lib/enrolment):
 *
 *   - a guessed id: `acceptance-guess-<runId>`, never enrolled, with a
 *     well-formed code → 403;
 *   - the enrolled, unclaimed device with a well-formed code that is not its
 *     own → 403;
 *   - a wrong code: its own code with one symbol changed (still in the
 *     alphabet) → 403;
 *   - then its own code → 201, so a wrong code does not burn the right one.
 *     `GET /devices/{id}` reads it back with `claimedAt`; the same claim
 *     again is 200 with the same `claimedAt`;
 *   - a second user (the acceptance peer, HAR-61): the now-consumed code →
 *     403; a fresh guess → 403; `GET /devices/{id}` → 404.
 *
 * Every refusal is checked by ../lib/claim-refusal's {@link ClaimRefusals}:
 * the same 403 body, with no request charge, whichever check refused it. That
 * is the "no oracle" property: the answer never says whether the id exists,
 * the code was wrong or someone else holds the device.
 *
 * The device's code is read once, kept in memory and never printed; neither
 * is a guess. The always-run last step releases the device and deletes its
 * DPS enrollment and hub identity.
 */

export default defineProofs('device claim', () => {
  let fresh: FreshDevice | undefined;
  /** The device's own claim code. In memory only. */
  let code: string | undefined;
  let claimed = false;
  let claimedAt: string | undefined;
  let ownerId: string | undefined;
  const refusals = new ClaimRefusals();

  const claimBody = (api: AcceptanceApi): ClaimBody => ({
    name: `Acceptance claim ${api.runId}`,
    model: 'Acceptance Rig',
    location: 'CI',
  });

  const enrolled = (): FreshDevice & { code: string } => {
    if (!fresh || code === undefined) {
      throw new Error('no device was enrolled by an earlier proof');
    }
    return { ...fresh, code };
  };

  /** Send a claim that must be refused, and check the refusal. */
  const refused = async (api: AcceptanceApi, deviceId: string, guess: string, as: Caller) => {
    const response = await sendClaim(api, deviceId, guess, claimBody(api), as);
    refusals.expect(api, response);
  };

  const getDevice = (api: AcceptanceApi, deviceId: string, as: Caller) =>
    api.request<Device>({
      method: 'GET',
      path: `/devices/${encodeURIComponent(deviceId)}`,
      route: '/devices/{id}',
      as,
    });

  return [
    {
      name: 'a fresh device acceptance-claim-<runId> is enrolled through DPS and shows an unclaimed code',
      async run(api: AcceptanceApi) {
        const device = await enrolFreshDevice(api, 'claim', d => {
          fresh = d;
        });
        code = await prepareClaim(api, device);
      },
    },
    {
      name: 'POST /devices/claim for a guessed id, acceptance-guess-<runId>, never enrolled, is 403 CLAIM_REFUSED',
      async run(api: AcceptanceApi) {
        await refused(api, `acceptance-guess-${api.runId}`, randomClaimCode(), 'owner');
      },
    },
    {
      name: 'POST /devices/claim for the enrolled, unclaimed device without its code is 403, the same body',
      async run(api: AcceptanceApi) {
        const device = enrolled();
        await refused(api, device.deviceId, randomClaimCode([device.code]), 'owner');
      },
    },
    {
      name: 'POST /devices/claim with its code one symbol changed is 403, the same body',
      async run(api: AcceptanceApi) {
        const device = enrolled();
        await refused(api, device.deviceId, mutateClaimCode(device.code), 'owner');
      },
    },
    {
      name: 'POST /devices/claim with its own code is then 201: a wrong code does not burn the right one',
      async run(api: AcceptanceApi) {
        const device = enrolled();
        const response = await postClaim(api, device.deviceId, device.code, claimBody(api));
        api.expectStatus(response, 201);
        claimed = true;
        api.check(
          response,
          isDate(response.body.claimedAt),
          `device.claimedAt ${JSON.stringify(response.body.claimedAt)} is not a date`
        );
        claimedAt = response.body.claimedAt;
        ownerId = response.body.userId;
      },
    },
    {
      name: 'GET /devices/{id} as the owner reads it back with claimedAt',
      async run(api: AcceptanceApi) {
        const device = enrolled();
        const response = await getDevice(api, device.deviceId, 'owner');
        api.expectStatus(response, 200);
        api.check(
          response,
          response.body.id === device.deviceId,
          'device.id is not the claimed id'
        );
        api.check(response, response.body.userId === ownerId, 'device.userId is not the claimant');
        api.check(
          response,
          response.body.claimedAt === claimedAt,
          `device.claimedAt ${JSON.stringify(response.body.claimedAt)} is not the claim's ${claimedAt}`
        );
      },
    },
    {
      name: 'POST /devices/claim again with the same code is 200, the device unchanged',
      async run(api: AcceptanceApi) {
        const device = enrolled();
        const response = await postClaim(api, device.deviceId, device.code, claimBody(api));
        api.expectStatus(response, 200);
        api.check(
          response,
          response.body.claimedAt === claimedAt,
          `the retry changed claimedAt to ${JSON.stringify(response.body.claimedAt)}`
        );
      },
    },
    {
      name: 'POST /devices/claim as the peer with the consumed code is 403, the same body',
      async run(api: AcceptanceApi) {
        const device = enrolled();
        if (!claimed) {
          throw new Error('the owner did not claim the device in an earlier proof');
        }
        await refused(api, device.deviceId, device.code, 'peer');
      },
    },
    {
      name: 'POST /devices/claim as the peer with a fresh well-formed guess is 403, the same body',
      async run(api: AcceptanceApi) {
        const device = enrolled();
        await refused(api, device.deviceId, randomClaimCode([device.code]), 'peer');
      },
    },
    {
      name: 'GET /devices/{id} as the peer is 404',
      async run(api: AcceptanceApi) {
        const response = await getDevice(api, enrolled().deviceId, 'peer');
        api.expectStatus(response, 404);
      },
    },
    {
      name: 'all five refusals were the same 403 body, with no request charge: no answer tells the cases apart',
      async run() {
        if (refusals.count !== 5) {
          throw new Error(`${refusals.count} refusals were checked, not 5`);
        }
      },
    },
    cleanupFreshDevice(
      'always: acceptance-claim-<runId> is released and its enrollment and hub identity deleted',
      () => ({ device: fresh, claimed })
    ),
  ];
});
