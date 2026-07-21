import { extractCorrelation, getStandardDimensions } from './correlation';

const VALID_TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('extractCorrelation', () => {
  it('returns the correlation.id and traceparent from applicationProperties', () => {
    const result = extractCorrelation(
      {
        'correlation.id': 'corr-xyz',
        traceparent: VALID_TRACEPARENT,
      },
      'inv-1'
    );

    expect(result.correlationId).toBe('corr-xyz');
    expect(result.traceparent).toBe(VALID_TRACEPARENT);
  });

  it('falls back to the invocationId when correlation.id is missing', () => {
    const result = extractCorrelation({ traceparent: VALID_TRACEPARENT }, 'inv-42');

    expect(result.correlationId).toBe('inv-42');
    expect(result.traceparent).toBe(VALID_TRACEPARENT);
  });

  it('falls back to the invocationId when applicationProperties is undefined', () => {
    const result = extractCorrelation(undefined, 'inv-7');

    expect(result.correlationId).toBe('inv-7');
    expect(result.traceparent).toBeUndefined();
  });

  it('drops a malformed traceparent without throwing', () => {
    const result = extractCorrelation(
      { 'correlation.id': 'corr-xyz', traceparent: 'not-a-traceparent' },
      'inv-1'
    );

    expect(result.correlationId).toBe('corr-xyz');
    expect(result.traceparent).toBeUndefined();
  });

  it('drops a non-string traceparent without throwing', () => {
    const result = extractCorrelation(
      { 'correlation.id': 'corr-xyz', traceparent: 12345 },
      'inv-1'
    );

    expect(result.traceparent).toBeUndefined();
  });
});

describe('getStandardDimensions', () => {
  afterEach(() => {
    delete process.env['ENVIRONMENT'];
  });

  it('emits exactly the six standard keys with the extracted correlation values', () => {
    process.env['ENVIRONMENT'] = 'prod';
    const { correlationId } = extractCorrelation(
      { 'correlation.id': 'corr-xyz', traceparent: VALID_TRACEPARENT },
      'inv-1'
    );

    const dims = getStandardDimensions({
      deviceId: 'meatgeek3',
      correlationId,
      cookId: 'cook-abc-123',
      processingPath: 'realtime',
      component: 'function',
    });

    expect(Object.keys(dims).sort()).toEqual(
      [
        'component',
        'cook.id',
        'correlation.id',
        'device.id',
        'environment',
        'processing.path',
      ].sort()
    );
    expect(dims).toEqual({
      'device.id': 'meatgeek3',
      'cook.id': 'cook-abc-123',
      'correlation.id': 'corr-xyz',
      'processing.path': 'realtime',
      component: 'function',
      environment: 'prod',
    });
  });

  it('defaults cook.id to "none" and reads environment from ENVIRONMENT', () => {
    process.env['ENVIRONMENT'] = 'staging';

    const dims = getStandardDimensions({
      deviceId: 'meatgeek3',
      correlationId: 'corr-xyz',
    });

    expect(dims['cook.id']).toBe('none');
    expect(dims['environment']).toBe('staging');
    // Sensible receive-path defaults for the offline helper.
    expect(dims['processing.path']).toBe('realtime');
    expect(dims['component']).toBe('function');
  });

  it('defaults environment to "dev" when ENVIRONMENT is unset', () => {
    const dims = getStandardDimensions({
      deviceId: 'meatgeek3',
      correlationId: 'corr-xyz',
    });

    expect(dims['environment']).toBe('dev');
  });
});
