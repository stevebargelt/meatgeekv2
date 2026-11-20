/**
 * Runtime configuration, fetched from `/config.json` before the app renders.
 * The committed file is apps/web/public/config.json. None of these values is
 * a secret: they are public client and tenant identifiers.
 */
export interface AppConfig {
  /** Base URL of the API, including the `/api` prefix. */
  apiBaseUrl: string;
  /** Entra tenant id; the MSAL authority is login.microsoftonline.com/<tenantId>. */
  tenantId: string;
  /** SPA app registration client id. Empty until that registration exists. */
  clientId: string;
  /** The API's delegated scope, e.g. api://<api-app-id>/access_as_user. */
  apiScope: string;
}

export type ConfigResult =
  | { kind: 'ready'; config: AppConfig }
  | { kind: 'not-configured'; config: AppConfig }
  | { kind: 'invalid'; problems: string[] };

const REQUIRED_NON_EMPTY = ['apiBaseUrl', 'tenantId', 'apiScope'] as const;

/** Checks the shape of a parsed config.json and lists every problem found. */
export function parseConfig(raw: unknown): ConfigResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'invalid', problems: ['config.json is not a JSON object.'] };
  }
  const value = raw as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of REQUIRED_NON_EMPTY) {
    const field = value[key];
    if (typeof field !== 'string' || field.trim() === '') {
      problems.push(`"${key}" is missing or empty.`);
    }
  }
  if (typeof value['clientId'] !== 'string') {
    problems.push('"clientId" is missing or not a string.');
  }
  const apiBaseUrl = value['apiBaseUrl'];
  if (typeof apiBaseUrl === 'string' && apiBaseUrl.trim() !== '' && !isHttpUrl(apiBaseUrl)) {
    problems.push(`"apiBaseUrl" is not an http(s) URL: ${apiBaseUrl}`);
  }
  if (problems.length > 0) {
    return { kind: 'invalid', problems };
  }

  const config: AppConfig = {
    apiBaseUrl: (apiBaseUrl as string).trim().replace(/\/+$/, ''),
    tenantId: (value['tenantId'] as string).trim(),
    clientId: (value['clientId'] as string).trim(),
    apiScope: (value['apiScope'] as string).trim(),
  };
  return config.clientId === '' ? { kind: 'not-configured', config } : { kind: 'ready', config };
}

/** Fetches and validates `/config.json`. Never throws. */
export async function loadConfig(
  fetchFn: typeof fetch = (input, init) => fetch(input, init)
): Promise<ConfigResult> {
  let response: Response;
  try {
    response = await fetchFn('/config.json', { cache: 'no-store' });
  } catch (err) {
    return { kind: 'invalid', problems: [`Could not fetch /config.json: ${describe(err)}`] };
  }
  if (!response.ok) {
    return {
      kind: 'invalid',
      problems: [`/config.json answered HTTP ${response.status}.`],
    };
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    return { kind: 'invalid', problems: [`/config.json is not valid JSON: ${describe(err)}`] };
  }
  return parseConfig(raw);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
