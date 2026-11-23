import { formatClaimCode, validateClaim } from './validation';

describe('formatClaimCode', () => {
  it.each([
    ['', ''],
    ['7k3m', '7K3M'],
    ['7k3m9', '7K3M-9'],
    ['7K3M-', '7K3M'],
    ['7k3m9qxr2htv', '7K3M-9QXR-2HTV'],
    ['7k3m-9qxr-2htv', '7K3M-9QXR-2HTV'],
    ['7k3m 9qxr  2htv', '7K3M-9QXR-2HTV'],
    [' 7K3M\t9QXR-2HTV ', '7K3M-9QXR-2HTV'],
    // Not judged here: the API reads O as 0 and refuses U, and says so.
    ['oooo-uuuu-iiii', 'OOOO-UUUU-IIII'],
    ['7K3M9QXR2HTVX', '7K3M-9QXR-2HTV-X'],
    ['7K3M.9QX', '7K3M-.9QX'],
  ])('%j shows as %j', (raw, shown) => {
    expect(formatClaimCode(raw).value).toBe(shown);
  });

  it('keeps the caret after the same symbols', () => {
    // Typed a 5th symbol at the end: the caret goes past the new hyphen.
    expect(formatClaimCode('7K3M9', 5)).toEqual({ value: '7K3M-9', cursor: 6 });
    // Typed `x` in the middle of the first group.
    expect(formatClaimCode('7Kx3M-9QXR', 3)).toEqual({ value: '7KX3-M9QX-R', cursor: 3 });
    // Typed at the start of the second group.
    expect(formatClaimCode('7K3M-q9QXR', 6)).toEqual({ value: '7K3M-Q9QX-R', cursor: 6 });
    // Deleted the hyphen: the caret stays at the end of the first group.
    expect(formatClaimCode('7K3M9QXR', 4)).toEqual({ value: '7K3M-9QXR', cursor: 4 });
    expect(formatClaimCode('7K3M', 0)).toEqual({ value: '7K3M', cursor: 0 });
  });
});

describe('validateClaim', () => {
  const valid = { deviceId: 'meatgeek3', claimCode: '7K3M-9QXR-2HTV', name: 'Box', location: '' };

  it('passes a complete claim', () => {
    expect(validateClaim(valid)).toEqual({});
  });

  it('requires a code, and separators alone are none', () => {
    expect(validateClaim({ ...valid, claimCode: ' - ' })).toEqual({
      claimCode: 'Claim code is required.',
    });
  });

  it('checks the device id, name and location like the API', () => {
    expect(
      validateClaim({
        deviceId: 'has spaces',
        claimCode: 'x',
        name: 'n'.repeat(101),
        location: 'l'.repeat(201),
      })
    ).toEqual({
      deviceId: 'Device ID must be 1-128 characters: letters, digits, and . _ : -',
      name: 'Name must be at most 100 characters.',
      location: 'Location must be at most 200 characters.',
    });
  });
});
