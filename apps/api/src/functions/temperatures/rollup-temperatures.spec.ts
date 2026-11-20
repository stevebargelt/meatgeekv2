/**
 * HAR-86 — the rollupTemperatures change-feed handler, with NO Azure: the real
 * TemperatureRollupsRepository over an in-memory container, fed IoT-Hub-shaped
 * `temperatures` documents as the change feed delivers them.
 */
import type { InvocationContext } from '@azure/functions';

import {
  fakeRollupsContainer,
  ROLLUP_READ_CHARGE,
  ROLLUP_WRITE_CHARGE,
} from '../../shared/cosmos/fake-temperature-rollups-container.testing';
import {
  RollupConflictError,
  TemperatureRollupsRepository,
} from '../../shared/cosmos/temperature-rollups-repository';
import {
  ROLLUP_WRITE_RU_PER_SECOND,
  rollupTemperaturesHandler,
  type RollupTemperaturesDeps,
} from './rollup-temperatures';

const DEVICE = 'grill-1';

/** A stored `temperatures` document as IoT Hub's routing endpoint writes it. */
function stored(options: {
  body: unknown;
  enqueuedTime?: string;
  partitionDeviceId?: string;
  hubDeviceId?: string;
}) {
  const partitionDeviceId = options.partitionDeviceId ?? DEVICE;
  return {
    id: `doc-${Math.random()}`,
    deviceId: partitionDeviceId,
    iothub_name: 'hub',
    Body: options.body,
    Properties: {},
    SystemProperties: {
      'iothub-connection-device-id': options.hubDeviceId ?? partitionDeviceId,
      'iothub-enqueuedtime': options.enqueuedTime ?? '2026-11-20T10:15:00.500Z',
    },
    _rid: 'rid',
    _ts: 1,
  };
}

function context() {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx = {
    invocationId: 'inv-rollup',
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
  } as unknown as InvocationContext;
  return { ctx, logs, errors };
}

function setup() {
  const fake = fakeRollupsContainer();
  const sleeps: number[] = [];
  const deps: RollupTemperaturesDeps = {
    getRepository: () => new TemperatureRollupsRepository(fake.container),
    now: () => 0,
    sleep: async ms => {
      sleeps.push(ms);
    },
  };
  return { fake, deps, sleeps };
}

