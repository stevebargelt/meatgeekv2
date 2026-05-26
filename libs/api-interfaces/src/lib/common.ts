/**
 * Standard API response wrapper
 */
export interface ApiResponse<T> {
  data: T;
  success: boolean;
  message?: string;
  errors?: string[];
  metadata?: {
    requestId: string;
    timestamp: string;
    version: string;
  };
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

/**
 * Standard error response
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
    timestamp: string;
  };
}

/**
 * API request with pagination
 */
export interface PaginatedRequest {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Date range filter
 */
export interface DateRangeFilter {
  startDate?: string;
  endDate?: string;
}

/**
 * Geographic location
 */
export interface Location {
  latitude: number;
  longitude: number;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  timezone?: string;
}

/**
 * File upload metadata
 */
export interface FileMetadata {
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
  uploadedBy: string;
  url?: string;
  thumbnailUrl?: string;
}

/**
 * Health check response
 */
export interface HealthCheck {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number; // seconds
  checks: {
    database: HealthStatus;
    iotHub: HealthStatus;
    signalR: HealthStatus;
    storage: HealthStatus;
  };
}

/**
 * Individual health status
 */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime?: number; // milliseconds
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * System metrics
 */
export interface SystemMetrics {
  timestamp: string;
  activeDevices: number;
  activeCooks: number;
  totalUsers: number;
  messagesPerSecond: number;
  averageResponseTime: number; // milliseconds
  errorRate: number; // percentage
  resourceUsage: {
    cpu: number; // percentage
    memory: number; // percentage
    storage: number; // percentage
  };
}

/**
 * WebSocket message types for real-time communication
 */
export type WebSocketMessageType = 
  | 'temperature_update'
  | 'cook_started'
  | 'cook_stopped' 
  | 'cook_paused'
  | 'cook_resumed'
  | 'device_online'
  | 'device_offline'
  | 'alert_triggered'
  | 'system_notification';

/**
 * WebSocket message structure
 */
export interface WebSocketMessage<T = unknown> {
  type: WebSocketMessageType;
  payload: T;
  timestamp: string;
  deviceId?: string;
  userId?: string;
  cookId?: string;
  messageId: string;
}