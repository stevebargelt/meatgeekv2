import { randomUUID } from 'crypto';

import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  HubMessage,
  ILogger,
  JsonHubProtocol,
  LogLevel,
  MessageType,
} from '@microsoft/signalr';
import type { Cook, CookListResponse, StartCookRequest } from '@meatgeekv2/api-interfaces';

import { expectErrorCode } from '../lib/checks';
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
import { registerSimulatedDevice, sameInstant, sendOneReading } from '../lib/telemetry';

/**
 * HAR-67 (goal HAR-55, items 5 and 7b) — a second signed-in caller who does not
 * own the simulated device receives nothing from it over SignalR: not its
 * readings, not its cook events. The owner is the run's caller; the peer is the
 * zero-role acceptance peer (HAR-61), sent as with `request({ as: 'peer' })`.
 *
 * What keeps the peer out, all on `main` already: `POST /negotiate` mints the
 * token for the caller's own userId and adds that user only to the
 * `device-{id}` groups of devices it owns, ignoring any query (HAR-57, HAR-59);
 * `broadcastTemperature` sends a reading only to `device-{deviceId}` (HAR-60);
 * `cook_started` / `cook_stopped` go to the cook owner's userId (HAR-57).
 *
 *   1. the simulated device is registered to the owner (as proof 7a does);
 *   2. the owner negotiates and connects, with handlers on `temperature`,
 *      `cook_started` and `cook_stopped`;
 *   3. the peer negotiates with `?deviceId=<simulated device>`, which must be
 *      ignored: 200, then it connects with the same three handlers. Every
 *      invocation the peer's connection receives, on ANY target, is recorded
 *      (at the protocol, so a target with no handler is caught too);
 *   4. as the peer, `GET /temperatures/current/<simulated device>` is
 *      404 DEVICE_NOT_FOUND and `POST /cooks` on it is 403 DEVICE_NOT_OWNED;
 *   5. `simdevice --count 1` sends one reading; the owner receives it within
 *      90 s (matched as in 7a), then after a further 15 s grace the peer has
 *      received nothing;
 *   6. the owner stops any cook already active on the simulated device, starts
 *      one (`signalr-cook-event-ms`: POST to `cook_started`), stops it, and
 *      receives `cook_stopped`; after a further 15 s grace the peer has still
 *      received nothing (`isolation-peer-messages`, which must be 0);
 *   7. both connections stop.
 *
 * Every message the owner receives, on any of its three targets, must match
 * that target's schema in openapi.yaml `x-signalr` (HAR-77).
 *
 * Whichever step fails, both connections are stopped before the failure is
 * reported. Client logging is off and errors are masked, so no SignalR url or
 * access token reaches the output; the bearer tokens never reach the proof.
 */

/** How long the owner's messages are waited for, and the grace after them in
 *  which the peer must stay silent. The self-test shortens both. */
export const ISOLATION_WAIT = { capMs: 90_000, graceMs: 15_000 };

const TARGETS = ['temperature', 'cook_started', 'cook_stopped'] as const;

interface Received {
  readonly target: string;
  readonly payload: unknown;
  readonly receivedAt: number;
}

interface Side {
  hub?: HubConnection;
  secrets: string[];
  closedBy?: string;
  readonly received: Received[];
}

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

/** The JSON protocol, reporting every invocation it parses before the client
 *  dispatches it, whatever its target. */
class RecordingProtocol extends JsonHubProtocol {
  constructor(private readonly record: (target: string, payload: unknown) => void) {
    super();
  }

  override parseMessages(input: string, logger: ILogger): HubMessage[] {
    const messages = super.parseMessages(input, logger);
    for (const message of messages) {
      if (message.type === MessageType.Invocation) {
        this.record(message.target, message.arguments[0]);
      }
    }
    return messages;
  }
}

