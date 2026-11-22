/**
 * HAR-136 (goal HAR-130) — DELETE /devices/{id} as release, with NO Azure and
 * NO credentials.
 *
 * The handler runs over the REAL DevicesRepository on the in-memory devices
 * container, the REAL CooksRepository on a point-read-only cooks container (the
 * MG-84 device lock), and a fake IoT Hub (FakeTwinHub). The claim-after-release
 * case drives the REAL claim handler on the same fakes with a fixed clock.
 * HAR-85's cases (204, 403, 404, 401, 500) stay in devices.spec.ts.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Device } from '@meatgeekv2/api-interfaces';
import { trace } from '@opentelemetry/api';

import { principalFromRequest } from '../../shared/auth/principal';
import { CooksRepository } from '../../shared/cosmos/cooks-repository';
import { DevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  COOKS_READ_CHARGE,
  FakeCooksContainer,
} from '../../shared/cosmos/fake-cooks-container.testing';
import {
  DELETE_CHARGE,
  FakeDevicesContainer,
  READ_CHARGE,
} from '../../shared/cosmos/fake-devices-container.testing';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import { claimantHash, claimCodeHash } from '../../shared/devices/claim-code';
import { DeviceTwinError } from '../../shared/iothub/device-twin';
import { FakeTwinHub } from '../../shared/iothub/fake-device-twin.testing';
import { CLAIM_REFUSED_MESSAGE, claimDeviceHandler, type ClaimDeviceDeps } from './claim-device';
import {
  COOK_ACTIVE_MESSAGE,
  deleteDeviceHandler,
  nextClaimGeneration,
  type DeleteDeviceDeps,
} from './delete-device';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const OTHER_OID = 'oid-zzzz-9999';
const USER_ID = `${TID}:${OID}`;
const OTHER_USER_ID = `${TID}:${OTHER_OID}`;

const DEVICE_ID = 'meatgeek3';
const CODE = '7K3M9QXR2HTV';
const CODE_HASH = claimCodeHash(DEVICE_ID, CODE);
const FRESH_CODE = 'ABCD1234EFGH';
const MY_HASH = claimantHash(USER_ID);

const NOW = new Date('2026-11-22T12:00:00.000Z');
const LATER = '2026-11-22T12:10:00.000Z';

function encodedPrincipal(oid: string, tid = TID): string {
  const payload = {
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: tid },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function request(options: { id?: string; oid?: string; body?: unknown } = {}): HttpRequest {
  const headers = new Map<string, string>([
    ['x-ms-client-principal', encodedPrincipal(options.oid ?? OID)],
  ]);
  return {
    json: async () => options.body,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: { get: () => null },
    params: options.id === undefined ? {} : { id: options.id },
  } as unknown as HttpRequest;
}

function context() {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      lines.push(`${level}: ${args.map(String).join(' ')}`);
  const ctx = {
    invocationId: 'inv-136',
    log: record('log'),
    warn: record('warn'),
    error: record('error'),
  } as unknown as InvocationContext;
  return { ctx, lines };
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: DEVICE_ID,
    userId: USER_ID,
    name: 'Backyard Smoker',
    model: 'MeatGeek V1',
    isActive: true,
    connectionStatus: 'unknown',
    claimedAt: '2026-11-22T11:00:00.000Z',
    ...overrides,
  };
}

/** The twin of a device claimed by the caller with CODE at generation `generation`. */
function claimedTwin(generation?: string) {
  return {
    desired: {
      ...(generation !== undefined ? { claimGeneration: generation } : {}),
      claimConsumedCodeHash: CODE_HASH,
      claimClaimantHash: MY_HASH,
    },
    reported: {
      claimCodeHash: CODE_HASH,
      claimGeneration: generation ?? '0',
      claimExpiresAt: LATER,
    },
  };
}

function setup() {
  const devices = new FakeDevicesContainer();
  const cooks = new FakeCooksContainer();
  const twins = new FakeTwinHub();
  const deps: DeleteDeviceDeps = {
    resolvePrincipal: principalFromRequest,
    getRepository: () => new DevicesRepository(devices.asContainer()),
    getCooksRepository: () => new CooksRepository(cooks.asContainer()),
    getDeviceTwin: () => twins,
  };
  const claimDeps: ClaimDeviceDeps = {
    resolvePrincipal: principalFromRequest,
    getRepository: () => new DevicesRepository(devices.asContainer()),
    getDeviceTwin: () => twins,
    now: () => NOW,
    tracer: trace.getTracer('har-136-test'),
  };
  return { devices, cooks, twins, deps, claimDeps };
}

