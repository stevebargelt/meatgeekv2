import type { Device } from '@meatgeekv2/api-interfaces';

import { deleteDevice, stopActiveCooks } from '../lib/devices';
import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { defineProofs } from '../lib/proof';

/**
 * HAR-85 — the sweep. Before HAR-85 every run registered three run-unique
 * devices to the acceptance owner and never removed them (98 by 2026-11-20).
 * The proofs now delete their own devices, but a run that is killed (a job
 * timeout, a cancelled deploy) cannot run its cleanup steps. So the first group
 * of every run deletes every `acceptance-*` device the owner holds, and the
 * device count stays flat whatever happened to the run before.
 *
 * The file name sorts it before every other proof file, so nothing this run
 * registers exists yet. Dev deploys run one at a time (the `app-deploy-dev`
 * concurrency group), so no other CI run's devices are in flight. A local run
 * signs in as the developer, a different owner, and sweeps only that owner's
 * acceptance devices.
 *
 * The standing devices are never deleted: the simulated device and the chart
 * device are re-registered (or confirmed) by later proofs and carry IoT Hub
 * identities and history the suite relies on. Their ids do not start with
 * `acceptance-`, and they are excluded by id as well.
 *
 * HAR-136: `DELETE /devices/{id}` is a release and is refused (409
 * COOK_ACTIVE) while a cook is active on the device, so the sweep stops any
 * cook still active on a device before it deletes it.
 *
 * Metrics: `acceptance-devices-before` (the owner's device count before),
 * `acceptance-devices-swept`, and `acceptance-devices-after`.
 */

/** The prefix every run-unique device a proof registers starts with. */
export const SWEPT_PREFIX = 'acceptance-';

async function listDevices(api: AcceptanceApi): Promise<{
  devices: Device[];
  response: AcceptanceResponse;
}> {
  const response = await api.request<{ devices: Device[] }>({ method: 'GET', path: '/devices' });
  api.expectStatus(response, 200);
  api.check(response, Array.isArray(response.body?.devices), 'body.devices is not an array');
  return { devices: response.body.devices, response };
}

export default defineProofs('device sweep', () => {
  const stale = (api: AcceptanceApi, devices: readonly Device[]): Device[] => {
    const standing = new Set(
      [api.simulatedDeviceId, api.chartDeviceId].filter((id): id is string => id !== undefined)
    );
    return devices.filter(device => device.id.startsWith(SWEPT_PREFIX) && !standing.has(device.id));
  };

  return [
    {
      name: 'DELETE /devices/{id} for every acceptance-* device an earlier run left',
      async run(api: AcceptanceApi) {
        const before = await listDevices(api);
        const swept = stale(api, before.devices);
        api.metric('acceptance-devices-before', before.devices.length);
        for (const device of swept) {
          // HAR-136: a run killed mid-cook leaves its cook active, and the
          // release would be 409 COOK_ACTIVE. Stop it first.
          await stopActiveCooks(api, device.id);
          const response = await deleteDevice(api, device.id);
          api.expectStatus(response, 204);
        }
        api.metric('acceptance-devices-swept', swept.length);

        const after = await listDevices(api);
        api.metric('acceptance-devices-after', after.devices.length);
        const left = stale(api, after.devices).map(device => device.id);
        api.check(
          after.response,
          left.length === 0,
          `acceptance devices are still listed after the sweep: ${left.join(', ')}`
        );
      },
    },
  ];
});
