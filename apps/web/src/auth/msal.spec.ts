/**
 * @jest-environment-options {"url": "https://meatgeekv2-web.vercel.app/cooks/abc?tab=chart#top"}
 */
import type { Configuration } from '@azure/msal-browser';
import { createMsalInstance } from './msal';

const mockConstructed: Configuration[] = [];

jest.mock('@azure/msal-browser', () => {
  const actual = jest.requireActual('@azure/msal-browser');
  return {
    ...actual,
    PublicClientApplication: jest.fn().mockImplementation((config: Configuration) => {
      mockConstructed.push(config);
      return { addEventCallback: jest.fn() };
    }),
  };
});

const CONFIG = {
  apiBaseUrl: 'https://example.test/api',
  tenantId: '7466b411-ac2e-49a0-b5d5-b1e866d26bac',
  clientId: '508bb3be-30f9-4b03-8d95-93e086de85e1',
  apiScope: 'api://x/access_as_user',
};

describe('createMsalInstance', () => {
  beforeEach(() => {
    mockConstructed.length = 0;
  });

  // Entra matches redirect URIs exactly. The registered ones are
  // https://meatgeekv2-web.vercel.app and http://localhost:3000: no path, no
  // trailing slash. Using the page's full URL, or adding a slash, gives AADSTS50011.
  it('redirects to the bare origin, with no path and no trailing slash', () => {
    createMsalInstance(CONFIG);

    const redirectUri = mockConstructed[0]?.auth.redirectUri;
    expect(redirectUri).toBe(window.location.origin);
    expect(redirectUri).toBe('https://meatgeekv2-web.vercel.app');
    expect(redirectUri).not.toMatch(/\/$/);
  });

  it('uses the configured client id and tenant authority', () => {
    createMsalInstance(CONFIG);

    expect(mockConstructed[0]?.auth.clientId).toBe(CONFIG.clientId);
    expect(mockConstructed[0]?.auth.authority).toBe(
      'https://login.microsoftonline.com/7466b411-ac2e-49a0-b5d5-b1e866d26bac'
    );
  });
});
