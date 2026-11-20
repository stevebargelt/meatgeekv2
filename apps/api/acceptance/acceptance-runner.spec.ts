/**
 * HAR-11 — self-test for the live acceptance suite. Runs under ordinary
 * `nx test api`, never against a deployed system: it starts an in-process HTTP
 * stub that imitates the cooks, devices, recipes, temperatures and users routes and drives the REAL runner and the REAL
 * proof files (discovered from ./proofs) against it.
 *
 * HAR-44: `simdevice` is replaced by a small Node script written to a temp dir
 * (see {@link writeFakeSimdevice}); the stub serves the reading it "sent" for
 * the simulated device once a few polls have gone by.
 *
 * HAR-45: the stub also keeps a volume of readings for the simulated device.
 * A fake top-up run tells the stub how many it "sent" (an unauthenticated POST
 * to `/api/__simdevice/sent`, which only the stub has), and the stub makes them
 * readable over the next few polls of the device's current reading, or never.
 * HAR-75: history pages by continuation token, and `offset` is a 400.
 */
import { randomUUID } from 'crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { REQUEST_CHARGE_HEADER } from '../src/shared/cosmos/request-charge';
import type { AcceptanceApi, ProofGroup, SimDeviceOptions } from './lib/proof';
import { runAcceptance, RunResult } from './lib/runner';
import twinGroup, { TWIN_POLL } from './proofs/device-twin.proof';
import isolationGroup, { ISOLATION_WAIT } from './proofs/signalr-isolation.proof';
import { LIVE_WAIT } from './proofs/signalr-live-temperature.proof';
import roundtripGroup, { ROUNDTRIP_POLL } from './proofs/telemetry-roundtrip.proof';
import volumeGroup, { topupDrainedAt, VOLUME } from './proofs/telemetry-volume.proof';

const TOKEN = 'eyJ0eXAi.SECRET-acceptance-token.value-9f3c';
/** HAR-67: the acceptance peer's token, a second caller who owns nothing. */
const PEER_TOKEN = 'eyJ0eXAi.SECRET-peer-token.value-41b7';

const SIM_DEVICE = 'meatgeek-dev-simulated-smoker';
const SIM_KEY = 'c2VjcmV0LXNpbS1kZXZpY2Uta2V5LWZvci10ZXN0cw==';
const SIM_CONNECTION_STRING = `HostName=stub-hub.azure-devices.net;DeviceId=${SIM_DEVICE};SharedAccessKey=${SIM_KEY}`;
/** The body `timestamp` the fake simdevice reports and the stub serves. */
const SIM_TIMESTAMP = '2026-11-19T16:47:33.120Z';
/** Readings the stub's history holds for the simulated device before the sent one. */
const OLDER_READINGS = [
  '2026-11-19T16:40:00.000Z',
  '2026-11-19T16:41:00.000Z',
  '2026-11-19T16:42:00.000Z',
];
const SIM_HISTORY_PAGE = 2;
/** HAR-75: the fake simdevice stamps top-up readings from here, 50 ms apart:
 *  after every other reading the stub serves, as live top-ups are the newest. */
const TOPUP_EPOCH = Date.UTC(2026, 10, 20);

type FakeMode = 'ok' | 'exit1' | 'topup-exit1' | 'hang' | 'leak-stderr' | 'leak-stdout';

type CookRoute = 'GET /cooks' | 'POST /cooks' | 'POST /cooks/{cookId}/stop';
/** HAR-75: kept out of CookRoute, whose failure tests follow the cook through
 *  every group that starts one. */
type CookItemRoute = 'GET /cooks/{cookId}';
type DeviceRoute = 'GET /devices' | 'POST /devices' | 'GET /devices/{id}' | 'PATCH /devices/{id}';
type TemperatureRoute = 'GET /temperatures/current/{deviceId}' | 'GET /temperatures/history';
type UserRoute = 'PUT /users/me' | 'GET /users/me';
type RecipeRoute =
  | 'GET /recipes'
  | 'POST /recipes'
  | 'GET /recipes/{id}'
  | 'PATCH /recipes/{id}'
  | 'DELETE /recipes/{id}';
type SignalRRoute = 'POST /negotiate';
type StubRoute =
  | CookRoute
  | CookItemRoute
  | DeviceRoute
  | TemperatureRoute
  | UserRoute
  | RecipeRoute
  | SignalRRoute;

/** HAR-57: the client access token the stub's POST /negotiate hands out. */
const SIGNALR_CLIENT_TOKEN = 'stub-signalr-client-token-7d1e';
/** HAR-67: the client access token negotiate hands the peer. */
const PEER_SIGNALR_CLIENT_TOKEN = 'stub-signalr-peer-token-3a90';
/** HAR-68: the body `timestamp` of the reading a fake `simdevice --twin --count 1` sends. */
const TWIN_TIMESTAMP = '2026-11-19T16:45:12.340Z';
/** HAR-68: the fixed reason the stub's 503 DEVICE_TWIN_UPDATE_FAILED carries. */
const TWIN_FAILURE_REASON = 'iothub_patch_twin_status_500';
/** HAR-67: the active cook an earlier run left on the simulated device. */
const STALE_COOK_ID = '0b7c1d52-9e1f-4c3a-8d2e-5f6a7b8c9d0e';
/** The SignalR JSON protocol's record separator. */
const RS = '\u001e';

interface StubOptions {
  /** Answer this route with this status (and an RU header) instead. */
  readonly failRoute?: { readonly route: StubRoute; readonly status: number };
  /** Answer this route normally but without the RU header. */
  readonly omitChargeOn?: StubRoute;
  /** Answer every GET /temperatures/current with a 404 carrying this code. */
  readonly temperatureErrorCode?: string;
  /** Answer GET /temperatures/history for an owned device (not the simulated
   *  one) with this body instead of the empty first page. */
  readonly emptyHistoryBody?: unknown;
  /** HAR-75: GET /temperatures/history ignores `offset` instead of a 400. */
  readonly historyAcceptsOffset?: boolean;
  /** HAR-75: GET /cooks/{cookId} serves the cook to the peer too (a broken
   *  partition), or serves the device lock as if it were a cook. */
  readonly cookItemFault?: 'peer-reads' | 'lock-reads';
  /** HAR-75: the RU the last page of a walk of the simulated device's volume
   *  reports, instead of the route's usual charge. */
  readonly simDeepPageCharge?: string;
  /** Echo the caller's Authorization header back in bodies and headers. */
  readonly echoAuthorization?: boolean;
  /** Start cooks on any device, registered or not (the pre-HAR-26 behaviour). */
  readonly allowAnyDevice?: boolean;
  /** The simulated device's current reading is the sent one from this poll on
   *  (1-based). Earlier polls answer 404 NO_READINGS, then an older reading. */
  readonly simVisibleFromPoll?: number;
  /** The sent reading never reaches the simulated device's current or history. */
  readonly simNeverRouted?: boolean;
  /** The body `timestamp` the stub serves for the sent reading, when it is
   *  spelled differently from the one the fake simdevice prints. */
  readonly simServedTimestamp?: string;
  /** The simulated device is registered to someone else: POST is 409, GET 404. */
  readonly simOwnedByOther?: boolean;
  /** HAR-45: readings the simulated device's volume starts with. Default
   *  `VOLUME.target`, so no top-up is needed. */
  readonly simVolume?: number;
  /** HAR-45: how many top-up readings become readable per poll of the
   *  simulated device's current reading. Default all of them at the next poll. */
  readonly simDrainPerPoll?: number;
  /** HAR-45: top-up readings never become readable. */
  readonly simTopupNeverRouted?: boolean;
  /** HAR-57: the stub's SignalR endpoint refuses the client token (401). */
  readonly signalRRejectsToken?: boolean;
  /** HAR-59: POST /negotiate answers 503 SIGNALR_UNAVAILABLE with this `reason`. */
  readonly negotiateUnavailableReason?: string;
  /** HAR-63: what the stub pushes on target `temperature` to each open SignalR
   *  connection after a `--count 1` send. It always pushes a replayed older
   *  reading of the simulated device and the sent timestamp for another device
   *  first; then `deliver` (default) the sent reading, `never` nothing,
   *  `extra-field` the sent reading with an `iothub_name`, `no-enqueued` the
   *  sent reading without `enqueuedTimeUtc`. */
  readonly livePush?: 'deliver' | 'never' | 'extra-field' | 'no-enqueued';
  /** HAR-67: also push this target to the peer's connections, as a broken
   *  group or user scoping would. By default the peer gets nothing. */
  readonly peerLeak?: 'temperature' | 'cook_started';
  /** HAR-67: the simulated device already has an active cook (an earlier run's). */
  readonly simActiveCook?: boolean;
  /** HAR-68: the twin proof's POST /cooks (X-Request-ID acceptance-twin-…)
   *  saves the cook but answers 503 DEVICE_TWIN_UPDATE_FAILED, as the API does
   *  when the twin PATCH fails. */
  readonly twinUpdateFails?: boolean;
  /** HAR-68: what the fake `simdevice --twin` prints wrong: `desired-cook`, a
   *  desired activeCookId that is not the active cook; `reported-version`, a
   *  reported appliedDesiredVersion one behind desired.$version. */
  readonly twinFault?: 'desired-cook' | 'reported-version';
}

interface StubCook {
  id: string;
  userId: string;
  deviceId: string;
  name: string;
  status: string;
  startTime: string;
  endTime?: string;
  meatType?: string;
  notes?: string;
}

interface StubDevice {
  id: string;
  userId: string;
  name: string;
  model: string;
  location?: string;
  isActive: boolean;
  connectionStatus: string;
}

interface Stub {
  readonly baseUrl: string;
  /** HAR-57: requests the SignalR client made to the stub's `/client/` endpoint. */
  readonly signalRRequests: Array<{ method: string; path: string; authorization?: string }>;
  readonly requests: Array<{
    method: string;
    path: string;
    authorization?: string;
    /** HAR-68: the request's X-Request-ID header, when it sent one. */
    requestId?: string;
  }>;
  /** HAR-68: the arguments of each `simdevice --twin` run the fake reported. */
  readonly twinRuns: string[][];
  /** HAR-45: the arguments of each top-up the fake simdevice reported. */
  readonly topups: string[][];
  /** HAR-63: how many SignalR connections each `--count 1` send was pushed to. */
  readonly livePushes: number[];
  /** HAR-67: each cook event pushed, with how many connections it went to. */
  readonly cookPushes: Array<{ target: string; cookId: string; connections: number }>;
  /** HAR-67: the simulated device's cooks. */
  readonly simCooks: () => Array<{ id: string; status: string }>;
  /** HAR-75: the volume after each poll of the simulated device's current
   *  reading while a top-up is being routed. */
  readonly drainTotals: number[];
  close(): Promise<void>;
}

const simReading = (timestamp: string) => ({
  deviceId: SIM_DEVICE,
  timestamp,
  grillTemp: 225.4,
  probe1Temp: 151.2,
  probe2Temp: 149.8,
});

const RU: Record<StubRoute, string> = {
  'GET /cooks': '2.83',
  'POST /cooks': '11.43',
  'POST /cooks/{cookId}/stop': '20.1',
  'GET /cooks/{cookId}': '1.17',
  'GET /devices': '3.11',
  'POST /devices': '9.52',
  'GET /devices/{id}': '1',
  'PATCH /devices/{id}': '11.9',
  'GET /temperatures/current/{deviceId}': '3.86',
  'GET /temperatures/history': '7.71',
  'PUT /users/me': '14.21',
  'GET /users/me': '3.62',
  'GET /recipes': '2.94',
  'POST /recipes': '10.67',
  'GET /recipes/{id}': '1.02',
  'PATCH /recipes/{id}': '12.38',
  'DELETE /recipes/{id}': '10.29',
  'POST /negotiate': '2.66',
};

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

