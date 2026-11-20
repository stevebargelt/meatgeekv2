import type { components } from '@meatgeekv2/api-specs/types';

export type TemperatureUnit = components['schemas']['TemperatureUnit'];

/**
 * A reading in the device's unit. Readings arrive in °F (the spec's
 * TemperatureReading), so a celsius device's are converted. Rounded to one
 * decimal; "—" when the device sent no value for the channel.
 */
export function formatTemperature(fahrenheit: number | undefined, unit: TemperatureUnit): string {
  if (fahrenheit === undefined) return '—';
  const value = unit === 'celsius' ? ((fahrenheit - 32) * 5) / 9 : fahrenheit;
  const rounded = Math.round(value * 10) / 10;
  return `${Object.is(rounded, -0) ? 0 : rounded} ${unit === 'celsius' ? '°C' : '°F'}`;
}

/** A duration as "12 s", "1 min 40 s" or "2 h 5 min". Negative counts as zero. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${total % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
