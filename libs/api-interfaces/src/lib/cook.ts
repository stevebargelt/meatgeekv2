/**
 * Cook session status
 */
export type CookStatus = 'planning' | 'active' | 'paused' | 'completed' | 'cancelled';

/**
 * Target temperatures for different probes
 */
export interface TargetTemperatures {
  grill?: number;
  probe1?: number;
  probe2?: number;
  probe3?: number;
  probe4?: number;
}

/**
 * Cook session data
 */
export interface Cook {
  id: string;
  userId: string;
  deviceId: string;
  name: string;
  status: CookStatus;
  startTime: string;
  endTime?: string;
  meatType?: string;
  weight?: number;
  targetTemps?: TargetTemperatures;
  actualDuration?: number; // hours
  maxTemps?: TargetTemperatures;
  notes?: string;
  photos?: string[];
  rating?: number; // 1-5 stars
  isPublic?: boolean;
}

/**
 * Request to start a new cook session
 */
export interface StartCookRequest {
  name: string;
  deviceId: string;
  meatType: string;
  weight?: number;
  targetTemps?: TargetTemperatures;
  notes?: string;
}

/**
 * Request to update a cook session
 */
export interface UpdateCookRequest {
  name?: string;
  status?: CookStatus;
  targetTemps?: TargetTemperatures;
  notes?: string;
  rating?: number;
  endTime?: string;
}

/**
 * Request for listing cooks
 */
export interface ListCooksRequest {
  userId?: string;
  status?: CookStatus;
  meatType?: string;
  sortBy?: 'startTime' | 'duration' | 'rating';
  sortOrder?: 'asc' | 'desc';
  /** Page size. The API clamps it to its own maximum. */
  limit?: number;
  /** Opaque cursor from a previous page's {@link CookListResponse.continuationToken}. */
  continuationToken?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Response for cook listing.
 *
 * Pagination is by continuation token, not offset: cooks are listed as a
 * single-partition Cosmos query, where an offset re-charges every skipped
 * document and an exact `total` needs a separate COUNT query. To read the next
 * page, send `continuationToken` back unchanged; it is present exactly when
 * `hasMore` is true.
 */
export interface CookListResponse {
  cooks: Cook[];
  /** The page size actually applied (after the API's clamp). */
  limit: number;
  hasMore: boolean;
  /** Opaque cursor for the next page; absent when `hasMore` is false. */
  continuationToken?: string;
}

/**
 * Cook summary statistics
 */
export interface CookSummary {
  cookId: string;
  totalDuration: number; // minutes
  averageGrillTemp: number;
  peakGrillTemp: number;
  averageProbeTemps: {
    probe1?: number;
    probe2?: number;
    probe3?: number;
    probe4?: number;
  };
  temperatureStability: number; // percentage
  fuelEfficiency?: number;
}

/**
 * Real-time cook status update
 */
export interface CookStatusUpdate {
  cookId: string;
  status: CookStatus;
  currentTemps: TargetTemperatures;
  progress: {
    elapsedTime: number; // minutes
    estimatedTimeRemaining?: number; // minutes
    completionPercentage: number; // 0-100
  };
  alerts: string[];
}