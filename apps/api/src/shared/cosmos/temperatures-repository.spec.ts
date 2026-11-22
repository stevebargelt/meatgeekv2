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
  InvalidContinuationTokenError,
  LATEST_READING_NOT_BEFORE_QUERY,
  LATEST_READING_QUERY,
  TemperaturesRepository,
  historyPageQuery,
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

  it('HAR-136: notBefore bounds the query itself, so TOP counts only documents at or after it', async () => {
    const fake = new FakeTemperaturesContainer();
    // One reading before the bound and one exactly at it (inclusive).
    fake.seed(routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T15:59:00.000Z' }));
    fake.seed(routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:00.000Z' }));

    const latest = await new TemperaturesRepository(fake.asContainer()).getLatestReading(DEVICE, {
      notBefore: '2026-08-14T16:00:00.000Z',
    });
    const before = await new TemperaturesRepository(fake.asContainer()).getLatestReading(DEVICE, {
      notBefore: '2026-08-14T16:00:00.001Z',
    });

    expect(latest).toMatchObject({
      status: 'found',
      reading: { timestamp: '2026-08-14T16:00:00.000Z' },
    });
    expect(before).toEqual({ status: 'none', requestCharge: TEMPERATURES_QUERY_CHARGE });
    expect(fake.queries[0].query).toBe(LATEST_READING_NOT_BEFORE_QUERY);
    expect(LATEST_READING_NOT_BEFORE_QUERY).toBe(
      'SELECT TOP 10 * FROM c WHERE c.deviceId = @deviceId ' +
        'AND c.SystemProperties["iothub-enqueuedtime"] >= @notBefore ' +
        'ORDER BY c.SystemProperties["iothub-enqueuedtime"] DESC'
    );
    expect(fake.queries[0].parameters).toEqual([
      { name: '@deviceId', value: DEVICE },
      { name: '@notBefore', value: '2026-08-14T16:00:00.000Z' },
    ]);
    expect(fake.queries[0].options['partitionKey']).toBe(DEVICE);
  });
});

