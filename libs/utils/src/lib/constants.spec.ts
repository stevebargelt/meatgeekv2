import { MEAT_TYPES, VALIDATION, resolveMeatType } from './constants';

describe('resolveMeatType', () => {
  it('resolves a display name (case-insensitive) to the canonical key', () => {
    expect(resolveMeatType('brisket')).toBe('BRISKET');
  });

  it('resolves the canonical key itself (case-insensitive)', () => {
    expect(resolveMeatType('PORK_SHOULDER')).toBe('PORK_SHOULDER');
  });

  it('resolves the display name "Pork Shoulder" to the PORK_SHOULDER key', () => {
    expect(resolveMeatType('Pork Shoulder')).toBe('PORK_SHOULDER');
  });

  it('returns undefined for an unrecognized meat type', () => {
    expect(resolveMeatType('Unicorn Steaks')).toBeUndefined();
  });

  it('returns a key that indexes MEAT_TYPES', () => {
    const key = resolveMeatType('Brisket');
    expect(key).toBeDefined();
    expect(MEAT_TYPES[key as keyof typeof MEAT_TYPES].name).toBe('Brisket');
  });
});

describe('VALIDATION.WEIGHT', () => {
  it('exposes the unified weight contract', () => {
    expect(VALIDATION.WEIGHT).toEqual({
      MIN_EXCLUSIVE: 0,
      MAX: 100,
      WARN_ABOVE: 50,
    });
  });
});
