/**
 * HAR-60 — broadcastTemperature registration, through the REAL app wiring.
 *
 * main.ts's app.eventHub() registration is captured by mocking the Functions
 * `app` object while keeping the real `output` generic-binding builder, so
 * signalROutput keeps its real object identity (the runtime matches
 * context.extraOutputs.set() to a binding by identity). The registered handler
 * is then driven with a host-shaped batch to prove the function a real event
 * would hit emits on that binding. No Event Hub and no SignalR Service are
 * involved; the live delivery proof is a later issue (after HAR-59). The
 * devices repository is replaced so the production owner lookup (HAR-81)
 * answers without Cosmos.
 */
import type { InvocationContext } from '@azure/functions';

import { recordTargetsReachedHandler } from '../functions/cooks/record-targets-reached';
import { broadcastTemperatureHandler } from '../functions/signalr/broadcast-temperature';
import {
  HUB_NAME,
  SIGNALR_CONNECTION_SETTING,
  signalROutput,
  SignalRTemperatureMessage,
} from '../functions/signalr/envelope';

interface EventHubRegistration {
  connection: string;
  eventHubName: string;
  consumerGroup?: string;
  cardinality?: 'many' | 'one';
  extraOutputs?: unknown[];
  retry?: { strategy: string };
  handler: (messages: unknown, context: InvocationContext) => Promise<unknown>;
}

const mockEventHubRegistrations: Record<string, EventHubRegistration> = {};

jest.mock('@azure/functions', () => {
  const actual = jest.requireActual('@azure/functions');
  return {
    ...actual,
    app: {
      eventHub: (name: string, config: EventHubRegistration) => {
        mockEventHubRegistrations[name] = config;
      },
      // HTTP and timer registrations are asserted in their own suites
      // (cook-events, cosmos-health-registration, storage-heartbeat).
      http: () => undefined,
      timer: () => undefined,
      cosmosDB: () => undefined,
    },
  };
});

const MOCK_OWNER = 'tid-1:oid-owner';

jest.mock('../shared/cosmos/devices-repository', () => {
  const actual = jest.requireActual('../shared/cosmos/devices-repository');
  return {
    ...actual,
    getDevicesRepository: () => ({
      getDeviceOwner: async (deviceId: string) => ({
        userId: deviceId === 'meatgeek3' ? MOCK_OWNER : undefined,
        requestCharge: 1,
      }),
    }),
  };
});

beforeAll(() => {
  // No jest.resetModules(): the registered handler must be the SAME instance
  // this file imported.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../main');
});

describe('broadcastTemperature registration (main.ts)', () => {
  it('shares the temperature-data event hub with the target rule only', () => {
    expect(Object.keys(mockEventHubRegistrations).sort()).toEqual([
      'broadcastTemperature',
      'recordTargetsReached',
    ]);
  });

  it('runs the target rule beside the push, never inside it: its own consumer group, no SignalR output, host retries', () => {
    const push = mockEventHubRegistrations['broadcastTemperature'];
    const rule = mockEventHubRegistrations['recordTargetsReached'];
    expect(rule.eventHubName).toBe(push.eventHubName);
    expect(rule.connection).toBe(push.connection);
    expect(rule.consumerGroup).toBe('%TARGETS_CONSUMER_GROUP%');
    expect(rule.consumerGroup).not.toBe(push.consumerGroup);
    expect(rule.cardinality).toBe('many');
    expect(rule.extraOutputs ?? []).toEqual([]);
    expect(rule.handler).toBe(recordTargetsReachedHandler);
    // A batch whose write failed is run again; the push never is.
    expect(rule.retry).toMatchObject({ strategy: 'exponentialBackoff' });
    expect(push.retry).toBeUndefined();
  });

  it('reads temperature-data on the API consumer group, identity-based, in batches', () => {
    const reg = mockEventHubRegistrations['broadcastTemperature'];
    expect(reg.connection).toBe('IOTHUB_EVENTS');
    expect(reg.eventHubName).toBe('temperature-data');
    expect(reg.consumerGroup).toBe('%TEMPERATURE_BROADCAST_CONSUMER_GROUP%');
    expect(reg.cardinality).toBe('many');
    expect(reg.handler).toBe(broadcastTemperatureHandler);
  });

  it('outputs through the existing SignalR binding on temperatureHub', () => {
    const reg = mockEventHubRegistrations['broadcastTemperature'];
    expect(reg.extraOutputs).toHaveLength(1);
    expect(reg.extraOutputs?.[0]).toBe(signalROutput);
    expect(signalROutput).toMatchObject({
      type: 'signalR',
      hubName: 'temperatureHub',
      connectionStringSetting: SIGNALR_CONNECTION_SETTING,
    });
    expect(HUB_NAME).toBe('temperatureHub');
  });

  it('the registered handler emits a host-shaped batch on that binding', async () => {
    let captured: SignalRTemperatureMessage[] | undefined;
    const ctx = {
      invocationId: 'broadcast-integration',
      triggerMetadata: {
        systemPropertiesArray: [
          {
            'iothub-connection-device-id': 'meatgeek3',
            'iothub-enqueuedtime': '2026-11-19T10:00:00.000Z',
          },
        ],
        enqueuedTimeUtcArray: ['2026-11-19T10:00:00.250Z'],
      },
      log: () => undefined,
      extraOutputs: {
        set: (output: unknown, value: unknown) => {
          if (output === signalROutput) {
            captured = value as SignalRTemperatureMessage[];
          }
        },
      },
    } as unknown as InvocationContext;

    await mockEventHubRegistrations['broadcastTemperature'].handler(
      [{ deviceId: 'not-this-one', timestamp: '2026-11-19T09:59:59.900Z', grillTemp: 225 }],
      ctx
    );

    // JSON round-trip: what the binding would put on the wire.
    expect(JSON.parse(JSON.stringify(captured))).toEqual([
      {
        target: 'temperature',
        userId: MOCK_OWNER,
        arguments: [
          {
            deviceId: 'meatgeek3',
            timestamp: '2026-11-19T09:59:59.900Z',
            grillTemp: 225,
            enqueuedTimeUtc: '2026-11-19T10:00:00.250Z',
          },
        ],
      },
    ]);
  });
});