/** `temperature ×2, cook_started ×1`: what the peer received, by target. */
function byTarget(received: readonly Received[]): string {
  const counts = new Map<string, number>();
  for (const { target } of received) {
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return [...counts.entries()].map(([target, n]) => `${target} ×${n}`).join(', ');
}

export default defineProofs('signalr isolation', () => {
  let registered = false;
  const owner: Side = { secrets: [], received: [] };
  const peer: Side = { secrets: [], received: [] };
  /** Wakes a wait when the owner receives a message or a connection closes. */
  let wake: (() => void) | undefined;
  let sent: SentReading | undefined;
  let cookId: string | undefined;

  const secrets = () => [...owner.secrets, ...peer.secrets];

  const stopQuietly = async () => {
    for (const side of [owner, peer]) {
      const connection = side.hub;
      side.hub = undefined;
      if (connection) {
        await within(connection.stop(), CONNECT_TIMEOUT_MS, 'stop()').catch(() => undefined);
      }
    }
  };

  /** Run `step`; if it fails, stop both connections, then report the failure. */
  const stopOnFailure = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      await stopQuietly();
      throw error;
    }
  };

  const connected = (side: Side, who: Caller): HubConnection => {
    if (!side.hub) {
      throw new Error(`no ${who} SignalR connection from an earlier proof`);
    }
    return side.hub;
  };

  /** Negotiate as `who`, then connect a client with a handler on each target. */
  const negotiateAndConnect = async (api: AcceptanceApi, who: Caller, side: Side) => {
    const query = who === 'peer' ? `?deviceId=${encodeURIComponent(api.simulatedDeviceId)}` : '';
    const response = await api.request<NegotiateBody>({
      method: 'POST',
      path: `/negotiate${query}`,
      as: who,
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
    side.secrets = [url, accessToken];

    const record = (target: string, payload: unknown) => {
      side.received.push({ target, payload, receivedAt: Date.now() });
      if (side === owner) wake?.();
    };
    const builder = new HubConnectionBuilder()
      .withUrl(url, { accessTokenFactory: () => accessToken })
      .configureLogging(LogLevel.None);
    // The owner records what its handlers get; the peer records at the
    // protocol, so a message on a target nobody handles still counts.
    const connection = (
      who === 'peer' ? builder.withHubProtocol(new RecordingProtocol(record)) : builder
    ).build();
    for (const target of TARGETS) {
      connection.on(target, (payload: unknown) => {
        if (who === 'owner') record(target, payload);
      });
    }
    connection.onclose(error => {
      side.closedBy = error ? describeError(error, secrets()) : 'closed without an error';
      wake?.();
    });
    side.hub = connection;

    await stopOnFailure(async () => {
      await startConnection(connection, `${who} start()`, secrets);
      if (connection.state !== HubConnectionState.Connected) {
        throw new ProofFailure(
          `after start() the ${who} connection is ${connection.state}, not Connected`
        );
      }
    });
  };

  /** How many of the owner's messages have been checked against the contract. */
  let ownerChecked = 0;

  /** Wait up to the cap for an owner message matching `isWanted`, then check
   *  every owner message not yet checked against openapi.yaml (HAR-77). */
  const waitForOwner = async (
    api: AcceptanceApi,
    what: string,
    isWanted: (message: Received) => boolean
  ) => {
    const capMs = ISOLATION_WAIT.capMs;
    const deadline = Date.now() + capMs;
    let match = owner.received.find(isWanted);
    while (!match && owner.closedBy === undefined && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, deadline - Date.now());
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
      match = owner.received.find(isWanted);
    }
    if (!match) {
      const why =
        owner.closedBy !== undefined
          ? `the owner connection closed while waiting (${owner.closedBy})`
          : `nothing within the ${capMs / 1000} s cap; the owner connection is ` +
            `${connected(owner, 'owner').state}`;
      throw new ProofFailure(
        `no ${what} reached the owner: ${why}. The owner received ` +
          `${owner.received.length} message(s)` +
          (owner.received.length > 0 ? ` (${byTarget(owner.received)})` : '')
      );
    }
    while (ownerChecked < owner.received.length) {
      const { target, payload } = owner.received[ownerChecked];
      ownerChecked += 1;
      expectHubMessage(api, target, payload);
    }
    return match;
  };

  /** Wait the grace window, then fail if the peer has received anything.
   *  `final` also prints METRIC isolation-peer-messages; so does any failure. */
  const expectPeerSilent = async (api: AcceptanceApi, after: string, final: boolean) => {
    await new Promise(resolve => setTimeout(resolve, ISOLATION_WAIT.graceMs));
    if (peer.closedBy !== undefined) {
      throw new ProofFailure(
        `the peer connection closed (${peer.closedBy}), so its silence proves nothing`
      );
    }
    const count = peer.received.length;
    if (count > 0 || final) {
      api.metric('isolation-peer-messages', count);
    }
    if (count > 0) {
      throw new ProofFailure(
        `LEAK: the peer, who does not own ${api.simulatedDeviceId}, received ${count} ` +
          `message(s) by ${after} + ${ISOLATION_WAIT.graceMs / 1000} s: ${byTarget(peer.received)}`
      );
    }
  };

  return [
    {
      name: 'POST /devices registers the simulated device to the owner',
      async run(api: AcceptanceApi) {
        await registerSimulatedDevice(api);
        registered = true;
      },
    },
    {
      name: 'the owner negotiates and connects, listening for temperature, cook_started and cook_stopped',
      async run(api: AcceptanceApi) {
        if (!registered) {
          throw new Error('the simulated device was not registered by an earlier proof');
        }
        await negotiateAndConnect(api, 'owner', owner);
      },
    },
    {
      name: 'the peer: POST /negotiate?deviceId=<simulated device> returns 200 and its client connects',
      async run(api: AcceptanceApi) {
        connected(owner, 'owner');
        await stopOnFailure(() => negotiateAndConnect(api, 'peer', peer));
      },
    },
    {
      name: 'the peer: GET /temperatures/current/<simulated device> is 404 DEVICE_NOT_FOUND',
      async run(api: AcceptanceApi) {
        connected(peer, 'peer');
        await stopOnFailure(async () => {
          const response = await api.request({
            method: 'GET',
            path: `/temperatures/current/${encodeURIComponent(api.simulatedDeviceId)}`,
            route: '/temperatures/current/{deviceId}',
            as: 'peer',
          });
          api.expectStatus(response, 404);
          expectErrorCode(api, response, 'DEVICE_NOT_FOUND');
        });
      },
    },
    {
      name: 'the peer: POST /cooks on the simulated device is 403 DEVICE_NOT_OWNED',
      async run(api: AcceptanceApi) {
        connected(peer, 'peer');
        await stopOnFailure(async () => {
          const body: StartCookRequest = {
            id: randomUUID(),
            name: `Acceptance isolation peer ${api.runId}`,
            deviceId: api.simulatedDeviceId,
            meatType: 'acceptance',
          };
          const response = await api.request({ method: 'POST', path: '/cooks', body, as: 'peer' });
          api.expectStatus(response, 403);
          expectErrorCode(api, response, 'DEVICE_NOT_OWNED');
        });
      },
    },
    {
      name: 'simdevice --count 1 sends one reading through IoT Hub',
      async run(api: AcceptanceApi) {
        connected(owner, 'owner');
        connected(peer, 'peer');
        await stopOnFailure(async () => {
          sent = await sendOneReading(api);
        });
      },
    },
    {
      name: 'the owner receives the reading on temperature; the peer receives nothing in the grace window',
      async run(api: AcceptanceApi) {
        connected(owner, 'owner');
        connected(peer, 'peer');
        await stopOnFailure(async () => {
          if (!sent) {
            throw new Error('no reading was sent by an earlier proof');
          }
          const { timestamp } = sent;
          const deviceId = api.simulatedDeviceId;
          await waitForOwner(
            api,
            `temperature message for ${deviceId} with timestamp ${timestamp}`,
            message =>
              message.target === 'temperature' &&
              field(message.payload, 'deviceId') === deviceId &&
              sameInstant(field(message.payload, 'timestamp'), timestamp)
          );
          await expectPeerSilent(api, 'the reading', false);
        });
      },
    },
    {
      name: 'the owner stops any cook already active on the simulated device',
      async run(api: AcceptanceApi) {
        connected(owner, 'owner');
        await stopOnFailure(async () => {
          const query = new URLSearchParams({ deviceId: api.simulatedDeviceId, status: 'active' });
          const response = await api.request<CookListResponse>({
            method: 'GET',
            path: `/cooks?${query.toString()}`,
            route: '/cooks',
          });
          api.expectStatus(response, 200);
          api.check(response, Array.isArray(response.body?.cooks), 'body.cooks is not an array');
          for (const cook of response.body.cooks) {
            const stop = await api.request<Cook>({
              method: 'POST',
              path: `/cooks/${encodeURIComponent(cook.id)}/stop`,
              route: '/cooks/{cookId}/stop',
            });
            api.expectStatus(stop, '2xx');
          }
        });
      },
    },
    {
      name: 'POST /cooks as the owner starts a cook on the simulated device and cook_started reaches the owner',
      async run(api: AcceptanceApi) {
        connected(owner, 'owner');
        await stopOnFailure(async () => {
          const body: StartCookRequest = {
            id: randomUUID(),
            name: `Acceptance isolation ${api.runId}`,
            deviceId: api.simulatedDeviceId,
            meatType: 'acceptance',
            notes: 'Synthetic cook written by the live acceptance suite (signalr isolation).',
          };
          const startedAt = Date.now();
          const response = await api.request<Cook>({ method: 'POST', path: '/cooks', body });
          api.expectStatus(response, 201);
          api.check(response, response.body?.id === body.id, 'cook.id is not the id sent');
          cookId = body.id;
          const id = body.id;
          const match = await waitForOwner(
            api,
            `cook_started for cook ${id}`,
            message =>
              message.target === 'cook_started' &&
              field(field(message.payload, 'payload'), 'id') === id
          );
          api.metric('signalr-cook-event-ms', match.receivedAt - startedAt);
        });
      },
    },
    {
      name: 'POST /cooks/{cookId}/stop stops it, cook_stopped reaches the owner, and the peer has received nothing',
      async run(api: AcceptanceApi) {
        connected(owner, 'owner');
        connected(peer, 'peer');
        await stopOnFailure(async () => {
          if (!cookId) {
            throw new Error('no cook was started by an earlier proof');
          }
          const id = cookId;
          const response = await api.request<Cook>({
            method: 'POST',
            path: `/cooks/${encodeURIComponent(id)}/stop`,
            route: '/cooks/{cookId}/stop',
          });
          api.expectStatus(response, '2xx');
          await waitForOwner(
            api,
            `cook_stopped for cook ${id}`,
            message =>
              message.target === 'cook_stopped' &&
              field(field(message.payload, 'payload'), 'id') === id
          );
          await expectPeerSilent(api, 'cook_stopped', true);
        });
      },
    },
    {
      name: 'both SignalR connections stop',
      async run() {
        if (!owner.hub || !peer.hub) {
          await stopQuietly();
          throw new Error('no owner and peer SignalR connections from earlier proofs');
        }
        const connections = [owner.hub, peer.hub];
        owner.hub = undefined;
        peer.hub = undefined;
        const results = await Promise.allSettled(
          connections.map(c => within(c.stop(), CONNECT_TIMEOUT_MS, 'stop()'))
        );
        const failed = results.find(r => r.status === 'rejected');
        if (failed) {
          throw (failed as PromiseRejectedResult).reason;
        }
        for (const [i, connection] of connections.entries()) {
          if ((connection.state as HubConnectionState) !== HubConnectionState.Disconnected) {
            throw new ProofFailure(
              `after stop() the ${i === 0 ? 'owner' : 'peer'} connection is ${connection.state}, ` +
                'not Disconnected'
            );
          }
        }
      },
    },
  ];
});
