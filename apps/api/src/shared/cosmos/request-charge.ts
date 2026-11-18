/**
 * HAR-11 — report the Cosmos request charge (RU) of a route to its caller.
 *
 * The cooks routes return the RU their Cosmos work cost in this response header,
 * as a decimal number exactly as Cosmos reported it (e.g. `7.42`). The live
 * acceptance suite (apps/api/acceptance) reads it to print RU per route after
 * every dev deploy, so the shared-throughput budget is measured on the deployed
 * system rather than estimated.
 *
 * A response that made no Cosmos call (e.g. a 401 before any read, a 400 on a
 * malformed body) carries no header: there is no charge to report, and a `0`
 * would be indistinguishable from a real zero-cost read.
 */
export const REQUEST_CHARGE_HEADER = 'x-meatgeek-request-charge';

/** The header to merge into a response for a known charge; empty when the
 *  charge is unknown or not a finite number, so the header is simply omitted. */
export function requestChargeHeaders(requestCharge: number | undefined): Record<string, string> {
  if (typeof requestCharge !== 'number' || !Number.isFinite(requestCharge)) {
    return {};
  }
  return { [REQUEST_CHARGE_HEADER]: String(requestCharge) };
}

/**
 * The request charge carried by a thrown Cosmos error, when it carries one.
 * `ErrorResponse` from @azure/cosmos exposes the failed operation's charge as a
 * numeric `requestCharge`. Only that number is read — never the error's text,
 * which can carry the account endpoint.
 */
export function requestChargeOfError(error: unknown): number | undefined {
  const charge = (error as { requestCharge?: unknown } | null | undefined)?.requestCharge;
  return typeof charge === 'number' && Number.isFinite(charge) ? charge : undefined;
}
