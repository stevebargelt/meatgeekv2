/**
 * Temperature reading from a BBQ device
 */
export interface TemperatureReading {
  deviceId: string;
  timestamp: string; // ISO 8601 datetime
  cookId?: string;
  grillTemp?: number;
  probe1Temp?: number;
  probe2Temp?: number;
  probe3Temp?: number;
  probe4Temp?: number;
}

/**
 * Request for querying temperature history
 */
export interface TemperatureHistoryRequest {
  deviceId: string;
  cookId?: string;
  startTime?: string;
  endTime?: string;
  /** Page size, 1-1000. Default 100. */
  limit?: number;
  /** Opaque cursor from a previous page's {@link TemperatureHistoryResponse.continuationToken}. */
  continuationToken?: string;
}

/**
 * Response for temperature history queries.
 *
 * Paged by continuation token, not offset (HAR-75): an offset re-charges every
 * skipped reading and an exact `total` needs a separate COUNT query. To read
 * the next page, send `continuationToken` back unchanged; it is present exactly
 * when `hasMore` is true.
 */
export interface TemperatureHistoryResponse {
  readings: TemperatureReading[];
  /** The page size applied. */
  limit: number;
  hasMore: boolean;
  /** Opaque cursor for the next page; absent when `hasMore` is false. */
  continuationToken?: string;
}

/**
 * Real-time temperature data for SignalR
 */
export interface LiveTemperatureUpdate {
  deviceId: string;
  timestamp: string;
  cookId?: string;
  temperatures: {
    grill?: number;
    probe1?: number;
    probe2?: number;
    probe3?: number;
    probe4?: number;
  };
  alerts?: TemperatureAlert[];
}

/**
 * Temperature alert configuration
 */
export interface TemperatureAlert {
  id: string;
  type: 'high' | 'low' | 'target_reached';
  probe: 'grill' | 'probe1' | 'probe2' | 'probe3' | 'probe4';
  threshold: number;
  isActive: boolean;
  message: string;
}