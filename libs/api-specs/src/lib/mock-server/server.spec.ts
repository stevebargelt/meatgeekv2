import type { Express } from 'express';
import { VALIDATION } from '@meatgeekv2/utils';

import { buildApp } from './server';
import { resetValidator } from '../validation';
import { __resetCookStoreForTests } from './handlers/cooks';
import { __resetDeviceStoreForTests } from './handlers/devices';
import { __resetTemperatureStateForTests } from './handlers/temperatures';
import { MOCK_USER_ID } from '../mock-data';

// supertest publishes as CommonJS with `export = supertest`; require it
// directly to keep the spec compatible with the workspace's tsconfig (no
// esModuleInterop). Matches the pattern used by spec-loader.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const request: typeof import('supertest') = require('supertest');

const NEW_COOK_ID = '6f1c2b8e-3d4a-4f6b-9c7d-0e1f2a3b4c5d';

describe('mock-server', () => {
  let app: Express;

  beforeAll(async () => {
    app = (await buildApp()) as Express;
  });

  beforeEach(() => {
    __resetCookStoreForTests();
    __resetDeviceStoreForTests();
    __resetTemperatureStateForTests();
  });

  afterAll(() => {
    resetValidator();
  });

  test('(a) GET /docs returns HTML containing Swagger UI', async () => {
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).toContain('swagger ui');
  });

  test('(b) GET /cooks returns CookListResponse-shape JSON', async () => {
    const res = await request(app).get('/cooks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        cooks: expect.any(Array),
        limit: expect.any(Number),
        hasMore: expect.any(Boolean),
      }),
    );
    // Continuation-token pagination (MG-85): no offset-era fields.
    expect(res.body).not.toHaveProperty('total');
    expect(res.body).not.toHaveProperty('offset');
    // Fixture seeded with 3 cooks.
    expect(res.body.cooks.length).toBeGreaterThan(0);
    for (const cook of res.body.cooks) {
      expect(cook).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          userId: expect.any(String),
          deviceId: expect.any(String),
          name: expect.any(String),
          status: expect.any(String),
          startTime: expect.any(String),
        }),
      );
    }
  });

  test('(b2) GET /cooks pages by an opaque continuation token', async () => {
    const first = await request(app).get('/cooks').query({ limit: 1 });
    expect(first.status).toBe(200);
    expect(first.body.cooks).toHaveLength(1);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.continuationToken).toEqual(expect.any(String));

    const second = await request(app)
      .get('/cooks')
      .query({ limit: 1, continuationToken: first.body.continuationToken });
    expect(second.status).toBe(200);
    expect(second.body.cooks).toHaveLength(1);
    expect(second.body.cooks[0].id).not.toBe(first.body.cooks[0].id);

    const all = await request(app).get('/cooks').query({ limit: 100 });
    expect(all.body.hasMore).toBe(false);
    expect(all.body).not.toHaveProperty('continuationToken');
  });

  test('(c) POST /cooks with valid body returns 201 + Cook', async () => {
    const res = await request(app)
      .post('/cooks')
      .set('Content-Type', 'application/json')
      .send({
        id: NEW_COOK_ID,
        name: 'Tri-Tip Reverse Sear',
        // meatgeek3 already has an active fixture cook; one active cook per device.
        deviceId: 'meatgeek4',
        meatType: 'beef',
        weight: 2.5,
        targetTemps: { grill: 250, probe1: 130 },
        notes: 'Smoke until 115F internal then sear.',
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        userId: MOCK_USER_ID,
        deviceId: 'meatgeek4',
        name: 'Tri-Tip Reverse Sear',
        status: 'active',
        startTime: expect.any(String),
        meatType: 'beef',
      }),
    );
    expect(res.body.id).toBe(NEW_COOK_ID);
  });

  test('(d) POST /cooks with missing meatType returns 400 with VALIDATION_ERROR envelope', async () => {
    const res = await request(app)
      .post('/cooks')
      .set('Content-Type', 'application/json')
      .send({ id: NEW_COOK_ID, name: 'Half-formed Cook', deviceId: 'meatgeek3' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'VALIDATION_ERROR',
        message: expect.any(String),
        requestId: expect.any(String),
      }),
    );
  });

  test('(e) GET /temperatures/current/{deviceId} returns values within VALIDATION.TEMPERATURE bounds across 10 calls', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/temperatures/current/meatgeek3');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          deviceId: 'meatgeek3',
          timestamp: expect.any(String),
        }),
      );
      const grill = res.body.grillTemp;
      expect(typeof grill).toBe('number');
      expect(grill).toBeGreaterThanOrEqual(VALIDATION.TEMPERATURE.MIN);
      expect(grill).toBeLessThanOrEqual(VALIDATION.TEMPERATURE.MAX);
      // Tighter smoke bound matching the README/acceptance curl assertion.
      expect(grill).toBeGreaterThanOrEqual(200);
      expect(grill).toBeLessThanOrEqual(300);
    }
  });

  describe('MG-84 POST /cooks retry contract', () => {
    const start = (body: Record<string, unknown>) =>
      request(app).post('/cooks').set('Content-Type', 'application/json').send(body);
    const brisket = {
      id: NEW_COOK_ID,
      name: 'Retry Brisket',
      deviceId: 'meatgeek4',
      meatType: 'brisket',
      targetTemps: { grill: 225, probe1: 203 },
    };

    test('a retry returns 200 with the original cook and stores one cook', async () => {
      const first = await start(brisket);
      const retry = await start(brisket);

      expect(first.status).toBe(201);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      const all = await request(app).get('/cooks').query({ limit: 100 });
      expect(all.body.cooks.filter((c: { id: string }) => c.id === NEW_COOK_ID)).toHaveLength(1);
    });

    test('the same id with a different body returns 422 COOK_ID_REUSED', async () => {
      await start(brisket);
      const reuse = await start({ ...brisket, name: 'Different Brisket' });

      expect(reuse.status).toBe(422);
      expect(reuse.body.error).toBe('COOK_ID_REUSED');
    });

    test('a second cook on a busy device returns 409 COOK_ALREADY_ACTIVE with the active cook id', async () => {
      const busy = await start({ ...brisket, deviceId: 'meatgeek3' });

      expect(busy.status).toBe(409);
      expect(busy.body).toEqual({
        error: 'COOK_ALREADY_ACTIVE',
        message: expect.any(String),
        requestId: expect.any(String),
        activeCookId: 'cook-active-001',
      });
    });

    test('a missing or non-UUID id returns 400 VALIDATION_ERROR', async () => {
      const { id: _omit, ...withoutId } = brisket;
      void _omit;
      expect((await start(withoutId)).status).toBe(400);
      expect((await start({ ...brisket, id: 'cook-1' })).status).toBe(400);
    });
  });

  test('POST /cooks with empty body returns 400 (validation middleware engaged)', async () => {
    const res = await request(app)
      .post('/cooks')
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('GET /devices requires userId and wraps in {devices: [...]}', async () => {
    const missing = await request(app).get('/devices');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('VALIDATION_ERROR');

    const ok = await request(app).get(`/devices?userId=${MOCK_USER_ID}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual(
      expect.objectContaining({ devices: expect.any(Array) }),
    );
    expect(ok.body.devices.length).toBeGreaterThan(0);
  });

  test('GET /health is reachable without OpenAPI validation', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
