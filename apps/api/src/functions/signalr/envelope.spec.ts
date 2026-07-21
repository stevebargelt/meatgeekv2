import {
  buildCookEnvelope,
  COOK_STARTED,
  COOK_STOPPED,
  CookRef,
} from './envelope';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cook: CookRef & { status: string } = {
  id: 'cook-123',
  deviceId: 'meatgeek3',
  userId: 'user-1',
  status: 'active',
};

describe('buildCookEnvelope', () => {
  it('stamps type, a UUID messageId, an ISO timestamp, and the cook ids', () => {
    const envelope = buildCookEnvelope(COOK_STARTED, cook, 'corr-1');

    expect(envelope.type).toBe(COOK_STARTED);
    expect(envelope.messageId).toMatch(UUID_RE);
    // ISO-8601 round-trips exactly through Date.
    expect(new Date(envelope.timestamp).toISOString()).toBe(envelope.timestamp);
    expect(envelope.deviceId).toBe('meatgeek3');
    expect(envelope.userId).toBe('user-1');
  });

  it('on cook_started sets BOTH envelope.cookId and payload.id to cook.id', () => {
    const envelope = buildCookEnvelope(COOK_STARTED, cook, 'corr-1');

    expect(envelope.cookId).toBe('cook-123');
    expect(envelope.payload.id).toBe('cook-123');
    expect(envelope.cookId).toBe(envelope.payload.id);
  });

  // The Go consumer's wire type is `CookID *string json:"cookId,omitempty"` and
  // it asserts nil on cook_stopped. The top-level cookId is the currently-active
  // cook id, which no longer exists after a stop; the stopped cook stays
  // identifiable via payload.id. The key must be OMITTED, not undefined-valued.
  it('on cook_stopped OMITS envelope.cookId but keeps payload.id', () => {
    const envelope = buildCookEnvelope(COOK_STOPPED, cook, 'corr-1');

    expect(envelope).not.toHaveProperty('cookId');
    expect(envelope.cookId).toBeUndefined();
    expect(envelope.payload.id).toBe('cook-123');
  });

  it('carries the passed correlation id and the full payload cook', () => {
    const envelope = buildCookEnvelope(COOK_STOPPED, cook, 'corr-xyz');

    expect(envelope.correlation.id).toBe('corr-xyz');
    expect(envelope.payload).toBe(cook);
    expect(envelope.payload.status).toBe('active');
  });

  it('generates a fresh messageId per call', () => {
    const a = buildCookEnvelope(COOK_STARTED, cook, 'c');
    const b = buildCookEnvelope(COOK_STARTED, cook, 'c');
    expect(a.messageId).not.toBe(b.messageId);
  });

  // These strings are the wire contract with the Go data-pusher consumer
  // (apps/data-pusher/internal/signalr/events.go). If either assertion fails,
  // the producer and consumer have drifted and cook events will be dropped.
  it('uses event-name strings that match the Go consumer EventType values', () => {
    expect(COOK_STARTED).toBe('cook_started');
    expect(COOK_STOPPED).toBe('cook_stopped');
  });
});
