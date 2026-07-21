/**
 * Temperature calculation and analysis business logic
 */

import { TemperatureReading } from '@meatgeekv2/api-interfaces';
import { 
  resistanceToTemperature, 
  adcToResistance, 
  applyCorrectionOffset,
  calculateTrend,
  calculateAverageTemperature
} from '@meatgeekv2/utils';

export interface TemperatureCalculationOptions {
  referenceVoltage?: number;
  referenceResistor?: number;
  r0?: number; // RTD reference resistance
}

export interface ProbeCorrections {
  grillProbeCorrection?: number;
  probe1Correction?: number;
  probe2Correction?: number;
  probe3Correction?: number;
  probe4Correction?: number;
}

export class TemperatureCalculator {
  private options: Required<TemperatureCalculationOptions>;

  constructor(options: TemperatureCalculationOptions = {}) {
    this.options = {
      referenceVoltage: options.referenceVoltage ?? 3.3,
      referenceResistor: options.referenceResistor ?? 10000,
      r0: options.r0 ?? 100,
    };
  }

  /**
   * Converts ADC reading to temperature with RTD sensor
   */
  convertAdcToTemperature(adcValue: number, correction: number = 0): number | null {
    if (adcValue <= 0 || adcValue >= 1023) {
      return null; // Invalid reading
    }

    try {
      const resistance = adcToResistance(
        adcValue, 
        this.options.referenceVoltage, 
        this.options.referenceResistor
      );

      if (!isFinite(resistance)) {
        return null;
      }

      const temperature = resistanceToTemperature(resistance, this.options.r0);
      return applyCorrectionOffset(temperature, correction);
    } catch (error) {
      return null;
    }
  }

  /**
   * Processes raw device data into calibrated temperature reading
   */
  processDeviceReading(rawReading: {
    deviceId: string;
    timestamp: string;
    grillAdc?: number;
    probe1Adc?: number;
    probe2Adc?: number;
    probe3Adc?: number;
    probe4Adc?: number;
    cookId?: string;
  }, corrections: ProbeCorrections = {}): TemperatureReading {
    return {
      deviceId: rawReading.deviceId,
      timestamp: rawReading.timestamp,
      cookId: rawReading.cookId,
      grillTemp: rawReading.grillAdc !== undefined && rawReading.grillAdc !== null
        ? this.convertAdcToTemperature(rawReading.grillAdc, corrections.grillProbeCorrection ?? 0) ?? undefined
        : undefined,
      probe1Temp: rawReading.probe1Adc !== undefined && rawReading.probe1Adc !== null
        ? this.convertAdcToTemperature(rawReading.probe1Adc, corrections.probe1Correction ?? 0) ?? undefined
        : undefined,
      probe2Temp: rawReading.probe2Adc !== undefined && rawReading.probe2Adc !== null
        ? this.convertAdcToTemperature(rawReading.probe2Adc, corrections.probe2Correction ?? 0) ?? undefined
        : undefined,
      probe3Temp: rawReading.probe3Adc !== undefined && rawReading.probe3Adc !== null
        ? this.convertAdcToTemperature(rawReading.probe3Adc, corrections.probe3Correction ?? 0) ?? undefined
        : undefined,
      probe4Temp: rawReading.probe4Adc !== undefined && rawReading.probe4Adc !== null
        ? this.convertAdcToTemperature(rawReading.probe4Adc, corrections.probe4Correction ?? 0) ?? undefined
        : undefined,
    };
  }

