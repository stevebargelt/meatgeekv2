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
 * Every error code the API emits. Matches the `ErrorCode` enum in
 * libs/api-specs/spec/components/schemas/common.yaml; the drift check in
 * apps/api/src/contract/contract.spec.ts fails when the two differ.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'DEVICE_NOT_FOUND',
  'DEVICE_NOT_OWNED',
  'DEVICE_CONFLICT',
  'CLAIM_REFUSED',
  'CONCURRENT_UPDATE',
  'COOK_ALREADY_ACTIVE',
  'COOK_NOT_ACTIVE',
  'COOK_ACTIVE',
  'COOK_ID_REUSED',
  'NO_READINGS',
  'USER_NOT_FOUND',
  'RECIPE_NOT_FOUND',
  'DEVICE_TWIN_UPDATE_FAILED',
  'SIGNALR_UNAVAILABLE',
  'INTERNAL_SERVER_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The error body the API returns, exactly as it is on the wire: flat, not
 * nested. `requestId` is the Functions invocation id. Variants that add fields
 * extend this interface; the 401 body is {@link UnauthenticatedError}.
 */
export interface ErrorResponse {
  error: ErrorCode;
  message: string;
  requestId: string;
}

/** 409 from POST /cooks: the device already has an active cook. */
export interface CookAlreadyActiveError extends ErrorResponse {
  error: 'COOK_ALREADY_ACTIVE';
  activeCookId: string;
}

/** 503 from POST /cooks and POST /cooks/{cookId}/stop: the cook was written,
 *  the device twin was not. `reason` is a fixed code. */
export interface DeviceTwinUpdateFailedError extends ErrorResponse {
  error: 'DEVICE_TWIN_UPDATE_FAILED';
  cookId: string;
  reason: string;
}

/** HAR-130: 503 from POST /devices/claim: a twin read or write failed before
 *  anything was stored. `reason` is a fixed code. */
export interface DeviceClaimTwinFailedError extends ErrorResponse {
  error: 'DEVICE_TWIN_UPDATE_FAILED';
  reason: string;
}

/** 503 from POST /negotiate. `reason` is a fixed code. */
export interface SignalRUnavailableError extends ErrorResponse {
  error: 'SIGNALR_UNAVAILABLE';
  reason: string;
}

/** Why a handler found no usable Easy Auth principal. */
export type UnauthenticatedReason =
  | 'principal_header_missing'
  | 'principal_header_unparseable'
  | 'principal_object_id_missing'
  | 'principal_tenant_id_missing';

/** 401 body a handler returns. It has `reason` in place of `message`. */
export interface UnauthenticatedError {
  error: 'UNAUTHENTICATED';
  reason: UnauthenticatedReason;
  requestId: string;
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