describe('TemperaturesRepository history queries (HAR-35)', () => {
  const PREDICATE =
    'c.deviceId = @deviceId AND c.SystemProperties["iothub-connection-device-id"] = @deviceId ' +
    'AND IS_OBJECT(c.Body)';

  function seeded() {
    const fake = new FakeTemperaturesContainer();
    // Three valid readings, out of insertion order.
    fake.seed(routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:20.000Z' }));
    fake.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: '2026-08-14T16:00:00.000Z',
        body: { deviceId: 'spoofed', timestamp: 'not-a-date', cookId: 'cook-1', grillTemp: 200 },
      })
    );
    fake.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: '2026-08-14T16:00:10.000Z',
        body: { timestamp: '2026-08-14T16:00:09.500Z', cookId: 'cook-1', grillTemp: 210 },
      })
    );
    // Excluded by the predicate: a foreign hub identity, and a non-object Body.
    fake.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: '2026-08-14T16:00:05.000Z',
        systemDeviceId: 'intruder',
      })
    );
    fake.seed(
      routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:06.000Z', body: 'e30=' })
    );
    // Another partition.
    fake.seed(routedDocument({ deviceId: 'grill-2', enqueuedTime: '2026-08-14T16:00:01.000Z' }));
    return { fake, repository: new TemperaturesRepository(fake.asContainer()) };
  }

  it('the page query text, parameters and partitionKey, with every filter', async () => {
    const { fake, repository } = seeded();
    const filter = {
      deviceId: DEVICE,
      cookId: 'cook-1',
      startTime: '2026-08-14T16:00:00.000Z',
      endTime: '2026-08-14T17:00:00.000Z',
    };

    await repository.getReadingsPage(filter, {
      limit: 50,
      continuationToken: 'fake-history-token:1',
    });

    expect(fake.queries).toHaveLength(1);
    const [query] = fake.queries;
    const where =
      `${PREDICATE} AND c.Body.cookId = @cookId ` +
      'AND c.SystemProperties["iothub-enqueuedtime"] >= @startTime ' +
      'AND c.SystemProperties["iothub-enqueuedtime"] < @endTime';
    // HAR-75: no OFFSET and no LIMIT in the text; the page size and position
    // are the SDK's maxItemCount and continuation token.
    expect(query.query).toBe(
      `SELECT * FROM c WHERE ${where} ` + 'ORDER BY c.SystemProperties["iothub-enqueuedtime"] ASC'
    );
    expect(query.query).not.toMatch(/OFFSET|LIMIT|COUNT/);
    expect(query.parameters).toEqual([
      { name: '@deviceId', value: DEVICE },
      { name: '@cookId', value: 'cook-1' },
      { name: '@startTime', value: '2026-08-14T16:00:00.000Z' },
      { name: '@endTime', value: '2026-08-14T17:00:00.000Z' },
    ]);
    expect(query.options).toEqual({
      partitionKey: DEVICE,
      maxItemCount: 50,
      continuationToken: 'fake-history-token:1',
    });
    expect(historyPageQuery(filter).query).toBe(query.query);
  });

  it('pages by continuation token until the query is drained, one query a page', async () => {
    const { fake, repository } = seeded();

    const first = await repository.getReadingsPage({ deviceId: DEVICE }, { limit: 2 });
    expect(first.readings.map(reading => reading.grillTemp)).toEqual([200, 210]);
    expect(first.continuationToken).toEqual(expect.any(String));

    const second = await repository.getReadingsPage(
      { deviceId: DEVICE },
      { limit: 2, continuationToken: first.continuationToken }
    );
    expect(second.readings.map(reading => reading.grillTemp)).toEqual([225]);
    expect(second.continuationToken).toBeUndefined();
    expect(second.requestCharge).toBe(TEMPERATURES_QUERY_CHARGE);

    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[0].options['continuationToken']).toBeUndefined();
    expect(fake.queries[1].options['continuationToken']).toBe(first.continuationToken);
  });

  it('turns a token Cosmos refuses (400) into InvalidContinuationTokenError with its charge', async () => {
    const { repository } = seeded();

    const refused = repository.getReadingsPage(
      { deviceId: DEVICE },
      { limit: 2, continuationToken: 'garbled' }
    );

    await expect(refused).rejects.toBeInstanceOf(InvalidContinuationTokenError);
    await expect(refused).rejects.toMatchObject({ requestCharge: TEMPERATURES_QUERY_CHARGE });
    await expect(refused).rejects.not.toHaveProperty('message', expect.stringContaining('https'));
  });

  it('turns a client-side token parse failure (no status, no string code) into InvalidContinuationTokenError', async () => {
    const container = {
      items: {
        query: () => ({
          fetchNext: async () => {
            throw new SyntaxError('Unexpected token g in JSON at position 0');
          },
        }),
      },
    };
    const repository = new TemperaturesRepository(container as never);

    await expect(
      repository.getReadingsPage({ deviceId: DEVICE }, { limit: 2, continuationToken: 'g' })
    ).rejects.toBeInstanceOf(InvalidContinuationTokenError);
  });

  it('lets a network failure on a tokened page (string code, no status) propagate, not InvalidContinuationTokenError', async () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'TimeoutError']) {
      const fake = new FakeTemperaturesContainer();
      const repository = new TemperaturesRepository(fake.asContainer());
      fake.failNext(code);
      const failed = await repository
        .getReadingsPage(
          { deviceId: DEVICE },
          { limit: 1, continuationToken: 'fake-history-token:0' }
        )
        .catch((error: unknown) => error);
      expect(failed).not.toBeInstanceOf(InvalidContinuationTokenError);
      expect(failed).toMatchObject({ code });
    }
  });

  it('lets a 400 without a token, and a non-400 with one, propagate as they are', async () => {
    const fake = new FakeTemperaturesContainer();
    const repository = new TemperaturesRepository(fake.asContainer());
    fake.failNext(400);
    await expect(
      repository.getReadingsPage({ deviceId: DEVICE }, { limit: 1 })
    ).rejects.toMatchObject({ statusCode: 400 });
    fake.failNext(503);
    await expect(
      repository.getReadingsPage(
        { deviceId: DEVICE },
        { limit: 1, continuationToken: 'fake-history-token:0' }
      )
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('pages oldest enqueued time first, mapped, ignoring Body.deviceId, with no _ key', async () => {
    const { repository } = seeded();

    const page = await repository.getReadingsPage({ deviceId: DEVICE }, { limit: 100 });

    expect(page).toEqual({
      readings: [
        // Body.timestamp does not parse: the enqueued time stands in.
        {
          deviceId: DEVICE,
          timestamp: '2026-08-14T16:00:00.000Z',
          cookId: 'cook-1',
          grillTemp: 200,
        },
        {
          deviceId: DEVICE,
          timestamp: '2026-08-14T16:00:09.500Z',
          cookId: 'cook-1',
          grillTemp: 210,
        },
        { deviceId: DEVICE, timestamp: '2026-08-14T16:00:20.000Z', grillTemp: 225 },
      ],
      requestCharge: TEMPERATURES_QUERY_CHARGE,
    });
    for (const reading of page.readings) {
      expect(Object.keys(reading).filter(key => key.startsWith('_'))).toEqual([]);
    }
    expect(JSON.stringify(page)).not.toContain('spoofed');
    expect(JSON.stringify(page)).not.toContain('intruder');
  });

  it('excludes a foreign SystemProperties device id, a non-object Body and other partitions', async () => {
    const { repository } = seeded();

    const all = await repository.getReadingsPage({ deviceId: DEVICE }, { limit: 100 });
    expect(all.readings).toHaveLength(3);
    const tagged = await repository.getReadingsPage(
      { deviceId: DEVICE, cookId: 'cook-1' },
      { limit: 100 }
    );
    expect(tagged.readings).toHaveLength(2);
    expect(
      (await repository.getReadingsPage({ deviceId: 'nobody' }, { limit: 100 })).readings
    ).toEqual([]);
  });

  it('drops a document that still maps to null from the page', async () => {
    const fake = new FakeTemperaturesContainer();
    // Passes the predicate, but has no usable timestamp anywhere.
    fake.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: 'not-a-date',
        body: { timestamp: 'also-not-a-date', grillTemp: 1 },
      })
    );
    fake.seed(routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:00.000Z' }));
    const repository = new TemperaturesRepository(fake.asContainer());

    const page = await repository.getReadingsPage({ deviceId: DEVICE }, { limit: 100 });
    expect(page.readings).toEqual([
      { deviceId: DEVICE, timestamp: '2026-08-14T16:00:00.000Z', grillTemp: 225 },
    ]);
  });

  it('lets a Cosmos failure propagate from the page query', async () => {
    const fake = new FakeTemperaturesContainer();
    const repository = new TemperaturesRepository(fake.asContainer());
    fake.failNext(429);
    await expect(
      repository.getReadingsPage({ deviceId: DEVICE }, { limit: 1 })
    ).rejects.toMatchObject({
      statusCode: 429,
    });
  });
});
