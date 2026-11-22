/**
 * HAR-130 — the claim-code rules, driven by the vector file the device's Go
 * tests also read (libs/api-interfaces/test-vectors/claim-code.json).
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  CLAIM_CODE_ALPHABET,
  claimantHash,
  claimCodeHash,
  hashMatches,
  normalizeClaimCode,
} from './claim-code';

const VECTOR_FILE = path.resolve(
  __dirname,
  '../../../../../libs/api-interfaces/test-vectors/claim-code.json'
);

interface ClaimCodeVector {
  readonly note: string;
  readonly deviceId: string;
  readonly input: string;
  readonly normalized: string | null;
  readonly hash: string | null;
}

const vectors = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8')) as {
  claimants: Array<{ userId: string; hash: string }>;
  cases: ClaimCodeVector[];
};

describe('claim-code vectors', () => {
  it('has valid and invalid cases', () => {
    expect(vectors.cases.filter(c => c.normalized !== null).length).toBeGreaterThanOrEqual(10);
    expect(vectors.cases.filter(c => c.normalized === null).length).toBeGreaterThanOrEqual(10);
    expect(vectors.claimants.length).toBeGreaterThanOrEqual(1);
  });

  it.each(vectors.cases)('normalizeClaimCode: $note', vector => {
    expect(normalizeClaimCode(vector.input)).toBe(vector.normalized);
  });

  it.each(vectors.cases.filter(vector => vector.normalized !== null))(
    'claimCodeHash: $note',
    vector => {
      expect(claimCodeHash(vector.deviceId, vector.normalized as string)).toBe(vector.hash);
    }
  );

  it.each(vectors.claimants)('claimantHash($userId)', claimant => {
    expect(claimantHash(claimant.userId)).toBe(claimant.hash);
  });
});

describe('claim-code rules', () => {
  it('uses Crockford base32', () => {
    expect(CLAIM_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(CLAIM_CODE_ALPHABET).toHaveLength(32);
  });

  it('hashes are lowercase hex SHA-256', () => {
    expect(claimCodeHash('d', '000000000000')).toMatch(/^[0-9a-f]{64}$/);
    expect(claimantHash('u')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashMatches is true only for the same string', () => {
    const hash = claimCodeHash('meatgeek3', '7K3M9QXR2HTV');
    expect(hashMatches(hash, hash)).toBe(true);
    expect(hashMatches(hash.toUpperCase(), hash)).toBe(false);
    expect(hashMatches(hash.slice(1), hash)).toBe(false);
    expect(hashMatches(undefined, hash)).toBe(false);
    expect(hashMatches(42, hash)).toBe(false);
    expect(hashMatches('', hash)).toBe(false);
  });
});
