/**
 * Client-side checks that mirror the API's (ClaimDeviceRequest and
 * UpdateDeviceRequest in libs/api-specs/spec/components/schemas/device.yaml).
 * The server stays authoritative; these only save a round trip.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ClaimDeviceInput {
  deviceId: string;
  claimCode: string;
  name: string;
  location: string;
}

export type FieldErrors = Partial<Record<keyof ClaimDeviceInput, string>>;

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

/**
 * Only that a code was typed. What makes a code well formed (12 Crockford
 * base32 symbols, `O` read as `0`, ...) is the API's to say, in its 400.
 */
export function validateClaimCode(value: string): string | undefined {
  return formatClaimCode(value).value === '' ? 'Claim code is required.' : undefined;
}

export function validateClaim(input: ClaimDeviceInput): FieldErrors {
  const errors: FieldErrors = {
    deviceId: validateDeviceId(input.deviceId),
    claimCode: validateClaimCode(input.claimCode),
    name: validateLabel('Name', input.name),
    location: validateLocation(input.location),
  };
  return Object.fromEntries(
    Object.entries(errors).filter(([, message]) => message !== undefined)
  ) as FieldErrors;
}

/** Spaces and hyphens a user may type between groups; the API ignores them too. */
const SEPARATOR = /[\s-]/;

/**
 * The claim code field as the user types: upper case, in groups of four
 * joined by hyphens (`XXXX-XXXX-XXXX`), whatever spaces or hyphens they typed.
 * Every other character is kept as typed, so the API, which normalizes the
 * code, is the one that judges it. `cursor` is where the caret was in `raw`;
 * the result says where it goes in `value`, after the same symbols.
 */
export function formatClaimCode(
  raw: string,
  cursor = raw.length
): { value: string; cursor: number } {
  const symbols: string[] = [];
  let before = 0;
  [...raw].forEach((char, index) => {
    if (SEPARATOR.test(char)) return;
    symbols.push(char.toUpperCase());
    if (index < cursor) before += 1;
  });
  const value = symbols.reduce(
    (out, symbol, index) => out + (index > 0 && index % 4 === 0 ? '-' : '') + symbol,
    ''
  );
  // After `before` symbols, and after the hyphens between them.
  return { value, cursor: before + Math.max(0, Math.floor((before - 1) / 4)) };
}
