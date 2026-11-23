import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import type { Device } from '@meatgeekv2/api-interfaces';

import { expectErrorCode } from '../lib/checks';
import { clock } from '../lib/clock';
import { ClaimRefusals } from '../lib/claim-refusal';
import { deleteDevice } from '../lib/devices';
import {
  ClaimBody,
  cleanupFreshDevice,
  enrolFreshDevice,
  FreshDevice,
  postClaim,
  prepareClaim,
  sendClaim,
} from '../lib/enrolment';
import { MessageFeed } from '../lib/live-feed';
import type { AcceptanceApi, Caller } from '../lib/proof';
import { defineProofs, ProofFailure } from '../lib/proof';
import type { NegotiateBody } from '../lib/signalr';
import {
  CONNECT_TIMEOUT_MS,
  describeError,
  expectHubMessage,
  negotiateFailureMessage,
  startConnection,
  within,
} from '../lib/signalr';
import type { SentReading } from '../lib/telemetry';
import { sameInstant, sendOneReading } from '../lib/telemetry';

/**
 * HAR-142 (goal HAR-130, DoD 5 and 7) — a release cuts the old owner off at
 * the device's next reading, and claiming it again needs a fresh code.
 *
 * Two fresh devices, enrolled through DPS and claimed by the owner:
 * `acceptance-release-<runId>` (released) and `acceptance-control-<runId>`
 * (kept, the control). The owner's SignalR client listens on `temperature`.
 *
 *   1. the released device sends a reading; the owner receives it (90 s cap);
 *   2. the owner releases it (`DELETE` → 204); `GET /temperatures/current/{id}`
 *      as the owner is then 404 DEVICE_NOT_FOUND;
 *   3. the released device sends its next reading, and then the control
 *      device sends one. The owner must receive the control's (90 s cap) and
 *      never the released device's: after the control's arrives, a further
 *      15 s window must pass with no message for the released device but its
 *      first reading. The control is the liveness signal: it shows the path
 *      to the owner was working all along. The window is there because Event
 *      Hub orders readings per device, not across devices, so the control's
 *      reading arriving first does not by itself mean the other was dropped.
 *      `broadcastTemperature` reads the owner on every batch (HAR-81), and the
 *      next reading is sent after the release has answered, so it has no owner
 *      when it is pushed;
 *   4. the connection stops;
 *   5. the code the device was claimed with → 403 CLAIM_REFUSED (it stays
 *      consumed, and the release raised the claim generation);
 *   6. a twin sync (`prepareClaim`) picks up the release and the device shows
 *      a new code; the peer claims it with that code → 201. Ownership moved:
 *      `GET /devices/{id}` is 200 as the peer and 404 as the owner;
 *   7. the peer releases it (204).
 *
 * The always-run last steps release whatever is still held, by whoever holds
 * it, and delete both devices' DPS enrollments and hub identities. Whichever
 * of steps 1–3 fails, the connection is stopped first. No code is printed.
 */

/** The waits, on the injected clock (../lib/clock): each reading's delivery
 *  (as LIVE_WAIT and ISOLATION_WAIT), and the window after the control's
 *  reading in which the released device's must not arrive (as
 *  ISOLATION_WAIT.graceMs). */
export const RELEASE_WAIT: { readonly capMs: number; readonly graceMs: number } = {
  capMs: 90_000,
  graceMs: 15_000,
};

interface Received {
  readonly payload: unknown;
  readonly receivedAt: number;
}

const field = (payload: unknown, key: string): unknown =>
  payload !== null && typeof payload === 'object'
    ? (payload as Record<string, unknown>)[key]
    : undefined;

const isReading = (deviceId: string, timestamp: string) => (message: Received) =>
  field(message.payload, 'deviceId') === deviceId &&
  sameInstant(field(message.payload, 'timestamp'), timestamp);

/** What the cleanup step knows about one fresh device. */
interface Held {
  device: FreshDevice | undefined;
  claimed: boolean;
  released: boolean;
  holder: Caller;
}

