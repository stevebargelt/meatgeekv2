import { randomUUID } from 'crypto';

import type {
  Cook,
  CookListResponse,
  StartCookRequest,
  TemperatureReading,
} from '@meatgeekv2/api-interfaces';

import { expectErrorCode } from '../lib/checks';
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
 * HAR-68 (goal HAR-55, items 1, 2 and 7c) — a cook started while the simulated
 * device is offline reaches it through the IoT Hub device twin, and the device
 * reports that it applied it.
 *
 * Start and stop sync the twin's desired `activeCookId` / `correlationId` to
 * Cosmos (HAR-66). `simdevice --twin` (HAR-58) runs the Pi's own twin code: it
 * connects, GETs the twin, applies the desired cook, reports it, GETs again and
 * prints one `{"event":"twin","desired":…,"reported":…}` line, then sends
 * `--count` readings carrying the applied cook. simdevice is short-lived, so it
 * is not connected when the cook starts: each run is a reconnect.
 *
 *   1. the simulated device is registered to the owner;
 *   2. any cook active on it is stopped, so the device lock is free;
 *   3. `POST /cooks` with `X-Request-ID: acceptance-twin-<runId>` is 201 (a 503
 *      DEVICE_TWIN_UPDATE_FAILED fails, printing its fixed `reason`);
 *   4. `simdevice --twin --count 1`: desired and reported carry the cook and the
 *      correlation id, and `reported.appliedDesiredVersion` is
 *      `desired.$version`. `METRIC twin-apply-ms`: the 201 to simdevice's exit.
 *      HAR-152: the twin line's `applyLagMs`, the device's own measure from
 *      the API's `cookUpdatedAt` stamp to its GET, is a non-negative integer;
 *      it is printed on the PASS line and as `METRIC twin-device-apply-lag-ms`;
 *   5. `GET /temperatures/current/{deviceId}` is polled until it returns the
 *      reading just sent (by timestamp, as an instant); its `cookId` is the cook;
 *   6. `POST /cooks/{cookId}/stop` is 200;
 *   7. `simdevice --twin --count 0`: no desired cook, reported cook null, and
 *      the reported version is the new desired `$version`;
 *   8. always, whatever failed before: no cook is left active on the device.
 */

/** Poll pacing for step 5, on the injected clock (../lib/clock). */
export const TWIN_POLL: { readonly intervalMs: number; readonly capMs: number } = {
  intervalMs: 2_000,
  capMs: 90_000,
};

/** simdevice's own wait for the twin (`--timeout`), and the runner's kill
 *  after it, which leaves room for the connect and a reading. */
const TWIN_TIMEOUT = '60s';
const SIMDEVICE_KILL_MS = 120_000;

/** A fixed error code from a 503 body: lower-case words and digits only, so a
 *  server that echoes request data cannot put it in the output. */
const fixedCode = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : undefined;

