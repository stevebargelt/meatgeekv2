/**
 * HAR-86 — the rollup fold, the read-merge-replace, and the chart query, with
 * NO Azure: an in-memory container (fake-temperature-rollups-container.testing.ts).
 * The same code runs against the real engine in
 * temperature-rollups-repository.emulator.spec.ts.
 */
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';

import {
  fakeRollupsContainer,
  ROLLUP_PAGE_CHARGE,
  ROLLUP_READ_CHARGE,
  ROLLUP_WRITE_CHARGE,
} from './fake-temperature-rollups-container.testing';
import {
  foldReadings,
  mergeSlots,
  rollupDocumentId,
  rollupHoursQuery,
  RollupConflictError,
  ROLLUP_MAX_ATTEMPTS,
  TemperatureRollupsRepository,
  type RollupDelta,
} from './temperature-rollups-repository';

const DEVICE = 'grill-1';

function reading(timestamp: string, temps: Partial<TemperatureReading> = {}): TemperatureReading {
  return { deviceId: DEVICE, timestamp, ...temps };
}

describe('rollupDocumentId', () => {
  it('is <deviceId>:<yyyy-mm-ddThh> in UTC', () => {
    expect(rollupDocumentId(DEVICE, Date.parse('2026-11-20T10:00:00.000Z'))).toBe(
      'grill-1:2026-11-20T10'
    );
  });

  it('encodes characters Cosmos does not allow in an id', () => {
    expect(rollupDocumentId('a/b?c#d', Date.parse('2026-11-20T10:00:00.000Z'))).toBe(
      'a%2Fb%3Fc%23d:2026-11-20T10'
    );
  });
});

describe('foldReadings', () => {
  it('three readings in one minute give n=3 and the min, max and sum per channel', () => {
    const deltas = foldReadings([
      reading('2026-11-20T10:15:05.000Z', { grillTemp: 225, probe1Temp: 150 }),
      reading('2026-11-20T10:15:25.000Z', { grillTemp: 231.5, probe1Temp: 152 }),
      reading('2026-11-20T10:15:55.999Z', { grillTemp: 228, probe1Temp: 149.5 }),
    ]);

    expect(deltas).toEqual([
      {
        id: 'grill-1:2026-11-20T10',
        deviceId: DEVICE,
        hourStart: '2026-11-20T10:00:00.000Z',
        slots: {
          '15': {
            grill: { n: 3, min: 225, max: 231.5, sum: 684.5 },
            probe1: { n: 3, min: 149.5, max: 152, sum: 451.5 },
          },
        },
      },
    ]);
  });

  it('a reading without probe2Temp does not count towards probe2', () => {
    const [delta] = foldReadings([
      reading('2026-11-20T10:15:05.000Z', { grillTemp: 225, probe2Temp: 140 }),
      reading('2026-11-20T10:15:10.000Z', { grillTemp: 226 }),
    ]);

    expect(delta.slots['15']).toEqual({
      grill: { n: 2, min: 225, max: 226, sum: 451 },
      probe2: { n: 1, min: 140, max: 140, sum: 140 },
    });
  });

  it('readings at 10:59:59 and 11:00:00 land in two documents', () => {
    const deltas = foldReadings([
      reading('2026-11-20T10:59:59.000Z', { grillTemp: 225 }),
      reading('2026-11-20T11:00:00.000Z', { grillTemp: 226 }),
    ]);

    expect(deltas.map(d => [d.id, d.hourStart, Object.keys(d.slots)])).toEqual([
      ['grill-1:2026-11-20T10', '2026-11-20T10:00:00.000Z', ['59']],
      ['grill-1:2026-11-20T11', '2026-11-20T11:00:00.000Z', ['0']],
    ]);
  });

  it('buckets by UTC hour whatever the timestamp offset', () => {
    const [delta] = foldReadings([reading('2026-11-20T04:30:10-06:00', { grillTemp: 225 })]);
    expect(delta.id).toBe('grill-1:2026-11-20T10');
    expect(Object.keys(delta.slots)).toEqual(['30']);
  });

  it('keeps devices apart, and drops readings with no temperature', () => {
    const deltas = foldReadings([
      reading('2026-11-20T10:15:05.000Z', { grillTemp: 225 }),
      { deviceId: 'smoker-2', timestamp: '2026-11-20T10:15:05.000Z', grillTemp: 300 },
      { deviceId: 'empty-3', timestamp: '2026-11-20T10:15:05.000Z' },
      reading('not a date', { grillTemp: 1 }),
    ]);
    expect(deltas.map(d => d.id)).toEqual(['grill-1:2026-11-20T10', 'smoker-2:2026-11-20T10']);
  });
});

