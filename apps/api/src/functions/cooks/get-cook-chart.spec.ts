/**
 * HAR-86 — GET /cooks/{cookId}/chart, with NO Azure and NO credentials.
 *
 * The handler runs over the REAL CooksRepository (on a minimal in-memory cooks
 * container, as get-cook.spec.ts does) and the REAL TemperatureRollupsRepository
 * (on fake-temperature-rollups-container.testing.ts), and reads real base64
 * X-MS-CLIENT-PRINCIPAL headers through the real principal.ts.
 *
 * HAR-136: the device is read too (the REAL DevicesRepository on
 * fake-devices-container.testing.ts), so a claimed device's chart starts no
 * earlier than its `claimedAt`. By default the device is the caller's, with no
 * `claimedAt`, so the HAR-86 cases are unbounded by a claim.
 */
import type { Container } from '@azure/cosmos';
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Cook, CookChart, Device } from '@meatgeekv2/api-interfaces';

import { principalFromRequest } from '../../shared/auth/principal';
import {
  ACTIVE_DEVICE_LOCK_DOC_TYPE,
  CooksRepository,
  activeDeviceLockId,
} from '../../shared/cosmos/cooks-repository';
import { DevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  FakeDevicesContainer,
  READ_CHARGE as DEVICE_READ_CHARGE,
} from '../../shared/cosmos/fake-devices-container.testing';
import {
  fakeRollupsContainer,
  ROLLUP_PAGE_CHARGE,
} from '../../shared/cosmos/fake-temperature-rollups-container.testing';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import {
  TemperatureRollupsRepository,
  type HourSlots,
  type MinuteSlot,
} from '../../shared/cosmos/temperature-rollups-repository';
import {
  bucketSecondsFor,
  getCookChartHandler,
  MAX_CHART_POINTS,
  type GetCookChartDeps,
} from './get-cook-chart';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const USER_ID = `${TID}:${OID}`;
const OTHER_OID = 'oid-zzzz-9999';
const COOK_ID = '3f4a5b6c-7d8e-4f9a-8b1c-2d3e4f5a6b7c';
const DEVICE = 'grill-1';
const READ_CHARGE = 1.24;

function encodedPrincipal(oid: string, tid = TID): string {
  const payload = {
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: tid },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function request(options: { cookId?: string; principal?: string | null; requestId?: string }) {
  const headers = new Map<string, string>();
  const principal = options.principal === undefined ? encodedPrincipal(OID) : options.principal;
  if (principal !== null) headers.set('x-ms-client-principal', principal);
  if (options.requestId !== undefined) headers.set('x-request-id', options.requestId);
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: new URLSearchParams(),
    params: options.cookId === undefined ? {} : { cookId: options.cookId },
  } as unknown as HttpRequest;
}

function context() {
  const errors: string[] = [];
  const ctx = {
    invocationId: 'inv-86',
    log: () => undefined,
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
  } as unknown as InvocationContext;
  return { ctx, errors };
}

function cook(overrides: Partial<Cook> = {}): Cook {
  return {
    id: COOK_ID,
    userId: USER_ID,
    deviceId: DEVICE,
    name: 'Weekend Brisket',
    status: 'active',
    startTime: '2026-11-20T06:15:30.000Z',
    meatType: 'brisket',
    ...overrides,
  };
}

/** The caller's device, as the devices container stores it. */
function ownDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: DEVICE,
    userId: USER_ID,
    name: 'Backyard Smoker',
    model: 'MeatGeek V1',
    isActive: true,
    ...overrides,
  };
}

