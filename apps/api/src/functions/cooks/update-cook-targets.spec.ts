/**
 * PUT /cooks/{cookId}/targets (#240), with NO Azure and NO credentials.
 *
 * The handler runs over the REAL CooksRepository on the in-memory cooks
 * container (point reads and If-Match replaces), reads real base64
 * X-MS-CLIENT-PRINCIPAL headers through the real principal.ts, and is told who
 * owns a device by a fake. The re-arm cases then drive the real target rule
 * (recordTargetsReachedHandler) the way the Functions host does, so "reached
 * again on the next two readings" is the rule's own behaviour, not a copy.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Cook } from '@meatgeekv2/api-interfaces';

import { principalFromRequest } from '../../shared/auth/principal';
import { CooksRepository } from '../../shared/cosmos/cooks-repository';
import type { DeviceOwnership } from '../../shared/cosmos/devices-repository';
import {
  COOKS_READ_CHARGE,
  COOKS_WRITE_CHARGE,
  FakeCooksContainer,
} from '../../shared/cosmos/fake-cooks-container.testing';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import { recordTargetsReachedHandler } from './record-targets-reached';
import { updateCookTargetsHandler, type UpdateCookTargetsDeps } from './update-cook-targets';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const USER_ID = `${TID}:${OID}`;
const OTHER_OID = 'oid-zzzz-9999';
const COOK_ID = '3f4a5b6c-7d8e-4f9a-8b1c-2d3e4f5a6b7c';
const DEVICE = 'grill-1';
const OWNERSHIP_CHARGE = 1;

function encodedPrincipal(oid: string): string {
  const payload = {
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: TID },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** `body` is sent as JSON; a string is sent as it is (malformed JSON). */
function request(options: {
  body?: unknown;
  cookId?: string;
  principal?: string | null;
  requestId?: string;
}): HttpRequest {
  const headers = new Map<string, string>();
  const principal = options.principal === undefined ? encodedPrincipal(OID) : options.principal;
  if (principal !== null) headers.set('x-ms-client-principal', principal);
  if (options.requestId !== undefined) headers.set('x-request-id', options.requestId);
  const raw = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    params: { cookId: options.cookId ?? COOK_ID },
    json: async () => JSON.parse(raw),
  } as unknown as HttpRequest;
}

function context(): InvocationContext {
  const noop = () => undefined;
  return {
    invocationId: 'inv-240',
    log: noop,
    warn: noop,
    error: noop,
    extraOutputs: { set: noop },
  } as unknown as InvocationContext;
}

/** Reading n is stamped 5 s after reading n-1, as the device sends them. */
function at(n: number): string {
  return new Date(Date.UTC(2026, 10, 27, 18, 0, 0) + n * 5_000).toISOString();
}

class Harness {
  readonly container = new FakeCooksContainer();
  readonly repository = new CooksRepository(this.container.asContainer());
  ownership: DeviceOwnership['status'] = 'owned';
  readonly ownershipReads: Array<{ userId: string; deviceId: string }> = [];
  readonly deps: UpdateCookTargetsDeps = {
    resolvePrincipal: principalFromRequest,
    getRepository: () => this.repository,
    getDeviceOwnership: async (userId, deviceId) => {
      this.ownershipReads.push({ userId, deviceId });
      return { status: this.ownership, requestCharge: OWNERSHIP_CHARGE } as DeviceOwnership;
    },
  };

  seed(overrides: Partial<Cook> & Record<string, unknown> = {}): void {
    this.container.seed({
      id: COOK_ID,
      userId: USER_ID,
      deviceId: DEVICE,
      name: 'Weekend Brisket',
      status: 'active',
      startTime: at(0),
      meatType: 'brisket',
      targetTemps: { grill: 225, probe1: 203 },
      ...overrides,
    });
  }

  /** Saves `targetTemps` as the cook's targets. */
  put(targetTemps: unknown, options: Parameters<typeof request>[0] = {}): Promise<HttpResponseInit> {
    return this.putRaw({ targetTemps }, options);
  }

