/**
 * HAR-66 — syncing a device twin's desired cook properties to Cosmos. Runs
 * against an in-memory hub (404 for an unknown device, 412 for a stale etag,
 * `null` deletes) and an in-memory "active cook" read, so each race is laid out
 * step by step.
 */
import {
  DEVICE_TWIN_SYNC_MAX_ATTEMPTS,
  DeviceTwinSyncError,
  syncDeviceTwinWith,
  targetDesired,
  type ActiveCookReader,
} from './device-twin-sync';
import { DeviceTwinError, type DeviceTwinPort } from './device-twin';
import { FakeTwinHub } from './fake-device-twin.testing';

const USER = 'tenant-abc:oid-123';
const DEVICE = 'meatgeek3';
const COOK_A = 'cook-a';
const COOK_B = 'cook-b';

/** RU each fake Cosmos read reports. */
const READ_CHARGE = 1.5;

/** The device's active cook as Cosmos holds it, changeable mid-test. */
function fakeCooks(active?: string) {
  const state = { active, reads: [] as Array<{ userId: string; deviceId: string }> };
  const reader: ActiveCookReader = {
    getActiveCookIdForDevice: async (userId, deviceId) => {
      state.reads.push({ userId, deviceId });
      return { cookId: state.active, requestCharge: READ_CHARGE };
    },
  };
  return { state, reader };
}

function cookProps(desired: Record<string, unknown> | undefined) {
  return { activeCookId: desired?.['activeCookId'], correlationId: desired?.['correlationId'] };
}

async function syncError(promise: Promise<unknown>): Promise<DeviceTwinSyncError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceTwinSyncError);
    return error as DeviceTwinSyncError;
  }
  throw new Error('expected a DeviceTwinSyncError');
}

describe('targetDesired', () => {
  it('clears both properties when there is no active cook', () => {
    expect(targetDesired({ activeCookId: COOK_A, correlationId: 'r1' }, undefined, 'r2')).toEqual({
      activeCookId: null,
      correlationId: null,
    });
  });

  it('keeps the twin correlationId when the active cook is already on the twin', () => {
    expect(targetDesired({ activeCookId: COOK_A, correlationId: 'r1' }, COOK_A, 'r2')).toEqual({
      activeCookId: COOK_A,
      correlationId: 'r1',
    });
  });

  it('writes the new cook with this request correlationId otherwise', () => {
    expect(targetDesired({ activeCookId: COOK_A, correlationId: 'r1' }, COOK_B, 'r2')).toEqual({
      activeCookId: COOK_B,
      correlationId: 'r2',
    });
  });
});