export default defineProofs('device release', () => {
  const released: Held = { device: undefined, claimed: false, released: false, holder: 'owner' };
  const control: Held = { device: undefined, claimed: false, released: false, holder: 'owner' };
  /** The code the released device was claimed with. In memory only. */
  let firstCode: string | undefined;
  let ownerId: string | undefined;
  let hub: HubConnection | undefined;
  let secrets: string[] = [];
  const feed = new MessageFeed<Received>();
  let firstReading: SentReading | undefined;
  const refusals = new ClaimRefusals();

  const claimBody = (api: AcceptanceApi, label: string): ClaimBody => ({
    name: `Acceptance ${label} ${api.runId}`,
    model: 'Acceptance Rig',
    location: 'CI',
  });

  const deviceOf = (held: Held): FreshDevice => {
    if (!held.device) {
      throw new Error('the devices were not enrolled by an earlier proof');
    }
    return held.device;
  };

  const stopQuietly = async () => {
    const connection = hub;
    hub = undefined;
    if (connection) {
      await within(connection.stop(), CONNECT_TIMEOUT_MS, 'stop()').catch(() => undefined);
    }
  };

  /** Run `step`; if it fails, stop the connection, then report the failure. */
  const stopOnFailure = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      await stopQuietly();
      throw error;
    }
  };

  const connected = (): HubConnection => {
    if (!hub) {
      throw new Error('no SignalR connection from an earlier proof');
    }
    return hub;
  };

  /** Why no matching message came: the connection closed, or the cap passed. */
  const why = (connection: HubConnection) =>
    feed.closedBy !== undefined
      ? `the connection closed while waiting (${feed.closedBy})`
      : `nothing within the ${RELEASE_WAIT.capMs / 1000} s cap; the connection is ${connection.state}`;

  const getDevice = (api: AcceptanceApi, deviceId: string, as: Caller) =>
    api.request<Device>({
      method: 'GET',
      path: `/devices/${encodeURIComponent(deviceId)}`,
      route: '/devices/{id}',
      as,
    });

  return [
    {
      name: 'two fresh devices, acceptance-release-<runId> and acceptance-control-<runId>, are enrolled through DPS',
      async run(api: AcceptanceApi) {
        await enrolFreshDevice(api, 'release', device => {
          released.device = device;
        });
        await enrolFreshDevice(api, 'control', device => {
          control.device = device;
        });
      },
    },
    {
      name: 'POST /devices/claim claims both for the owner with their own codes (201)',
      async run(api: AcceptanceApi) {
        const releasedDevice = deviceOf(released);
        firstCode = await prepareClaim(api, releasedDevice);
        const first = await postClaim(
          api,
          releasedDevice.deviceId,
          firstCode,
          claimBody(api, 'release')
        );
        api.expectStatus(first, 201);
        released.claimed = true;
        ownerId = first.body.userId;

        const controlDevice = deviceOf(control);
        const code = await prepareClaim(api, controlDevice);
        const second = await postClaim(
          api,
          controlDevice.deviceId,
          code,
          claimBody(api, 'control')
        );
        api.expectStatus(second, 201);
        control.claimed = true;
      },
    },
    {
      name: 'POST /negotiate returns 200 and the owner’s SignalR client listening for temperature connects',
      async run(api: AcceptanceApi) {
        // HAR-81: negotiate reads no devices, so it reports no request charge.
        const response = await api.request<NegotiateBody>({
          method: 'POST',
          path: '/negotiate',
          expectRequestCharge: false,
        });
        api.check(
          response,
          response.status === 200,
          negotiateFailureMessage(response.status, response.body)
        );
        const { url, accessToken } = (response.body ?? {}) as NegotiateBody;
        api.check(
          response,
          typeof url === 'string' && typeof accessToken === 'string' && accessToken.length > 0,
          'body has no url and accessToken'
        );
        secrets = [url, accessToken];

        const connection = new HubConnectionBuilder()
          .withUrl(url, { accessTokenFactory: () => accessToken })
          .configureLogging(LogLevel.None)
          .build();
        connection.on('temperature', (payload: unknown) => {
          feed.push({ payload, receivedAt: clock().now() });
        });
        connection.onclose(error => {
          feed.close(error ? describeError(error, secrets) : 'closed without an error');
        });
        hub = connection;

        await stopOnFailure(async () => {
          await startConnection(connection, 'start()', () => secrets);
          if (connection.state !== HubConnectionState.Connected) {
            throw new ProofFailure(
              `after start() the connection is ${connection.state}, not Connected`
            );
          }
        });
      },
    },
    {
      name: 'a reading from acceptance-release-<runId> reaches the owner while the owner holds it',
      async run(api: AcceptanceApi) {
        const connection = connected();
        await stopOnFailure(async () => {
          const { deviceId } = deviceOf(released);
          const reading = await sendOneReading(api, deviceOf(released));
          const match = await feed.waitFor(
            isReading(deviceId, reading.timestamp),
            RELEASE_WAIT.capMs
          );
          if (!match) {
            throw new ProofFailure(
              `sent a reading as ${deviceId} (timestamp ${reading.timestamp}), but it did not ` +
                `reach the owner: ${why(connection)}`
            );
          }
          firstReading = reading;
        });
      },
    },
    {
      name: 'DELETE /devices/{id} releases acceptance-release-<runId> (204), and GET /temperatures/current/{id} as the old owner is 404',
      async run(api: AcceptanceApi) {
        connected();
        await stopOnFailure(async () => {
          const { deviceId } = deviceOf(released);
          const response = await deleteDevice(api, deviceId);
          api.expectStatus(response, 204);
          released.claimed = false;
          released.released = true;

          const current = await api.request({
            method: 'GET',
            path: `/temperatures/current/${encodeURIComponent(deviceId)}`,
            route: '/temperatures/current/{deviceId}',
          });
          api.expectStatus(current, 404);
          expectErrorCode(api, current, 'DEVICE_NOT_FOUND');
        });
      },
    },
    {
      name: 'its next reading never reaches the old owner, while a later reading from the owner’s control device does',
      async run(api: AcceptanceApi) {
        const connection = connected();
        await stopOnFailure(async () => {
          if (!firstReading) {
            throw new Error('the released device sent no reading in an earlier proof');
          }
          const releasedId = deviceOf(released).deviceId;
          const controlId = deviceOf(control).deviceId;
          const next = await sendOneReading(api, deviceOf(released));
          const controlReading = await sendOneReading(api, deviceOf(control));

          const arrived = await feed.waitFor(
            isReading(controlId, controlReading.timestamp),
            RELEASE_WAIT.capMs
          );
          if (!arrived) {
            throw new ProofFailure(
              `the control device's reading (timestamp ${controlReading.timestamp}) did not reach ` +
                `the owner, so the path to the owner was not shown to work: ${why(connection)}`
            );
          }

          // Anything for the released device but its first reading (a replay
          // of that one is allowed: delivery is at least once).
          const first = isReading(releasedId, firstReading.timestamp);
          const leaked = await feed.quietFor(
            message => field(message.payload, 'deviceId') === releasedId && !first(message),
            RELEASE_WAIT.graceMs
          );
          if (leaked.length > 0) {
            const stamps = leaked.map(m => JSON.stringify(field(m.payload, 'timestamp')));
            throw new ProofFailure(
              `after the release the old owner received ${leaked.length} reading(s) from ` +
                `${releasedId} (timestamp ${stamps.join(', ')}; the next one sent was ${next.timestamp})`
            );
          }
          if (feed.closedBy !== undefined) {
            throw new ProofFailure(
              `the connection closed during the ${RELEASE_WAIT.graceMs / 1000} s window ` +
                `(${feed.closedBy}), so the released device's silence proves nothing`
            );
          }
          for (const message of feed.received) {
            expectHubMessage(api, 'temperature', message.payload);
          }
        });
      },
    },
    {
      name: 'the SignalR connection stops',
      async run() {
        const connection = connected();
        hub = undefined;
        await within(connection.stop(), CONNECT_TIMEOUT_MS, 'stop()');
        if ((connection.state as HubConnectionState) !== HubConnectionState.Disconnected) {
          throw new ProofFailure(
            `after stop() the connection is ${connection.state}, not Disconnected`
          );
        }
      },
    },
    {
      name: 'POST /devices/claim with the code it was claimed with before the release is 403 CLAIM_REFUSED',
      async run(api: AcceptanceApi) {
        const { deviceId } = deviceOf(released);
        if (firstCode === undefined || !released.released) {
          throw new Error('the device was not claimed and released by earlier proofs');
        }
        const response = await sendClaim(api, deviceId, firstCode, claimBody(api, 'release'));
        refusals.expect(api, response);
      },
    },
    {
      name: 'after a twin sync it shows a new code, and the peer claims it with that code (201): ownership moved',
      async run(api: AcceptanceApi) {
        const device = deviceOf(released);
        const code = await prepareClaim(api, device);
        if (code === firstCode) {
          throw new ProofFailure(
            'after the release and a twin sync the device still shows the code it was claimed with'
          );
        }
        // From here the peer may hold it, so the cleanup releases it as the peer.
        released.holder = 'peer';
        released.released = false;
        const response = await postClaim(
          api,
          device.deviceId,
          code,
          claimBody(api, 'reclaim'),
          'peer'
        );
        api.expectStatus(response, 201);
        released.claimed = true;
        api.check(
          response,
          response.body.userId !== ownerId,
          'the peer’s claim stored the old owner’s userId'
        );

        const asPeer = await getDevice(api, device.deviceId, 'peer');
        api.expectStatus(asPeer, 200);
        api.check(asPeer, asPeer.body.userId !== ownerId, 'the device is still the old owner’s');
        const asOwner = await getDevice(api, device.deviceId, 'owner');
        api.expectStatus(asOwner, 404);
      },
    },
    {
      name: 'DELETE /devices/{id} as the peer releases it again (204)',
      async run(api: AcceptanceApi) {
        const response = await deleteDevice(api, deviceOf(released).deviceId, 'peer');
        api.expectStatus(response, 204);
        released.claimed = false;
        released.released = true;
      },
    },
    cleanupFreshDevice(
      'always: acceptance-release-<runId> is released by whoever holds it and its enrollment and hub identity deleted',
      () => released
    ),
    cleanupFreshDevice(
      'always: acceptance-control-<runId> is released and its enrollment and hub identity deleted',
      () => control
    ),
  ];
});
