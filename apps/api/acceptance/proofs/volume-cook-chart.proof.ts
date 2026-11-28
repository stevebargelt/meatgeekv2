import { randomUUID } from 'crypto';

import type {
  Cook,
  CookChart,
  CookListResponse,
  StartCookRequest,
} from '@meatgeekv2/api-interfaces';

import { clock } from '../lib/clock';
import { claimStandingDevice } from '../lib/enrolment';
import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { defineProofs, ProofFailure } from '../lib/proof';
import { topupTimeLimitMs, VOLUME } from './telemetry-volume.proof';

/**
 * HAR-87 (goal HAR-71, item 5) — what loading a 12-hour cook's chart costs,
 * measured live on a real cook with 12 hours of readings, and held to
 * {@link CHART_RU_BUDGET}.
 *
 * `GET /cooks/{cookId}/chart` (HAR-86) reads the cook's device's hourly rollup
 * documents. The server sets a cook's `startTime` when it starts it, and
 * device-twin.proof.ts starts and stops cooks on the standing simulated device
 * every run, so this proof keeps ONE STANDING ACTIVE COOK on the second
 * standing device, the chart device (ACCEPTANCE_CHART_DEVICE_ID, HAR-84), and
 * NEVER stops it. An active cook's chart covers every reading from `startTime`
 * on with no upper bound, so the readings are stamped from `startTime` forward
 * (`simdevice --start <startTime> --step 5s`), whenever they are sent.
 *
 *   1. the chart device is configured (both variables are set);
 *   2. (HAR-140) the chart device is claimed for the caller with its own claim
 *      code (`POST /devices/claim`, 201 or 200; `claimStandingDevice` in
 *      ../lib/enrolment), and never released;
 *   3. the standing cook is found with `GET /cooks?deviceId=<chart>&status=
 *      active`; with none, `POST /cooks` starts one;
 *   4. the chart is loaded and checked for coverage ({@link chartCoverage});
 *   5. if it is not covered, `simdevice` sends {@link CHART.readings} readings
 *      as the chart device, stamped `startTime + i × 5 s`, paced as the volume
 *      top-up is, and the chart is polled until it is covered. `METRIC
 *      chart-topup-sent` is the number sent (0 when none);
 *   6. one more `GET /cooks/{cookId}/chart` is the measurement: `METRIC
 *      chart-ru-12h`, `chart-points`, `chart-bucket-seconds`. It must cost at
 *      most {@link CHART_RU_BUDGET}.
 *
 * The first run tops up once: 8,640 messages, ~86k RU of routed writes plus
 * the rollup writes. Rollups have no TTL, so later runs find the chart covered
 * and send nothing; the raw readings expire (ADR 0001), but the chart never
 * reads them. If the cook is stopped by hand, the next run starts a new one
 * and tops that up. The file name sorts after cooks-lifecycle.proof.ts and
 * telemetry-volume.proof.ts, so it runs after both (file-name order).
 */

/**
 * The chart of a 12-hour cook may cost at most this many RU to load. Goal
 * HAR-71 states the budget: HAR-86 serves the chart from per-device, per-hour
 * rollup documents (one single-partition query over about 13 of them) so that
 * a long cook's chart costs a few dozen RU, not the ~400 RU of reading its
 * 8,640 raw readings (the history walk pays about 47 RU per 1,000). If the measurement is over, the budget is not raised:
 * the number is reported on the issue and the rollup design revisited.
 */
export const CHART_RU_BUDGET = 40;

/**
 * The standing cook's readings and the coverage polling. The self-test shrinks
 * `readings`; nothing else should, and there is deliberately no environment
 * variable for them. The polling runs on the injected clock (../lib/clock), so
 * the self-test keeps its live values. Pacing (interval, in flight) is the volume
 * top-up's, {@link VOLUME}: at most 200 RU/s of the shared 400 RU/s offer.
 */
export const CHART = {
  /** One long cook: 12 h × 3600 s / 5 s per reading. */
  readings: 8_640,
  /** The gap between consecutive readings' timestamps (`--step`). */
  stepSeconds: 5,
  /** Step 5: how often the chart is re-read after a top-up... */
  pollIntervalMs: 10_000,
  /** ...and for how long after the send ends. */
  pollCapMs: 15 * 60_000,
};

/** What {@link chartCoverage} found. */
export interface Coverage {
  readonly covered: boolean;
  /** Why it is not covered, for a failure message. */
  readonly reason?: string;
}