describe('rollupTemperatures', () => {
  it('one batch touching two hours makes exactly two writes, one per document', async () => {
    const { fake, deps } = setup();
    const batch = [
      stored({ body: { timestamp: '2026-11-20T10:58:00.000Z', grillTemp: 225 } }),
      stored({ body: { timestamp: '2026-11-20T10:59:59.000Z', grillTemp: 226 } }),
      stored({ body: { timestamp: '2026-11-20T11:00:00.000Z', grillTemp: 227 } }),
      stored({ body: { timestamp: '2026-11-20T11:00:05.000Z', grillTemp: 228 } }),
    ];

    await rollupTemperaturesHandler(batch, context().ctx, deps);

    expect(fake.writes()).toEqual([
      { op: 'create', id: 'grill-1:2026-11-20T10' },
      { op: 'create', id: 'grill-1:2026-11-20T11' },
    ]);
    expect(fake.get(DEVICE, 'grill-1:2026-11-20T11')?.['slots']).toEqual({
      '0': { grill: { n: 2, min: 227, max: 228, sum: 455 } },
    });
  });

  it('applies the trust rule: hub identity, Body.timestamp else the enqueued time', async () => {
    const { fake, deps } = setup();
    await rollupTemperaturesHandler(
      [
        // Body.deviceId is ignored; the reading belongs to the hub identity.
        stored({ body: { deviceId: 'spoofed', timestamp: '2026-11-20T10:01:00Z', grillTemp: 1 } }),
        // No Body.timestamp: the enqueued time places it.
        stored({ body: { grillTemp: 2 }, enqueuedTime: '2026-11-20T10:02:30.000Z' }),
      ],
      context().ctx,
      deps
    );

    expect(fake.get(DEVICE, 'grill-1:2026-11-20T10')?.['slots']).toEqual({
      '1': { grill: { n: 1, min: 1, max: 1, sum: 1 } },
      '2': { grill: { n: 1, min: 2, max: 2, sum: 2 } },
    });
    expect(fake.get('spoofed', 'spoofed:2026-11-20T10')).toBeUndefined();
  });

  it('skips documents that do not map, and logs counts without ids', async () => {
    const { fake, deps } = setup();
    const { ctx, logs } = context();
    await rollupTemperaturesHandler(
      [
        stored({ body: 'eyJncmlsbFRlbXAiOjk5OX0=' }), // non-JSON payload, stored as base64
        stored({ body: { grillTemp: 999 }, hubDeviceId: 'neighbour' }), // foreign identity
        { id: 'no-device', Body: { grillTemp: 1 } },
        null,
        stored({ body: { timestamp: '2026-11-20T10:01:00Z', grillTemp: 225 } }),
      ],
      ctx,
      deps
    );

    expect(fake.writes()).toHaveLength(1);
    expect(fake.get(DEVICE, 'grill-1:2026-11-20T10')?.['slots']).toEqual({
      '1': { grill: { n: 1, min: 225, max: 225, sum: 225 } },
    });
    expect(logs.join('\n')).toContain(
      `rollupTemperatures documents=5 readings=1 skipped=4 buckets=1 requestCharge=${
        ROLLUP_READ_CHARGE + ROLLUP_WRITE_CHARGE
      }`
    );
    expect(logs.join('\n')).not.toContain(DEVICE);
  });

  it('makes no Cosmos call for a batch with nothing to fold', async () => {
    const { fake, deps } = setup();
    await rollupTemperaturesHandler([stored({ body: 'not json' })], context().ctx, deps);
    expect(fake.calls).toEqual([]);
  });

  it('throws when a bucket cannot be written, so the lease does not checkpoint', async () => {
    const { fake, deps } = setup();
    fake.seed({
      id: 'grill-1:2026-11-20T10',
      deviceId: DEVICE,
      hourStart: '2026-11-20T10:00:00.000Z',
      slots: {},
    });
    fake.beforeWrite(() =>
      fake.seed({
        id: 'grill-1:2026-11-20T10',
        deviceId: DEVICE,
        hourStart: '2026-11-20T10:00:00.000Z',
        slots: {},
      })
    );
    const { ctx, errors } = context();

    await expect(
      rollupTemperaturesHandler(
        [stored({ body: { timestamp: '2026-11-20T10:01:00Z', grillTemp: 225 } })],
        ctx,
        deps
      )
    ).rejects.toBeInstanceOf(RollupConflictError);
    expect(errors.join('\n')).toContain(
      'rollupTemperatures failed: rollup_conflict_retries_exhausted'
    );
  });

  it('logs a Cosmos failure as a fixed code, never its text, and rethrows', async () => {
    const { fake, deps } = setup();
    fake.beforeWrite(() => {
      throw Object.assign(new Error('https://secret-account.documents.azure.com/ said no'), {
        code: 503,
      });
    });
    const { ctx, errors } = context();

    await expect(
      rollupTemperaturesHandler(
        [stored({ body: { timestamp: '2026-11-20T10:01:00Z', grillTemp: 225 } })],
        ctx,
        deps
      )
    ).rejects.toMatchObject({ code: 503 });
    expect(errors.join('\n')).toContain('rollupTemperatures failed: cosmos_status_503');
    expect(errors.join('\n')).not.toContain('secret-account');
  });

  it(`paces itself to ${ROLLUP_WRITE_RU_PER_SECOND} RU/s of writes`, async () => {
    const { deps, sleeps } = setup();
    let clock = 0;
    deps.now = () => clock;
    const fold = rollupTemperaturesHandler(
      [
        stored({ body: { timestamp: '2026-11-20T10:01:00Z', grillTemp: 225 } }),
        stored({ body: { timestamp: '2026-11-20T11:01:00Z', grillTemp: 225 } }),
      ],
      context().ctx,
      deps
    );
    clock = 20; // the writes took 20 ms
    await fold;

    const charge = 2 * (ROLLUP_READ_CHARGE + ROLLUP_WRITE_CHARGE);
    expect(sleeps).toEqual([(charge / ROLLUP_WRITE_RU_PER_SECOND) * 1000 - 20]);
  });
});