/** An in-process imitation of the deployed cooks, devices, recipes, temperatures and users routes under `/api`. */
async function startStub(options: StubOptions = {}): Promise<Stub> {
  const cooks: StubCook[] = [];
  const devices = new Map<string, StubDevice>();
  const recipes = new Map<string, Record<string, unknown>>();
  // The acceptance identity's profile persists between runs, as it does in dev.
  let profile: Record<string, unknown> | undefined;
  const requests: Stub['requests'] = [];
  if (options.simActiveCook) {
    cooks.push({
      id: STALE_COOK_ID,
      userId: 'stub-tenant:stub-user',
      deviceId: SIM_DEVICE,
      name: 'Acceptance isolation (an earlier run)',
      status: 'active',
      startTime: '2026-11-18T10:00:00.000Z',
      meatType: 'acceptance',
    });
  }
  /** HAR-68: the simulated device's twin. Start and stop sync desired to its
   *  active cook as the API does (HAR-66); a fake `simdevice --twin` applies
   *  desired to reported. */
  const twin = {
    desired: { activeCookId: null as string | null, correlationId: null as string | null },
    version: 1,
    reported: {
      activeCookId: null as string | null,
      correlationId: null as string | null,
      appliedDesiredVersion: null as number | null,
    },
  };
  const syncTwin = (correlationId: string) => {
    const active = cooks.find(c => c.deviceId === SIM_DEVICE && c.status === 'active');
    const target =
      active === undefined
        ? { activeCookId: null, correlationId: null }
        : active.id === twin.desired.activeCookId
          ? twin.desired
          : { activeCookId: active.id, correlationId };
    if (
      target.activeCookId !== twin.desired.activeCookId ||
      target.correlationId !== twin.desired.correlationId
    ) {
      twin.desired = { ...target };
      twin.version += 1;
    }
  };
  const twinRuns: string[][] = [];
  /** HAR-68: the reading the last `simdevice --twin --count 1` sent, served as
   *  the simulated device's current reading until another send replaces it. */
  let twinReading: { timestamp: string; cookId: string | null } | undefined;
  let simPolls = 0;
  const simVisibleFromPoll = options.simVisibleFromPoll ?? 3;
  const simRouted = () => !options.simNeverRouted && simPolls >= simVisibleFromPoll;
  const simServed = options.simServedTimestamp ?? SIM_TIMESTAMP;
  const topups: string[][] = [];
  const drainTotals: number[] = [];
  let simStored = options.simVolume ?? VOLUME.target;
  let simPending = 0;
  /** HAR-75: the timestamp of the last reading the last top-up "sent". */
  let topupLast: string | undefined;
  const signalRRequests: Stub['signalRRequests'] = [];
  // HAR-57: a minimal Azure SignalR client endpoint, long polling only. Per
  // connection token: messages queued for the client, the poll being held, and
  // whether the first (initialising) poll has been answered.
  const signalRConnections = new Map<
    string,
    {
      user: 'owner' | 'peer';
      outbox: string[];
      held?: ServerResponse;
      started: boolean;
      closed: boolean;
    }
  >();
  const livePushes: number[] = [];
  const cookPushes: Stub['cookPushes'] = [];
  /** HAR-67: the open connections a message on `target` reaches: the owner's,
   *  plus the peer's when `peerLeak` names that target. */
  const recipients = (target: string) =>
    [...signalRConnections.values()].filter(
      c => c.started && !c.closed && (c.user === 'owner' || options.peerLeak === target)
    );
  /** HAR-67: what startCook / stopCook would send to the owner's userId. */
  const pushCookEvent = (target: 'cook_started' | 'cook_stopped', cook: StubCook) => {
    const { id, ...rest } = cook;
    const envelope = {
      type: target,
      timestamp: new Date().toISOString(),
      messageId: randomUUID(),
      deviceId: cook.deviceId,
      userId: cook.userId,
      ...(target === 'cook_started' ? { cookId: id } : {}),
      correlation: { id: 'stub-invocation' },
      payload: { id, ...rest },
    };
    const open = recipients(target);
    cookPushes.push({ target, cookId: id, connections: open.length });
    const message = `${JSON.stringify({ type: 1, target, arguments: [envelope] })}${RS}`;
    for (const connection of open) {
      connection.outbox.push(message);
      flushPoll(connection);
    }
  };
  /** HAR-63: what broadcastTemperature would push to the simulated device's
   *  group, sent to every open connection of its owner. */
  const pushLiveReading = () => {
    const push = options.livePush ?? 'deliver';
    const invocation = (payload: unknown) =>
      `${JSON.stringify({ type: 1, target: 'temperature', arguments: [payload] })}${RS}`;
    const enqueuedTimeUtc = new Date().toISOString();
    const sent: Record<string, unknown> = { ...simReading(simServed), enqueuedTimeUtc };
    if (push === 'extra-field') sent['iothub_name'] = 'stub-hub';
    if (push === 'no-enqueued') delete sent['enqueuedTimeUtc'];
    const messages = [
      invocation({ ...simReading(OLDER_READINGS[0]), enqueuedTimeUtc }),
      invocation({ ...simReading(simServed), deviceId: 'someone-elses-device', enqueuedTimeUtc }),
      ...(push === 'never' ? [] : [invocation(sent)]),
    ];
    const open = recipients('temperature');
    livePushes.push(open.length);
    for (const connection of open) {
      connection.outbox.push(...messages);
      flushPoll(connection);
    }
  };
  const flushPoll = (connection: { outbox: string[]; held?: ServerResponse; closed: boolean }) => {
    const held = connection.held;
    if (!held) return;
    if (connection.outbox.length > 0) {
      connection.held = undefined;
      held.writeHead(200, { 'Content-Type': 'text/plain' });
      held.end(connection.outbox.splice(0).join(''));
    } else if (connection.closed) {
      connection.held = undefined;
      held.writeHead(204);
      held.end();
    }
  };

  const server: Server = createServer((request, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://stub');
      if (url.pathname.startsWith('/client/')) {
        // HAR-57: the SignalR client, dialling the url POST /negotiate returned.
        const authorization = request.headers['authorization'];
        signalRRequests.push({
          method: request.method ?? '',
          path: url.pathname + url.search,
          authorization,
        });
        const user =
          authorization === `Bearer ${SIGNALR_CLIENT_TOKEN}`
            ? 'owner'
            : authorization === `Bearer ${PEER_SIGNALR_CLIENT_TOKEN}`
              ? 'peer'
              : undefined;
        if (
          options.signalRRejectsToken ||
          !user ||
          url.searchParams.get('hub') !== 'temperatureHub'
        ) {
          response.writeHead(401);
          response.end();
          return;
        }
        if (request.method === 'POST' && url.pathname === '/client/negotiate') {
          const token = `conn-${signalRConnections.size + 1}`;
          signalRConnections.set(token, { user, outbox: [], started: false, closed: false });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              negotiateVersion: 1,
              connectionId: token,
              connectionToken: token,
              availableTransports: [
                { transport: 'LongPolling', transferFormats: ['Text', 'Binary'] },
              ],
            })
          );
          return;
        }
        const connection = signalRConnections.get(url.searchParams.get('id') ?? '');
        if (url.pathname !== '/client/' || !connection || connection.user !== user) {
          response.writeHead(404);
          response.end();
          return;
        }
        if (request.method === 'GET') {
          if (!connection.started) {
            connection.started = true;
            response.writeHead(200);
            response.end();
            return;
          }
          connection.held?.writeHead(200).end();
          connection.held = response;
          flushPoll(connection);
          // Never hold a poll for long: an empty 200 makes the client re-poll.
          setTimeout(() => {
            if (connection.held === response) {
              connection.held = undefined;
              response.writeHead(200).end();
            }
          }, 500);
          return;
        }
        if (request.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk as Buffer);
          const text = Buffer.concat(chunks).toString('utf8');
          if (text.includes('"protocol":"json"')) {
            connection.outbox.push(`{}${RS}`);
            flushPoll(connection);
          }
          response.writeHead(200);
          response.end();
          return;
        }
        if (request.method === 'DELETE') {
          connection.closed = true;
          flushPoll(connection);
          response.writeHead(202);
          response.end();
          return;
        }
        response.writeHead(405);
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/__simdevice/sent') {
        // HAR-45: the fake simdevice reporting a top-up. Not an API route.
        const { args } = (await readJson(request)) as { args: string[] };
        if (args.join(' ') === '--count 1') {
          // HAR-63: the one reading; broadcastTemperature pushes it live.
          twinReading = undefined;
          setTimeout(pushLiveReading, 20);
        } else {
          topups.push(args);
          const count = Number(args[args.indexOf('--count') + 1]);
          simPending += count;
          // The fake simdevice stamps its top-up readings from TOPUP_EPOCH, 50 ms apart.
          topupLast = new Date(TOPUP_EPOCH + (count - 1) * 50).toISOString();
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/__simdevice/twin') {
        // HAR-68: the fake simdevice reconnecting with --twin. Not an API route.
        const { args } = (await readJson(request)) as { args: string[] };
        twinRuns.push(args);
        twin.reported = {
          ...twin.desired,
          appliedDesiredVersion: twin.version,
        };
        const desired = {
          activeCookId:
            options.twinFault === 'desired-cook' ? randomUUID() : twin.desired.activeCookId,
          correlationId: twin.desired.correlationId,
          $version: twin.version,
        };
        const reported = {
          ...twin.reported,
          appliedDesiredVersion:
            options.twinFault === 'reported-version' ? twin.version - 1 : twin.version,
        };
        if (args.join(' ').includes('--count 1')) {
          twinReading = { timestamp: TWIN_TIMESTAMP, cookId: reported.activeCookId };
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ desired, reported }));
        return;
      }
      const authorization = request.headers['authorization'];
      const requestIdHeader = request.headers['x-request-id'];
      const requestId = typeof requestIdHeader === 'string' ? requestIdHeader : undefined;
      requests.push({
        method: request.method ?? '',
        path: url.pathname + url.search,
        authorization,
        ...(requestId === undefined ? {} : { requestId }),
      });

      const send = (status: number, body: unknown, route?: StubRoute, charge?: string) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (route && options.omitChargeOn !== route) {
          headers[REQUEST_CHARGE_HEADER] = charge ?? RU[route];
        }
        if (options.echoAuthorization && authorization) {
          headers['x-echo-authorization'] = authorization;
        }
        response.writeHead(status, headers);
        response.end(JSON.stringify(body));
      };

      const caller =
        authorization === `Bearer ${TOKEN}`
          ? 'owner'
          : authorization === `Bearer ${PEER_TOKEN}`
            ? 'peer'
            : undefined;
      if (!caller) {
        send(401, {
          error:
            options.echoAuthorization && authorization ? `BAD ${authorization}` : 'UNAUTHENTICATED',
        });
        return;
      }

      const stopMatch = /^\/api\/cooks\/([^/]+)\/stop$/.exec(url.pathname);
      const cookMatch = /^\/api\/cooks\/([^/]+)$/.exec(url.pathname);
      const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(url.pathname);
      const temperatureMatch = /^\/api\/temperatures\/current\/([^/]+)$/.exec(url.pathname);
      const recipeMatch = /^\/api\/recipes\/([^/]+)$/.exec(url.pathname);
      let route: StubRoute | undefined;
      if (request.method === 'GET' && url.pathname === '/api/cooks') route = 'GET /cooks';
      else if (request.method === 'POST' && url.pathname === '/api/cooks') route = 'POST /cooks';
      else if (request.method === 'POST' && stopMatch) route = 'POST /cooks/{cookId}/stop';
      else if (request.method === 'GET' && cookMatch) route = 'GET /cooks/{cookId}';
      else if (request.method === 'GET' && url.pathname === '/api/devices') route = 'GET /devices';
      else if (request.method === 'POST' && url.pathname === '/api/devices')
        route = 'POST /devices';
      else if (request.method === 'GET' && deviceMatch) route = 'GET /devices/{id}';
      else if (request.method === 'PATCH' && deviceMatch) route = 'PATCH /devices/{id}';
      else if (request.method === 'GET' && temperatureMatch)
        route = 'GET /temperatures/current/{deviceId}';
      else if (request.method === 'GET' && url.pathname === '/api/temperatures/history')
        route = 'GET /temperatures/history';
      else if (request.method === 'PUT' && url.pathname === '/api/users/me')
        route = 'PUT /users/me';
      else if (request.method === 'GET' && url.pathname === '/api/users/me')
        route = 'GET /users/me';
      else if (request.method === 'GET' && url.pathname === '/api/recipes') route = 'GET /recipes';
      else if (request.method === 'POST' && url.pathname === '/api/recipes')
        route = 'POST /recipes';
      else if (request.method === 'GET' && recipeMatch) route = 'GET /recipes/{id}';
      else if (request.method === 'PATCH' && recipeMatch) route = 'PATCH /recipes/{id}';
      else if (request.method === 'DELETE' && recipeMatch) route = 'DELETE /recipes/{id}';
      else if (request.method === 'POST' && url.pathname === '/api/negotiate')
        route = 'POST /negotiate';
      if (!route) {
        send(404, { error: 'NOT_FOUND' });
        return;
      }
      // HAR-67: the peer owns nothing. The stub serves it only the routes the
      // isolation proof sends as the peer.
      const owns = (deviceId: string) => caller === 'owner' && devices.has(deviceId);
      const peerRoutes: StubRoute[] = [
        'POST /negotiate',
        'GET /temperatures/current/{deviceId}',
        'POST /cooks',
        'GET /cooks/{cookId}',
      ];
      if (caller === 'peer' && !peerRoutes.includes(route)) {
        send(404, { error: 'NOT_FOUND' });
        return;
      }

      if (options.failRoute?.route === route) {
        send(
          options.failRoute.status,
          { error: options.echoAuthorization ? `STUB_FAILURE ${authorization}` : 'STUB_FAILURE' },
          route
        );
        return;
      }

      if (route === 'POST /negotiate' && options.negotiateUnavailableReason !== undefined) {
        send(
          503,
          {
            error: 'SIGNALR_UNAVAILABLE',
            message: 'Real-time updates are unavailable. Try again later.',
            reason: options.negotiateUnavailableReason,
            requestId: 'stub-invocation',
          },
          route
        );
        return;
      }

      if (route === 'POST /negotiate') {
        const { port } = server.address() as AddressInfo;
        send(
          200,
          {
            url: `http://127.0.0.1:${port}/client/?hub=temperatureHub`,
            accessToken: caller === 'peer' ? PEER_SIGNALR_CLIENT_TOKEN : SIGNALR_CLIENT_TOKEN,
          },
          route
        );
        return;
      }

      if (route === 'PUT /users/me') {
        const body = (await readJson(request)) as Record<string, unknown>;
        if (!body?.['name'] || !body['email'] || 'id' in body || 'userId' in body) {
          send(400, { error: 'VALIDATION_ERROR' });
          return;
        }
        const created = profile === undefined;
        profile = {
          id: 'stub-tenant:stub-user',
          createdAt: (profile?.['createdAt'] as string) ?? new Date().toISOString(),
          preferences: {},
          devices: [...devices.keys()],
          name: body['name'],
          email: body['email'],
        };
        send(created ? 201 : 200, profile, route);
        return;
      }
      if (route === 'GET /users/me') {
        if (!profile) {
          send(404, { error: 'USER_NOT_FOUND' }, route);
          return;
        }
        send(200, profile, route);
        return;
      }

      if (route === 'GET /recipes') {
        send(200, { recipes: [...recipes.values()] }, route);
        return;
      }
      if (route === 'POST /recipes') {
        const body = (await readJson(request)) as Record<string, unknown>;
        if (!body?.['name'] || !body['meatType'] || 'id' in body || 'userId' in body) {
          send(400, { error: 'VALIDATION_ERROR' });
          return;
        }
        const now = new Date().toISOString();
        const recipe = {
          ...body,
          id: randomUUID(),
          userId: 'stub-tenant:stub-user',
          createdAt: now,
          updatedAt: now,
        };
        recipes.set(recipe.id, recipe);
        send(201, recipe, route);
        return;
      }
      if (recipeMatch) {
        const id = decodeURIComponent(recipeMatch[1]);
        const recipe = recipes.get(id);
        if (!recipe) {
          send(404, { error: 'RECIPE_NOT_FOUND' }, route);
          return;
        }
        if (route === 'DELETE /recipes/{id}') {
          recipes.delete(id);
          const headers: Record<string, string> = {};
          if (options.omitChargeOn !== route) headers[REQUEST_CHARGE_HEADER] = RU[route];
          response.writeHead(204, headers);
          response.end();
          return;
        }
        if (route === 'PATCH /recipes/{id}') {
          const body = (await readJson(request)) as Record<string, unknown>;
          Object.assign(recipe, body, { updatedAt: new Date().toISOString() });
        }
        send(200, recipe, route);
        return;
      }

      if (route === 'GET /temperatures/current/{deviceId}') {
        const deviceId = decodeURIComponent(temperatureMatch![1]);
        const owned = owns(deviceId);
        if (owned && deviceId === SIM_DEVICE && topupLast !== undefined) {
          // HAR-75: while a top-up is routed, each poll makes a batch readable;
          // once all of it is, the newest reading is its last.
          if (!options.simTopupNeverRouted) {
            const routed = Math.min(simPending, options.simDrainPerPoll ?? simPending);
            simPending -= routed;
            simStored += routed;
          }
          drainTotals.push(simStored);
          if (simPending === 0) {
            send(200, simReading(topupLast), route);
            return;
          }
        }
        if (owned && deviceId === SIM_DEVICE && twinReading) {
          // HAR-68: the reading the twin run sent, tagged with its cook.
          const { timestamp, cookId } = twinReading;
          send(200, { ...simReading(timestamp), ...(cookId ? { cookId } : {}) }, route);
          return;
        }
        if (owned && deviceId === SIM_DEVICE) {
          // HAR-44: the simulated device's reading arrives after a few polls.
          simPolls += 1;
          if (simRouted()) {
            send(200, simReading(simServed), route);
          } else if (simPolls === 1) {
            send(404, { error: 'NO_READINGS' }, route);
          } else {
            send(200, simReading(OLDER_READINGS[OLDER_READINGS.length - 1]), route);
          }
          return;
        }
        // Nothing else writes telemetry in the stub: an owned device has no readings.
        const code = owned ? 'NO_READINGS' : 'DEVICE_NOT_FOUND';
        send(404, { error: options.temperatureErrorCode ?? code }, route);
      } else if (route === 'GET /temperatures/history') {
        // An owned device has an empty first page; anything else is not found.
        const deviceId = url.searchParams.get('deviceId') ?? '';
        if (!devices.has(deviceId)) {
          send(404, { error: 'DEVICE_NOT_FOUND' }, route);
          return;
        }
        // HAR-75: offset paging is gone; refused before any read (no RU).
        if (url.searchParams.has('offset') && !options.historyAcceptsOffset) {
          send(400, { error: 'VALIDATION_ERROR', message: 'offset is not supported' });
          return;
        }
        const token = url.searchParams.get('continuationToken');
        /** A page of `all` from the position `prefix`-token names, `size` long. */
        const pageOf = <T>(all: readonly T[], size: number, prefix: string) => {
          const start = token === null ? 0 : Number(token.slice(prefix.length));
          const next = Math.min(all.length, start + size);
          const hasMore = next < all.length;
          return {
            start,
            body: {
              readings: all.slice(start, next),
              limit: size,
              hasMore,
              ...(hasMore ? { continuationToken: `${prefix}${next}` } : {}),
            },
          };
        };
        if (deviceId === SIM_DEVICE && !url.searchParams.has('startTime')) {
          // HAR-45/75: the volume, walked by token (`v-<position>`).
          const limit = Number(url.searchParams.get('limit') ?? '100');
          const all = Array.from({ length: simStored }, (_, i) =>
            simReading(new Date(Date.UTC(2026, 10, 12) + i * 5000).toISOString())
          );
          const { start, body } = pageOf(all, limit, 'v-');
          const deep = start > 0 && !body.hasMore ? options.simDeepPageCharge : undefined;
          send(200, body, route, deep);
          return;
        }
        if (deviceId === SIM_DEVICE) {
          // HAR-44: older readings plus the sent one, in pages of two (`w-<position>`).
          const startTime = url.searchParams.get('startTime');
          if (!startTime || Number.isNaN(Date.parse(startTime))) {
            send(400, { error: 'VALIDATION_ERROR' });
            return;
          }
          const all = [...OLDER_READINGS, ...(simRouted() ? [simServed] : [])].map(simReading);
          send(200, pageOf(all, SIM_HISTORY_PAGE, 'w-').body, route);
          return;
        }
        send(200, options.emptyHistoryBody ?? { readings: [], limit: 100, hasMore: false }, route);
      } else if (route === 'GET /devices') {
        send(200, { devices: [...devices.values()] }, route);
      } else if (route === 'POST /devices') {
        const body = (await readJson(request)) as Partial<StubDevice> & { deviceId?: string };
        if (!body?.deviceId || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.deviceId) || !body.name) {
          send(400, { error: 'VALIDATION_ERROR' });
          return;
        }
        if (
          devices.has(body.deviceId) ||
          (options.simOwnedByOther && body.deviceId === SIM_DEVICE)
        ) {
          send(409, { error: 'DEVICE_CONFLICT' }, route);
          return;
        }
        const device: StubDevice = {
          id: body.deviceId,
          userId: 'stub-tenant:stub-user',
          name: body.name,
          model: body.model ?? '',
          location: body.location,
          isActive: true,
          connectionStatus: 'unknown',
        };
        devices.set(device.id, device);
        send(201, device, route);
      } else if (route === 'GET /devices/{id}' || route === 'PATCH /devices/{id}') {
        const device = devices.get(decodeURIComponent(deviceMatch![1]));
        if (!device) {
          send(404, { error: 'NOT_FOUND' }, route);
          return;
        }
        if (route === 'PATCH /devices/{id}') {
          const body = (await readJson(request)) as Partial<StubDevice>;
          Object.assign(device, body.name ? { name: body.name } : {}, {
            location: body.location ?? device.location,
          });
        }
        send(200, device, route);
      } else if (route === 'GET /cooks') {
        // Honours the MG-87 filters, as the deployed route does.
        const deviceId = url.searchParams.get('deviceId');
        const status = url.searchParams.get('status');
        const sorted = cooks
          .filter(cook => deviceId === null || cook.deviceId === deviceId)
          .filter(cook => status === null || cook.status === status)
          .sort((a, b) => b.startTime.localeCompare(a.startTime));
        send(200, { cooks: sorted, limit: 100, hasMore: false }, route);
      } else if (route === 'GET /cooks/{cookId}') {
        // HAR-75: the caller's own cook only; a lock id is no cook.
        const id = decodeURIComponent(cookMatch![1]);
        const userId = caller === 'peer' ? 'stub-tenant:stub-peer' : 'stub-tenant:stub-user';
        const cook = cooks.find(
          candidate =>
            candidate.id === id &&
            (candidate.userId === userId || options.cookItemFault === 'peer-reads')
        );
        if (cook) {
          send(200, cook, route);
        } else if (id.startsWith('active-device:') && options.cookItemFault === 'lock-reads') {
          send(200, { id, userId, deviceId: id.slice('active-device:'.length) }, route);
        } else {
          send(404, { error: 'NOT_FOUND' }, route);
        }
      } else if (route === 'POST /cooks') {
        const body = (await readJson(request)) as Partial<StubCook>;
        if (!body?.id || !/^[0-9a-f-]{36}$/i.test(body.id) || !body.deviceId || !body.name) {
          send(400, { error: 'VALIDATION_ERROR' });
          return;
        }
        // HAR-26: a cook only starts on a device the caller registered.
        if (!options.allowAnyDevice && !owns(body.deviceId)) {
          send(403, { error: 'DEVICE_NOT_OWNED' }, route);
          return;
        }
        const cook: StubCook = {
          id: body.id,
          userId: caller === 'peer' ? 'stub-tenant:stub-peer' : 'stub-tenant:stub-user',
          deviceId: body.deviceId,
          name: body.name,
          status: 'active',
          startTime: new Date().toISOString(),
          meatType: body.meatType,
          notes: body.notes,
        };
        cooks.push(cook);
        pushCookEvent('cook_started', cook);
        if (cook.deviceId === SIM_DEVICE) {
          // HAR-66/68: the twin follows the stored cook; a failed PATCH is a 503
          // and the cook stays saved.
          if (options.twinUpdateFails && requestId?.startsWith('acceptance-twin-')) {
            send(
              503,
              {
                error: 'DEVICE_TWIN_UPDATE_FAILED',
                message: 'The cook was saved, but the device twin was not updated.',
                cookId: cook.id,
                reason: TWIN_FAILURE_REASON,
                requestId: 'stub-invocation',
              },
              route
            );
            return;
          }
          syncTwin(requestId ?? 'stub-invocation');
        }
        send(201, cook, route);
      } else {
        const cook = cooks.find(candidate => candidate.id === decodeURIComponent(stopMatch![1]));
        if (!cook) {
          send(404, { error: 'NOT_FOUND' }, route);
          return;
        }
        cook.status = 'completed';
        cook.endTime = new Date().toISOString();
        pushCookEvent('cook_stopped', cook);
        if (cook.deviceId === SIM_DEVICE) {
          syncTwin(requestId ?? 'stub-invocation');
        }
        send(200, cook, route);
      }
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    requests,
    twinRuns,
    signalRRequests,
    topups,
    livePushes,
    cookPushes,
    simCooks: () =>
      cooks.filter(c => c.deviceId === SIM_DEVICE).map(({ id, status }) => ({ id, status })),
    drainTotals,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