  /**
   * Calculates temperature statistics from readings
   */
  calculateStatistics(readings: TemperatureReading[], probe: keyof Pick<TemperatureReading, 'grillTemp' | 'probe1Temp' | 'probe2Temp' | 'probe3Temp' | 'probe4Temp'>) {
    const validReadings = readings
      .map(r => ({ timestamp: r.timestamp, temperature: r[probe] }))
      .filter(r => r.temperature !== null && r.temperature !== undefined) as Array<{ timestamp: string; temperature: number }>;

    if (validReadings.length === 0) {
      return {
        current: null,
        average: null,
        min: null,
        max: null,
        trend: 'stable' as const,
        stability: 0,
      };
    }

    const temperatures = validReadings.map(r => r.temperature);
    const current = validReadings[validReadings.length - 1]?.temperature ?? null;
    const average = calculateAverageTemperature(validReadings);
    const min = Math.min(...temperatures);
    const max = Math.max(...temperatures);
    const trend = calculateTrend(validReadings);

    // Calculate stability as inverse of temperature variance
    const variance = temperatures.reduce((sum, temp) => sum + Math.pow(temp - average, 2), 0) / temperatures.length;
    const stability = Math.max(0, 100 - Math.sqrt(variance));

    return {
      current,
      average: Number(average.toFixed(1)),
      min: Number(min.toFixed(1)),
      max: Number(max.toFixed(1)),
      trend,
      stability: Number(stability.toFixed(1)),
    };
  }

  /**
   * Detects temperature anomalies.
   *
   * `thresholds` are the °F change (vs. the previous reading) at which a
   * spike/drop is classified. Defaults preserve the original behavior: >high →
   * high severity, >medium → medium, >low → low. They are configurable because
   * the right sensitivity depends on the probe placement and cook (e.g. a fast
   * searing cook tolerates larger swings than low-and-slow).
   */
  detectAnomalies(
    readings: TemperatureReading[],
    thresholds: { high: number; medium: number; low: number } = {
      high: 50,
      medium: 25,
      low: 15,
    }
  ): Array<{
    timestamp: string;
    anomaly: 'spike' | 'drop' | 'disconnect';
    probe: string;
    value: number | null;
    severity: 'low' | 'medium' | 'high';
  }> {
    const anomalies: Array<{
      timestamp: string;
      anomaly: 'spike' | 'drop' | 'disconnect';
      probe: string;
      value: number | null;
      severity: 'low' | 'medium' | 'high';
    }> = [];

    const probes = ['grillTemp', 'probe1Temp', 'probe2Temp', 'probe3Temp', 'probe4Temp'] as const;

    for (const probe of probes) {
      for (let i = 1; i < readings.length; i++) {
        const current = readings[i][probe];
        const previous = readings[i - 1][probe];

        // Disconnect detection
        if (previous != null && current == null) {
          anomalies.push({
            timestamp: readings[i].timestamp,
            anomaly: 'disconnect',
            probe: probe.replace('Temp', ''),
            value: null,
            severity: 'high',
          });
          continue;
        }

        if (current == null || previous == null) {
          continue;
        }

        const change = current - previous;
        const absChange = Math.abs(change);

        // Spike/drop detection based on temperature change
        let severity: 'low' | 'medium' | 'high' = 'low';
        let anomaly: 'spike' | 'drop' | null = null;

        if (absChange > thresholds.high) {
          severity = 'high';
          anomaly = change > 0 ? 'spike' : 'drop';
        } else if (absChange > thresholds.medium) {
          severity = 'medium';
          anomaly = change > 0 ? 'spike' : 'drop';
        } else if (absChange > thresholds.low) {
          severity = 'low';
          anomaly = change > 0 ? 'spike' : 'drop';
        }

        if (anomaly) {
          anomalies.push({
            timestamp: readings[i].timestamp,
            anomaly,
            probe: probe.replace('Temp', ''),
            value: current ?? null,
            severity,
          });
        }
      }
    }

    return anomalies;
  }

