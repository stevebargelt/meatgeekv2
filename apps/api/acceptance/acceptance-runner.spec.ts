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
 *
 * HAR-87: the chart device (HAR-84) is configured in every whole-suite run. By
 * default the stub starts with it registered and a standing active cook on it
 * whose chart is covered, the steady state live; `chartCook` starts it with no
 * cook (a first run) or an uncovered one. A fake chart top-up (`--start …
 * --step 5s`) is reported to the stub, which covers that cook's chart after a
 * few chart reads.
 *
 * HAR-120: nothing here waits on real time. Every wait in the proofs and the
 * runner goes through ../lib/clock, and each test runs on a {@link FakeClock}:
 * a proof's `sleep` (a poll interval, a retry delay, the grace window, the
 * rest of a cap) ends once the stub has answered everything it was sent and
 * every SignalR client has taken what was pushed to it (`stub.settled()`), and
 * then moves the fake time on by exactly that long. A deadline racing a real
 * event (`within`, the per-request limit, the simdevice kill) fires only when
 * the fake time reaches it, which a test does on purpose with `advance`. So
 * the live intervals, caps and messages are exercised as they are, and the
 * result does not depend on how fast the machine is. The stub has no timers of
 * its own: a held SignalR poll is answered by the next message, the next poll
 * or the stub closing, and a sent reading is pushed when the fake simdevice
 * reports it.
 *
 * HAR-138: DPS mode. The env a simdevice child gets is read off the `spawn`
 * call itself (a pass-through spy); `readClaimCode` runs fake claim-code
 * scripts, and its 30 s kill fires only on the fake clock.
 */
import { randomUUID } from 'crypto';
import { EventEmitter, once } from 'events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { PassThrough } from 'stream';

import { REQUEST_CHARGE_HEADER } from '../src/shared/cosmos/request-charge';
import { DEFAULT_USER_PREFERENCES } from '../src/shared/cosmos/users-repository';
import { ClaimCodeError, readClaimCode } from './lib/claim-code';
import type { Clock } from './lib/clock';
import { setClock } from './lib/clock';
import { Contract } from './lib/contract';
import type { AcceptanceApi, ProofGroup, SimDeviceOptions } from './lib/proof';
import { ProofFailure } from './lib/proof';
import { makeRedactor, runAcceptance, RunResult } from './lib/runner';
import {
  CONNECT_TIMEOUT_MS,
  expectHubMessage,
  START_RETRY,
  startConnection,
  within,
} from './lib/signalr';
import type { ChildProcess, Spawn } from './lib/spawn';
import { realSpawn, setSpawn } from './lib/spawn';
import sweepGroup from './proofs/acceptance-device-sweep.proof';
import claimGroup from './proofs/device-claim.proof';
import releaseGroup, { RELEASE_WAIT } from './proofs/device-release.proof';
import revokeGroup, { REVOKED_SEND_KILL_MS } from './proofs/device-revoke.proof';
import twinGroup, { TWIN_POLL } from './proofs/device-twin.proof';
import isolationGroup, { ISOLATION_WAIT } from './proofs/signalr-isolation.proof';
import liveGroup, { LIVE_WAIT } from './proofs/signalr-live-temperature.proof';
import roundtripGroup, { ROUNDTRIP_POLL } from './proofs/telemetry-roundtrip.proof';
import volumeGroup, { topupDrainedAt, VOLUME } from './proofs/telemetry-volume.proof';
import temperaturesGroup from './proofs/temperatures.proof';
import usersGroup from './proofs/users.proof';
import chartGroup, {
  CHART,
  CHART_RU_BUDGET,
  chartCoverage,
} from './proofs/volume-cook-chart.proof';

/**
 * HAR-120: the clock every test runs on. Time stands still unless a proof
 * sleeps or a test calls {@link FakeClock.advance}.
 *
 * - `sleep(ms)` first waits for {@link FakeClock.settle} (the stub's
 *   `settled()`: no request unanswered, nothing pushed that a SignalR client
 *   has not taken), then moves the time to its end, firing every timer due by
 *   then in order. An aborted sleep never moves the time.
 * - `after(ms, fire)` fires only when the time reaches it: through a sleep, or
 *   a test's `advance`.
 *
 * `slept` lists each sleep that ran to its end, so a test can check the exact
 * intervals a proof waited.
 */
class FakeClock implements Clock {
  /** When every test's fake time starts: a fixed instant, never the wall clock. */
  static readonly EPOCH = Date.UTC(2026, 10, 19, 17, 0, 0);
  private time = FakeClock.EPOCH;
  private sequence = 0;
  private readonly timers: Array<{
    readonly due: number;
    readonly ms: number;
    readonly seq: number;
    readonly fire: () => void;
    readonly deadline: boolean;
  }> = [];
  private readonly armedWaiters: Array<{ ms: number; resolve: () => void }> = [];
  /** What a sleep waits for before the time moves. */
  settle: () => Promise<void> = () => Promise.resolve();
  readonly slept: number[] = [];

  now(): number {
    return this.time;
  }

  monotonic(): number {
    return this.time - FakeClock.EPOCH;
  }

