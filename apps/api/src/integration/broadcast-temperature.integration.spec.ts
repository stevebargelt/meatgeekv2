/**
 * HAR-60 — broadcastTemperature registration, through the REAL app wiring.
 *
 * main.ts's app.eventHub() registration is captured by mocking the Functions
 * `app` object while keeping the real `output` generic-binding builder, so
 * signalROutput keeps its real object identity (the runtime matches
 * context.extraOutputs.set() to a binding by identity). The registered handler
 * is then driven with a host-shaped batch to prove the function a real event
 * would hit emits on that binding. No Event Hub and no SignalR Service are
 * involved; the live delivery proof is a later issue (after HAR-59).
 */
import type { InvocationContext } from '@azure/functions';

import { broadcastTemperatureHandler } from '../functions/signalr/broadcast-temperature';
import {
  HUB_NAME,
  SIGNALR_CONNECTION_SETTING,
  signalROutput,
  SignalRGroupMessage,
} from '../functions/signalr/envelope';

interface EventHubRegistration {
  connection: string;
  eventHubName: string;
  consumerGroup?: string;
  cardinality?: 'many' | 'one';
  extraOutputs?: unknown[];
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

beforeAll(() => {
  // No jest.resetModules(): the registered handler must be the SAME instance
  // this file imported.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../main');
});

describe('broadcastTemperature registration (main.ts)', () => {
  it('is the only Event Hub trigger', () => {
    expect(Object.keys(mockEventHubRegistrations)).toEqual(['broadcastTemperature']);
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
    let captured: SignalRGroupMessage[] | undefined;
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
            captured = value as SignalRGroupMessage[];
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
        groupName: 'device-meatgeek3',
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
