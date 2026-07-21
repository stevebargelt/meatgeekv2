import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import {
  buildCookEnvelope,
  COOK_STARTED,
  signalROutput,
  SignalROutputMessage,
} from '../signalr/envelope';

export interface StartCookRequest {
  name: string;
  deviceId: string;
  meatType: string;
  targetTemps?: {
    grill?: number;
    probe1?: number;
    probe2?: number;
    probe3?: number;
    probe4?: number;
  };
  notes?: string;
}

export interface Cook {
  id: string;
  userId: string;
  deviceId: string;
  name: string;
  status: 'planning' | 'active' | 'paused' | 'completed';
  startTime: string;
  endTime?: string;
  meatType: string;
  targetTemps?: {
    grill?: number;
    probe1?: number;
    probe2?: number;
    probe3?: number;
    probe4?: number;
  };
  notes?: string;
}

export async function startCookHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Processing startCook request');

  try {
    // Parse request body
    const body = await request.json() as StartCookRequest;
    
    // Validate required fields. name must be non-empty after trimming so a
    // whitespace-only name never mints a Cook.
    if (!body.name || body.name.trim().length === 0 || !body.deviceId || !body.meatType) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          error: 'VALIDATION_ERROR',
          message: 'Missing required fields: name (non-empty), deviceId, meatType',
          requestId: context.invocationId
        }
      };
    }

    // Create new cook (mock implementation)
    const newCook: Cook = {
      id: `cook-${Date.now()}`,
      userId: 'user-1', // TODO: Extract from auth token
      deviceId: body.deviceId,
      name: body.name.trim(),
      status: 'active',
      startTime: new Date().toISOString(),
      meatType: body.meatType,
      targetTemps: body.targetTemps,
      notes: body.notes
    };

    context.log(`Started cook: ${newCook.id} for device: ${body.deviceId}`);

    // Correlation id propagates from the inbound request when present, else the
    // Functions invocation id. Emit AFTER the cook is minted; userId scopes
    // delivery to the device's SignalR user group.
    const correlationId = request.headers.get('X-Request-ID') ?? context.invocationId;
    const message: SignalROutputMessage = {
      target: COOK_STARTED,
      userId: body.deviceId,
      arguments: [buildCookEnvelope(COOK_STARTED, newCook, correlationId)],
    };
    context.extraOutputs.set(signalROutput, [message]);

    return {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': context.invocationId
      },
      jsonBody: newCook
    };

  } catch (error) {
    context.error('Error in startCook:', error);
    
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to start cook',
        requestId: context.invocationId
      }
    };
  }
}