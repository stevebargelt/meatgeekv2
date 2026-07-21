/**
 * MG-28 — createCook name-guard integration tests.
 *
 * The MG-28 fix makes CookManager.createCook fail fast when the incoming name
 * trims to the empty string. Before the fix, `name: request.name.trim()` emitted
 * a Cook whose `name` was '' for a whitespace-only request — violating Cook.name's
 * required, non-empty invariant (schema minLength 3; validators reject empty /
 * whitespace-only names). createCook now throws instead of producing that Cook.
 *
 * These tests drive the public factory end-to-end (real Cook construction, real
 * randomUUID, real MEAT_TYPES defaults) and assert the invariant directly:
 *
 *   1. a whitespace-only name THROWS and returns no Cook;
 *   2. an empty-string name THROWS;
 *   3. a normal (padded) name is still trimmed and stored;
 *   4. (property) createCook NEVER returns a Cook whose name is empty or
 *      whitespace-only — for any input it either throws or stores a real,
 *      trimmed, non-empty name.
 *
 * A regression that restores the old passthrough (`name: request.name.trim()`
 * with no guard) passes on a happy-path name but fails properties 1, 2 and 4.
 */
import { describe, expect, it } from '@jest/globals';
import { CookManager } from './cook-manager';
import type { Cook, StartCookRequest } from '@meatgeekv2/api-interfaces';

const GUARD_ERROR = 'createCook: cook name must not be empty or whitespace-only';

const baseRequest = (overrides: Partial<StartCookRequest> = {}): StartCookRequest => ({
  name: 'Sunday Cook',
  deviceId: 'device-1',
  meatType: 'BRISKET',
  ...overrides,
});

/** Assorted strings that trim to '' — every one must be rejected by createCook. */
const WHITESPACE_ONLY = [
  '',
  ' ',
  '   ',
  '\t',
  '\n',
  '\r',
  '\t\n',
  '  \t  \n  ',
  ' ', // non-breaking space
  ' ', // em space
  '\f\v',
];

/** Names that carry real content — createCook must store the trimmed form. */
const CONTENTFUL = [
  'Brisket',
  '  Pork  ',
  '\tTabbed\n',
  'Sunday Brisket',
  'a',
  '  x  ',
  'Ribs 🍖',
  '   Low & Slow   ',
];

describe('MG-28 — createCook fails fast on empty / whitespace-only names', () => {
  it('THROWS (and returns no Cook) for a whitespace-only name', () => {
    let returned: Cook | undefined;
    expect(() => {
      returned = CookManager.createCook(baseRequest({ name: '   ' }), 'user-1');
    }).toThrow(GUARD_ERROR);
    // Fail-fast: nothing is produced, so no invalid Cook can leak downstream.
    expect(returned).toBeUndefined();
  });

  it('THROWS for an empty-string name', () => {
    expect(() => CookManager.createCook(baseRequest({ name: '' }), 'user-1')).toThrow(GUARD_ERROR);
  });

  it.each(WHITESPACE_ONLY.map(n => [n]))('THROWS for name %j (trims to empty)', name => {
    expect(() => CookManager.createCook(baseRequest({ name }), 'user-1')).toThrow(GUARD_ERROR);
  });

  it('still trims and stores a normal padded name', () => {
    const cook = CookManager.createCook(baseRequest({ name: '  Sunday Brisket  ' }), 'user-1');
    expect(cook.name).toBe('Sunday Brisket');
    expect(typeof cook.name).toBe('string');
  });

  it.each(CONTENTFUL.map(n => [n]))('stores the trimmed form of a contentful name %j', name => {
    const cook = CookManager.createCook(baseRequest({ name }), 'user-1');
    expect(cook.name).toBe(name.trim());
    expect(cook.name.length).toBeGreaterThan(0);
  });
});

describe('MG-28 — property: createCook never returns a Cook with an empty / whitespace-only name', () => {
  // A deterministic corpus of names spanning empty, whitespace-only, padded,
  // and interior-whitespace inputs — plus generated combinations. No fast-check
  // dependency (not installed; package-lock is not to be modified), so the
  // property is exercised over an explicit, reproducible generator instead.
  const PAD = ['', ' ', '   ', '\t', '\n', ' '];
  const CORE = ['', ' ', 'B', 'Brisket', 'Low & Slow', 'x'];

  const corpus: string[] = [];
  for (const left of PAD) {
    for (const core of CORE) {
      for (const right of PAD) {
        corpus.push(`${left}${core}${right}`);
      }
    }
  }
  // Fold in the standalone corpora too.
  corpus.push(...WHITESPACE_ONLY, ...CONTENTFUL);

  it(`holds for all ${new Set(corpus).size} generated inputs`, () => {
    for (const name of corpus) {
      const trimmed = name.trim();
      let cook: Cook | undefined;
      try {
        cook = CookManager.createCook(baseRequest({ name }), 'user-1');
      } catch (err) {
        // Only permissible when the name genuinely carries no content.
        expect(trimmed.length).toBe(0);
        expect((err as Error).message).toBe(GUARD_ERROR);
        continue;
      }
      // The invariant under test: any returned Cook has a real, trimmed name.
      expect(cook.name.length).toBeGreaterThan(0);
      expect(cook.name).toBe(trimmed);
      expect(cook.name.trim()).toBe(cook.name);
    }
  });

  it('every contentful input yields a Cook; every empty-trimming input throws', () => {
    for (const name of corpus) {
      const shouldThrow = name.trim().length === 0;
      if (shouldThrow) {
        expect(() => CookManager.createCook(baseRequest({ name }), 'user-1')).toThrow(GUARD_ERROR);
      } else {
        expect(() => CookManager.createCook(baseRequest({ name }), 'user-1')).not.toThrow();
      }
    }
  });
});
