// seedrandom publishes via `export =`; the workspace tsconfig disables
// esModuleInterop, so use the TypeScript-native CJS import syntax. Matches
// the spec-loader pattern.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import seedrandom = require('seedrandom');
import { VALIDATION, TEMPERATURE } from '@meatgeekv2/utils';
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';

export interface SimulatorOptions {
  /** RNG seed (same seed + same elapsedMinutes always yields the same reading). */
  seed: string;
  /** Device identifier emitted on every reading. */
  deviceId: string;
  /** Optional cook id correlation tag. */
  cookId?: string;
  /** Grill setpoint in °F. Default 225°F (low-and-slow). */
  setpoint?: number;
  /** Probe finish temperature in °F. Default 203 (brisket-slice doneness). */
  probeFinishTemp?: number;
  /** Probe stall plateau temperature in °F. Default 165 (typical bark-stall). */
  stallTemp?: number;
  /** Total minutes the simulated cook runs to reach finishTemp. Default 720 (12h). */
  cookDurationMinutes?: number;
  /** Cook start time in ms-since-epoch. Defaults to "now - elapsedMinutes". */
  startTimeMs?: number;
  /** Which probes to drive. Default ['probe1','probe2']. */
  activeProbes?: ReadonlyArray<'probe1' | 'probe2' | 'probe3' | 'probe4'>;
}

const DEFAULTS = {
  setpoint: 225,
  probeFinishTemp: TEMPERATURE.BEEF.BRISKET,
  stallTemp: TEMPERATURE.POULTRY.SAFE_TEMP,
  cookDurationMinutes: 720,
  activeProbes: ['probe1', 'probe2'] as ReadonlyArray<
    'probe1' | 'probe2' | 'probe3' | 'probe4'
  >,
};

const GRILL_OSCILLATION_AMPLITUDE_F = 5;
const GRILL_OSCILLATION_PERIOD_MIN = 8;
const GRILL_NOISE_F = 1.0;
const PROBE_AMBIENT_F = 70;
const STALL_BAND_F = 3;
const PROBE_NOISE_F = 0.4;

function clampToValidRange(temp: number): number {
  if (temp < VALIDATION.TEMPERATURE.MIN) return VALIDATION.TEMPERATURE.MIN;
  if (temp > VALIDATION.TEMPERATURE.MAX) return VALIDATION.TEMPERATURE.MAX;
  return temp;
}

function deterministicNoise(seed: string, elapsedMinutes: number, channel: string): number {
  const rng = seedrandom(`${seed}|${channel}|${Math.floor(elapsedMinutes * 60)}`);
  return rng() * 2 - 1;
}

function grillTempAt(elapsedMinutes: number, setpoint: number, seed: string): number {
  if (elapsedMinutes < 0) return PROBE_AMBIENT_F;
  const warmup = Math.min(1, elapsedMinutes / 10);
  const target = PROBE_AMBIENT_F + (setpoint - PROBE_AMBIENT_F) * warmup;
  const oscillation =
    GRILL_OSCILLATION_AMPLITUDE_F *
    Math.sin((2 * Math.PI * elapsedMinutes) / GRILL_OSCILLATION_PERIOD_MIN);
  const noise = deterministicNoise(seed, elapsedMinutes, 'grill') * GRILL_NOISE_F;
  return clampToValidRange(target + oscillation + noise);
}

function probeTempAt(
  elapsedMinutes: number,
  options: Required<
    Pick<SimulatorOptions, 'probeFinishTemp' | 'stallTemp' | 'cookDurationMinutes'>
  >,
  seed: string,
  channel: string,
  offsetSeconds: number,
): number {
  const { probeFinishTemp, stallTemp, cookDurationMinutes } = options;
  if (elapsedMinutes < 0) return PROBE_AMBIENT_F;

  const stallStartFrac = 0.45;
  const stallEndFrac = 0.75;
  const t = Math.min(1, elapsedMinutes / cookDurationMinutes);

  const climbToStallEnd = stallStartFrac;
  const stallEnd = stallEndFrac;

  let base: number;
  if (t <= climbToStallEnd) {
    const climbFrac = t / climbToStallEnd;
    base = PROBE_AMBIENT_F + (stallTemp - PROBE_AMBIENT_F) * climbFrac;
  } else if (t <= stallEnd) {
    const stallFrac = (t - climbToStallEnd) / (stallEnd - climbToStallEnd);
    base = stallTemp + STALL_BAND_F * stallFrac;
  } else {
    const finishFrac = (t - stallEnd) / (1 - stallEnd);
    const stallExitTemp = stallTemp + STALL_BAND_F;
    base = stallExitTemp + (probeFinishTemp - stallExitTemp) * finishFrac;
  }

  const noiseSign = deterministicNoise(seed, elapsedMinutes, channel) > 0 ? 1 : -1;
  const noiseMagnitude =
    Math.abs(deterministicNoise(seed, elapsedMinutes, `${channel}|n`)) * PROBE_NOISE_F;
  const offsetF = offsetSeconds / 60;
  return clampToValidRange(base + noiseSign * noiseMagnitude + offsetF);
}

export function generateReading(
  elapsedMinutes: number,
  options: SimulatorOptions,
): TemperatureReading {
  const merged = {
    setpoint: options.setpoint ?? DEFAULTS.setpoint,
    probeFinishTemp: options.probeFinishTemp ?? DEFAULTS.probeFinishTemp,
    stallTemp: options.stallTemp ?? DEFAULTS.stallTemp,
    cookDurationMinutes: options.cookDurationMinutes ?? DEFAULTS.cookDurationMinutes,
    activeProbes: options.activeProbes ?? DEFAULTS.activeProbes,
  };

  const startTimeMs = options.startTimeMs ?? Date.now() - elapsedMinutes * 60_000;
  const timestamp = new Date(startTimeMs + elapsedMinutes * 60_000).toISOString();

  const reading: TemperatureReading = {
    deviceId: options.deviceId,
    timestamp,
    grillTemp: round1(grillTempAt(elapsedMinutes, merged.setpoint, options.seed)),
  };

  if (options.cookId) {
    reading.cookId = options.cookId;
  }

  const probeOptions = {
    probeFinishTemp: merged.probeFinishTemp,
    stallTemp: merged.stallTemp,
    cookDurationMinutes: merged.cookDurationMinutes,
  };

  for (let i = 0; i < merged.activeProbes.length; i++) {
    const probe = merged.activeProbes[i];
    const value = probeTempAt(elapsedMinutes, probeOptions, options.seed, probe, i * 1);
    reading[`${probe}Temp` as 'probe1Temp' | 'probe2Temp' | 'probe3Temp' | 'probe4Temp'] =
      round1(value);
  }

  return reading;
}

export function generateSeries(
  options: SimulatorOptions,
  startElapsedMinutes: number,
  endElapsedMinutes: number,
  stepMinutes: number,
): TemperatureReading[] {
  if (stepMinutes <= 0) {
    throw new Error('stepMinutes must be positive');
  }
  const out: TemperatureReading[] = [];
  for (let m = startElapsedMinutes; m <= endElapsedMinutes; m += stepMinutes) {
    out.push(generateReading(m, options));
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
