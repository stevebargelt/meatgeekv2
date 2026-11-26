import { randomUUID } from 'crypto';

import type { Cook, CookListResponse, StartCookRequest } from '@meatgeekv2/api-interfaces';

import { clock } from '../lib/clock';
import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { defineProofs, ProofFailure } from '../lib/proof';
import type { SentReading } from '../lib/telemetry';
import {
  expectSimDeviceExit0,
  parseSentReading,
  registerSimulatedDevice,
  sameInstant,
} from '../lib/telemetry';

/**
 * The target rule on dev: a running cook records which channels have reached
 * their target, and when (recordTargetsReached in apps/api, on its own
 * consumer group of the temperature-data event hub).
 *
 * simdevice's synthetic readings never put the grill below 221 °F and start
 * probe 1 at 150 °F. The cook's targets are under both, so the target is
 * already met when the cook starts, which the rule treats like any other
 * reading: two readings in a row at or above it.
 *
 *   1. the simulated device is registered to the owner;
 *   2. any cook active on it is stopped, so the device lock is free;
 *   3. `POST /cooks` with targets grill 200 and probe 1 140 is 201, and the
 *      cook has reached nothing yet;
 *   4. `simdevice --twin --count 2 --interval 2s`: the device applies the cook
 *      and sends two readings tagged with it;
 *   5. `GET /cooks/{cookId}` is polled until the grill and probe 1 are reached,
 *      each at the second reading's timestamp. Probe 2 has no target and is
 *      not. `METRIC targets-reached-ms`: simdevice's exit to the reach being
 *      readable;
 *   6. `POST /cooks/{cookId}/stop` is 200 and the stopped cook keeps them;
 *   7. always, whatever failed before: no cook is left active on the device.
 */

/** Poll pacing for step 5, on the injected clock (../lib/clock). */
export const TARGETS_POLL: { readonly intervalMs: number; readonly capMs: number } = {
  intervalMs: 2_000,
  capMs: 90_000,
};

/** Under simdevice's synthetic grill (225 ± 4 °F) and probe 1 (from 150 °F). */
export const TARGETS = { grill: 200, probe1: 140 } as const;

const SIMDEVICE_ARGS = ['--twin', '--count', '2', '--interval', '2s', '--timeout', '60s'];
const SIMDEVICE_KILL_MS = 120_000;

const show = (value: unknown) => (value === undefined ? 'absent' : JSON.stringify(value));

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function activeCooks(api: AcceptanceApi): Promise<Cook[]> {
  const query = new URLSearchParams({ deviceId: api.simulatedDeviceId, status: 'active' });
  const response = await api.request<CookListResponse>({
    method: 'GET',
    path: `/cooks?${query.toString()}`,
    route: '/cooks',
  });
  api.expectStatus(response, 200);
  api.check(response, Array.isArray(response.body?.cooks), 'body.cooks is not an array');
  return response.body.cooks;
}

async function stopCook(api: AcceptanceApi, id: string): Promise<AcceptanceResponse<Cook>> {
  const response = await api.request<Cook>({
    method: 'POST',
    path: `/cooks/${encodeURIComponent(id)}/stop`,
    route: '/cooks/{cookId}/stop',
  });
  api.expectStatus(response, 200);
  return response;
}

/** Whether both target channels are reached; fails if one is reached at
 *  another time than the second reading's, or probe 2 is reached at all. */
function reachedAtSecondReading(
  api: AcceptanceApi,
  response: AcceptanceResponse<Cook>,
  second: SentReading
): boolean {
  const reached = response.body?.targetsReached;
  if (reached === undefined) {
    return false;
  }
  api.check(
    response,
    reached.probe2 === undefined,
    `probe2 is reached (${show(reached.probe2)}) but has no target`
  );
  for (const channel of ['grill', 'probe1'] as const) {
    const at = reached[channel]?.reachedAt;
    if (at === undefined) {
      return false;
    }
    api.check(
      response,
      sameInstant(at, second.timestamp),
      `${channel} was reached at ${show(at)}, not at the second reading's timestamp ` +
        `${second.timestamp}`
    );
  }
  return true;
}

