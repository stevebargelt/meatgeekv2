import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import type { components, operations } from '@meatgeekv2/api-specs/types';
import { FROZEN_NOW_MS, frozenIso } from './clock';
import { corsHeaders, fulfillPreflight } from './http';

type Schemas = components['schemas'];
export type Device = Schemas['Device'];
export type Cook = Schemas['Cook'];
export type CookChart = Schemas['CookChart'];
export type StartCookRequest = Schemas['StartCookRequest'];
export type ClaimDeviceRequest = Schemas['ClaimDeviceRequest'];
export type SignalRConnectionInfo = Schemas['SignalRConnectionInfo'];
export type TemperatureReading = Schemas['TemperatureReading'];

/**
 * The JSON body the spec declares for one operation and status. Every
 * response below is built against this, so a fake that drifts from
 * libs/api-specs/spec/openapi.yaml fails `nx run web-e2e:typecheck`.
 */
type Json<
  Op extends keyof operations,
  Status extends keyof operations[Op]['responses'],
> = operations[Op]['responses'][Status] extends { content: { 'application/json': infer Body } }
  ? Body
  : never;

/** One request the fake received. */
export interface RecordedRequest {
  method: string;
  /** The path after `/api`, e.g. `/cooks/abc/stop`. */
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  body: unknown;
}

/** One-minute buckets: the chart's finest resolution. */
const BUCKET_SECONDS = 60;
/**
 * The fake back-dates a new cook's start by this many whole buckets, so its
 * chart already has that many completed buckets before any reading the test
 * pushes. A pushed reading is drawn only after the last bucket's end.
 */
export const CHART_BUCKETS = 3;

export interface FakeApiOptions {
  apiBaseUrl: string;
  device: Device;
  /** The SignalR connection info POST /negotiate returns. */
  negotiate: SignalRConnectionInfo;
  /** The stored reading GET /temperatures/current answers; none (404) if unset. */
  currentReading?: TemperatureReading;
  /** Answer POST /negotiate with this error status instead of the connection info. */
  negotiateError?: 401;
  /**
   * HAR-141: the device starts unclaimed, claimable with this code (as the
   * device shows it, `XXXX-XXXX-XXXX`). Unset: it is the user's already.
   */
  claimCode?: string;
}

/**
 * An in-memory API on `page.route`, implementing only the routes the main
 * path uses. Anything else is answered 404 and listed in `unexpected`. Its
 * times are FROZEN_NOW_MS (clock.ts), never the real clock.
 */
export class FakeApi {
  readonly requests: RecordedRequest[] = [];
  readonly unexpected: string[] = [];
  readonly cooks = new Map<string, Cook>();
  /** Whether the device is the user's: listed, and its routes answer. */
  claimed: boolean;
  constructor(private readonly options: FakeApiOptions) {
    this.claimed = options.claimCode === undefined;
  }

  async install(page: Page): Promise<void> {
    await page.route(`${this.options.apiBaseUrl}/**`, route => this.handle(route));
  }

  /** The recorded calls with this method and path. */
  calls(method: string, path: string): RecordedRequest[] {
    return this.requests.filter(r => r.method === method && r.path === path);
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === 'OPTIONS') return fulfillPreflight(route);

    const url = new URL(request.url());
    const path = url.pathname.slice(new URL(this.options.apiBaseUrl).pathname.length);
    const raw = request.postData();
    const recorded: RecordedRequest = {
      method: request.method(),
      path,
      query: url.searchParams,
      authorization: request.headers()['authorization'],
      body: raw ? JSON.parse(raw) : undefined,
    };
    this.requests.push(recorded);

