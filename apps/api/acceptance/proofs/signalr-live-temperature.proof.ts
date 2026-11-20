import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';

import type { AcceptanceApi } from '../lib/proof';
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
import { isDate, registerSimulatedDevice, sameInstant, sendOneReading } from '../lib/telemetry';

/**
 * HAR-63 (goal HAR-55, item 7a) — a reading the simulated device sends reaches
 * its owner's SignalR client by push, and the run records how long that took.
 * The path: simdevice → IoT Hub → `temperature-data` Event Hub →
 * `broadcastTemperature` (HAR-60) → SignalR group `device-{deviceId}`, which
 * `POST /negotiate` (HAR-57, HAR-59) put the caller in.
 *
 *   1. the simulated device is registered to the caller (as the telemetry
 *      round trip does): ownership is what puts the caller in its group;
 *   2. `POST /negotiate` answers 200, after the registration, so the groups it
 *      adds include the device; a `@microsoft/signalr` client with a handler on
 *      target `temperature` connects with the url and token (`start()`);
 *   3. `simdevice --count 1` sends one reading; the wall-clock time just before
 *      the send is kept;
 *   4. the client receives, within 90 s, a `temperature` message for the device
 *      whose `timestamp` is the sent one (as an instant). Other messages are
 *      ignored: a new consumer group can replay retained events first. The
 *      payload carries `enqueuedTimeUtc` and no field `toTemperatureReading`
 *      would not produce. Every message received by then, the sent one and the
 *      ignored ones, matches the `temperature` schema in openapi.yaml (HAR-77).
 *      Prints `METRIC signalr-delivery-ms`: receive time minus the time before
 *      the send;
 *   5. the connection stops.
 *
 * Whichever step fails, the connection is stopped before the failure is
 * reported: the runner skips the rest of the group after a failure, so steps
 * 2–4 stop it themselves. The client's logging is off and errors are masked, so
 * neither the url nor the token reaches the output.
 */

/** How long step 4 waits for the reading. The self-test shortens it. */
export const LIVE_WAIT = { capMs: 90_000 };

/** Every field `toTemperatureReading` can produce, plus the enqueued time
 *  `broadcastTemperature` adds. */
const PAYLOAD_FIELDS: ReadonlySet<string> = new Set([
  'deviceId',
  'timestamp',
  'cookId',
  'grillTemp',
  'probe1Temp',
  'probe2Temp',
  'probe3Temp',
  'probe4Temp',
  'enqueuedTimeUtc',
]);

interface Received {
  readonly payload: unknown;
  readonly receivedAt: number;
}

const field = (payload: unknown, key: string): unknown =>
  payload !== null && typeof payload === 'object'
    ? (payload as Record<string, unknown>)[key]
    : undefined;

export default defineProofs('signalr live temperature', () => {
  let registered = false;
  let hub: HubConnection | undefined;
  let secrets: string[] = [];
  /** Why the connection closed on its own, once it has. */
  let closedBy: string | undefined;
  const received: Received[] = [];
  /** Wakes step 4 when a message arrives or the connection closes. */
  let wake: (() => void) | undefined;
  let sent: (SentReading & { sendStartedAt: number }) | undefined;

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

  return [
    {
      name: 'POST /devices registers the simulated device to the caller',
      async run(api: AcceptanceApi) {
        await registerSimulatedDevice(api);
        registered = true;
      },
    },
    {
      name: 'POST /negotiate returns 200 and a SignalR client listening for temperature connects',
      async run(api: AcceptanceApi) {
        if (!registered) {
          throw new Error('the simulated device was not registered by an earlier proof');
        }
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
          received.push({ payload, receivedAt: Date.now() });
          wake?.();
        });
        connection.onclose(error => {
          closedBy = error ? describeError(error, secrets) : 'closed without an error';
          wake?.();
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
      name: 'simdevice --count 1 sends one reading through IoT Hub',
      async run(api: AcceptanceApi) {
        connected();
        await stopOnFailure(async () => {
          const sendStartedAt = Date.now();
          const reading = await sendOneReading(api);
          sent = { ...reading, sendStartedAt };
        });
      },
    },
    {
      name: 'the sent reading arrives on target temperature, with enqueuedTimeUtc and no other field',
      async run(api: AcceptanceApi) {
        const connection = connected();
        await stopOnFailure(async () => {
          if (!sent) {
            throw new Error('no reading was sent by an earlier proof');
          }
          const { timestamp, sendStartedAt } = sent;
          const deviceId = api.simulatedDeviceId;
          const capMs = LIVE_WAIT.capMs;
          const deadline = Date.now() + capMs;
          const isSent = (message: Received) =>
            field(message.payload, 'deviceId') === deviceId &&
            sameInstant(field(message.payload, 'timestamp'), timestamp);

          let match = received.find(isSent);
          while (!match && closedBy === undefined && Date.now() < deadline) {
            await new Promise<void>(resolve => {
              const timer = setTimeout(resolve, deadline - Date.now());
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = undefined;
            match = received.find(isSent);
          }

          if (!match) {
            const forDevice = received.filter(m => field(m.payload, 'deviceId') === deviceId);
            const reached =
              closedBy !== undefined
                ? `the connection closed while waiting (${closedBy})`
                : `nothing within the ${capMs / 1000} s cap; the connection is ${connection.state}`;
            throw new ProofFailure(
              `connected and sent (timestamp ${timestamp}, sentAt ${sent.sentAt}), but no ` +
                `temperature message for ${deviceId} with that timestamp arrived: ${reached}. ` +
                `Received ${received.length} temperature message(s), ${forDevice.length} for ` +
                `${deviceId}` +
                (forDevice.length > 0
                  ? `, last timestamp ${JSON.stringify(field(forDevice[forDevice.length - 1].payload, 'timestamp'))}`
                  : '')
            );
          }

          const payload = match.payload as Record<string, unknown>;
          if (!isDate(payload['enqueuedTimeUtc'])) {
            throw new ProofFailure(
              `the reading arrived without a date enqueuedTimeUtc ` +
                `(${JSON.stringify(payload['enqueuedTimeUtc'])})`
            );
          }
          const extra = Object.keys(payload).filter(key => !PAYLOAD_FIELDS.has(key));
          if (extra.length > 0) {
            throw new ProofFailure(
              `the reading carries field(s) toTemperatureReading does not produce: ${extra.join(', ')}`
            );
          }
          for (const message of received) {
            expectHubMessage(api, 'temperature', message.payload);
          }
          api.metric('signalr-delivery-ms', match.receivedAt - sendStartedAt);
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
  ];
});
