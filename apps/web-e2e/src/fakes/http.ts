import type { Route } from '@playwright/test';

/**
 * CORS headers for a faked cross-origin response. The app's origin
 * (http://localhost:4300) calls api.test, hub.test and login.microsoftonline.com
 * from the page, so the browser applies CORS to the fakes' answers exactly as
 * it would to the real services'. SignalR's negotiate sends credentials, so the
 * origin is echoed rather than `*`.
 */
export function corsHeaders(route: Route): Record<string, string> {
  const headers = route.request().headers();
  const origin = headers['origin'];
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': headers['access-control-request-headers'] ?? '*',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/** Answers a CORS preflight, if the browser sends one through the route. */
export async function fulfillPreflight(route: Route): Promise<void> {
  await route.fulfill({ status: 204, headers: corsHeaders(route) });
}

export async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(route),
    body: JSON.stringify(body),
  });
}

/** base64url without padding, as JWTs and PKCE use it. */
export function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}
