import type { InvocationContext } from '@azure/functions';
import type { Cook, TargetTemperatures } from '@meatgeekv2/api-interfaces';
import type { Meter } from '@opentelemetry/api';

import { ApnsClient } from '../../shared/apns/apns-client';
import type { ApnsRequest, ApnsResponse, ApnsTransport } from '../../shared/apns/apns-transport';
import { CooksRepository } from '../../shared/cosmos/cooks-repository';
import { FakeCooksContainer } from '../../shared/cosmos/fake-cooks-container.testing';
import { FakeDevicesContainer } from '../../shared/cosmos/fake-devices-container.testing';
import { PushTokensRepository } from '../../shared/cosmos/push-tokens-repository';
import {
  recordTargetsReachedHandler,
  type RecordTargetsReachedDeps,
} from './record-targets-reached';
import type { TemperatureUnit } from './target-alerts';

/**
 * The reading-batch handler of the target rule and its alerts, driven the way
 * the Functions host drives the Event Hub trigger: a batch of bodies, with each
 * event's hub-stamped device id and enqueued time in `triggerMetadata`. Cooks
 * live in a fake cooks container, phones in a fake users container, Apple is a
 * fake APNs transport behind the real client, and the clock is a variable the
 * test moves. Nothing reads the wall clock.
 */

export const OWNER = 'owner-a';
export const DEVICE = 'smoker-a';
export const COOK = 'cook-1';

const START_MS = Date.UTC(2026, 10, 25, 18, 0, 0);

/** Reading n is stamped 5 s after reading n-1, as the device sends them. */
export function at(n: number): string {
  return new Date(START_MS + n * 5_000).toISOString();
}

export interface Reading {
  n: number;
  grillTemp?: number;
  probe1Temp?: number;
  probe2Temp?: number;
  cookId?: string;
  deviceId?: string;
}

export function batchOf(readings: Reading[]): { events: unknown[]; context: InvocationContext } {
  const logs: string[] = [];
  const context = {
    invocationId: 'targets-inv',
    triggerMetadata: {
      systemPropertiesArray: readings.map(r => ({
        'iothub-connection-device-id': r.deviceId ?? DEVICE,
        'iothub-enqueuedtime': at(r.n),
      })),
      enqueuedTimeUtcArray: readings.map(r => at(r.n)),
    },
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    extraOutputs: { set: () => undefined },
    logs,
  } as unknown as InvocationContext;
  const events = readings.map(({ n, cookId, deviceId: _deviceId, ...temps }) => ({
    timestamp: at(n),
    cookId: cookId === undefined ? COOK : cookId,
    ...temps,
  }));
  return { events, context };
}

export function logsOf(context: InvocationContext): string[] {
  return (context as unknown as { logs: string[] }).logs;
}

/** Apple's answer to one push, or `'no-answer'` for a network failure. */
export type FakeAnswer = { status: number; reason?: string } | 'no-answer';

/** Stands in for Apple: records every request and answers from a per-token rule. */
export class FakeApnsTransport implements ApnsTransport {
  readonly sent: ApnsRequest[] = [];
  /** The answer for a device token; 200 unless set. */
  answers = new Map<string, FakeAnswer>();
  /** Runs as each push is answered (to move the clock, for instance). */
  onSend?: (request: ApnsRequest) => void;

  async send(request: ApnsRequest): Promise<ApnsResponse> {
    this.sent.push(request);
    this.onSend?.(request);
    const answer = this.answers.get(request.deviceToken) ?? { status: 200 };
    if (answer === 'no-answer') {
      throw new Error(`connect ECONNRESET ${request.deviceToken}`);
    }
    return {
      status: answer.status,
      apnsId: 'apns-id',
      body: answer.reason ? JSON.stringify({ reason: answer.reason }) : '',
    };
  }

  /** The alerts sent, as the phone would show them. */
  alerts(): Array<{ token: string; title: string; body: string; thread: string; cookId: string }> {
    return this.sent.map(request => {
      const payload = JSON.parse(request.body) as {
        aps: { alert: { title: string; body: string }; 'thread-id': string };
        cookId: string;
      };
      return {
        token: request.deviceToken,
        title: payload.aps.alert.title,
        body: payload.aps.alert.body,
        thread: payload.aps['thread-id'],
        cookId: payload.cookId,
      };
    });
  }

  titles(): string[] {
    return this.alerts().map(a => a.title);
  }
}

export class RecordingMeter {
  readonly records: Array<{ name: string; value: number; attributes: unknown }> = [];
  asMeter(): Meter {
    return {
      createHistogram: (name: string) => ({
        record: (value: number, attributes?: unknown) =>
          this.records.push({ name, value, attributes: attributes ?? {} }),
      }),
    } as unknown as Meter;
  }
}

/** A phone's made-up APNs token: 64 hex characters. */
export function phoneToken(n: number): string {
  return n.toString(16).padStart(2, '0').repeat(32);
}

export class Harness {
  readonly container = new FakeCooksContainer();
  readonly repository = new CooksRepository(this.container.asContainer());
  readonly usersContainer = new FakeDevicesContainer();
  /** The fake clock: the time an alert is sent. Starts at reading 0. */
  now = new Date(at(0));
  readonly pushTokens = new PushTokensRepository(this.usersContainer.asContainer(), () => this.now);
  readonly apple = new FakeApnsTransport();
  readonly meter = new RecordingMeter();
  unit: TemperatureUnit = 'fahrenheit';
  readonly deps: RecordTargetsReachedDeps = {
    ownerOf: async deviceId => (deviceId === DEVICE ? OWNER : undefined),
    getRepository: () => this.repository,
    getPushTokens: () => this.pushTokens,
    getApns: () =>
      new ApnsClient({
        transport: this.apple,
        tokens: { get: async () => 'provider.jwt.token' },
        host: 'api.sandbox.push.apple.com',
        bundleId: 'com.meatgeek.ios',
      }),
    temperatureUnitOf: async () => this.unit,
    now: () => this.now,
    meter: this.meter.asMeter(),
  };

  startCook(targetTemps: TargetTemperatures, status: Cook['status'] = 'active'): void {
    this.container.seed({
      id: COOK,
      userId: OWNER,
      deviceId: DEVICE,
      name: 'Brisket',
      status,
      startTime: at(0),
      targetTemps: { ...targetTemps },
    });
  }

  async registerPhone(token: string, userId = OWNER): Promise<void> {
    await this.pushTokens.register(userId, token);
  }

  async phoneIds(userId = OWNER): Promise<string[]> {
    return (await this.pushTokens.listSummaries(userId)).tokens.map(t => t.id);
  }

  /**
   * Each call is one batch, as one trigger invocation. The clock is set to the
   * newest reading's time first: in normal running a batch arrives the moment
   * its readings are taken.
   */
  async send(...readings: Reading[]): Promise<InvocationContext> {
    const newest = Math.max(...readings.map(r => r.n));
    if (Date.parse(at(newest)) > this.now.getTime()) {
      this.now = new Date(at(newest));
    }
    return this.sendAsIs(...readings);
  }

  /** One batch, with the clock left where the test put it. */
  async sendAsIs(...readings: Reading[]): Promise<InvocationContext> {
    const { events, context } = batchOf(readings);
    await recordTargetsReachedHandler(events, context, this.deps);
    return context;
  }

  async cook(): Promise<Cook> {
    const { cook } = await this.repository.getCook(OWNER, COOK);
    if (!cook) {
      throw new Error('cook missing');
    }
    return cook;
  }
}

export const noopMeter = {
  createHistogram: () => ({ record: () => undefined }),
} as unknown as Meter;
