import { CLAIM_REFUSED_MESSAGE as API_REFUSED_MESSAGE } from '../src/functions/devices/claim-device';
import {
  CLAIM_CODE_ALPHABET as API_ALPHABET,
  normalizeClaimCode,
} from '../src/shared/devices/claim-code';
import {
  CLAIM_CODE_ALPHABET,
  CLAIM_REFUSED_MESSAGE,
  ClaimRefusals,
  isWellFormedClaimCode,
  mutateClaimCode,
  randomClaimCode,
} from './lib/claim-refusal';
import type { AcceptanceApi, AcceptanceResponse } from './lib/proof';
import { ProofFailure } from './lib/proof';

/**
 * HAR-142 — ./lib/claim-refusal: the wrong codes the claim proofs send, and
 * the "no oracle" check on their refusals. Pure functions and a fake api;
 * nothing waits.
 */

describe('the claim-code rules match the API', () => {
  it('uses the API’s alphabet and refusal message', () => {
    expect(CLAIM_CODE_ALPHABET).toBe(API_ALPHABET);
    expect(CLAIM_REFUSED_MESSAGE).toBe(API_REFUSED_MESSAGE);
  });
});

describe('mutateClaimCode', () => {
  const codeOf = (symbols: string) =>
    `${symbols.slice(0, 4)}-${symbols.slice(4, 8)}-${symbols.slice(8, 12)}`;

  it('changes exactly the one symbol, for every symbol of the alphabet at every position', () => {
    let checked = 0;
    for (const symbol of CLAIM_CODE_ALPHABET) {
      // A different filler, so a change at any position is visible.
      const filler = symbol === '7' ? 'K' : '7';
      for (let position = 0; position < 12; position++) {
        const symbols = Array.from({ length: 12 }, (_, i) => (i === position ? symbol : filler));
        const code = codeOf(symbols.join(''));
        const mutated = mutateClaimCode(code, position);

        expect(isWellFormedClaimCode(mutated)).toBe(true);
        // The API reads both as codes, and as different ones.
        expect(normalizeClaimCode(mutated)).not.toBeNull();
        expect(normalizeClaimCode(mutated)).not.toBe(normalizeClaimCode(code));
        const before = code.replace(/-/g, '');
        const after = mutated.replace(/-/g, '');
        const changed = [...after].filter((c, i) => c !== before[i]);
        expect(changed).toHaveLength(1);
        expect(after[position]).not.toBe(before[position]);
        checked++;
      }
    }
    expect(checked).toBe(32 * 12);
  });

  it('changes the first symbol by default, wrapping Z to 0', () => {
    expect(mutateClaimCode('7K3M-9QXR-2HTV')).toBe('8K3M-9QXR-2HTV');
    expect(mutateClaimCode('ZK3M-9QXR-2HTV')).toBe('0K3M-9QXR-2HTV');
    expect(mutateClaimCode('7K3M-9QXR-2HTZ', 11)).toBe('7K3M-9QXR-2HT0');
  });

  it('refuses a code that is not well formed, or a position outside it, without quoting it', () => {
    for (const bad of ['7K3M9QXR2HTV', '7k3m-9qxr-2htv', '7K3M-9QXR-2HTI', '7K3M-9QXR-2HT', '']) {
      expect(() => mutateClaimCode(bad)).toThrow(
        'mutateClaimCode needs a well-formed XXXX-XXXX-XXXX code'
      );
    }
    expect(() => mutateClaimCode('7K3M-9QXR-2HTV', 12)).toThrow('symbol must be 0 to 11, got 12');
    expect(() => mutateClaimCode('7K3M-9QXR-2HTV', -1)).toThrow('symbol must be 0 to 11, got -1');
  });
});