interface TwinLine {
  /** HAR-152: ms from the API's `cookUpdatedAt` to the device applying it. */
  readonly applyLagMs?: unknown;
  readonly desired: {
    readonly activeCookId?: unknown;
    readonly correlationId?: unknown;
    readonly $version?: unknown;
  };
  readonly reported: {
    readonly activeCookId?: unknown;
    readonly correlationId?: unknown;
    readonly appliedDesiredVersion?: unknown;
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Fail with `message` unless `condition` holds. simdevice output has no
 *  response to attribute a failure to. */
function expectTwin(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ProofFailure(message);
  }
}

/**
 * Run `simdevice --twin --count <count>` and return its twin line and, for a
 * count of 1, the reading it sent. Fails unless it exits 0 and prints exactly
 * one twin line first, then `count` reading lines and nothing else.
 */
async function reconnect(
  api: AcceptanceApi,
  count: 0 | 1
): Promise<{ twin: TwinLine; reading?: SentReading }> {
  const run = await api.runSimDevice(
    ['--twin', '--count', String(count), '--timeout', TWIN_TIMEOUT],
    { timeoutMs: SIMDEVICE_KILL_MS }
  );
  expectSimDeviceExit0(run);
  const [first, ...rest] = run.messages;
  expectTwin(
    run.unparsedLines === 0 && rest.length === count,
    `simdevice printed ${run.messages.length} JSON line(s) and ${run.unparsedLines} other ` +
      `line(s) on stdout, expected the twin line and ${count} reading line(s)`
  );
  expectTwin(
    isObject(first) &&
      first['event'] === 'twin' &&
      isObject(first['desired']) &&
      isObject(first['reported']),
    'simdevice\'s first line is not {"event":"twin","desired":{…},"reported":{…}}'
  );
  const twin = first as unknown as TwinLine;
  return { twin, reading: count === 1 ? parseSentReading(api, rest[0]) : undefined };
}

const show = (value: unknown) => (value === undefined ? 'absent' : JSON.stringify(value));

/** Fail unless the device reported the twin's current desired version. */
function expectAppliedVersion(twin: TwinLine): number {
  const version = twin.desired.$version;
  expectTwin(
    typeof version === 'number' && Number.isInteger(version),
    `desired.$version is ${show(version)}, not an integer`
  );
  expectTwin(
    twin.reported.appliedDesiredVersion === version,
    `reported.appliedDesiredVersion is ${show(twin.reported.appliedDesiredVersion)}, not ` +
      `desired.$version ${version}: the device did not report applying the current desired state`
  );
  return version;
}

/** The owner's active cooks on the simulated device. */
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

/** Stop a cook: 200. */
async function stopCook(api: AcceptanceApi, id: string): Promise<AcceptanceResponse<Cook>> {
  const response = await api.request<Cook>({
    method: 'POST',
    path: `/cooks/${encodeURIComponent(id)}/stop`,
    route: '/cooks/{cookId}/stop',
  });
  api.expectStatus(response, 200);
  return response;
}

export default defineProofs('device twin', () => {
  let registered = false;
  let cookId: string | undefined;
  /** When the start's 201 arrived, for METRIC twin-apply-ms. */
  let startedAt: number | undefined;
  let startVersion: number | undefined;
  let sent: SentReading | undefined;
  let stopped = false;

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
      name: 'POST /cooks with X-Request-ID acceptance-twin-<runId> starts a cook on the simulated device: 201',
      async run(api: AcceptanceApi) {
        const body: StartCookRequest = {
          id: randomUUID(),
          name: `Acceptance twin ${api.runId}`,
          deviceId: api.simulatedDeviceId,
          meatType: 'acceptance',
          notes: 'Synthetic cook written by the live acceptance suite (device twin).',
        };
        const response = await api.request<Partial<Cook> & { error?: unknown; reason?: unknown }>({
          method: 'POST',
          path: '/cooks',
          body,
          headers: { 'X-Request-ID': `acceptance-twin-${api.runId}` },
        });
        if (response.status === 503 && response.body?.error === 'DEVICE_TWIN_UPDATE_FAILED') {
          const reason = fixedCode(response.body?.reason);
          throw new ProofFailure(
            `DEVICE_TWIN_UPDATE_FAILED, reason ${reason ?? '(not a fixed code)'}: the cook ` +
              'was saved but the device twin was not updated',
            response
          );
        }
        api.expectStatus(response, 201);
        startedAt = clock().now();
        api.check(response, response.body?.id === body.id, 'cook.id is not the id sent');
        api.check(
          response,
          response.body.status === 'active',
          `cook.status is ${show(response.body.status)}, not active`
        );
        cookId = body.id;
      },
    },
    {
      name: 'simdevice --twin --count 1 reconnects: the twin carries the cook and the device reports it applied',
      async run(api: AcceptanceApi) {
        const id = startedCook();
        const correlationId = `acceptance-twin-${api.runId}`;
        const { twin, reading } = await reconnect(api, 1);
        const exitedAt = clock().now();
        expectTwin(
          twin.desired.activeCookId === id,
          `desired.activeCookId is ${show(twin.desired.activeCookId)}, not the new cook ${id}`
        );
        expectTwin(
          twin.desired.correlationId === correlationId,
          `desired.correlationId is ${show(twin.desired.correlationId)}, not ${correlationId}`
        );
        expectTwin(
          twin.reported.activeCookId === id,
          `reported.activeCookId is ${show(twin.reported.activeCookId)}, not the new cook ${id}`
        );
        expectTwin(
          twin.reported.correlationId === correlationId,
          `reported.correlationId is ${show(twin.reported.correlationId)}, not ${correlationId}`
        );
        startVersion = expectAppliedVersion(twin);
        const lag = twin.applyLagMs;
        expectTwin(
          typeof lag === 'number' && Number.isInteger(lag) && lag >= 0,
          `applyLagMs is ${show(lag)}, not a non-negative integer: the device did not measure ` +
            "the cook's apply lag from desired.cookUpdatedAt"
        );
        sent = reading;
        if (startedAt !== undefined) {
          api.metric('twin-apply-ms', exitedAt - startedAt);
        }
        api.metric('twin-device-apply-lag-ms', lag);
        return `applyLagMs ${lag}`;
      },
    },
    {
      name: 'GET /temperatures/current/{deviceId} returns the reading just sent, tagged with the cook',
      async run(api: AcceptanceApi) {
        const id = startedCook();
        if (!sent) {
          throw new Error('no reading was sent by an earlier proof');
        }
        const { timestamp } = sent;
        const deviceId = api.simulatedDeviceId;
        const deadline = clock().now() + TWIN_POLL.capMs;
        let last: AcceptanceResponse<Partial<TemperatureReading>> | undefined;

        for (;;) {
          const response = await api.request<Partial<TemperatureReading>>({
            method: 'GET',
            path: `/temperatures/current/${encodeURIComponent(deviceId)}`,
            route: '/temperatures/current/{deviceId}',
          });
          last = response;
          if (response.status === 200 && sameInstant(response.body?.timestamp, timestamp)) {
            api.check(
              response,
              response.body.cookId === id,
              `reading.cookId is ${show(response.body.cookId)}, not the applied cook ${id}`
            );
            return;
          }
          // Not routed yet (404 NO_READINGS) or an older reading: keep polling.
          if (response.status === 404) {
            expectErrorCode(api, response, 'NO_READINGS');
          } else {
            api.expectStatus(response, 200);
          }
          if (clock().now() + TWIN_POLL.intervalMs > deadline) {
            break;
          }
          await clock().sleep(TWIN_POLL.intervalMs);
        }

        const seen = last.status === 200 ? last.body?.timestamp : undefined;
        throw new ProofFailure(
          `the reading with timestamp ${timestamp} was not readable within the ` +
            `${TWIN_POLL.capMs / 1000} s cap; last status ${last.status}, ` +
            `last timestamp seen ${seen === undefined ? 'none' : JSON.stringify(seen)}`,
          last
        );
      },
    },
    {
      name: 'POST /cooks/{cookId}/stop stops the cook: 200',
      async run(api: AcceptanceApi) {
        const id = startedCook();
        const response = await stopCook(api, id);
        stopped = true;
        api.check(response, response.body?.id === id, 'cook.id is not the cook stopped');
        api.check(
          response,
          response.body.status === 'completed',
          `cook.status is ${show(response.body.status)}, not completed`
        );
      },
    },
    {
      name: 'simdevice --twin --count 0 reconnects: the twin has no cook and the device reports it applied',
      async run(api: AcceptanceApi) {
        if (!stopped || startVersion === undefined) {
          throw new Error('the cook was not started, applied and stopped by earlier proofs');
        }
        const { twin } = await reconnect(api, 0);
        expectTwin(
          twin.desired.activeCookId === undefined || twin.desired.activeCookId === null,
          `desired.activeCookId is ${show(twin.desired.activeCookId)} after the stop, not absent`
        );
        expectTwin(
          twin.reported.activeCookId === null,
          `reported.activeCookId is ${show(twin.reported.activeCookId)} after the stop, not null`
        );
        const version = expectAppliedVersion(twin);
        expectTwin(
          version > startVersion,
          `desired.$version ${version} is not after the start's ${startVersion}: the stop ` +
            'did not update the twin'
        );
      },
    },
    {
      name: 'no cook is left active on the simulated device',
      // Runs whatever failed before it, so a failed run still frees the device.
      always: true,
      async run(api: AcceptanceApi) {
        if (!registered) {
          // Nothing was started without the registration.
          return;
        }
        for (const cook of await activeCooks(api)) {
          await stopCook(api, cook.id);
        }
      },
    },
  ];
});