describe('mergeSlots', () => {
  it('adds n and sum, takes min of mins and max of maxes, and adds new slots and channels', () => {
    const merged = mergeSlots(
      { '1': { grill: { n: 2, min: 220, max: 230, sum: 450 } } },
      {
        '1': {
          grill: { n: 1, min: 210, max: 210, sum: 210 },
          probe3: { n: 1, min: 100, max: 100, sum: 100 },
        },
        '2': { grill: { n: 1, min: 240, max: 240, sum: 240 } },
      }
    );
    expect(merged).toEqual({
      '1': {
        grill: { n: 3, min: 210, max: 230, sum: 660 },
        probe3: { n: 1, min: 100, max: 100, sum: 100 },
      },
      '2': { grill: { n: 1, min: 240, max: 240, sum: 240 } },
    });
  });
});

function delta(slots: RollupDelta['slots'], hour = '2026-11-20T10'): RollupDelta {
  return {
    id: `${DEVICE}:${hour}`,
    deviceId: DEVICE,
    hourStart: `${hour}:00:00.000Z`,
    slots,
  };
}

describe('TemperatureRollupsRepository.applyBucket', () => {
  it('creates an absent document: one read, one create, both charges', async () => {
    const fake = fakeRollupsContainer();
    const repository = new TemperatureRollupsRepository(fake.container);

    const charge = await repository.applyBucket(
      delta({ '5': { grill: { n: 1, min: 225, max: 225, sum: 225 } } })
    );

    expect(fake.calls.map(c => c.op)).toEqual(['read', 'create']);
    expect(charge).toBe(ROLLUP_READ_CHARGE + ROLLUP_WRITE_CHARGE);
    expect(fake.get(DEVICE, 'grill-1:2026-11-20T10')).toEqual({
      id: 'grill-1:2026-11-20T10',
      deviceId: DEVICE,
      hourStart: '2026-11-20T10:00:00.000Z',
      slots: { '5': { grill: { n: 1, min: 225, max: 225, sum: 225 } } },
    });
  });

  it('merges into an existing document with IfMatch on the etag read', async () => {
    const fake = fakeRollupsContainer();
    fake.seed({
      id: 'grill-1:2026-11-20T10',
      deviceId: DEVICE,
      hourStart: '2026-11-20T10:00:00.000Z',
      slots: { '5': { grill: { n: 1, min: 225, max: 225, sum: 225 } } },
      _rid: 'system-property',
    });
    const repository = new TemperatureRollupsRepository(fake.container);

    await repository.applyBucket(delta({ '5': { grill: { n: 1, min: 230, max: 230, sum: 230 } } }));

    expect(fake.writes()).toEqual([
      { op: 'replace', id: 'grill-1:2026-11-20T10', ifMatch: '"etag-1"' },
    ]);
    // The replace writes only the modelled fields.
    expect(fake.get(DEVICE, 'grill-1:2026-11-20T10')).toEqual({
      id: 'grill-1:2026-11-20T10',
      deviceId: DEVICE,
      hourStart: '2026-11-20T10:00:00.000Z',
      slots: { '5': { grill: { n: 2, min: 225, max: 230, sum: 455 } } },
    });
  });

  it('a 412 on replace is retried from a fresh read, and nothing is lost', async () => {
    const fake = fakeRollupsContainer();
    fake.seed({
      id: 'grill-1:2026-11-20T10',
      deviceId: DEVICE,
      hourStart: '2026-11-20T10:00:00.000Z',
      slots: { '5': { grill: { n: 1, min: 225, max: 225, sum: 225 } } },
    });
    let raced = false;
    fake.beforeWrite(() => {
      if (raced) return;
      raced = true;
      // A concurrent writer lands between our read and our replace.
      fake.seed({
        id: 'grill-1:2026-11-20T10',
        deviceId: DEVICE,
        hourStart: '2026-11-20T10:00:00.000Z',
        slots: { '5': { grill: { n: 2, min: 200, max: 225, sum: 425 } } },
      });
    });
    const repository = new TemperatureRollupsRepository(fake.container);

    await repository.applyBucket(delta({ '5': { grill: { n: 1, min: 230, max: 230, sum: 230 } } }));

    expect(fake.calls.map(c => c.op)).toEqual(['read', 'replace', 'read', 'replace']);
    expect(fake.get(DEVICE, 'grill-1:2026-11-20T10')?.['slots']).toEqual({
      '5': { grill: { n: 3, min: 200, max: 230, sum: 655 } },
    });
  });

  it('a 409 on create is retried as a read and a replace', async () => {
    const fake = fakeRollupsContainer();
    let raced = false;
    fake.beforeWrite(op => {
      if (raced || op !== 'create') return;
      raced = true;
      fake.seed({
        id: 'grill-1:2026-11-20T10',
        deviceId: DEVICE,
        hourStart: '2026-11-20T10:00:00.000Z',
        slots: { '7': { probe1: { n: 1, min: 150, max: 150, sum: 150 } } },
      });
    });
    const repository = new TemperatureRollupsRepository(fake.container);

    await repository.applyBucket(delta({ '5': { grill: { n: 1, min: 230, max: 230, sum: 230 } } }));

    expect(fake.calls.map(c => c.op)).toEqual(['read', 'create', 'read', 'replace']);
    expect(fake.get(DEVICE, 'grill-1:2026-11-20T10')?.['slots']).toEqual({
      '5': { grill: { n: 1, min: 230, max: 230, sum: 230 } },
      '7': { probe1: { n: 1, min: 150, max: 150, sum: 150 } },
    });
  });

  it(`throws RollupConflictError after ${ROLLUP_MAX_ATTEMPTS} lost rounds`, async () => {
    const fake = fakeRollupsContainer();
    fake.seed({
      id: 'grill-1:2026-11-20T10',
      deviceId: DEVICE,
      hourStart: '2026-11-20T10:00:00.000Z',
      slots: {},
    });
    // Every replace loses the race.
    fake.beforeWrite(() =>
      fake.seed({
        id: 'grill-1:2026-11-20T10',
        deviceId: DEVICE,
        hourStart: '2026-11-20T10:00:00.000Z',
        slots: {},
      })
    );
    const repository = new TemperatureRollupsRepository(fake.container);

    await expect(
      repository.applyBucket(delta({ '5': { grill: { n: 1, min: 230, max: 230, sum: 230 } } }))
    ).rejects.toBeInstanceOf(RollupConflictError);
    expect(fake.calls.filter(c => c.op === 'replace')).toHaveLength(ROLLUP_MAX_ATTEMPTS);
  });

  it('propagates any other failure without retrying', async () => {
    const fake = fakeRollupsContainer();
    fake.beforeWrite(() => {
      throw Object.assign(new Error('throttled'), { code: 429 });
    });
    const repository = new TemperatureRollupsRepository(fake.container);

    await expect(
      repository.applyBucket(delta({ '5': { grill: { n: 1, min: 230, max: 230, sum: 230 } } }))
    ).rejects.toMatchObject({ code: 429 });
    expect(fake.calls.map(c => c.op)).toEqual(['read', 'create']);
  });
});