    const reply = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { ...corsHeaders(route), 'x-request-id': randomUUID() },
        body: JSON.stringify(body),
      });

    const method = recorded.method;
    const match = (pattern: RegExp) => path.match(pattern)?.slice(1).map(decodeURIComponent);
    let params: string[] | undefined;

    if (method === 'GET' && path === '/devices') {
      return reply(200, this.listDevices());
    }
    if (method === 'POST' && path === '/devices/claim') {
      const claimed = this.claim(recorded.body as ClaimDeviceRequest);
      return claimed ? reply(201, claimed) : reply(403, claimRefused());
    }
    if (method === 'GET' && (params = match(/^\/devices\/([^/]+)$/))) {
      return this.owns(params[0])
        ? reply(200, this.getDevice())
        : reply(404, notFound('DEVICE_NOT_FOUND'));
    }
    if (method === 'DELETE' && (params = match(/^\/devices\/([^/]+)$/))) {
      if (!this.owns(params[0])) return reply(404, notFound('DEVICE_NOT_FOUND'));
      const cooking = [...this.cooks.values()].some(
        c => c.deviceId === params?.[0] && c.status === 'active'
      );
      if (cooking) return reply(409, cookActive());
      this.claimed = false;
      return route.fulfill({
        status: 204,
        headers: { ...corsHeaders(route), 'x-request-id': randomUUID() },
      });
    }
    if (method === 'GET' && path === '/cooks') {
      return reply(200, this.listCooks(url.searchParams.get('status')));
    }
    if (method === 'POST' && path === '/cooks') {
      return reply(201, this.startCook(recorded.body as StartCookRequest));
    }
    if (method === 'GET' && (params = match(/^\/cooks\/([^/]+)$/))) {
      const cook = this.cooks.get(params[0]);
      return cook ? reply(200, this.getCook(cook)) : reply(404, notFound('NOT_FOUND'));
    }
    if (method === 'POST' && (params = match(/^\/cooks\/([^/]+)\/stop$/))) {
      const cook = this.cooks.get(params[0]);
      return cook ? reply(200, this.stopCook(cook)) : reply(404, notFound('NOT_FOUND'));
    }
    if (method === 'GET' && (params = match(/^\/cooks\/([^/]+)\/chart$/))) {
      const cook = this.cooks.get(params[0]);
      return cook ? reply(200, this.chart(cook)) : reply(404, notFound('NOT_FOUND'));
    }
    if (method === 'GET' && (params = match(/^\/temperatures\/current\/([^/]+)$/))) {
      const stored = this.options.currentReading;
      if (stored && params[0] === this.options.device.id) return reply(200, stored);
      // No reading is stored: the live panel waits for the one the test pushes.
      return reply(
        404,
        notFound(params[0] === this.options.device.id ? 'NO_READINGS' : 'DEVICE_NOT_FOUND')
      );
    }
    if (method === 'POST' && path === '/negotiate') {
      const error = this.options.negotiateError;
      if (error) return reply(error, unauthenticated());
      return reply(200, this.negotiate());
    }

    this.unexpected.push(`${recorded.method} ${path}${url.search}`);
    return reply(404, notFound('NOT_FOUND'));
  }

  private owns(deviceId: string): boolean {
    return this.claimed && deviceId === this.options.device.id;
  }

  private listDevices(): Json<'getDevices', 200> {
    return { devices: this.claimed ? [this.options.device] : [] };
  }

  /**
   * The device, now the user's, when it is unclaimed and `body` carries its
   * id and code (case, spaces and hyphens ignored, as the API does); else
   * undefined, a refusal. A claimed code is used up: it never claims again.
   */
  private claim(body: ClaimDeviceRequest): Json<'claimDevice', 201> | undefined {
    const code = this.options.claimCode;
    const normalize = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();
    if (
      this.claimed ||
      code === undefined ||
      body.deviceId !== this.options.device.id ||
      normalize(body.claimCode) !== normalize(code)
    ) {
      return undefined;
    }
    this.claimed = true;
    this.options.claimCode = undefined;
    // The stored device takes the name and location the claim sent.
    const device: Device = { ...this.options.device, name: body.name.trim() };
    delete device.location;
    if (body.location !== undefined) device.location = body.location;
    this.options.device = device;
    // HAR-143: as the real route, the claim answers without the live connection.
    const claimed = { ...device };
    delete claimed.connection;
    return claimed;
  }

  private getDevice(): Json<'getDevice', 200> {
    return this.options.device;
  }

  private listCooks(status: string | null): Json<'listCooks', 200> {
    const cooks = [...this.cooks.values()].filter(c => status === null || c.status === status);
    return { cooks, limit: 100, hasMore: false };
  }

  private startCook(body: StartCookRequest): Json<'startCook', 201> {
    const start = new Date(FROZEN_NOW_MS - CHART_BUCKETS * BUCKET_SECONDS * 1000);
    start.setUTCSeconds(0, 0);
    const cook: Cook = {
      id: body.id,
      userId: this.options.device.userId,
      deviceId: body.deviceId,
      name: body.name.trim(),
      meatType: body.meatType.trim(),
      status: 'active',
      startTime: start.toISOString(),
      ...(body.weight === undefined ? {} : { weight: body.weight }),
      ...(body.targetTemps === undefined ? {} : { targetTemps: body.targetTemps }),
    };
    this.cooks.set(cook.id, cook);
    return cook;
  }

  private getCook(cook: Cook): Json<'getCook', 200> {
    return cook;
  }

  private stopCook(cook: Cook): Json<'stopCook', 200> {
    if (cook.status === 'active') {
      cook.status = 'completed';
      cook.endTime = frozenIso();
    }
    return cook;
  }

  /** CHART_BUCKETS one-minute buckets of grill and probe 1 from the cook's start. */
  private chart(cook: Cook): Json<'getCookChart', 200> {
    const start = Date.parse(cook.startTime);
    return {
      cookId: cook.id,
      deviceId: cook.deviceId,
      startTime: cook.startTime,
      ...(cook.endTime ? { endTime: cook.endTime } : {}),
      bucketSeconds: BUCKET_SECONDS,
      points: Array.from({ length: CHART_BUCKETS }, (_, i) => ({
        t: new Date(start + i * BUCKET_SECONDS * 1000).toISOString(),
        grill: { min: 218 + i, max: 226 + i, avg: 222 + i },
        probe1: { min: 120 + 5 * i, max: 124 + 5 * i, avg: 122 + 5 * i },
      })),
    };
  }

  private negotiate(): Json<'negotiate', 200> {
    return this.options.negotiate;
  }
}

type ErrorResponse = Json<'getCook', 404>;

function unauthenticated(): ErrorResponse {
  return { error: 'UNAUTHENTICATED', message: 'Unauthenticated.', requestId: randomUUID() };
}

function claimRefused(): Json<'claimDevice', 403> {
  return {
    error: 'CLAIM_REFUSED',
    message: 'Device could not be claimed with that code',
    requestId: randomUUID(),
  };
}

function cookActive(): Json<'deleteDevice', 409> {
  return {
    error: 'COOK_ACTIVE',
    message: 'Stop the active cook before releasing this device',
    requestId: randomUUID(),
  };
}

function notFound(error: ErrorResponse['error']): ErrorResponse {
  return { error, message: `Not found (${error}).`, requestId: randomUUID() };
}
