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
  limit?: number;
  offset?: number;
}

/**
 * Response for temperature history queries
 */
export interface TemperatureHistoryResponse {
  readings: TemperatureReading[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
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