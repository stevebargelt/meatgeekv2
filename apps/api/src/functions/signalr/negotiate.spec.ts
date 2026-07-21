import { HttpRequest, InvocationContext } from '@azure/functions';
import { negotiateHandler, signalRConnInfoInput } from './negotiate';

const STUB_CONNECTION_INFO = {
  url: 'https://example.service.signalr.net/client/?hub=temperatureHub',
  accessToken: 'stub-access-token',
};

function mockRequest(deviceId?: string): HttpRequest {
  const query = new Map<string, string>();
  if (deviceId !== undefined) {
    query.set('deviceId', deviceId);
  }
  return {
    query: { get: (k: string) => query.get(k) ?? null },
    headers: { get: () => null },
  } as unknown as HttpRequest;
}

function mockContext(connectionInfo: unknown): InvocationContext {
  return {
    invocationId: 'inv-1',
    log: () => undefined,
    error: () => undefined,
    extraInputs: {
      get: (input: unknown) =>
        input === signalRConnInfoInput ? connectionInfo : undefined,
    },
  } as unknown as InvocationContext;
}

describe('negotiateHandler', () => {
  it('returns 200 with the SignalRConnectionInfo from the input binding', async () => {
    const res = await negotiateHandler(
      mockRequest('meatgeek3'),
      mockContext(STUB_CONNECTION_INFO)
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toBe(STUB_CONNECTION_INFO);
  });

  it('returns 400 when the deviceId query param is missing', async () => {
    const res = await negotiateHandler(
      mockRequest(undefined),
      mockContext(STUB_CONNECTION_INFO)
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toBe('VALIDATION_ERROR');
  });
});