function setup(nowIso = '2026-11-20T08:00:00.000Z') {
  const cooks = new Map<string, Record<string, unknown>>();
  const cookReads: Array<{ id: string; partitionKey: unknown }> = [];
  const cooksContainer = {
    item: (id: string, partitionKey: unknown) => ({
      read: async () => {
        cookReads.push({ id, partitionKey });
        const resource = cooks.get(`${String(partitionKey)}/${id}`);
        return {
          resource,
          statusCode: resource ? 200 : 404,
          etag: resource ? '"etag-1"' : undefined,
          requestCharge: READ_CHARGE,
        };
      },
    }),
  } as unknown as Container;
  const rollups = fakeRollupsContainer();
  const getRollupsRepository = jest.fn(() => new TemperatureRollupsRepository(rollups.container));
  const devices = new FakeDevicesContainer();
  devices.seed(ownDevice());
  const deps: GetCookChartDeps = {
    resolvePrincipal: principalFromRequest,
    getCooksRepository: () => new CooksRepository(cooksContainer),
    getDevicesRepository: () => new DevicesRepository(devices.asContainer()),
    getRollupsRepository,
    now: () => Date.parse(nowIso),
  };
  return {
    deps,
    rollups,
    cookReads,
    devices,
    getRollupsRepository,
    /** HAR-136: the caller's device, claimed at `claimedAt`. */
    claimDevice(claimedAt: string) {
      devices.seed(ownDevice({ claimedAt }));
    },
    seedCook(document: Record<string, unknown>) {
      cooks.set(`${document['userId']}/${document['id']}`, { ...document, _rid: 'r', _etag: 'e' });
    },
    /** An hour document for `hour` ("2026-11-20T06") with these minute slots. */
    seedHour(hour: string, slots: HourSlots, deviceId = DEVICE) {
      rollups.seed({ id: `${deviceId}:${hour}`, deviceId, hourStart: `${hour}:00:00.000Z`, slots });
    },
  };
}

