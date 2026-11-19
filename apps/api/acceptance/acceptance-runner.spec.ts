/**
 * HAR-11 — self-test for the live acceptance suite. Runs under ordinary
 * `nx test api`, never against a deployed system: it starts an in-process HTTP
 * stub that imitates the cooks and devices routes and drives the REAL runner and the REAL
 * proof files (discovered from ./proofs) against it.
 */
import { randomUUID } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { REQUEST_CHARGE_HEADER } from '../src/shared/cosmos/request-charge';
import { runAcceptance, RunResult } from './lib/runner';

const TOKEN = 'eyJ0eXAi.SECRET-acceptance-token.value-9f3c';

type CookRoute = 'GET /cooks' | 'POST /cooks' | 'POST /cooks/{cookId}/stop';
type DeviceRoute = 'GET /devices' | 'POST /devices' | 'GET /devices/{id}' | 'PATCH /devices/{id}';
type StubRoute = CookRoute | DeviceRoute;

interface StubOptions {
  /** Answer this route with this status (and an RU header) instead. */
  readonly failRoute?: { readonly route: StubRoute; readonly status: number };
  /** Answer this route normally but without the RU header. */
  readonly omitChargeOn?: StubRoute;
  /** Echo the caller's Authorization header back in bodies and headers. */
  readonly echoAuthorization?: boolean;
  /** Start cooks on any device, registered or not (the pre-HAR-26 behaviour). */
  readonly allowAnyDevice?: boolean;
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

const RU: Record<StubRoute, string> = {
  'GET /cooks': '2.83',
  'POST /cooks': '11.43',
  'POST /cooks/{cookId}/stop': '20.1',
  'GET /devices': '3.11',
  'POST /devices': '9.52',
  'GET /devices/{id}': '1',
  'PATCH /devices/{id}': '11.9',
};

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

/** An in-process imitation of the deployed cooks and devices routes under `/api`. */
async function startStub(options: StubOptions = {}): Promise<Stub> {
  const cooks: StubCook[] = [];
  const devices = new Map<string, StubDevice>();
  const requests: Stub['requests'] = [];

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
      let route: StubRoute | undefined;
      if (request.method === 'GET' && url.pathname === '/api/cooks') route = 'GET /cooks';
      else if (request.method === 'POST' && url.pathname === '/api/cooks') route = 'POST /cooks';
      else if (request.method === 'POST' && stopMatch) route = 'POST /cooks/{cookId}/stop';
      else if (request.method === 'GET' && url.pathname === '/api/devices') route = 'GET /devices';
      else if (request.method === 'POST' && url.pathname === '/api/devices')
        route = 'POST /devices';
      else if (request.method === 'GET' && deviceMatch) route = 'GET /devices/{id}';
      else if (request.method === 'PATCH' && deviceMatch) route = 'PATCH /devices/{id}';
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

      if (route === 'GET /devices') {
        send(200, { devices: [...devices.values()] }, route);
      } else if (route === 'POST /devices') {
        const body = (await readJson(request)) as Partial<StubDevice> & { deviceId?: string };
        if (!body?.deviceId || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.deviceId) || !body.name) {
          send(400, { error: 'VALIDATION_ERROR' });
          return;
        }
        if (devices.has(body.deviceId)) {
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

let stub: Stub | undefined;

async function runAgainstStub(options: StubOptions = {}): Promise<Run> {
  stub = await startStub(options);
  return run({ ACCEPTANCE_BASE_URL: stub.baseUrl, ACCEPTANCE_BEARER_TOKEN: TOKEN });
}

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

describe('live acceptance runner (against an in-process stub)', () => {
  it('(a) exits 0 against a passing stub and reports RU for every cooks and devices route', async () => {
    const result = await runAgainstStub();

    expect(result.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/\d+ passed, 0 failed, 0 skipped/);

    // Every authenticated request line carries the RU the stub reported.
    const requestLines = result.lines.filter(line => /^\s+(GET|POST|PATCH)\s+\//.test(line));
    expect(requestLines.length).toBeGreaterThanOrEqual(5);
    for (const route of [...ROUTES, ...DEVICE_ROUTES]) {
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

  /** HAR-26: the cooks lifecycle also registers its device, so a broken
   *  POST /devices fails that group too. */
  const groupsUsing = (route: DeviceRoute): string[] =>
    route === 'POST /devices' ? ['cooks lifecycle ›', 'devices ›'] : ['devices ›'];

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
      env: { ACCEPTANCE_BASE_URL: stub.baseUrl, ACCEPTANCE_BEARER_TOKEN: TOKEN },
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
    const env = { ACCEPTANCE_BASE_URL: stub.baseUrl, ACCEPTANCE_BEARER_TOKEN: TOKEN };
    const first = await runAcceptance({ env, write: () => undefined, runId: `r-${randomUUID()}` });
    const second = await runAcceptance({ env, write: () => undefined, runId: `r-${randomUUID()}` });

    expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
  });
});
