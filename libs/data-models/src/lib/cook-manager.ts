/**
 * Cook session management business logic
 */

import { 
  Cook, 
  StartCookRequest, 
  UpdateCookRequest,
  CookStatus,
  TemperatureReading,
  CookSummary
} from '@meatgeekv2/api-interfaces';
import { randomUUID } from 'node:crypto';
import {
  MEAT_TYPES,
  COOK_STATUS,
  VALIDATION,
  resolveMeatType,
  calculateDuration,
  formatDuration
} from '@meatgeekv2/utils';

export class CookManager {
  /**
   * Creates a new cook session
   */
  static createCook(request: StartCookRequest, userId: string): Cook {
    const cookId = `cook-${randomUUID()}`;
    const key = resolveMeatType(request.meatType);
    const meatTypeConfig = key ? MEAT_TYPES[key] : undefined;

    return {
      id: cookId,
      userId,
      deviceId: request.deviceId,
      name: request.name.trim(),
      status: COOK_STATUS.PLANNING,
      startTime: new Date().toISOString(),
      meatType: request.meatType,
      weight: request.weight,
      targetTemps: request.targetTemps || {
        grill: meatTypeConfig?.defaultGrillTemp,
        probe1: meatTypeConfig?.defaultMeatTemp,
      },
      notes: request.notes,
      isPublic: false,
    };
  }

  /**
   * Starts an active cook session
   */
  static startCook(cook: Cook): Cook {
    return {
      ...cook,
      status: COOK_STATUS.ACTIVE,
      startTime: new Date().toISOString(),
    };
  }

  /**
   * Updates a cook session
   */
  static updateCook(cook: Cook, updates: UpdateCookRequest): Cook {
    const updatedCook = { ...cook };

    if (updates.name !== undefined) updatedCook.name = updates.name;
    if (updates.status !== undefined) updatedCook.status = updates.status;
    if (updates.targetTemps !== undefined) {
      updatedCook.targetTemps = { ...cook.targetTemps, ...updates.targetTemps };
    }
    if (updates.notes !== undefined) updatedCook.notes = updates.notes;
    if (updates.rating !== undefined) updatedCook.rating = updates.rating;
    
    if (updates.endTime !== undefined) {
      updatedCook.endTime = updates.endTime;
      if (updatedCook.startTime) {
        updatedCook.actualDuration = calculateDuration(updatedCook.startTime, updates.endTime) / 60; // Convert to hours
      }
    }

    return updatedCook;
  }

  /**
   * Completes a cook session
   */
  static completeCook(cook: Cook, finalTemps?: {
    grill?: number;
    probe1?: number;
    probe2?: number;
    probe3?: number;
    probe4?: number;
  }): Cook {
    const endTime = new Date().toISOString();
    const actualDuration = cook.startTime 
      ? calculateDuration(cook.startTime, endTime) / 60 // Convert to hours
      : undefined;

    return {
      ...cook,
      status: COOK_STATUS.COMPLETED,
      endTime,
      actualDuration,
      maxTemps: finalTemps,
    };
  }

  /**
   * Validates cook data
   */
  static validateCook(cook: Partial<Cook>): { isValid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!cook.name || cook.name.trim().length < 3) {
      errors.push('Cook name must be at least 3 characters');
    }

    if (!cook.deviceId || cook.deviceId.trim().length === 0) {
      errors.push('Device ID is required');
    }

    if (!cook.meatType || cook.meatType.trim().length === 0) {
      errors.push('Meat type is required');
    }

    if (cook.weight !== undefined) {
      if (cook.weight <= VALIDATION.WEIGHT.MIN_EXCLUSIVE || cook.weight > VALIDATION.WEIGHT.MAX) {
        errors.push('Weight must be between 0 and 100 pounds');
      } else if (cook.weight > VALIDATION.WEIGHT.WARN_ABOVE) {
        warnings.push('Weight over 50 pounds - verify this is correct');
      }
    }

