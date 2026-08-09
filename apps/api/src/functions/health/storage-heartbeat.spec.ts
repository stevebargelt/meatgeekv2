/**
 * MG-58 — the probe that makes a broken host storage account observable.
 *
 * The defect this ticket fixes hid because nothing in the app needed
 * AzureWebJobsStorage: `azure.functions.webjobs.storage` was Unhealthy with
 * AuthenticationFailed every ~30s while all seven HTTP triggers answered 200.
 * The evidence that the fix works is the timer FIRING — the host cannot grant
 * its lease or persist its schedule status without an authenticated storage
 * account — so these tests hold the properties that make that evidence usable:
 * the handler is registered on the intended low-frequency schedule, it emits the
 * marker the runbook greps for, and it cannot fail an invocation on its own.
 *
 * The handler is exercised directly. No network, no Azure SDK, no credentials —
 * following the cosmos-health.spec.ts convention.
 */
import type { InvocationContext, Timer } from '@azure/functions';

import {
  STORAGE_HEARTBEAT_MARKER,
  STORAGE_HEARTBEAT_SCHEDULE,
  formatStorageHeartbeat,
  storageHeartbeatHandler,
} from './storage-heartbeat';

interface TimerRegistration {
  schedule: string;
  handler: unknown;
}

const timerRegistrations: Record<string, TimerRegistration> = {};
const httpRegistrations: string[] = [];

// main.ts is the Functions v4 registration path; capturing the registrations is
// the only way to prove the timer is wired to the intended handler on the
// intended schedule without a Functions host.
jest.mock('@azure/functions', () => {
  const actual = jest.requireActual('@azure/functions');
  return {
    ...actual,
    app: {
      http: (name: string) => {
        httpRegistrations.push(name);
      },
      timer: (name: string, registration: TimerRegistration) => {
        timerRegistrations[name] = registration;
      },
    },
  };
});

function context(invocationId = 'heartbeat-inv'): InvocationContext {
  return {
    invocationId,
    log: jest.fn(),
    error: jest.fn(),
  } as unknown as InvocationContext;
}

function timer(overrides: Partial<Timer> = {}): Timer {
  return {
    isPastDue: false,
    schedule: { adjustForDST: true },
    scheduleStatus: {
      last: '2026-08-09T12:00:00Z',
      next: '2026-08-09T12:15:00Z',
      lastUpdated: '2026-08-09T12:00:00Z',
    },
    ...overrides,
  } as Timer;
}

function loggedBy(invocationContext: InvocationContext): string {
  return (invocationContext.log as unknown as jest.Mock).mock.calls.flat().map(String).join('\n');
}

describe('MG-58: the storage heartbeat is the host-storage proof path', () => {
  it('logs the marker the runbook greps for, and nothing else happens', async () => {
    const invocationContext = context('inv-heartbeat-1');

    await expect(storageHeartbeatHandler(timer(), invocationContext)).resolves.toBeUndefined();

    const logged = loggedBy(invocationContext);
    expect(logged).toContain(STORAGE_HEARTBEAT_MARKER);
    expect(logged).toContain('invocation=inv-heartbeat-1');
    expect(logged).toContain('pastDue=false');
    // One line per invocation: this runs forever on every instance, against a
    // dev workspace with a hard 2 GB/day ingestion cap (MG-58 runbook).
    expect(invocationContext.log as unknown as jest.Mock).toHaveBeenCalledTimes(1);
    expect(invocationContext.error).not.toHaveBeenCalled();
  });

  it('reports the past-due flag, which is what a storage recovery looks like', async () => {
    const invocationContext = context();

    await storageHeartbeatHandler(timer({ isPastDue: true }), invocationContext);

    // The host marks an invocation past due when the schedule status it read
    // back from storage says the occurrence was missed — precisely the shape of
    // the first run after AzureWebJobsStorage starts authenticating again.
    expect(loggedBy(invocationContext)).toContain('pastDue=true');
  });

  it('re-emits the schedule status the host read back from storage, as timestamps', () => {
    const line = formatStorageHeartbeat(timer(), 'inv-schedule');

    expect(line).toContain('lastRun=2026-08-09T12:00:00.000Z');
    expect(line).toContain('nextRun=2026-08-09T12:15:00.000Z');
  });

  it('discards anything in the schedule status that is not a timestamp', () => {
    // scheduleStatus arrives from the host. The log line's vocabulary stays
    // fixed — a marker, an id, a boolean, timestamps — so host-supplied text
    // cannot ride into the log stream the way a dependency's error text can.
    const hostile = formatStorageHeartbeat(
      timer({
        scheduleStatus: {
          last: 'Bearer eyJ0eXAiOiJKV1Qi.leaked',
          next: 'https://mgv2devstorage.blob.core.windows.net/azure-webjobs-hosts',
          lastUpdated: 'X-IDENTITY-HEADER=1a2b3c4d',
        },
      } as Partial<Timer>),
      'inv-hostile'
    );

    expect(hostile).toContain('lastRun=unknown');
    expect(hostile).toContain('nextRun=unknown');
    for (const disclosure of [
      'eyJ0eXAiOiJKV1Qi',
      'mgv2devstorage',
      'blob.core.windows.net',
      'X-IDENTITY-HEADER',
      '1a2b3c4d',
    ]) {
      expect(hostile).not.toContain(disclosure);
    }
  });

  it('cannot fail an invocation on its own, whatever the host hands it', async () => {
    // A throw here would surface as a failed invocation and read as "host
    // storage is broken" — the one false conclusion this probe must never
    // produce. The negative signal is the ABSENCE of the invocation.
    const invocationContext = context();

    await expect(
      storageHeartbeatHandler(undefined as unknown as Timer, invocationContext)
    ).resolves.toBeUndefined();
    await expect(storageHeartbeatHandler({} as Timer, invocationContext)).resolves.toBeUndefined();

    expect(loggedBy(invocationContext)).toContain('lastRun=unknown');
    expect(invocationContext.error).not.toHaveBeenCalled();
  });

  it('fires every 15 minutes — a six-field NCRONTAB expression, seconds first', () => {
    expect(STORAGE_HEARTBEAT_SCHEDULE).toBe('0 */15 * * * *');
    expect(STORAGE_HEARTBEAT_SCHEDULE.split(' ')).toHaveLength(6);
  });

  describe('registration in main.ts', () => {
    beforeAll(() => {
      // No jest.resetModules() here on purpose: the registration must be
      // compared against the SAME handler instance this file imported, and a
      // fresh module registry would hand main.ts a second copy of the handler
      // that merely looks identical.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../main');
    });

    it('registers exactly one timer, pointing at this handler on this schedule', () => {
      // Exactly one: a second timer would be a second lease-holder in the host
      // storage account, and would make "the timer fired" ambiguous evidence.
      expect(Object.keys(timerRegistrations)).toEqual(['storageHeartbeat']);
      expect(timerRegistrations['storageHeartbeat']).toEqual({
        schedule: STORAGE_HEARTBEAT_SCHEDULE,
        handler: storageHeartbeatHandler,
      });
    });

    it('leaves the seven HTTP registrations in place', () => {
      expect(httpRegistrations).toEqual([
        'getCooks',
        'startCook',
        'stopCook',
        'negotiate',
        'getCurrentTemperatures',
        'getDevices',
        'cosmosHealth',
      ]);
    });
  });
});