  after(ms: number, fire: () => void): () => void {
    const cancel = this.add(ms, fire, true);
    for (const waiter of this.armedWaiters.filter(w => w.ms === ms)) {
      this.armedWaiters.splice(this.armedWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    return cancel;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const due = this.time + ms;
    await new Promise<void>(resolve => {
      const cancel = this.add(
        ms,
        () => {
          this.slept.push(ms);
          resolve();
        },
        false
      );
      signal?.addEventListener(
        'abort',
        () => {
          cancel();
          resolve();
        },
        { once: true }
      );
      void this.settle().then(() => {
        if (!signal?.aborted) this.advanceTo(due);
      });
    });
  }

  /** Move the time on by `ms`, firing every timer due by then, in order. */
  advance(ms: number): void {
    this.advanceTo(this.time + ms);
  }

  /** The time left on each pending deadline (`after`), soonest first. */
  deadlines(): number[] {
    return this.timers.filter(t => t.deadline).map(t => t.due - this.time);
  }

  /** Resolves once a deadline of exactly `ms` is pending (now or later). */
  armed(ms: number): Promise<void> {
    if (this.timers.some(t => t.deadline && t.ms === ms)) return Promise.resolve();
    return new Promise(resolve => this.armedWaiters.push({ ms, resolve }));
  }

  private add(ms: number, fire: () => void, deadline: boolean): () => void {
    const timer = { due: this.time + ms, ms, seq: this.sequence++, fire, deadline };
    this.timers.push(timer);
    this.timers.sort((a, b) => a.due - b.due || a.seq - b.seq);
    return () => {
      const at = this.timers.indexOf(timer);
      if (at >= 0) this.timers.splice(at, 1);
    };
  }

  private advanceTo(target: number): void {
    while (this.timers.length > 0 && this.timers[0].due <= target) {
      const timer = this.timers.shift()!;
      this.time = Math.max(this.time, timer.due);
      timer.fire();
    }
    this.time = Math.max(this.time, target);
  }
}

let fakeClock: FakeClock;
let restoreClock: (() => void) | undefined;

/** Let every callback already queued run (no time passes on any clock). */
const drainEvents = () => new Promise<void>(resolve => setImmediate(resolve));

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

/** HAR-84: the second standing device, and its credential. */
const CHART_DEVICE = `${SIM_DEVICE}-chart`;
const CHART_KEY = 'Y2hhcnQtZGV2aWNlLWtleS1mb3ItdGVzdHMtb25seQ==';
const CHART_CONNECTION_STRING = `HostName=stub-hub.azure-devices.net;DeviceId=${CHART_DEVICE};SharedAccessKey=${CHART_KEY}`;
const chartEnv = {
  ACCEPTANCE_CHART_DEVICE_ID: CHART_DEVICE,
  SIMDEVICE_CHART_CONNECTION_STRING: CHART_CONNECTION_STRING,
};
/** HAR-87: the standing chart cook an earlier run started. */
const STANDING_CHART_COOK_ID = '6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
const STANDING_CHART_START = '2026-11-01T06:00:07.250Z';

type FakeMode = 'ok' | 'exit1' | 'topup-exit1' | 'hang' | 'leak-stderr' | 'leak-stdout';

type CookRoute = 'GET /cooks' | 'POST /cooks' | 'POST /cooks/{cookId}/stop';
/** HAR-75: kept out of CookRoute, whose failure tests follow the cook through
 *  every group that starts one. */
type CookItemRoute = 'GET /cooks/{cookId}';
/** HAR-86: the cook chart. */
type CookChartRoute = 'GET /cooks/{cookId}/chart';
type DeviceRoute =
  | 'GET /devices'
  | 'POST /devices'
  | 'POST /devices/claim'
  | 'GET /devices/{id}'
  | 'PATCH /devices/{id}'
  | 'DELETE /devices/{id}';
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
  | CookChartRoute
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
  /** HAR-86: GET /cooks/{cookId}/chart serves the chart to the peer too, or
   *  answers with a body CookChart does not allow. */
  readonly chartFault?: 'peer-reads' | 'bad-body';
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
  /** The simulated device is registered to someone else: the owner does not
   *  hold it (GET 404), and a claim is refused. */
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
  /** HAR-81: POST /negotiate reports this request charge (by default none, as
   *  the API does since it stopped reading devices). */
  readonly negotiateCharge?: string;
  /** HAR-63: what the stub pushes on target `temperature` to each open SignalR
   *  connection after a `--count 1` send. It always pushes a replayed older
   *  reading of the simulated device and the sent timestamp for another device
   *  first; then `deliver` (default) the sent reading, `never` nothing,
   *  `extra-field` the sent reading with an `iothub_name`, `no-enqueued` the
   *  sent reading without `enqueuedTimeUtc`, `wrong-type` (HAR-77) the sent
   *  reading with a string `grillTemp`. */
  readonly livePush?: 'deliver' | 'never' | 'extra-field' | 'no-enqueued' | 'wrong-type';
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
  /** HAR-77: answer this route without the X-Request-ID header. */
  readonly omitRequestIdOn?: StubRoute;
  /** HAR-77: rewrite the body of this route's 2xx answer. */
  readonly alterBody?: { readonly route: StubRoute; readonly alter: (body: unknown) => unknown };
  /** HAR-77: answer a request without a token with this JSON body (the
   *  handler's 401) instead of Easy Auth's empty one. */
  readonly unauthenticatedBody?: unknown;
  /** HAR-77: answer this many of the SignalR client's `POST /client/negotiate`
   *  calls with 429, as the Free_F1 service did live (`Infinity`: all). */
  readonly signalRThrottle?: number;
  /** HAR-87: the chart device's state when the run starts. `covered` (default):
   *  registered, with a standing active cook whose chart covers its readings.
   *  `uncovered`: registered, with a standing cook and no readings. `none`:
   *  not registered and no cook, as before the first run. */
  readonly chartCook?: 'covered' | 'uncovered' | 'none';
  /** HAR-87: the RU the chart device's chart reports (default the route's). */
  readonly chartCharge?: string;
  /** HAR-87: after a chart top-up, the chart is covered from this chart read
   *  on (1-based, default 2). */
  readonly chartCoveredFromRead?: number;
  /** HAR-87: a chart top-up is never rolled up. */
  readonly chartTopupNeverRolledUp?: boolean;
  /** HAR-85: device ids already registered to the owner when the run starts,
   *  as earlier runs left them. */
  readonly devicesAtStart?: readonly string[];
  /** HAR-136: device ids (of `devicesAtStart`) with an owner's cook still
   *  active on them, as a run killed mid-cook leaves them. */
  readonly activeCookAtStartOn?: readonly string[];
  /** HAR-85: DELETE /devices/{id} misbehaves: `peer-deletes` lets the peer
   *  delete the owner's device (204); `keeps` answers the owner 204 but keeps
   *  the device. */
  readonly deviceDeleteFault?: 'peer-deletes' | 'keeps';
  /** HAR-142: a release does not cut the old owner off: a reading from a
   *  device nobody holds is still pushed to the user who last held it. */
  readonly releaseLeaks?: boolean;
  /** HAR-142: revoke-device.sh changes nothing, so the revoked device still
   *  registers and sends. */
  readonly revokeIgnored?: boolean;
  /** HAR-142: a fresh device's reading reaches the hub but is never pushed to
   *  SignalR, for the release proof's released device (`release`) or its
   *  control device (`control`). */
  readonly freshPushDropped?: 'release' | 'control';
  /** HAR-142: the revoked device's send is neither refused nor accepted: its
   *  simdevice never exits. */
  readonly revokedSendHangs?: boolean;
  /** HAR-142: a refusal for an id that was never enrolled says so, an
   *  oracle: `DEVICE_NOT_FOUND` instead of `CLAIM_REFUSED`. */
  readonly claimOracle?: boolean;
  /** HAR-120: the reading a `simdevice --twin --count 1` sends never reaches
   *  the simulated device's current reading. */
  readonly twinReadingNeverRouted?: boolean;
  /** HAR-120: never answer this route (until the stub closes), so the runner's
   *  per-request limit is what ends the request. */
  readonly holdRoute?: StubRoute;
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

/** HAR-142: the userIds the stub stores for the owner and the peer. */
const STUB_OWNER_USER = 'stub-tenant:stub-user';
const STUB_PEER_USER = 'stub-tenant:stub-peer';

interface StubDevice {
  id: string;
  userId: string;
  name: string;
  model: string;
  location?: string;
  isActive: boolean;
  connectionStatus: string;
  /** HAR-140: set on a device claimed through POST /devices/claim. */
  claimedAt?: string;
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
  /** HAR-87: the arguments of each chart top-up the fake simdevice reported. */
  readonly chartTopups: string[][];
  /** HAR-87: the chart device's cooks. */
  readonly chartCooks: () => Array<{ id: string; status: string; startTime: string }>;
  /** HAR-87: whether the chart device is registered. */
  readonly chartRegistered: () => boolean;
  /** HAR-85: the ids of the devices registered now, sorted. */
  readonly deviceIds: () => string[];
  /** HAR-140: each fake device-script run, in order. */
  readonly scriptRuns: Array<{ script: string; args: string[] }>;
  /** HAR-140: the fresh devices with a fake DPS enrollment or hub identity
   *  now, sorted. */
  readonly enrolledIds: () => string[];
  /** HAR-140: every claim code the stub has minted, so a test can check none
   *  reached the output. */
  readonly mintedCodes: string[];
  /** HAR-142: each `simdevice --count 1` a fresh device sent (or tried to),
   *  with the user it was pushed to, if any. */
  /** HAR-142: the revoked device's send never exits, so fresh devices'
   *  sends run as real children, which the runner's kill can end. */
  readonly revokedSendHangs: boolean;
  readonly freshSends: Array<{
    deviceId: string;
    pushedTo?: 'owner' | 'peer';
    refused?: boolean;
    dropped?: boolean;
    hung?: boolean;
  }>;
  /** HAR-142: the fresh devices revoked now, sorted. */
  readonly revokedIds: () => string[];
  /** HAR-120: the fake time at each `simdevice --count 1` report, which the
   *  fake prints as that reading's `sentAt`. */
  readonly sendTimes: number[];
  /** HAR-120: resolves once the stub has nothing outstanding: every API
   *  request it was sent is answered (a `holdRoute` request aside), and every
   *  open SignalR connection has taken all that was pushed to it and is
   *  polling again, so its client has dispatched those messages. Wired to the
   *  fake clock's `settle`. */
  settled(): Promise<void>;
  /** HAR-120: resolves once a request to `holdRoute` has arrived. */
  whenHeld(): Promise<void>;
  /** HAR-142: resolves once the stub has answered a revoked device's send
   *  with "hang" (`revokedSendHangs`), so no request of it is still open. */
  whenSendHung(): Promise<void>;
  close(): Promise<void>;
}

const simReading = (timestamp: string) => ({
  deviceId: SIM_DEVICE,
  timestamp,
  grillTemp: 225.4,
  probe1Temp: 151.2,
  probe2Temp: 149.8,
});

/** The charge each route reports. `POST /negotiate` reads no Cosmos since
 *  HAR-81, so it reports none. */
const RU: Record<Exclude<StubRoute, SignalRRoute>, string> = {
  'GET /cooks': '2.83',
  'POST /cooks': '11.43',
  'POST /cooks/{cookId}/stop': '20.1',
  'GET /cooks/{cookId}': '1.17',
  'GET /cooks/{cookId}/chart': '3.94',
  'GET /devices': '3.11',
  'POST /devices': '9.52',
  'POST /devices/claim': '12.64',
  'GET /devices/{id}': '1',
  'PATCH /devices/{id}': '11.9',
  'DELETE /devices/{id}': '9.71',
  'GET /temperatures/current/{deviceId}': '3.86',
  'GET /temperatures/history': '7.71',
  'PUT /users/me': '14.21',
  'GET /users/me': '3.62',
  'GET /recipes': '2.94',
  'POST /recipes': '10.67',
  'GET /recipes/{id}': '1.02',
  'PATCH /recipes/{id}': '12.38',
  'DELETE /recipes/{id}': '10.29',
};

/** What a route's charge header carries, or `undefined` for none. */
function chargeOf(route: StubRoute): string | undefined {
  return route === 'POST /negotiate' ? undefined : RU[route];
}

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
  for (const id of options.devicesAtStart ?? []) {
    devices.set(id, {
      id,
      userId: 'stub-tenant:stub-user',
      name: `Left by an earlier run: ${id}`,
      model: 'Acceptance Rig',
      isActive: true,
      connectionStatus: 'unknown',
    });
  }
  // HAR-140: the owner holds the standing simulated device, as in dev, unless
  // someone else does. In connection-string mode it shows no claim code, so
  // the suite only checks it is held; in DPS mode it is claimed again.
  if (!options.simOwnedByOther) {
    devices.set(SIM_DEVICE, {
      id: SIM_DEVICE,
      userId: 'stub-tenant:stub-user',
      name: 'Simulated smoker (acceptance)',
      model: 'simdevice',
      isActive: true,
      connectionStatus: 'unknown',
    });
  }
  for (const deviceId of options.activeCookAtStartOn ?? []) {
    cooks.push({
      id: randomUUID(),
      userId: 'stub-tenant:stub-user',
      deviceId,
      name: `Left active by an earlier run on ${deviceId}`,
      status: 'active',
      startTime: '2026-11-18T09:00:00.000Z',
      meatType: 'acceptance',
    });
  }
  // HAR-140: the fresh devices' fake DPS enrollments and hub identities, and
  // the claim code each one shows (minted when it registers, dropped when it
  // is released, as a release raises the claim generation).
  const enrolledIds = new Set<string>([SIM_DEVICE, CHART_DEVICE]);
  const hubIds = new Set<string>();
  const claimCodes = new Map<string, { code: string; consumedBy?: string }>();
  const mintedCodes: string[] = [];
  // HAR-142: revoked fresh devices (their enrollment and identity disabled),
  // who last held each device, and each fresh device's sends.
  const revokedIds = new Set<string>();
  const lastHolder = new Map<string, 'owner' | 'peer'>();
  const freshSends: Stub['freshSends'] = [];
  const scriptRuns: Array<{ script: string; args: string[] }> = [];
  const recipes = new Map<string, Record<string, unknown>>();
  // The acceptance identity's profile persists between runs, as it does in dev.
  let profile: Record<string, unknown> | undefined;
  const requests: Stub['requests'] = [];
  // HAR-87: the chart device and its standing cook, as an earlier run left them.
  const chartCook = options.chartCook ?? 'covered';
  /** The `--start` of the chart readings that are rolled up, as epoch ms. */
  let chartCoveredFrom: number | undefined;
  /** Chart reads left before a pending top-up is rolled up. */
  let chartReadsToCover: number | undefined;
  let chartPendingFrom: number | undefined;
  const chartTopups: string[][] = [];
  if (chartCook !== 'none') {
    devices.set(CHART_DEVICE, {
      id: CHART_DEVICE,
      userId: 'stub-tenant:stub-user',
      name: 'Acceptance chart device',
      model: 'simdevice',
      location: 'CI',
      isActive: true,
      connectionStatus: 'unknown',
    });
    cooks.push({
      id: STANDING_CHART_COOK_ID,
      userId: 'stub-tenant:stub-user',
      deviceId: CHART_DEVICE,
      name: 'acceptance standing chart cook',
      status: 'active',
      startTime: STANDING_CHART_START,
      meatType: 'brisket',
    });
    if (chartCook === 'covered') {
      chartCoveredFrom = Date.parse(STANDING_CHART_START);
    }
  }
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
      /** The client dropped its held poll without the stub answering it (it
       *  is stopping); a new poll clears it. */
      gone?: boolean;
    }
  >();
  /** HAR-120: API requests received and not yet answered. */
  let apiInFlight = 0;
  const heldApi: ServerResponse[] = [];
  const heldWaiters: Array<() => void> = [];
  const hungWaiters: Array<() => void> = [];
  const sendTimes: number[] = [];
  const settleWaiters: Array<() => void> = [];
  const isSettled = () =>
    apiInFlight === 0 &&
    [...signalRConnections.values()].every(
      c => c.closed || c.gone || (c.outbox.length === 0 && (c.held !== undefined || !c.started))
    );
  /** Wake every `settled()` waiter if the stub is settled now. Called after
   *  each change to a connection or a request. */
  const checkSettled = () => {
    if (isSettled()) settleWaiters.splice(0).forEach(resolve => resolve());
  };
  const settled = () =>
    new Promise<void>(resolve => {
      settleWaiters.push(resolve);
      checkSettled();
    });
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
      timestamp: new Date(fakeClock.now()).toISOString(),
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
    const enqueuedTimeUtc = new Date(fakeClock.now()).toISOString();
    const sent: Record<string, unknown> = { ...simReading(simServed), enqueuedTimeUtc };
    if (push === 'extra-field') sent['iothub_name'] = 'stub-hub';
    if (push === 'no-enqueued') delete sent['enqueuedTimeUtc'];
    if (push === 'wrong-type') sent['grillTemp'] = '225.4';
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
    if (held) {
      if (connection.outbox.length > 0) {
        connection.held = undefined;
        held.writeHead(200, { 'Content-Type': 'text/plain' });
        held.end(connection.outbox.splice(0).join(''));
      } else if (connection.closed) {
        connection.held = undefined;
        held.writeHead(204);
        held.end();
      }
    }
    checkSettled();
  };

  let throttled = 0;
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
          if (throttled < (options.signalRThrottle ?? 0)) {
            throttled++;
            response.writeHead(429);
            response.end('Too many requests.');
            return;
          }
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
          // A poll is held until there is something to send, the connection
          // closes, the client polls again (the older poll gets an empty 200,
          // which makes a client re-poll) or the stub closes. No timer.
          connection.held?.writeHead(200).end();
          connection.held = response;
          connection.gone = false;
          request.on('close', () => {
            if (connection.held === response && !response.writableEnded) {
              connection.held = undefined;
              connection.gone = true;
              checkSettled();
            }
          });
          flushPoll(connection);
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
        // HAR-45: the fake simdevice reporting a top-up. Not an API route. It
        // answers with the fake time, which the fake prints as `sentAt`.
        const { args } = (await readJson(request)) as { args: string[] };
        const now = fakeClock.now();
        if (args.includes('--start')) {
          // HAR-87: a chart top-up, rolled up after a few chart reads.
          chartTopups.push(args);
          chartPendingFrom = Date.parse(args[args.indexOf('--start') + 1]);
          chartReadsToCover = options.chartCoveredFromRead ?? 2;
        } else if (args.join(' ') === '--count 1') {
          // HAR-63: the one reading; broadcastTemperature pushes it live, as
          // soon as the send is reported (before simdevice prints it).
          twinReading = undefined;
          sendTimes.push(now);
          pushLiveReading();
        } else {
          topups.push(args);
          const count = Number(args[args.indexOf('--count') + 1]);
          simPending += count;
          // The fake simdevice stamps its top-up readings from TOPUP_EPOCH, 50 ms apart.
          topupLast = new Date(TOPUP_EPOCH + (count - 1) * 50).toISOString();
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ now: new Date(now).toISOString() }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/__scripts/run') {
        // HAR-140: a fake enrol-device.sh or delete-device.sh. Not an API route.
        const { script, args } = (await readJson(request)) as { script: string; args: string[] };
        scriptRuns.push({ script, args });
        const id = args[args.indexOf('--device-id') + 1];
        let line: string;
        if (script === 'enrol-device.sh') {
          line = enrolledIds.has(id) ? `unchanged ${id}` : `enrolled ${id}`;
          enrolledIds.add(id);
        } else if (script === 'revoke-device.sh') {
          // HAR-142: disables the enrollment and the hub identity.
          const already = revokedIds.has(id);
          if (!options.revokeIgnored) revokedIds.add(id);
          line = already ? `already revoked ${id}` : `revoked ${id}`;
        } else {
          const had = enrolledIds.has(id) || hubIds.has(id);
          enrolledIds.delete(id);
          hubIds.delete(id);
          claimCodes.delete(id);
          revokedIds.delete(id);
          line = had ? `deleted ${id}` : `already deleted ${id}`;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ line }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/__simdevice/register') {
        // HAR-140: a fresh device registering through the fake DPS, which
        // needs its enrollment, and syncing its twin, which mints a claim
        // code when it shows none. Not an API route.
        const { deviceId } = (await readJson(request)) as { deviceId: string };
        if (!enrolledIds.has(deviceId) || revokedIds.has(deviceId)) {
          response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'not enrolled' }));
          return;
        }
        hubIds.add(deviceId);
        if (!claimCodes.has(deviceId)) {
          const code = `7K3M-9QXR-${String(1000 + mintedCodes.length)}`;
          mintedCodes.push(code);
          claimCodes.set(deviceId, { code });
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/__simdevice/fresh-send') {
        // HAR-142: a fresh device's `simdevice --count 1`. The hub refuses a
        // revoked (or never registered) identity; otherwise broadcastTemperature
        // pushes the reading to the device's holder, read now, as the deployed
        // function reads the owner on every batch. Not an API route.
        const { deviceId } = (await readJson(request)) as { deviceId: string };
        if (options.revokedSendHangs && revokedIds.has(deviceId)) {
          freshSends.push({ deviceId, hung: true });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ hang: true }), () =>
            hungWaiters.splice(0).forEach(resolve => resolve())
          );
          return;
        }
        if (!hubIds.has(deviceId) || revokedIds.has(deviceId)) {
          freshSends.push({ deviceId, refused: true });
          response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end('{}');
          return;
        }
        const now = fakeClock.now();
        // Distinct per send, so each reading is its own timestamp.
        const timestamp = new Date(now + freshSends.length).toISOString();
        const owner = devices.get(deviceId)?.userId;
        const holder: 'owner' | 'peer' | undefined =
          owner === STUB_PEER_USER
            ? 'peer'
            : owner !== undefined
              ? 'owner'
              : options.releaseLeaks
                ? lastHolder.get(deviceId)
                : undefined;
        const dropped =
          options.freshPushDropped !== undefined &&
          deviceId.startsWith(`acceptance-${options.freshPushDropped}-`);
        freshSends.push({
          deviceId,
          ...(holder && !dropped ? { pushedTo: holder } : {}),
          ...(dropped ? { dropped: true } : {}),
        });
        if (holder && !dropped) {
          const payload = {
            deviceId,
            timestamp,
            grillTemp: 225.4,
            probe1Temp: 150,
            enqueuedTimeUtc: new Date(now).toISOString(),
          };
          const message = `${JSON.stringify({ type: 1, target: 'temperature', arguments: [payload] })}${RS}`;
          for (const connection of signalRConnections.values()) {
            if (connection.started && !connection.closed && connection.user === holder) {
              connection.outbox.push(message);
              flushPoll(connection);
            }
          }
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ now: new Date(now).toISOString(), timestamp }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/__simdevice/claim-state') {
        // HAR-140: what `simdevice claim-code` prints for a fresh device.
        const deviceId = url.searchParams.get('deviceId') ?? '';
        const entry = claimCodes.get(deviceId);
        if (!entry) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify(
            entry.consumedBy
              ? { deviceId, state: 'claimed' }
              : {
                  deviceId,
                  state: 'unclaimed',
                  claimCode: entry.code,
                  expiresAt: new Date(fakeClock.now() + 86_400_000).toISOString(),
                }
          )
        );
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
        if (args.join(' ').includes('--count 1') && !options.twinReadingNeverRouted) {
          twinReading = { timestamp: TWIN_TIMESTAMP, cookId: reported.activeCookId };
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ desired, reported, now: new Date(fakeClock.now()).toISOString() })
        );
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
      apiInFlight += 1;
      let answered = false;
      const doneWith = () => {
        if (answered) return;
        answered = true;
        apiInFlight -= 1;
        checkSettled();
      };
      response.on('close', doneWith);

      // HAR-77: every API response carries X-Request-ID, as the handlers'
      // do: the caller's when it sent one, else the invocation id.
      const responseRequestId = requestId ?? 'stub-invocation';
      const send = (status: number, body: unknown, route?: StubRoute, charge?: string) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (!route || options.omitRequestIdOn !== route) {
          headers['X-Request-ID'] = responseRequestId;
        }
        const altered =
          route && options.alterBody?.route === route && status >= 200 && status < 300
            ? options.alterBody.alter(body)
            : body;
        if (route && options.omitChargeOn !== route) {
          const reported =
            route === 'POST /negotiate' ? options.negotiateCharge : (charge ?? chargeOf(route));
          if (reported !== undefined) {
            headers[REQUEST_CHARGE_HEADER] = reported;
          }
        }
        if (options.echoAuthorization && authorization) {
          headers['x-echo-authorization'] = authorization;
        }
        response.writeHead(status, headers);
        response.end(JSON.stringify(altered));
      };

      const caller =
        authorization === `Bearer ${TOKEN}`
          ? 'owner'
          : authorization === `Bearer ${PEER_TOKEN}`
            ? 'peer'
            : undefined;
      if (!caller) {
        if (options.echoAuthorization && authorization) {
          send(401, { error: `BAD ${authorization}` });
          return;
        }
        if (options.unauthenticatedBody !== undefined) {
          send(401, options.unauthenticatedBody);
          return;
        }
        // Easy Auth answers a missing token itself: no body, no X-Request-ID.
        response.writeHead(401);
        response.end();
        return;
      }
      /** HAR-77: the error envelope the handlers write (ErrorResponse). */
      const errorBody = (code: string, message = `stub: ${code}`) => ({
        error: code,
        message,
        requestId: 'stub-invocation',
      });

      const stopMatch = /^\/api\/cooks\/([^/]+)\/stop$/.exec(url.pathname);
      const cookMatch = /^\/api\/cooks\/([^/]+)$/.exec(url.pathname);
      const chartMatch = /^\/api\/cooks\/([^/]+)\/chart$/.exec(url.pathname);
      const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(url.pathname);
      const temperatureMatch = /^\/api\/temperatures\/current\/([^/]+)$/.exec(url.pathname);
      const recipeMatch = /^\/api\/recipes\/([^/]+)$/.exec(url.pathname);
      let route: StubRoute | undefined;
      if (request.method === 'GET' && url.pathname === '/api/cooks') route = 'GET /cooks';
      else if (request.method === 'POST' && url.pathname === '/api/cooks') route = 'POST /cooks';
      else if (request.method === 'POST' && stopMatch) route = 'POST /cooks/{cookId}/stop';
      else if (request.method === 'GET' && cookMatch) route = 'GET /cooks/{cookId}';
      else if (request.method === 'GET' && chartMatch) route = 'GET /cooks/{cookId}/chart';
      else if (request.method === 'GET' && url.pathname === '/api/devices') route = 'GET /devices';
      else if (request.method === 'POST' && url.pathname === '/api/devices')
        route = 'POST /devices';
      else if (request.method === 'POST' && url.pathname === '/api/devices/claim')
        route = 'POST /devices/claim';
      else if (request.method === 'GET' && deviceMatch) route = 'GET /devices/{id}';
      else if (request.method === 'PATCH' && deviceMatch) route = 'PATCH /devices/{id}';
      else if (request.method === 'DELETE' && deviceMatch) route = 'DELETE /devices/{id}';
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
        send(404, errorBody('NOT_FOUND'));
        return;
      }
      // HAR-67: the peer owns nothing. The stub serves it only the routes the
      // isolation proof sends as the peer.
      const callerUser = caller === 'peer' ? STUB_PEER_USER : STUB_OWNER_USER;
      const owns = (deviceId: string) => devices.get(deviceId)?.userId === callerUser;
      const peerRoutes: StubRoute[] = [
        'POST /negotiate',
        'GET /temperatures/current/{deviceId}',
        'POST /cooks',
        'GET /cooks/{cookId}',
        'GET /cooks/{cookId}/chart',
        'DELETE /devices/{id}',
        // HAR-142: the claim proofs' second user.
        'POST /devices/claim',
        'GET /devices/{id}',
      ];
      if (caller === 'peer' && !peerRoutes.includes(route)) {
        send(404, errorBody('NOT_FOUND'));
        return;
      }

      if (options.holdRoute === route) {
        // HAR-120: never answered; the stub's close ends it.
        heldApi.push(response);
        doneWith();
        heldWaiters.splice(0).forEach(resolve => resolve());
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
          send(400, errorBody('VALIDATION_ERROR'));
          return;
        }
        const created = profile === undefined;
        profile = {
          id: 'stub-tenant:stub-user',
          createdAt: (profile?.['createdAt'] as string) ?? new Date(fakeClock.now()).toISOString(),
          // As the API does on create: the defaults, deep-merged with nothing.
          preferences: structuredClone(DEFAULT_USER_PREFERENCES),
          devices: [...devices.keys()],
          name: body['name'],
          email: body['email'],
        };
        send(created ? 201 : 200, profile, route);
        return;
      }
      if (route === 'GET /users/me') {
        if (!profile) {
          send(404, errorBody('USER_NOT_FOUND'), route);
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
          send(400, errorBody('VALIDATION_ERROR'));
          return;
        }
        const now = new Date(fakeClock.now()).toISOString();
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
          send(404, errorBody('RECIPE_NOT_FOUND'), route);
          return;
        }
        if (route === 'DELETE /recipes/{id}') {
          recipes.delete(id);
          const headers: Record<string, string> = { 'X-Request-ID': responseRequestId };
          if (options.omitChargeOn !== route) headers[REQUEST_CHARGE_HEADER] = RU[route];
          response.writeHead(204, headers);
          response.end();
          return;
        }
        if (route === 'PATCH /recipes/{id}') {
          const body = (await readJson(request)) as Record<string, unknown>;
          Object.assign(recipe, body, { updatedAt: new Date(fakeClock.now()).toISOString() });
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
            send(404, errorBody('NO_READINGS'), route);
          } else {
            send(200, simReading(OLDER_READINGS[OLDER_READINGS.length - 1]), route);
          }
          return;
        }
        // Nothing else writes telemetry in the stub: an owned device has no readings.
        const code = owned ? 'NO_READINGS' : 'DEVICE_NOT_FOUND';
        send(404, errorBody(options.temperatureErrorCode ?? code), route);
      } else if (route === 'GET /temperatures/history') {
        // An owned device has an empty first page; anything else is not found.
        const deviceId = url.searchParams.get('deviceId') ?? '';
        if (!devices.has(deviceId)) {
          send(404, errorBody('DEVICE_NOT_FOUND'), route);
          return;
        }
        // HAR-75: offset paging is gone; refused before any read (no RU).
        if (url.searchParams.has('offset') && !options.historyAcceptsOffset) {
          send(400, errorBody('VALIDATION_ERROR', 'offset is not supported'));
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
            send(400, errorBody('VALIDATION_ERROR'));
            return;
          }
          const all = [...OLDER_READINGS, ...(simRouted() ? [simServed] : [])].map(simReading);
          send(200, pageOf(all, SIM_HISTORY_PAGE, 'w-').body, route);
          return;
        }
        send(200, options.emptyHistoryBody ?? { readings: [], limit: 100, hasMore: false }, route);
      } else if (route === 'GET /devices') {
        send(200, { devices: [...devices.values()].filter(d => d.userId === callerUser) }, route);
      } else if (route === 'POST /devices') {
        const body = (await readJson(request)) as Partial<StubDevice> & { deviceId?: string };
        if (!body?.deviceId || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.deviceId) || !body.name) {
          send(400, errorBody('VALIDATION_ERROR'));
          return;
        }
        if (
          devices.has(body.deviceId) ||
          (options.simOwnedByOther && body.deviceId === SIM_DEVICE)
        ) {
          send(409, errorBody('DEVICE_CONFLICT'), route);
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
      } else if (route === 'POST /devices/claim') {
        // HAR-140: the device's own claim code, as it shows it; every refusal
        // is the one 403 with no request charge, as the deployed route does.
        const body = (await readJson(request)) as {
          deviceId?: string;
          claimCode?: string;
          name?: string;
          model?: string;
          location?: string;
        } | null;
        if (
          !body?.deviceId ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(body.deviceId) ||
          !body.name ||
          typeof body.claimCode !== 'string'
        ) {
          send(400, errorBody('VALIDATION_ERROR'));
          return;
        }
        const refuse = () =>
          send(403, errorBody('CLAIM_REFUSED', 'Device could not be claimed with that code'));
        const entry = claimCodes.get(body.deviceId);
        if (!entry && options.claimOracle && !enrolledIds.has(body.deviceId)) {
          send(403, errorBody('DEVICE_NOT_FOUND'));
          return;
        }
        if (
          !entry ||
          entry.code !== body.claimCode ||
          (entry.consumedBy !== undefined && entry.consumedBy !== caller)
        ) {
          refuse();
          return;
        }
        // HAR-142: held by someone else (the code was consumed by them).
        const existing = devices.get(body.deviceId);
        if (existing && existing.userId !== callerUser) {
          refuse();
          return;
        }
        entry.consumedBy = caller;
        lastHolder.set(body.deviceId, caller);
        if (existing) {
          send(200, existing, route);
          return;
        }
        const device: StubDevice = {
          id: body.deviceId,
          userId: callerUser,
          name: body.name,
          model: body.model ?? 'MeatGeek',
          location: body.location,
          isActive: true,
          connectionStatus: 'unknown',
          claimedAt: new Date(fakeClock.now()).toISOString(),
        };
        devices.set(device.id, device);
        send(201, device, route);
      } else if (route === 'DELETE /devices/{id}') {
        // HAR-85: 403 for the peer on the owner's device, 404 for no device.
        const id = decodeURIComponent(deviceMatch![1]);
        if (!devices.has(id)) {
          send(404, errorBody('DEVICE_NOT_FOUND'), route);
          return;
        }
        if (!owns(id) && !(caller === 'peer' && options.deviceDeleteFault === 'peer-deletes')) {
          send(403, errorBody('DEVICE_NOT_OWNED'), route);
          return;
        }
        // HAR-136: a release is refused while the caller has an active cook on
        // the device, as the deployed route refuses it.
        const userId = callerUser;
        if (
          cooks.some(
            cook => cook.deviceId === id && cook.userId === userId && cook.status === 'active'
          )
        ) {
          send(409, errorBody('COOK_ACTIVE'), route);
          return;
        }
        if (options.deviceDeleteFault !== 'keeps') {
          devices.delete(id);
          // HAR-140: a release raises the claim generation: the old code is
          // dead, and the device mints a new one at its next twin sync.
          claimCodes.delete(id);
        }
        const headers: Record<string, string> = { 'X-Request-ID': responseRequestId };
        if (options.omitChargeOn !== route) headers[REQUEST_CHARGE_HEADER] = RU[route];
        response.writeHead(204, headers);
        response.end();
      } else if (route === 'GET /devices/{id}' || route === 'PATCH /devices/{id}') {
        const device = devices.get(decodeURIComponent(deviceMatch![1]));
        // HAR-142: someone else's device is the same 404 as an unknown one.
        if (!device || device.userId !== callerUser) {
          send(404, errorBody('NOT_FOUND'), route);
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
          send(404, errorBody('NOT_FOUND'), route);
        }
      } else if (route === 'GET /cooks/{cookId}/chart') {
        // HAR-86: the caller's own cook only, as GET /cooks/{cookId}.
        const id = decodeURIComponent(chartMatch![1]);
        const userId = caller === 'peer' ? 'stub-tenant:stub-peer' : 'stub-tenant:stub-user';
        const cook = cooks.find(
          candidate =>
            candidate.id === id &&
            (candidate.userId === userId || options.chartFault === 'peer-reads')
        );
        if (!cook) {
          send(404, errorBody('NOT_FOUND'), route);
        } else if (cook.deviceId === CHART_DEVICE) {
          // HAR-87: the standing cook's chart, in 60 s buckets from its
          // start minute to the minute of its last reading, once covered.
          if (chartReadsToCover !== undefined && !options.chartTopupNeverRolledUp) {
            chartReadsToCover -= 1;
            if (chartReadsToCover <= 0) {
              chartCoveredFrom = chartPendingFrom;
              chartReadsToCover = undefined;
            }
          }
          const startMs = Date.parse(cook.startTime);
          const startMinute = Math.floor(startMs / 60_000) * 60_000;
          const lastReading = startMs + (CHART.readings - 1) * CHART.stepSeconds * 1000;
          const points =
            chartCoveredFrom === startMs
              ? Array.from(
                  { length: Math.floor((lastReading - startMinute) / 60_000) + 1 },
                  (_, k) => ({
                    t: new Date(startMinute + k * 60_000).toISOString(),
                    grill: { min: 224.9, max: 225.4, avg: 225.1 },
                  })
                )
              : [];
          send(
            200,
            {
              cookId: cook.id,
              deviceId: cook.deviceId,
              startTime: cook.startTime,
              bucketSeconds: 60,
              points,
            },
            route,
            options.chartCharge
          );
        } else if (options.chartFault === 'bad-body') {
          send(200, { cookId: cook.id, deviceId: cook.deviceId, points: 'none' }, route);
        } else {
          send(
            200,
            {
              cookId: cook.id,
              deviceId: cook.deviceId,
              startTime: cook.startTime,
              ...(cook.endTime ? { endTime: cook.endTime } : {}),
              bucketSeconds: 60,
              points: [
                {
                  t: cook.startTime.slice(0, 16) + ':00.000Z',
                  grill: { min: 224.9, max: 225.4, avg: 225.1 },
                },
              ],
            },
            route
          );
        }
      } else if (route === 'POST /cooks') {
        const body = (await readJson(request)) as Partial<StubCook>;
        if (!body?.id || !/^[0-9a-f-]{36}$/i.test(body.id) || !body.deviceId || !body.name) {
          send(400, errorBody('VALIDATION_ERROR'));
          return;
        }
        // HAR-26: a cook only starts on a device the caller registered.
        if (!options.allowAnyDevice && !owns(body.deviceId)) {
          send(403, errorBody('DEVICE_NOT_OWNED'), route);
          return;
        }
        const cook: StubCook = {
          id: body.id,
          userId: caller === 'peer' ? 'stub-tenant:stub-peer' : 'stub-tenant:stub-user',
          deviceId: body.deviceId,
          name: body.name,
          status: 'active',
          startTime: new Date(fakeClock.now()).toISOString(),
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
          send(404, errorBody('NOT_FOUND'), route);
          return;
        }
        cook.status = 'completed';
        cook.endTime = new Date(fakeClock.now()).toISOString();
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
  fakeClock.settle = settled;
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
    chartTopups,
    chartCooks: () =>
      cooks
        .filter(c => c.deviceId === CHART_DEVICE)
        .map(({ id, status, startTime }) => ({ id, status, startTime })),
    chartRegistered: () => devices.has(CHART_DEVICE),
    deviceIds: () => [...devices.keys()].sort(),
    scriptRuns,
    enrolledIds: () =>
      [...new Set([...enrolledIds, ...hubIds])]
        .filter(id => id !== SIM_DEVICE && id !== CHART_DEVICE)
        .sort(),
    mintedCodes,
    freshSends,
    revokedSendHangs: options.revokedSendHangs ?? false,
    revokedIds: () => [...revokedIds].sort(),
    sendTimes,
    settled,
    whenHeld: () =>
      new Promise<void>(resolve => {
        if (heldApi.length > 0) resolve();
        else heldWaiters.push(resolve);
      }),
    whenSendHung: () =>
      new Promise<void>(resolve => {
        if (freshSends.some(send => send.hung)) resolve();
        else hungWaiters.push(resolve);
      }),
    close: () =>
      new Promise<void>(resolve => {
        // End what is still open, so close() waits on nothing: held polls get
        // the 204 that tells a client the connection is over, and a held API
        // request an empty 503.
        for (const connection of signalRConnections.values()) {
          connection.closed = true;
          flushPoll(connection);
        }
        for (const held of heldApi.splice(0)) {
          if (!held.writableEnded) held.writeHead(503).end();
        }
        // Every proof is over by now, so no socket is still wanted: a stopping
        // SignalR client can leave one open with no request on it, which
        // close() alone would wait on until the client drops it.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
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
    groups,
    deviceScriptsDir,
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
// HAR-120: sentAt is the stub's fake time when the send was reported, never this process's clock.
let sentAt = ${JSON.stringify(new Date(FakeClock.EPOCH).toISOString())};
const reading = timestamp => ({ messageId: 'f'.repeat(64), deviceId: ${JSON.stringify(SIM_DEVICE)}, timestamp, sentAt });
const args = process.argv.slice(2).join(' ');
// HAR-140: DPS mode, the device named by MEATGEEK_DEVICE_ID with its own state
// dir (made by identity init, or by the test for a standing device).
const dpsDevice = process.env.MEATGEEK_DEVICE_ID || '';
const dpsStored = (() => {
  try {
    return JSON.parse(require('fs').readFileSync(require('path').join(process.env.MEATGEEK_STATE_DIR || '', 'identity.json'), 'utf8')).deviceId;
  } catch {
    return undefined;
  }
})();
const dpsHandedOver = dpsDevice !== '' && dpsStored === dpsDevice && conn === '' && !!process.env.MEATGEEK_DPS_ID_SCOPE && !process.env.ACCEPTANCE_BEARER_TOKEN && !process.env.SIMDEVICE_CHART_CONNECTION_STRING;
const handedOver = (conn === ${JSON.stringify(SIM_CONNECTION_STRING)} && !process.env.ACCEPTANCE_BEARER_TOKEN && !process.argv.some(a => a.includes(key))) || (dpsHandedOver && dpsDevice === ${JSON.stringify(SIM_DEVICE)});
const chartHandedOver = (conn === ${JSON.stringify(CHART_CONNECTION_STRING)} && !process.env.ACCEPTANCE_BEARER_TOKEN && !process.env.SIMDEVICE_CHART_CONNECTION_STRING && !process.argv.some(a => a.includes(key))) || (dpsHandedOver && dpsDevice === ${JSON.stringify(CHART_DEVICE)});
// HAR-87: a chart top-up, stamped start + i × step.
const chartTopup = /^--count ([1-9][0-9]*) --start ([^ ]+) --step ([1-9][0-9]*)s --inflight [1-9][0-9]* --interval [0-9]+ms$/.exec(args);
const topup = /^--count ([1-9][0-9]*) --inflight [1-9][0-9]* --interval [0-9]+ms$/.exec(args);
const twin = /^--twin --count ([01]) --timeout 60s$/.exec(args);
// HAR-140: a fresh device. identity init makes a state dir; in DPS mode a
// --twin --count 0 registers through the stub's fake DPS (which mints the
// claim code); claim-code prints the stub's claim state. In every mode.
const fs = require('fs');
const pathJoin = require('path').join;
const argv = process.argv.slice(2);
const stubBase = ${JSON.stringify(stub ? stub.baseUrl : '')};
const freshId = process.env.MEATGEEK_DEVICE_ID || '';
const FAKE_PEM = '-----BEGIN CERTIFICATE-----\\nZmFrZS1jZXJ0\\n-----END CERTIFICATE-----\\\n';
let handledFresh = true;
if (argv[0] === 'claim-code' && argv[1] === '--state-dir' && argv.length === 3) {
  let id;
  try {
    id = JSON.parse(fs.readFileSync(pathJoin(argv[2], 'identity.json'), 'utf8')).deviceId;
  } catch {
    process.stderr.write('claim-code: no identity in the state dir\\n');
    process.exit(1);
  }
  fetch(stubBase + '/__simdevice/claim-state?deviceId=' + encodeURIComponent(id)).then(r => {
    if (r.status === 404) process.exit(3);
    return r.json().then(body => line(body));
  }, () => process.exit(1));
} else if (argv[0] === 'identity' && argv[1] === 'init') {
  const id = argv[argv.indexOf('--device-id') + 1];
  const dir = argv[argv.indexOf('--state-dir') + 1];
  if (id !== freshId || dir !== process.env.MEATGEEK_STATE_DIR) {
    process.stderr.write('fake simdevice: identity init for another device\\n');
    process.exit(2);
  }
  // The real layout (data-pusher identity.go): key and certificate under identity/.
  fs.mkdirSync(pathJoin(dir, 'identity'), { recursive: true });
  fs.writeFileSync(pathJoin(dir, 'identity', 'device.key'), 'fake private key');
  fs.writeFileSync(pathJoin(dir, 'identity', 'device.crt'), FAKE_PEM);
  fs.writeFileSync(pathJoin(dir, 'identity.json'), JSON.stringify({ deviceId: id }));
  process.stdout.write(FAKE_PEM);
} else if (freshId.startsWith('acceptance-') && args === '--count 1') {
  // HAR-142: a fresh device sends one reading, through the stub's fake hub.
  if (!dpsHandedOver) {
    process.stderr.write('fake simdevice: bad DPS hand-over: ' + args + '\\n');
    process.exit(2);
  }
  fetch(stubBase + '/__simdevice/fresh-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: freshId }),
  }).then(r => {
    if (!r.ok) {
      process.stderr.write('{"level":"info","msg":"iothub: hub assigned"}\\n');
      process.stderr.write('simdevice: send reading 1 of 1: iothub: publish failed after retry: iothub: find the hub: provision: DPS refused the enrollment: the enrollment for ' + freshId + ' is disabled\\n');
      process.exit(1);
    }
    return r.json().then(body => body.hang ? setInterval(() => undefined, 1000) : line({ messageId: 'f'.repeat(64), deviceId: freshId, timestamp: body.timestamp, sentAt: body.now }));
  }, () => process.exit(1));
} else if (freshId.startsWith('acceptance-') || (dpsDevice !== '' && args === '--twin --count 0 --timeout 2m')) {
  if (args !== '--twin --count 0 --timeout 2m' || !dpsHandedOver) {
    process.stderr.write('fake simdevice: bad DPS hand-over: ' + args + '\\n');
    process.exit(2);
  }
  fetch(stubBase + '/__simdevice/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: freshId }),
  }).then(r => {
    if (!r.ok) {
      process.stderr.write('dps: registration refused: the device is not enrolled\\n');
      process.exit(1);
    }
    line({ event: 'twin', desired: {}, reported: {} });
  }, () => process.exit(1));
} else {
  handledFresh = false;
}
if (handledFresh) {
  // done above
} else if (mode === 'ok' && chartTopup && chartHandedOver) {
  fetch(${JSON.stringify(notifyUrl)}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: process.argv.slice(2) }),
  }).then(r => r.json()).then(body => {
    sentAt = body.now;
    const start = Date.parse(chartTopup[2]);
    for (let i = 0; i < Number(chartTopup[1]); i++) {
      line({ ...reading(new Date(start + i * Number(chartTopup[3]) * 1000).toISOString()), deviceId: ${JSON.stringify(CHART_DEVICE)} });
    }
  }, () => {
    process.stderr.write('fake simdevice: could not report the chart top-up\\n');
    process.exit(3);
  });
} else if ((mode === 'ok' || mode === 'topup-exit1') && twin && handedOver) {
  // HAR-68: reconnect, read the stub's twin (it applies desired to reported),
  // print the twin line, then the reading carrying the cook.
  fetch(${JSON.stringify(stub ? `${stub.baseUrl}/__simdevice/twin` : '')}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: process.argv.slice(2) }),
  })
    .then(r => r.json())
    .then(({ desired, reported, now }) => {
      sentAt = now;
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
      }).then(r => r.json()).then(body => { sentAt = body.now; print(); }, print);
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
    }).then(r => r.json()).then(body => {
      sentAt = body.now;
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

/**
 * HAR-140: stand-ins for enrol-device.sh and delete-device.sh, written next to
 * each other as the runner expects. Each checks the runner's hand-over (login
 * auth, both host names, no bearer token or device credential in its
 * environment) and its own rules (enrol: the certificate file exists; delete:
 * `--only-prefix` is given and the id starts with it, else exit 4), then has
 * the stub do the work and prints the stub's result line.
 */
function writeFakeDeviceScripts(
  hang?: 'enrol-device.sh' | 'delete-device.sh' | 'revoke-device.sh'
): string {
  const dir = mkdtempSync(join(fakeDir, 'scripts-'));
  if (hang) hangingScriptDirs.add(dir);
  for (const script of ['enrol-device.sh', 'delete-device.sh', 'revoke-device.sh']) {
    const path = join(dir, script);
    writeFileSync(
      path,
      `#!${process.execPath}
const script = ${JSON.stringify(script)};
if (${JSON.stringify(hang === script)}) setInterval(() => undefined, 1000);
else {
const args = process.argv.slice(2);
const get = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const fail = (code, message) => { process.stderr.write(script + ': ' + message + '\\n'); process.exit(code); };
if (get('--auth-type') !== 'login' || get('--dps') !== ${JSON.stringify(DPS_HOST)} || get('--hub') !== ${JSON.stringify(HUB_HOST)}) fail(2, 'bad hand-over: ' + args.join(' '));
if (process.env.ACCEPTANCE_BEARER_TOKEN || process.env.ACCEPTANCE_PEER_BEARER_TOKEN || process.env.SIMDEVICE_CONNECTION_STRING || process.env.MEATGEEK_STATE_DIR) fail(2, 'handed a secret');
const id = get('--device-id');
if (!id) fail(2, '--device-id is required');
if (script === 'enrol-device.sh' && !require('fs').existsSync(get('--certificate') || '')) fail(2, 'cannot read the certificate');
if (script === 'delete-device.sh') {
  const prefix = get('--only-prefix');
  if (!prefix) fail(2, '--only-prefix is required');
  if (!id.startsWith(prefix)) fail(4, 'refusing to delete device ' + id);
}
fetch(${JSON.stringify(stub ? `${stub.baseUrl}/__scripts/run` : '')}, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ script, args }),
}).then(r => r.json()).then(body => process.stdout.write(body.line + '\\n'), () => fail(1, 'no stub'));
}
`
    );
    chmodSync(path, 0o755);
  }
  return dir;
}

/** HAR-140: fake device-script dirs with a script that never exits. Those
 *  always run as real children, so the runner's kill is what ends them. */
const hangingScriptDirs = new Set<string>();

/**
 * HAR-140: when false, every child the runner starts is a real process.
 * {@link inProcessSpawn} is the default; a test of the hand-over itself sets
 * this to false.
 */
let inProcessChildren = true;

const FAKE_PEM = '-----BEGIN CERTIFICATE-----\nZmFrZS1jZXJ0\n-----END CERTIFICATE-----\n';

/**
 * A child process that runs `work` in this process: what `work` writes goes to
 * its stdout and stderr, and the number it returns is its exit code.
 */
function inProcessChild(
  work: (out: (text: string) => void, err: (text: string) => void) => Promise<number>
): ChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: () => false });
  // A microtask, so the caller's listeners are attached first.
  void Promise.resolve().then(async () => {
    let code: number;
    try {
      code = await work(
        text => stdout.write(text),
        text => stderr.write(text)
      );
    } catch (error) {
      stderr.write(`in-process fake: ${(error as Error).message}\n`);
      code = 1;
    }
    const ended = Promise.all([once(stdout, 'end'), once(stderr, 'end')]);
    stdout.end();
    stderr.end();
    await ended;
    child.emit('close', code);
  });
  return child as unknown as ChildProcess;
}