describe('syncDeviceTwinWith', () => {
  it('sets the active cook and correlationId on an empty twin, then checks Cosmos again', async () => {
    const hub = new FakeTwinHub().addDevice(DEVICE);
    const cooks = fakeCooks(COOK_A);

    const result = await syncDeviceTwinWith(
      { twin: hub, cooks: cooks.reader },
      USER,
      DEVICE,
      'req-1'
    );

    expect(result).toEqual({ outcome: 'patched', requestCharge: 2 * READ_CHARGE });
    expect(hub.patches).toEqual([
      {
        deviceId: DEVICE,
        desired: { activeCookId: COOK_A, correlationId: 'req-1' },
        etag: 'etag-1',
      },
    ]);
    expect(cookProps(hub.desired(DEVICE))).toEqual({
      activeCookId: COOK_A,
      correlationId: 'req-1',
    });
    // Read in the owner's partition, for this device.
    expect(cooks.state.reads).toEqual([
      { userId: USER, deviceId: DEVICE },
      { userId: USER, deviceId: DEVICE },
    ]);
  });

  it('sends null for both properties when no cook is active, so IoT Hub deletes them', async () => {
    const hub = new FakeTwinHub().addDevice(DEVICE, { activeCookId: COOK_A, correlationId: 'r1' });
    const cooks = fakeCooks(undefined);

    const result = await syncDeviceTwinWith({ twin: hub, cooks: cooks.reader }, USER, DEVICE, 'r2');

    expect(result.outcome).toBe('patched');
    expect(hub.patches.map(p => p.desired)).toEqual([{ activeCookId: null, correlationId: null }]);
    expect(hub.desired(DEVICE)).toEqual({});
  });

  it('makes no PATCH when the twin already matches', async () => {
    const hub = new FakeTwinHub().addDevice(DEVICE, { activeCookId: COOK_A, correlationId: 'r1' });
    const cooks = fakeCooks(COOK_A);

    const result = await syncDeviceTwinWith({ twin: hub, cooks: cooks.reader }, USER, DEVICE, 'r1');

    expect(result).toEqual({ outcome: 'unchanged', requestCharge: READ_CHARGE });
    expect(hub.patches).toEqual([]);
  });

  it('makes no PATCH when no cook is active and the twin is already clear', async () => {
    const hub = new FakeTwinHub().addDevice(DEVICE);
    const result = await syncDeviceTwinWith(
      { twin: hub, cooks: fakeCooks(undefined).reader },
      USER,
      DEVICE,
      'r1'
    );
    expect(result.outcome).toBe('unchanged');
    expect(hub.patches).toEqual([]);
  });

  it('keeps the existing correlationId when the active cook id already matches', async () => {
    // A retried start (new X-Request-ID) of the cook already on the twin.
    const hub = new FakeTwinHub().addDevice(DEVICE, {
      activeCookId: COOK_A,
      correlationId: 'original-start',
    });

    const result = await syncDeviceTwinWith(
      { twin: hub, cooks: fakeCooks(COOK_A).reader },
      USER,
      DEVICE,
      'retry-of-start'
    );

    expect(result.outcome).toBe('unchanged');
    expect(hub.patches).toEqual([]);
    expect(hub.desired(DEVICE)?.['correlationId']).toBe('original-start');
  });

  it('treats a 404 from getTwin as nothing to sync, without reading Cosmos', async () => {
    const hub = new FakeTwinHub(); // no device identity in the hub
    const cooks = fakeCooks(COOK_A);

    const result = await syncDeviceTwinWith({ twin: hub, cooks: cooks.reader }, USER, DEVICE, 'r1');

    expect(result).toEqual({ outcome: 'noTwin', requestCharge: 0 });
    expect(hub.patches).toEqual([]);
    expect(cooks.state.reads).toEqual([]);
  });

  describe('412 handling', () => {
    it('re-reads the twin and Cosmos and retries after a 412', async () => {
      const hub = new FakeTwinHub().addDevice(DEVICE);
      const cooks = fakeCooks(COOK_A);
      // Another writer lands between our GET and our PATCH.
      hub.beforePatch = () =>
        hub.forceWrite(DEVICE, { activeCookId: 'someone', correlationId: 'x' });

      const result = await syncDeviceTwinWith(
        { twin: hub, cooks: cooks.reader },
        USER,
        DEVICE,
        'r1'
      );

      expect(result.outcome).toBe('patched');
      expect(hub.gets).toHaveLength(2);
      expect(hub.patches.map(p => p.etag)).toEqual(['etag-1', 'etag-2']);
      // Attempt 1 read, attempt 2 read, then the post-PATCH check.
      expect(cooks.state.reads).toHaveLength(3);
      expect(cookProps(hub.desired(DEVICE))).toEqual({ activeCookId: COOK_A, correlationId: 'r1' });
    });

    it(`gives up after ${DEVICE_TWIN_SYNC_MAX_ATTEMPTS} attempts with a sanitized 412 reason`, async () => {
      const hub = new FakeTwinHub().addDevice(DEVICE);
      const alwaysStale: DeviceTwinPort = {
        getTwin: id => hub.getTwin(id),
        patchDesired: async () => {
          throw new DeviceTwinError('patch_twin', 412);
        },
      };
      const cooks = fakeCooks(COOK_A);

      const error = await syncError(
        syncDeviceTwinWith({ twin: alwaysStale, cooks: cooks.reader }, USER, DEVICE, 'r1')
      );

      expect(DEVICE_TWIN_SYNC_MAX_ATTEMPTS).toBe(3);
      expect(error.reason).toBe('iothub_patch_twin_status_412');
      expect(error.requestCharge).toBe(3 * READ_CHARGE);
      expect(hub.gets).toHaveLength(3);
      expect(cooks.state.reads).toHaveLength(3);
    });
  });

  describe('races', () => {
    it('a late retried stop of cook A after cook B started leaves B', async () => {
      // A was on the twin. A was stopped and B started in Cosmos. B's start is
      // syncing; between its GET and its PATCH, a retried stop of A syncs too.
      const hub = new FakeTwinHub().addDevice(DEVICE, {
        activeCookId: COOK_A,
        correlationId: 'start-a',
      });
      const cooks = fakeCooks(COOK_B);
      const deps = { twin: hub, cooks: cooks.reader };

      hub.beforePatch = async () => {
        const lateStop = await syncDeviceTwinWith(deps, USER, DEVICE, 'retry-stop-a');
        expect(lateStop.outcome).toBe('patched');
      };
      const startB = await syncDeviceTwinWith(deps, USER, DEVICE, 'start-b');

      // B's own PATCH lost the etag race (412); its retry found B already there.
      expect(startB.outcome).toBe('unchanged');
      expect(hub.desired(DEVICE)?.['activeCookId']).toBe(COOK_B);

      // And a stop of A arriving after everything settled changes nothing.
      const evenLater = await syncDeviceTwinWith(deps, USER, DEVICE, 'retry-stop-a-again');
      expect(evenLater.outcome).toBe('unchanged');
      expect(hub.desired(DEVICE)?.['activeCookId']).toBe(COOK_B);
    });

    it('a slow start that lost to a stop leaves the twin cleared', async () => {
      // Start A committed; its sync is slow. Stop A commits and syncs first.
      const hub = new FakeTwinHub().addDevice(DEVICE, {
        activeCookId: COOK_A,
        correlationId: 'start-a',
      });
      const cooks = fakeCooks(undefined); // A is completed in Cosmos
      const deps = { twin: hub, cooks: cooks.reader };

      expect((await syncDeviceTwinWith(deps, USER, DEVICE, 'stop-a')).outcome).toBe('patched');
      const slowStart = await syncDeviceTwinWith(deps, USER, DEVICE, 'start-a');

      expect(slowStart.outcome).toBe('unchanged');
      expect(hub.desired(DEVICE)).toEqual({});
    });

    it('a start whose PATCH lands after a stop that wrote nothing is undone by its own re-check', async () => {
      // Start A reads "A active" from Cosmos. Before its PATCH, stop A commits
      // and its sync finds the twin already clear, so it writes nothing and the
      // etag does not move. The start's PATCH then succeeds with A.
      const hub = new FakeTwinHub().addDevice(DEVICE);
      const cooks = fakeCooks(COOK_A);
      const deps = { twin: hub, cooks: cooks.reader };

      hub.beforePatch = async () => {
        cooks.state.active = undefined; // stop A committed
        expect((await syncDeviceTwinWith(deps, USER, DEVICE, 'stop-a')).outcome).toBe('unchanged');
      };
      const slowStart = await syncDeviceTwinWith(deps, USER, DEVICE, 'start-a');

      // The re-read after the PATCH saw A completed, and the next attempt cleared it.
      expect(slowStart.outcome).toBe('patched');
      expect(hub.patches.map(p => p.desired)).toEqual([
        { activeCookId: COOK_A, correlationId: 'start-a' },
        { activeCookId: null, correlationId: null },
      ]);
      expect(hub.desired(DEVICE)).toEqual({});
    });

    it('fails as contended when Cosmos keeps changing under every PATCH', async () => {
      const hub = new FakeTwinHub().addDevice(DEVICE);
      // Every read names a different cook, so no PATCH is ever confirmed.
      let reads = 0;
      const flapping: ActiveCookReader = {
        getActiveCookIdForDevice: async () => ({
          cookId: `cook-${++reads}`,
          requestCharge: READ_CHARGE,
        }),
      };

      const error = await syncError(
        syncDeviceTwinWith({ twin: hub, cooks: flapping }, USER, DEVICE, 'r1')
      );

      expect(error.reason).toBe('device_twin_sync_contended');
      expect(hub.patches).toHaveLength(DEVICE_TWIN_SYNC_MAX_ATTEMPTS);
    });
  });

  describe('sanitized failures', () => {
    it('reports a twin failure by its fixed code', async () => {
      const failing: DeviceTwinPort = {
        getTwin: async () => {
          throw new DeviceTwinError('get_twin', 403);
        },
        patchDesired: async () => undefined,
      };
      const error = await syncError(
        syncDeviceTwinWith({ twin: failing, cooks: fakeCooks(COOK_A).reader }, USER, DEVICE, 'r')
      );
      expect(error.reason).toBe('iothub_get_twin_status_403');
    });

    it('reports a PATCH failure other than 412 by its fixed code, after the RU already spent', async () => {
      const hub = new FakeTwinHub().addDevice(DEVICE);
      const failing: DeviceTwinPort = {
        getTwin: id => hub.getTwin(id),
        patchDesired: async () => {
          throw new DeviceTwinError('patch_twin', 403);
        },
      };
      const error = await syncError(
        syncDeviceTwinWith({ twin: failing, cooks: fakeCooks(COOK_A).reader }, USER, DEVICE, 'r')
      );
      expect(error.reason).toBe('iothub_patch_twin_status_403');
      expect(error.requestCharge).toBe(READ_CHARGE);
    });

    it('treats a 404 on PATCH (device deleted mid-sync) as nothing to sync', async () => {
      const hub = new FakeTwinHub().addDevice(DEVICE);
      const vanishing: DeviceTwinPort = {
        getTwin: id => hub.getTwin(id),
        patchDesired: async () => {
          throw new DeviceTwinError('patch_twin', 404);
        },
      };
      const result = await syncDeviceTwinWith(
        { twin: vanishing, cooks: fakeCooks(COOK_A).reader },
        USER,
        DEVICE,
        'r'
      );
      expect(result.outcome).toBe('noTwin');
    });

    it('never passes a Cosmos error text through', async () => {
      const hub = new FakeTwinHub().addDevice(DEVICE);
      const failing: ActiveCookReader = {
        getActiveCookIdForDevice: async () => {
          throw Object.assign(new Error('https://mgv2-secret-account.documents.azure.com/ 503'), {
            statusCode: 503,
          });
        },
      };
      const error = await syncError(
        syncDeviceTwinWith({ twin: hub, cooks: failing }, USER, DEVICE, 'r')
      );
      expect(error.reason).toBe('cosmos_active_cook_read_failed');
      expect(error.message).not.toContain('mgv2-secret-account');
      expect(hub.patches).toEqual([]);
    });

    it('reports an unexpected twin error as iothub_failure', async () => {
      const failing: DeviceTwinPort = {
        getTwin: async () => {
          throw new Error(`boom at ${DEVICE}.azure-devices.net`);
        },
        patchDesired: async () => undefined,
      };
      const error = await syncError(
        syncDeviceTwinWith({ twin: failing, cooks: fakeCooks().reader }, USER, DEVICE, 'r')
      );
      expect(error.reason).toBe('iothub_failure');
      expect(error.message).not.toContain('azure-devices');
    });
  });
});
