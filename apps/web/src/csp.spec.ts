import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Content-Security-Policy Vercel sends (repo-root vercel.json) must let
 * the app reach the API named in public/config.json. If either file changes
 * alone, this fails before the deployed app silently loses the API.
 */
const vercel = JSON.parse(readFileSync(resolve(__dirname, '../../../vercel.json'), 'utf8')) as {
  headers?: { source: string; headers: { key: string; value: string }[] }[];
};
const config = JSON.parse(readFileSync(resolve(__dirname, '../public/config.json'), 'utf8')) as {
  apiBaseUrl: string;
};

function csp(): Map<string, string[]> {
  const rule = vercel.headers?.find(entry => entry.source === '/(.*)');
  const header = rule?.headers.find(h => h.key.toLowerCase() === 'content-security-policy');
  if (!header) throw new Error('vercel.json has no Content-Security-Policy header for /(.*)');
  const directives = new Map<string, string[]>();
  for (const part of header.value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

const SIGN_IN = 'https://login.microsoftonline.com';
const SIGNALR = ['https://*.service.signalr.net', 'wss://*.service.signalr.net'];

describe('Content-Security-Policy (vercel.json)', () => {
  it("allows exactly one API origin in connect-src, and it is config.json's apiBaseUrl origin", () => {
    const connect = csp().get('connect-src') ?? [];
    const apiOrigins = connect.filter(
      source => source !== "'self'" && source !== SIGN_IN && !SIGNALR.includes(source)
    );
    expect(apiOrigins).toEqual([new URL(config.apiBaseUrl).origin]);
  });

  it('allows sign-in and SignalR, and nothing else beyond self', () => {
    const directives = csp();
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('connect-src')).toEqual(
      expect.arrayContaining(["'self'", SIGN_IN, ...SIGNALR])
    );
    // 'self' because Entra redirects MSAL's silent-renew iframe back to
    // redirectUri (window.location.origin); without it the iframe is blocked.
    expect(directives.get('frame-src')).toEqual(["'self'", SIGN_IN]);
    expect(directives.get('img-src')).toEqual(["'self'", 'data:']);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.has('script-src')).toBe(false);
    expect(directives.has('style-src')).toBe(false);
  });
});