describe('randomClaimCode', () => {
  /** A pick that returns `values` in turn. */
  const scripted = (values: number[]) => {
    let i = 0;
    return (max: number) => {
      expect(max).toBe(32);
      return values[i++ % values.length];
    };
  };

  it('builds a well-formed code from the picks', () => {
    const code = randomClaimCode([], scripted([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 31]));
    expect(code).toBe('0123-4567-89AZ');
  });

  it('draws again when the code is one to avoid', () => {
    const zeros = Array.from({ length: 12 }, () => 0);
    const ones = Array.from({ length: 12 }, () => 1);
    const code = randomClaimCode(['0000-0000-0000'], scripted([...zeros, ...ones]));
    expect(code).toBe('1111-1111-1111');
  });

  it('is well formed and avoids the given code with the real random source', () => {
    for (let i = 0; i < 200; i++) {
      const code = randomClaimCode(['7K3M-9QXR-2HTV']);
      expect(isWellFormedClaimCode(code)).toBe(true);
      expect(normalizeClaimCode(code)).toBe(code.replace(/-/g, ''));
      expect(code).not.toBe('7K3M-9QXR-2HTV');
    }
  });

  it('fails on a pick outside the alphabet', () => {
    expect(() => randomClaimCode([], () => 32)).toThrow('pick returned a number outside [0, 32)');
  });
});

describe('ClaimRefusals', () => {
  const api = {
    expectStatus(response: AcceptanceResponse, expected: number) {
      if (response.status !== expected) {
        throw new ProofFailure(`expected ${expected}, got ${response.status}`, response);
      }
    },
    check(response: AcceptanceResponse, condition: unknown, message: string) {
      if (!condition) throw new ProofFailure(message, response);
    },
  } as unknown as AcceptanceApi;

  const refusal = (
    body: unknown,
    options: { status?: number; charge?: string } = {}
  ): AcceptanceResponse => {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (options.charge !== undefined) headers.set('x-meatgeek-request-charge', options.charge);
    return {
      method: 'POST',
      route: '/devices/claim',
      as: 'owner',
      status: options.status ?? 403,
      latencyMs: 1,
      requestCharge: options.charge === undefined ? undefined : Number(options.charge),
      headers,
      body,
    };
  };

  const body = (requestId: string) => ({
    error: 'CLAIM_REFUSED',
    message: CLAIM_REFUSED_MESSAGE,
    requestId,
  });

  it('accepts refusals that differ only in requestId, and counts them', () => {
    const refusals = new ClaimRefusals();
    refusals.expect(api, refusal(body('invocation-1')));
    refusals.expect(api, refusal(body('invocation-2')));
    expect(refusals.count).toBe(2);
  });

  it.each([
    ['a 200', refusal(body('i'), { status: 200 }), 'expected 403, got 200'],
    [
      'a request charge',
      refusal(body('i'), { charge: '1.23' }),
      'a refused claim carries a request charge, so it tells a Cosmos read from none',
    ],
    ['a body that is not an object', refusal('refused'), 'the refusal body is not a JSON object'],
    [
      'an extra field',
      refusal({ ...body('i'), reason: 'wrong_code' }),
      'the refusal body\'s fields are ["error","message","requestId","reason"], not',
    ],
    [
      'the fields in another order',
      refusal({ message: CLAIM_REFUSED_MESSAGE, error: 'CLAIM_REFUSED', requestId: 'i' }),
      'the refusal body\'s fields are ["message","error","requestId"]',
    ],
    [
      'another code',
      refusal({ ...body('i'), error: 'DEVICE_NOT_FOUND' }),
      'body.error is "DEVICE_NOT_FOUND", not CLAIM_REFUSED',
    ],
    [
      'another message',
      refusal({ ...body('i'), message: 'No such device' }),
      'body.message is not the one fixed refusal message',
    ],
    ['no requestId', refusal({ ...body('i'), requestId: 7 }), 'body.requestId is not a string'],
  ])('fails on %s', (_what, response, message) => {
    const refusals = new ClaimRefusals();
    expect(() => refusals.expect(api, response)).toThrow(message);
    expect(refusals.count).toBe(0);
  });
});
