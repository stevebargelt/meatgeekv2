import type { AccountInfo } from '@azure/msal-browser';
import type { Cook, Device } from '../api/client';
import type { AppConfig } from '../config/config';

export const TEST_CONFIG: AppConfig = {
  apiBaseUrl: 'https://api.example.test/api',
  tenantId: '7466b411-ac2e-49a0-b5d5-b1e866d26bac',
  clientId: '11111111-2222-3333-4444-555555555555',
  apiScope: 'api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user',
};

export const TEST_ACCOUNT = {
  homeAccountId: 'oid.tid',
  environment: 'login.microsoftonline.com',
  tenantId: TEST_CONFIG.tenantId,
  username: 'pitmaster@example.com',
  localAccountId: 'oid',
  name: 'Pat Pitmaster',
} as AccountInfo;

/** The slice of PublicClientApplication the app calls, as jest mocks. */
export function createFakeMsal(account: AccountInfo | null = TEST_ACCOUNT) {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    getActiveAccount: jest.fn(() => account),
    getAllAccounts: jest.fn(() => (account ? [account] : [])),
    setActiveAccount: jest.fn(),
    addEventCallback: jest.fn(),
    loginRedirect: jest.fn().mockResolvedValue(undefined),
    logoutRedirect: jest.fn().mockResolvedValue(undefined),
    acquireTokenSilent: jest.fn().mockResolvedValue({ accessToken: 'token-from-silent' }),
    acquireTokenRedirect: jest.fn().mockResolvedValue(undefined),
  };
}

export type FakeMsal = ReturnType<typeof createFakeMsal>;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

/**
 * Installs a fake global fetch. `respond` decides each answer; every request
 * the app sends is recorded with its parsed JSON body.
 */
export function installFetch(respond: (req: RecordedRequest) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetchMock = jest.fn(async (input: Request) => {
    const text = await input.clone().text();
    const recorded: RecordedRequest = {
      method: input.method,
      url: input.url,
      headers: input.headers,
      body: text === '' ? undefined : JSON.parse(text),
    };
    requests.push(recorded);
    return respond(recorded);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { requests, fetchMock };
}

export const BRISKET_BOX: Device = {
  id: 'meatgeek3',
  userId: 'tid:oid',
  name: 'Brisket Box',
  model: 'MeatGeek V1',
  location: 'Backyard',
  isActive: true,
  connectionStatus: 'online',
};

export const OFFSET: Device = {
  ...BRISKET_BOX,
  id: 'offset-1',
  name: 'Offset',
  location: undefined,
};

/** A cook as the API returns it; override any field. */
export function makeCook(overrides: Partial<Cook> = {}): Cook {
  return {
    id: '0b6f1d2e-6a51-4c3e-9f6e-8a1d2c3b4a5f',
    userId: 'tid:oid',
    deviceId: BRISKET_BOX.id,
    name: 'Saturday brisket',
    meatType: 'brisket',
    status: 'active',
    startTime: '2026-11-20T14:00:00.000Z',
    ...overrides,
  };
}

/** The path and query of a recorded request, relative to the API base URL. */
export function apiPath(req: RecordedRequest): string {
  const url = new URL(req.url);
  return url.pathname.replace(new URL(TEST_CONFIG.apiBaseUrl).pathname, '') + url.search;
}