/** A device the caller owns, with its twin claimed at `generation`. */
function ownedAndClaimed(generation?: string) {
  const fixture = setup();
  fixture.devices.seed(device());
  const twin = claimedTwin(generation);
  fixture.twins.addDevice(DEVICE_ID, twin.desired, twin.reported);
  return fixture;
}

const release = (deps: DeleteDeviceDeps, oid = OID) =>
  deleteDeviceHandler(request({ id: DEVICE_ID, oid }), context().ctx, deps);

describe('DELETE /devices/{id}: release (HAR-136)', () => {
  it('204: bumps claimGeneration, clears the claimant, keeps the consumed code, under If-Match, before the delete', async () => {
    const { devices, twins, deps } = ownedAndClaimed('3');
    let documentAtPatch: unknown;
    twins.beforePatch = () => {
      documentAtPatch = devices.stored(DEVICE_ID);
    };
    const etagRead = (await twins.getTwin(DEVICE_ID)).etag;
    twins.gets.length = 0;
    const { ctx, lines } = context();

    const response = await deleteDeviceHandler(request({ id: DEVICE_ID }), ctx, deps);

    expect(response.status).toBe(204);
    expect(response.jsonBody).toBeUndefined();
    expect(twins.patches).toEqual([
      {
        deviceId: DEVICE_ID,
        desired: { claimGeneration: '4', claimClaimantHash: null },
        etag: etagRead,
      },
    ]);
    // The patch ran while the document still existed; the document is gone now.
    expect(documentAtPatch).toBeDefined();
    expect(devices.stored(DEVICE_ID)).toBeUndefined();
    expect(twins.desired(DEVICE_ID)).toEqual({
      claimGeneration: '4',
      claimConsumedCodeHash: CODE_HASH,
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + COOKS_READ_CHARGE + READ_CHARGE + DELETE_CHARGE)
    );
    expect(lines).toContain('log: deleteDevice device twin patched');
    // No code, hash or claimant reaches the log.
    expect(lines.join('\n')).not.toContain(CODE_HASH);
    expect(lines.join('\n')).not.toContain(MY_HASH);
  });

  it('an absent claimGeneration counts as "0": the first release writes "1"', async () => {
    const { twins, deps } = ownedAndClaimed(undefined);

    const response = await release(deps);

    expect(response.status).toBe(204);
    expect(twins.patches.map(p => p.desired)).toEqual([
      { claimGeneration: '1', claimClaimantHash: null },
    ]);
  });

  it('a 412 re-reads the twin once and retries from what it read', async () => {
    const { devices, twins, deps } = ownedAndClaimed('3');
    // Someone else writes the twin between our read and our patch.
    twins.beforePatch = () => twins.forceWrite(DEVICE_ID, { claimGeneration: '7' });

    const response = await release(deps);

    expect(response.status).toBe(204);
    expect(twins.gets).toEqual([DEVICE_ID, DEVICE_ID]);
    expect(twins.patches.map(p => p.desired)).toEqual([
      { claimGeneration: '4', claimClaimantHash: null }, // refused with 412
      { claimGeneration: '8', claimClaimantHash: null },
    ]);
    expect(twins.patches[0].etag).not.toBe(twins.patches[1].etag);
    expect(twins.desired(DEVICE_ID)?.['claimGeneration']).toBe('8');
    expect(devices.stored(DEVICE_ID)).toBeUndefined();
  });

  it('a twin 404 (no hub identity) skips the twin step: 204 with no patch', async () => {
    const { devices, twins, deps } = setup();
    devices.seed(device({ claimedAt: undefined }));

    const response = await release(deps);

    expect(response.status).toBe(204);
    expect(twins.gets).toEqual([DEVICE_ID]);
    expect(twins.patches).toEqual([]);
    expect(devices.stored(DEVICE_ID)).toBeUndefined();
  });

  it.each([
    ['the twin read answers 503', 'get_twin', 503, 'iothub_get_twin_status_503'],
    ['the twin read fails on the network', 'get_twin', undefined, 'iothub_get_twin_failed'],
    ['the patch answers 500', 'patch_twin', 500, 'iothub_patch_twin_status_500'],
  ] as const)(
    '503 DEVICE_TWIN_UPDATE_FAILED when %s, and the document is kept',
    async (_label, operation, status, reason) => {
      const { devices, twins, deps } = ownedAndClaimed('3');
      twins.failNext(operation, status);
      const { ctx, lines } = context();

      const response = await deleteDeviceHandler(request({ id: DEVICE_ID }), ctx, deps);

      expect(response.status).toBe(503);
      expect(response.jsonBody).toEqual({
        error: 'DEVICE_TWIN_UPDATE_FAILED',
        message: 'The device twin could not be read or updated. Retry the same request.',
        reason,
        requestId: 'inv-136',
      });
      expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE + COOKS_READ_CHARGE));
      expect(devices.stored(DEVICE_ID)).toBeDefined();
      expect(devices.calls.map(c => c.operation)).toEqual(['read']);
      expect(lines).toContain(`error: deleteDevice device twin failed: ${reason}`);
    }
  );

  it('503 when the patch still meets a 412 after the one re-read, and the document is kept', async () => {
    const { devices, twins, deps } = ownedAndClaimed('3');
    twins.failNext('patch_twin', 412);
    twins.failNext('patch_twin', 412);

    const response = await release(deps);

    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({ reason: 'iothub_patch_twin_status_412' });
    expect(twins.gets).toEqual([DEVICE_ID, DEVICE_ID]);
    expect(devices.stored(DEVICE_ID)).toBeDefined();
  });

  it('503 when the hub is not configured, and the document is kept', async () => {
    const { devices, deps } = ownedAndClaimed('3');
    deps.getDeviceTwin = () => {
      throw new DeviceTwinError('configuration');
    };

    const response = await release(deps);

    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({ reason: 'iothub_configuration_failed' });
    expect(devices.stored(DEVICE_ID)).toBeDefined();
  });

  it('a retry after a 503 releases the device', async () => {
    const { devices, twins, deps } = ownedAndClaimed('3');
    twins.failNext('get_twin', 503);

    const first = await release(deps);
    const second = await release(deps);

    expect([first.status, second.status]).toEqual([503, 204]);
    expect(twins.desired(DEVICE_ID)?.['claimGeneration']).toBe('4');
    expect(devices.stored(DEVICE_ID)).toBeUndefined();
  });

  it('409 COOK_ACTIVE while the caller has an active cook on it: no twin call, no delete', async () => {
    const { devices, cooks, twins, deps } = ownedAndClaimed('3');
    cooks.seedCookWithLock(USER_ID, DEVICE_ID, 'cook-1');
    const { ctx, lines } = context();

    const response = await deleteDeviceHandler(request({ id: DEVICE_ID }), ctx, deps);

    expect(response.status).toBe(409);
    expect(response.jsonBody).toEqual({
      error: 'COOK_ACTIVE',
      message: COOK_ACTIVE_MESSAGE,
      requestId: 'inv-136',
    });
    expect(COOK_ACTIVE_MESSAGE).toBe('Stop the active cook before releasing this device');
    // The lock, then the cook it names: point reads in the caller's partition.
    expect(cooks.reads).toEqual([
      { id: 'active-device:meatgeek3', partitionKey: USER_ID },
      { id: 'cook-1', partitionKey: USER_ID },
    ]);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + 2 * COOKS_READ_CHARGE)
    );
    expect(twins.gets).toEqual([]);
    expect(twins.patches).toEqual([]);
    expect(devices.stored(DEVICE_ID)).toBeDefined();
    expect(devices.calls.map(c => c.operation)).toEqual(['read']);
    expect(lines).toContain(
      `log: deleteDevice cook_active (requestCharge=${READ_CHARGE + 2 * COOKS_READ_CHARGE} RU)`
    );
  });

  it('a stale lock (its cook completed) does not block the release', async () => {
    const { devices, cooks, deps } = ownedAndClaimed('3');
    cooks.seedCookWithLock(USER_ID, DEVICE_ID, 'cook-1', 'completed');

    const response = await release(deps);

    expect(response.status).toBe(204);
    expect(devices.stored(DEVICE_ID)).toBeUndefined();
  });

  it("another user's lock on the same device id does not block the caller", async () => {
    const { cooks, deps } = ownedAndClaimed('3');
    cooks.seedCookWithLock(OTHER_USER_ID, DEVICE_ID, 'their-cook');

    const response = await release(deps);

    expect(response.status).toBe(204);
    expect(cooks.reads).toEqual([{ id: 'active-device:meatgeek3', partitionKey: USER_ID }]);
  });

  it('403 DEVICE_NOT_OWNED and 404 DEVICE_NOT_FOUND are unchanged: no lock read, no twin call', async () => {
    const { devices, cooks, twins, deps } = setup();
    devices.seed(device({ userId: OTHER_USER_ID }));
    twins.addDevice(DEVICE_ID, claimedTwin('3').desired, claimedTwin('3').reported);

    const foreign = await release(deps);
    const unknown = await deleteDeviceHandler(request({ id: 'nobody' }), context().ctx, deps);

    expect(foreign.status).toBe(403);
    expect(foreign.jsonBody).toEqual({
      error: 'DEVICE_NOT_OWNED',
      message: 'The device is not registered to the caller.',
      requestId: 'inv-136',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.jsonBody).toEqual({
      error: 'DEVICE_NOT_FOUND',
      message: 'Device not found',
      requestId: 'inv-136',
    });
    expect(header(foreign, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(header(unknown, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(cooks.reads).toEqual([]);
    expect(twins.gets).toEqual([]);
    expect(devices.stored(DEVICE_ID)).toBeDefined();
  });
});

describe('a claim after a release (HAR-136)', () => {
  const claim = (deps: ClaimDeviceDeps, code: string, oid = OID) =>
    claimDeviceHandler(
      request({ oid, body: { deviceId: DEVICE_ID, claimCode: code, name: 'Backyard Smoker' } }),
      context().ctx,
      deps
    );

  it('refuses the old code (403 CLAIM_REFUSED) for the old owner and anyone else', async () => {
    const { twins, deps, claimDeps } = setup();
    // An unclaimed device that published CODE at generation 0.
    twins.addDevice(DEVICE_ID, {}, claimedTwin(undefined).reported);

    const claimed = await claim(claimDeps, CODE);
    expect(claimed.status).toBe(201);
    expect(twins.desired(DEVICE_ID)).toEqual({
      claimConsumedCodeHash: CODE_HASH,
      claimClaimantHash: MY_HASH,
    });

    const released = await release(deps);
    expect(released.status).toBe(204);
    // The post-release state: generation bumped, claimant cleared, code consumed.
    expect(twins.desired(DEVICE_ID)).toEqual({
      claimGeneration: '1',
      claimConsumedCodeHash: CODE_HASH,
    });

    const sameOwner = await claim(claimDeps, CODE);
    const someoneElse = await claim(claimDeps, CODE, OTHER_OID);
    const refused = {
      error: 'CLAIM_REFUSED',
      message: CLAIM_REFUSED_MESSAGE,
      requestId: 'inv-136',
    };
    expect(sameOwner.status).toBe(403);
    expect(sameOwner.jsonBody).toEqual(refused);
    expect(someoneElse.status).toBe(403);
    expect(someoneElse.jsonBody).toEqual(refused);
  });

  it('still refuses the old code after the device reports generation 1 with it', async () => {
    const { twins, deps, claimDeps } = setup();
    twins.addDevice(DEVICE_ID, {}, claimedTwin(undefined).reported);
    expect((await claim(claimDeps, CODE)).status).toBe(201);
    expect((await release(deps)).status).toBe(204);
    // A device that (wrongly) re-reported its old code under the new generation:
    // the consumed hash still refuses it.
    twins.report(DEVICE_ID, { claimGeneration: '1' });

    const response = await claim(claimDeps, CODE, OTHER_OID);

    expect(response.status).toBe(403);
  });

  it('accepts the fresh code the device mints for the new generation', async () => {
    const { twins, deps, claimDeps } = setup();
    twins.addDevice(DEVICE_ID, {}, claimedTwin(undefined).reported);
    expect((await claim(claimDeps, CODE)).status).toBe(201);
    expect((await release(deps)).status).toBe(204);
    twins.report(DEVICE_ID, {
      claimCodeHash: claimCodeHash(DEVICE_ID, FRESH_CODE),
      claimGeneration: '1',
      claimExpiresAt: LATER,
    });

    const response = await claim(claimDeps, FRESH_CODE, OTHER_OID);

    expect(response.status).toBe(201);
    expect(response.jsonBody).toMatchObject({ id: DEVICE_ID, userId: OTHER_USER_ID });
  });
});

describe('nextClaimGeneration', () => {
  it.each([
    [{}, '1'],
    [{ claimGeneration: '0' }, '1'],
    [{ claimGeneration: '41' }, '42'],
    [{ claimGeneration: 7 }, '1'],
    [{ claimGeneration: 'x' }, '1'],
  ])('%j → %s', (desired, next) => {
    expect(nextClaimGeneration(desired)).toBe(next);
  });
});
