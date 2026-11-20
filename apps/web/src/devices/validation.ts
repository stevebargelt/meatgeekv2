/**
 * Client-side checks that mirror the API's (RegisterDeviceRequest and
 * UpdateDeviceRequest in libs/api-specs/spec/components/schemas/device.yaml).
 * The server stays authoritative; these only save a round trip.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RegisterDeviceInput {
  deviceId: string;
  name: string;
  model: string;
  location: string;
}

export type FieldErrors = Partial<Record<keyof RegisterDeviceInput, string>>;

export function validateDeviceId(deviceId: string): string | undefined {
  return DEVICE_ID_PATTERN.test(deviceId)
    ? undefined
    : 'Device ID must be 1-128 characters: letters, digits, and . _ : -';
}

/** For name and model: 1-100 characters after trimming. */
export function validateLabel(label: string, value: string): string | undefined {
  const length = value.trim().length;
  if (length === 0) return `${label} is required.`;
  if (length > 100) return `${label} must be at most 100 characters.`;
  return undefined;
}

export function validateLocation(value: string): string | undefined {
  return value.trim().length > 200 ? 'Location must be at most 200 characters.' : undefined;
}

export function validateRegistration(input: RegisterDeviceInput): FieldErrors {
  const errors: FieldErrors = {
    deviceId: validateDeviceId(input.deviceId),
    name: validateLabel('Name', input.name),
    model: validateLabel('Model', input.model),
    location: validateLocation(input.location),
  };
  return Object.fromEntries(
    Object.entries(errors).filter(([, message]) => message !== undefined)
  ) as FieldErrors;
}
