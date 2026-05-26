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
  limit?: number;
  offset?: number;
  startDate?: string;
  endDate?: string;
}

/**
 * Response for cook listing
 */
export interface CookListResponse {
  cooks: Cook[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
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