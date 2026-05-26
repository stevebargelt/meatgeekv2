import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

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
    
    // Validate required fields
    if (!body.name || !body.deviceId || !body.meatType) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          error: 'VALIDATION_ERROR',
          message: 'Missing required fields: name, deviceId, meatType',
          requestId: context.invocationId
        }
      };
    }

    // Create new cook (mock implementation)
    const newCook: Cook = {
      id: `cook-${Date.now()}`,
      userId: 'user-1', // TODO: Extract from auth token
      deviceId: body.deviceId,
      name: body.name,
      status: 'active',
      startTime: new Date().toISOString(),
      meatType: body.meatType,
      targetTemps: body.targetTemps,
      notes: body.notes
    };

    context.log(`Started cook: ${newCook.id} for device: ${body.deviceId}`);

    return {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': context.invocationId
      },
      jsonBody: newCook
    };

  } catch (error) {
    context.log.error('Error in startCook:', error);
    
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