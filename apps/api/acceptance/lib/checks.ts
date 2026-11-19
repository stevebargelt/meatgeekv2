import type { AcceptanceApi, AcceptanceResponse } from './proof';

/**
 * Response checks more than one proof file makes. Proofs import them from here
 * rather than each carrying a copy.
 */

/** Every key at any depth that starts with `_` (a Cosmos system property). */
export function underscoreKeys(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => underscoreKeys(item, `${at}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, member]) => [
      ...(key.startsWith('_') ? [`${at}.${key}`] : []),
      ...underscoreKeys(member, `${at}.${key}`),
    ]);
  }
  return [];
}

/** Fail if the body carries a Cosmos system property at any depth. */
export function expectNoSystemProperties(api: AcceptanceApi, response: AcceptanceResponse): void {
  const leaked = underscoreKeys(response.body);
  api.check(
    response,
    leaked.length === 0,
    `body carries Cosmos system properties: ${leaked.join(', ')}`
  );
}

/** Fail unless the body is the error envelope with `error` = `code`. */
export function expectErrorCode(
  api: AcceptanceApi,
  response: AcceptanceResponse,
  code: string
): void {
  const body = response.body as { error?: unknown } | null;
  api.check(
    response,
    body !== null && typeof body === 'object' && body.error === code,
    `body.error is ${JSON.stringify(body?.error)}, not ${code}`
  );
}
