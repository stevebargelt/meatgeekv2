import { createHash, timingSafeEqual } from 'crypto';

/**
 * HAR-130 — the claim code a device mints to prove it is in the claimant's
 * hands (learnings/decisions/har-130-device-provisioning-and-claim.md).
 *
 * The device keeps the plaintext and reports only {@link claimCodeHash} in its
 * twin's reported properties. The API hashes what the claimant typed and
 * compares. Nothing here logs, and no caller may log a code or a hash.
 *
 * The rules are shared with the device (Go) through one vector file,
 * libs/api-interfaces/test-vectors/claim-code.json. Change both together.
 */

/** Crockford base32: no I, L, O or U. */
export const CLAIM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Symbols in a code. Shown as three groups of four: `XXXX-XXXX-XXXX`. */
export const CLAIM_CODE_LENGTH = 12;

const CLAIM_CODE_PATTERN = new RegExp(`^[${CLAIM_CODE_ALPHABET}]{${CLAIM_CODE_LENGTH}}$`);

/** Hyphens and ASCII whitespace (space, tab, LF, VT, FF, CR). */
const SEPARATORS = /[-\t\n\v\f\r ]/g;

/** The letters a person reads as digits. */
const LOOKALIKES: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' };

/**
 * The 12-symbol code `input` stands for, or `null` when it is not one.
 *
 * Removes hyphens and ASCII whitespace, upper-cases ASCII letters, and maps
 * `O` to `0` and `I` / `L` to `1`. Upper-casing is ASCII-only on purpose: the
 * locale-free `toUpperCase` turns `ß` into `SS`, which Go's would not, and the
 * two sides must agree on every input.
 */
export function normalizeClaimCode(input: string): string | null {
  const normalized = input
    .replace(SEPARATORS, '')
    .replace(/[a-z]/g, letter => letter.toUpperCase())
    .replace(/[OIL]/g, letter => LOOKALIKES[letter]);
  return CLAIM_CODE_PATTERN.test(normalized) ? normalized : null;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lowercase hex SHA-256 of `meatgeek-claim-v1:<deviceId>:<normalizedCode>`. */
export function claimCodeHash(deviceId: string, normalizedCode: string): string {
  return sha256Hex(`meatgeek-claim-v1:${deviceId}:${normalizedCode}`);
}

/** Lowercase hex SHA-256 of `meatgeek-claimant-v1:<userId>`. */
export function claimantHash(userId: string): string {
  return sha256Hex(`meatgeek-claimant-v1:${userId}`);
}

/**
 * Whether `stored` (a twin property, of any type) is the hash `expected`, in
 * constant time for equal lengths. A missing, non-string or wrong-length value
 * is simply unequal.
 */
export function hashMatches(stored: unknown, expected: string): boolean {
  if (typeof stored !== 'string') {
    return false;
  }
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
