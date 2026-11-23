import { randomInt } from 'crypto';

import type { AcceptanceApi, AcceptanceResponse } from './proof';

/**
 * HAR-142 (goal HAR-130) — what the claim proofs need besides a fresh device:
 * codes that are well formed but wrong, and the check that every refusal is
 * the same answer.
 *
 * A code here is a secret until it is used, as in ./claim-code: no message
 * quotes one, right or wrong.
 */

/** The claim-code alphabet, Crockford base32 (no I, L, O or U). The API's
 *  CLAIM_CODE_ALPHABET (apps/api/src/shared/devices/claim-code.ts) and the
 *  device's; claim-refusal.spec.ts fails if they drift apart. */
export const CLAIM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A claim code as simdevice prints it: `XXXX-XXXX-XXXX`. */
const WELL_FORMED = new RegExp(`^[${CLAIM_CODE_ALPHABET}]{4}(-[${CLAIM_CODE_ALPHABET}]{4}){2}$`);

/** The 12 symbols, by index, in the printed `XXXX-XXXX-XXXX`. */
const SYMBOL_OFFSETS = [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13];

export function isWellFormedClaimCode(code: string): boolean {
  return WELL_FORMED.test(code);
}

/**
 * `code` with its `symbol`-th symbol (0 to 11) replaced by the next one in the
 * alphabet, wrapping from `Z` to `0`. The result is well formed and differs
 * from `code` in exactly that symbol. Every alphabet symbol is its own
 * normalized form (the API folds only `O`, `I`, `L` and lower case, none of
 * which is in the alphabet), so the API reads it as a different code too.
 */
export function mutateClaimCode(code: string, symbol = 0): string {
  if (!isWellFormedClaimCode(code)) {
    throw new Error('mutateClaimCode needs a well-formed XXXX-XXXX-XXXX code');
  }
  if (!Number.isInteger(symbol) || symbol < 0 || symbol >= SYMBOL_OFFSETS.length) {
    throw new Error(`symbol must be 0 to ${SYMBOL_OFFSETS.length - 1}, got ${symbol}`);
  }
  const at = SYMBOL_OFFSETS[symbol];
  const next =
    CLAIM_CODE_ALPHABET[(CLAIM_CODE_ALPHABET.indexOf(code[at]) + 1) % CLAIM_CODE_ALPHABET.length];
  return `${code.slice(0, at)}${next}${code.slice(at + 1)}`;
}

/** `randomInt(max)`: a uniform integer in [0, max). The self-test passes its own. */
export type RandomInt = (max: number) => number;

/**
 * A random well-formed code that is none of `avoid`. A clash is a 1 in 32^12
 * chance; it is drawn again rather than trusted to luck.
 */
export function randomClaimCode(
  avoid: readonly string[] = [],
  pick: RandomInt = max => randomInt(max)
): string {
  for (;;) {
    const symbols = Array.from(
      { length: SYMBOL_OFFSETS.length },
      () => CLAIM_CODE_ALPHABET[pick(CLAIM_CODE_ALPHABET.length)]
    ).join('');
    const code = `${symbols.slice(0, 4)}-${symbols.slice(4, 8)}-${symbols.slice(8)}`;
    if (!isWellFormedClaimCode(code)) {
      throw new Error('pick returned a number outside [0, 32)');
    }
    if (!avoid.includes(code)) {
      return code;
    }
  }
}

/** The one 403 message every claim refusal carries (claim-device.ts's
 *  CLAIM_REFUSED_MESSAGE; claim-refusal.spec.ts fails if they drift apart). */
export const CLAIM_REFUSED_MESSAGE = 'Device could not be claimed with that code';

/** The fields of a refusal body, in the order the API writes them. */
const REFUSAL_KEYS = ['error', 'message', 'requestId'];

/**
 * The "no oracle" check: every refused claim in a group is the same answer,
 * whichever check refused it (no twin, a wrong code, a consumed code, a
 * device held by someone else). {@link expect} fails unless the response is
 *
 *   - 403 with no `x-meatgeek-request-charge` header (Cosmos may have been
 *     read, but the answer does not say so);
 *   - a body of exactly `error`, `message` and `requestId`, in that order:
 *     `CLAIM_REFUSED`, the one fixed message, and a string;
 *
 * So every refusal that passes is the same bytes apart from `requestId`,
 * which is the request's own invocation id and differs on every answer.
 */
export class ClaimRefusals {
  private seen = 0;

  get count(): number {
    return this.seen;
  }

  expect(api: AcceptanceApi, response: AcceptanceResponse): void {
    api.expectStatus(response, 403);
    api.check(
      response,
      response.requestCharge === undefined && !response.headers.has('x-meatgeek-request-charge'),
      'a refused claim carries a request charge, so it tells a Cosmos read from none'
    );
    const body = response.body as Record<string, unknown> | null;
    api.check(
      response,
      body !== null && typeof body === 'object' && !Array.isArray(body),
      'the refusal body is not a JSON object'
    );
    api.check(
      response,
      JSON.stringify(Object.keys(body)) === JSON.stringify(REFUSAL_KEYS),
      `the refusal body's fields are ${JSON.stringify(Object.keys(body))}, not ${JSON.stringify(REFUSAL_KEYS)}`
    );
    api.check(
      response,
      body['error'] === 'CLAIM_REFUSED',
      `body.error is ${JSON.stringify(body['error'])}, not CLAIM_REFUSED`
    );
    api.check(
      response,
      body['message'] === CLAIM_REFUSED_MESSAGE,
      'body.message is not the one fixed refusal message'
    );
    api.check(response, typeof body['requestId'] === 'string', 'body.requestId is not a string');
    this.seen += 1;
  }
}