  /**
   * Estimates cook completion time based on temperature trend
   */
  estimateCompletionTime(
    readings: TemperatureReading[],
    targetTemp: number,
    probe: keyof Pick<TemperatureReading, 'probe1Temp' | 'probe2Temp' | 'probe3Temp' | 'probe4Temp'>
  ): {
    estimatedMinutes: number | null;
    confidence: 'low' | 'medium' | 'high';
    estimatedCompletionTime: string | null;
  } {
    const validReadings = readings
      .map(r => ({ timestamp: r.timestamp, temperature: r[probe] }))
      .filter(r => r.temperature !== null && r.temperature !== undefined) as Array<{ timestamp: string; temperature: number }>;

    if (validReadings.length < 3) {
      return {
        estimatedMinutes: null,
        confidence: 'low',
        estimatedCompletionTime: null,
      };
    }

    const current = validReadings[validReadings.length - 1];
    if (current.temperature >= targetTemp) {
      return {
        estimatedMinutes: 0,
        confidence: 'high',
        estimatedCompletionTime: new Date().toISOString(),
      };
    }

    // Calculate temperature rise rate using linear regression on recent readings
    const recentReadings = validReadings.slice(-10); // Last 10 readings
    const timePoints = recentReadings.map(r => new Date(r.timestamp).getTime());
    const startTime = timePoints[0];
    const normalizedTimes = timePoints.map(t => (t - startTime) / (1000 * 60)); // Convert to minutes

    // Simple linear regression
    const n = recentReadings.length;
    const sumX = normalizedTimes.reduce((sum, x) => sum + x, 0);
    const sumY = recentReadings.reduce((sum, r) => sum + r.temperature, 0);
    const sumXY = normalizedTimes.reduce((sum, x, i) => sum + x * recentReadings[i].temperature, 0);
    const sumXX = normalizedTimes.reduce((sum, x) => sum + x * x, 0);

    // When every recent reading shares an identical timestamp the normalized
    // times are all 0, so this denominator is 0 and the slope divide is 0/0 =
    // NaN. Guard it before dividing — an all-identical time axis carries no
    // derivable trend, so return the same low-confidence no-estimate result the
    // non-positive-slope branch does. (NaN also slips past `slope <= 0`, which
    // would otherwise crash the downstream Date construction.)
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) {
      return {
        estimatedMinutes: null,
        confidence: 'low',
        estimatedCompletionTime: null,
      };
    }

    const slope = (n * sumXY - sumX * sumY) / denom;

    if (!Number.isFinite(slope) || slope <= 0) {
      return {
        estimatedMinutes: null,
        confidence: 'low',
        estimatedCompletionTime: null,
      };
    }

    const tempRemaining = targetTemp - current.temperature;
    const estimatedMinutes = Math.ceil(tempRemaining / slope);

    // Calculate confidence based on data consistency
    const r2 = this.calculateRSquared(recentReadings.map(r => r.temperature), normalizedTimes, slope);
    let confidence: 'low' | 'medium' | 'high' = 'low';
    
    if (r2 > 0.8 && recentReadings.length >= 8) {
      confidence = 'high';
    } else if (r2 > 0.6 && recentReadings.length >= 5) {
      confidence = 'medium';
    }

    const estimatedCompletionTime = new Date(Date.now() + estimatedMinutes * 60 * 1000).toISOString();

    return {
      estimatedMinutes,
      confidence,
      estimatedCompletionTime,
    };
  }

  /**
   * Helper function to calculate R-squared for regression
   */
  private calculateRSquared(temperatures: number[], times: number[], slope: number): number {
    const avgTemp = temperatures.reduce((sum, t) => sum + t, 0) / temperatures.length;
    const avgTime = times.reduce((sum, t) => sum + t, 0) / times.length;
    
    const intercept = avgTemp - slope * avgTime;
    
    let ssRes = 0;
    let ssTot = 0;
    
    for (let i = 0; i < temperatures.length; i++) {
      const predicted = slope * times[i] + intercept;
      ssRes += Math.pow(temperatures[i] - predicted, 2);
      ssTot += Math.pow(temperatures[i] - avgTemp, 2);
    }
    
    if (ssTot === 0) return 0;
    const rSquared = 1 - ssRes / ssTot;
    // Guard NaN: when all time points are identical the upstream slope divide is
    // 0/0 → NaN, which would propagate through here and poison the confidence
    // calculation. Fall back to a defined 0 (no explanatory power).
    return isFinite(rSquared) ? rSquared : 0;
  }
}