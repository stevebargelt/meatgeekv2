import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  buildCookEnvelope,
  COOK_STOPPED,
  signalROutput,
  SignalROutputMessage,
} from '../signalr/envelope';
import { Cook } from './start-cook';

export interface StopCookRequest {
  deviceId: string;
}

export async function stopCookHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Processing stopCook request');

  try {
    const cookId = request.params['cookId'];
    const body = (await request.json()) as StopCookRequest;

    // Validate required fields. No SignalR message is emitted on a 400.
    if (!body.deviceId) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          error: 'VALIDATION_ERROR',
          message: 'Missing required field: deviceId',
          requestId: context.invocationId,
        },
      };
    }

    // Correlation id propagates from the inbound request when present, else the
    // Functions invocation id (matches start-cook).
    const correlationId = request.headers.get('X-Request-ID') ?? context.invocationId;

    const endTime = new Date().toISOString();

    // Complete the cook (still a mock — the durable write lands in a later
    // ticket). The envelope-level cook data is what the pusher consumes.
    //
    // PLACEHOLDER VALUES: there is no persisted cook to read back (start-cook is
    // a mock — DEC-3; the persist-or-minimize decision is tracked in the MG-14
    // follow-up ticket), so name/startTime/meatType cannot be the real values.
    // We emit schema-VALID synthetic placeholders instead of empty strings so
    // the payload conforms to the Cook schema (name minLength 3, startTime
    // date-time). The Go data-pusher consumer does NOT read name/startTime on
    // cook_stopped — it keys off payload.id — so synthetic values are safe:
    //   - name:      `Cook ${cookId}` (obviously synthetic, >= 3 chars)
    //   - startTime: reuse endTime (true start unknown; documented approximation)
    //   - meatType:  'unknown' (valid non-empty string; meatType is optional)
    const cook: Cook = {
      id: cookId,
      userId: 'user-1', // TODO: Extract from auth token
      deviceId: body.deviceId,
      name: `Cook ${cookId}`,
      status: 'completed',
      startTime: endTime,
      endTime,
      meatType: 'unknown',
    };

    context.log(`Stopped cook: ${cook.id} for device: ${body.deviceId}`);

    // Emit AFTER building the (mock) completed cook. userId scopes delivery to
    // the device's SignalR user group.
    const message: SignalROutputMessage = {
      target: COOK_STOPPED,
      userId: body.deviceId,
      arguments: [buildCookEnvelope(COOK_STOPPED, cook, correlationId)],
    };
    context.extraOutputs.set(signalROutput, [message]);

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': correlationId,
      },
      jsonBody: cook,
    };
  } catch (error) {
    context.error('Error in stopCook:', error);

    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to stop cook',
        requestId: context.invocationId,
      },
    };
  }
}