/**
 * Whether `chart` covers the standing cook's readings: its points run from
 * within one bucket of `startTime` to the bucket holding the last reading,
 * `startTime + (readings − 1) × step` (12 h − 5 s live).
 *
 * Point `t`s are bucket starts, so the bucket holding an instant `x` has
 * `t > x − bucketSeconds`. The first point must be the bucket holding
 * `startTime` (`t < startTime + bucketSeconds`); the last must be at or after
 * the bucket holding the last reading. That is the issue's "at least
 * `startTime + 12 h − bucketSeconds`", measured to the last reading itself:
 * buckets start on `startTime`'s minute, not on `startTime`, so a last bucket
 * starting a few seconds before `startTime + 12 h − bucketSeconds` can still
 * hold the last reading.
 */
export function chartCoverage(chart: CookChart): Coverage {
  const startMs = Date.parse(chart.startTime);
  const bucketMs = chart.bucketSeconds * 1000;
  if (chart.points.length === 0) {
    return { covered: false, reason: 'the chart has no points' };
  }
  const firstMs = Date.parse(chart.points[0].t);
  const lastMs = Date.parse(chart.points[chart.points.length - 1].t);
  const lastReadingMs = startMs + (CHART.readings - 1) * CHART.stepSeconds * 1000;
  if (!(firstMs < startMs + bucketMs)) {
    return {
      covered: false,
      reason:
        `the first point (${chart.points[0].t}) is more than one ${chart.bucketSeconds} s ` +
        `bucket after startTime ${chart.startTime}`,
    };
  }
  if (!(lastMs > lastReadingMs - bucketMs)) {
    return {
      covered: false,
      reason:
        `the last point (${chart.points[chart.points.length - 1].t}) ends before the last ` +
        `reading, ${new Date(lastReadingMs).toISOString()} (${chart.bucketSeconds} s buckets)`,
    };
  }
  return { covered: true };
}

/** `--start`: the cook's startTime, at millisecond precision, UTC. */
function startArgument(startTime: string): string {
  return new Date(Date.parse(startTime)).toISOString();
}

