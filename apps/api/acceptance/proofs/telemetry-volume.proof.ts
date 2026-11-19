import type { TemperatureHistoryResponse } from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { defineProofs, ProofFailure } from '../lib/proof';

/**
 * HAR-45 (MG-79, its last deferred criterion) — `GET /temperatures/history`'s
 * RU cost, measured with one long cook's worth of readings on the standing
 * simulated device: 12 h at one reading every 5 s = 8,640.
 *
 *   1. `GET /temperatures/history?deviceId=<sim>&limit=1` reads `total` (a
 *      `COUNT(1)` over the device's partition);
 *   2. if it is short of the target, `simdevice --count <target − total +
 *      margin> --interval <interval>` tops it up through IoT Hub;
 *   3. the same `limit=1` request is polled until `total` reaches the target:
 *      the top-up is readable, and the routing backlog it made on the shared
 *      throughput offer has drained before later groups run;
 *   4. three history pages are read and their request charge printed: the
 *      first default page, the last default page (the deepest `OFFSET`), and
 *      the largest page one request returns (`limit=5000` over the last 12 h).
 *
 * The device is registered to the caller by `telemetry-roundtrip.proof.ts`,
 * which runs first (file-name order). Readings are never deleted; they expire
 * on the dev `temperatures` TTL (7 days, `temperature_data_ttl_days` in
 * `apps/infrastructure/environments/dev.tfvars`), which is why every run checks
 * the volume and tops it up when it is short.
 */

/**
 * The volume and pacing. The self-test shrinks these; nothing else should, and
 * there is deliberately no environment variable for them.
 *
 * `intervalMs` — the gap simdevice leaves between sends. The `temperatures`
 * container has no throughput of its own: it shares ONE 400 RU/s
 * database-level offer with the other four containers
 * (`apps/infrastructure/modules/cosmos-db/main.tf`, `throughput = 400` on the
 * shared database), and IoT Hub's routed writes are paid from that same offer.
 * The top-up may use at most half of it: 200 RU/s. At ~10 RU per routed write
 * that is at most 20 writes/s, so at least 1000 ms / 20 = 50 ms between sends.
 * simdevice waits the interval AFTER each acknowledged publish, so the real
 * rate is lower still, never higher.
 */
export const VOLUME = {
  /** One long cook: 12 h × 3600 s / 5 s per reading. */
  target: 8_640,
  /** Sent on top of the shortfall, for readings that expire during the run. */
  margin: 60,
  intervalMs: 50,
  /** Step 3: how often `total` is re-read... */
  pollIntervalMs: 10_000,
  /** ...and for how long after the send ends. */
  pollCapMs: 15 * 60_000,
};

/**
 * How long one top-up message may take on top of `intervalMs` (the QoS 1
 * publish round trip to IoT Hub), and how long simdevice may take to connect,
 * before the run is killed: the top-up's time limit is
 * `count × (intervalMs + PUBLISH_ALLOWANCE_MS) + START_ALLOWANCE_MS`.
 */
const PUBLISH_ALLOWANCE_MS = 100;
const START_ALLOWANCE_MS = 60_000;

/** The API's default page size (`HISTORY_DEFAULT_LIMIT` in get-history.ts). */
const DEFAULT_PAGE = 100;
/** The largest page one request may ask for (`HISTORY_MAX_LIMIT`). */
const MAX_PAGE = 5_000;
/** The window of the max-page read: one long cook. */
const LONG_COOK_MS = 12 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const historyPath = (deviceId: string, query = '') =>
  `/temperatures/history?deviceId=${encodeURIComponent(deviceId)}${query}`;

/** `GET /temperatures/history?…&limit=1`, expecting a 200 with a numeric `total`. */
async function readTotal(
  api: AcceptanceApi
): Promise<{ response: AcceptanceResponse<TemperatureHistoryResponse>; total: number }> {
  const response = await api.request<TemperatureHistoryResponse>({
    method: 'GET',
    path: historyPath(api.simulatedDeviceId, '&limit=1'),
    route: '/temperatures/history',
  });
  api.expectStatus(response, 200);
  const total = response.body?.total;
  api.check(
    response,
    typeof total === 'number' && Number.isInteger(total) && total >= 0,
    `body.total is ${JSON.stringify(total)}, not a count`
  );
  return { response, total };
}

/** Fail unless a history page is a 200 whose `readings` is an array. */
function expectPage(
  api: AcceptanceApi,
  response: AcceptanceResponse<TemperatureHistoryResponse>
): readonly unknown[] {
  api.expectStatus(response, 200);
  const readings = response.body?.readings;
  api.check(response, Array.isArray(readings), 'body.readings is not an array');
  return readings;
}

