import { HttpRequest, InvocationContext } from '@azure/functions';
import { stopCookHandler, StopCookRequest } from './stop-cook';
import { Cook } from './start-cook';
import { signalROutput, SignalROutputMessage } from '../signalr/envelope';

type CookMessage = SignalROutputMessage<Cook>;

const INVOCATION_ID = 'inv-99';

function mockRequest(
  cookId: string,
  body: Partial<StopCookRequest>
): HttpRequest {
  return {
    json: async () => body,
    headers: { get: () => null },
    query: { get: () => null },
    params: { cookId },
  } as unknown as HttpRequest;
}

interface Captured {
  ctx: InvocationContext;
  messages: () => CookMessage[] | undefined;
}

function mockContext(): Captured {
  let captured: CookMessage[] | undefined;
  const ctx = {
    invocationId: INVOCATION_ID,
    log: () => undefined,
    error: () => undefined,
    extraOutputs: {
      set: (output: unknown, value: unknown) => {
        if (output === signalROutput) {
          captured = value as CookMessage[];
        }
      },
    },
  } as unknown as InvocationContext;
  return { ctx, messages: () => captured };
}

describe('stopCookHandler', () => {
  it('emits one cook_stopped message for the path cookId, scoped to the device', async () => {
    const { ctx, messages } = mockContext();
    const res = await stopCookHandler(
      mockRequest('cook-abc', { deviceId: 'meatgeek3' }),
      ctx
    );

    const msgs = messages();
    expect(msgs).toHaveLength(1);
    const [msg] = msgs!;
    expect(msg.target).toBe('cook_stopped');
    expect(msg.userId).toBe('meatgeek3');

    const envelope = msg.arguments[0];
    // cook_stopped carries NO top-level cookId (the Go consumer asserts nil on
    // stop); the stopped cook stays identifiable via payload.id.
    expect(envelope).not.toHaveProperty('cookId');
    expect(envelope.cookId).toBeUndefined();
    expect(envelope.payload.id).toBe('cook-abc');
    expect(envelope.payload.status).toBe('completed');

    // The (placeholder) payload must still be schema-VALID per the Cook schema
    // even though the cook is not persisted: name >= 3 chars, startTime a
    // parseable ISO-8601 date-time. See stop-cook.ts for why these are synthetic.
    expect(envelope.payload.name.length).toBeGreaterThanOrEqual(3);
    expect(Number.isNaN(Date.parse(envelope.payload.startTime))).toBe(false);

    expect(res.status).toBe(200);
  });

  it('returns 400 with no SignalR message when deviceId is missing', async () => {
    const { ctx, messages } = mockContext();
    const res = await stopCookHandler(mockRequest('cook-abc', {}), ctx);

    expect(res.status).toBe(400);
    expect(messages()).toBeUndefined();
  });
});