  putRaw(body: unknown, options: Parameters<typeof request>[0] = {}): Promise<HttpResponseInit> {
    return updateCookTargetsHandler(request({ body, ...options }), context(), this.deps);
  }

  /** One batch of readings through the real target rule. */
  async readings(...readings: Array<{ n: number; grillTemp?: number; probe1Temp?: number }>) {
    const events = readings.map(({ n, ...temps }) => ({
      timestamp: at(n),
      cookId: COOK_ID,
      ...temps,
    }));
    const ctx = {
      ...context(),
      triggerMetadata: {
        systemPropertiesArray: readings.map(r => ({
          'iothub-connection-device-id': DEVICE,
          'iothub-enqueuedtime': at(r.n),
        })),
        enqueuedTimeUtcArray: readings.map(r => at(r.n)),
      },
    } as unknown as InvocationContext;
    await recordTargetsReachedHandler(events, ctx, {
      ownerOf: async deviceId => (deviceId === DEVICE ? USER_ID : undefined),
      getRepository: () => this.repository,
    });
  }

  stored(): Record<string, unknown> {
    return this.container.peek(USER_ID, COOK_ID);
  }
}

function bodyOf(response: HttpResponseInit): Record<string, unknown> {
  return response.jsonBody as Record<string, unknown>;
}

