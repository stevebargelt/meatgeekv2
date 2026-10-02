import type { HttpResponseInit } from '@azure/functions';

/**
 * MG-59 — the sole source of the authenticated cooks `userId`.
 *
 * WHERE THE IDENTITY COMES FROM
 * The Function App runs behind App Service Authentication ("Easy Auth"),
 * configured in Terraform via `auth_settings_v2`. Easy Auth validates the
 * inbound Entra (Azure AD) access token at the platform edge BEFORE the request
 * reaches this code, then injects the validated principal as the base64-encoded
 * JSON header `X-MS-CLIENT-PRINCIPAL`. Because the platform has already proven
 * the token, handler code trusts this header — but ONLY this header. It never
 * reads identity from the query string or the request body, where any caller
 * could assert an arbitrary `userId` and read or orphan another tenant's cooks.
 *
 * WHICH IDENTIFIER IS THE userId, AND ITS NAMESPACE
 * The stable identifier is the Entra **object id** — the `oid` claim
 * (`http://schemas.microsoft.com/identity/claims/objectidentifier`). Microsoft
 * guarantees the `oid` is immutable for the life of the account, which is what a
 * partition key needs. CRUCIALLY, an `oid` is only unique *within its Entra
 * tenant*: Microsoft does not promise it is globally unique, so it must NOT be
 * treated as a globally significant identifier. We therefore namespace it with
 * the tenant id — the `tid` claim
 * (`http://schemas.microsoft.com/identity/claims/tenantid`) — and use
 * `"<tid>:<oid>"` as the cooks partition value. The namespace travels *with* the
 * key, so a principal minted in a different tenant can never collide onto
 * another tenant's partition even if two tenants ever issued the same `oid`.
 * (Reconciling legacy V1-migrated cook userIds against this namespace is MG-81,
 * out of scope here.)
 *
 * FAIL CLOSED, NEVER FABRICATE
 * A missing, unparseable, or claim-incomplete header yields an UNAUTHENTICATED
 * result — never a default userId and never the retired `user-1` tenant. There
 * is no fallback identity.
 *
 * SANITIZED FAILURES
 * The header carries token-derived claims (object ids, tenant ids, emails,
 * names). None of it may reach an error, a log line, or a response body. This
 * module NEVER logs and NEVER embeds header/claim text in a thrown error or a
 * result: every failure is a fixed code from {@link PrincipalFailure}, chosen by
 * control flow, exactly as MG-51's cosmos-health check reports fixed codes and
 * numeric statuses only. A caller may safely log `result.reason`.
 */

/** The Easy Auth header carrying the validated, base64-encoded principal. */
export const CLIENT_PRINCIPAL_HEADER = 'x-ms-client-principal';

/**
 * Entra claim types for the object id. Easy Auth passes long-form claim URIs by
 * default; the short form appears when the token or platform emits it. Both are
 * accepted so a benign claim-shape difference is not read as "unauthenticated".
 */
const OID_CLAIM_TYPES = [
  'http://schemas.microsoft.com/identity/claims/objectidentifier',
  'oid',
] as const;

/** Entra claim types for the tenant id (the object id's namespace). */
const TID_CLAIM_TYPES = [
  'http://schemas.microsoft.com/identity/claims/tenantid',
  'tid',
] as const;

/**
 * The only failure vocabulary this helper speaks. Each code names the STEP that
 * failed; none is derived from header, token, or claim text, so a caller that
 * logs or returns the code cannot leak identity material.
 */
export type PrincipalFailure =
  | 'principal_header_missing'
  | 'principal_header_unparseable'
  | 'principal_object_id_missing'
  | 'principal_tenant_id_missing';

