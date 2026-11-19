/**
 * HAR-11 — self-test for the live acceptance suite. Runs under ordinary
 * `nx test api`, never against a deployed system: it starts an in-process HTTP
 * stub that imitates the cooks, devices, recipes, temperatures and users routes and drives the REAL runner and the REAL
 * proof files (discovered from ./proofs) against it.
 *
 * HAR-44: `simdevice` is replaced by a small Node script written to a temp dir
 * (see {@link writeFakeSimdevice}); the stub serves the reading it "sent" for
 * the simulated device once a few polls have gone by.
 */
import { randomUUID } from 'crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { REQUEST_CHARGE_HEADER } from '../src/shared/cosmos/request-charge';
import { runAcceptance, RunResult } from './lib/runner';
import { ROUNDTRIP_POLL } from './proofs/telemetry-roundtrip.proof';

const TOKEN = 'eyJ0eXAi.SECRET-acceptance-token.value-9f3c';

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

type FakeMode = 'ok' | 'exit1' | 'leak-stderr' | 'leak-stdout';

type CookRoute = 'GET /cooks' | 'POST /cooks' | 'POST /cooks/{cookId}/stop';
type DeviceRoute = 'GET /devices' | 'POST /devices' | 'GET /devices/{id}' | 'PATCH /devices/{id}';
type TemperatureRoute = 'GET /temperatures/current/{deviceId}' | 'GET /temperatures/history';
type UserRoute = 'PUT /users/me' | 'GET /users/me';
type RecipeRoute =
  | 'GET /recipes'
  | 'POST /recipes'
  | 'GET /recipes/{id}'
  | 'PATCH /recipes/{id}'
  | 'DELETE /recipes/{id}';
type StubRoute = CookRoute | DeviceRoute | TemperatureRoute | UserRoute | RecipeRoute;

interface StubOptions {
  /** Answer this route with this status (and an RU header) instead. */
  readonly failRoute?: { readonly route: StubRoute; readonly status: number };
  /** Answer this route normally but without the RU header. */
  readonly omitChargeOn?: StubRoute;
  /** Answer every GET /temperatures/current with a 404 carrying this code. */
  readonly temperatureErrorCode?: string;
  /** Answer GET /temperatures/history for an owned device with this `total`. */
  readonly historyTotal?: number;
  /** Echo the caller's Authorization header back in bodies and headers. */
  readonly echoAuthorization?: boolean;
  /** Start cooks on any device, registered or not (the pre-HAR-26 behaviour). */
  readonly allowAnyDevice?: boolean;
  /** The simulated device's current reading is the sent one from this poll on
   *  (1-based). Earlier polls answer 404 NO_READINGS, then an older reading. */
  readonly simVisibleFromPoll?: number;
  /** The sent reading never reaches the simulated device's current or history. */
  readonly simNeverRouted?: boolean;
  /** The simulated device is registered to someone else: POST is 409, GET 404. */
  readonly simOwnedByOther?: boolean;
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
  readonly requests: Array<{ method: string; path: string; authorization?: string }>;
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
  let simPolls = 0;
  const simVisibleFromPoll = options.simVisibleFromPoll ?? 3;
  const simRouted = () => !options.simNeverRouted && simPolls >= simVisibleFromPoll;

