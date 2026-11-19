/**
 * HAR-28 (MG-79 part 1) — the IoT Hub document → TemperatureReading projection
 * and the newest-reading query, with NO Azure and NO credentials.
 */
import {
  FakeTemperaturesContainer,
  TEMPERATURES_QUERY_CHARGE,
  routedDocument,
} from './fake-temperatures-container.testing';
import {
  LATEST_READING_QUERY,
  TemperaturesRepository,
  toTemperatureReading,
} from './temperatures-repository';

const DEVICE = 'grill-1';
const ENQUEUED = '2026-08-14T16:04:49.639Z';

/** The MG-73 evidence document's shape, with the top-level deviceId stamped. */
function envelope(overrides: { Body?: unknown; SystemProperties?: unknown } = {}) {
  return {
    id: '456b9c75-f0fb-4dfc-bced-fdec0d67731a',
    deviceId: DEVICE,
    iothub_name: 'meatgeek-v2-dev-iothub-259d4bf5b628',
    Body:
      'Body' in overrides
        ? overrides.Body
        : {
            deviceId: DEVICE,
            timestamp: '2026-08-14T16:04:46.049Z',
            cookId: 'cook-42',
            grillTemp: 251.5,
            probe1Temp: 160,
            probe2Temp: 140.25,
            probe3Temp: 0,
            probe4Temp: -3,
          },
    Properties: { anything: 'device-set' },
    SystemProperties:
      'SystemProperties' in overrides
        ? overrides.SystemProperties
        : {
            'message-id': 'm-1',
            'iothub-connection-device-id': DEVICE,
            'iothub-connection-auth-generation-id': '639223201741688239',
            'iothub-enqueuedtime': ENQUEUED,
            'iothub-message-source': 'Telemetry',
          },
    _rid: 'rid',
    _self: 'self',
    _etag: '"etag"',
    _attachments: 'attachments/',
    _ts: 1786723490,
  };
}

function systemWith(overrides: Record<string, unknown>) {
  const base = envelope().SystemProperties as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries({ ...base, ...overrides }).filter(([, value]) => value !== undefined)
  );
}

describe('toTemperatureReading', () => {
  it('maps a routed IoT Hub document onto a TemperatureReading', () => {
    expect(toTemperatureReading(envelope(), DEVICE)).toEqual({
      deviceId: DEVICE,
      timestamp: '2026-08-14T16:04:46.049Z',
      cookId: 'cook-42',
      grillTemp: 251.5,
      probe1Temp: 160,
      probe2Temp: 140.25,
      probe3Temp: 0,
      probe4Temp: -3,
    });
  });

  it('takes identity from SystemProperties, never Body.deviceId', () => {
    const document = envelope({
      Body: { deviceId: 'someone-elses-grill', timestamp: ENQUEUED, grillTemp: 200 },
    });

    const reading = toTemperatureReading(document, DEVICE);

    expect(reading?.deviceId).toBe(DEVICE);
    expect(JSON.stringify(reading)).not.toContain('someone-elses-grill');
  });

  it('is null when the SystemProperties id differs from the partition device', () => {
    const document = envelope({
      SystemProperties: systemWith({ 'iothub-connection-device-id': 'grill-2' }),
    });
    expect(toTemperatureReading(document, DEVICE)).toBeNull();
  });

  it('is null when the SystemProperties id is missing, empty, or not a string', () => {
    for (const id of [undefined, '', 42, null]) {
      const document = envelope({
        SystemProperties: systemWith({ 'iothub-connection-device-id': id }),
      });
      expect(toTemperatureReading(document, DEVICE)).toBeNull();
    }
    expect(toTemperatureReading(envelope({ SystemProperties: undefined }), DEVICE)).toBeNull();
    expect(toTemperatureReading(envelope({ SystemProperties: 'x' }), DEVICE)).toBeNull();
  });

  it('is null when Body is not a JSON object', () => {
    // IoT Hub stores a non-JSON payload as a base64 string.
    for (const body of ['eyJncmlsbFRlbXAiOjIyNX0=', 225, null, [{ grillTemp: 225 }], undefined]) {
      expect(toTemperatureReading(envelope({ Body: body }), DEVICE)).toBeNull();
    }
  });

  it('is null for a document that is not an object', () => {
    for (const document of [null, undefined, 'doc', 7, []]) {
      expect(toTemperatureReading(document, DEVICE)).toBeNull();
    }
  });

  it('falls back to iothub-enqueuedtime when Body.timestamp is missing or not a date', () => {
    for (const timestamp of [undefined, 'not a date', '', 1786723489, null]) {
      const reading = toTemperatureReading(
        envelope({ Body: { timestamp, grillTemp: 225 } }),
        DEVICE
      );
      expect(reading?.timestamp).toBe(ENQUEUED);
    }
  });

  it('is null when neither Body.timestamp nor iothub-enqueuedtime is a date', () => {
    const document = envelope({
      Body: { grillTemp: 225 },
      SystemProperties: systemWith({ 'iothub-enqueuedtime': undefined }),
    });
    expect(toTemperatureReading(document, DEVICE)).toBeNull();
  });

  it('omits non-numeric and non-finite temperatures', () => {
    const reading = toTemperatureReading(
      envelope({
        Body: {
          timestamp: ENQUEUED,
          grillTemp: '225',
          probe1Temp: null,
          probe2Temp: Number.NaN,
          probe3Temp: Number.POSITIVE_INFINITY,
          probe4Temp: 180.5,
        },
      }),
      DEVICE
    );
    expect(reading).toEqual({ deviceId: DEVICE, timestamp: ENQUEUED, probe4Temp: 180.5 });
  });

  it('keeps cookId only when it is a non-empty string', () => {
    for (const cookId of ['', 12, null, undefined]) {
      const reading = toTemperatureReading(
        envelope({ Body: { timestamp: ENQUEUED, cookId } }),
        DEVICE
      );
      expect(reading).toEqual({ deviceId: DEVICE, timestamp: ENQUEUED });
    }
  });

  it('carries no _ key, SystemProperties, Properties, iothub_name, id, or unmodelled Body field', () => {
    const reading = toTemperatureReading(
      envelope({
        Body: {
          deviceId: DEVICE,
          timestamp: ENQUEUED,
          grillTemp: 225,
          syntheticFixture: 'MG-67',
          _secret: 'x',
          SystemProperties: { forged: true },
        },
      }),
      DEVICE
    );
    expect(Object.keys(reading ?? {}).sort()).toEqual(['deviceId', 'grillTemp', 'timestamp']);
    for (const key of ['SystemProperties', 'Properties', 'iothub_name', 'id', 'Body']) {
      expect(reading).not.toHaveProperty(key);
    }
    expect(Object.keys(reading ?? {}).filter(key => key.startsWith('_'))).toEqual([]);
  });
});

