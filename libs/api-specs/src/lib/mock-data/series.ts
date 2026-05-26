import type { TemperatureReading } from '@meatgeekv2/api-interfaces';
import { generateReading, SimulatorOptions } from './simulator';

export interface TemperatureSeriesOptions extends SimulatorOptions {
  /** Maximum number of recent readings to retain in memory. Default 720 (1h @ 5s). */
  cacheSize?: number;
  /** Real-time/clock callback for tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_CACHE_SIZE = 720;

/**
 * Drives a deterministic simulator forward in wall-clock time.
 *
 * Each call to `current()` advances the elapsed-time pointer to "now" relative
 * to the series start, generates the reading at that point, caches it, and
 * returns it. `history()` returns up to `cacheSize` recent readings, oldest
 * first.
 */
export class TemperatureSeries {
  private readonly options: SimulatorOptions;
  private readonly startTimeMs: number;
  private readonly cacheSize: number;
  private readonly now: () => number;
  private readonly cache: TemperatureReading[] = [];

  constructor(options: TemperatureSeriesOptions) {
    this.options = options;
    this.cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
    this.now = options.now ?? Date.now;
    this.startTimeMs = options.startTimeMs ?? this.now();
  }

  /** Reading at the supplied elapsed minutes (does not touch the cache). */
  at(elapsedMinutes: number): TemperatureReading {
    return generateReading(elapsedMinutes, {
      ...this.options,
      startTimeMs: this.startTimeMs,
    });
  }

  /** Generate the reading at "now" and append it to the cache. */
  current(): TemperatureReading {
    const elapsedMs = this.now() - this.startTimeMs;
    const elapsedMinutes = Math.max(0, elapsedMs / 60_000);
    const reading = this.at(elapsedMinutes);
    this.cache.push(reading);
    if (this.cache.length > this.cacheSize) {
      this.cache.splice(0, this.cache.length - this.cacheSize);
    }
    return reading;
  }

  /** Up to `limit` recent readings (oldest first); empty until current() called. */
  history(limit?: number): TemperatureReading[] {
    if (limit === undefined || limit >= this.cache.length) {
      return [...this.cache];
    }
    return this.cache.slice(this.cache.length - limit);
  }

  /**
   * Backfill a synthetic history by sampling the simulator at fixed intervals
   * starting `minutesBack` minutes ago through "now". Useful so that the first
   * call to `history()` after construction returns a populated time-series
   * (mock /temperatures/history responses).
   */
  backfill(minutesBack: number, stepSeconds: number): void {
    const stepMinutes = stepSeconds / 60;
    if (stepMinutes <= 0) {
      throw new Error('stepSeconds must be positive');
    }
    const nowMs = this.now();
    const startBackfillMs = nowMs - minutesBack * 60_000;
    for (let tMs = startBackfillMs; tMs <= nowMs; tMs += stepSeconds * 1000) {
      const elapsedMinutes = Math.max(0, (tMs - this.startTimeMs) / 60_000);
      this.cache.push(this.at(elapsedMinutes));
    }
    if (this.cache.length > this.cacheSize) {
      this.cache.splice(0, this.cache.length - this.cacheSize);
    }
  }

  /** Reset the cache (start time and seed unchanged). */
  clear(): void {
    this.cache.length = 0;
  }
}