describe('PUT /cooks/{cookId}/targets', () => {
  it('sets, changes and clears targets in one save and returns the cook', async () => {
    const h = new Harness();
    h.seed();

    const response = await h.put({ probe1: 165, probe2: 160 }, { requestId: 'req-1' });

    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ 'X-Request-ID': 'req-1' });
    const cook = bodyOf(response) as unknown as Cook;
    expect(cook.id).toBe(COOK_ID);
    // grill cleared (absent from the body), probe1 changed, probe2 added.
    expect(cook.targetTemps).toEqual({ probe1: 165, probe2: 160 });
    expect(h.stored()['targetTemps']).toEqual({ probe1: 165, probe2: 160 });
    expect(h.stored()['targetsPending']).toBeUndefined();
  });

  it('clears every target with an empty targetTemps', async () => {
    const h = new Harness();
    h.seed({ targetsReached: { grill: { reachedAt: at(2) } } });

    const response = await h.put({});

    expect(response.status).toBe(200);
    const cook = bodyOf(response) as unknown as Cook;
    expect(cook.targetTemps).toBeUndefined();
    expect(cook.targetsReached).toBeUndefined();
    expect(h.stored()['targetTemps']).toBeUndefined();
  });

  it('lets the last save win', async () => {
    const h = new Harness();
    h.seed();

    await h.put({ probe1: 165 });
    await h.put({ probe1: 203, probe3: 145 });

    expect(h.stored()['targetTemps']).toEqual({ probe1: 203, probe3: 145 });
  });

  it('charges the reads and the write it made', async () => {
    const h = new Harness();
    h.seed();

    const response = await h.put({ probe1: 165 });

    // The handler's point read, the ownership read, then the repository's
    // read-then-replace.
    expect(response.headers).toMatchObject({
      [REQUEST_CHARGE_HEADER]: String(
        COOKS_READ_CHARGE + OWNERSHIP_CHARGE + COOKS_READ_CHARGE + COOKS_WRITE_CHARGE
      ),
    });
  });

  describe('re-arming', () => {
    it('re-arms a channel whose target changes, and clears what it had pending', async () => {
      const h = new Harness();
      h.seed({
        targetsReached: { probe1: { reachedAt: at(2) } },
        targetsPending: { grill: at(3) },
      });

      const response = await h.put({ grill: 250, probe1: 165 });

      expect(bodyOf(response)['targetsReached']).toBeUndefined();
      expect(h.stored()['targetsReached']).toBeUndefined();
      expect(h.stored()['targetsPending']).toBeUndefined();
    });

    it('changes nothing when a target is saved with the value it has', async () => {
      const h = new Harness();
      h.seed({
        targetsReached: { probe1: { reachedAt: at(2) } },
        targetsPending: { grill: at(3) },
      });

      const response = await h.put({ grill: 225, probe1: 203 });

      expect(response.status).toBe(200);
      expect(bodyOf(response)['targetsReached']).toEqual({ probe1: { reachedAt: at(2) } });
      expect(h.container.replaces).toEqual([]);
    });

    it('keeps the reached state of a channel whose target is unchanged when another changes', async () => {
      const h = new Harness();
      h.seed({ targetsReached: { grill: { reachedAt: at(2) }, probe1: { reachedAt: at(2) } } });

      await h.put({ grill: 225, probe1: 165 });

      expect(h.stored()['targetsReached']).toEqual({ grill: { reachedAt: at(2) } });
    });

    it('clears the reached state of a cleared target', async () => {
      const h = new Harness();
      h.seed({ targetsReached: { grill: { reachedAt: at(2) }, probe1: { reachedAt: at(2) } } });

      await h.put({ grill: 225 });

      expect(h.stored()['targetsReached']).toEqual({ grill: { reachedAt: at(2) } });
    });

    it('lets a changed target be reached again, at the second reading after the change', async () => {
      const h = new Harness();
      h.seed({ targetTemps: { probe1: 165 } });
      await h.readings({ n: 1, probe1Temp: 170 }, { n: 2, probe1Temp: 171 });
      expect(h.stored()['targetsReached']).toEqual({ probe1: { reachedAt: at(2) } });

      // Wrap done: the finish target is set. It is not met yet.
      await h.put({ probe1: 203 });
      await h.readings({ n: 3, probe1Temp: 190 });
      expect(h.stored()['targetsReached']).toBeUndefined();

      await h.readings({ n: 4, probe1Temp: 203 }, { n: 5, probe1Temp: 204 });
      expect(h.stored()['targetsReached']).toEqual({ probe1: { reachedAt: at(5) } });
    });

    it('reaches a new target that is already met on the next two readings, not on one', async () => {
      const h = new Harness();
      h.seed({ targetTemps: { probe1: 203 } });
      // The probe sits at 181, below its target: nothing is pending.
      await h.readings({ n: 1, probe1Temp: 181 });

      await h.put({ probe1: 175 });
      await h.readings({ n: 2, probe1Temp: 181 });
      expect(h.stored()['targetsReached']).toBeUndefined();

      await h.readings({ n: 3, probe1Temp: 181 });
      expect(h.stored()['targetsReached']).toEqual({ probe1: { reachedAt: at(3) } });
    });

    it('does not let a reading pending under the old target count towards the new one', async () => {
      const h = new Harness();
      h.seed({ targetTemps: { probe1: 180 } });
      await h.readings({ n: 1, probe1Temp: 185 });
      expect(h.stored()['targetsPending']).toEqual({ probe1: at(1) });

      await h.put({ probe1: 182 });
      await h.readings({ n: 2, probe1Temp: 185 });
      expect(h.stored()['targetsReached']).toBeUndefined();

      await h.readings({ n: 3, probe1Temp: 185 });
      expect(h.stored()['targetsReached']).toEqual({ probe1: { reachedAt: at(3) } });
    });

    it('does not count a redelivered reading already counted under the old target', async () => {
      const h = new Harness();
      h.seed({ targetTemps: { probe1: 165 } });
      await h.readings({ n: 1, probe1Temp: 170 }, { n: 2, probe1Temp: 171 });
      expect(h.stored()['targetsReached']).toEqual({ probe1: { reachedAt: at(2) } });

      const response = await h.put({ probe1: 168 });
      // The watermark is stored only, never returned.
      expect(bodyOf(response)).not.toHaveProperty('targetsSeen');
      expect(h.stored()['targetsSeen']).toEqual({ probe1: at(2) });

      // The event hub delivers the same batch again: nothing new was read.
      await h.readings({ n: 1, probe1Temp: 170 }, { n: 2, probe1Temp: 171 });
      expect(h.stored()['targetsReached']).toBeUndefined();
      expect(h.stored()['targetsPending']).toBeUndefined();

      await h.readings({ n: 3, probe1Temp: 172 });
      expect(h.stored()['targetsReached']).toBeUndefined();
      await h.readings({ n: 4, probe1Temp: 172 });
      expect(h.stored()['targetsReached']).toEqual({ probe1: { reachedAt: at(4) } });
      expect(h.stored()['targetsSeen']).toBeUndefined();
    });

    it('keeps the watermark while a new reading is pending, even when the next falls short', async () => {
      const h = new Harness();
      h.seed({ targetTemps: { probe1: 165 } });
      await h.readings({ n: 1, probe1Temp: 170 }, { n: 2, probe1Temp: 171 });
      await h.put({ probe1: 168 });

      await h.readings({ n: 3, probe1Temp: 170 });
      await h.readings({ n: 4, probe1Temp: 160 });
      expect(h.stored()['targetsPending']).toBeUndefined();

      // The old batch is delivered again after the pending reading went.
      await h.readings({ n: 1, probe1Temp: 170 }, { n: 2, probe1Temp: 171 });
      expect(h.stored()['targetsReached']).toBeUndefined();
      expect(h.stored()['targetsPending']).toBeUndefined();
      expect(h.stored()['targetsSeen']).toEqual({ probe1: at(2) });
    });

    it('keeps the watermark across a second change before any new reading', async () => {
      const h = new Harness();
      h.seed({ targetTemps: { probe1: 165 }, targetsReached: { probe1: { reachedAt: at(2) } } });

      await h.put({ probe1: 168 });
      await h.put({ probe1: 166 });
      await h.readings({ n: 1, probe1Temp: 170 }, { n: 2, probe1Temp: 171 });

      expect(h.stored()['targetsSeen']).toEqual({ probe1: at(2) });
      expect(h.stored()['targetsReached']).toBeUndefined();
    });
  });

  describe('limits (as POST /cooks)', () => {
    it.each([
      [{ probe1: -1 }, 'targetTemps.probe1 must be a number from 0 to 1000'],
      [{ grill: 1000.5 }, 'targetTemps.grill must be a number from 0 to 1000'],
      [{ probe2: '200' }, 'targetTemps.probe2 must be a number from 0 to 1000'],
      [{ probe5: 200 }, 'targetTemps.probe5 is not a target: use grill, probe1, probe2, probe3, probe4'],
      [null, 'targetTemps must be an object'],
      [[], 'targetTemps must be an object'],
    ])('refuses %j with 400 VALIDATION_ERROR and makes no Cosmos call', async (body, message) => {
      const h = new Harness();
      h.seed();

      const response = await h.put(body);

      expect(response.status).toBe(400);
      expect(bodyOf(response)).toEqual({
        error: 'VALIDATION_ERROR',
        message,
        requestId: 'inv-240',
      });
      expect(h.container.reads).toEqual([]);
      expect(response.headers).not.toHaveProperty(REQUEST_CHARGE_HEADER);
    });

    it.each([
      ['{not json', 'Request body must be valid JSON'],
      [[], 'Request body must be a JSON object'],
      [{}, 'targetTemps is required: send {} to clear every target'],
      [{ targetTemps: {}, name: 'Brisket' }, 'name is not a targets field'],
    ])('refuses the body %j with 400', async (body, message) => {
      const h = new Harness();
      h.seed();

      const response = await h.putRaw(body);

      expect(response.status).toBe(400);
      expect(bodyOf(response)['message']).toBe(message);
      expect(h.container.reads).toEqual([]);
    });

    it('accepts both ends of the range', async () => {
      const h = new Harness();
      h.seed();

      const response = await h.put({ grill: 1000, probe4: 0 });

      expect(response.status).toBe(200);
      expect(h.stored()['targetTemps']).toEqual({ grill: 1000, probe4: 0 });
    });
  });

  describe('refusals', () => {
    it('refuses a cook that is not running with 409 COOK_NOT_ACTIVE and writes nothing', async () => {
      const h = new Harness();
      h.seed({ status: 'completed', endTime: at(100) });

      const response = await h.put({ probe1: 165 });

      expect(response.status).toBe(409);
      expect(bodyOf(response)['error']).toBe('COOK_NOT_ACTIVE');
      expect(h.container.replaces).toEqual([]);
      expect(h.stored()['targetTemps']).toEqual({ grill: 225, probe1: 203 });
    });

    it('refuses a cook stopped between the read and the write with 409', async () => {
      const h = new Harness();
      h.seed();
      let stopped = false;
      h.container.beforeReplace = () => {
        if (stopped) return;
        stopped = true;
        h.container.seed({ ...h.stored(), status: 'completed', endTime: at(9) } as never);
      };

      const response = await h.put({ probe1: 165 });

      expect(response.status).toBe(409);
      expect(bodyOf(response)['error']).toBe('COOK_NOT_ACTIVE');
      expect(h.stored()['targetTemps']).toEqual({ grill: 225, probe1: 203 });
    });

    it('answers 404 for a cook of another user, which lives in another partition', async () => {
      const h = new Harness();
      h.seed();

      const response = await h.put({ probe1: 165 }, { principal: encodedPrincipal(OTHER_OID) });

      expect(response.status).toBe(404);
      expect(bodyOf(response)['error']).toBe('NOT_FOUND');
      expect(h.container.replaces).toEqual([]);
    });

    it('answers 404 for a cook that does not exist', async () => {
      const h = new Harness();

      const response = await h.put({ probe1: 165 });

      expect(response.status).toBe(404);
    });

    it.each(['foreign', 'unknown'] as const)(
      'refuses a cook whose device is %s with 403 DEVICE_NOT_OWNED and writes nothing',
      async status => {
        const h = new Harness();
        h.seed();
        h.ownership = status;

        const response = await h.put({ probe1: 165 });

        expect(response.status).toBe(403);
        expect(bodyOf(response)['error']).toBe('DEVICE_NOT_OWNED');
        expect(h.ownershipReads).toEqual([{ userId: USER_ID, deviceId: DEVICE }]);
        expect(h.container.replaces).toEqual([]);
      }
    );

    it('answers 401 without a principal and reads nothing', async () => {
      const h = new Harness();
      h.seed();

      const response = await h.put({ probe1: 165 }, { principal: null });

      expect(response.status).toBe(401);
      expect(h.container.reads).toEqual([]);
    });

    it('answers a sanitized 500 when Cosmos fails', async () => {
      const h = new Harness();
      h.seed();
      h.container.beforeReplace = () => {
        throw Object.assign(new Error('https://mgv2-secret-account.documents.azure.com/ down'), {
          code: 503,
        });
      };

      const response = await h.put({ probe1: 165 });

      expect(response.status).toBe(500);
      expect(JSON.stringify(response.jsonBody)).not.toContain('secret');
      expect(bodyOf(response)['error']).toBe('INTERNAL_SERVER_ERROR');
    });
  });

  it('keeps the change when the target rule writes the cook between its read and its write', async () => {
    const h = new Harness();
    h.seed({ targetsReached: { grill: { reachedAt: at(2) } } });
    let raced = false;
    h.container.beforeReplace = () => {
      if (raced) return;
      raced = true;
      h.container.seed({ ...h.stored(), targetsPending: { probe1: at(3) } } as never);
    };

    const response = await h.put({ grill: 225, probe1: 165 });

    expect(response.status).toBe(200);
    expect(h.stored()['targetTemps']).toEqual({ grill: 225, probe1: 165 });
    // Re-read after the 412: the grill keeps its mark, probe1's pending goes.
    expect(h.stored()['targetsReached']).toEqual({ grill: { reachedAt: at(2) } });
    expect(h.stored()['targetsPending']).toBeUndefined();
  });
});