/** The authenticated identity a cooks handler is allowed to act on. */
export interface AuthenticatedPrincipal {
  /**
   * The cooks partition value: the tenant-namespaced Entra object id,
   * `"<tenantId>:<objectId>"`. Stable, tenant-scoped, and safe as a Cosmos
   * partition key. This is the ONLY value a handler should persist or query on.
   */
  userId: string;
  /** The raw Entra object id (`oid`) — tenant-scoped, not globally meaningful. */
  objectId: string;
  /** The Entra tenant id (`tid`) the object id belongs to; the userId namespace. */
  tenantId: string;
}

export type PrincipalResult =
  | { authenticated: true; principal: AuthenticatedPrincipal }
  | { authenticated: false; reason: PrincipalFailure };

/** The base64 JSON shape Easy Auth injects. Only `claims` is relied upon. */
interface ClientPrincipalPayload {
  auth_typ?: string;
  name_typ?: string;
  role_typ?: string;
  claims?: Array<{ typ?: string; val?: string }>;
}

function claimValue(
  claims: ReadonlyArray<{ typ?: string; val?: string }>,
  types: ReadonlyArray<string>
): string | undefined {
  for (const claim of claims) {
    if (claim?.typ && types.includes(claim.typ)) {
      const val = typeof claim.val === 'string' ? claim.val.trim() : '';
      if (val.length > 0) {
        return val;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the authenticated principal from a raw `X-MS-CLIENT-PRINCIPAL` value.
 *
 * Returns an authenticated result carrying the tenant-namespaced userId, or an
 * unauthenticated result with a fixed reason code. NEVER throws on bad input and
 * NEVER puts header/claim text in its output.
 */
export function principalFromHeaderValue(
  headerValue: string | null | undefined
): PrincipalResult {
  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) {
    return { authenticated: false, reason: 'principal_header_missing' };
  }

  let payload: ClientPrincipalPayload;
  try {
    // Base64 → UTF-8 JSON. Buffer decoding is lenient, so garbage that is not a
    // JSON object is caught by JSON.parse below and reported as unparseable —
    // never as a partial/garbage identity.
    const decoded = Buffer.from(headerValue, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    // The principal is a JSON object; a null, primitive, or array payload is not
    // the Easy Auth shape and is rejected outright rather than mined for claims.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { authenticated: false, reason: 'principal_header_unparseable' };
    }
    payload = parsed as ClientPrincipalPayload;
  } catch {
    // The caught error can carry a fragment of the (secret) header; it is
    // swallowed here and replaced with a fixed code so nothing leaks.
    return { authenticated: false, reason: 'principal_header_unparseable' };
  }

  const claims = Array.isArray(payload.claims) ? payload.claims : [];

  const objectId = claimValue(claims, OID_CLAIM_TYPES);
  if (!objectId) {
    return { authenticated: false, reason: 'principal_object_id_missing' };
  }

  const tenantId = claimValue(claims, TID_CLAIM_TYPES);
  if (!tenantId) {
    return { authenticated: false, reason: 'principal_tenant_id_missing' };
  }

  return {
    authenticated: true,
    principal: {
      userId: `${tenantId}:${objectId}`,
      objectId,
      tenantId,
    },
  };
}

/** Minimal header accessor a Functions `HttpRequest` satisfies. */
export interface HeaderReader {
  headers: { get(name: string): string | null };
}

/**
 * Resolve the authenticated principal from an incoming request. Reads ONLY the
 * Easy Auth header — never query params or the body.
 */
export function principalFromRequest(request: HeaderReader): PrincipalResult {
  return principalFromHeaderValue(request.headers.get(CLIENT_PRINCIPAL_HEADER));
}

/**
 * The single, sanitized 401 a cooks handler returns when the request is not
 * authenticated. The body carries the fixed reason code and the request id
 * only — no identity material, matching MG-51's allowlisted-projection
 * discipline. Centralised here so every cooks route rejects identically.
 */
export function unauthenticatedResponse(
  reason: PrincipalFailure,
  requestId: string
): HttpResponseInit {
  return {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
    },
    jsonBody: {
      error: 'UNAUTHENTICATED',
      reason,
      requestId,
    },
  };
}