/**
 * HAR-140: the fresh-device steps, answered in this process. A full suite run
 * makes about 18 of these child processes per three fresh devices (six steps
 * each; HAR-142 brought it to eight devices), and the self-test runs the
 * suite well over a hundred times, so
 * starting real ones made this file four times slower.
 *
 * Each branch does what the matching branch of the fake scripts
 * ({@link writeFakeSimdevice}, {@link writeFakeDeviceScripts}) does, with the
 * same checks of the arguments and environment the runner hands over, and
 * against the same stub routes. The two must agree. The DPS-mode test sets
 * {@link inProcessChildren} to false and runs the real ones. Anything else
 * (sends, top-ups, twin reconnects, a hanging script, and a fresh device's
 * `--count 1` in a run whose revoked send hangs) is a real child.
 */
const inProcessSpawn: Spawn = (bin, args, env) => {
  const hangingSend = stub?.revokedSendHangs === true && args.join(' ') === '--count 1';
  const fresh =
    inProcessChildren && stub && !hangingSend
      ? freshDeviceStep(bin, args, env, stub.baseUrl)
      : undefined;
  return fresh ? inProcessChild(fresh) : realSpawn(bin, args, env);
};

type ChildWork = (out: (text: string) => void, err: (text: string) => void) => Promise<number>;

