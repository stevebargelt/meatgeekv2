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
 * A channel: the grill, or one of probes 1 to 4.
 */
export type TemperatureChannel = keyof TargetTemperatures;

/**
 * A channel that has reached its target: it read at or above the target on two
 * readings in a row. `reachedAt` is the timestamp of the second reading (the
 * device's clock), so a reading that arrives late still says when the target
 * was reached.
 */
export interface TargetReached {
  reachedAt: string;
}

/**
 * The channels that have reached their current target, keyed by channel. A
 * channel that is absent has not.
 */
export type TargetsReached = { [C in TemperatureChannel]?: TargetReached };

/**
 * Stored on a cook and never returned: per channel, the timestamp of a first
 * reading at or above its target, waiting for a second one.
 */
export type TargetsPending = { [C in TemperatureChannel]?: string };

/**
 * Stored on a cook and never returned: per channel, the `reachedAt` of the
 * reach whose alert Apple accepted for every phone (#244). A channel whose
 * `targetsReached` time differs is still to be alerted.
 */
export type TargetsAlerted = { [C in TemperatureChannel]?: string };

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
  /** Which channels have reached their target, and when. Set by the server. */
  targetsReached?: TargetsReached;
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
  /**
   * Client-generated cook id (a UUID, e.g. from `crypto.randomUUID()`), and the
   * idempotency key for the start. Generate it ONCE per start intent and send
   * the same id, with the same body, on every retry. A repeat returns the
   * original cook with 200 instead of creating a second one; the same id with a
   * different body is rejected with 422 `COOK_ID_REUSED`.
   */
  id: string;
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
  /** Only cooks on this device (opaque, 1–128 characters). ANDs with `status`. */
  deviceId?: string;
  /** Only cooks in this status. ANDs with `deviceId`. */
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
/**
 * HAR-86 — one channel of one {@link CookChartPoint}: the readings of that
 * channel inside the bucket, reduced to their minimum, maximum and mean.
 */
export interface CookChartChannel {
  min: number;
  max: number;
  /** Σsum / Σn over the minute slots merged into the bucket. */
  avg: number;
}

/**
 * HAR-86 — one bucket of a {@link CookChart}. A channel with no reading in the
 * bucket is absent; a bucket with no reading at all is not in `points`.
 */
export interface CookChartPoint {
  /** Bucket start, ISO 8601 (UTC). */
  t: string;
  grill?: CookChartChannel;
  probe1?: CookChartChannel;
  probe2?: CookChartChannel;
  probe3?: CookChartChannel;
  probe4?: CookChartChannel;
}

/**
 * HAR-86 — `GET /cooks/{cookId}/chart`: the whole cook as at most 720 points,
 * read from the per-device, per-hour rollup documents (never the raw readings).
 */
export interface CookChart {
  cookId: string;
  deviceId: string;
  startTime: string;
  /** Present for a cook that has ended; the window is then `[startTime, endTime)`. */
  endTime?: string;
  /** Width of each bucket: 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400 or 21600. */
  bucketSeconds: number;
  /** Buckets with data, oldest first. */
  points: CookChartPoint[];
}