  const server: Server = createServer((request, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://stub');
      const authorization = request.headers['authorization'];
      requests.push({
        method: request.method ?? '',
        path: url.pathname + url.search,
        authorization,
      });

      const send = (status: number, body: unknown, route?: StubRoute) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (route && options.omitChargeOn !== route) {
          headers[REQUEST_CHARGE_HEADER] = RU[route];
        }
        if (options.echoAuthorization && authorization) {
          headers['x-echo-authorization'] = authorization;
        }
        response.writeHead(status, headers);
        response.end(JSON.stringify(body));
      };

      if (authorization !== `Bearer ${TOKEN}`) {
        send(401, {
          error:
            options.echoAuthorization && authorization ? `BAD ${authorization}` : 'UNAUTHENTICATED',
        });
        return;
      }

      const stopMatch = /^\/api\/cooks\/([^/]+)\/stop$/.exec(url.pathname);
      const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(url.pathname);
      const temperatureMatch = /^\/api\/temperatures\/current\/([^/]+)$/.exec(url.pathname);
      const recipeMatch = /^\/api\/recipes\/([^/]+)$/.exec(url.pathname);
      let route: StubRoute | undefined;
      if (request.method === 'GET' && url.pathname === '/api/cooks') route = 'GET /cooks';
      else if (request.method === 'POST' && url.pathname === '/api/cooks') route = 'POST /cooks';
      else if (request.method === 'POST' && stopMatch) route = 'POST /cooks/{cookId}/stop';
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
      if (!route) {
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
        const owned = devices.has(deviceId);
        if (owned && deviceId === SIM_DEVICE) {
          // HAR-44: the simulated device's reading arrives after a few polls.
          simPolls += 1;
          if (simRouted()) {
            send(200, simReading(SIM_TIMESTAMP), route);
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
        if (deviceId === SIM_DEVICE) {
          // HAR-44: older readings plus the sent one, in pages of two.
          const startTime = url.searchParams.get('startTime');
          if (!startTime || Number.isNaN(Date.parse(startTime))) {
            send(400, { error: 'VALIDATION_ERROR' });
            return;
          }
          const all = [...OLDER_READINGS, ...(simRouted() ? [SIM_TIMESTAMP] : [])].map(simReading);
          const offset = Number(url.searchParams.get('offset') ?? '0');
          send(
            200,
            {
              readings: all.slice(offset, offset + SIM_HISTORY_PAGE),
              total: all.length,
              offset,
              limit: SIM_HISTORY_PAGE,
              hasMore: offset + SIM_HISTORY_PAGE < all.length,
            },
            route
          );
          return;
        }
        send(
          200,
          { readings: [], total: options.historyTotal ?? 0, offset: 0, limit: 100, hasMore: false },
          route
        );
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
      } else if (route === 'POST /cooks') {
        const body = (await readJson(request)) as Partial<StubCook>;
        if (!body?.id || !/^[0-9a-f-]{36}$/i.test(body.id) || !body.deviceId || !body.name) {
          send(400, { error: 'VALIDATION_ERROR' });
          return;
        }
        // HAR-26: a cook only starts on a device the caller registered.
        if (!options.allowAnyDevice && !devices.has(body.deviceId)) {
          send(403, { error: 'DEVICE_NOT_OWNED' }, route);
          return;
        }
        const cook: StubCook = {
          id: body.id,
          userId: 'stub-tenant:stub-user',
          deviceId: body.deviceId,
          name: body.name,
          status: 'active',
          startTime: new Date().toISOString(),
          meatType: body.meatType,
          notes: body.notes,
        };
        cooks.push(cook);
        send(201, cook, route);
      } else {
        const cook = cooks.find(candidate => candidate.id === decodeURIComponent(stopMatch![1]));
        if (!cook) {
          send(404, { error: 'NOT_FOUND' }, route);
          return;
        }
        cook.status = 'completed';
        cook.endTime = new Date().toISOString();
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
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

interface Run extends RunResult {
  readonly output: string;
  readonly lines: readonly string[];
}

async function run(env: Record<string, string | undefined>): Promise<Run> {
  const lines: string[] = [];
  const result = await runAcceptance({ env, write: line => lines.push(line), timeoutMs: 5_000 });
  return { ...result, lines, output: lines.join('\n') };
}

let fakeDir: string;

/**
 * A stand-in for `simdevice`: a Node script, run through its shebang, that
 * prints one JSON line the way simdevice does, or misbehaves as `mode` says.
 * In `ok` mode it exits 2 unless it got `--count 1` and the credential arrived
 * through its environment, so the runner's hand-over is checked too.
 */
function writeFakeSimdevice(mode: FakeMode): string {
  const path = join(fakeDir, `simdevice-${mode}`);
  const script = `#!${process.execPath}
const mode = ${JSON.stringify(mode)};
const conn = process.env.SIMDEVICE_CONNECTION_STRING || '';
const key = (conn.split(';').find(p => p.startsWith('SharedAccessKey=')) || '').slice(16);
const line = o => process.stdout.write(JSON.stringify(o) + '\\n');
const reading = timestamp => ({ messageId: 'f'.repeat(64), deviceId: ${JSON.stringify(SIM_DEVICE)}, timestamp, sentAt: new Date().toISOString() });
if (mode === 'ok') {
  const args = process.argv.slice(2).join(' ');
  if (args !== '--count 1' || conn !== ${JSON.stringify(SIM_CONNECTION_STRING)} || process.env.ACCEPTANCE_BEARER_TOKEN || process.argv.some(a => a.includes(key))) {
    process.stderr.write('fake simdevice: bad hand-over: ' + args + '\\n');
    process.exit(2);
  }
  process.stderr.write('connected\\n');
  line(reading(${JSON.stringify(SIM_TIMESTAMP)}));
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

async function runAgainstStub(options: StubOptions = {}, mode: FakeMode = 'ok'): Promise<Run> {
  stub = await startStub(options);
  return run({
    ACCEPTANCE_BASE_URL: stub.baseUrl,
    ACCEPTANCE_BEARER_TOKEN: TOKEN,
    ...simEnv(mode),
  });
}

const realPoll = { ...ROUNDTRIP_POLL };

beforeAll(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'acceptance-simdevice-'));
  // The round-trip proof polls every 1 s for up to 120 s live; here, far less.
  ROUNDTRIP_POLL.intervalMs = 5;
  ROUNDTRIP_POLL.capMs = 300;
});

afterAll(() => {
  Object.assign(ROUNDTRIP_POLL, realPoll);
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

    // HAR-26: one start on the registered device, one refused on the unowned one.
    const posts = stub!.requests.filter(r => r.method === 'POST' && r.path === '/api/cooks');
    expect(posts).toHaveLength(2);
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

  it.each(ROUTES)('(b) exits non-zero and names %s when it returns a wrong status', async route => {
    const result = await runAgainstStub({ failRoute: { route, status: 503 } });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(`${route} → 503`);
    expect(result.failures[0]).toContain('cooks lifecycle ›');
    expect(result.output).toContain(`FAIL cooks lifecycle`);
  });

  /** HAR-26 and HAR-28: the cooks lifecycle and the temperatures proof also
   *  register their own device, so a broken POST /devices fails them too. */
  const groupsUsing = (route: DeviceRoute): string[] =>
    route === 'POST /devices'
      ? ['cooks lifecycle ›', 'devices ›', 'temperatures ›', 'telemetry round-trip ›']
      : ['devices ›'];

  it.each(DEVICE_ROUTES)(
    '(b) exits non-zero and names %s when it returns a wrong status',
    async route => {
      const result = await runAgainstStub({ failRoute: { route, status: 503 } });

      expect(result.exitCode).not.toBe(0);
      const groups = groupsUsing(route);
      expect(result.failures).toHaveLength(groups.length);
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

  /** HAR-44: the telemetry round-trip reads both temperatures routes too. */
  const TEMPERATURE_GROUPS = ['FAIL temperatures ›', 'FAIL telemetry round-trip ›'];

  it.each(TEMPERATURE_ROUTES)(
    '(b) exits non-zero and names %s when it returns a wrong status',
    async route => {
      const result = await runAgainstStub({ failRoute: { route, status: 503 } });

      expect(result.exitCode).not.toBe(0);
      expect(result.failures).toHaveLength(TEMPERATURE_GROUPS.length);
      TEMPERATURE_GROUPS.forEach(group => {
        const failure = result.failures.find(line => line.startsWith(group));
        expect(failure).toContain(`${route} → 503`);
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
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain('FAIL temperatures ›');
      expect(result.failures[0]).toContain('GET /temperatures/current/{deviceId} → 404');
      expect(result.failures[0]).toContain(`body.error is "${answered}", not ${expected}`);
    }
  );

  it('(b) exits non-zero when GET /temperatures/history is not an empty first page', async () => {
    const result = await runAgainstStub({ historyTotal: 1 });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('FAIL temperatures ›');
    expect(result.failures[0]).toContain('GET /temperatures/history → 200');
    expect(result.failures[0]).toContain('"total":1');
  });

  it.each(TEMPERATURE_ROUTES)('(c) exits non-zero when %s omits the RU header', async route => {
    const result = await runAgainstStub({ omitChargeOn: route });

    expect(result.exitCode).not.toBe(0);
    expect(result.failures).toHaveLength(TEMPERATURE_GROUPS.length);
    TEMPERATURE_GROUPS.forEach(group => {
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
    const env = { ACCEPTANCE_BASE_URL: stub.baseUrl, ACCEPTANCE_BEARER_TOKEN: TOKEN, ...simEnv() };
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
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('unregistered device is 403 DEVICE_NOT_OWNED');
    expect(result.failures[0]).toContain('POST /cooks → 201: expected 403');
  });

  it('(b) exits non-zero when the unauthenticated GET /cooks is not refused', async () => {
    // A stub that lets anyone in (e.g. Easy Auth switched off) must fail proof 1.
    stub = await startStub();
    const lines: string[] = [];
    const result = await runAcceptance({
      env: { ACCEPTANCE_BASE_URL: stub.baseUrl, ACCEPTANCE_BEARER_TOKEN: TOKEN, ...simEnv() },
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
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(route);
    expect(result.failures[0]).toContain(`missing ${REQUEST_CHARGE_HEADER} header`);
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
      expect(output).not.toMatch(/authorization/i);
    }
    // ...and the token was in fact sent on authenticated requests.
    expect(stub!.requests.some(r => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('starts each run with a fresh synthetic device, so reruns never collide', async () => {
    stub = await startStub();
    const env = { ACCEPTANCE_BASE_URL: stub.baseUrl, ACCEPTANCE_BEARER_TOKEN: TOKEN, ...simEnv() };
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
    const metrics = result.lines.filter(line => line.startsWith('METRIC '));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatch(/^METRIC roundtrip-ms \d+$/);
    expect(result.lines.some(line => /^\s+EXEC\s+simdevice --count 1\s+exit 0\s/.test(line))).toBe(
      true
    );

    // A 404 NO_READINGS, then older readings, were polled past.
    const current = stub!.requests.filter(
      r => r.path === `/api/temperatures/current/${SIM_DEVICE}`
    );
    expect(current).toHaveLength(4);
    // History was paged (two per page) until the sent reading turned up, from a
    // window opening five minutes before the send.
    const history = stub!.requests
      .filter(r => r.path.startsWith(`/api/temperatures/history?deviceId=${SIM_DEVICE}&`))
      .map(r => new URL(r.path, 'http://stub').searchParams);
    expect(history.map(params => params.get('offset'))).toEqual([null, '2']);
    const opened = Date.parse(history[0].get('startTime') ?? '');
    expect(Date.now() - opened).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(Date.now() - opened).toBeLessThan(6 * 60 * 1000);
    // Polls go through api.request, so they are in the RU table.
    expect(summaryRow(result.output, 'GET /temperatures/current/{deviceId}')).toBeDefined();
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
    expect(result.output).not.toMatch(/^METRIC /m);
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
