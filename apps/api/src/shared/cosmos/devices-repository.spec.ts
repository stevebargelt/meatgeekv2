/**
 * HAR-20 (MG-80) — the devices repository against an in-memory container, no
 * Azure and no credentials. The real-Cosmos behaviour is exercised by
 * devices-repository.emulator.spec.ts.
 */
import type { Device } from '@meatgeekv2/api-interfaces';

import {
  DEFAULT_DEVICE_CONFIGURATION,
  DEVICE_ID_PATTERN,
  DevicesRepository,
  DevicesStoreError,
  mergeDeviceConfiguration,
  toDevice,
} from './devices-repository';
import {
  FakeDevicesContainer,
  QUERY_CHARGE,
  READ_CHARGE,
  WRITE_CHARGE,
} from './fake-devices-container.testing';

const OWNER = 'tid-1:oid-owner';
const STRANGER = 'tid-1:oid-stranger';

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'grill-1',
    userId: OWNER,
    name: 'Backyard Smoker',
    model: 'MeatGeek V1',
    isActive: true,
    connectionStatus: 'unknown',
    ...overrides,
  };
}

function setup() {
  const fake = new FakeDevicesContainer();
  return { fake, repository: new DevicesRepository(fake.asContainer()) };
}

function systemKeys(value: object | undefined): string[] {
  return Object.keys(value ?? {}).filter(key => key.startsWith('_'));
}

describe('toDevice', () => {
  it('keeps only Device fields and drops Cosmos system properties', () => {
    const stored = {
      ...device({ location: 'Patio' }),
      _rid: 'r',
      _self: 's',
      _etag: '"e"',
      _attachments: 'a',
      _ts: 1,
      legacyField: 'x',
    };
    expect(toDevice(stored as unknown as Device)).toEqual(device({ location: 'Patio' }));
  });
});

describe('DEVICE_ID_PATTERN', () => {
  it.each(['meatgeek3', 'a', 'grill_1.local:2-b', 'x'.repeat(128)])('accepts %s', id => {
    expect(DEVICE_ID_PATTERN.test(id)).toBe(true);
  });
  it.each(['', 'x'.repeat(129), 'a/b', 'a?b', 'a#b', 'a\\b', 'a b'])('rejects %p', id => {
    expect(DEVICE_ID_PATTERN.test(id)).toBe(false);
  });
});

describe('mergeDeviceConfiguration', () => {
  it('fills every required field from DEFAULT_DEVICE_CONFIGURATION', () => {
    expect(mergeDeviceConfiguration(undefined, {})).toEqual({
      temperatureUnit: 'fahrenheit',
      pollingInterval: 30,
      alertSettings: {
        highTempThreshold: 0,
        lowTempThreshold: 0,
        enableSounds: false,
        enablePushNotifications: false,
      },
    });
  });

  it('merges field by field over the stored configuration, alertSettings included', () => {
    const stored = mergeDeviceConfiguration(undefined, {
      temperatureUnit: 'celsius',
      probe1Correction: -2,
      alertSettings: { highTempThreshold: 300, enableSounds: true },
    });
    const merged = mergeDeviceConfiguration(stored, {
      pollingInterval: 10,
      alertSettings: { lowTempThreshold: 150 },
    });
    expect(merged).toEqual({
      temperatureUnit: 'celsius',
      probe1Correction: -2,
      pollingInterval: 10,
      alertSettings: {
        highTempThreshold: 300,
        lowTempThreshold: 150,
        enableSounds: true,
        enablePushNotifications: false,
      },
    });
  });

  it('never mutates the shared default', () => {
    const merged = mergeDeviceConfiguration(undefined, {});
    merged.alertSettings.enableSounds = true;
    expect(DEFAULT_DEVICE_CONFIGURATION.alertSettings.enableSounds).toBe(false);
    expect(Object.isFrozen(DEFAULT_DEVICE_CONFIGURATION)).toBe(true);
  });
});