function grill(n: number, min: number, max: number, sum: number): MinuteSlot {
  return { grill: { n, min, max, sum } };
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

async function chartOf(fixture: ReturnType<typeof setup>): Promise<CookChart> {
  const response = await getCookChartHandler(
    request({ cookId: COOK_ID }),
    context().ctx,
    fixture.deps
  );
  expect(response.status).toBe(200);
  return response.jsonBody as CookChart;
}

describe('GET /cooks/{cookId}/chart: ownership and validation', () => {
  it('404 NOT_FOUND for an absent cook, with the read charge and no rollup query', async () => {
    const fixture = setup();
    const response = await getCookChartHandler(
      request({ cookId: COOK_ID }),
      context().ctx,
      fixture.deps
    );
    expect(response.status).toBe(404);
    expect(response.jsonBody).toEqual({
      error: 'NOT_FOUND',
      message: 'Cook not found',
      requestId: 'inv-86',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(fixture.rollups.calls).toEqual([]);
  });

  it("404 for another user's cook, without reading their partition", async () => {
    const fixture = setup();
    fixture.seedCook({ ...cook() });
    const response = await getCookChartHandler(
      request({ cookId: COOK_ID, principal: encodedPrincipal(OTHER_OID) }),
      context().ctx,
      fixture.deps
    );
    expect(response.status).toBe(404);
    expect(fixture.cookReads).toEqual([{ id: COOK_ID, partitionKey: `${TID}:${OTHER_OID}` }]);
    expect(fixture.rollups.calls).toEqual([]);
  });

  it('404 for the device lock id, which shares the partition but is not a cook', async () => {
    const fixture = setup();
    const lockId = activeDeviceLockId(DEVICE);
    fixture.seedCook({
      id: lockId,
      userId: USER_ID,
      docType: ACTIVE_DEVICE_LOCK_DOC_TYPE,
      deviceId: DEVICE,
      cookId: COOK_ID,
    });
    const response = await getCookChartHandler(
      request({ cookId: lockId }),
      context().ctx,
      fixture.deps
    );
    expect(response.status).toBe(404);
    expect(fixture.rollups.calls).toEqual([]);
  });

  it('400 VALIDATION_ERROR for an empty or over-long id, with no Cosmos call', async () => {
    for (const cookId of ['', 'x'.repeat(129)]) {
      const fixture = setup();
      const response = await getCookChartHandler(request({ cookId }), context().ctx, fixture.deps);
      expect(response.status).toBe(400);
      expect((response.jsonBody as { error: string }).error).toBe('VALIDATION_ERROR');
      expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
      expect(fixture.cookReads).toEqual([]);
    }
  });

  it('401 without a principal', async () => {
    const fixture = setup();
    const response = await getCookChartHandler(
      request({ cookId: COOK_ID, principal: null }),
      context().ctx,
      fixture.deps
    );
    expect(response.status).toBe(401);
    expect(fixture.cookReads).toEqual([]);
  });
});

describe('GET /cooks/{cookId}/chart: the window', () => {
  it('a completed cook queries [hour of startTime, endTime) and drops slots outside the window', async () => {
    const fixture = setup('2026-11-21T00:00:00.000Z');
    fixture.seedCook({
      ...cook({ status: 'completed', endTime: '2026-11-20T07:30:00.000Z' }),
    });
    fixture.seedHour('2026-11-20T05', { '59': grill(1, 1, 1, 1) }); // before the window
    fixture.seedHour('2026-11-20T06', {
      '14': grill(1, 2, 2, 2), // the minute before startTime's
      '15': grill(1, 225, 225, 225), // startTime's minute is kept whole
      '16': grill(1, 226, 226, 226),
    });
    fixture.seedHour('2026-11-20T07', {
      '29': grill(1, 230, 230, 230),
      '30': grill(1, 999, 999, 999), // at endTime: excluded
      '45': grill(1, 999, 999, 999), // after endTime
    });
    fixture.seedHour('2026-11-20T08', { '0': grill(1, 999, 999, 999) }); // after endTime

    const chart = await chartOf(fixture);

    const query = fixture.rollups.calls.find(c => c.op === 'query');
    expect(query).toMatchObject({
      partitionKey: DEVICE,
      parameters: [
        { name: '@deviceId', value: DEVICE },
        { name: '@from', value: '2026-11-20T06:00:00.000Z' },
        { name: '@to', value: '2026-11-20T07:30:00.000Z' },
      ],
    });
    expect(chart).toEqual({
      cookId: COOK_ID,
      deviceId: DEVICE,
      startTime: '2026-11-20T06:15:30.000Z',
      endTime: '2026-11-20T07:30:00.000Z',
      bucketSeconds: 60,
      points: [
        { t: '2026-11-20T06:15:00.000Z', grill: { min: 225, max: 225, avg: 225 } },
        { t: '2026-11-20T06:16:00.000Z', grill: { min: 226, max: 226, avg: 226 } },
        { t: '2026-11-20T07:29:00.000Z', grill: { min: 230, max: 230, avg: 230 } },
      ],
    });
  });

  it('an active cook has no upper bound, and includes slots after now', async () => {
    const fixture = setup('2026-11-20T07:00:00.000Z');
    fixture.seedCook({ ...cook() });
    fixture.seedHour('2026-11-20T06', { '20': grill(1, 225, 225, 225) });
    // A device clock ahead of the server: data after now still counts.
    fixture.seedHour('2026-11-20T09', { '10': grill(1, 240, 240, 240) });

    const chart = await chartOf(fixture);

    const query = fixture.rollups.calls.find(c => c.op === 'query');
    expect(query).toMatchObject({
      parameters: [
        { name: '@deviceId', value: DEVICE },
        { name: '@from', value: '2026-11-20T06:00:00.000Z' },
      ],
    });
    expect(chart.endTime).toBeUndefined();
    expect(chart.points.map(p => p.t)).toEqual([
      '2026-11-20T06:20:00.000Z',
      '2026-11-20T09:10:00.000Z',
    ]);
  });

  it("only reads the cook's own device", async () => {
    const fixture = setup();
    fixture.seedCook({ ...cook() });
    fixture.seedHour('2026-11-20T06', { '20': grill(1, 999, 999, 999) }, 'someone-elses-device');

    const chart = await chartOf(fixture);

    expect(chart.points).toEqual([]);
  });
});

describe('GET /cooks/{cookId}/chart: the claim bound (HAR-136)', () => {
  it('a device claimed after the cook started shows only slots from its claim on', async () => {
    const fixture = setup('2026-11-21T00:00:00.000Z');
    fixture.claimDevice('2026-11-20T07:10:00.000Z');
    fixture.seedCook({
      ...cook({ status: 'completed', endTime: '2026-11-20T07:30:00.000Z' }),
    });
    fixture.seedHour('2026-11-20T06', { '20': grill(1, 999, 999, 999) }); // before the claim
    fixture.seedHour('2026-11-20T07', {
      '9': grill(1, 999, 999, 999), // the minute before the claim
      '10': grill(1, 230, 230, 230), // the claim's minute starts at claimedAt: kept
      '20': grill(1, 231, 231, 231),
    });

    const chart = await chartOf(fixture);

    // The bound is in the query: the hour containing claimedAt, not the cook's.
    const query = fixture.rollups.calls.find(c => c.op === 'query');
    expect(query).toMatchObject({
      partitionKey: DEVICE,
      parameters: [
        { name: '@deviceId', value: DEVICE },
        { name: '@from', value: '2026-11-20T07:00:00.000Z' },
        { name: '@to', value: '2026-11-20T07:30:00.000Z' },
      ],
    });
    expect(chart.startTime).toBe('2026-11-20T06:15:30.000Z');
    expect(chart.points).toEqual([
      { t: '2026-11-20T07:10:00.000Z', grill: { min: 230, max: 230, avg: 230 } },
      { t: '2026-11-20T07:20:00.000Z', grill: { min: 231, max: 231, avg: 231 } },
    ]);
  });

  it('drops the minute a mid-minute claim falls in, which may hold earlier readings', async () => {
    const fixture = setup('2026-11-20T08:00:00.000Z');
    fixture.claimDevice('2026-11-20T06:40:20.000Z');
    fixture.seedCook({ ...cook() });
    fixture.seedHour('2026-11-20T06', {
      '20': grill(1, 999, 999, 999),
      '40': grill(1, 999, 999, 999), // 06:40:00-06:41:00 straddles the claim
      '41': grill(1, 241, 241, 241),
    });

    const chart = await chartOf(fixture);

    expect(chart.points.map(p => p.t)).toEqual(['2026-11-20T06:41:00.000Z']);
  });

  it('a claim before the cook started leaves the window as the cook has it', async () => {
    const fixture = setup('2026-11-20T08:00:00.000Z');
    fixture.claimDevice('2026-11-19T12:00:00.000Z');
    fixture.seedCook({ ...cook() });
    fixture.seedHour('2026-11-20T06', {
      '14': grill(1, 999, 999, 999),
      '15': grill(1, 225, 225, 225),
    });

    const chart = await chartOf(fixture);

    const query = fixture.rollups.calls.find(c => c.op === 'query');
    expect(query).toMatchObject({
      parameters: [
        { name: '@deviceId', value: DEVICE },
        { name: '@from', value: '2026-11-20T06:00:00.000Z' },
      ],
    });
    expect(chart.points.map(p => p.t)).toEqual(['2026-11-20T06:15:00.000Z']);
  });

  it('a device without claimedAt (POST /devices) is not bounded', async () => {
    const fixture = setup('2026-11-20T08:00:00.000Z');
    fixture.seedCook({ ...cook() });
    fixture.seedHour('2026-11-20T06', { '15': grill(1, 225, 225, 225) });

    const chart = await chartOf(fixture);

    expect(fixture.devices.stored(DEVICE)?.['claimedAt']).toBeUndefined();
    expect(chart.points.map(p => p.t)).toEqual(['2026-11-20T06:15:00.000Z']);
  });
});

describe('GET /cooks/{cookId}/chart: buckets', () => {
  it('a 13-hour span gives bucketSeconds 120 and at most 720 points', async () => {
    const fixture = setup('2026-11-20T19:00:00.000Z');
    fixture.seedCook({
      ...cook({
        status: 'completed',
        startTime: '2026-11-20T06:00:00.000Z',
        endTime: '2026-11-20T19:00:00.000Z',
      }),
    });
    for (let h = 6; h < 19; h += 1) {
      const slots: HourSlots = {};
      for (let m = 0; m < 60; m += 1) slots[String(m)] = grill(1, 225, 225, 225);
      fixture.seedHour(`2026-11-20T${String(h).padStart(2, '0')}`, slots);
    }

    const chart = await chartOf(fixture);

    expect(chart.bucketSeconds).toBe(120);
    expect(chart.points).toHaveLength(390);
    expect(chart.points.length).toBeLessThanOrEqual(MAX_CHART_POINTS);
  });

  it('2-minute merging: avg is Σsum/Σn and min/max are the min of mins and max of maxes', async () => {
    const fixture = setup('2026-11-20T19:00:00.000Z');
    fixture.seedCook({
      ...cook({
        status: 'completed',
        startTime: '2026-11-20T06:00:00.000Z',
        endTime: '2026-11-20T19:00:00.000Z',
      }),
    });
    fixture.seedHour('2026-11-20T06', {
      '0': {
        grill: { n: 3, min: 220, max: 230, sum: 675 },
        probe1: { n: 2, min: 140, max: 150, sum: 290 },
      },
      '1': { grill: { n: 1, min: 210, max: 210, sum: 210 } },
      '2': { probe4: { n: 1, min: 100, max: 100, sum: 100 } },
    });

    const chart = await chartOf(fixture);

    expect(chart.bucketSeconds).toBe(120);
    expect(chart.points).toEqual([
      {
        t: '2026-11-20T06:00:00.000Z',
        grill: { min: 210, max: 230, avg: (675 + 210) / 4 },
        probe1: { min: 140, max: 150, avg: 145 },
      },
      { t: '2026-11-20T06:02:00.000Z', probe4: { min: 100, max: 100, avg: 100 } },
    ]);
  });

  it('picks the smallest width that keeps the span at 720 buckets or fewer', () => {
    const minutes = (m: number) => m * 60_000;
    expect(bucketSecondsFor(0)).toBe(60);
    expect(bucketSecondsFor(minutes(720))).toBe(60);
    expect(bucketSecondsFor(minutes(721))).toBe(120);
    expect(bucketSecondsFor(minutes(13 * 60))).toBe(120);
    expect(bucketSecondsFor(minutes(24 * 60 + 1))).toBe(300);
    expect(bucketSecondsFor(minutes(1000 * 60))).toBe(7200);
    expect(bucketSecondsFor(minutes(3000 * 60))).toBe(21600);
    // Past 180 days even 6 h buckets overflow; the widest is used.
    expect(bucketSecondsFor(minutes(5000 * 60))).toBe(21600);
  });
});

describe('GET /cooks/{cookId}/chart: headers', () => {
  it('x-meatgeek-request-charge sums the point reads and every query page', async () => {
    const fixture = setup();
    fixture.seedCook({ ...cook() });
    fixture.seedHour('2026-11-20T06', { '20': grill(1, 225, 225, 225) });
    fixture.seedHour('2026-11-20T07', { '20': grill(1, 226, 226, 226) });

    const response = await getCookChartHandler(
      request({ cookId: COOK_ID, requestId: 'req-9' }),
      context().ctx,
      fixture.deps
    );

    expect(response.status).toBe(200);
    expect(fixture.rollups.calls.filter(c => c.op === 'query')).toHaveLength(1);
    // The cook read, the device read (HAR-136) and both pages.
    expect(Number(header(response, REQUEST_CHARGE_HEADER))).toBeCloseTo(
      READ_CHARGE + DEVICE_READ_CHARGE + 2 * ROLLUP_PAGE_CHARGE
    );
    expect(header(response, 'X-Request-ID')).toBe('req-9');
  });

  it('500 on a rollup query failure, with the charge spent so far and fixed text', async () => {
    const fixture = setup();
    fixture.seedCook({ ...cook() });
    fixture.getRollupsRepository.mockReturnValue({
      queryHours: async () => {
        throw Object.assign(new Error('https://secret-account.documents.azure.com/ down'), {
          code: 503,
        });
      },
    } as unknown as TemperatureRollupsRepository);
    const { ctx, errors } = context();

    const response = await getCookChartHandler(request({ cookId: COOK_ID }), ctx, fixture.deps);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to retrieve cook chart',
      requestId: 'inv-86',
    });
    expect(Number(header(response, REQUEST_CHARGE_HEADER))).toBeCloseTo(
      READ_CHARGE + DEVICE_READ_CHARGE
    );
    expect(errors.join('\n')).toContain('getCookChart failed: cosmos_status_503');
    expect(errors.join('\n')).not.toContain('secret-account');
  });
});

describe('GET /cooks/{cookId}/chart: the 720-point bound', () => {
  it('keeps only the newest 720 buckets when even 6 h buckets overflow', async () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const fixture = setup('2026-11-20T00:00:00.000Z');
    fixture.seedCook({ ...cook({ startTime: new Date(start).toISOString() }) });
    // One reading every 6 h for 200 days: 800 buckets of data.
    for (let k = 0; k < 800; k += 1) {
      const hour = new Date(start + k * 6 * 3_600_000).toISOString().slice(0, 13);
      fixture.seedHour(hour, { '0': grill(1, 225, 225, 225) });
    }

    const chart = await chartOf(fixture);

    expect(chart.bucketSeconds).toBe(21600);
    expect(chart.points).toHaveLength(MAX_CHART_POINTS);
    expect(chart.points[0].t).toBe(new Date(start + 80 * 6 * 3_600_000).toISOString());
  });
});
