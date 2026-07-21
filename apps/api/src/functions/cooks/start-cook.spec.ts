import { HttpRequest, InvocationContext } from '@azure/functions';
import { startCookHandler, StartCookRequest } from './start-cook';
import { signalROutput, SignalROutputMessage } from '../signalr/envelope';

const INVOCATION_ID = 'inv-42';

function mockRequest(
  body: Partial<StartCookRequest>,
  requestIdHeader?: string
): HttpRequest {
  const headers = new Map<string, string>();
  if (requestIdHeader !== undefined) {
    headers.set('X-Request-ID', requestIdHeader);
  }
  return {
    json: async () => body,
    headers: { get: (k: string) => headers.get(k) ?? null },
    query: { get: () => null },
    params: {},
  } as unknown as HttpRequest;
}

interface Captured {
  ctx: InvocationContext;
  messages: () => SignalROutputMessage[] | undefined;
}

function mockContext(): Captured {
  let captured: SignalROutputMessage[] | undefined;
  const ctx = {
    invocationId: INVOCATION_ID,
    log: () => undefined,
    error: () => undefined,
    extraOutputs: {
      set: (output: unknown, value: unknown) => {
        if (output === signalROutput) {
          captured = value as SignalROutputMessage[];
        }
      },
    },
  } as unknown as InvocationContext;
  return { ctx, messages: () => captured };
}

const validBody: StartCookRequest = {
  name: 'Weekend Brisket',
  deviceId: 'meatgeek3',
  meatType: 'brisket',
};

describe('startCookHandler', () => {
  it('emits exactly one cook_started SignalR message scoped to the device', async () => {
    const { ctx, messages } = mockContext();
    const res = await startCookHandler(mockRequest(validBody), ctx);

    const msgs = messages();
    expect(msgs).toHaveLength(1);
    const [msg] = msgs!;
    expect(msg.target).toBe('cook_started');
    expect(msg.userId).toBe(validBody.deviceId);

    const envelope = msg.arguments[0];
    expect(envelope.type).toBe('cook_started');
    expect(envelope.deviceId).toBe(validBody.deviceId);
    expect(envelope.cookId).toBe(envelope.payload.id);
    // No X-Request-ID header -> correlation falls back to the invocation id.
    expect(envelope.correlation.id).toBe(INVOCATION_ID);

    // The existing 201 contract is preserved.
    expect(res.status).toBe(201);
    expect((res.jsonBody as { id: string }).id).toBe(envelope.payload.id);
  });

  it('propagates the X-Request-ID header as the correlation id when present', async () => {
    const { ctx, messages } = mockContext();
    await startCookHandler(mockRequest(validBody, 'req-abc'), ctx);

    expect(messages()![0].arguments[0].correlation.id).toBe('req-abc');
  });

  it.each([
    ['name', { deviceId: 'meatgeek3', meatType: 'brisket' }],
    ['deviceId', { name: 'x', meatType: 'brisket' }],
    ['meatType', { name: 'x', deviceId: 'meatgeek3' }],
  ])('returns 400 with no SignalR message when %s is missing', async (_field, body) => {
    const { ctx, messages } = mockContext();
    const res = await startCookHandler(mockRequest(body), ctx);

    expect(res.status).toBe(400);
    expect(messages()).toBeUndefined();
  });

  it('returns 400 with no SignalR message when name is whitespace-only', async () => {
    const { ctx, messages } = mockContext();
    const res = await startCookHandler(
      mockRequest({ name: '   ', deviceId: 'meatgeek3', meatType: 'brisket' }),
      ctx
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toBe('VALIDATION_ERROR');
    expect(messages()).toBeUndefined();
  });

  it('stores the trimmed name in the 201 body when name has surrounding whitespace', async () => {
    const { ctx } = mockContext();
    const res = await startCookHandler(
      mockRequest({ name: '  Weekend Brisket  ', deviceId: 'meatgeek3', meatType: 'brisket' }),
      ctx
    );

    expect(res.status).toBe(201);
    expect((res.jsonBody as { name: string }).name).toBe('Weekend Brisket');
  });
});
