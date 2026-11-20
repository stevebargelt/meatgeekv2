import type { components } from '@meatgeekv2/api-specs/types';
import { createApiClient, type StartCookRequest } from '../api/client';
import { installFetch, jsonResponse } from '../test/fakes';
import { formatElapsed } from './time';
import { EMPTY_START_COOK, toStartCookRequest, validateStartCook } from './validation';

const ID = '0b6f1d2e-6a51-4c3e-9f6e-8a1d2c3b4a5f';

describe('validateStartCook', () => {
  it('accepts a minimal valid input', () => {
    expect(validateStartCook({ ...EMPTY_START_COOK, name: 'Ribs', meatType: 'pork' })).toEqual({});
  });

  it('applies the StartCookRequest rules', () => {
    expect(
      validateStartCook({
        ...EMPTY_START_COOK,
        name: ' ',
        meatType: 'x'.repeat(101),
        weight: '1000.5',
        grill: '-1',
        probe1: 'hot',
        probe2: '1000',
        probe3: '0',
      })
    ).toEqual({
      name: 'Name is required.',
      meatType: 'Meat type must be at most 100 characters.',
      weight: 'Weight must be a number greater than 0 and at most 1000.',
      grill: 'Grill target must be a number from 0 to 1000.',
      probe1: 'Probe 1 target must be a number from 0 to 1000.',
    });
    expect(
      validateStartCook({ ...EMPTY_START_COOK, name: 'a', meatType: 'b', weight: '0' })
    ).toEqual({
      weight: 'Weight must be a number greater than 0 and at most 1000.',
    });
    expect(
      validateStartCook({ ...EMPTY_START_COOK, name: 'a', meatType: 'b', weight: '1000' })
    ).toEqual({});
  });
});

describe('toStartCookRequest', () => {
  it('trims text, parses numbers and leaves blank fields out', () => {
    expect(
      toStartCookRequest(ID, 'meatgeek3', {
        ...EMPTY_START_COOK,
        name: ' Ribs ',
        meatType: ' pork',
        weight: ' 4.25 ',
        probe3: '195',
      })
    ).toEqual({
      id: ID,
      deviceId: 'meatgeek3',
      name: 'Ribs',
      meatType: 'pork',
      weight: 4.25,
      targetTemps: { probe3: 195 },
    });
  });
});

describe('formatElapsed', () => {
  it('prints H:MM:SS and never goes negative', () => {
    expect(formatElapsed(0)).toBe('0:00:00');
    expect(formatElapsed(3_723_999)).toBe('1:02:03');
    expect(formatElapsed(30 * 3600 * 1000)).toBe('30:00:00');
    expect(formatElapsed(-5000)).toBe('0:00:00');
  });
});

describe('the start body is typed from the spec', () => {
  it("is the spec's StartCookRequest: missing, unknown and mistyped fields fail tsc", async () => {
    const { fetchMock } = installFetch(() => jsonResponse(201, {}));
    const client = createApiClient({ baseUrl: 'https://x.test/api', getToken: async () => 't' });
    const body = toStartCookRequest(ID, 'meatgeek3', {
      ...EMPTY_START_COOK,
      name: 'a',
      meatType: 'b',
    });

    // These lines exist for `tsc` (nx run web:typecheck, and ts-jest here):
    // if the generated types ever accepted them, the @ts-expect-error
    // directives would themselves become errors.
    const fromSpec: components['schemas']['StartCookRequest'] = body;
    const alias: StartCookRequest = fromSpec;
    // @ts-expect-error StartCookRequest requires meatType
    await client.POST('/cooks', { body: { id: ID, deviceId: 'meatgeek3', name: 'a' } });
    // @ts-expect-error weight is a number, not the form's string
    await client.POST('/cooks', { body: { ...alias, weight: '12' } });
    // @ts-expect-error StartCookRequest has no `probeTarget` field
    const unknownField: StartCookRequest = { ...alias, probeTarget: 200 };
    // @ts-expect-error StartCookTargetTemperatures has no probe5
    const unknownProbe: StartCookRequest = { ...alias, targetTemps: { probe5: 200 } };

    await client.POST('/cooks', { body });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([unknownField, unknownProbe]).toHaveLength(2);
  });
});