export default defineProofs('targets reached', () => {
  let registered = false;
  let cookId: string | undefined;
  let second: SentReading | undefined;
  let sentAt: number | undefined;
  let reached: Cook['targetsReached'];

  const startedCook = (): string => {
    if (!cookId) {
      throw new Error('no cook was started by an earlier proof');
    }
    return cookId;
  };

  return [
    {
      name: 'POST /devices/claim claims the simulated device for the owner',
      async run(api: AcceptanceApi) {
        await registerSimulatedDevice(api);
        registered = true;
      },
    },
    {
      name: 'any cook already active on the simulated device is stopped',
      async run(api: AcceptanceApi) {
        if (!registered) {
          throw new Error('the simulated device was not registered by an earlier proof');
        }
        for (const cook of await activeCooks(api)) {
          await stopCook(api, cook.id);
        }
      },
    },
    {
      name: 'POST /cooks with targets below the simulated readings starts a cook that has reached nothing: 201',
      async run(api: AcceptanceApi) {
        const body: StartCookRequest = {
          id: randomUUID(),
          name: `Acceptance targets ${api.runId}`,
          deviceId: api.simulatedDeviceId,
          meatType: 'acceptance',
          targetTemps: { ...TARGETS },
          notes: 'Synthetic cook written by the live acceptance suite (targets reached).',
        };
        const response = await api.request<Cook>({ method: 'POST', path: '/cooks', body });
        api.expectStatus(response, 201);
        api.check(response, response.body?.id === body.id, 'cook.id is not the id sent');
        api.check(
          response,
          response.body.targetsReached === undefined,
          `a new cook has targetsReached ${show(response.body.targetsReached)}`
        );
        cookId = body.id;
      },
    },
    {
      name: 'simdevice --twin --count 2 applies the cook and sends two readings tagged with it',
      async run(api: AcceptanceApi) {
        const id = startedCook();
        const run = await api.runSimDevice(SIMDEVICE_ARGS, { timeoutMs: SIMDEVICE_KILL_MS });
        expectSimDeviceExit0(run);
        const [twin, ...readings] = run.messages;
        if (run.unparsedLines !== 0 || readings.length !== 2) {
          throw new ProofFailure(
            `simdevice printed ${run.messages.length} JSON line(s) and ${run.unparsedLines} ` +
              'other line(s) on stdout, expected the twin line and 2 reading lines'
          );
        }
        const applied =
          isObject(twin) && isObject(twin['reported']) ? twin['reported']['activeCookId'] : undefined;
        if (applied !== id) {
          throw new ProofFailure(
            `the device applied cook ${show(applied)}, not ${id}: its readings are not tagged ` +
              'with the cook'
          );
        }
        parseSentReading(api, readings[0]);
        second = parseSentReading(api, readings[1]);
        sentAt = clock().now();
      },
    },
    {
      name: 'GET /cooks/{cookId} shows the grill and probe 1 reached at the second reading, probe 2 not',
      async run(api: AcceptanceApi) {
        const id = startedCook();
        if (!second || sentAt === undefined) {
          throw new Error('no readings were sent by an earlier proof');
        }
        const deadline = clock().now() + TARGETS_POLL.capMs;
        let last: AcceptanceResponse<Cook> | undefined;
        for (;;) {
          const response = await api.request<Cook>({
            method: 'GET',
            path: `/cooks/${encodeURIComponent(id)}`,
            route: '/cooks/{cookId}',
          });
          api.expectStatus(response, 200);
          last = response;
          if (reachedAtSecondReading(api, response, second)) {
            reached = response.body.targetsReached;
            api.metric('targets-reached-ms', clock().now() - sentAt);
            return;
          }
          if (clock().now() + TARGETS_POLL.intervalMs > deadline) {
            break;
          }
          await clock().sleep(TARGETS_POLL.intervalMs);
        }
        throw new ProofFailure(
          `the grill and probe 1 were not both reached within the ${TARGETS_POLL.capMs / 1000} s ` +
            `cap; last targetsReached ${show(last.body?.targetsReached)}`,
          last
        );
      },
    },
    {
      name: 'POST /cooks/{cookId}/stop stops the cook: 200, and it keeps its reached targets',
      async run(api: AcceptanceApi) {
        const id = startedCook();
        if (reached === undefined) {
          throw new Error('the targets were not reached in an earlier proof');
        }
        const response = await stopCook(api, id);
        api.check(
          response,
          response.body?.status === 'completed',
          `cook.status is ${show(response.body?.status)}, not completed`
        );
        api.check(
          response,
          JSON.stringify(response.body.targetsReached) === JSON.stringify(reached),
          `the stopped cook has targetsReached ${show(response.body.targetsReached)}, ` +
            `not ${show(reached)}`
        );
      },
    },
    {
      name: 'no cook is left active on the simulated device',
      // Runs whatever failed before it, so a failed run still frees the device.
      always: true,
      async run(api: AcceptanceApi) {
        if (!registered) {
          return;
        }
        for (const cook of await activeCooks(api)) {
          await stopCook(api, cook.id);
        }
      },
    },
  ];
});