describe('TemperatureRollupsRepository.queryHours', () => {
  it('is one single-partition query on deviceId and the hourStart range, every page summed', async () => {
    const fake = fakeRollupsContainer();
    for (const hour of ['09', '10', '11', '12']) {
      fake.seed({
        id: `${DEVICE}:2026-11-20T${hour}`,
        deviceId: DEVICE,
        hourStart: `2026-11-20T${hour}:00:00.000Z`,
        slots: { '0': { grill: { n: 1, min: 1, max: 1, sum: 1 } } },
      });
    }
    fake.seed({
      id: 'other:2026-11-20T10',
      deviceId: 'other',
      hourStart: '2026-11-20T10:00:00.000Z',
      slots: {},
    });
    const repository = new TemperatureRollupsRepository(fake.container);

    const result = await repository.queryHours({
      deviceId: DEVICE,
      fromHourStart: '2026-11-20T10:00:00.000Z',
      toHourStart: '2026-11-20T12:00:00.000Z',
    });

    expect(result.hours.map(h => h.hourStart).sort()).toEqual([
      '2026-11-20T10:00:00.000Z',
      '2026-11-20T11:00:00.000Z',
    ]);
    expect(result.requestCharge).toBe(2 * ROLLUP_PAGE_CHARGE);
    const queries = fake.calls.filter(c => c.op === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ partitionKey: DEVICE });
  });

  it('has no upper bound when toHourStart is absent', () => {
    expect(
      rollupHoursQuery({ deviceId: DEVICE, fromHourStart: '2026-11-20T10:00:00.000Z' })
    ).toEqual({
      query:
        'SELECT c.deviceId, c.hourStart, c.slots FROM c WHERE c.deviceId = @deviceId AND c.hourStart >= @from',
      parameters: [
        { name: '@deviceId', value: DEVICE },
        { name: '@from', value: '2026-11-20T10:00:00.000Z' },
      ],
    });
  });
});
