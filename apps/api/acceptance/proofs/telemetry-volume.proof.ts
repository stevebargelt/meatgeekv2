import type { TemperatureHistoryResponse, TemperatureReading } from '@meatgeekv2/api-interfaces';

import { expectErrorCode } from '../lib/checks';
import { clock } from '../lib/clock';
import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { defineProofs, ProofFailure } from '../lib/proof';

/**
 * HAR-45 (MG-79) and HAR-75 — `GET /temperatures/history`'s RU cost, measured
 * with one long cook's worth of readings on the standing simulated device: 12 h
 * at one reading every 5 s = 8,640.
 *
 * History pages by continuation token (HAR-75), so a deep page should cost what
 * the first one does. Before HAR-75 it paged by `OFFSET`, and the page at 8,600
 * readings in cost twice the first. This group is the live evidence:
 *
 *   1. the simulated device's readings are counted by walking
 *      `GET /temperatures/history?deviceId=<sim>&limit=1000` page by page,
 *      sequentially, each page resuming from the previous one's
 *      `continuationToken`;
 *   2. if the walk is short of the target, `simdevice --count <target − counted
 *      + margin> --inflight <inflight> --interval <interval>` tops it up through
 *      IoT Hub;
 *   3. after a top-up, `GET /temperatures/current/<sim>` is polled until it
 *      shows the end of the top-up: the routing backlog it made on the shared
 *      throughput offer has drained before the measuring walk and later groups;
 *   4. the device is walked once more. That walk prints `METRIC
 *      history-ru-first-page`, `history-ru-last-page` and `history-pages`, must
 *      count at least the target, and its last page must cost at most 1.5 × its
 *      first.
 *
 * The device is registered to the caller by `telemetry-roundtrip.proof.ts`,
 * which runs first (file-name order). Readings are never deleted; they expire
 * on the dev `temperatures` TTL (7 days, `temperature_data_ttl_days` in
 * `apps/infrastructure/environments/dev.tfvars`), which is why every run checks
 * the volume and tops it up when it is short.
 */

/**
 * The volume and pacing. The self-test shrinks the volume (`target`, `margin`,
 * `pageLimit`); nothing else should, and there is deliberately no environment
 * variable for them. The polls run on the injected clock (../lib/clock), so
 * the self-test keeps their live values.
 *
 * `intervalMs` — the gap simdevice leaves between send starts. The `temperatures`
 * container has no throughput of its own: it shares ONE 400 RU/s
 * database-level offer with the other four containers
 * (`apps/infrastructure/modules/cosmos-db/main.tf`, `throughput = 400` on the
 * shared database), and IoT Hub's routed writes are paid from that same offer.
 * The top-up may use at most half of it: 200 RU/s. At ~10 RU per routed write
 * that is at most 20 writes/s, so at least 1000 ms / 20 = 50 ms between sends.
 * With `--inflight` above 1 simdevice starts a send at most once per interval,
 * whatever the acknowledgement latency, so the rate never exceeds 20/s.
 *
 * `inflight` — how many sends may await IoT Hub's acknowledgement at once
 * (HAR-46). With one, each ~200 ms QoS 1 round trip is paid in series and the
 * rate is ~5/s, not 20 (8,640 readings took ~30 min). 32 in flight covers a
 * round trip of up to 32 × 50 ms = 1.6 s, so the interval sets the pace.
 */
export const VOLUME = {
  /** One long cook: 12 h × 3600 s / 5 s per reading. */
  target: 8_640,
  /** Sent on top of the shortfall, for readings that expire during the run. */
  margin: 60,
  intervalMs: 50,
  inflight: 32,
  /** The walks' page size: the largest the API serves (`HISTORY_MAX_LIMIT`). */
  pageLimit: 1_000,
  /** Step 3: how often the current reading is re-read... */
  pollIntervalMs: 10_000,
  /** ...and for how long after the send ends. */
  pollCapMs: 15 * 60_000,
};

/** The last page of the measuring walk may cost at most this × the first. */
export const DEEP_PAGE_RU_RATIO = 1.5;

/** A walk that has not ended after this many pages is a paging bug, not volume. */
const MAX_WALK_PAGES = 100;

