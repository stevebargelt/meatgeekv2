import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

export interface TemperatureReading {
  deviceId: string;
  timestamp: string;
  cookId?: string;
  grillTemp?: number;
  probe1Temp?: number;
  probe2Temp?: number;
  probe3Temp?: number;
  probe4Temp?: number;
}

export async function getCurrentTemperaturesHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Processing getCurrentTemperatures request');

  try {
    const deviceId = request.params.deviceId;
    
    if (!deviceId) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          error: 'VALIDATION_ERROR',
          message: 'Device ID is required',
          requestId: context.invocationId
        }
      };
    }

    // Mock temperature data
    const currentReading: TemperatureReading = {
      deviceId,
      timestamp: new Date().toISOString(),
      cookId: 'cook-2', // Currently active cook
      grillTemp: 225.5,
      probe1Temp: 165.2,
      probe2Temp: 145.8,
      probe3Temp: null,
      probe4Temp: 200.1
    };

    context.log(`Retrieved temperature for device: ${deviceId}`);

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': context.invocationId
      },
      jsonBody: currentReading
    };

  } catch (error) {
    context.log.error('Error in getCurrentTemperatures:', error);
    
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve current temperatures',
        requestId: context.invocationId
      }
    };
  }
}