export default defineProofs('telemetry volume', () => {
  let totalBefore: number | undefined;
  let total: number | undefined;

  return [
    {
      name: 'GET /temperatures/history?limit=1 reads the simulated device volume',
      async run(api: AcceptanceApi) {
        ({ total: totalBefore } = await readTotal(api));
        api.metric('history-total-before', totalBefore);
      },
    },
    {
      name: 'simdevice tops the volume up to one long cook when it is short',
      async run(api: AcceptanceApi) {
        if (totalBefore === undefined) {
          throw new Error('the volume was not read by an earlier proof');
        }
        if (totalBefore >= VOLUME.target) {
          api.metric('topup-sent', 0);
          api.metric('topup-ms', 0);
          return;
        }
        const count = VOLUME.target - totalBefore + VOLUME.margin;
        const timeoutMs = count * (VOLUME.intervalMs + PUBLISH_ALLOWANCE_MS) + START_ALLOWANCE_MS;
        const started = Date.now();
        const run = await api.runSimDevice(
          ['--count', String(count), '--interval', `${VOLUME.intervalMs}ms`],
          { timeoutMs }
        );
        const elapsed = Date.now() - started;
        if (run.exitCode !== 0) {
          throw new ProofFailure(
            (run.exitCode === null
              ? `simdevice was killed after the ${Math.round(timeoutMs / 1000)} s limit`
              : `simdevice exited ${run.exitCode}, expected 0`) +
              ` (${run.messages.length} of ${count} message(s) sent)` +
              (run.stderrFirstLine ? `: ${run.stderrFirstLine}` : '')
          );
        }
        if (run.messages.length !== count || run.unparsedLines > 0) {
          throw new ProofFailure(
            `simdevice printed ${run.messages.length} JSON line(s) and ` +
              `${run.unparsedLines} other line(s) on stdout, expected ${count} JSON lines`
          );
        }
        api.metric('topup-sent', count);
        api.metric('topup-ms', elapsed);
      },
    },
    {
      name: 'GET /temperatures/history?limit=1 reaches one long cook of readings',
      async run(api: AcceptanceApi) {
        const deadline = Date.now() + VOLUME.pollCapMs;
        let last: { response: AcceptanceResponse; total: number };

        for (;;) {
          last = await readTotal(api);
          if (last.total >= VOLUME.target) {
            total = last.total;
            api.metric('history-total', total);
            return;
          }
          if (Date.now() + VOLUME.pollIntervalMs > deadline) {
            break;
          }
          await sleep(VOLUME.pollIntervalMs);
        }

        throw new ProofFailure(
          `total is ${last.total}, short of ${VOLUME.target}, after the ` +
            `${VOLUME.pollCapMs / 1000} s cap`,
          last.response
        );
      },
    },
    {
      name: 'GET /temperatures/history pages report their request charge at that volume',
      async run(api: AcceptanceApi) {
        if (total === undefined) {
          throw new Error('the volume was not confirmed by an earlier proof');
        }
        const deviceId = api.simulatedDeviceId;
        const route = '/temperatures/history';

        const first = await api.request<TemperatureHistoryResponse>({
          method: 'GET',
          path: historyPath(deviceId),
          route,
        });
        const firstReadings = expectPage(api, first);
        api.check(
          first,
          firstReadings.length === DEFAULT_PAGE,
          `the first page has ${firstReadings.length} reading(s), expected ${DEFAULT_PAGE}`
        );
        api.metric('history-ru-first-page', first.requestCharge as number);

        // The deepest page: Cosmos OFFSET cost grows with the rows skipped. The
        // first page's total is the freshest count.
        const lastOffset = Math.max(0, first.body.total - DEFAULT_PAGE);
        const lastPage = await api.request<TemperatureHistoryResponse>({
          method: 'GET',
          path: historyPath(deviceId, `&offset=${lastOffset}`),
          route,
        });
        const lastReadings = expectPage(api, lastPage);
        api.check(
          lastPage,
          lastReadings.length >= 1,
          `the page at offset ${lastOffset} is empty, expected at least one reading`
        );
        api.metric('history-ru-last-page', lastPage.requestCharge as number);

        const startTime = new Date(Date.now() - LONG_COOK_MS).toISOString();
        const max = await api.request<TemperatureHistoryResponse>({
          method: 'GET',
          path: historyPath(
            deviceId,
            `&startTime=${encodeURIComponent(startTime)}&limit=${MAX_PAGE}`
          ),
          route,
        });
        const maxReadings = expectPage(api, max);
        api.metric('history-ru-max-page', max.requestCharge as number);
        // How many readings that charge bought: the last 12 h hold a full page
        // only on a run that has just topped up (see live-acceptance.md).
        api.metric('history-max-page-readings', maxReadings.length);
      },
    },
  ];
});
