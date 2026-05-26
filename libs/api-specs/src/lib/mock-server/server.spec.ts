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
        total: expect.any(Number),
        offset: expect.any(Number),
        limit: expect.any(Number),
        hasMore: expect.any(Boolean),
      }),
    );
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

  test('(c) POST /cooks with valid body returns 201 + Cook', async () => {
    const res = await request(app)
      .post('/cooks')
      .set('Content-Type', 'application/json')
      .send({
        name: 'Tri-Tip Reverse Sear',
        deviceId: 'meatgeek3',
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
        deviceId: 'meatgeek3',
        name: 'Tri-Tip Reverse Sear',
        status: 'active',
        startTime: expect.any(String),
        meatType: 'beef',
      }),
    );
    expect(res.body.id).toMatch(/^cook-/);
  });

  test('(d) POST /cooks with missing meatType returns 400 with VALIDATION_ERROR envelope', async () => {
    const res = await request(app)
      .post('/cooks')
      .set('Content-Type', 'application/json')
      .send({ name: 'Half-formed Cook', deviceId: 'meatgeek3' });
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