/**
 * The top-up's time limit, after which simdevice is killed: the paced send
 * time (`count × intervalMs`) with half again for slack, plus 120 s to connect
 * and drain the last acknowledgements. Pipelined sends start at the interval
 * whatever the publish round trip, so no per-message publish time is assumed.
 */
export function topupTimeLimitMs(count: number): number {
  return count * VOLUME.intervalMs * 1.5 + 120_000;
}

/**
 * When a top-up has drained: the earliest timestamp the LAST reading to reach
 * IoT Hub can carry. simdevice stamps readings in send-start order, strictly
 * increasing, and keeps at most `inflight` sends unacknowledged. When the last
 * send starts, every reading more than `inflight` places before it has already
 * been acknowledged, so the last reading the hub enqueues is one of the final
 * `inflight` and its timestamp is at least the one at place `count − inflight`
 * (0-based). The current reading is the newest enqueued, so once it is at or
 * after that timestamp the top-up's tail has been routed. (Waiting for the
 * single newest timestamp could wait forever: with sends in flight, it need not
 * be the last one enqueued.)
 */
export function topupDrainedAt(timestamps: readonly number[], inflight: number): number {
  const sorted = [...timestamps].sort((a, b) => a - b);
  return sorted[Math.max(0, sorted.length - inflight)];
}

const historyPath = (deviceId: string, query = '') =>
  `/temperatures/history?deviceId=${encodeURIComponent(deviceId)}${query}`;

/** What a walk of the simulated device's history found and paid. */
interface Walk {
  readonly readings: number;
  readonly pages: number;
  readonly firstCharge: number;
  readonly lastCharge: number;
  readonly last: AcceptanceResponse<TemperatureHistoryResponse>;
}

/**
 * Every reading of the simulated device, `VOLUME.pageLimit` a page, one request
 * at a time: each page resumes from the previous page's `continuationToken`
 * and the walk ends at the first page without one.
 */
async function walkHistory(api: AcceptanceApi): Promise<Walk> {
  let readings = 0;
  let firstCharge: number | undefined;
  let continuationToken: string | undefined;
  for (let pages = 1; pages <= MAX_WALK_PAGES; pages += 1) {
    const response = await api.request<TemperatureHistoryResponse>({
      method: 'GET',
      path: historyPath(
        api.simulatedDeviceId,
        `&limit=${VOLUME.pageLimit}` +
          (continuationToken === undefined
            ? ''
            : `&continuationToken=${encodeURIComponent(continuationToken)}`)
      ),
      route: '/temperatures/history',
    });
    api.expectStatus(response, 200);
    const body = response.body;
    api.check(response, Array.isArray(body?.readings), 'body.readings is not an array');
    api.check(
      response,
      body.readings.length <= VOLUME.pageLimit,
      `the page has ${body.readings.length} readings, more than limit ${VOLUME.pageLimit}`
    );
    api.check(response, !('total' in body) && !('offset' in body), 'body has total or offset');
    const charge = response.requestCharge as number;
    firstCharge ??= charge;
    readings += body.readings.length;

    if (body.hasMore !== true) {
      api.check(
        response,
        body.continuationToken === undefined,
        'hasMore is false but a continuationToken was returned'
      );
      return { readings, pages, firstCharge, lastCharge: charge, last: response };
    }
    api.check(
      response,
      typeof body.continuationToken === 'string' && body.continuationToken.length > 0,
      'hasMore is true without a continuationToken'
    );
    continuationToken = body.continuationToken;
  }
  throw new ProofFailure(
    `the history walk did not end within ${MAX_WALK_PAGES} pages of ${VOLUME.pageLimit}`
  );
}

/** The `timestamp` of each reading simdevice printed, as epoch ms. */
function sentTimestamps(messages: readonly unknown[]): number[] {
  return messages.map(message => {
    const timestamp = (message as { timestamp?: unknown } | null)?.timestamp;
    const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    if (Number.isNaN(parsed)) {
      throw new ProofFailure(
        `simdevice printed a reading without a parseable timestamp: ${JSON.stringify(timestamp)}`
      );
    }
    return parsed;
  });
}

