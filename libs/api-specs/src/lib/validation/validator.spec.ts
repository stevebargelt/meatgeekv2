import type { OpenAPIV3 } from 'openapi-types';

import {
  initValidator,
  resetValidator,
  validateRequest,
  validateResponse,
} from './validator';
import { validateExpressRequest } from './express-adapter';
import { validateFunctionsRequest } from './functions-adapter';

// Minimal dereferenced spec sufficient to exercise body/query/path validation, additional-
// property rejection, and response-shape validation. Mirrors the real spec's
// StartCookRequest / Cook / ErrorResponse shapes closely enough for parity.
const TEST_SPEC: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: { title: 'Test', version: '0.0.0' },
  paths: {
    '/cooks': {
      get: {
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 500 },
          },
        ],
        responses: {
          '200': {
            description: 'list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['cooks', 'total'],
                  additionalProperties: false,
                  properties: {
                    cooks: { type: 'array', items: { type: 'object' } },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'deviceId', 'meatType'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', minLength: 3, maxLength: 50 },
                  deviceId: { type: 'string' },
                  meatType: { type: 'string' },
                  weight: { type: 'number', minimum: 0 },
                  notes: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'name', 'deviceId', 'status'],
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    deviceId: { type: 'string' },
                    status: { type: 'string', enum: ['active'] },
                  },
                },
              },
            },
          },
          '400': {
            description: 'bad request',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['error', 'message'],
                  properties: {
                    error: { type: 'string' },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/cooks/{id}': {
      get: {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'one',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
};

beforeAll(() => {
  initValidator(TEST_SPEC);
});

afterAll(() => {
  resetValidator();
});

describe('validator core', () => {
  test('(a) valid POST /cooks payload accepted', () => {
    const result = validateRequest('POST', '/cooks', {
      name: 'Brisket Cook',
      deviceId: 'meatgeek3',
      meatType: 'brisket',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('(b) missing required field rejected with field path in error', () => {
    const result = validateRequest('POST', '/cooks', {
      name: 'Some name',
      // deviceId + meatType missing
    });
    expect(result.valid).toBe(false);
    const missingNames = result.errors
      .filter((e) => e.keyword === 'required')
      .flatMap((e) =>
        e.params && typeof e.params['missingProperty'] === 'string'
          ? [e.params['missingProperty'] as string]
          : [],
      );
    expect(missingNames).toEqual(expect.arrayContaining(['deviceId', 'meatType']));
    expect(result.errors[0].path).toContain('/body');
  });

  test('(c) extra unknown property rejected when additionalProperties is false', () => {
    const result = validateRequest('POST', '/cooks', {
      name: 'Brisket Cook',
      deviceId: 'meatgeek3',
      meatType: 'brisket',
      __sneaky__: 'not in schema',
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.keyword === 'additionalProperties'),
    ).toBe(true);
  });

  test('(d) response validator rejects shape that doesn\'t match the schema', () => {
    const result = validateResponse('POST', '/cooks', 201, {
      // Missing required id/deviceId/status
      name: 'X',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('response validator accepts a well-shaped response', () => {
    const result = validateResponse('POST', '/cooks', 201, {
      id: 'cook-1',
      name: 'Brisket',
      deviceId: 'meatgeek3',
      status: 'active',
    });
    expect(result.valid).toBe(true);
  });

  test('concrete path resolves to templated operation', () => {
    const result = validateRequest('GET', '/cooks/abc-123');
    expect(result.valid).toBe(true);
  });

  test('query param type coerced (integer accepts numeric string)', () => {
    const result = validateRequest('GET', '/cooks', undefined, {
      limit: '20',
    });
    expect(result.valid).toBe(true);
  });

  test('query param type rejected when out of bounds', () => {
    const result = validateRequest('GET', '/cooks', undefined, {
      limit: '9999',
    });
    expect(result.valid).toBe(false);
  });

  test('unknown route returns descriptive failure', () => {
    const result = validateRequest('POST', '/does-not-exist', {});
    expect(result.valid).toBe(false);
    expect(result.errors[0].keyword).toBe('operation');
  });
});

describe('adapter parity', () => {
  // Inputs identical between Express and Functions adapters; both should produce
  // identical core ValidationResult.
  const badBody = { name: 'X' }; // missing deviceId, meatType, name too short
  const goodBody = {
    name: 'Brisket Cook',
    deviceId: 'meatgeek3',
    meatType: 'brisket',
  };

  function buildExpressReq(body: unknown) {
    return {
      method: 'POST',
      path: '/cooks',
      body,
      query: {},
      params: {},
    } as unknown as import('express').Request;
  }

  function buildFunctionsReq(body: unknown) {
    const text = JSON.stringify(body);
    const fake = {
      method: 'POST',
      url: 'http://localhost/api/cooks',
      query: new URLSearchParams(),
      params: {},
      clone: () => ({
        text: async () => text,
      }),
    };
    return fake as unknown as import('@azure/functions').HttpRequest;
  }

  test('(e-bad) express and functions adapters return identical verdict for invalid payload', async () => {
    const expressResult = validateExpressRequest(buildExpressReq(badBody));
    const functionsResult = await validateFunctionsRequest(
      buildFunctionsReq(badBody),
    );
    expect(expressResult.valid).toBe(false);
    expect(functionsResult.valid).toBe(false);
    expect(expressResult.errors.map((e) => e.keyword).sort()).toEqual(
      functionsResult.errors.map((e) => e.keyword).sort(),
    );
    expect(expressResult.errors.map((e) => e.path).sort()).toEqual(
      functionsResult.errors.map((e) => e.path).sort(),
    );
  });

  test('(e-good) express and functions adapters return identical verdict for valid payload', async () => {
    const expressResult = validateExpressRequest(buildExpressReq(goodBody));
    const functionsResult = await validateFunctionsRequest(
      buildFunctionsReq(goodBody),
    );
    expect(expressResult.valid).toBe(true);
    expect(functionsResult.valid).toBe(true);
    expect(expressResult.errors).toEqual([]);
    expect(functionsResult.errors).toEqual([]);
  });
});