function freshDeviceStep(
  bin: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stubBase: string
): ChildWork | undefined {
  const script = basename(bin);
  if (
    (script === 'enrol-device.sh' ||
      script === 'delete-device.sh' ||
      script === 'revoke-device.sh') &&
    dirname(bin).startsWith(fakeDir) &&
    !hangingScriptDirs.has(dirname(bin))
  ) {
    return async (out, err) => {
      const get = (flag: string) => {
        const i = argv.indexOf(flag);
        return i < 0 ? undefined : argv[i + 1];
      };
      const fail = (code: number, message: string) => {
        err(`${script}: ${message}\n`);
        return code;
      };
      if (
        get('--auth-type') !== 'login' ||
        get('--dps') !== DPS_HOST ||
        get('--hub') !== HUB_HOST
      ) {
        return fail(2, `bad hand-over: ${argv.join(' ')}`);
      }
      if (
        env['ACCEPTANCE_BEARER_TOKEN'] ||
        env['ACCEPTANCE_PEER_BEARER_TOKEN'] ||
        env['SIMDEVICE_CONNECTION_STRING'] ||
        env['MEATGEEK_STATE_DIR']
      ) {
        return fail(2, 'handed a secret');
      }
      const id = get('--device-id');
      if (!id) return fail(2, '--device-id is required');
      if (script === 'enrol-device.sh' && !existsSync(get('--certificate') ?? '')) {
        return fail(2, 'cannot read the certificate');
      }
      if (script === 'delete-device.sh') {
        const prefix = get('--only-prefix');
        if (!prefix) return fail(2, '--only-prefix is required');
        if (!id.startsWith(prefix)) return fail(4, `refusing to delete device ${id}`);
      }
      const response = await fetch(`${stubBase}/__scripts/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script, args: argv }),
      });
      out(`${((await response.json()) as { line: string }).line}\n`);
      return 0;
    };
  }
  if (!basename(bin).startsWith('simdevice-') || dirname(bin) !== fakeDir) {
    return undefined;
  }
  const args = argv.join(' ');
  const line = (out: (text: string) => void, value: unknown) => out(`${JSON.stringify(value)}\n`);
  const freshId = env['MEATGEEK_DEVICE_ID'] ?? '';
  if (argv[0] === 'claim-code' && argv[1] === '--state-dir' && argv.length === 3) {
    return async (out, err) => {
      let id: string;
      try {
        id = JSON.parse(readFileSync(join(argv[2], 'identity.json'), 'utf8')).deviceId;
      } catch {
        err('claim-code: no identity in the state dir\n');
        return 1;
      }
      const response = await fetch(
        `${stubBase}/__simdevice/claim-state?deviceId=${encodeURIComponent(id)}`
      );
      if (response.status === 404) return 3;
      line(out, await response.json());
      return 0;
    };
  }
  if (argv[0] === 'identity' && argv[1] === 'init') {
    return async (out, err) => {
      const id = argv[argv.indexOf('--device-id') + 1];
      const dir = argv[argv.indexOf('--state-dir') + 1];
      if (id !== freshId || dir !== env['MEATGEEK_STATE_DIR']) {
        err('fake simdevice: identity init for another device\n');
        return 2;
      }
      // The real layout (data-pusher identity.go): key and certificate under identity/.
      mkdirSync(join(dir, 'identity'), { recursive: true });
      writeFileSync(join(dir, 'identity', 'device.key'), 'fake private key');
      writeFileSync(join(dir, 'identity', 'device.crt'), FAKE_PEM);
      writeFileSync(join(dir, 'identity.json'), JSON.stringify({ deviceId: id }));
      out(FAKE_PEM);
      return 0;
    };
  }
  const register = '--twin --count 0 --timeout 2m';
  const storedId = () => {
    try {
      return JSON.parse(
        readFileSync(join(env['MEATGEEK_STATE_DIR'] ?? '', 'identity.json'), 'utf8')
      ).deviceId as string;
    } catch {
      return undefined;
    }
  };
  const dpsHandedOver = () =>
    storedId() === freshId &&
    !env['SIMDEVICE_CONNECTION_STRING'] &&
    !!env['MEATGEEK_DPS_ID_SCOPE'] &&
    !env['ACCEPTANCE_BEARER_TOKEN'] &&
    !env['SIMDEVICE_CHART_CONNECTION_STRING'];
  if (freshId.startsWith('acceptance-') && args === '--count 1') {
    // HAR-142: a fresh device sends one reading, through the stub's fake hub.
    return async (out, err) => {
      if (!dpsHandedOver()) {
        err(`fake simdevice: bad DPS hand-over: ${args}\n`);
        return 2;
      }
      const response = await fetch(`${stubBase}/__simdevice/fresh-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: freshId }),
      });
      if (!response.ok) {
        // As simdevice does: its logs first, its own failure line last.
        err('{"level":"info","msg":"iothub: hub assigned"}\n');
        err(
          'simdevice: send reading 1 of 1: iothub: publish failed after retry: iothub: find the hub: ' +
            `provision: DPS refused the enrollment: the enrollment for ${freshId} is disabled\n`
        );
        return 1;
      }
      const { now, timestamp } = (await response.json()) as { now: string; timestamp: string };
      line(out, { messageId: 'f'.repeat(64), deviceId: freshId, timestamp, sentAt: now });
      return 0;
    };
  }
  if (freshId.startsWith('acceptance-') || (freshId !== '' && args === register)) {
    return async (out, err) => {
      let stored: string | undefined;
      try {
        stored = JSON.parse(
          readFileSync(join(env['MEATGEEK_STATE_DIR'] ?? '', 'identity.json'), 'utf8')
        ).deviceId;
      } catch {
        stored = undefined;
      }
      const handedOver =
        stored === freshId &&
        !env['SIMDEVICE_CONNECTION_STRING'] &&
        !!env['MEATGEEK_DPS_ID_SCOPE'] &&
        !env['ACCEPTANCE_BEARER_TOKEN'] &&
        !env['SIMDEVICE_CHART_CONNECTION_STRING'];
      if (args !== register || !handedOver) {
        err(`fake simdevice: bad DPS hand-over: ${args}\n`);
        return 2;
      }
      const response = await fetch(`${stubBase}/__simdevice/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: freshId }),
      });
      if (!response.ok) {
        err('dps: registration refused: the device is not enrolled\n');
        return 1;
      }
      line(out, { event: 'twin', desired: {}, reported: {} });
      return 0;
    };
  }
  return undefined;
}

/** HAR-140: the fake services' host names the runner hands the scripts. */
const DPS_HOST = 'stub-dps.azure-devices-provisioning.net';
const HUB_HOST = 'stub-hub.azure-devices.net';
/** The DPS inputs a stub run has, so fresh devices run in DPS mode. */
const dpsEnv = {
  ACCEPTANCE_DPS_ID_SCOPE: '0ne00STUB01',
  ACCEPTANCE_DPS_HOST: DPS_HOST,
  ACCEPTANCE_IOT_HUB_HOST: HUB_HOST,
};
/** The fake device scripts of the current stub run, handed to the runner. */
let deviceScriptsDir: string | undefined;

/**
 * HAR-140: the standing devices in DPS mode, as CI runs them: each with a
 * state dir (as the workflow's `identity init` leaves it) and no connection
 * string. A standing device can then show a claim code.
 */
function standingDpsEnv(mode: FakeMode = 'ok'): Record<string, string> {
  const stateDir = (id: string) => {
    const dir = mkdtempSync(join(fakeDir, 'state-'));
    writeFileSync(join(dir, 'identity.json'), JSON.stringify({ deviceId: id }));
    return dir;
  };
  return {
    ACCEPTANCE_SIM_DEVICE_ID: SIM_DEVICE,
    ACCEPTANCE_SIM_STATE_DIR: stateDir(SIM_DEVICE),
    ACCEPTANCE_CHART_DEVICE_ID: CHART_DEVICE,
    ACCEPTANCE_CHART_STATE_DIR: stateDir(CHART_DEVICE),
    ACCEPTANCE_SIMDEVICE_BIN: writeFakeSimdevice(mode),
  };
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
  groups?: readonly ProofGroup[],
  standing: 'connection-string' | 'dps' = 'connection-string'
): Promise<Run> {
  stub = await startStub(options);
  deviceScriptsDir = writeFakeDeviceScripts();
  return run(
    {
      ACCEPTANCE_BASE_URL: stub.baseUrl,
      ACCEPTANCE_BEARER_TOKEN: TOKEN,
      ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
      ...(standing === 'dps' ? standingDpsEnv(mode) : { ...simEnv(mode), ...chartEnv }),
      ...dpsEnv,
    },
    groups
  );
}

const realVolume = { ...VOLUME };
const realChart = { ...CHART };

beforeAll(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'acceptance-simdevice-'));
  // HAR-120: every wait keeps its live value (ROUNDTRIP_POLL, LIVE_WAIT,
  // ISOLATION_WAIT, TWIN_POLL, START_RETRY, the polls in VOLUME and CHART):
  // they run on the fake clock. Only the volumes shrink.
  // HAR-45: a long cook is 8,640 readings, walked 1,000 a page. Here a few
  // hundred walked 100 a page, so a walk is several pages.
  VOLUME.target = 240;
  VOLUME.margin = 6;
  VOLUME.pageLimit = 100;
  // HAR-87: 12 h of readings 5 s apart; here 10 min of them (120).
  CHART.readings = 120;
});

afterAll(() => {
  Object.assign(VOLUME, realVolume);
  Object.assign(CHART, realChart);
  rmSync(fakeDir, { recursive: true, force: true });
});

let restoreSpawn: (() => void) | undefined;

beforeEach(() => {
  fakeClock = new FakeClock();
  restoreClock = setClock(fakeClock);
  inProcessChildren = true;
  restoreSpawn = setSpawn(inProcessSpawn);
});

afterEach(async () => {
  await stub?.close();
  stub = undefined;
  deviceScriptsDir = undefined;
  restoreClock?.();
  restoreClock = undefined;
  restoreSpawn?.();
  restoreSpawn = undefined;
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
const COOK_CHART_ROUTE: CookChartRoute = 'GET /cooks/{cookId}/chart';
// HAR-140: no proof sends POST /devices any more; the stub still serves it.
const DEVICE_ROUTES: DeviceRoute[] = [
  'POST /devices/claim',
  'GET /devices/{id}',
  'GET /devices',
  'PATCH /devices/{id}',
  'DELETE /devices/{id}',
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
      COOK_CHART_ROUTE,
      ...DEVICE_ROUTES,
      ...TEMPERATURE_ROUTES,
      ...USER_ROUTES,
      ...RECIPE_ROUTES,
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
    // HAR-81: negotiate reads no devices, so every negotiate line has no RU.
    const negotiateLines = requestLines.filter(line => /^\s+POST\s+\/negotiate\s/.test(line));
    expect(negotiateLines.length).toBeGreaterThan(0);
    // Request lines end `RU -`; the summary rows show `-` for both RU columns.
    expect(negotiateLines.every(line => /(RU -|\s-\s+-)$/.test(line))).toBe(true);

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
    // HAR-136: the cleanup lists the device's active cooks once more, to stop
    // any before it releases the device.
    const filtered = stub!.requests.filter(
      r =>
        r.method === 'GET' && /^\/api\/cooks\?deviceId=acceptance-[^&]+&status=active$/.test(r.path)
    );
    expect(filtered).toHaveLength(3);
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

  /** HAR-136: the cooks lifecycle group fails the same way. Its always-run
   *  cleanup lists the device's active cooks and stops any before it releases
   *  the device, so it fails too when it lists (GET /cooks) or must stop (a stop
   *  refused, so the cook is still active). */
  const lifecycleFailures = twinFailures;

  it.each(ROUTES)('(b) exits non-zero and names %s when it returns a wrong status', async route => {
    const result = await runAgainstStub({ failRoute: { route, status: 503 } });

    expect(result.exitCode).not.toBe(0);
    // HAR-67 and HAR-68: the isolation and twin groups use every cooks route too.
    const twin = result.failures.filter(line => line.startsWith('FAIL device twin ›'));
    expect(twin).toHaveLength(twinFailures(route, true));
    // HAR-87: the cook-chart group lists the chart device's active cooks; it
    // starts or stops none while its standing cook is there.
    const chart = result.failures.filter(line => line.startsWith('FAIL cook chart ›'));
    expect(chart).toHaveLength(route === 'GET /cooks' ? 1 : 0);
    const lifecycle = result.failures.filter(line => line.startsWith('FAIL cooks lifecycle ›'));
    expect(lifecycle).toHaveLength(lifecycleFailures(route, true));
    expect(result.failures).toHaveLength(lifecycle.length + 1 + twin.length + chart.length);
    expect(result.failures[0]).toContain('cooks lifecycle ›');
    expect(result.failures[result.failures.length - 1 - chart.length]).toContain(
      'signalr isolation ›'
    );
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

  it('(a) HAR-86: reads the chart as the owner, for an unknown id, and as the peer', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    const reads = stub!.requests
      .filter(r => r.method === 'GET' && /^\/api\/cooks\/[^/?]+\/chart$/.test(r.path))
      .map(r => ({
        id: decodeURIComponent(r.path.slice('/api/cooks/'.length, -'/chart'.length)),
        as: r.authorization === `Bearer ${PEER_TOKEN}` ? 'peer' : 'owner',
      }))
      // HAR-87's standing cook is read by the cook-chart group.
      .filter(read => read.id !== STANDING_CHART_COOK_ID);
    expect(reads).toHaveLength(3);
    const cookId = reads[0].id;
    expect(reads).toEqual([
      { id: cookId, as: 'owner' },
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), as: 'owner' },
      { id: cookId, as: 'peer' },
    ]);
    expect(reads[1].id).not.toBe(cookId);
    for (const step of [
      'GET /cooks/{cookId}/chart as the owner is the chart of the started cook',
      'GET /cooks/{cookId}/chart for an unknown id is 404 NOT_FOUND',
      "GET /cooks/{cookId}/chart as the peer is 404 NOT_FOUND for the owner's cook",
    ]) {
      expect(result.lines).toContain(`PASS cooks lifecycle › ${step}`);
    }
  });

  it.each([
    [
      'peer-reads',
      "GET /cooks/{cookId}/chart as the peer is 404 NOT_FOUND for the owner's cook",
      'GET /cooks/{cookId}/chart (peer) → 200: expected 404',
    ],
    [
      'bad-body',
      'GET /cooks/{cookId}/chart as the owner is the chart of the started cook',
      'GET /cooks/{cookId}/chart → 200: contract: GET /cooks/{cookId}/chart (getCookChart) 200: the body does not match the schema',
    ],
  ] as const)('(b) HAR-86: exits non-zero when the chart %s', async (chartFault, step, shown) => {
    const result = await runAgainstStub({ chartFault });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(`FAIL cooks lifecycle › ${step}`);
    expect(result.failures[0]).toContain(shown);
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
      // HAR-77: a lock is not a Cook, so the contract catches it first.
      "GET /cooks/{cookId} → 200: contract: GET /cooks/{cookId} (getCook) 200: the body does not match the schema: (root) must have required property 'name'",
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
   *  have their own device. HAR-140: they, and the devices group, enrol a
   *  fresh one and claim it with POST /devices/claim, so a broken claim fails
   *  those three, and POST /devices is left to the simulated device's groups.
   *  HAR-68: the device twin group registers the simulated device first
   *  (201), so the isolation (HAR-67), live-temperature (HAR-63) and round
   *  trip groups, which run after it, take the 409 path and read
   *  GET /devices/{id}. HAR-85: the sweep lists the devices first; the devices
   *  group's first DELETE is the peer's, and its always-run cleanup then fails
   *  too, as do the temperatures and cooks lifecycle cleanups. A refused
   *  registration is no cleanup failure: the cleanup's DELETE may be 404.
   *  HAR-142: the claim, release and revoke groups claim fresh devices too;
   *  the release group releases one in a step and holds two to clean up,
   *  and the claim and release groups read a device back. */
  const groupsUsing = (route: DeviceRoute): string[] =>
    route === 'GET /devices'
      ? ['device sweep ›', 'devices ›']
      : route === 'DELETE /devices/{id}'
        ? [
            'cooks lifecycle ›',
            'device claim ›',
            'device release ›',
            'device release ›',
            'device release ›',
            'device revoke ›',
            'devices ›',
            'devices ›',
            'temperatures ›',
          ]
        : route === 'POST /devices/claim'
          ? [
              'cooks lifecycle ›',
              'device claim ›',
              'device release ›',
              'device revoke ›',
              'devices ›',
              'temperatures ›',
            ]
          : route === 'GET /devices/{id}'
            ? [
                'device claim ›',
                'device release ›',
                'devices ›',
                // HAR-140: in connection-string mode a standing device shows
                // no claim code, so each of its groups checks the caller holds it.
                'device twin ›',
                'signalr isolation ›',
                'signalr live temperature ›',
                'telemetry round-trip ›',
                'cook chart ›',
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
        expect(failure).toMatch(new RegExp(`${escape(route)}( \\(peer\\))? → 503`));
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
      // HAR-63, HAR-67: the live-temperature and isolation groups negotiate
      // too; HAR-142: so does the device release group.
      expect(result.failures).toHaveLength(4);
      for (const group of [
        'device release ›',
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
      negotiateUnavailableReason: 'signalr_generate_token_status_429',
    });

    expect(result.exitCode).not.toBe(0);
    // HAR-63, HAR-67: the live-temperature and isolation groups negotiate too,
    // and report it the same way; HAR-142: so does the device release group.
    expect(result.failures).toHaveLength(4);
    expect(result.failures[0]).toContain('FAIL device release › POST /negotiate returns 200');
    expect(result.failures[1]).toContain('FAIL signalr isolation › the owner negotiates');
    expect(result.failures[2]).toContain(
      'FAIL signalr live temperature › POST /negotiate returns 200'
    );
    expect(result.failures[3]).toContain(
      'FAIL signalr negotiate › POST /negotiate returns a url and an accessToken'
    );
    for (const failure of result.failures) {
      expect(failure).toContain('POST /negotiate → 503');
      expect(failure).toContain(
        'expected 200, got 503 (SIGNALR_UNAVAILABLE); reason signalr_generate_token_status_429'
      );
    }
  });

  it('(b) HAR-81: a request charge on POST /negotiate fails the negotiate proof', async () => {
    // negotiate must read no devices; a charge means a Cosmos read came back.
    const result = await runAgainstStub({ negotiateCharge: '2.66' });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(
      'FAIL signalr negotiate › POST /negotiate returns a url and an accessToken'
    );
    expect(result.failures[0]).toContain('negotiate reported a request charge');
  });

  it('(b) HAR-59: a reason that is not a fixed signalr_ code is not printed', async () => {
    const result = await runAgainstStub({
      negotiateUnavailableReason:
        'PUT https://acct.service.signalr.net/api/hubs failed for tid:oid',
    });

    expect(result.exitCode).not.toBe(0);
    // HAR-77: the spec's reason pattern refuses it before the proof looks; the
    // contract line names the field, never its value.
    expect(result.failures[0]).toContain(
      'POST /negotiate → 503: contract: POST /negotiate (negotiate) 503: the body does not match the schema: /reason must match pattern'
    );
    expect(result.output).not.toContain('acct.service.signalr.net');
    expect(result.output).not.toContain('tid:oid');
  });

  it('(b) HAR-57: fails the connect proof when SignalR refuses the token, printing neither token nor url', async () => {
    const result = await runAgainstStub({ signalRRejectsToken: true });

    expect(result.exitCode).not.toBe(0);
    // HAR-63, HAR-67: the live-temperature and isolation groups connect too;
    // HAR-142: so does the device release group.
    expect(result.failures).toHaveLength(4);
    expect(result.failures[0]).toContain('FAIL device release › POST /negotiate returns 200');
    expect(result.failures[1]).toContain('FAIL signalr isolation › the owner negotiates');
    expect(result.failures[2]).toContain(
      'FAIL signalr live temperature › POST /negotiate returns 200'
    );
    expect(result.failures[3]).toContain('FAIL signalr negotiate › a SignalR client connects');
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

  /** HAR-85: each DELETE /devices/{id} the run sent, in order: the device id
   *  and who sent it. */
  const deviceDeletes = () =>
    stub!.requests
      .filter(r => r.method === 'DELETE' && r.path.startsWith('/api/devices/'))
      .map(r => ({
        id: decodeURIComponent(r.path.slice('/api/devices/'.length)),
        as: r.authorization === `Bearer ${PEER_TOKEN}` ? 'peer' : 'owner',
      }));

  it('(a) HAR-85: every proof deletes the device it registered; the peer cannot', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    const deletes = deviceDeletes();
    const own = deletes.find(d => d.id.startsWith('acceptance-device-'))?.id;
    expect(own).toMatch(/^acceptance-device-\d/);
    const released = expect.stringMatching(/^acceptance-release-\d/);
    expect(deletes).toEqual([
      { id: expect.stringMatching(/^acceptance-cook-\d/), as: 'owner' },
      // HAR-142: the claim group's cleanup; the release group's release by the
      // owner, the peer's after it re-claimed, and the control's cleanup; the
      // revoke group's cleanup.
      { id: expect.stringMatching(/^acceptance-claim-\d/), as: 'owner' },
      { id: released, as: 'owner' },
      { id: released, as: 'peer' },
      { id: expect.stringMatching(/^acceptance-control-\d/), as: 'owner' },
      { id: expect.stringMatching(/^acceptance-revoke-\d/), as: 'owner' },
      { id: own, as: 'peer' },
      { id: own, as: 'owner' },
      { id: own, as: 'owner' },
      { id: expect.stringMatching(/^acceptance-temp-\d/), as: 'owner' },
    ]);
    // Only the standing simulated and chart devices are left.
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
    // 403 to the peer, 204 then 404 to the owner, each with its RU; the GET
    // between them is 404.
    const deleteLines = result.lines.filter(line =>
      /^\s+DELETE\s+\/devices\/\{id\}(\s+\(peer\))?\s+\d{3}\s/.test(line)
    );
    expect(deleteLines.map(line => /\s(\d{3})\s/.exec(line)?.[1])).toEqual([
      '204',
      '204',
      '204',
      '204',
      '204',
      '204',
      '403',
      '204',
      '404',
      '204',
    ]);
    expect(deleteLines.filter(line => !line.endsWith('RU 9.71'))).toEqual([]);
    expect(deleteLines[3]).toContain('(peer)');
    expect(deleteLines[6]).toContain('(peer)');
    for (const step of [
      'PASS devices › DELETE /devices/{id} as the peer is 403 DEVICE_NOT_OWNED and the device stays',
      'PASS devices › DELETE /devices/{id} deletes the caller’s device',
      'PASS devices › GET /devices/{id} is 404 after the delete',
      'PASS devices › DELETE /devices/{id} again is 404 DEVICE_NOT_FOUND',
      'PASS devices › always: acceptance-device-<runId> is released and its enrollment and hub identity deleted',
      'PASS temperatures › always: acceptance-temp-<runId> is released and its enrollment and hub identity deleted',
      'PASS cooks lifecycle › always: acceptance-cook-<runId> is released and its enrollment and hub identity deleted',
    ]) {
      expect(result.lines).toContain(step);
    }
    // HAR-140: each fresh device was enrolled, claimed with the code it
    // minted, and deleted from the fake DPS and hub; no code reached the log.
    const scriptsOf = (label: string) => {
      const id = new RegExp(`^acceptance-${label}-\\d`);
      return stub!.scriptRuns.filter(r => id.test(r.args[r.args.indexOf('--device-id') + 1]));
    };
    for (const label of ['cook', 'claim', 'release', 'control', 'device', 'temp']) {
      const runs = scriptsOf(label);
      expect(runs.map(r => r.script)).toEqual(['enrol-device.sh', 'delete-device.sh']);
      expect(runs[1].args).toEqual(expect.arrayContaining(['--only-prefix', 'acceptance-']));
    }
    // HAR-142: the revoked device is revoked twice before it is deleted.
    expect(scriptsOf('revoke').map(r => r.script)).toEqual([
      'enrol-device.sh',
      'revoke-device.sh',
      'revoke-device.sh',
      'delete-device.sh',
    ]);
    expect(stub!.enrolledIds()).toEqual([]);
    expect(stub!.revokedIds()).toEqual([]);
    // The owner's seven fresh claims; the peer's re-claim is its own line.
    expect(
      result.lines.filter(line => /^\s+POST\s+\/devices\/claim\s+201\s/.test(line))
    ).toHaveLength(7);
    expect(
      result.lines.filter(line => /^\s+POST\s+\/devices\/claim\s+\(peer\)\s+201\s/.test(line))
    ).toHaveLength(1);
    expect(
      result.lines.filter(line => /delete-device\.sh .* exit 0 .*  deleted acceptance-/.test(line))
    ).toHaveLength(7);
    // One code each, and a second for the released device after its release.
    expect(stub!.mintedCodes).toHaveLength(8);
    for (const code of stub!.mintedCodes) expect(result.output).not.toContain(code);
    expect(result.output).not.toContain('BEGIN CERTIFICATE');
    expect(result.output).not.toContain('PRIVATE KEY');
    expect(result.output).not.toContain('"claimCode"');
    // The standing simulated and chart devices are there from the start, and
    // are not swept.
    expect(result.output).toMatch(/^METRIC acceptance-devices-before 2$/m);
    expect(result.output).toMatch(/^METRIC acceptance-devices-swept 0$/m);
  });

  it('(a) HAR-85: the sweep deletes every acceptance-* device an earlier run left, first', async () => {
    const left = [
      'acceptance-20261119101500-aa11bb',
      'acceptance-temp-20261119101500-aa11bb',
      'acceptance-cook-20261119101500-aa11bb',
      'acceptance-20261118090000-cc22dd',
    ];
    const result = await runAgainstStub({ devicesAtStart: [...left, 'backyard-smoker'] });

    expect(result.failures).toEqual([]);
    // The sweep runs before any other group: its deletes come first.
    expect(deviceDeletes().slice(0, left.length)).toEqual(left.map(id => ({ id, as: 'owner' })));
    expect(result.output).toMatch(/^METRIC acceptance-devices-before 7$/m);
    expect(result.output).toMatch(/^METRIC acceptance-devices-swept 4$/m);
    expect(result.output).toMatch(/^METRIC acceptance-devices-after 3$/m);
    const sweepStarts = result.lines.indexOf(
      'RUN  device sweep › DELETE /devices/{id} and delete-device.sh for every acceptance-* device an earlier run left'
    );
    expect(sweepStarts).toBeGreaterThanOrEqual(0);
    expect(sweepStarts).toBeLessThan(
      result.lines.findIndex(line => line.startsWith('RUN  cooks lifecycle ›'))
    );
    // HAR-140: each one is handed to delete-device.sh after its release;
    // none of them ever had an enrollment.
    expect(stub!.scriptRuns.slice(0, left.length)).toEqual(
      left.map(id => ({
        script: 'delete-device.sh',
        args: [
          '--device-id',
          id,
          '--only-prefix',
          'acceptance-',
          '--auth-type',
          'login',
          '--dps',
          DPS_HOST,
          '--hub',
          HUB_HOST,
        ],
      }))
    );
    left.forEach(id => expect(result.output).toContain(`already deleted ${id}`));
    // A device that is not an acceptance device stays, as do the standing ones.
    expect(stub!.deviceIds()).toEqual(['backyard-smoker', SIM_DEVICE, CHART_DEVICE].sort());
  });

  it('(a) HAR-136: the sweep stops a cook an earlier run left active before it releases the device', async () => {
    const left = 'acceptance-cook-20261119101500-aa11bb';
    const result = await runAgainstStub({ devicesAtStart: [left], activeCookAtStartOn: [left] });

    expect(result.failures).toEqual([]);
    expect(deviceDeletes()[0]).toEqual({ id: left, as: 'owner' });
    const sweepCalls = stub!.requests
      .filter(r => r.path.includes(encodeURIComponent(left)) || r.path.endsWith('/stop'))
      .map(
        r => `${r.method} ${r.path.replace(/\/api\/cooks\/[^/]+\/stop$/, '/api/cooks/{id}/stop')}`
      )
      .slice(0, 3);
    // List the device's active cooks, stop the one found, then release.
    expect(sweepCalls).toEqual([
      `GET /api/cooks?deviceId=${left}&status=active`,
      'POST /api/cooks/{id}/stop',
      `DELETE /api/devices/${left}`,
    ]);
    expect(stub!.deviceIds()).not.toContain(left);
  });

  it('(b) HAR-136: a release with a cook still active is 409 COOK_ACTIVE, so the lifecycle cleanup stops it first', async () => {
    // The chart step fails, so the lifecycle's own stop is skipped and its
    // cook is still active when the always-run cleanup releases the device.
    const result = await runAgainstStub({ chartFault: 'bad-body' });

    expect(result.failures).toHaveLength(1);
    expect(result.lines).toContain(
      'PASS cooks lifecycle › always: acceptance-cook-<runId> is released and its enrollment and hub identity deleted'
    );
    const cleanup = deviceDeletes().find(d => d.id.startsWith('acceptance-cook-'));
    expect(cleanup).toEqual({ id: expect.stringMatching(/^acceptance-cook-/), as: 'owner' });
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
  });

  it('HAR-85: the sweep never deletes the standing simulated or chart device, whatever its id', async () => {
    const standing = ['acceptance-standing-sim', 'acceptance-standing-chart'];
    // The stub's own chart device is replaced by `standing[1]`.
    stub = await startStub({
      devicesAtStart: [...standing, 'acceptance-old-run'],
      chartCook: 'none',
    });
    deviceScriptsDir = writeFakeDeviceScripts();
    const result = await run(
      {
        ACCEPTANCE_BASE_URL: stub.baseUrl,
        ACCEPTANCE_BEARER_TOKEN: TOKEN,
        ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
        ...simEnv(),
        ACCEPTANCE_SIM_DEVICE_ID: standing[0],
        ACCEPTANCE_CHART_DEVICE_ID: standing[1],
        SIMDEVICE_CHART_CONNECTION_STRING: SIM_CONNECTION_STRING,
        ...dpsEnv,
      },
      [sweepGroup]
    );

    expect(result.failures).toEqual([]);
    expect(deviceDeletes()).toEqual([{ id: 'acceptance-old-run', as: 'owner' }]);
    // HAR-140: and only it is handed to delete-device.sh.
    expect(stub.scriptRuns.map(r => r.args[r.args.indexOf('--device-id') + 1])).toEqual([
      'acceptance-old-run',
    ]);
    expect(stub.deviceIds()).toEqual([...standing, SIM_DEVICE].sort());
  });

  it('(b) HAR-85: a failed step still deletes the device its group registered', async () => {
    const result = await runAgainstStub({
      failRoute: { route: 'PATCH /devices/{id}', status: 503 },
    });

    expect(result.failures).toHaveLength(1);
    expect(result.lines).toContain(
      'PASS devices › always: acceptance-device-<runId> is released and its enrollment and hub identity deleted'
    );
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
  });

  it('(b) HAR-85: fails when the peer can delete the owner’s device', async () => {
    const result = await runAgainstStub({ deviceDeleteFault: 'peer-deletes' });

    expect(result.exitCode).not.toBe(0);
    // The always-run cleanup then finds the device gone: 404, not its 204.
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toContain(
      'FAIL devices › DELETE /devices/{id} as the peer is 403 DEVICE_NOT_OWNED and the device stays'
    );
    expect(result.failures[1]).toContain(
      'FAIL devices › always: acceptance-device-<runId> is released and its enrollment and hub identity deleted — DELETE /devices/{id} → 404: expected 204, got 404'
    );
    expect(result.failures[0]).toContain(
      'DELETE /devices/{id} (peer) → 204: expected 403, got 204'
    );
  });

  it('(b) HAR-85: fails when a delete answers 204 but the device is still there', async () => {
    const result = await runAgainstStub({ deviceDeleteFault: 'keeps' });

    expect(result.exitCode).not.toBe(0);
    // The devices group sees its device again; the sweep is clean (nothing
    // left by an earlier run), and the other groups only DELETE. HAR-142: the
    // release group reads its released device's current reading as the old
    // owner, which it still holds.
    expect(result.failures).toEqual([
      expect.stringContaining(
        'FAIL device release › DELETE /devices/{id} releases acceptance-release-<runId> (204), and GET /temperatures/current/{id} as the old owner is 404 — GET /temperatures/current/{deviceId} → 404: body.error is "NO_READINGS", not DEVICE_NOT_FOUND'
      ),
      expect.stringContaining(
        'FAIL devices › GET /devices/{id} is 404 after the delete — GET /devices/{id} → 200: expected 404, got 200'
      ),
    ]);
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
      : // HAR-142: the release group reads the released device's current
        // reading as its old owner.
        ['FAIL device release ›', 'FAIL signalr isolation ›', 'FAIL device twin ›']),
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
      // HAR-142: so must the old owner's read of a released device.
      const release = result.failures.filter(line => line.startsWith('FAIL device release ›'));
      expect(release).toHaveLength(answered === 'DEVICE_NOT_FOUND' ? 0 : 1);
      expect(result.failures).toHaveLength(failures.length + isolation.length + release.length);
    }
  );

  it.each([
    [
      'still has the pre-HAR-75 total and offset',
      { readings: [], total: 0, offset: 0, limit: 100, hasMore: false },
      // HAR-77: the contract refuses the extra fields before the proof looks.
      "(root) must NOT have additional properties 'total'; (root) must NOT have additional properties 'offset'",
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
      ...chartEnv,
      ...dpsEnv,
    };
    const scripts = writeFakeDeviceScripts();
    const first = await runAcceptance({
      env,
      write: () => undefined,
      runId: `r-${randomUUID()}`,
      deviceScriptsDir: scripts,
    });
    const lines: string[] = [];
    const second = await runAcceptance({
      env,
      write: line => lines.push(line),
      runId: `r-${randomUUID()}`,
      deviceScriptsDir: scripts,
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
    // HAR-87: the cook-chart group lists the chart device's active cooks.
    const chart = result.failures.filter(line => line.startsWith('FAIL cook chart ›'));
    expect(chart).toHaveLength(route === 'GET /cooks' ? 1 : 0);
    const lifecycle = result.failures.filter(line => line.startsWith('FAIL cooks lifecycle ›'));
    expect(lifecycle).toHaveLength(lifecycleFailures(route, false));
    expect(result.failures).toHaveLength(lifecycle.length + 1 + twin.length + chart.length);
    expect(result.failures[0]).toContain('cooks lifecycle ›');
    expect(result.failures[result.failures.length - 1 - chart.length]).toContain(
      'signalr isolation ›'
    );
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

  it('HAR-140: in DPS mode every device is claimed with its own code, the standing ones once per run', async () => {
    // Real children throughout: the fake scripts check what the runner hands
    // a real process (its arguments, its environment, an executable path).
    inProcessChildren = false;
    const result = await runAgainstStub({}, 'ok', undefined, 'dps');

    expect(result.failures).toEqual([]);
    const claims = result.lines
      .filter(line => /^\s+POST\s+\/devices\/claim\s+\d{3}\s+\d+ ms/.test(line))
      .map(line => /\s(\d{3})\s/.exec(line)?.[1]);
    // In file order: the three fresh devices are new (201: cooks lifecycle,
    // devices, temperatures); the owner already held the simulated device
    // (200, device twin), and its later groups claim it again with the same
    // code (200: isolation, live temperature, round trip); the chart device
    // was held too (200). HAR-142: between them, the owner's claims in the
    // claim group (three refusals, the claim, its retry), the release group
    // (both devices, then the old code after the release) and the revoke
    // group; the peer's claims are lines of their own.
    expect(claims).toEqual([
      '201',
      ...['403', '403', '403', '201', '200'],
      ...['201', '201', '403'],
      '201',
      ...['200', '201', '200', '200', '200', '201', '200'],
    ]);
    expect(stub!.requests.filter(r => r.method === 'POST' && r.path === '/api/devices')).toEqual(
      []
    );
    // The simulated device's code is read once: its first claim; later
    // groups reuse it without another twin sync or read.
    const readsOf = (label: string) =>
      result.lines.filter(line => new RegExp(`^\\s+EXEC\\s+${label} claim-code\\s`).test(line));
    expect(readsOf('simdevice')).toHaveLength(1);
    expect(readsOf('simdevice \\(chart\\)')).toHaveLength(1);
    expect(stub!.mintedCodes.length).toBeGreaterThanOrEqual(5);
    for (const code of stub!.mintedCodes) expect(result.output).not.toContain(code);
    expect(result.output).not.toContain('"claimCode"');
    // Neither standing device is released.
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
  });

  it('starts each run with a fresh synthetic device, so reruns never collide', async () => {
    stub = await startStub();
    const env = {
      ACCEPTANCE_BASE_URL: stub.baseUrl,
      ACCEPTANCE_BEARER_TOKEN: TOKEN,
      ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
      ...simEnv(),
      ...chartEnv,
      ...dpsEnv,
    };
    const scripts = writeFakeDeviceScripts();
    const first = await runAcceptance({
      env,
      write: () => undefined,
      runId: `r-${randomUUID()}`,
      deviceScriptsDir: scripts,
    });
    const lines: string[] = [];
    const second = await runAcceptance({
      env,
      write: line => lines.push(line),
      runId: `r-${randomUUID()}`,
      deviceScriptsDir: scripts,
    });

    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
    // HAR-44: the standing simulated device is reused, never registered again.
    // HAR-140: in connection-string mode it shows no claim code, so the GET
    // proves it is the caller's; nothing calls POST /devices.
    expect(lines.some(line => /^\s+GET\s+\/devices\/\{id\}\s+200\s/.test(line))).toBe(true);
    expect(lines.some(line => /^\s+POST\s+\/devices\s/.test(line))).toBe(false);
    expect(lines).toContain(
      'PASS telemetry round-trip › POST /devices/claim claims the simulated device for the caller'
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
      'POST /devices/claim claims the simulated device for the caller',
      'simdevice --count 1 sends one reading through IoT Hub',
      'GET /temperatures/current/{deviceId} returns the sent reading',
      'GET /temperatures/history holds the sent reading',
    ]) {
      expect(result.lines).toContain(`PASS ${GROUP} ${step}`);
    }
    // HAR-120: on the fake clock the round trip is exactly the three poll
    // intervals slept between the send and the fourth poll.
    expect(result.lines.filter(line => line.startsWith('METRIC roundtrip-ms '))).toEqual([
      `METRIC roundtrip-ms ${3 * ROUNDTRIP_POLL.intervalMs}`,
    ]);
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
    // HAR-120: exactly five minutes before the send's sentAt, which is the fake
    // time when the send was reported (the last of the run's `--count 1` sends).
    const sentAt = stub!.sendTimes[stub!.sendTimes.length - 1];
    expect(sentAt).toBeDefined();
    expect(history.map(params => params.get('startTime'))).toEqual([
      new Date(sentAt - 5 * 60 * 1000).toISOString(),
      new Date(sentAt - 5 * 60 * 1000).toISOString(),
    ]);
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
    expect(failures[0]).toContain(
      `GET /temperatures/current/{deviceId} → 200: the reading sent at ` +
        `${new Date(stub!.sendTimes[stub!.sendTimes.length - 1]).toISOString()} ` +
        `(timestamp ${SIM_TIMESTAMP}) was not readable within the 120 s cap; last status 200, ` +
        `last timestamp seen "${OLDER_READINGS[2]}"`
    );
    // HAR-120: the live pacing, on the fake clock: a poll at 0 s, then one
    // every 1 s up to the 120 s cap, 121 in all, 120 intervals slept.
    const polls = stub!.requests.filter(
      r =>
        r.path === `/api/temperatures/current/${SIM_DEVICE}` &&
        r.authorization === `Bearer ${TOKEN}`
    );
    expect(polls).toHaveLength(1 + 121);
    expect(fakeClock.slept.filter(ms => ms === ROUNDTRIP_POLL.intervalMs)).toHaveLength(120);
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

  it('(f) fails when the simulated device is registered to someone else (GET 404)', async () => {
    const result = await runAgainstStub({ simOwnedByOther: true });

    expect(result.exitCode).not.toBe(0);
    const failures = telemetryFailures(result);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('POST /devices/claim claims the simulated device for the caller');
    expect(failures[0]).toContain('GET /devices/{id} → 404');
    expect(failures[0]).toContain("is not the caller's (expected 200, got 404)");
    // simdevice was never run for someone else's device.
    // HAR-140: the fresh devices run simdevice as themselves; the simulated
    // device never runs.
    expect(result.output).not.toMatch(/^\s+EXEC\s+simdevice\s(?!\()/m);
  });
});

describe('signalr live temperature (HAR-63, against the stub and a fake simdevice)', () => {
  const GROUP = 'signalr live temperature ›';
  const STEPS = [
    'POST /devices/claim claims the simulated device for the caller',
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
    // HAR-77: a wrong type the proof's own checks pass over; the contract does not.
    [
      'wrong-type',
      'contract: hub message temperature: the message does not match the schema: /grillTemp must be number',
    ],
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

describe('device claim, release and revoke (HAR-142, against the stub and a fake simdevice)', () => {
  const runClaims = (options: StubOptions = {}) =>
    runAgainstStub(options, 'ok', [claimGroup, releaseGroup, revokeGroup]);

  it('(a) passes every step, leaves nothing behind, and prints no code, key or claim body', async () => {
    const result = await runClaims();

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    for (const step of [
      'PASS device claim › a fresh device acceptance-claim-<runId> is enrolled through DPS and shows an unclaimed code',
      'PASS device claim › POST /devices/claim for a guessed id, acceptance-guess-<runId>, never enrolled, is 403 CLAIM_REFUSED',
      'PASS device claim › POST /devices/claim for the enrolled, unclaimed device without its code is 403, the same body',
      'PASS device claim › POST /devices/claim with its code one symbol changed is 403, the same body',
      'PASS device claim › POST /devices/claim with its own code is then 201: a wrong code does not burn the right one',
      'PASS device claim › GET /devices/{id} as the owner reads it back with claimedAt',
      'PASS device claim › POST /devices/claim again with the same code is 200, the device unchanged',
      'PASS device claim › POST /devices/claim as the peer with the consumed code is 403, the same body',
      'PASS device claim › POST /devices/claim as the peer with a fresh well-formed guess is 403, the same body',
      'PASS device claim › GET /devices/{id} as the peer is 404',
      'PASS device claim › all five refusals were the same 403 body, with no request charge: no answer tells the cases apart',
      'PASS device claim › always: acceptance-claim-<runId> is released and its enrollment and hub identity deleted',
      'PASS device release › a reading from acceptance-release-<runId> reaches the owner while the owner holds it',
      'PASS device release › DELETE /devices/{id} releases acceptance-release-<runId> (204), and GET /temperatures/current/{id} as the old owner is 404',
      'PASS device release › its next reading never reaches the old owner, while a later reading from the owner’s control device does',
      'PASS device release › POST /devices/claim with the code it was claimed with before the release is 403 CLAIM_REFUSED',
      'PASS device release › after a twin sync it shows a new code, and the peer claims it with that code (201): ownership moved',
      'PASS device release › DELETE /devices/{id} as the peer releases it again (204)',
      'PASS device revoke › revoke-device.sh revokes it: exit 0, "revoked acceptance-revoke-<runId>"',
      'PASS device revoke › simdevice --count 1 as the revoked device is refused by the hub and by DPS: it exits non-zero and sends nothing',
      'PASS device revoke › revoke-device.sh again prints "already revoked acceptance-revoke-<runId>"',
      'PASS device revoke › always: acceptance-revoke-<runId> is released and its enrollment and hub identity deleted',
    ]) {
      expect(result.lines).toContain(step);
    }
    // Each refusal is a 403 with no RU; the peer's are marked as the peer's.
    const refusals = result.lines.filter(line =>
      /^\s+POST\s+\/devices\/claim(\s+\(peer\))?\s+403\s/.test(line)
    );
    expect(refusals).toHaveLength(6);
    expect(refusals.filter(line => line.includes('(peer)'))).toHaveLength(2);
    expect(refusals.every(line => / RU -$/.test(line))).toBe(true);

    // The released device's first reading went to the owner, its next to no
    // one; the control's to the owner; the revoked device's was refused.
    const sends = stub!.freshSends.map(({ deviceId, ...rest }) => ({
      device: deviceId.replace(/-\d{14}-[0-9a-f]{6}$/, ''),
      ...rest,
    }));
    expect(sends).toEqual([
      { device: 'acceptance-release', pushedTo: 'owner' },
      { device: 'acceptance-release' },
      { device: 'acceptance-control', pushedTo: 'owner' },
      { device: 'acceptance-revoke', refused: true },
    ]);
    // HAR-120: the window after the control's reading ran its live 15 s.
    expect(fakeClock.slept).toContain(RELEASE_WAIT.graceMs);
    expect(RELEASE_WAIT).toEqual({ capMs: 90_000, graceMs: 15_000 });

    // Nothing is left: no device, no enrollment, no revoked identity.
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
    expect(stub!.enrolledIds()).toEqual([]);
    expect(stub!.revokedIds()).toEqual([]);
    // The revoked device's refusal is its own failure line, the last on stderr.
    expect(
      result.lines.find(line =>
        /^\s+EXEC\s+simdevice \(acceptance-revoke-\S+\) --count 1 /.test(line)
      )
    ).toMatch(/ exit 1 /);
    // No code (right or wrong), key, certificate or claim body is printed.
    expect(stub!.mintedCodes).toHaveLength(5);
    for (const code of stub!.mintedCodes) expect(result.output).not.toContain(code);
    expect(result.output).not.toMatch(
      /[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/
    );
    expect(result.output).not.toContain('"claimCode"');
    expect(result.output).not.toContain('PRIVATE KEY');
    expect(result.output).not.toContain('BEGIN CERTIFICATE');
    expect(result.output).not.toContain(SIGNALR_CLIENT_TOKEN);
  });

  it('(b) fails the guessed-id step when a refusal tells an unknown id apart', async () => {
    const result = await runClaims({ claimOracle: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toEqual([
      expect.stringContaining(
        'FAIL device claim › POST /devices/claim for a guessed id, acceptance-guess-<runId>, never enrolled, is 403 CLAIM_REFUSED — POST /devices/claim → 403: body.error is "DEVICE_NOT_FOUND", not CLAIM_REFUSED'
      ),
    ]);
    // The cleanup still ran: the device was never claimed, so 204 or 404 is fine.
    expect(result.lines).toContain(
      'PASS device claim › always: acceptance-claim-<runId> is released and its enrollment and hub identity deleted'
    );
    expect(stub!.enrolledIds()).toEqual([]);
  });

  it('(b) fails when a released device still reaches its old owner, and still cleans up', async () => {
    const result = await runClaims({ releaseLeaks: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(
      /^FAIL device release › its next reading never reaches the old owner, while a later reading from the owner’s control device does — simdevice \(acceptance-control-\S+\) → exit 0: after the release the old owner received 1 reading\(s\) from acceptance-release-\S+ \(timestamp "[^"]+"; the next one sent was [^)]+\)$/
    );
    expect(result.lines).toContain(
      'SKIP device release › the SignalR connection stops (an earlier proof in this group failed)'
    );
    for (const cleanup of [
      'PASS device release › always: acceptance-release-<runId> is released by whoever holds it and its enrollment and hub identity deleted',
      'PASS device release › always: acceptance-control-<runId> is released and its enrollment and hub identity deleted',
    ]) {
      expect(result.lines).toContain(cleanup);
    }
    // The failure stopped the connection itself.
    const calls = stub!.signalRRequests.map(r => `${r.method} ${r.path.split('?')[0]}`);
    expect(calls.filter(call => call === 'DELETE /client/')).toHaveLength(
      calls.filter(call => call === 'POST /client/negotiate').length
    );
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
    expect(stub!.enrolledIds()).toEqual([]);
  });

  it('(b) fails when a revoked device is still accepted, and still releases and deletes it', async () => {
    const result = await runClaims({ revokeIgnored: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(
      /^FAIL device revoke › simdevice --count 1 as the revoked device is refused by the hub and by DPS: it exits non-zero and sends nothing — simdevice \(acceptance-revoke-\S+\) → exit 0: simdevice as the revoked acceptance-revoke-\S+ exited 0 and printed 1 reading\(s\): the revoked device was accepted$/
    );
    expect(result.lines).toContain(
      'PASS device revoke › always: acceptance-revoke-<runId> is released and its enrollment and hub identity deleted'
    );
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
    expect(stub!.enrolledIds()).toEqual([]);
  });
  it('HAR-120: the release proof gives up on the first reading at exactly its 90 s cap', async () => {
    const result = await runAgainstStub({ freshPushDropped: 'release' }, 'ok', [releaseGroup]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(
      /^FAIL device release › a reading from acceptance-release-<runId> reaches the owner while the owner holds it — simdevice \(acceptance-release-\S+\) → exit 0: sent a reading as acceptance-release-\S+ \(timestamp [^)]+\), but it did not reach the owner: nothing within the 90 s cap; the connection is Connected$/
    );
    expect(fakeClock.slept).toEqual([RELEASE_WAIT.capMs]);
    expect(fakeClock.deadlines()).toEqual([]);
    expect(stub!.freshSends.map(send => send.dropped)).toEqual([true]);
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
    expect(stub!.enrolledIds()).toEqual([]);
  });

  it('HAR-120: the release proof gives up on the control device’s reading at exactly its 90 s cap, before any grace', async () => {
    const result = await runAgainstStub({ freshPushDropped: 'control' }, 'ok', [releaseGroup]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(
      /^FAIL device release › its next reading never reaches the old owner, while a later reading from the owner’s control device does — simdevice \(acceptance-control-\S+\) → exit 0: the control device's reading \(timestamp [^)]+\) did not reach the owner, so the path to the owner was not shown to work: nothing within the 90 s cap; the connection is Connected$/
    );
    expect(fakeClock.slept).toEqual([RELEASE_WAIT.capMs]);
    expect(fakeClock.deadlines()).toEqual([]);
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
    expect(stub!.enrolledIds()).toEqual([]);
  });

  it('a revoked device whose simdevice never exits is killed at exactly 120 s, and still released and deleted', async () => {
    const running = runAgainstStub({ revokedSendHangs: true }, 'ok', [revokeGroup]);
    await fakeClock.armed(REVOKED_SEND_KILL_MS);
    // The kill only once the stub has answered the send, so no request is left open.
    await stub!.whenSendHung();
    expect(fakeClock.deadlines()).toEqual([REVOKED_SEND_KILL_MS]);
    fakeClock.advance(REVOKED_SEND_KILL_MS);
    const result = await running;

    expect(REVOKED_SEND_KILL_MS).toBe(120_000);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(
      /^FAIL device revoke › simdevice --count 1 as the revoked device is refused by the hub and by DPS: it exits non-zero and sends nothing — simdevice \(acceptance-revoke-\S+\) → exit killed: simdevice as the revoked acceptance-revoke-\S+ did not exit within its 120000 ms limit and was killed: it should be refused at once$/
    );
    expect(stub!.freshSends.map(send => send.hung)).toEqual([true]);
    expect(result.lines).toContain(
      'PASS device revoke › always: acceptance-revoke-<runId> is released and its enrollment and hub identity deleted'
    );
    expect(stub!.deviceIds()).toEqual([SIM_DEVICE, CHART_DEVICE].sort());
    expect(stub!.enrolledIds()).toEqual([]);
  });
});

describe('device twin (HAR-68, against the stub and a fake simdevice)', () => {
  const GROUP = 'device twin ›';
  const STEPS = [
    'POST /devices/claim claims the simulated device for the owner',
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

  it('(d) HAR-120: fails naming the 90 s cap when the reading never reaches the current reading, and still stops the cook', async () => {
    const result = await runTwin({ twinReadingNeverRouted: true });

    expectFailedAt(
      result,
      4,
      `GET /temperatures/current/{deviceId} → 200: the reading with timestamp ${TWIN_TIMESTAMP} ` +
        `was not readable within the 90 s cap; last status 200, last timestamp seen ` +
        `"${SIM_TIMESTAMP}"`
    );
    // The live pacing on the fake clock: a poll at 0 s, then one every 2 s up
    // to the 90 s cap.
    const polls = stub!.requests.filter(r => r.path === `/api/temperatures/current/${SIM_DEVICE}`);
    expect(polls).toHaveLength(1 + 90 / 2);
    expect(fakeClock.slept).toEqual(Array.from({ length: 90 / 2 }, () => TWIN_POLL.intervalMs));
  });
});

describe('signalr isolation (HAR-67, against the stub and a fake simdevice)', () => {
  const GROUP = 'signalr isolation ›';
  const STEPS = [
    'POST /devices/claim claims the simulated device for the owner',
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
  /** The isolation group's two connections, the owner's then the peer's:
   *  the peer's is the run's only one, and the owner's opens just before it
   *  (HAR-142: the device release group opens one earlier). */
  const isolationConnections = () => {
    const negotiates = stub!.signalRRequests.filter(
      r => r.method === 'POST' && r.path.startsWith('/client/negotiate')
    );
    const peer = negotiates.findIndex(
      r => r.authorization === `Bearer ${PEER_SIGNALR_CLIENT_TOKEN}`
    );
    expect(peer).toBeGreaterThan(0);
    return negotiates.slice(peer - 1, peer + 1);
  };
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
    // HAR-120: both grace windows ran their live 15 s on the fake clock
    // (HAR-142: and the device release group's window, a third).
    expect(fakeClock.slept.filter(ms => ms === 15_000)).toHaveLength(3);
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
    // HAR-140: the simulated device's runs only; fresh devices run as themselves.
    const execs = result.lines.filter(line => /^\s+EXEC\s+simdevice\s(?!\()/.test(line));
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
    expect(failures[0]).toContain('after the 900 s cap');
    // HAR-120: the live pacing on the fake clock: a read at 0 s, then one every
    // 10 s up to the 15 min cap.
    expect(stub!.drainTotals).toHaveLength(1 + 900 / 10);
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
    let killedAfterMs: number | undefined;
    const running = runAcceptance({
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
                ({ exitCode, killedAfterMs } = await api.runSimDevice(['--count', '1'], {
                  timeoutMs: 200,
                }));
              },
            },
          ],
        },
      ],
    });
    // HAR-120: the hung child is killed when the fake time reaches the limit,
    // and not before: one tick short, the deadline is still pending.
    await fakeClock.armed(200);
    fakeClock.advance(199);
    expect(fakeClock.deadlines()).toEqual([1]);
    fakeClock.advance(1);
    const result = await running;

    expect(result.exitCode).toBe(0);
    expect(exitCode).toBeNull();
    expect(killedAfterMs).toBe(200);
    expect(lines.some(line => /^\s+EXEC\s+simdevice --count 1\s+exit killed\s/.test(line))).toBe(
      true
    );
  });
});

describe('chart device (HAR-84)', () => {
  const baseEnv = () => ({
    ACCEPTANCE_BASE_URL: stub!.baseUrl,
    ACCEPTANCE_BEARER_TOKEN: TOKEN,
    ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
  });

  /** A one-proof group: send as `device`, then fail with whatever simdevice
   *  printed, so it reaches the failure line and the output. */
  const echoing = (device: 'simulated' | 'chart'): ProofGroup => ({
    name: 'chart device',
    create: () => [
      {
        name: `simdevice as the ${device} device`,
        run: async api => {
          const sent = await api.runSimDevice(['--count', '1'], { device });
          throw new Error(
            `simdevice said ${sent.stderrFirstLine} and ${JSON.stringify(sent.messages)}`
          );
        },
      },
    ],
  });

  it.each<FakeMode>(['leak-stderr', 'leak-stdout'])(
    '(a) never prints the chart connection string or its key when simdevice prints them (%s)',
    async mode => {
      stub = await startStub();
      const result = await run({ ...baseEnv(), ...simEnv(mode), ...chartEnv }, [echoing('chart')]);

      // The leak reached the failure line, and was masked there...
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain('simdevice (chart) → exit');
      expect(result.failures[0]).toContain('[redacted]');
      expect(
        result.lines.some(line => /^\s+EXEC\s+simdevice \(chart\) --count 1\s/.test(line))
      ).toBe(true);
      // ...and nowhere in the output is the credential, its key, or its parts.
      for (const text of [result.output, ...result.failures]) {
        expect(text).not.toContain(CHART_CONNECTION_STRING);
        expect(text).not.toContain(CHART_KEY);
        expect(text).not.toContain('SharedAccessKey=');
        expect(text).not.toContain(`DeviceId=${CHART_DEVICE};`);
      }
    }
  );

  it('(b) hands each simdevice run only the credential of the device it sends as', async () => {
    stub = await startStub();
    const bin = join(fakeDir, 'simdevice-env-report');
    writeFileSync(
      bin,
      `#!${process.execPath}
const conn = process.env.SIMDEVICE_CONNECTION_STRING;
process.stdout.write(JSON.stringify({
  standing: conn === ${JSON.stringify(SIM_CONNECTION_STRING)},
  chart: conn === ${JSON.stringify(CHART_CONNECTION_STRING)},
  chartVariable: process.env.SIMDEVICE_CHART_CONNECTION_STRING !== undefined,
  token: process.env.ACCEPTANCE_BEARER_TOKEN !== undefined,
}) + '\\n');
`
    );
    chmodSync(bin, 0o755);
    const seen: Record<string, unknown> = {};
    let chartDeviceId: string | undefined;
    // In CI the runner's own process environment carries the chart credential.
    process.env['SIMDEVICE_CHART_CONNECTION_STRING'] = CHART_CONNECTION_STRING;
    try {
      const result = await run(
        { ...baseEnv(), ...simEnv(), ACCEPTANCE_SIMDEVICE_BIN: bin, ...chartEnv },
        [
          {
            name: 'chart device',
            create: () => [
              {
                name: 'each device gets its own credential',
                run: async api => {
                  chartDeviceId = api.chartDeviceId;
                  seen['simulated'] = (await api.runSimDevice(['--count', '1'])).messages[0];
                  seen['chart'] = (
                    await api.runSimDevice(['--count', '1'], { device: 'chart' })
                  ).messages[0];
                },
              },
            ],
          },
        ]
      );
      expect(result.failures).toEqual([]);
    } finally {
      delete process.env['SIMDEVICE_CHART_CONNECTION_STRING'];
    }

    expect(chartDeviceId).toBe(CHART_DEVICE);
    expect(seen['simulated']).toEqual({
      standing: true,
      chart: false,
      chartVariable: false,
      token: false,
    });
    expect(seen['chart']).toEqual({
      standing: false,
      chart: true,
      chartVariable: false,
      token: false,
    });
  });

  it('(c) is optional: without it chartDeviceId is undefined and a chart run fails, unstarted', async () => {
    stub = await startStub();
    let chartDeviceId: string | undefined = 'unset';
    const result = await run({ ...baseEnv(), ...simEnv() }, [
      {
        name: 'chart device',
        create: () => [
          {
            name: 'reads the chart device id',
            run: async api => {
              chartDeviceId = api.chartDeviceId;
            },
          },
          {
            name: 'cannot send as an unconfigured chart device',
            run: async api => {
              await api.runSimDevice(['--count', '1'], { device: 'chart' });
            },
          },
        ],
      },
    ]);

    expect(chartDeviceId).toBeUndefined();
    expect(result.failures).toEqual([
      'FAIL chart device › cannot send as an unconfigured chart device — simdevice (chart) → ' +
        'not started: the chart device is not configured: ACCEPTANCE_CHART_DEVICE_ID and ' +
        'SIMDEVICE_CHART_CONNECTION_STRING are not set',
    ]);
  });

  it.each([
    ['ACCEPTANCE_CHART_DEVICE_ID', 'SIMDEVICE_CHART_CONNECTION_STRING'],
    ['SIMDEVICE_CHART_CONNECTION_STRING', 'ACCEPTANCE_CHART_DEVICE_ID'],
  ])('(d) stops at once when %s is set without %s', async (given, absent) => {
    stub = await startStub();
    for (const value of [undefined, '  ']) {
      const result = await run({
        ...baseEnv(),
        ...simEnv(),
        ...chartEnv,
        [absent]: value,
      });

      expect(result.exitCode).toBe(2);
      expect(result.failures).toEqual([
        `acceptance: ${given} is set but ${absent} is not; the chart device needs both or neither`,
      ]);
      expect(result.output).not.toContain(CHART_KEY);
    }
    expect(stub.requests).toHaveLength(0);
  });
});

describe('cook chart (HAR-87, against the stub and a fake simdevice)', () => {
  const GROUP = 'cook chart ›';
  const STEPS = [
    'the chart device is configured (ACCEPTANCE_CHART_DEVICE_ID, SIMDEVICE_CHART_CONNECTION_STRING)',
    'POST /devices/claim claims the chart device for the caller with its own claim code',
    'GET /cooks?deviceId=<chart>&status=active finds the standing cook (POST /cooks starts one when there is none)',
    "GET /cooks/{cookId}/chart: is the standing cook's 12 h covered",
    'simdevice tops the chart device up to 12 h of readings from the cook start when it is not',
    'GET /cooks/{cookId}/chart covers 12 h once the top-up is rolled up',
    `GET /cooks/{cookId}/chart of a 12 h cook costs at most ${CHART_RU_BUDGET} RU`,
  ];
  const metric = (result: Run, name: string) =>
    result.lines.filter(line => line.startsWith(`METRIC ${name} `));
  const chartRequests = (method: string, path: RegExp) =>
    stub!.requests.filter(r => r.method === method && path.test(r.path));
  /** One run of the cook-chart group alone. */
  const runChart = (
    options: StubOptions = {},
    standing: 'connection-string' | 'dps' = 'connection-string'
  ) => runAgainstStub(options, 'ok', [chartGroup], standing);
  /** The stub's chart in 60 s buckets: start minute to last reading's minute. */
  const pointsFor = (startTime: string) => {
    const start = Date.parse(startTime);
    const last = start + (CHART.readings - 1) * CHART.stepSeconds * 1000;
    return Math.floor((last - Math.floor(start / 60_000) * 60_000) / 60_000) + 1;
  };

  it('(a) with no standing cook: claims the device, starts a cook, tops it up once and measures', async () => {
    // HAR-140: in DPS mode, as in CI, so the device shows a claim code.
    const result = await runChart({ chartCook: 'none' }, 'dps');

    expect(result.failures).toEqual([]);
    STEPS.forEach(step => expect(result.lines).toContain(`PASS ${GROUP} ${step}`));
    // Claimed with its own code (201: nobody held it), and the cook started
    // with the standing name. Nothing is registered with POST /devices.
    expect(chartRequests('POST', /^\/api\/devices\/claim$/)).toHaveLength(1);
    expect(result.lines.some(line => /^\s+POST\s+\/devices\/claim\s+201\s/.test(line))).toBe(true);
    expect(chartRequests('POST', /^\/api\/devices$/)).toHaveLength(0);
    expect(stub!.chartRegistered()).toBe(true);
    expect(chartRequests('POST', /^\/api\/cooks$/)).toHaveLength(1);
    const cooks = stub!.chartCooks();
    expect(cooks).toHaveLength(1);
    // It is never stopped.
    expect(cooks[0].status).toBe('active');
    expect(chartRequests('POST', /\/stop$/)).toHaveLength(0);
    // One top-up, as the chart device, stamped from the cook's start.
    expect(stub!.chartTopups).toEqual([
      [
        '--count',
        String(CHART.readings),
        '--start',
        new Date(Date.parse(cooks[0].startTime)).toISOString(),
        '--step',
        '5s',
        '--inflight',
        '32',
        '--interval',
        '50ms',
      ],
    ]);
    expect(
      result.lines.some(line =>
        new RegExp(`^\\s+EXEC\\s+simdevice \\(chart\\) --count ${CHART.readings} --start `).test(
          line
        )
      )
    ).toBe(true);
    expect(metric(result, 'chart-topup-sent')).toEqual([
      `METRIC chart-topup-sent ${CHART.readings}`,
    ]);
    expect(metric(result, 'chart-ru-12h')).toEqual(['METRIC chart-ru-12h 3.94']);
    expect(metric(result, 'chart-points')).toEqual([
      `METRIC chart-points ${pointsFor(cooks[0].startTime)}`,
    ]);
    expect(metric(result, 'chart-bucket-seconds')).toEqual(['METRIC chart-bucket-seconds 60']);
    // Loaded; polled until covered (on the second read after the top-up); measured.
    expect(chartRequests('GET', /\/chart$/)).toHaveLength(1 + 2 + 1);
  });

  it('(a) with an uncovered standing cook: tops that cook up, starting nothing', async () => {
    const result = await runChart({ chartCook: 'uncovered', chartCoveredFromRead: 3 });

    expect(result.failures).toEqual([]);
    expect(chartRequests('POST', /^\/api\/devices$/)).toHaveLength(0);
    expect(chartRequests('POST', /^\/api\/cooks$/)).toHaveLength(0);
    expect(stub!.chartTopups).toHaveLength(1);
    expect(stub!.chartTopups[0].slice(2, 4)).toEqual(['--start', STANDING_CHART_START]);
    expect(stub!.chartCooks()).toEqual([
      { id: STANDING_CHART_COOK_ID, status: 'active', startTime: STANDING_CHART_START },
    ]);
    expect(metric(result, 'chart-topup-sent')).toEqual([
      `METRIC chart-topup-sent ${CHART.readings}`,
    ]);
    expect(chartRequests('GET', /\/chart$/)).toHaveLength(1 + 3 + 1);
  });

  it('(b) covered: sends nothing and measures one more load', async () => {
    const result = await runChart();

    expect(result.failures).toEqual([]);
    expect(stub!.chartTopups).toEqual([]);
    expect(result.lines.some(line => /EXEC\s+simdevice/.test(line))).toBe(false);
    expect(chartRequests('POST', /^\/api\/devices$/)).toHaveLength(0);
    expect(chartRequests('POST', /^\/api\/cooks$/)).toHaveLength(0);
    expect(metric(result, 'chart-topup-sent')).toEqual(['METRIC chart-topup-sent 0']);
    expect(metric(result, 'chart-ru-12h')).toEqual(['METRIC chart-ru-12h 3.94']);
    expect(metric(result, 'chart-points')).toEqual([
      `METRIC chart-points ${pointsFor(STANDING_CHART_START)}`,
    ]);
    // The coverage load, then the measurement.
    expect(
      chartRequests('GET', new RegExp(`/cooks/${STANDING_CHART_COOK_ID}/chart$`))
    ).toHaveLength(2);
  });

  it('(b) the whole suite passes on a first run (no standing cook yet)', async () => {
    const result = await runAgainstStub({ chartCook: 'none' }, 'ok', undefined, 'dps');

    expect(result.failures).toEqual([]);
    expect(stub!.chartTopups).toHaveLength(1);
    expect(stub!.chartCooks().map(c => c.status)).toEqual(['active']);
  });

  it.each([
    ['40', true],
    ['41', false],
  ] as const)('(c) a chart costing %s RU is within the budget: %s', async (charge, passes) => {
    const result = await runChart({ chartCharge: charge });

    expect(metric(result, 'chart-ru-12h')).toEqual([`METRIC chart-ru-12h ${charge}`]);
    if (passes) {
      expect(result.failures).toEqual([]);
      return;
    }
    expect(result.exitCode).toBe(1);
    expect(result.failures).toEqual([
      `FAIL ${GROUP} ${STEPS[6]} — GET /cooks/{cookId}/chart → 200: the chart of a 12 h cook ` +
        `cost 41 RU, over the ${CHART_RU_BUDGET} RU budget (CHART_RU_BUDGET)`,
    ]);
  });

  it('(c) fails naming the cap when the top-up is never rolled up', async () => {
    const result = await runChart({ chartCook: 'uncovered', chartTopupNeverRolledUp: true });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(
      `FAIL ${GROUP} ${STEPS[5]} — GET /cooks/{cookId}/chart → 200`
    );
    expect(result.failures[0]).toContain(
      'the chart is not covered after the 900 s cap: the chart has no points'
    );
    // HAR-120: the coverage load, then the live pacing on the fake clock: a
    // load at 0 s and one every 10 s up to the 15 min cap.
    expect(chartRequests('GET', /\/chart$/)).toHaveLength(1 + 1 + 900 / 10);
    expect(fakeClock.slept).toEqual(Array.from({ length: 900 / 10 }, () => CHART.pollIntervalMs));
    expect(result.lines).toContain(
      `SKIP ${GROUP} ${STEPS[6]} (an earlier proof in this group failed)`
    );
    expect(metric(result, 'chart-ru-12h')).toEqual([]);
  });

  it('(d) fails clearly when neither chart variable is set, sending nothing', async () => {
    stub = await startStub({ chartCook: 'none' });
    const result = await run(
      {
        ACCEPTANCE_BASE_URL: stub.baseUrl,
        ACCEPTANCE_BEARER_TOKEN: TOKEN,
        ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
        ...simEnv(),
      },
      [chartGroup]
    );

    expect(result.exitCode).toBe(1);
    expect(result.failures).toEqual([
      `FAIL ${GROUP} ${STEPS[0]} — before any request: ACCEPTANCE_CHART_DEVICE_ID and ` +
        'SIMDEVICE_CHART_CONNECTION_STRING are not set; the cook-chart proof needs the chart device',
    ]);
    STEPS.slice(1).forEach(step =>
      expect(result.lines).toContain(
        `SKIP ${GROUP} ${step} (an earlier proof in this group failed)`
      )
    );
    expect(stub.requests).toHaveLength(0);
  });

  it.each(['ACCEPTANCE_CHART_DEVICE_ID', 'SIMDEVICE_CHART_CONNECTION_STRING'])(
    '(d) fails at once naming the other variable when only %s is set',
    async given => {
      stub = await startStub();
      const absent =
        given === 'ACCEPTANCE_CHART_DEVICE_ID'
          ? 'SIMDEVICE_CHART_CONNECTION_STRING'
          : 'ACCEPTANCE_CHART_DEVICE_ID';
      const result = await run(
        {
          ACCEPTANCE_BASE_URL: stub.baseUrl,
          ACCEPTANCE_BEARER_TOKEN: TOKEN,
          ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
          ...simEnv(),
          [given]: chartEnv[given as keyof typeof chartEnv],
        },
        [chartGroup]
      );

      expect(result.exitCode).toBe(2);
      expect(result.failures).toEqual([
        `acceptance: ${given} is set but ${absent} is not; the chart device needs both or neither`,
      ]);
      expect(stub.requests).toHaveLength(0);
    }
  );

  describe('chartCoverage', () => {
    const lastReadingOffsetMs = () => (CHART.readings - 1) * CHART.stepSeconds * 1000;
    const chartOf = (startTime: string, bucketSeconds: number, ts: number[]) => ({
      cookId: STANDING_CHART_COOK_ID,
      deviceId: CHART_DEVICE,
      startTime,
      bucketSeconds,
      points: ts.map(t => ({ t: new Date(t).toISOString() })),
    });

    it('is covered when the last bucket holds the last reading, even if it starts before startTime + span − bucket', () => {
      // startTime 2 s into its minute: buckets start on the minute, so the
      // bucket holding the last reading starts 2 s + step before
      // startTime + span − bucket.
      const start = Date.parse('2026-11-01T06:00:02.000Z');
      const minute = Date.parse('2026-11-01T06:00:00.000Z');
      const bucket = 60;
      const lastReading = start + lastReadingOffsetMs();
      const lastBucket = minute + Math.floor((lastReading - minute) / 60_000) * 60_000;
      expect(lastBucket).toBeLessThan(
        start + CHART.readings * CHART.stepSeconds * 1000 - bucket * 1000
      );
      expect(
        chartCoverage(chartOf(new Date(start).toISOString(), bucket, [minute, lastBucket])).covered
      ).toBe(true);
    });

    it.each([
      ['no points', [], 'the chart has no points'],
      [
        'a first point a bucket late',
        [60_000, 'last'],
        'more than one 60 s bucket after startTime',
      ],
      ['a last point a bucket short', [0, 'short'], 'ends before the last reading'],
    ] as const)('is not covered with %s', (_, offsets, reason) => {
      const start = Date.parse('2026-11-01T06:00:00.000Z');
      const lastBucket = start + Math.floor(lastReadingOffsetMs() / 60_000) * 60_000;
      const ts = offsets.map(o =>
        o === 'last' ? lastBucket : o === 'short' ? lastBucket - 60_000 : start + o
      );
      const coverage = chartCoverage(chartOf(new Date(start).toISOString(), 60, ts));
      expect(coverage.covered).toBe(false);
      expect(coverage.reason).toContain(reason);
    });
  });
});

describe('OpenAPI contract (HAR-77, against the stub)', () => {
  const GROUP = 'contract';
  /** A one-proof group sending `request`, and checking the status when given. */
  const one = (request: Parameters<AcceptanceApi['request']>[0], status?: number): ProofGroup => ({
    name: GROUP,
    create: () => [
      {
        name: `${request.method} ${request.path}`,
        async run(api) {
          const response = await api.request(request);
          if (status !== undefined) api.expectStatus(response, status);
        },
      },
    ],
  });
  const contractLine = (result: Run) => result.lines.find(line => line.startsWith('CONTRACT '));

  it('prints the CONTRACT summary and METRIC contract-validated-responses after a passing run', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    // One line per request above the RU table, whose rows look the same.
    const requests = result.lines
      .slice(0, result.lines.indexOf('RU per route'))
      .filter(line => /^\s+(GET|POST|PATCH|PUT|DELETE)\s+\//.test(line));
    const summary = contractLine(result);
    // Every response was checked, and the SignalR proofs checked what they received.
    expect(summary).toMatch(
      new RegExp(
        `^CONTRACT validated ${requests.length} responses, [1-9]\\d* hub messages, 0 mismatches$`
      )
    );
    expect(result.lines).toContain(`METRIC contract-validated-responses ${requests.length}`);
    // Both sit just above the totals, inside what the CI summary copies.
    const totals = result.lines.findIndex(line => line.startsWith('acceptance: '));
    expect(result.lines.indexOf(summary!)).toBeGreaterThan(result.lines.indexOf('RU per route'));
    expect(result.lines.indexOf(summary!)).toBeLessThan(totals);
  });

  it('passes a conforming response and counts it', async () => {
    const result = await runAgainstStub({}, 'ok', [one({ method: 'GET', path: '/devices' }, 200)]);

    expect(result.failures).toEqual([]);
    expect(result.lines).toContain(`PASS ${GROUP} › GET /devices`);
    expect(contractLine(result)).toBe(
      'CONTRACT validated 1 responses, 0 hub messages, 0 mismatches'
    );
    expect(result.lines).toContain('METRIC contract-validated-responses 1');
  });

  it('fails the proof on a status the operation does not declare, listing the declared ones', async () => {
    const result = await runAgainstStub(
      { failRoute: { route: 'GET /devices', status: 418 } },
      'ok',
      [one({ method: 'GET', path: '/devices' })]
    );

    expect(result.exitCode).toBe(1);
    expect(result.failures).toEqual([
      `FAIL ${GROUP} › GET /devices — GET /devices → 418: contract: GET /devices (getDevices) 418: ` +
        'the status is not declared (the spec declares 200, 401, 500)',
    ]);
    expect(contractLine(result)).toBe(
      'CONTRACT validated 1 responses, 0 hub messages, 1 mismatches'
    );
  });

  it('fails the proof on a body that breaks the schema, naming the field', async () => {
    const result = await runAgainstStub(
      {
        alterBody: {
          route: 'POST /devices',
          alter: body => ({ ...(body as object), isActive: 'yes', colour: 'red-1.2' }),
        },
      },
      'ok',
      [one({ method: 'POST', path: '/devices', body: { deviceId: 'contract-1', name: 'Smoker' } })]
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(
      `FAIL ${GROUP} › POST /devices — POST /devices → 201: contract: POST /devices (registerDevice) 201: ` +
        'the body does not match the schema: '
    );
    expect(result.failures[0]).toContain("(root) must NOT have additional properties 'colour'");
    expect(result.failures[0]).toContain('/isActive must be boolean');
    // The line names the field, never its value.
    expect(result.failures[0]).not.toContain('red-1.2');
  });

  it('fails the proof when the declared X-Request-ID header is missing', async () => {
    const result = await runAgainstStub({ omitRequestIdOn: 'GET /devices' }, 'ok', [
      one({ method: 'GET', path: '/devices' }, 200),
    ]);

    expect(result.failures).toEqual([
      `FAIL ${GROUP} › GET /devices — GET /devices → 200: contract: GET /devices (getDevices) 200: ` +
        'the declared X-Request-ID header is missing',
    ]);
  });

  it('checks an unauthenticated request against the 401 response too', async () => {
    const unauthenticated = one(
      { method: 'GET', path: '/cooks', authenticated: false, expectRequestCharge: false },
      401
    );

    // Easy Auth's own 401: no body, and the 401 declares no X-Request-ID.
    const platform = await runAgainstStub({}, 'ok', [unauthenticated]);
    expect(platform.failures).toEqual([]);
    expect(contractLine(platform)).toBe(
      'CONTRACT validated 1 responses, 0 hub messages, 0 mismatches'
    );
    await stub!.close();

    // The handler's 401 body must be an UnauthenticatedError.
    const handler = await runAgainstStub(
      {
        unauthenticatedBody: {
          error: 'UNAUTHENTICATED',
          reason: 'principal_header_missing',
          requestId: 'i',
        },
      },
      'ok',
      [unauthenticated]
    );
    expect(handler.failures).toEqual([]);
    await stub!.close();

    const wrong = await runAgainstStub(
      { unauthenticatedBody: { error: 'UNAUTHENTICATED' } },
      'ok',
      [unauthenticated]
    );
    expect(wrong.failures).toEqual([
      `FAIL ${GROUP} › GET /cooks — GET /cooks → 401: contract: GET /cooks (listCooks) 401: ` +
        "the body does not match the schema: (root) must have required property 'reason'; " +
        "(root) must have required property 'requestId'",
    ]);
  });

  it('fails at request time, before sending, on a route that is not in the spec', async () => {
    const result = await runAgainstStub({}, 'ok', [
      one({ method: 'GET', path: '/cookz' }),
      one({ method: 'DELETE', path: '/cooks/abc', route: '/cooks/{cookId}' }),
      one({ method: 'GET', path: '/devices/abc', route: '/cooks/{cookId}' }),
    ]);

    expect(result.failures).toEqual([
      `FAIL ${GROUP} › GET /cookz — GET /cookz → no response: ` +
        'contract: GET /cookz matches no operation in openapi.yaml',
      `FAIL ${GROUP} › DELETE /cooks/abc — DELETE /cooks/{cookId} → no response: ` +
        'contract: DELETE /cooks/{cookId} is not an operation in openapi.yaml',
      `FAIL ${GROUP} › GET /devices/abc — GET /cooks/{cookId} → no response: ` +
        'contract: the path /devices/abc does not fit the route /cooks/{cookId}',
    ]);
    // Nothing was sent.
    expect(stub!.requests).toEqual([]);
    expect(contractLine(result)).toBe(
      'CONTRACT validated 0 responses, 0 hub messages, 0 mismatches'
    );
  });

  it('derives the route from the path when a proof gives none, a literal segment winning', async () => {
    const result = await runAgainstStub({}, 'ok', [
      one({ method: 'GET', path: '/devices/abc' }, 404),
      one({ method: 'GET', path: '/temperatures/history?deviceId=abc' }, 404),
    ]);

    expect(result.failures).toEqual([]);
    expect(result.lines.some(line => /^\s+GET\s+\/devices\/\{id\}\s+404\s/.test(line))).toBe(true);
    expect(summaryRow(result.output, 'GET /devices/{id}')).toBeDefined();
    expect(summaryRow(result.output, 'GET /temperatures/history')).toBeDefined();
  });

  it('exits 2 before any request when the spec cannot be loaded', async () => {
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
      specPath: join(fakeDir, 'missing-openapi.yaml'),
    });

    expect(result.exitCode).toBe(2);
    expect(result.failures[0]).toMatch(/^acceptance: the OpenAPI contract could not be loaded: /);
    expect(stub.requests).toEqual([]);
  });

  describe('expectHubMessage', () => {
    let contract: Contract;
    const started = {
      type: 'cook_started',
      timestamp: '2026-11-20T12:00:00.000Z',
      messageId: '6f1c2b8e-3d4a-4f6b-9c7d-0e1f2a3b4c5d',
      deviceId: 'meatgeek3',
      userId: 'tid:oid',
      cookId: '0b7c1d52-9e1f-4c3a-8d2e-5f6a7b8c9d0e',
      correlation: { id: 'invocation-1' },
      payload: {
        id: '0b7c1d52-9e1f-4c3a-8d2e-5f6a7b8c9d0e',
        userId: 'tid:oid',
        deviceId: 'meatgeek3',
        name: 'Brisket',
        status: 'active',
        startTime: '2026-11-20T12:00:00.000Z',
        meatType: 'brisket',
      },
    };

    beforeAll(async () => {
      contract = await Contract.load();
    });

    it('passes a message that matches its target and counts it', () => {
      expect(() => expectHubMessage({ contract }, 'cook_started', started)).not.toThrow();
      expect(contract.counts).toMatchObject({ hubMessages: 1, mismatches: 0 });
    });

    it('fails a message of the wrong shape, naming the target and the field', () => {
      const wrong = { ...started, payload: { ...started.payload, status: 'smoking' } };
      const { cookId: _cookId, ...noCookId } = started;

      expect(() => expectHubMessage({ contract }, 'cook_started', wrong)).toThrow(ProofFailure);
      expect(() => expectHubMessage({ contract }, 'cook_started', wrong)).toThrow(
        'contract: hub message cook_started: the message does not match the schema: ' +
          '/payload/status must be equal to one of the allowed values'
      );
      expect(() => expectHubMessage({ contract }, 'cook_started', noCookId)).toThrow(
        "(root) must have required property 'cookId'"
      );
      // A cook_started envelope is not a valid cook_stopped one.
      expect(() => expectHubMessage({ contract }, 'cook_stopped', started)).toThrow(
        "contract: hub message cook_stopped: the message does not match the schema: (root) must NOT have additional properties 'cookId'"
      );
    });

    it('fails a message on a target x-signalr does not list', () => {
      expect(() => expectHubMessage({ contract }, 'cook_paused', started)).toThrow(
        'contract: hub message cook_paused: the target is not in x-signalr.messages'
      );
    });
  });
});

describe('real-time waits, on the fake clock (HAR-120)', () => {
  it('within() rejects with "<what> did not finish in <ms> ms" when the fake time reaches the bound, not before', async () => {
    let outcome: unknown;
    const waiting = within(new Promise<never>(() => undefined), CONNECT_TIMEOUT_MS, 'start()').then(
      () => (outcome = 'resolved'),
      error => (outcome = error)
    );
    expect(fakeClock.deadlines()).toEqual([30_000]);

    fakeClock.advance(CONNECT_TIMEOUT_MS - 1);
    await drainEvents();
    expect(outcome).toBeUndefined();

    fakeClock.advance(1);
    await waiting;
    expect(outcome).toBeInstanceOf(ProofFailure);
    expect((outcome as Error).message).toBe('start() did not finish in 30000 ms');
  });

  it('within() cancels its deadline when the promise settles first', async () => {
    await expect(within(Promise.resolve('done'), CONNECT_TIMEOUT_MS, 'stop()')).resolves.toBe(
      'done'
    );
    expect(fakeClock.deadlines()).toEqual([]);
  });

  it('a request still unanswered at the 60 s per-request limit fails, naming the limit and the route', async () => {
    stub = await startStub({ holdRoute: 'GET /users/me' });
    const lines: string[] = [];
    const running = runAcceptance({
      env: {
        ACCEPTANCE_BASE_URL: stub.baseUrl,
        ACCEPTANCE_BEARER_TOKEN: TOKEN,
        ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
        ...simEnv(),
      },
      write: line => lines.push(line),
      groups: [
        {
          name: 'held',
          create: () => [
            {
              name: 'GET /users/me never answers',
              run: async api => {
                await api.request({ method: 'GET', path: '/users/me' });
              },
            },
          ],
        },
      ],
    });
    await stub.whenHeld();
    expect(fakeClock.deadlines()).toEqual([60_000]);
    fakeClock.advance(60_000);
    const result = await running;

    expect(result.failures).toEqual([
      'FAIL held › GET /users/me never answers — GET /users/me → no response: ' +
        "the response did not finish in 60000 ms (the runner's per-request limit)",
    ]);
    expect(fakeClock.deadlines()).toEqual([]);
  });

  it('a finished request leaves no deadline behind', async () => {
    stub = await startStub();
    const result = await run(
      {
        ACCEPTANCE_BASE_URL: stub.baseUrl,
        ACCEPTANCE_BEARER_TOKEN: TOKEN,
        ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
        ...simEnv(),
      },
      [usersGroup]
    );

    expect(result.failures).toEqual([]);
    expect(fakeClock.deadlines()).toEqual([]);
  });

  it('a simdevice send still running at the 120 s limit is killed and fails naming the limit', async () => {
    const running = runAgainstStub({}, 'hang', [roundtripGroup]);
    await fakeClock.armed(120_000);
    fakeClock.advance(120_000);
    const result = await running;

    expect(result.failures).toEqual([
      'FAIL telemetry round-trip › simdevice --count 1 sends one reading through IoT Hub — ' +
        'simdevice → exit killed: simdevice did not exit within its 120000 ms limit and was ' +
        'killed, expected exit 0',
    ]);
  });

  it('HAR-140: a device script still running at the 300 s limit is killed, and the cleanup still runs', async () => {
    stub = await startStub();
    deviceScriptsDir = writeFakeDeviceScripts('enrol-device.sh');
    const running = run(
      {
        ACCEPTANCE_BASE_URL: stub.baseUrl,
        ACCEPTANCE_BEARER_TOKEN: TOKEN,
        ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
        ...simEnv(),
        ...dpsEnv,
      },
      [temperaturesGroup]
    );
    await fakeClock.armed(300_000);
    fakeClock.advance(300_000);
    const result = await running;

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(
      /^FAIL temperatures › a fresh device acceptance-temp-<runId> is enrolled through DPS — enrol-device\.sh → exit killed: enrol-device\.sh for acceptance-temp-\S+ did not exit within its 300000 ms limit and was killed$/
    );
    expect(result.lines).toContain(
      'PASS temperatures › always: acceptance-temp-<runId> is released and its enrollment and hub identity deleted'
    );
    expect(stub.scriptRuns.map(r => r.script)).toEqual(['delete-device.sh']);
  });

  it('the live-temperature wait gives up at exactly its 90 s cap', async () => {
    const result = await runAgainstStub({ livePush: 'never' }, 'ok', [liveGroup]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(
      'nothing within the 90 s cap; the connection is Connected'
    );
    expect(fakeClock.slept).toEqual([LIVE_WAIT.capMs]);
    expect(fakeClock.now()).toBe(FakeClock.EPOCH + 90_000);
  });

  it('the isolation owner wait gives up at exactly its 90 s cap, before any grace', async () => {
    const result = await runAgainstStub({ livePush: 'never' }, 'ok', [isolationGroup]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(
      'nothing within the 90 s cap; the owner connection is Connected'
    );
    expect(fakeClock.slept).toEqual([ISOLATION_WAIT.capMs]);
  });
});

describe('SignalR start() retries a throttled service (HAR-77, against the stub)', () => {
  const SIGNALR_GROUPS = [
    'device release ›',
    'signalr isolation ›',
    'signalr live temperature ›',
    'signalr negotiate ›',
  ];
  const negotiates = () =>
    stub!.signalRRequests.filter(r => r.method === 'POST' && r.path.startsWith('/client/negotiate'))
      .length;

  it('passes every proof when the service answers the first client negotiates with 429', async () => {
    const result = await runAgainstStub({ signalRThrottle: 3 });

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    // Three throttled negotiates were retried; then each connection opened and was stopped.
    const calls = stub!.signalRRequests.map(r => `${r.method} ${r.path.split('?')[0]}`);
    expect(calls.filter(call => call === 'DELETE /client/')).toHaveLength(negotiates() - 3);
    expect(result.output).not.toContain('/client/');
    // HAR-120: the first start() (HAR-142: the device release group's) slept
    // the live 1, 2 and 4 s between its throttled attempts, on the fake clock.
    expect(fakeClock.slept.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
  });

  it('fails each SignalR proof naming the 429 and the attempts when the service never stops throttling', async () => {
    const result = await runAgainstStub({ signalRThrottle: Infinity });

    expect(result.exitCode).not.toBe(0);
    for (const group of SIGNALR_GROUPS) {
      const failures = result.failures.filter(line => line.startsWith(`FAIL ${group}`));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('start() failed: Error: Failed to complete negotiation');
      expect(failures[0]).toContain("Status code '429' (throttled on all 5 attempts)");
    }
    expect(negotiates()).toBe(SIGNALR_GROUPS.length * 5);
    // HAR-120: each of them slept the live 1, 2, 4 and 8 s between its five
    // attempts, on the fake clock.
    expect(fakeClock.slept.slice(0, 4 * SIGNALR_GROUPS.length)).toEqual(
      SIGNALR_GROUPS.flatMap(() => START_RETRY.delaysMs)
    );
    expect(START_RETRY.delaysMs).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(result.output).not.toContain(SIGNALR_CLIENT_TOKEN);
    expect(result.output).not.toContain('/client/');
  });

  it('does not retry an error that is not a 429', async () => {
    let calls = 0;
    const connection = {
      start: () => {
        calls++;
        return Promise.reject(new Error("Unauthorized: Status code '401'"));
      },
    };

    await expect(startConnection(connection, 'start()', () => [])).rejects.toThrow(
      "start() failed: Error: Unauthorized: Status code '401'"
    );
    expect(calls).toBe(1);
  });

  it('masks the secrets in the failure', async () => {
    const connection = {
      start: () =>
        Promise.reject(new Error("tok-123 at https://x.service.signalr.net: Status code '429'")),
    };

    const failure = startConnection(connection, 'owner start()', () => ['tok-123']);
    await expect(failure).rejects.toThrow(
      "owner start() failed: Error: *** at <url> Status code '429' (throttled on all 5 attempts)"
    );
  });
});

describe('DPS mode (HAR-138)', () => {
  const ID_SCOPE = '0ne00SCOPE-VALUE';
  const ENDPOINT = 'dps-endpoint.example.test';
  const SIM_STATE_DIR = '/state/SIM-STATE-DIR-VALUE';
  const CHART_STATE_DIR = '/state/CHART-STATE-DIR-VALUE';
  /** A claim code, as simdevice prints it. */
  const CLAIM_CODE = '7K3M-9QXR-2HTV';

  const childProcess = jest.requireActual<typeof import('child_process')>('child_process');
  let spawnSpy: jest.SpyInstance;
  beforeEach(() => {
    spawnSpy = jest.spyOn(childProcess, 'spawn');
  });
  afterEach(() => {
    spawnSpy.mockRestore();
  });
  /** The env of each `spawn` call, in order. */
  const spawnedEnvs = (): NodeJS.ProcessEnv[] =>
    spawnSpy.mock.calls.map(call => (call[2] as { env: NodeJS.ProcessEnv }).env);

  const baseEnv = () => ({
    ACCEPTANCE_BASE_URL: stub!.baseUrl,
    ACCEPTANCE_BEARER_TOKEN: TOKEN,
    ACCEPTANCE_PEER_BEARER_TOKEN: PEER_TOKEN,
    ACCEPTANCE_SIM_DEVICE_ID: SIM_DEVICE,
  });

  /** A script that prints `stdout`, writes `stderr` and exits `code`. */
  function script(name: string, body: string): string {
    const path = join(fakeDir, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  const quietBin = () => script('simdevice-quiet', "process.stdout.write('{}\\n');");

  /** A one-proof group sending once as the simulated device, then as the chart device. */
  const sendAsBoth: ProofGroup = {
    name: 'dps',
    create: () => [
      {
        name: 'sends as each device',
        run: async api => {
          await api.runSimDevice(['--count', '1']);
          if (api.chartDeviceId !== undefined) {
            await api.runSimDevice(['--count', '1'], { device: 'chart' });
          }
        },
      },
    ],
  };

  const pick = (env: NodeJS.ProcessEnv, names: readonly string[]) =>
    Object.fromEntries(names.filter(n => env[n] !== undefined).map(n => [n, env[n]]));
  const DEVICE_VARIABLES = [
    'SIMDEVICE_CONNECTION_STRING',
    'SIMDEVICE_CHART_CONNECTION_STRING',
    'MEATGEEK_DPS_ID_SCOPE',
    'MEATGEEK_DPS_ENDPOINT',
    'MEATGEEK_DEVICE_ID',
    'MEATGEEK_STATE_DIR',
    'ACCEPTANCE_BEARER_TOKEN',
    'ACCEPTANCE_PEER_BEARER_TOKEN',
  ];

  describe('the env handed to spawn', () => {
    it('(a) DPS mode: the four MEATGEEK_* variables for each device, and no connection string', async () => {
      stub = await startStub();
      // In CI the runner's own environment may still carry the old inputs.
      process.env['SIMDEVICE_CONNECTION_STRING'] = SIM_CONNECTION_STRING;
      process.env['SIMDEVICE_CHART_CONNECTION_STRING'] = CHART_CONNECTION_STRING;
      try {
        const result = await run(
          {
            ...baseEnv(),
            ACCEPTANCE_SIMDEVICE_BIN: quietBin(),
            ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
            ACCEPTANCE_DPS_ENDPOINT: ` ${ENDPOINT} `,
            ACCEPTANCE_SIM_STATE_DIR: SIM_STATE_DIR,
            ACCEPTANCE_CHART_DEVICE_ID: CHART_DEVICE,
            ACCEPTANCE_CHART_STATE_DIR: CHART_STATE_DIR,
          },
          [sendAsBoth]
        );
        expect(result.failures).toEqual([]);
      } finally {
        delete process.env['SIMDEVICE_CONNECTION_STRING'];
        delete process.env['SIMDEVICE_CHART_CONNECTION_STRING'];
      }

      const [sim, chart] = spawnedEnvs();
      expect(spawnSpy).toHaveBeenCalledTimes(2);
      expect(pick(sim, DEVICE_VARIABLES)).toEqual({
        MEATGEEK_DPS_ID_SCOPE: ID_SCOPE,
        MEATGEEK_DPS_ENDPOINT: ENDPOINT,
        MEATGEEK_DEVICE_ID: SIM_DEVICE,
        MEATGEEK_STATE_DIR: SIM_STATE_DIR,
      });
      expect(pick(chart, DEVICE_VARIABLES)).toEqual({
        MEATGEEK_DPS_ID_SCOPE: ID_SCOPE,
        MEATGEEK_DPS_ENDPOINT: ENDPOINT,
        MEATGEEK_DEVICE_ID: CHART_DEVICE,
        MEATGEEK_STATE_DIR: CHART_STATE_DIR,
      });
    });

    it('(b) DPS mode without ACCEPTANCE_DPS_ENDPOINT: three MEATGEEK_* variables', async () => {
      stub = await startStub();
      const result = await run(
        {
          ...baseEnv(),
          ACCEPTANCE_SIMDEVICE_BIN: quietBin(),
          ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
          ACCEPTANCE_SIM_STATE_DIR: SIM_STATE_DIR,
        },
        [sendAsBoth]
      );
      expect(result.failures).toEqual([]);

      expect(spawnedEnvs().map(env => pick(env, DEVICE_VARIABLES))).toEqual([
        {
          MEATGEEK_DPS_ID_SCOPE: ID_SCOPE,
          MEATGEEK_DEVICE_ID: SIM_DEVICE,
          MEATGEEK_STATE_DIR: SIM_STATE_DIR,
        },
      ]);
    });

    it("(c) connection-string mode: today's env, the runner's own minus the tokens and the other device's credential", async () => {
      stub = await startStub();
      const bin = quietBin();
      const result = await run(
        {
          ...baseEnv(),
          ...simEnv(),
          ACCEPTANCE_SIMDEVICE_BIN: bin,
          ...chartEnv,
          // An ID scope alone changes nothing: no device has a state dir.
          ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
        },
        [sendAsBoth]
      );
      expect(result.failures).toEqual([]);

      const today = (credential: string) => {
        const env: NodeJS.ProcessEnv = { ...process.env, SIMDEVICE_CONNECTION_STRING: credential };
        delete env['ACCEPTANCE_BEARER_TOKEN'];
        delete env['ACCEPTANCE_PEER_BEARER_TOKEN'];
        delete env['SIMDEVICE_CHART_CONNECTION_STRING'];
        return env;
      };
      expect(spawnedEnvs()).toEqual([today(SIM_CONNECTION_STRING), today(CHART_CONNECTION_STRING)]);
      expect(spawnSpy.mock.calls.map(call => call[0])).toEqual([bin, bin]);
    });

    it('(d) each device has its own mode: the simulated device in DPS, the chart device by connection string', async () => {
      stub = await startStub();
      const result = await run(
        {
          ...baseEnv(),
          ACCEPTANCE_SIMDEVICE_BIN: quietBin(),
          ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
          ACCEPTANCE_SIM_STATE_DIR: SIM_STATE_DIR,
          ...chartEnv,
        },
        [sendAsBoth]
      );
      expect(result.failures).toEqual([]);

      expect(spawnedEnvs().map(env => pick(env, DEVICE_VARIABLES))).toEqual([
        {
          MEATGEEK_DPS_ID_SCOPE: ID_SCOPE,
          MEATGEEK_DEVICE_ID: SIM_DEVICE,
          MEATGEEK_STATE_DIR: SIM_STATE_DIR,
        },
        { SIMDEVICE_CONNECTION_STRING: CHART_CONNECTION_STRING },
      ]);
      expect(result.output).not.toContain(CHART_KEY);
    });
  });

  describe('configuration errors stop the run before any proof, naming variables, never values', () => {
    const VALUES = [
      ID_SCOPE,
      SIM_STATE_DIR,
      CHART_STATE_DIR,
      SIM_CONNECTION_STRING,
      SIM_KEY,
      CHART_CONNECTION_STRING,
      CHART_KEY,
    ];

    // The inputs are thunks: simEnv() writes the fake simdevice, which needs
    // the temp dir beforeAll makes.
    it.each<[string, () => Record<string, string>, string]>([
      [
        'the simulated device has a connection string and a state dir',
        () => ({
          ...simEnv(),
          ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
          ACCEPTANCE_SIM_STATE_DIR: SIM_STATE_DIR,
        }),
        'acceptance: SIMDEVICE_CONNECTION_STRING and ACCEPTANCE_SIM_STATE_DIR are both set; the ' +
          'simulated device runs in one mode: set the connection string, or the state dir for DPS mode',
      ],
      [
        'the chart device has a connection string and a state dir',
        () => ({
          ...simEnv(),
          ...chartEnv,
          ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
          ACCEPTANCE_CHART_STATE_DIR: CHART_STATE_DIR,
        }),
        'acceptance: SIMDEVICE_CHART_CONNECTION_STRING and ACCEPTANCE_CHART_STATE_DIR are both ' +
          'set; the chart device runs in one mode: set the connection string, or the state dir for DPS mode',
      ],
      [
        'the simulated device has a state dir but there is no ID scope',
        () => ({
          ...simEnv(),
          SIMDEVICE_CONNECTION_STRING: '',
          ACCEPTANCE_SIM_STATE_DIR: SIM_STATE_DIR,
        }),
        'acceptance: ACCEPTANCE_SIM_STATE_DIR is set but ACCEPTANCE_DPS_ID_SCOPE is not; DPS mode ' +
          'for the simulated device needs both',
      ],
      [
        'the chart device has a state dir but there is no ID scope',
        () => ({
          ...simEnv(),
          ACCEPTANCE_CHART_DEVICE_ID: CHART_DEVICE,
          ACCEPTANCE_CHART_STATE_DIR: CHART_STATE_DIR,
        }),
        'acceptance: ACCEPTANCE_CHART_STATE_DIR is set but ACCEPTANCE_DPS_ID_SCOPE is not; DPS ' +
          'mode for the chart device needs both',
      ],
      [
        'the chart device has a state dir but no id',
        () => ({
          ...simEnv(),
          ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
          ACCEPTANCE_CHART_STATE_DIR: CHART_STATE_DIR,
        }),
        'acceptance: ACCEPTANCE_CHART_STATE_DIR is set but ACCEPTANCE_CHART_DEVICE_ID is not; the ' +
          'chart device needs both or neither',
      ],
      [
        'the chart device has an id but neither credential, with an ID scope set',
        () => ({
          ...simEnv(),
          ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
          ACCEPTANCE_CHART_DEVICE_ID: CHART_DEVICE,
        }),
        'acceptance: ACCEPTANCE_CHART_DEVICE_ID is set but neither SIMDEVICE_CHART_CONNECTION_STRING ' +
          'nor ACCEPTANCE_CHART_STATE_DIR is; the chart device needs both or neither',
      ],
    ])('(e) %s', async (_what, given, message) => {
      stub = await startStub();
      const result = await run({ ...baseEnv(), ...given() });

      expect(result.exitCode).toBe(2);
      expect(result.failures).toEqual([message]);
      for (const text of [result.output, ...result.failures]) {
        for (const value of VALUES) expect(text).not.toContain(value);
      }
      expect(stub.requests).toHaveLength(0);
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('(f) neither input for the simulated device is the old missing-input failure', async () => {
      stub = await startStub();
      const result = await run({
        ...baseEnv(),
        ...simEnv(),
        SIMDEVICE_CONNECTION_STRING: undefined,
        ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
      });

      expect(result.exitCode).toBe(2);
      expect(result.failures).toEqual([
        'acceptance: SIMDEVICE_CONNECTION_STRING is not set; the live acceptance run needs it',
      ]);
      expect(stub.requests).toHaveLength(0);
    });
  });

  describe('readClaimCode', () => {
    const STATE = '/state/claim-dir';
    /** A fake simdevice that checks its arguments, then prints `out`, writes
     *  `err` and exits `code`. */
    const claimBin = (name: string, out: string, err: string, code: number) =>
      script(
        `simdevice-claim-${name}`,
        `const args = process.argv.slice(2);
if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(['claim-code', '--state-dir', STATE]))}) {
  process.stderr.write('unexpected arguments ' + JSON.stringify(args) + '\\n');
  process.exit(2);
}
process.stdout.write(${JSON.stringify(out)});
process.stderr.write(${JSON.stringify(err)});
process.exitCode = ${code};`
      );

    it.each([
      [
        'unclaimed',
        {
          deviceId: 'sim-1',
          state: 'unclaimed',
          claimCode: CLAIM_CODE,
          expiresAt: '2026-11-19T18:00:00Z',
        },
      ],
      ['claimed', { deviceId: 'sim-1', state: 'claimed' }],
      ['expired', { deviceId: 'sim-1', state: 'expired' }],
    ])('parses the %s line', async (state, line) => {
      const bin = claimBin(state, `${JSON.stringify(line)}\n`, '', 0);
      await expect(readClaimCode(bin, STATE)).resolves.toEqual(line);
    });

    it('gives the child only PATH and HOME', async () => {
      const bin = claimBin(
        'env',
        `${JSON.stringify({ deviceId: 'sim-1', state: 'claimed' })}\n`,
        '',
        0
      );
      await readClaimCode(bin, STATE);
      expect(Object.keys(spawnedEnvs()[0]).sort()).toEqual(['HOME', 'PATH']);
    });

    it('is "no claim yet" on exit 3', async () => {
      const bin = claimBin('none', '', 'simdevice claim-code: open claim.json: no such file\n', 3);
      await expect(readClaimCode(bin, STATE)).resolves.toEqual({ state: 'no-claim-yet' });
    });

    it('throws on another exit with the code and stderr, and never stdout', async () => {
      const stdout = `{"deviceId":"sim-1","state":"unclaimed","claimCode":"${CLAIM_CODE}"} STDOUT-MARKER\n`;
      const bin = claimBin('fail', stdout, `boom: read ${CLAIM_CODE} failed\n`, 1);

      const error = await readClaimCode(bin, STATE).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ClaimCodeError);
      const failure = error as ClaimCodeError;
      expect(failure.exitCode).toBe(1);
      expect(failure.message).toBe('simdevice claim-code exited 1: boom: read [redacted] failed');
      expect(failure.stderr).toBe('boom: read [redacted] failed');
      for (const text of [failure.message, failure.stderr, String(failure.stack)]) {
        expect(text).not.toContain(CLAIM_CODE);
        expect(text).not.toContain('STDOUT-MARKER');
      }
    });

    it('throws, without stdout, when exit 0 prints no claim-code line', async () => {
      const bin = claimBin('garbled', `claim code ${CLAIM_CODE} STDOUT-MARKER\n`, '', 0);
      const error = (await readClaimCode(bin, STATE).catch((e: unknown) => e)) as ClaimCodeError;
      expect(error).toBeInstanceOf(ClaimCodeError);
      expect(error.exitCode).toBe(0);
      expect(error.message).toContain('did not print one claim-code JSON line');
      expect(error.message).not.toContain(CLAIM_CODE);
      expect(error.message).not.toContain('STDOUT-MARKER');
    });

    it('throws when the binary cannot be started', async () => {
      await expect(readClaimCode(join(fakeDir, 'no-such-simdevice'), STATE)).rejects.toThrow(
        'simdevice claim-code could not be started (ENOENT)'
      );
    });

    it('kills a run still going when the fake time reaches 30 s, not before', async () => {
      const bin = script(
        'simdevice-claim-hang',
        "process.stdout.write('" + CLAIM_CODE + "'); setInterval(() => undefined, 1 << 30);"
      );
      let outcome: unknown;
      const reading = readClaimCode(bin, STATE).then(
        () => (outcome = 'resolved'),
        (error: unknown) => (outcome = error)
      );
      await fakeClock.armed(30_000);
      fakeClock.advance(29_999);
      await drainEvents();
      expect(outcome).toBeUndefined();

      fakeClock.advance(1);
      await reading;
      expect(outcome).toBeInstanceOf(ClaimCodeError);
      expect((outcome as Error).message).toBe('simdevice claim-code did not finish in 30000 ms');
    });
  });

  describe('the claim code never reaches the output', () => {
    it('the redactor masks a claim code, but not a UUID or other dashed ids', () => {
      const redact = makeRedactor([], []);
      expect(redact(`code ${CLAIM_CODE}, again (${CLAIM_CODE.toLowerCase()})`)).toBe(
        `code [redacted], again (${CLAIM_CODE.toLowerCase()})`
      );
      for (const text of [
        STANDING_CHART_COOK_ID,
        STANDING_CHART_COOK_ID.toUpperCase(),
        'meatgeek-dev-simulated-smoker-chart',
        '20261119170000-abc123',
      ]) {
        expect(redact(text)).toBe(text);
      }
    });

    it('a claim code simdevice prints on stdout or stderr is masked in the failure and the output', async () => {
      stub = await startStub();
      const bin = script(
        'simdevice-claim-leak',
        `process.stderr.write('minted claim code ${CLAIM_CODE}\\n');
process.stdout.write(JSON.stringify({ event: 'twin', claimCode: '${CLAIM_CODE}' }) + '\\n');
process.exitCode = 1;`
      );
      const result = await run(
        {
          ...baseEnv(),
          ACCEPTANCE_SIMDEVICE_BIN: bin,
          ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
          ACCEPTANCE_SIM_STATE_DIR: SIM_STATE_DIR,
        },
        [
          {
            name: 'claim leak',
            create: () => [
              {
                name: 'echoes what simdevice printed',
                run: async api => {
                  const sent = await api.runSimDevice(['--twin', '--count', '0']);
                  throw new Error(
                    `simdevice said ${sent.stderrFirstLine} and ${JSON.stringify(sent.messages)}`
                  );
                },
              },
            ],
          },
        ]
      );

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain('simdevice → exit 1');
      expect(result.failures[0]).toContain('minted claim code [redacted]');
      expect(result.failures[0]).toContain('"claimCode":"[redacted]"');
      for (const text of [result.output, ...result.failures]) {
        expect(text).not.toContain(CLAIM_CODE);
        expect(text).not.toContain(SIM_STATE_DIR);
      }
    });
  });
});
