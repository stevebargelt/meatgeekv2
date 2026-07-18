import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

export interface ListCooksRequest {
  userId?: string;
  status?: 'planning' | 'active' | 'paused' | 'completed';
  limit?: number;
  offset?: number;
}

export interface Cook {
  id: string;
  userId: string;
  deviceId: string;
  name: string;
  status: 'planning' | 'active' | 'paused' | 'completed';
  startTime: string;
  endTime?: string;
  meatType?: string;
}

export interface CookListResponse {
  cooks: Cook[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export async function getCooksHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('Processing getCooks request');

  try {
    // Extract query parameters
    const userId = request.query.get('userId');
    const status = request.query.get('status') as ListCooksRequest['status'];
    const limit = parseInt(request.query.get('limit') || '20');
    const offset = parseInt(request.query.get('offset') || '0');

    // For now, return mock data
    const mockCooks: Cook[] = [
      {
        id: 'cook-1',
        userId: userId || 'user-1',
        deviceId: 'meatgeek3',
        name: 'Weekend Brisket',
        status: 'completed',
        startTime: '2025-08-25T06:00:00Z',
        endTime: '2025-08-25T20:00:00Z',
        meatType: 'brisket'
      },
      {
        id: 'cook-2',
        userId: userId || 'user-1',
        deviceId: 'meatgeek3',
        name: 'Sunday Ribs',
        status: 'active',
        startTime: '2025-08-26T10:00:00Z',
        meatType: 'pork'
      }
    ];

    // Filter by status if provided
    const filteredCooks = status 
      ? mockCooks.filter(cook => cook.status === status)
      : mockCooks;

    // Apply pagination
    const paginatedCooks = filteredCooks.slice(offset, offset + limit);

    const response: CookListResponse = {
      cooks: paginatedCooks,
      total: filteredCooks.length,
      offset,
      limit,
      hasMore: offset + paginatedCooks.length < filteredCooks.length
    };

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': context.invocationId
      },
      jsonBody: response
    };

  } catch (error) {
    context.error('Error in getCooks:', error);
    
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve cooks',
        requestId: context.invocationId
      }
    };
  }
}