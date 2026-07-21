import { HttpRequest, HttpResponseInit, InvocationContext, input } from '@azure/functions';
import { HUB_NAME, SIGNALR_CONNECTION_SETTING } from './envelope';

// SignalR connection-info INPUT binding. The Functions runtime resolves this to
// a SignalRConnectionInfo ({ url, accessToken }) that the client uses to open
// its WebSocket. `userId` is bound to the request `deviceId` query param so the
// negotiated connection is placed in that device's user group — this is what
// makes per-device fan-out work (see DEC-4 / MG-30 in main.ts).
export const signalRConnInfoInput = input.generic({
  type: 'signalRConnectionInfo',
  name: 'connectionInfo',
  hubName: HUB_NAME,
  connectionStringSetting: SIGNALR_CONNECTION_SETTING,
  userId: '{query.deviceId}',
});

export async function negotiateHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Processing SignalR negotiate request');

  const deviceId = request.query.get('deviceId');
  if (!deviceId) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: {
        error: 'VALIDATION_ERROR',
        message: 'Missing required query parameter: deviceId',
        requestId: context.invocationId,
      },
    };
  }

  // The runtime populated this from the signalRConnectionInfo input binding.
  const connectionInfo = context.extraInputs.get(signalRConnInfoInput);

  return {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': context.invocationId,
    },
    jsonBody: connectionInfo,
  };
}