describe('DevicesRepository.getDeviceOwnership', () => {
  it('is owned when the stored userId is the caller, from one point read keyed on the device id', async () => {
    const { fake, repository } = setup();
    fake.seed(device());

    const ownership = await repository.getDeviceOwnership(OWNER, 'grill-1');

    expect(ownership).toEqual({ status: 'owned', device: device(), requestCharge: READ_CHARGE });
    expect(fake.calls).toEqual([{ operation: 'read', id: 'grill-1', partitionKey: 'grill-1' }]);
    if (ownership.status === 'owned') {
      expect(systemKeys(ownership.device)).toEqual([]);
    }
  });

  it('is foreign when someone else owns it, and carries no device', async () => {
    const { fake, repository } = setup();
    fake.seed(device({ userId: STRANGER }));

    const ownership = await repository.getDeviceOwnership(OWNER, 'grill-1');

    expect(ownership).toEqual({ status: 'foreign', requestCharge: READ_CHARGE });
  });

  it('is unknown when there is no such device', async () => {
    const { repository } = setup();
    expect(await repository.getDeviceOwnership(OWNER, 'nope')).toEqual({
      status: 'unknown',
      requestCharge: READ_CHARGE,
    });
  });

  it('is unknown without a read when the id could never be a device id', async () => {
    const { fake, repository } = setup();
    expect(await repository.getDeviceOwnership(OWNER, 'a/b')).toEqual({
      status: 'unknown',
      requestCharge: 0,
    });
    expect(fake.calls).toEqual([]);
  });

  it('propagates a Cosmos failure other than 404', async () => {
    const { fake, repository } = setup();
    fake.failNext('read', 503);
    await expect(repository.getDeviceOwnership(OWNER, 'grill-1')).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});

describe('DevicesRepository.getDeviceOwner (HAR-81)', () => {
  it('is the stored userId, from one point read keyed on the device id', async () => {
    const { fake, repository } = setup();
    fake.seed(device({ userId: STRANGER }));

    expect(await repository.getDeviceOwner('grill-1')).toEqual({
      userId: STRANGER,
      requestCharge: READ_CHARGE,
    });
    expect(fake.calls).toEqual([{ operation: 'read', id: 'grill-1', partitionKey: 'grill-1' }]);
  });

  it('is undefined when there is no such device', async () => {
    const { repository } = setup();
    expect(await repository.getDeviceOwner('nope')).toEqual({
      userId: undefined,
      requestCharge: READ_CHARGE,
    });
  });

  it('is undefined without a read when the id could never be a device id', async () => {
    const { fake, repository } = setup();
    expect(await repository.getDeviceOwner('a/b')).toEqual({ userId: undefined, requestCharge: 0 });
    expect(fake.calls).toEqual([]);
  });

  it('propagates a Cosmos failure other than 404', async () => {
    const { fake, repository } = setup();
    fake.failNext('read', 503);
    await expect(repository.getDeviceOwner('grill-1')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('DevicesRepository.listDevicesByOwner', () => {
  it('runs the one owner query, cross-partition (no partitionKey), sorted by name', async () => {
    const { fake, repository } = setup();
    fake.seed(device({ id: 'b', name: 'Zed' }));
    fake.seed(device({ id: 'a', name: 'Alpha' }));
    fake.seed(device({ id: 'c', name: 'Mine?', userId: STRANGER }));

    const { devices, requestCharge } = await repository.listDevicesByOwner(OWNER);

    expect(devices.map(d => d.id)).toEqual(['a', 'b']);
    expect(devices.flatMap(systemKeys)).toEqual([]);
    expect(requestCharge).toBe(QUERY_CHARGE);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.query).toBe('SELECT * FROM c WHERE c.userId = @userId');
    expect(call.parameters).toEqual([{ name: '@userId', value: OWNER }]);
    expect(call.queryOptions).not.toHaveProperty('partitionKey');
  });
});

describe('DevicesRepository.registerDevice', () => {
  it('creates the document (never upsert) and returns it without system properties', async () => {
    const { fake, repository } = setup();

    const result = await repository.registerDevice(device());

    expect(result).toEqual({
      outcome: 'created',
      device: device(),
      requestCharge: QUERY_CHARGE + WRITE_CHARGE,
    });
    expect(fake.calls.map(c => c.operation)).toEqual(['query', 'create']);
    expect(fake.stored('grill-1')).toMatchObject(device());
  });

  it('is a conflict when the id exists under another owner, and writes nothing', async () => {
    const { fake, repository } = setup();
    fake.seed(device({ userId: STRANGER, name: 'Theirs' }));

    const result = await repository.registerDevice(device());

    expect(result).toEqual({ outcome: 'conflict', requestCharge: QUERY_CHARGE + WRITE_CHARGE });
    expect(fake.stored('grill-1')?.['userId']).toBe(STRANGER);
  });

  it('is a conflict when the owner already has a device with that name, without a create', async () => {
    const { fake, repository } = setup();
    fake.seed(device({ id: 'other' }));

    const result = await repository.registerDevice(device());

    expect(result).toEqual({ outcome: 'conflict', requestCharge: QUERY_CHARGE });
    expect(fake.calls.map(c => c.operation)).toEqual(['query']);
  });

  it('allows the same name under a different owner', async () => {
    const { fake, repository } = setup();
    fake.seed(device({ id: 'theirs', userId: STRANGER }));
    expect((await repository.registerDevice(device())).outcome).toBe('created');
  });

  it('re-throws a failed create as a DevicesStoreError with the total charge and no Cosmos text', async () => {
    const { fake, repository } = setup();
    fake.failNext('create', 503);

    const error = await repository.registerDevice(device()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DevicesStoreError);
    expect(error).toMatchObject({
      statusCode: 503,
      requestCharge: QUERY_CHARGE + WRITE_CHARGE,
      message: 'devices store operation failed',
    });
  });
});

describe('DevicesRepository.updateDevice', () => {
  it('merges the change, writes with If-Match on the read ETag, and keeps unmodelled fields', async () => {
    const { fake, repository } = setup();
    const legacy = {
      ...device({ configuration: mergeDeviceConfiguration(undefined, { probe2Correction: 3 }) }),
      legacyField: 'kept',
    };
    fake.seed(legacy);
    const etag = fake.stored('grill-1')?.['_etag'];

    const result = await repository.updateDevice(OWNER, 'grill-1', {
      location: 'Garage',
      configuration: { pollingInterval: 5 },
    });

    expect(result.outcome).toBe('updated');
    if (result.outcome !== 'updated') return;
    expect(result.device.location).toBe('Garage');
    expect(result.device.configuration).toMatchObject({ probe2Correction: 3, pollingInterval: 5 });
    expect(systemKeys(result.device)).toEqual([]);
    expect(result.requestCharge).toBe(READ_CHARGE + WRITE_CHARGE);
    expect(fake.calls.find(c => c.operation === 'replace')).toMatchObject({
      id: 'grill-1',
      partitionKey: 'grill-1',
      ifMatch: etag,
    });
    expect(fake.stored('grill-1')?.['legacyField']).toBe('kept');
  });

  it('is notFound for a foreign device and writes nothing', async () => {
    const { fake, repository } = setup();
    fake.seed(device({ userId: STRANGER }));

    const result = await repository.updateDevice(OWNER, 'grill-1', { location: 'Mine now' });

    expect(result).toEqual({ outcome: 'notFound', requestCharge: READ_CHARGE });
    expect(fake.calls.map(c => c.operation)).toEqual(['read']);
  });

  it('is notFound for an unknown device', async () => {
    const { repository } = setup();
    expect((await repository.updateDevice(OWNER, 'nope', { name: 'X' })).outcome).toBe('notFound');
  });

  it('is concurrentUpdate when the document changed between the read and the write', async () => {
    const { fake, repository } = setup();
    fake.seed(device());
    fake.beforeReplace = id => fake.touch(id);

    const result = await repository.updateDevice(OWNER, 'grill-1', { location: 'Late' });

    expect(result).toEqual({
      outcome: 'concurrentUpdate',
      requestCharge: READ_CHARGE + WRITE_CHARGE,
    });
  });

  it('is nameConflict when renaming onto another of the owner’s devices', async () => {
    const { fake, repository } = setup();
    fake.seed(device());
    fake.seed(device({ id: 'grill-2', name: 'Patio' }));

    const result = await repository.updateDevice(OWNER, 'grill-1', { name: 'Patio' });

    expect(result).toEqual({ outcome: 'nameConflict', requestCharge: READ_CHARGE + QUERY_CHARGE });
  });

  it('does not query names when the name is unchanged', async () => {
    const { fake, repository } = setup();
    fake.seed(device());

    const result = await repository.updateDevice(OWNER, 'grill-1', { name: 'Backyard Smoker' });

    expect(result.outcome).toBe('updated');
    expect(fake.calls.map(c => c.operation)).toEqual(['read', 'replace']);
  });
});