export default defineProofs('cook chart', () => {
  let deviceId: string | undefined;
  let deviceReady = false;
  let cook: Cook | undefined;
  let coverage: Coverage | undefined;
  /** Set when the chart was covered on load or after a top-up. */
  let covered = false;
  /** Set after a top-up was sent: the chart must still be polled. */
  let toppedUp = false;

  const chartDevice = (): string => {
    if (deviceId === undefined) {
      throw new Error('the chart device was not configured (an earlier proof failed)');
    }
    return deviceId;
  };
  const standingCook = (): Cook => {
    if (!cook) {
      throw new Error('no standing cook was found or started by an earlier proof');
    }
    return cook;
  };

  const getChart = (api: AcceptanceApi, cookId: string) =>
    api.request<CookChart>({
      method: 'GET',
      path: `/cooks/${encodeURIComponent(cookId)}/chart`,
      route: '/cooks/{cookId}/chart',
    });

  /** Load the standing cook's chart: 200, the cook's, with a request charge. */
  const loadChart = async (
    api: AcceptanceApi
  ): Promise<{ response: AcceptanceResponse<CookChart>; coverage: Coverage }> => {
    const standing = standingCook();
    const response = await getChart(api, standing.id);
    api.expectStatus(response, 200);
    api.check(
      response,
      response.body.cookId === standing.id && response.body.deviceId === standing.deviceId,
      `the chart is of cook ${response.body.cookId} on ${response.body.deviceId}, not the standing cook`
    );
    return { response, coverage: chartCoverage(response.body) };
  };

  return [
    {
      name: 'the chart device is configured (ACCEPTANCE_CHART_DEVICE_ID, ACCEPTANCE_CHART_STATE_DIR)',
      async run(api: AcceptanceApi) {
        // The runner stops the run when only one is set (HAR-84); here neither is.
        if (api.chartDeviceId === undefined) {
          throw new ProofFailure(
            'ACCEPTANCE_CHART_DEVICE_ID and ACCEPTANCE_CHART_STATE_DIR are not set; ' +
              'the cook-chart proof needs the chart device'
          );
        }
        deviceId = api.chartDeviceId;
      },
    },
    {
      name: 'POST /devices/claim claims the chart device for the caller with its own claim code',
      async run(api: AcceptanceApi) {
        chartDevice();
        // HAR-140: claimed once per run (200 when the caller already holds it,
        // which keeps its claimedAt and so the cook's rollups in view), never
        // released: its standing cook would make a release 409 COOK_ACTIVE.
        await claimStandingDevice(api, 'chart', {
          name: 'Acceptance chart device',
          model: 'simdevice',
          location: 'CI',
        });
        deviceReady = true;
      },
    },
    {
      name: 'GET /cooks?deviceId=<chart>&status=active finds the standing cook (POST /cooks starts one when there is none)',
      async run(api: AcceptanceApi) {
        const id = chartDevice();
        if (!deviceReady) {
          throw new Error('the chart device was not claimed by an earlier proof');
        }
        const query = new URLSearchParams({ deviceId: id, status: 'active' });
        const listed = await api.request<CookListResponse>({
          method: 'GET',
          path: `/cooks?${query.toString()}`,
          route: '/cooks',
        });
        api.expectStatus(listed, 200);
        const active = listed.body.cooks.filter(c => c.deviceId === id && c.status === 'active');
        if (active.length > 0) {
          cook = active[0];
          return;
        }
        const started: StartCookRequest = {
          id: randomUUID(),
          name: 'acceptance standing chart cook',
          deviceId: id,
          meatType: 'brisket',
          notes: 'Standing cook kept active by the live acceptance suite (HAR-87). Do not stop.',
        };
        const response = await api.request<Cook>({ method: 'POST', path: '/cooks', body: started });
        api.expectStatus(response, 201);
        api.check(
          response,
          response.body.id === started.id && response.body.status === 'active',
          `the started cook is ${response.body.id} (${response.body.status}), not ${started.id} (active)`
        );
        cook = response.body;
      },
    },
    {
      name: "GET /cooks/{cookId}/chart: is the standing cook's 12 h covered",
      async run(api: AcceptanceApi) {
        ({ coverage } = await loadChart(api));
        covered = coverage.covered;
      },
    },
    {
      name: 'simdevice tops the chart device up to 12 h of readings from the cook start when it is not',
      async run(api: AcceptanceApi) {
        const standing = standingCook();
        if (coverage === undefined) {
          throw new Error('the chart was not loaded by an earlier proof');
        }
        if (coverage.covered) {
          api.metric('chart-topup-sent', 0);
          return;
        }
        const count = CHART.readings;
        const start = startArgument(standing.startTime);
        const timeoutMs = topupTimeLimitMs(count);
        const run = await api.runSimDevice(
          [
            '--count',
            String(count),
            '--start',
            start,
            '--step',
            `${CHART.stepSeconds}s`,
            '--inflight',
            String(VOLUME.inflight),
            '--interval',
            `${VOLUME.intervalMs}ms`,
          ],
          { device: 'chart', timeoutMs }
        );
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
        // The stamps must be the cook's, not the wall clock's.
        const stamps = run.messages
          .map(m => Date.parse(String((m as { timestamp?: unknown } | null)?.timestamp)))
          .sort((a, b) => a - b);
        const firstWant = Date.parse(start);
        const lastWant = firstWant + (count - 1) * CHART.stepSeconds * 1000;
        if (stamps[0] !== firstWant || stamps[stamps.length - 1] !== lastWant) {
          throw new ProofFailure(
            `simdevice stamped ${new Date(stamps[0]).toISOString()} … ` +
              `${new Date(stamps[stamps.length - 1]).toISOString()}, expected ` +
              `${new Date(firstWant).toISOString()} … ${new Date(lastWant).toISOString()}`
          );
        }
        toppedUp = true;
        api.metric('chart-topup-sent', count);
      },
    },
    {
      name: 'GET /cooks/{cookId}/chart covers 12 h once the top-up is rolled up',
      async run(api: AcceptanceApi) {
        if (covered) {
          return;
        }
        if (!toppedUp) {
          throw new Error('the chart was not topped up by an earlier proof');
        }
        const deadline = clock().now() + CHART.pollCapMs;
        let last: { response: AcceptanceResponse<CookChart>; coverage: Coverage };
        for (;;) {
          last = await loadChart(api);
          if (last.coverage.covered) {
            covered = true;
            return;
          }
          if (clock().now() + CHART.pollIntervalMs > deadline) {
            break;
          }
          await clock().sleep(CHART.pollIntervalMs);
        }
        throw new ProofFailure(
          `the chart is not covered after the ${CHART.pollCapMs / 1000} s cap: ${last.coverage.reason}`,
          last.response
        );
      },
    },
    {
      name: `GET /cooks/{cookId}/chart of a 12 h cook costs at most ${CHART_RU_BUDGET} RU`,
      async run(api: AcceptanceApi) {
        if (!covered) {
          throw new Error('the chart was not covered by an earlier proof');
        }
        const { response, coverage: measured } = await loadChart(api);
        const charge = response.requestCharge as number;
        api.metric('chart-ru-12h', charge);
        api.metric('chart-points', response.body.points.length);
        api.metric('chart-bucket-seconds', response.body.bucketSeconds);
        api.check(response, measured.covered, `the chart is no longer covered: ${measured.reason}`);
        api.check(
          response,
          charge <= CHART_RU_BUDGET,
          `the chart of a 12 h cook cost ${charge} RU, over the ${CHART_RU_BUDGET} RU budget ` +
            '(CHART_RU_BUDGET)'
        );
      },
    },
  ];
});