interface Run extends RunResult {
  readonly output: string;
  readonly lines: readonly string[];
}

async function run(
  env: Record<string, string | undefined>,
  groups?: readonly ProofGroup[]
): Promise<Run> {
  const lines: string[] = [];
  const result = await runAcceptance({
    env,
    write: line => lines.push(line),
    timeoutMs: 5_000,
    groups,
  });
  return { ...result, lines, output: lines.join('\n') };
}

let fakeDir: string;

/**
 * A stand-in for `simdevice`: a Node script, run through its shebang, that
 * prints one JSON line per reading the way simdevice does, or misbehaves as
 * `mode` says. In `ok` mode it exits 2 unless it got `--count 1` (the round
 * trip) or `--count N --inflight M --interval D` (a HAR-45/46 top-up) and the credential
 * arrived through its environment, so the runner's hand-over is checked too.
 * A top-up is reported to the running stub first, so the stub can serve it;
 * so is a `--count 1` send (HAR-63), so the stub can push it to SignalR clients.
 * `topup-exit1` sends the round trip's reading but fails a top-up; `hang`
 * never exits.
 */
function writeFakeSimdevice(mode: FakeMode): string {
  const path = join(fakeDir, `simdevice-${mode}`);
  const notifyUrl = stub ? `${stub.baseUrl}/__simdevice/sent` : '';
  const script = `#!${process.execPath}
const mode = ${JSON.stringify(mode)};
const conn = process.env.SIMDEVICE_CONNECTION_STRING || '';
const key = (conn.split(';').find(p => p.startsWith('SharedAccessKey=')) || '').slice(16);
const line = o => process.stdout.write(JSON.stringify(o) + '\\n');
const reading = timestamp => ({ messageId: 'f'.repeat(64), deviceId: ${JSON.stringify(SIM_DEVICE)}, timestamp, sentAt: new Date().toISOString() });
const args = process.argv.slice(2).join(' ');
const handedOver = conn === ${JSON.stringify(SIM_CONNECTION_STRING)} && !process.env.ACCEPTANCE_BEARER_TOKEN && !process.argv.some(a => a.includes(key));
const topup = /^--count ([1-9][0-9]*) --inflight [1-9][0-9]* --interval [0-9]+ms$/.exec(args);
const twin = /^--twin --count ([01]) --timeout 60s$/.exec(args);
if ((mode === 'ok' || mode === 'topup-exit1') && twin && handedOver) {
  // HAR-68: reconnect, read the stub's twin (it applies desired to reported),
  // print the twin line, then the reading carrying the cook.
  fetch(${JSON.stringify(stub ? `${stub.baseUrl}/__simdevice/twin` : '')}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: process.argv.slice(2) }),
  })
    .then(r => r.json())
    .then(({ desired, reported }) => {
      line({ event: 'twin', desired, reported });
      if (twin[1] === '1') line(reading(${JSON.stringify(TWIN_TIMESTAMP)}));
    }, () => {
      process.stderr.write('fake simdevice: no twin response\\n');
      process.exit(1);
    });
} else if (mode === 'ok' || mode === 'topup-exit1') {
  if (!handedOver || (args !== '--count 1' && !topup)) {
    process.stderr.write('fake simdevice: bad hand-over: ' + args + '\\n');
    process.exit(2);
  }
  if (!topup) {
    process.stderr.write('connected\\n');
    const print = () => line(reading(${JSON.stringify(SIM_TIMESTAMP)}));
    // HAR-63: tell the stub, so it can push the reading to SignalR clients.
    if (${JSON.stringify(notifyUrl)}) {
      fetch(${JSON.stringify(notifyUrl)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: process.argv.slice(2) }),
      }).then(print, print);
    } else {
      print();
    }
  } else if (mode === 'topup-exit1') {
    process.stderr.write('send reading 3 of ' + topup[1] + ': connection lost\\nmore detail\\n');
    process.exit(1);
  } else {
    fetch(${JSON.stringify(notifyUrl)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: process.argv.slice(2) }),
    }).then(() => {
      for (let i = 0; i < Number(topup[1]); i++) line(reading(new Date(${TOPUP_EPOCH} + i * 50).toISOString()));
    }, () => {
      process.stderr.write('fake simdevice: could not report the top-up\\n');
      process.exit(3);
    });
  }
} else if (mode === 'hang') {
  setInterval(() => undefined, 1000);
} else if (mode === 'exit1') {
  process.stderr.write('send failed: connection refused\\nmore detail\\n');
  process.exit(1);
} else if (mode === 'leak-stderr') {
  process.stdout.write(conn + '\\n');
  process.stderr.write('auth failed for ' + conn + ' key SharedAccessKey=' + key + ' bare ' + key + '\\n');
  process.exit(1);
} else {
  process.stderr.write(conn + '\\n');
  line({ ...reading(key), messageId: conn });
}
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/** The HAR-44 variables, with the fake simdevice in `mode`. */
function simEnv(mode: FakeMode = 'ok'): Record<string, string> {
  return {
    SIMDEVICE_CONNECTION_STRING: SIM_CONNECTION_STRING,
    ACCEPTANCE_SIM_DEVICE_ID: SIM_DEVICE,
    ACCEPTANCE_SIMDEVICE_BIN: writeFakeSimdevice(mode),
  };
}

let stub: Stub | undefined;

/** Run every proof group (or only `groups`) against a fresh stub. */
async function runAgainstStub(
  options: StubOptions = {},
  mode: FakeMode = 'ok',
  groups?: readonly ProofGroup[]
): Promise<Run> {
  stub = await startStub(options);
  return run(
    {
      ACCEPTANCE_BASE_URL: stub.baseUrl,
      ACCEPTANCE_BEARER_TOKEN: TOKEN,
      ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
      ...simEnv(mode),
    },
    groups
  );
}

const realPoll = { ...ROUNDTRIP_POLL };
const realLiveWait = { ...LIVE_WAIT };
const realIsolationWait = { ...ISOLATION_WAIT };
const realTwinPoll = { ...TWIN_POLL };
const realVolume = { ...VOLUME };

beforeAll(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'acceptance-simdevice-'));
  // The round-trip proof polls every 1 s for up to 120 s live; here, far less.
  ROUNDTRIP_POLL.intervalMs = 5;
  ROUNDTRIP_POLL.capMs = 300;
  // HAR-63: the live push is waited for up to 90 s live; here, 300 ms.
  LIVE_WAIT.capMs = 300;
  // HAR-67: 90 s for the owner's message and a 15 s grace for the peer live.
  ISOLATION_WAIT.capMs = 300;
  ISOLATION_WAIT.graceMs = 100;
  // HAR-68: the twin reading is polled every 2 s for up to 90 s live.
  TWIN_POLL.intervalMs = 5;
  TWIN_POLL.capMs = 300;
  // HAR-45: a long cook is 8,640 readings, walked 1,000 a page, and the
  // current reading re-read every 10 s for up to 15 min live. Here a few
  // hundred walked 100 a page (so a walk is several pages), and polls in
  // milliseconds. The send interval is left as it is live.
  VOLUME.target = 240;
  VOLUME.margin = 6;
  VOLUME.pageLimit = 100;
  VOLUME.pollIntervalMs = 5;
  VOLUME.pollCapMs = 300;
});

afterAll(() => {
  Object.assign(ROUNDTRIP_POLL, realPoll);
  Object.assign(LIVE_WAIT, realLiveWait);
  Object.assign(ISOLATION_WAIT, realIsolationWait);
  Object.assign(TWIN_POLL, realTwinPoll);
  Object.assign(VOLUME, realVolume);
  rmSync(fakeDir, { recursive: true, force: true });
});

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

/** The RU summary row for a route, e.g. `  POST /cooks   1   11.43   11.43`. */
function summaryRow(output: string, route: string): string | undefined {
  const summary = output.split('RU per route')[1] ?? '';
  return summary.split('\n').find(line => new RegExp(`^\\s+${escape(route)}\\s+\\d`).test(line));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ROUTES: CookRoute[] = ['POST /cooks', 'GET /cooks', 'POST /cooks/{cookId}/stop'];
const COOK_ITEM_ROUTE: CookItemRoute = 'GET /cooks/{cookId}';
const DEVICE_ROUTES: DeviceRoute[] = [
  'POST /devices',
  'GET /devices/{id}',
  'GET /devices',
  'PATCH /devices/{id}',
];
const TEMPERATURE_ROUTES: TemperatureRoute[] = [
  'GET /temperatures/current/{deviceId}',
  'GET /temperatures/history',
];
const USER_ROUTES: UserRoute[] = ['PUT /users/me', 'GET /users/me'];
const SIGNALR_ROUTES: SignalRRoute[] = ['POST /negotiate'];
const RECIPE_ROUTES: RecipeRoute[] = [
  'POST /recipes',
  'GET /recipes/{id}',
  'GET /recipes',
  'PATCH /recipes/{id}',
  'DELETE /recipes/{id}',
];

describe('live acceptance runner (against an in-process stub)', () => {
  it('(a) exits 0 against a passing stub and reports RU for every cooks, devices, recipes, temperatures and users route', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/\d+ passed, 0 failed, 0 skipped/);

    // Every authenticated request line carries the RU the stub reported.
    const requestLines = result.lines.filter(line =>
      /^\s+(GET|POST|PATCH|PUT|DELETE)\s+\//.test(line)
    );
    expect(requestLines.length).toBeGreaterThanOrEqual(5);
    for (const route of [
      ...ROUTES,
      COOK_ITEM_ROUTE,
      ...DEVICE_ROUTES,
      ...TEMPERATURE_ROUTES,
      ...USER_ROUTES,
      ...RECIPE_ROUTES,
      ...SIGNALR_ROUTES,
    ]) {
      const [method, path] = route.split(' ');
      const lines = requestLines.filter(line =>
        new RegExp(`^\\s+${method}\\s+${escape(path)}\\s`).test(line)
      );
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some(line => line.endsWith(`RU ${RU[route]}`))).toBe(true);
      // ...and the summary has an RU line for it.
      expect(summaryRow(result.output, route)).toMatch(new RegExp(`${escape(RU[route])}\\s*$`));
    }
    // The unauthenticated call is its own row, with no RU.
    expect(summaryRow(result.output, 'GET /cooks (no auth)')).toMatch(/-\s*$/);

    // HAR-26: one start on the registered device, one refused on the unowned one.
    // HAR-67: the isolation group starts one more as the owner and is refused
    // one as the peer. HAR-68: the twin group starts one more as the owner.
    const posts = stub!.requests.filter(r => r.method === 'POST' && r.path === '/api/cooks');
    expect(posts.filter(r => r.authorization === `Bearer ${TOKEN}`)).toHaveLength(4);
    expect(posts.filter(r => r.authorization === `Bearer ${PEER_TOKEN}`)).toHaveLength(1);
    expect(
      stub!.requests.filter(
        r => r.method === 'GET' && /^\/api\/cooks\?deviceId=acceptance-unowned-[^&]+$/.test(r.path)
      )
    ).toHaveLength(1);
    // MG-87: the reconcile query ran once while the cook was active, once after.
    const filtered = stub!.requests.filter(
      r =>
        r.method === 'GET' && /^\/api\/cooks\?deviceId=acceptance-[^&]+&status=active$/.test(r.path)
    );
    expect(filtered).toHaveLength(2);
    // The unauthenticated proof sent no Authorization header; all others did.
    const anonymous = stub!.requests.filter(r => r.authorization === undefined);
    expect(anonymous).toHaveLength(1);
    expect(anonymous[0]).toMatchObject({ method: 'GET', path: '/api/cooks' });
  });

  /** HAR-68: the device twin group's failures when `route` is broken: the step
   *  that sends it, plus its always-run cleanup when that lists (GET /cooks) or
   *  must stop (a stop refused, so the cook is still active) the cooks. */
  const twinFailures = (route: CookRoute, refused: boolean): number =>
    route === 'GET /cooks' || (refused && route === 'POST /cooks/{cookId}/stop') ? 2 : 1;

  it.each(ROUTES)('(b) exits non-zero and names %s when it returns a wrong status', async route => {
    const result = await runAgainstStub({ failRoute: { route, status: 503 } });

    expect(result.exitCode).not.toBe(0);
    // HAR-67 and HAR-68: the isolation and twin groups use every cooks route too.
    const twin = result.failures.filter(line => line.startsWith('FAIL device twin ›'));
    expect(twin).toHaveLength(twinFailures(route, true));
    expect(result.failures).toHaveLength(2 + twin.length);
    expect(result.failures[0]).toContain('cooks lifecycle ›');
    expect(result.failures[result.failures.length - 1]).toContain('signalr isolation ›');
    for (const failure of result.failures) {
      expect(failure).toMatch(new RegExp(`${escape(route)}( \\(peer\\))? → 503`));
    }
  });

  it('(a) HAR-75: reads the cook by id as the owner (twice), the peer, an unknown id and the lock', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    const reads = stub!.requests
      .filter(r => r.method === 'GET' && /^\/api\/cooks\/[^/?]+$/.test(r.path))
      .map(r => ({
        id: decodeURIComponent(r.path.slice('/api/cooks/'.length)),
        as: r.authorization === `Bearer ${PEER_TOKEN}` ? 'peer' : 'owner',
      }));
    expect(reads).toHaveLength(5);
    const cookId = reads[0].id;
    expect(reads).toEqual([
      { id: cookId, as: 'owner' },
      { id: cookId, as: 'peer' },
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), as: 'owner' },
      { id: expect.stringMatching(/^active-device:acceptance-cook-/), as: 'owner' },
      { id: cookId, as: 'owner' },
    ]);
    expect(reads[2].id).not.toBe(cookId);
    for (const step of [
      'GET /cooks/{cookId} as the owner returns the started cook',
      'GET /cooks/{cookId} as the peer is 404 NOT_FOUND',
      'GET /cooks/{cookId} for an unknown id is 404 NOT_FOUND',
      'GET /cooks/{cookId} for the device lock active-device:<deviceId> is 404 NOT_FOUND',
      'GET /cooks/{cookId} reads the cook back as completed with an endTime',
    ]) {
      expect(result.lines).toContain(`PASS cooks lifecycle › ${step}`);
    }
  });

  it.each([
    [
      'peer-reads',
      'GET /cooks/{cookId} as the peer is 404 NOT_FOUND',
      'GET /cooks/{cookId} (peer) → 200: expected 404',
    ],
    [
      'lock-reads',
      'GET /cooks/{cookId} for the device lock active-device:<deviceId> is 404 NOT_FOUND',
      'GET /cooks/{cookId} → 200: expected 404',
    ],
  ] as const)(
    '(b) HAR-75: exits non-zero when GET /cooks/{cookId} %s',
    async (cookItemFault, step, shown) => {
      const result = await runAgainstStub({ cookItemFault });

      expect(result.exitCode).not.toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(`FAIL cooks lifecycle › ${step}`);
      expect(result.failures[0]).toContain(shown);
    }
  );

  it('(b) HAR-75: exits non-zero and names GET /cooks/{cookId} when it returns a wrong status', async () => {
    const result = await runAgainstStub({ failRoute: { route: COOK_ITEM_ROUTE, status: 503 } });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(
      'FAIL cooks lifecycle › GET /cooks/{cookId} as the owner returns the started cook'
    );
    expect(result.failures[0]).toContain('GET /cooks/{cookId} → 503');
  });

  it('(c) HAR-75: exits non-zero when GET /cooks/{cookId} omits the RU header', async () => {
    const result = await runAgainstStub({ omitChargeOn: COOK_ITEM_ROUTE });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('GET /cooks/{cookId}');
    expect(result.failures[0]).toContain(`missing ${REQUEST_CHARGE_HEADER} header`);
  });

  /** HAR-26 and HAR-28: the cooks lifecycle and the temperatures proof also
   *  register their own device, so a broken POST /devices fails them too.
   *  HAR-68: the device twin group registers the simulated device first
   *  (201), so the isolation (HAR-67), live-temperature (HAR-63) and round
   *  trip groups, which run after it, take the 409 path and read
   *  GET /devices/{id}. */
  const groupsUsing = (route: DeviceRoute): string[] =>
    route === 'POST /devices'
      ? [
          'cooks lifecycle ›',
          'device twin ›',
          'devices ›',
          'temperatures ›',
          'signalr isolation ›',
          'signalr live temperature ›',
          'telemetry round-trip ›',
        ]
      : route === 'GET /devices/{id}'
        ? [
            'devices ›',
            'signalr isolation ›',
            'signalr live temperature ›',
            'telemetry round-trip ›',
          ]
        : ['devices ›'];

  it.each(DEVICE_ROUTES)(
    '(b) exits non-zero and names %s when it returns a wrong status',
    async route => {
      const result = await runAgainstStub({ failRoute: { route, status: 503 } });

      expect(result.exitCode).not.toBe(0);
      const groups = groupsUsing(route);
      // HAR-45: the volume group relies on the round trip's registration, so a
      // refused POST /devices leaves it reading an unregistered device.
      const volume = result.failures.filter(line => line.startsWith('FAIL telemetry volume ›'));
      expect(volume).toHaveLength(route === 'POST /devices' ? 1 : 0);
      volume.forEach(failure =>
        expect(failure).toContain('GET /temperatures/history → 404: expected 200, got 404')
      );
      expect(result.failures).toHaveLength(groups.length + volume.length);
      groups.forEach(group => {
        const failure = result.failures.find(line => line.includes(group));
        expect(failure).toContain(`${route} → 503`);
      });
    }
  );

  it.each(USER_ROUTES)(
    '(b) exits non-zero and names %s when it returns a wrong status',
    async route => {
      const result = await runAgainstStub({ failRoute: { route, status: 503 } });

      expect(result.exitCode).not.toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(`${route} → 503`);
      expect(result.failures[0]).toContain('users ›');
    }
  );

  it.each(RECIPE_ROUTES)(
    '(b) exits non-zero and names %s when it returns a wrong status',
    async route => {
      const result = await runAgainstStub({ failRoute: { route, status: 503 } });

      expect(result.exitCode).not.toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(`${route} → 503`);
      expect(result.failures[0]).toContain('recipes ›');
    }
  );

  it('(a) HAR-57: connects a SignalR client with the negotiated url and token, then stops it', async () => {
    const result = await runAgainstStub();

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('PASS signalr negotiate › POST /negotiate returns a url');
    expect(result.output).toContain('PASS signalr negotiate › a SignalR client connects');
    const calls = stub!.signalRRequests.map(r => `${r.method} ${r.path.split('?')[0]}`);
    expect(calls[0]).toBe('POST /client/negotiate');
    expect(calls).toContain('GET /client/');
    expect(calls).toContain('POST /client/');
    // stop() ends the connection with a DELETE, after the handshake POST. (A
    // close message the client POSTs can race the DELETE, so it need not be last.)
    expect(calls.lastIndexOf('DELETE /client/')).toBeGreaterThan(calls.indexOf('POST /client/'));
    // Every SignalR call presented a negotiated token (HAR-67: the owner's or
    // the peer's), never an API bearer.
    expect(
      stub!.signalRRequests.every(
        r =>
          r.authorization === `Bearer ${SIGNALR_CLIENT_TOKEN}` ||
          r.authorization === `Bearer ${PEER_SIGNALR_CLIENT_TOKEN}`
      )
    ).toBe(true);
    // Neither the token nor the client url reaches the output.
    expect(result.output).not.toContain(SIGNALR_CLIENT_TOKEN);
    expect(result.output).not.toContain('/client/');
  });

  it.each(SIGNALR_ROUTES)(
    '(b) exits non-zero and names %s when it returns a wrong status',
    async route => {
      const result = await runAgainstStub({ failRoute: { route, status: 503 } });

      expect(result.exitCode).not.toBe(0);
      // HAR-63, HAR-67: the live-temperature and isolation groups negotiate too.
      expect(result.failures).toHaveLength(3);
      for (const group of [
        'signalr isolation ›',
        'signalr live temperature ›',
        'signalr negotiate ›',
      ]) {
        expect(result.failures.find(line => line.includes(group))).toContain(`${route} → 503`);
      }
      expect(result.output).toContain('SKIP signalr negotiate › a SignalR client connects');
      expect(result.output).toContain(
        'SKIP signalr live temperature › simdevice --count 1 sends one reading'
      );
      expect(stub!.signalRRequests).toEqual([]);
    }
  );

  it("(b) HAR-59: a 503 from POST /negotiate prints the body's reason, naming the failed SignalR call", async () => {
    const result = await runAgainstStub({
      negotiateUnavailableReason: 'signalr_add_user_to_group_status_404',
    });

    expect(result.exitCode).not.toBe(0);
    // HAR-63, HAR-67: the live-temperature and isolation groups negotiate too,
    // and report it the same way.
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0]).toContain('FAIL signalr isolation › the owner negotiates');
    expect(result.failures[1]).toContain(
      'FAIL signalr live temperature › POST /negotiate returns 200'
    );
    expect(result.failures[2]).toContain(
      'FAIL signalr negotiate › POST /negotiate returns a url and an accessToken'
    );
    for (const failure of result.failures) {
      expect(failure).toContain('POST /negotiate → 503');
      expect(failure).toContain(
        'expected 200, got 503 (SIGNALR_UNAVAILABLE); reason signalr_add_user_to_group_status_404'
      );
    }
  });

  it('(b) HAR-59: a reason that is not a fixed signalr_ code is not printed', async () => {
    const result = await runAgainstStub({
      negotiateUnavailableReason:
        'PUT https://acct.service.signalr.net/api/hubs failed for tid:oid',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures[0]).toContain('reason unrecognised, not printed');
    expect(result.output).not.toContain('acct.service.signalr.net');
    expect(result.output).not.toContain('tid:oid');
  });

  it('(b) HAR-57: fails the connect proof when SignalR refuses the token, printing neither token nor url', async () => {
    const result = await runAgainstStub({ signalRRejectsToken: true });

    expect(result.exitCode).not.toBe(0);
    // HAR-63, HAR-67: the live-temperature and isolation groups connect too.
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0]).toContain('FAIL signalr isolation › the owner negotiates');
    expect(result.failures[1]).toContain(
      'FAIL signalr live temperature › POST /negotiate returns 200'
    );
    expect(result.failures[2]).toContain('FAIL signalr negotiate › a SignalR client connects');
    for (const failure of result.failures) {
      expect(failure).toContain('start() failed');
    }
    expect(result.output).not.toContain(SIGNALR_CLIENT_TOKEN);
    expect(result.output).not.toContain('/client/');
  });

  it('(a) runs the recipes proof in order and deletes the recipe it created', async () => {
    const result = await runAgainstStub();

    expect(result.exitCode).toBe(0);
    const recipeCalls = stub!.requests
      .filter(r => r.path.startsWith('/api/recipes'))
      .map(r => `${r.method} ${r.path.replace(/\/api\/recipes\/[^/?]+/, '/api/recipes/{id}')}`);
    expect(recipeCalls).toEqual([
      'POST /api/recipes',
      'GET /api/recipes/{id}',
      'GET /api/recipes',
      'PATCH /api/recipes/{id}',
      'GET /api/recipes/{id}',
      'DELETE /api/recipes/{id}',
      'GET /api/recipes/{id}',
    ]);
    // The 204 and the 404 after it both carried their RU.
    expect(
      result.lines.some(line => /^\s+DELETE\s+\/recipes\/\{id\}\s+204\s.*RU 10\.29$/.test(line))
    ).toBe(true);
    expect(
      result.lines.some(line => /^\s+GET\s+\/recipes\/\{id\}\s+404\s.*RU 1\.02$/.test(line))
    ).toBe(true);
  });

  it('(b) exits non-zero when DELETE /recipes/{id} reports no RU', async () => {
    const result = await runAgainstStub({ omitChargeOn: 'DELETE /recipes/{id}' });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('recipes ›');
    expect(result.failures[0]).toContain('missing x-meatgeek-request-charge header');
  });

  /** HAR-44: the telemetry round-trip reads both temperatures routes too;
   *  HAR-45: the telemetry volume group reads history only; HAR-67: the
   *  isolation group reads current, as the peer; HAR-68: so does the twin
   *  group, as the owner. */
  const temperatureGroups = (route: TemperatureRoute): string[] => [
    'FAIL temperatures ›',
    'FAIL telemetry round-trip ›',
    ...(route === 'GET /temperatures/history'
      ? ['FAIL telemetry volume ›']
      : ['FAIL signalr isolation ›', 'FAIL device twin ›']),
  ];

  it.each(TEMPERATURE_ROUTES)(
    '(b) exits non-zero and names %s when it returns a wrong status',
    async route => {
      const result = await runAgainstStub({ failRoute: { route, status: 503 } });

      expect(result.exitCode).not.toBe(0);
      expect(result.failures).toHaveLength(temperatureGroups(route).length);
      temperatureGroups(route).forEach(group => {
        const failure = result.failures.find(line => line.startsWith(group));
        expect(failure).toMatch(new RegExp(`${escape(route)}( \\(peer\\))? → 503`));
      });
    }
  );

  it.each([
    // Every answer NO_READINGS: the unowned-device proof must fail.
    ['NO_READINGS', 'DEVICE_NOT_FOUND'],
    // Every answer DEVICE_NOT_FOUND: the registered-device proof must fail.
    ['DEVICE_NOT_FOUND', 'NO_READINGS'],
  ])(
    '(b) exits non-zero when GET /temperatures/current always answers 404 %s',
    async (answered, expected) => {
      const result = await runAgainstStub({ temperatureErrorCode: answered });

      expect(result.exitCode).not.toBe(0);
      const failures = result.failures.filter(line => line.startsWith('FAIL temperatures ›'));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('GET /temperatures/current/{deviceId} → 404');
      expect(failures[0]).toContain(`body.error is "${answered}", not ${expected}`);
      // HAR-67: the peer's read of the simulated device must be DEVICE_NOT_FOUND too.
      const isolation = result.failures.filter(line => line.startsWith('FAIL signalr isolation ›'));
      expect(isolation).toHaveLength(answered === 'DEVICE_NOT_FOUND' ? 0 : 1);
      expect(result.failures).toHaveLength(failures.length + isolation.length);
    }
  );

  it.each([
    [
      'still has the pre-HAR-75 total and offset',
      { readings: [], total: 0, offset: 0, limit: 100, hasMore: false },
      '"total":0',
    ],
    [
      'has a continuationToken',
      { readings: [], limit: 100, hasMore: false, continuationToken: 'x' },
      '"continuationToken":"x"',
    ],
    ['has more pages', { readings: [], limit: 100, hasMore: true }, '"hasMore":true'],
  ])(
    '(b) exits non-zero when GET /temperatures/history for a new device %s',
    async (_label, emptyHistoryBody, shown) => {
      const result = await runAgainstStub({ emptyHistoryBody });

      expect(result.exitCode).not.toBe(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain('FAIL temperatures ›');
      expect(result.failures[0]).toContain('GET /temperatures/history → 200');
      expect(result.failures[0]).toContain(shown);
    }
  );

  it('(b) HAR-75: exits non-zero when GET /temperatures/history accepts offset=0', async () => {
    const result = await runAgainstStub({ historyAcceptsOffset: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(
      'FAIL temperatures › GET /temperatures/history with offset=0 is 400 VALIDATION_ERROR'
    );
    expect(result.failures[0]).toContain('GET /temperatures/history → 200: expected 400');
  });

  it('(a) HAR-75: the temperatures proof sends offset=0 and expects no RU on its 400', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    expect(
      stub!.requests.filter(r => /^\/api\/temperatures\/history\?.*&offset=0$/.test(r.path))
    ).toHaveLength(1);
    expect(result.lines.some(line => /^\s+GET\s+\/temperatures\/history\s+400\s/.test(line))).toBe(
      true
    );
  });

  it.each(TEMPERATURE_ROUTES)('(c) exits non-zero when %s omits the RU header', async route => {
    const result = await runAgainstStub({ omitChargeOn: route });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(temperatureGroups(route).length);
    temperatureGroups(route).forEach(group => {
      const failure = result.failures.find(line => line.startsWith(group));
      expect(failure).toContain(route);
      expect(failure).toContain(`missing ${REQUEST_CHARGE_HEADER} header`);
    });
  });

  it.each(USER_ROUTES)('(c) exits non-zero when %s omits the RU header', async route => {
    const result = await runAgainstStub({ omitChargeOn: route });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(route);
    expect(result.failures[0]).toContain(`missing ${REQUEST_CHARGE_HEADER} header`);
  });

  it('accepts the profile PUT as a create on the first run and a replace on the next', async () => {
    stub = await startStub();
    const env = {
      ACCEPTANCE_BASE_URL: stub.baseUrl,
      ACCEPTANCE_BEARER_TOKEN: TOKEN,
      ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
      ...simEnv(),
    };
    const first = await runAcceptance({ env, write: () => undefined, runId: `r-${randomUUID()}` });
    const lines: string[] = [];
    const second = await runAcceptance({
      env,
      write: line => lines.push(line),
      runId: `r-${randomUUID()}`,
    });

    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    expect(lines.some(line => /^\s+PUT\s+\/users\/me\s+200\s/.test(line))).toBe(true);
  });

  it.each(DEVICE_ROUTES)('(c) exits non-zero when %s omits the RU header', async route => {
    const result = await runAgainstStub({ omitChargeOn: route });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(groupsUsing(route).length);
    for (const failure of result.failures) {
      expect(failure).toContain(route);
      expect(failure).toContain(`missing ${REQUEST_CHARGE_HEADER} header`);
    }
  });

  it('(b) exits non-zero when POST /cooks on an unregistered device is not refused', async () => {
    // The pre-HAR-26 behaviour: a cook starts on any device.
    const result = await runAgainstStub({ allowAnyDevice: true });

    expect(result.exitCode).not.toBe(0);
    // HAR-67: the peer's start on the simulated device is not refused either.
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toContain('unregistered device is 403 DEVICE_NOT_OWNED');
    expect(result.failures[0]).toContain('POST /cooks → 201: expected 403');
    expect(result.failures[1]).toContain(
      'FAIL signalr isolation › the peer: POST /cooks on the simulated device is 403'
    );
    expect(result.failures[1]).toContain('POST /cooks (peer) → 201: expected 403');
  });

  it("HAR-68: sends a proof's extra headers, but never lets them replace the caller's token", async () => {
    const result = await runAgainstStub({}, 'ok', [
      {
        name: 'headers',
        create: () => [
          {
            name: 'GET /cooks with X-Request-ID and a forged Authorization',
            run: async api => {
              const response = await api.request({
                method: 'GET',
                path: '/cooks',
                headers: { 'X-Request-ID': 'acceptance-headers', authorization: 'Bearer forged' },
              });
              api.expectStatus(response, 200);
            },
          },
        ],
      },
    ]);

    expect(result.failures).toEqual([]);
    expect(stub!.requests).toEqual([
      {
        method: 'GET',
        path: '/api/cooks',
        authorization: `Bearer ${TOKEN}`,
        requestId: 'acceptance-headers',
      },
    ]);
  });

  it('(b) exits non-zero when the unauthenticated GET /cooks is not refused', async () => {
    // A stub that lets anyone in (e.g. Easy Auth switched off) must fail proof 1.
    stub = await startStub();
    const lines: string[] = [];
    const result = await runAcceptance({
      env: {
        ACCEPTANCE_BASE_URL: stub.baseUrl,
        ACCEPTANCE_BEARER_TOKEN: TOKEN,
        ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
        ...simEnv(),
      },
      write: line => lines.push(line),
      groups: [
        {
          name: 'cooks auth',
          create: () => [
            {
              name: 'GET /cooks without a token is refused with 401',
              run: async api => {
                const response = await api.request({
                  method: 'GET',
                  path: '/cooks',
                  expectRequestCharge: false,
                });
                api.expectStatus(response, 401);
              },
            },
          ],
        },
      ],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures[0]).toContain('GET /cooks → 200: expected 401');
  });

  it.each(ROUTES)('(c) exits non-zero when %s omits the RU header', async route => {
    const result = await runAgainstStub({ omitChargeOn: route });

    expect(result.exitCode).not.toBe(0);
    // HAR-67 and HAR-68: the isolation and twin groups use every cooks route
    // too. A stop that went through but omitted its RU leaves nothing for the
    // twin group's cleanup to stop.
    const twin = result.failures.filter(line => line.startsWith('FAIL device twin ›'));
    expect(twin).toHaveLength(twinFailures(route, false));
    expect(result.failures).toHaveLength(2 + twin.length);
    expect(result.failures[0]).toContain('cooks lifecycle ›');
    expect(result.failures[result.failures.length - 1]).toContain('signalr isolation ›');
    for (const failure of result.failures) {
      expect(failure).toContain(route);
      expect(failure).toContain(`missing ${REQUEST_CHARGE_HEADER} header`);
    }
  });

  it.each([
    ['ACCEPTANCE_BASE_URL', { ACCEPTANCE_BEARER_TOKEN: TOKEN }],
    ['ACCEPTANCE_BEARER_TOKEN', { ACCEPTANCE_BASE_URL: 'http://127.0.0.1:9/api' }],
    [
      'ACCEPTANCE_BEARER_TOKEN',
      { ACCEPTANCE_BASE_URL: 'http://127.0.0.1:9/api', ACCEPTANCE_BEARER_TOKEN: '  ' },
    ],
  ])('(d) exits non-zero naming %s when it is missing', async (name, env) => {
    const result = await run(env);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(`${name} is not set`);
    expect(result.failures.join('\n')).toContain(name);
  });

  it('(d) names both variables when neither is set', async () => {
    const result = await run({});

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('ACCEPTANCE_BASE_URL is not set');
    expect(result.output).toContain('ACCEPTANCE_BEARER_TOKEN is not set');
  });

  it.each([undefined, '  '])(
    '(d) HAR-67: refuses to run when ACCEPTANCE_PEER_BEARER_TOKEN is %p',
    async value => {
      stub = await startStub();
      const result = await run({
        ACCEPTANCE_BASE_URL: stub.baseUrl,
        ACCEPTANCE_BEARER_TOKEN: TOKEN,
        ACCEPTANCE_PEER_BEARER_TOKEN: value,
        ...simEnv(),
      });

      expect(result.exitCode).toBe(2);
      expect(result.failures).toEqual([
        'acceptance: ACCEPTANCE_PEER_BEARER_TOKEN is not set; the live acceptance run needs it',
      ]);
      // Nothing ran: no request, no SignalR connection.
      expect(stub.requests).toHaveLength(0);
      expect(stub.signalRRequests).toHaveLength(0);
    }
  );

  it('(e) never prints the token, even when the server echoes it back', async () => {
    const outputs: string[] = [];

    outputs.push((await runAgainstStub({ echoAuthorization: true })).output);
    await stub!.close();
    outputs.push(
      (
        await runAgainstStub({
          echoAuthorization: true,
          failRoute: { route: 'POST /cooks', status: 500 },
        })
      ).output
    );
    await stub!.close();
    outputs.push(
      (await runAgainstStub({ echoAuthorization: true, omitChargeOn: 'GET /cooks' })).output
    );

    // The echoing stub did reach the failure path, with the token in its body...
    expect(outputs[1]).toContain('POST /cooks → 500');
    for (const output of outputs) {
      expect(output).not.toContain(TOKEN);
      expect(output).not.toContain('SECRET-acceptance-token');
      // HAR-67: nor the peer's.
      expect(output).not.toContain(PEER_TOKEN);
      expect(output).not.toContain('SECRET-peer-token');
      expect(output).not.toMatch(/authorization/i);
    }
    // ...and the token was in fact sent on authenticated requests.
    expect(stub!.requests.some(r => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('starts each run with a fresh synthetic device, so reruns never collide', async () => {
    stub = await startStub();
    const env = {
      ACCEPTANCE_BASE_URL: stub.baseUrl,
      ACCEPTANCE_BEARER_TOKEN: TOKEN,
      ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
      ...simEnv(),
    };
    const first = await runAcceptance({ env, write: () => undefined, runId: `r-${randomUUID()}` });
    const lines: string[] = [];
    const second = await runAcceptance({
      env,
      write: line => lines.push(line),
      runId: `r-${randomUUID()}`,
    });

    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    // HAR-44: the standing simulated device is reused, not re-registered: the
    // second run's POST is 409 and the GET that follows proves it is the caller's.
    expect(lines.some(line => /^\s+POST\s+\/devices\s+409\s/.test(line))).toBe(true);
    expect(lines.some(line => /^\s+GET\s+\/devices\/\{id\}\s+200\s/.test(line))).toBe(true);
    expect(lines).toContain(
      'PASS telemetry round-trip › POST /devices registers the simulated device to the caller'
    );
  });
});

describe('telemetry round-trip (HAR-44, against the stub and a fake simdevice)', () => {
  const GROUP = 'telemetry round-trip ›';
  const telemetryFailures = (result: Run) =>
    result.failures.filter(line => line.startsWith(`FAIL ${GROUP}`));

  it('(a) passes once the reading is readable after a few polls, and prints METRIC roundtrip-ms', async () => {
    const result = await runAgainstStub({ simVisibleFromPoll: 4 });

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    for (const step of [
      'POST /devices registers the simulated device to the caller',
      'simdevice --count 1 sends one reading through IoT Hub',
      'GET /temperatures/current/{deviceId} returns the sent reading',
      'GET /temperatures/history holds the sent reading',
    ]) {
      expect(result.lines).toContain(`PASS ${GROUP} ${step}`);
    }
    const metrics = result.lines.filter(line => line.startsWith('METRIC roundtrip-ms '));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatch(/^METRIC roundtrip-ms \d+$/);
    expect(result.lines.some(line => /^\s+EXEC\s+simdevice --count 1\s+exit 0\s/.test(line))).toBe(
      true
    );

    // A 404 NO_READINGS, then older readings, were polled past.
    // (HAR-67: the isolation group's one read is the peer's, not counted.
    // HAR-68: the twin group's one read, before the round trip, is.)
    const current = stub!.requests.filter(
      r =>
        r.path === `/api/temperatures/current/${SIM_DEVICE}` &&
        r.authorization === `Bearer ${TOKEN}`
    );
    expect(current).toHaveLength(1 + 4);
    // History was paged (two per page, HAR-75: by continuation token) until the
    // sent reading turned up, from a window opening five minutes before the
    // send. (The volume group's reads carry no window.)
    const history = stub!.requests
      .filter(r => r.path.startsWith(`/api/temperatures/history?deviceId=${SIM_DEVICE}&`))
      .map(r => new URL(r.path, 'http://stub').searchParams)
      .filter(params => params.has('startTime'));
    expect(history.map(params => params.get('continuationToken'))).toEqual([null, 'w-2']);
    expect(history.every(params => !params.has('offset'))).toBe(true);
    const opened = Date.parse(history[0].get('startTime') ?? '');
    expect(Date.now() - opened).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(Date.now() - opened).toBeLessThan(6 * 60 * 1000);
    // Polls go through api.request, so they are in the RU table.
    expect(summaryRow(result.output, 'GET /temperatures/current/{deviceId}')).toBeDefined();
  });

  it('(a) matches the sent timestamp as an instant: printed …33.120Z, served …33.12Z', async () => {
    // simdevice prints three fractional digits; the payload (Go RFC3339Nano)
    // and so the API drop trailing zeros.
    const served = SIM_TIMESTAMP.replace('.120Z', '.12Z');
    expect(served).not.toBe(SIM_TIMESTAMP);
    const result = await runAgainstStub({ simServedTimestamp: served });

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain(
      `PASS ${GROUP} GET /temperatures/current/{deviceId} returns the sent reading`
    );
    expect(result.lines).toContain(
      `PASS ${GROUP} GET /temperatures/history holds the sent reading`
    );
    expect(result.lines.filter(line => line.startsWith('METRIC roundtrip-ms '))).toHaveLength(1);
  });

  it('(b) fails naming the cap when the reading never appears', async () => {
    const result = await runAgainstStub({ simNeverRouted: true });

    expect(result.exitCode).not.toBe(0);
    const failures = telemetryFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('GET /temperatures/current/{deviceId} returns the sent reading');
    expect(failures[0]).toContain(`within the ${ROUNDTRIP_POLL.capMs / 1000} s cap`);
    expect(failures[0]).toContain('last status 200');
    expect(failures[0]).toContain(`last timestamp seen "${OLDER_READINGS[2]}"`);
    expect(result.output).toContain(
      `SKIP ${GROUP} GET /temperatures/history holds the sent reading`
    );
    expect(result.output).not.toMatch(/^METRIC roundtrip-ms /m);
  });

  it('(c) fails with the exit code when simdevice exits 1', async () => {
    const result = await runAgainstStub({}, 'exit1');

    expect(result.exitCode).not.toBe(0);
    const failures = telemetryFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('simdevice → exit 1');
    expect(failures[0]).toContain(
      'simdevice exited 1, expected 0: send failed: connection refused'
    );
    // Only the first stderr line is reported.
    expect(result.output).not.toContain('more detail');
  });

  it.each<FakeMode>(['leak-stderr', 'leak-stdout'])(
    '(d) never prints the connection string or its key when simdevice prints them (%s)',
    async mode => {
      const result = await runAgainstStub({}, mode);

      // The leak reached the failure path, and was masked there...
      expect(result.exitCode).not.toBe(0);
      expect(telemetryFailures(result)).toHaveLength(1);
      expect(telemetryFailures(result)[0]).toContain('[redacted]');
      // ...and nowhere in the output is the credential, its key, or its parts.
      for (const text of [result.output, ...result.failures]) {
        expect(text).not.toContain(SIM_CONNECTION_STRING);
        expect(text).not.toContain(SIM_KEY);
        expect(text).not.toContain('SharedAccessKey=');
        expect(text).not.toContain(`DeviceId=${SIM_DEVICE};`);
      }
    }
  );

  it.each(['SIMDEVICE_CONNECTION_STRING', 'ACCEPTANCE_SIM_DEVICE_ID', 'ACCEPTANCE_SIMDEVICE_BIN'])(
    '(e) fails at once naming %s when it is missing',
    async name => {
      stub = await startStub();
      for (const value of [undefined, '  ']) {
        const result = await run({
          ACCEPTANCE_BASE_URL: stub.baseUrl,
          ACCEPTANCE_BEARER_TOKEN: TOKEN,
          ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
          ...simEnv(),
          [name]: value,
        });

        expect(result.exitCode).toBe(2);
        expect(result.failures).toEqual([
          `acceptance: ${name} is not set; the live acceptance run needs it`,
        ]);
      }
      // Nothing ran: no request, no simdevice.
      expect(stub.requests).toHaveLength(0);
    }
  );

  it('(f) fails when the simulated device is registered to someone else (409 then 404)', async () => {
    const result = await runAgainstStub({ simOwnedByOther: true });

    expect(result.exitCode).not.toBe(0);
    const failures = telemetryFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('POST /devices registers the simulated device to the caller');
    expect(failures[0]).toContain('GET /devices/{id} → 404');
    expect(failures[0]).toContain('not to the caller');
    // simdevice was never run for someone else's device.
    expect(result.output).not.toMatch(/^\s+EXEC\s/m);
  });
});

describe('signalr live temperature (HAR-63, against the stub and a fake simdevice)', () => {
  const GROUP = 'signalr live temperature ›';
  const STEPS = [
    'POST /devices registers the simulated device to the caller',
    'POST /negotiate returns 200 and a SignalR client listening for temperature connects',
    'simdevice --count 1 sends one reading through IoT Hub',
    'the sent reading arrives on target temperature, with enqueuedTimeUtc and no other field',
    'the SignalR connection stops',
  ];
  const liveFailures = (result: Run) =>
    result.failures.filter(line => line.startsWith(`FAIL ${GROUP}`));
  /** Every SignalR connection the run opened was closed again (a DELETE each). */
  const expectEveryConnectionStopped = () => {
    const calls = stub!.signalRRequests.map(r => `${r.method} ${r.path.split('?')[0]}`);
    const opened = calls.filter(call => call === 'POST /client/negotiate').length;
    expect(opened).toBeGreaterThan(0);
    expect(calls.filter(call => call === 'DELETE /client/')).toHaveLength(opened);
  };

  it('(a) passes when the sent reading is pushed after replayed and other-device messages, and prints METRIC signalr-delivery-ms', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    STEPS.forEach(step => expect(result.lines).toContain(`PASS ${GROUP} ${step}`));
    const metrics = result.lines.filter(line => line.startsWith('METRIC signalr-delivery-ms '));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatch(/^METRIC signalr-delivery-ms \d+$/);
    // HAR-67: the isolation group's send reached its owner connection only
    // (not the peer's). Then the reading went to the one open connection, the
    // proof's own; the round trip's later send found none open.
    expect(stub!.livePushes).toEqual([1, 1, 0]);
    // Registration came before negotiate, so the group membership includes it.
    const label = (step: number) => result.lines.indexOf(`RUN  ${GROUP} ${STEPS[step]}`);
    const negotiate = result.lines.findIndex(
      (line, i) => i > label(1) && /^\s+POST\s+\/negotiate\s+200\s/.test(line)
    );
    expect(label(0)).toBeLessThan(label(1));
    expect(negotiate).toBeLessThan(label(2));
    expectEveryConnectionStopped();
    expect(result.output).not.toContain(SIGNALR_CLIENT_TOKEN);
    expect(result.output).not.toContain('/client/');
  });

  it('(a) matches the sent timestamp as an instant: printed …33.120Z, pushed …33.12Z', async () => {
    const result = await runAgainstStub({ simServedTimestamp: '2026-11-19T16:47:33.12Z' });

    expect(result.failures).toEqual([]);
    expect(result.lines).toContain(`PASS ${GROUP} ${STEPS[3]}`);
  });

  it('(b) fails naming the cap and what did arrive when the reading is never pushed, and stops the connection', async () => {
    const result = await runAgainstStub({ livePush: 'never' });

    expect(result.exitCode).not.toBe(0);
    const failures = liveFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`FAIL ${GROUP} ${STEPS[3]}`);
    expect(failures[0]).toContain(`connected and sent (timestamp ${SIM_TIMESTAMP}, sentAt `);
    expect(failures[0]).toContain(
      `nothing within the ${LIVE_WAIT.capMs / 1000} s cap; the connection is Connected`
    );
    // The replayed reading and the other device's were seen and passed over.
    expect(failures[0]).toContain(
      `Received 2 temperature message(s), 1 for ${SIM_DEVICE}, last timestamp "${OLDER_READINGS[0]}"`
    );
    expect(result.output).toContain(`SKIP ${GROUP} ${STEPS[4]}`);
    expect(result.output).not.toMatch(/^METRIC signalr-delivery-ms /m);
    expectEveryConnectionStopped();
    // Only this group and the isolation group (whose owner waits for the same
    // push) failed.
    expect(result.failures.filter(line => !line.startsWith('FAIL signalr isolation ›'))).toEqual(
      failures
    );
  });

  it.each([
    ['extra-field', 'field(s) toTemperatureReading does not produce: iothub_name'],
    ['no-enqueued', 'the reading arrived without a date enqueuedTimeUtc (undefined)'],
  ] as const)(
    '(c) fails when the pushed reading is %s, and stops the connection',
    async (push, message) => {
      const result = await runAgainstStub({ livePush: push });

      const failures = liveFailures(result);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(`FAIL ${GROUP} ${STEPS[3]}`);
      expect(failures[0]).toContain(message);
      expect(result.output).not.toMatch(/^METRIC signalr-delivery-ms /m);
      expectEveryConnectionStopped();
    }
  );

  it('(d) fails at the send when simdevice exits 1, and stops the connection', async () => {
    const result = await runAgainstStub({}, 'exit1');

    const failures = liveFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`FAIL ${GROUP} ${STEPS[2]}`);
    expect(failures[0]).toContain('simdevice → exit 1');
    expect(result.output).toContain(`SKIP ${GROUP} ${STEPS[3]}`);
    expectEveryConnectionStopped();
  });
});

describe('device twin (HAR-68, against the stub and a fake simdevice)', () => {
  const GROUP = 'device twin ›';
  const STEPS = [
    'POST /devices registers the simulated device to the owner',
    'any cook already active on the simulated device is stopped',
    'POST /cooks with X-Request-ID acceptance-twin-<runId> starts a cook on the simulated device: 201',
    'simdevice --twin --count 1 reconnects: the twin carries the cook and the device reports it applied',
    'GET /temperatures/current/{deviceId} returns the reading just sent, tagged with the cook',
    'POST /cooks/{cookId}/stop stops the cook: 200',
    'simdevice --twin --count 0 reconnects: the twin has no cook and the device reports it applied',
    'no cook is left active on the simulated device',
  ];
  const CLEANUP = STEPS[STEPS.length - 1];
  const runTwin = (options: StubOptions = {}, mode: FakeMode = 'ok') =>
    runAgainstStub(options, mode, [twinGroup]);
  const runIdOf = (result: Run) =>
    /^acceptance run (\S+) against /.exec(result.lines[0] ?? '')?.[1] ?? '(none)';
  /** The failed step, the cleanup PASSed after it, and every step between SKIPped. */
  const expectFailedAt = (result: Run, step: number, message: string) => {
    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(`FAIL ${GROUP} ${STEPS[step]}`);
    expect(result.failures[0]).toContain(message);
    STEPS.slice(step + 1, -1).forEach(skipped =>
      expect(result.lines).toContain(
        `SKIP ${GROUP} ${skipped} (an earlier proof in this group failed)`
      )
    );
    expect(result.lines).toContain(`PASS ${GROUP} ${CLEANUP}`);
    // The cleanup left no cook active on the simulated device.
    expect(stub!.simCooks().length).toBeGreaterThan(0);
    expect(stub!.simCooks().every(c => c.status === 'completed')).toBe(true);
  };

  it('(a) passes: the started cook reaches the twin and the reading, the stop clears it; prints METRIC twin-apply-ms', async () => {
    const result = await runTwin();

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    STEPS.forEach(step => expect(result.lines).toContain(`PASS ${GROUP} ${step}`));
    const metrics = result.lines.filter(line => line.startsWith('METRIC twin-apply-ms '));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatch(/^METRIC twin-apply-ms \d+$/);
    // The start carried the run's X-Request-ID, which became the correlation id.
    const starts = stub!.requests.filter(r => r.method === 'POST' && r.path === '/api/cooks');
    expect(starts).toEqual([
      expect.objectContaining({ requestId: `acceptance-twin-${runIdOf(result)}` }),
    ]);
    // Two reconnects, with simdevice's real flag syntax.
    expect(stub!.twinRuns).toEqual([
      ['--twin', '--count', '1', '--timeout', '60s'],
      ['--twin', '--count', '0', '--timeout', '60s'],
    ]);
    expect(stub!.simCooks()).toHaveLength(1);
    expect(stub!.simCooks()[0].status).toBe('completed');
    expect(result.output).not.toContain(TOKEN);
    expect(result.output).not.toContain(SIM_KEY);
  });

  it('(a) stops a cook an earlier run left active on the simulated device before starting its own', async () => {
    const result = await runTwin({ simActiveCook: true });

    expect(result.failures).toEqual([]);
    const stops = stub!.requests.filter(r => r.method === 'POST' && r.path.endsWith('/stop'));
    expect(stops[0]?.path).toBe(`/api/cooks/${STALE_COOK_ID}/stop`);
    expect(stops).toHaveLength(2);
    expect(stub!.simCooks().every(c => c.status === 'completed')).toBe(true);
  });

  it('(b) fails when the twin desired activeCookId is not the new cook, and still stops the cook', async () => {
    const result = await runTwin({ twinFault: 'desired-cook' });

    expectFailedAt(result, 3, 'simdevice → exit 0: desired.activeCookId is "');
    expect(result.failures[0]).toMatch(/not the new cook [0-9a-f-]{36}$/);
    expect(result.lines.some(line => line.startsWith('METRIC twin-apply-ms'))).toBe(false);
  });

  it('(b) fails when reported.appliedDesiredVersion is not desired.$version, and still stops the cook', async () => {
    const result = await runTwin({ twinFault: 'reported-version' });

    expectFailedAt(
      result,
      3,
      'reported.appliedDesiredVersion is 1, not desired.$version 2: the device did not ' +
        'report applying the current desired state'
    );
  });

  it('(b) fails on a 503 DEVICE_TWIN_UPDATE_FAILED start, printing its reason, and still stops the saved cook', async () => {
    const result = await runTwin({ twinUpdateFails: true });

    expectFailedAt(
      result,
      2,
      `POST /cooks → 503: DEVICE_TWIN_UPDATE_FAILED, reason ${TWIN_FAILURE_REASON}: the cook ` +
        'was saved but the device twin was not updated'
    );
    expect(stub!.twinRuns).toEqual([]);
  });

  it('(c) fails with the exit code when simdevice exits 1, and still stops the cook', async () => {
    const result = await runTwin({}, 'exit1');

    expectFailedAt(
      result,
      3,
      'simdevice → exit 1: simdevice exited 1, expected 0: send failed: connection refused'
    );
  });
});

describe('signalr isolation (HAR-67, against the stub and a fake simdevice)', () => {
  const GROUP = 'signalr isolation ›';
  const STEPS = [
    'POST /devices registers the simulated device to the owner',
    'the owner negotiates and connects, listening for temperature, cook_started and cook_stopped',
    'the peer: POST /negotiate?deviceId=<simulated device> returns 200 and its client connects',
    'the peer: GET /temperatures/current/<simulated device> is 404 DEVICE_NOT_FOUND',
    'the peer: POST /cooks on the simulated device is 403 DEVICE_NOT_OWNED',
    'simdevice --count 1 sends one reading through IoT Hub',
    'the owner receives the reading on temperature; the peer receives nothing in the grace window',
    'the owner stops any cook already active on the simulated device',
    'POST /cooks as the owner starts a cook on the simulated device and cook_started reaches the owner',
    'POST /cooks/{cookId}/stop stops it, cook_stopped reaches the owner, and the peer has received nothing',
    'both SignalR connections stop',
  ];
  const isolationFailures = (result: Run) =>
    result.failures.filter(line => line.startsWith(`FAIL ${GROUP}`));
  const metric = (result: Run, name: string) =>
    result.lines.filter(line => line.startsWith(`METRIC ${name} `));
  /** The isolation group's two connections, in the order the stub opened them:
   *  the first two `POST /client/negotiate` calls of the run. */
  const isolationConnections = () =>
    stub!.signalRRequests.filter(
      r => r.method === 'POST' && r.path.startsWith('/client/negotiate')
    );
  /** Every SignalR connection the run opened was closed again (a DELETE each). */
  const expectEveryConnectionStopped = () => {
    const calls = stub!.signalRRequests.map(r => `${r.method} ${r.path.split('?')[0]}`);
    const opened = calls.filter(call => call === 'POST /client/negotiate').length;
    expect(opened).toBeGreaterThan(0);
    expect(calls.filter(call => call === 'DELETE /client/')).toHaveLength(opened);
  };

  it('(a) passes: the owner gets the reading and both cook events, the peer nothing; prints both metrics', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    STEPS.forEach(step => expect(result.lines).toContain(`PASS ${GROUP} ${step}`));
    expect(metric(result, 'isolation-peer-messages')).toEqual(['METRIC isolation-peer-messages 0']);
    const cookMetric = metric(result, 'signalr-cook-event-ms');
    expect(cookMetric).toHaveLength(1);
    expect(cookMetric[0]).toMatch(/^METRIC signalr-cook-event-ms \d+$/);

    // The peer negotiated with the simulated device in the query, with its own
    // token, and got its own SignalR token.
    const peerNegotiate = stub!.requests.filter(
      r => r.method === 'POST' && r.path.startsWith('/api/negotiate')
    );
    expect(peerNegotiate.map(r => [r.path, r.authorization])).toContainEqual([
      `/api/negotiate?deviceId=${SIM_DEVICE}`,
      `Bearer ${PEER_TOKEN}`,
    ]);
    const [ownerConn, peerConn] = isolationConnections();
    expect(ownerConn.authorization).toBe(`Bearer ${SIGNALR_CLIENT_TOKEN}`);
    expect(peerConn.authorization).toBe(`Bearer ${PEER_SIGNALR_CLIENT_TOKEN}`);
    // The peer's two refused calls are labelled as the peer's.
    expect(
      result.lines.some(line =>
        /^\s+GET\s+\/temperatures\/current\/\{deviceId\} \(peer\)\s+404\s/.test(line)
      )
    ).toBe(true);
    expect(result.lines.some(line => /^\s+POST\s+\/cooks \(peer\)\s+403\s/.test(line))).toBe(true);
    expect(summaryRow(result.output, 'POST /cooks (peer)')).toMatch(/11\.43\s*$/);
    // The cook events went to the owner's one connection each.
    const isolationCooks = stub!.cookPushes.filter(p => p.connections > 0);
    expect(isolationCooks.map(p => p.target)).toEqual(['cook_started', 'cook_stopped']);
    expect(isolationCooks.every(p => p.connections === 1)).toBe(true);
    expect(stub!.simCooks().every(c => c.status === 'completed')).toBe(true);
    expectEveryConnectionStopped();
    for (const secret of [SIGNALR_CLIENT_TOKEN, PEER_SIGNALR_CLIENT_TOKEN, TOKEN, PEER_TOKEN]) {
      expect(result.output).not.toContain(secret);
    }
    expect(result.output).not.toContain('/client/');
  });

  it('(a) stops a cook an earlier run left active on the simulated device before starting its own', async () => {
    // Only this group: the device twin group runs earlier and would stop it first.
    const result = await runAgainstStub({ simActiveCook: true }, 'ok', [isolationGroup]);

    expect(result.failures).toEqual([]);
    expect(
      stub!.requests.some(r => r.method === 'POST' && r.path === `/api/cooks/${STALE_COOK_ID}/stop`)
    ).toBe(true);
    expect(stub!.simCooks()).toHaveLength(2);
    expect(stub!.simCooks().every(c => c.status === 'completed')).toBe(true);
  });

  it('(b) fails naming the target when a temperature reaches the peer, and stops both connections', async () => {
    const result = await runAgainstStub({ peerLeak: 'temperature' });

    expect(result.exitCode).not.toBe(0);
    const failures = isolationFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`FAIL ${GROUP} ${STEPS[6]}`);
    expect(failures[0]).toContain(
      `LEAK: the peer, who does not own ${SIM_DEVICE}, received 3 message(s) by the reading`
    );
    // The replayed reading, the other device's and the sent one: all on temperature.
    expect(failures[0]).toContain(': temperature ×3');
    expect(metric(result, 'isolation-peer-messages')).toEqual(['METRIC isolation-peer-messages 3']);
    expect(metric(result, 'signalr-cook-event-ms')).toEqual([]);
    STEPS.slice(7).forEach(step => expect(result.output).toContain(`SKIP ${GROUP} ${step}`));
    expectEveryConnectionStopped();
    // Only this group failed: the other groups' connections are the owner's.
    expect(result.failures).toEqual(failures);
  });

  it('(b) fails naming the target when cook_started reaches the peer', async () => {
    const result = await runAgainstStub({ peerLeak: 'cook_started' });

    const failures = isolationFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`FAIL ${GROUP} ${STEPS[9]}`);
    expect(failures[0]).toContain('received 1 message(s) by cook_stopped');
    expect(failures[0]).toContain(': cook_started ×1');
    expect(metric(result, 'isolation-peer-messages')).toEqual(['METRIC isolation-peer-messages 1']);
    expect(result.output).toContain(`SKIP ${GROUP} ${STEPS[10]}`);
    expectEveryConnectionStopped();
  });

  it('(b) fails naming the cap when the reading never reaches the owner, and stops both connections', async () => {
    const result = await runAgainstStub({ livePush: 'never' });

    const failures = isolationFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`FAIL ${GROUP} ${STEPS[6]}`);
    expect(failures[0]).toContain(
      `nothing within the ${ISOLATION_WAIT.capMs / 1000} s cap; the owner connection is Connected`
    );
    expect(failures[0]).toContain('The owner received 2 message(s) (temperature ×2)');
    expect(metric(result, 'isolation-peer-messages')).toEqual([]);
    expectEveryConnectionStopped();
  });

  it('(b) fails when the peer is not refused POST /cooks, before any reading is sent', async () => {
    const result = await runAgainstStub({ allowAnyDevice: true });

    const failures = isolationFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`FAIL ${GROUP} ${STEPS[4]}`);
    expect(failures[0]).toContain('POST /cooks (peer) → 201: expected 403');
    expect(result.output).toContain(`SKIP ${GROUP} ${STEPS[5]}`);
    expectEveryConnectionStopped();
  });
});

describe('telemetry volume (HAR-45, HAR-75, against the stub and a fake simdevice)', () => {
  const GROUP = 'telemetry volume ›';
  const STEPS = [
    'GET /temperatures/history walks the simulated device page by page',
    'simdevice tops the volume up to one long cook when it is short',
    'GET /temperatures/current/{deviceId} shows the end of the top-up',
    'GET /temperatures/history walked again: the last page costs at most 1.5 × the first',
  ];
  const volumeFailures = (result: Run) =>
    result.failures.filter(line => line.startsWith(`FAIL ${GROUP}`));
  const metric = (result: Run, name: string) =>
    result.lines.filter(line => line.startsWith(`METRIC ${name} `));
  /** The volume group's history reads of the simulated device (no window), as
   *  their query after the deviceId. */
  const volumeReads = () =>
    stub!.requests
      .filter(r => r.path.startsWith(`/api/temperatures/history?deviceId=${SIM_DEVICE}`))
      .map(r => new URL(r.path, 'http://stub').searchParams)
      .filter(params => !params.has('startTime'))
      .map(params => params.toString().replace(/^deviceId=[^&]+&?/, ''));
  /** One walk of `readings` at the self-test's page size, as volumeReads shows it. */
  const walk = (readings: number) =>
    Array.from({ length: Math.max(1, Math.ceil(readings / VOLUME.pageLimit)) }, (_, page) =>
      page === 0
        ? `limit=${VOLUME.pageLimit}`
        : `limit=${VOLUME.pageLimit}&continuationToken=v-${page * VOLUME.pageLimit}`
    );

  it('(a) walks twice without a top-up when the volume is already at the target', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    STEPS.forEach(step => expect(result.lines).toContain(`PASS ${GROUP} ${step}`));
    // No simdevice top-up: the only sends are the isolation proof's (HAR-67),
    // the live push's (HAR-63) and the round trip's, one reading each, besides
    // the twin group's two reconnects (HAR-68).
    expect(stub!.topups).toEqual([]);
    const execs = result.lines.filter(line => /^\s+EXEC\s/.test(line));
    const sends = execs.filter(line => !/^\s+EXEC\s+simdevice --twin\s/.test(line));
    expect(execs).toHaveLength(sends.length + 2);
    expect(sends).toHaveLength(3);
    sends.forEach(line => expect(line).toMatch(/^\s+EXEC\s+simdevice --count 1\s/));
    // Two walks, page by page by continuation token: never an offset, never a total.
    const pages = walk(VOLUME.target);
    expect(pages.length).toBeGreaterThan(1);
    expect(volumeReads()).toEqual([...pages, ...pages]);
    expect(stub!.drainTotals).toEqual([]);
    expect(metric(result, 'history-readings-before')).toEqual([
      `METRIC history-readings-before ${VOLUME.target}`,
    ]);
    expect(metric(result, 'topup-sent')).toEqual(['METRIC topup-sent 0']);
    expect(metric(result, 'history-readings')).toEqual([
      `METRIC history-readings ${VOLUME.target}`,
    ]);
    expect(metric(result, 'history-pages')).toEqual([`METRIC history-pages ${pages.length}`]);
    // The stub charges 7.71 RU for every history page.
    for (const name of ['history-ru-first-page', 'history-ru-last-page']) {
      expect(metric(result, name)).toEqual([`METRIC ${name} 7.71`]);
    }
    expect(result.output).not.toMatch(/^METRIC history-(total|ru-max-page|max-page)/m);
  });

  it('(b) tops up a short volume, waits for its end in the current reading, then walks again', async () => {
    const before = 40;
    const count = VOLUME.target - before + VOLUME.margin;
    const result = await runAgainstStub({ simVolume: before, simDrainPerPoll: 80 });

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    STEPS.forEach(step => expect(result.lines).toContain(`PASS ${GROUP} ${step}`));
    expect(stub!.topups).toEqual([
      ['--count', String(count), '--inflight', '32', '--interval', '50ms'],
    ]);
    expect(
      result.lines.some(line =>
        new RegExp(
          `^\\s+EXEC\\s+simdevice --count ${count} --inflight 32 --interval 50ms\\s+exit 0\\s.*${count} message`
        ).test(line)
      )
    ).toBe(true);
    expect(metric(result, 'history-readings-before')).toEqual([
      `METRIC history-readings-before ${before}`,
    ]);
    expect(metric(result, 'topup-sent')).toEqual([`METRIC topup-sent ${count}`]);
    expect(metric(result, 'topup-ms')).toHaveLength(1);
    expect(metric(result, 'topup-ms')[0]).toMatch(/^METRIC topup-ms \d+$/);
    // The current reading was polled, 80 readings routed a poll, until it
    // showed the top-up's end; then the measuring walk saw all of it.
    expect(stub!.drainTotals).toEqual([120, 200, before + count]);
    expect(volumeReads()).toEqual([...walk(before), ...walk(before + count)]);
    expect(metric(result, 'history-readings')).toEqual([
      `METRIC history-readings ${before + count}`,
    ]);
    expect(metric(result, 'history-pages')).toEqual([
      `METRIC history-pages ${walk(before + count).length}`,
    ]);
    expect(metric(result, 'history-ru-first-page')).toHaveLength(1);
    expect(metric(result, 'history-ru-last-page')).toHaveLength(1);
  });

  it('(c) fails naming the cap when the top-up never reaches the current reading', async () => {
    const result = await runAgainstStub({ simVolume: 40, simTopupNeverRouted: true });

    expect(result.exitCode).not.toBe(0);
    const failures = volumeFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`${GROUP} ${STEPS[2]}`);
    expect(failures[0]).toContain('GET /temperatures/current/{deviceId} → 200');
    expect(failures[0]).toContain(
      `the current reading is "${SIM_TIMESTAMP}", before the top-up's end`
    );
    expect(failures[0]).toContain(`after the ${VOLUME.pollCapMs / 1000} s cap`);
    expect(stub!.drainTotals.length).toBeGreaterThan(2);
    expect(result.output).toContain(`SKIP ${GROUP} ${STEPS[3]}`);
    expect(result.output).not.toMatch(/^METRIC history-(readings|pages|ru-[a-z-]+) /m);
    // Only this group failed.
    expect(result.failures).toEqual(failures);
  });

  it('(d) fails with the exit code when simdevice exits 1 during the top-up', async () => {
    const result = await runAgainstStub({ simVolume: 40 }, 'topup-exit1');

    expect(result.exitCode).not.toBe(0);
    const failures = volumeFailures(result);
    expect(failures).toHaveLength(1);
    expect(result.failures).toEqual(failures);
    expect(failures[0]).toContain(`${GROUP} ${STEPS[1]}`);
    expect(failures[0]).toContain('simdevice → exit 1');
    expect(failures[0]).toContain(
      `simdevice exited 1, expected 0 (0 of ${VOLUME.target - 40 + VOLUME.margin} message(s) sent): ` +
        `send reading 3 of ${VOLUME.target - 40 + VOLUME.margin}: connection lost`
    );
    expect(result.output).not.toContain('more detail');
    expect(result.output).toContain(`SKIP ${GROUP} ${STEPS[2]}`);
    expect(result.output).not.toMatch(/^METRIC (topup-sent|history-readings|history-pages) /m);
  });

  it.each([
    ['11.56', true],
    ['11.57', false],
  ])(
    '(f) HAR-75: a last page of %s RU against a first of 7.71 passes: %s (the bound is 1.5 ×)',
    async (deep, passes) => {
      const result = await runAgainstStub({ simDeepPageCharge: deep });

      expect(metric(result, 'history-ru-first-page')).toEqual([
        'METRIC history-ru-first-page 7.71',
      ]);
      expect(metric(result, 'history-ru-last-page')).toEqual([
        `METRIC history-ru-last-page ${deep}`,
      ]);
      const failures = volumeFailures(result);
      if (passes) {
        expect(result.failures).toEqual([]);
      } else {
        expect(result.failures).toEqual(failures);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain(`${GROUP} ${STEPS[3]}`);
        expect(failures[0]).toContain(
          `the last page (page ${walk(VOLUME.target).length}) cost ${deep} RU, more than 1.5 × ` +
            "the first page's 7.71 RU"
        );
      }
    }
  );

  it('(g) HAR-75: the drain point is the top-up reading `inflight` places from the end', () => {
    const at = (i: number) => TOPUP_EPOCH + i * 50;
    const sent = Array.from({ length: 100 }, (_, i) => at(i)).reverse();
    expect(topupDrainedAt(sent, 32)).toBe(at(68));
    expect(topupDrainedAt(sent, 1)).toBe(at(99));
    expect(topupDrainedAt([at(0), at(1)], 32)).toBe(at(0));
  });

  it('(e) kills the top-up at count × 50 ms × 1.5 + 120 s, with 32 sends in flight', async () => {
    const before = 40;
    const count = VOLUME.target - before + VOLUME.margin;
    stub = await startStub({ simVolume: before, simDrainPerPoll: 1_000 });
    const calls: { args: readonly string[]; options?: SimDeviceOptions }[] = [];
    // The real volume proofs, handed an api whose runSimDevice is recorded,
    // after the round trip that registers the device (as in a full run).
    const recorded = {
      name: volumeGroup.name,
      create: () =>
        volumeGroup.create().map(proof => ({
          name: proof.name,
          run: (api: AcceptanceApi) =>
            proof.run(
              Object.assign(Object.create(api) as AcceptanceApi, {
                runSimDevice(args: readonly string[], options?: SimDeviceOptions) {
                  calls.push({ args, options });
                  return api.runSimDevice(args, options);
                },
              })
            ),
        })),
    };
    const lines: string[] = [];
    const result = await runAcceptance({
      env: {
        ACCEPTANCE_BASE_URL: stub.baseUrl,
        ACCEPTANCE_BEARER_TOKEN: TOKEN,
        ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
        ...simEnv(),
      },
      write: line => lines.push(line),
      groups: [roundtripGroup, recorded],
    });

    expect(result.failures).toEqual([]);
    expect(lines).toContain(`METRIC topup-sent ${count}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      '--count',
      String(count),
      '--inflight',
      '32',
      '--interval',
      '50ms',
    ]);
    expect(calls[0].options?.timeoutMs).toBe(count * 50 * 1.5 + 120_000);
  });

  it('runSimDevice kills a run that outlasts the time limit the proof passes', async () => {
    stub = await startStub();
    const lines: string[] = [];
    let exitCode: number | null | undefined;
    const result = await runAcceptance({
      env: {
        ACCEPTANCE_BASE_URL: stub.baseUrl,
        ACCEPTANCE_BEARER_TOKEN: TOKEN,
        ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
        ...simEnv('hang'),
      },
      write: line => lines.push(line),
      groups: [
        {
          name: 'slow simdevice',
          create: () => [
            {
              name: 'a hung simdevice is killed at the limit',
              run: async api => {
                ({ exitCode } = await api.runSimDevice(['--count', '1'], { timeoutMs: 200 }));
              },
            },
          ],
        },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(exitCode).toBeNull();
    expect(lines.some(line => /^\s+EXEC\s+simdevice --count 1\s+exit killed\s/.test(line))).toBe(
      true
    );
  });
});
