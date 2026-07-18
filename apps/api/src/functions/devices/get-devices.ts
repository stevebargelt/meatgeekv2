import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

export interface Device {
  id: string;
  userId: string;
  name: string;
  model: string;
  location?: string;
  lastSeen?: string;
  isActive: boolean;
  configuration?: {
    grillProbeCorrection?: number;
    probe1Correction?: number;
    probe2Correction?: number;
    probe3Correction?: number;
    probe4Correction?: number;
  };
}

export async function getDevicesHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Processing getDevices request');

  try {
    const userId = request.query.get('userId') || request.headers.get('x-user-id');

    if (!userId) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          error: 'VALIDATION_ERROR',
          message: 'User ID is required',
          requestId: context.invocationId
        }
      };
    }

    // Mock device data
    const devices: Device[] = [
      {
        id: 'meatgeek3',
        userId,
        name: 'Backyard Smoker',
        model: 'MeatGeek V1',
        location: 'Austin, TX',
        lastSeen: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
        isActive: true,
        configuration: {
          grillProbeCorrection: -6.0,
          probe1Correction: -8.0,
          probe2Correction: 2.0,
          probe3Correction: -1.0,
          probe4Correction: -5.0
        }
      }
    ];

    context.log(`Retrieved ${devices.length} devices for user: ${userId}`);

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': context.invocationId
      },
      jsonBody: { devices }
    };

  } catch (error) {
    context.error('Error in getDevices:', error);
    
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve devices',
        requestId: context.invocationId
      }
    };
  }
}