describe('TemperaturesRepository.getLatestReading', () => {
  it('runs one single-partition query, newest enqueued time first', async () => {
    const fake = new FakeTemperaturesContainer();
    fake.seed(routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:00.000Z' }));

    await new TemperaturesRepository(fake.asContainer()).getLatestReading(DEVICE);

    expect(fake.queries).toHaveLength(1);
    const [query] = fake.queries;
    expect(query.query).toBe(LATEST_READING_QUERY);
    expect(query.query).toBe(
      'SELECT TOP 10 * FROM c WHERE c.deviceId = @deviceId ' +
        'ORDER BY c.SystemProperties["iothub-enqueuedtime"] DESC'
    );
    expect(query.parameters).toEqual([{ name: '@deviceId', value: DEVICE }]);
    expect(query.options['partitionKey']).toBe(DEVICE);
    expect(query.options).not.toHaveProperty('enableCrossPartitionQuery');
  });

  it('returns the newest document that maps, skipping ones that do not', async () => {
    const fake = new FakeTemperaturesContainer();
    fake.seed(routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:00.000Z' }));
    fake.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: '2026-08-14T16:00:05.000Z',
        body: { timestamp: '2026-08-14T16:00:04.900Z', grillTemp: 230 },
      })
    );
    fake.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: '2026-08-14T16:00:09.000Z',
        systemDeviceId: 'intruder',
      })
    );
    fake.seed(
      routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:10.000Z', body: 'e30=' })
    );
    fake.seed(routedDocument({ deviceId: 'grill-2', enqueuedTime: '2026-08-14T17:00:00.000Z' }));

    const latest = await new TemperaturesRepository(fake.asContainer()).getLatestReading(DEVICE);

    expect(latest).toEqual({
      status: 'found',
      reading: { deviceId: DEVICE, timestamp: '2026-08-14T16:00:04.900Z', grillTemp: 230 },
      requestCharge: TEMPERATURES_QUERY_CHARGE,
    });
  });

  it('is none, with the request charge, when no document maps', async () => {
    const fake = new FakeTemperaturesContainer();
    fake.seed(
      routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:10.000Z', body: 'e30=' })
    );

    const latest = await new TemperaturesRepository(fake.asContainer()).getLatestReading(DEVICE);

    expect(latest).toEqual({ status: 'none', requestCharge: TEMPERATURES_QUERY_CHARGE });
  });

  it('lets a Cosmos failure propagate to the caller', async () => {
    const fake = new FakeTemperaturesContainer();
    fake.failNext(503);
    await expect(
      new TemperaturesRepository(fake.asContainer()).getLatestReading(DEVICE)
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