export default defineProofs('telemetry volume', () => {
  let readingsBefore: number | undefined;
  /** Set after a top-up: when its tail has reached the current reading. */
  let drainedAt: number | undefined;
  let ready = false;

  return [
    {
      name: 'GET /temperatures/history walks the simulated device page by page',
      async run(api: AcceptanceApi) {
        ({ readings: readingsBefore } = await walkHistory(api));
        api.metric('history-readings-before', readingsBefore);
      },
    },
    {
      name: 'simdevice tops the volume up to one long cook when it is short',
      async run(api: AcceptanceApi) {
        if (readingsBefore === undefined) {
          throw new Error('the volume was not read by an earlier proof');
        }
        if (readingsBefore >= VOLUME.target) {
          api.metric('topup-sent', 0);
          api.metric('topup-ms', 0);
          return;
        }
        const count = VOLUME.target - readingsBefore + VOLUME.margin;
        const timeoutMs = topupTimeLimitMs(count);
        const started = clock().now();
        const run = await api.runSimDevice(
          [
            '--count',
            String(count),
            '--inflight',
            String(VOLUME.inflight),
            '--interval',
            `${VOLUME.intervalMs}ms`,
          ],
          { timeoutMs }
        );
        const elapsed = clock().now() - started;
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
        drainedAt = topupDrainedAt(sentTimestamps(run.messages), VOLUME.inflight);
        api.metric('topup-sent', count);
        api.metric('topup-ms', elapsed);
      },
    },
    {
      name: 'GET /temperatures/current/{deviceId} shows the end of the top-up',
      async run(api: AcceptanceApi) {
        if (readingsBefore === undefined) {
          throw new Error('the volume was not read by an earlier proof');
        }
        if (drainedAt === undefined) {
          // No top-up was needed (the earlier proof failed otherwise).
          ready = true;
          return;
        }
        const deadline = clock().now() + VOLUME.pollCapMs;
        let last: AcceptanceResponse<TemperatureReading>;
        for (;;) {
          last = await api.request<TemperatureReading>({
            method: 'GET',
            path: `/temperatures/current/${encodeURIComponent(api.simulatedDeviceId)}`,
            route: '/temperatures/current/{deviceId}',
          });
          // Nothing routed yet (404 NO_READINGS) or an older reading: keep
          // polling. Anything else is a failure now.
          if (last.status === 404) {
            expectErrorCode(api, last, 'NO_READINGS');
          } else {
            api.expectStatus(last, 200);
          }
          const shown = last.status === 200 ? Date.parse(String(last.body?.timestamp)) : NaN;
          if (shown >= drainedAt) {
            ready = true;
            return;
          }
          if (clock().now() + VOLUME.pollIntervalMs > deadline) {
            break;
          }
          await clock().sleep(VOLUME.pollIntervalMs);
        }
        throw new ProofFailure(
          `the current reading is ${last.status === 200 ? JSON.stringify(last.body?.timestamp) : 'none'}, ` +
            `before the top-up's ` +
            `end (${new Date(drainedAt).toISOString()}), after the ` +
            `${VOLUME.pollCapMs / 1000} s cap`,
          last
        );
      },
    },
    {
      name: `GET /temperatures/history walked again: the last page costs at most ${DEEP_PAGE_RU_RATIO} × the first`,
      async run(api: AcceptanceApi) {
        if (!ready) {
          throw new Error('the volume was not confirmed by an earlier proof');
        }
        const walk = await walkHistory(api);
        api.metric('history-readings', walk.readings);
        api.metric('history-pages', walk.pages);
        api.metric('history-ru-first-page', walk.firstCharge);
        api.metric('history-ru-last-page', walk.lastCharge);
        api.check(
          walk.last,
          walk.readings >= VOLUME.target,
          `the walk counted ${walk.readings} readings, short of ${VOLUME.target}`
        );
        api.check(
          walk.last,
          walk.lastCharge <= DEEP_PAGE_RU_RATIO * walk.firstCharge,
          `the last page (page ${walk.pages}) cost ${walk.lastCharge} RU, more than ` +
            `${DEEP_PAGE_RU_RATIO} × the first page's ${walk.firstCharge} RU`
        );
      },
    },
  ];
});