    if (cook.targetTemps) {
      const { targetTemps } = cook;
      if (targetTemps.grill !== undefined && (targetTemps.grill < 150 || targetTemps.grill > 500)) {
        errors.push('Grill target temperature must be between 150°F and 500°F');
      }
      
      ['probe1', 'probe2', 'probe3', 'probe4'].forEach(probe => {
        const temp = targetTemps[probe as keyof typeof targetTemps];
        if (temp !== undefined && (temp < 100 || temp > 250)) {
          errors.push(`${probe} target temperature must be between 100°F and 250°F`);
        }
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Calculates cook progress based on temperature targets
   */
  static calculateCookProgress(cook: Cook, currentTemps: TemperatureReading): {
    overallProgress: number;
    probeProgress: Record<string, number>;
    isNearCompletion: boolean;
    completedProbes: string[];
  } {
    if (!cook.targetTemps) {
      return {
        overallProgress: 0,
        probeProgress: {},
        isNearCompletion: false,
        completedProbes: [],
      };
    }

    const probeProgress: Record<string, number> = {};
    const completedProbes: string[] = [];
    let totalProgress = 0;
    let activeProbes = 0;

    // Calculate progress for each probe with a target
    (['probe1', 'probe2', 'probe3', 'probe4'] as const).forEach(probe => {
      const targetTemp = cook.targetTemps![probe];
      const currentTemp = currentTemps[`${probe}Temp` as keyof TemperatureReading] as number | null;

      if (targetTemp && currentTemp !== null) {
        const startTemp = 70; // Assume starting temp around room temperature
        const progress = Math.min(100, Math.max(0, ((currentTemp - startTemp) / (targetTemp - startTemp)) * 100));
        
        probeProgress[probe] = Math.round(progress);
        totalProgress += progress;
        activeProbes++;

        if (currentTemp >= targetTemp) {
          completedProbes.push(probe);
        }
      }
    });

    const overallProgress = activeProbes > 0 ? Math.round(totalProgress / activeProbes) : 0;
    const isNearCompletion = overallProgress >= 90 || completedProbes.length === activeProbes;

    return {
      overallProgress,
      probeProgress,
      isNearCompletion,
      completedProbes,
    };
  }

  /**
   * Generates cook summary analytics
   */
  static generateCookSummary(cook: Cook, allReadings: TemperatureReading[]): CookSummary {
    const cookReadings = allReadings.filter(r => r.cookId === cook.id);
    
    if (cookReadings.length === 0) {
      return {
        cookId: cook.id,
        totalDuration: 0,
        averageGrillTemp: 0,
        peakGrillTemp: 0,
        averageProbeTemps: {},
        temperatureStability: 0,
      };
    }

    // Calculate grill temperature stats
    const grillTemps = cookReadings
      .map(r => r.grillTemp)
      .filter((t): t is number => t !== null && t !== undefined);
    
    const averageGrillTemp = grillTemps.reduce((sum, t) => sum + t, 0) / grillTemps.length;
    const peakGrillTemp = Math.max(...grillTemps);

    // Calculate probe averages
    const averageProbeTemps: Record<string, number> = {};
    (['probe1', 'probe2', 'probe3', 'probe4'] as const).forEach(probe => {
      const temps = cookReadings
        .map(r => r[`${probe}Temp` as keyof TemperatureReading])
        .filter((t): t is number => t !== null && t !== undefined);
      
      if (temps.length > 0) {
        averageProbeTemps[probe] = temps.reduce((sum, t) => sum + t, 0) / temps.length;
      }
    });

    // Calculate stability (inverse of temperature variance)
    const grillVariance = grillTemps.reduce((sum, t) => sum + Math.pow(t - averageGrillTemp, 2), 0) / grillTemps.length;
    const temperatureStability = Math.max(0, 100 - Math.sqrt(grillVariance));

    // Calculate total duration
    const firstReading = new Date(cookReadings[0].timestamp);
    const lastReading = new Date(cookReadings[cookReadings.length - 1].timestamp);
    const totalDuration = Math.floor((lastReading.getTime() - firstReading.getTime()) / (1000 * 60));

    return {
      cookId: cook.id,
      totalDuration,
      averageGrillTemp: Number(averageGrillTemp.toFixed(1)),
      peakGrillTemp: Number(peakGrillTemp.toFixed(1)),
      averageProbeTemps: Object.fromEntries(
        Object.entries(averageProbeTemps).map(([probe, temp]) => [probe, Number(temp.toFixed(1))])
      ),
      temperatureStability: Number(temperatureStability.toFixed(1)),
    };
  }

  /**
   * Estimates remaining cook time
   */
  static estimateRemainingTime(cook: Cook, currentTemps: TemperatureReading): string | null {
    if (!cook.targetTemps?.probe1 || !currentTemps.probe1Temp) {
      return null;
    }

    const currentTemp = currentTemps.probe1Temp;
    const targetTemp = cook.targetTemps.probe1;

    if (currentTemp >= targetTemp) {
      return 'Done!';
    }

    if (!cook.startTime) {
      return null;
    }

    const elapsedMinutes = calculateDuration(cook.startTime, new Date().toISOString());
    
    if (elapsedMinutes < 30) {
      return 'Calculating...';
    }

    // Simple linear projection
    const startingTemp = 70; // Assume starting temp
    const tempRise = currentTemp - startingTemp;
    const ratePerMinute = tempRise / elapsedMinutes;

    if (ratePerMinute <= 0) {
      return 'Unable to estimate';
    }

    const tempNeeded = targetTemp - currentTemp;
    const estimatedMinutes = Math.ceil(tempNeeded / ratePerMinute);

    return formatDuration(estimatedMinutes);
  }
}