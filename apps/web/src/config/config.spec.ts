import { parseConfig } from './config';

const VALID = {
  apiBaseUrl: 'https://example.test/api/',
  tenantId: 'tenant',
  clientId: 'client',
  apiScope: 'api://x/access_as_user',
};

describe('parseConfig', () => {
  it('accepts a complete config and drops a trailing slash from apiBaseUrl', () => {
    expect(parseConfig(VALID)).toEqual({
      kind: 'ready',
      config: { ...VALID, apiBaseUrl: 'https://example.test/api' },
    });
  });

  it('treats an empty clientId as not configured, not invalid', () => {
    expect(parseConfig({ ...VALID, clientId: '' }).kind).toBe('not-configured');
  });

  describe('the committed public/config.json', () => {
    // This is the file Vercel serves. If it slides back to an empty clientId,
    // production sign-in switches off silently; these tests make it loud.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const committed = require('../../public/config.json');
    const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it('has a GUID clientId', () => {
      expect(committed.clientId).toMatch(GUID);
    });

    it('points at the MeatGeek tenant', () => {
      expect(committed.tenantId).toBe('7466b411-ac2e-49a0-b5d5-b1e866d26bac');
    });

    it("asks for the API's delegated scope", () => {
      expect(committed.apiScope).toBe(
        'api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user'
      );
    });

    it('parses as ready, so sign-in is switched on', () => {
      expect(parseConfig(committed).kind).toBe('ready');
    });
  });

  it.each([
    [null, 'config.json is not a JSON object.'],
    [[], 'config.json is not a JSON object.'],
    [{ ...VALID, apiBaseUrl: 'not a url' }, '"apiBaseUrl" is not an http(s) URL: not a url'],
    [{ ...VALID, apiScope: '  ' }, '"apiScope" is missing or empty.'],
  ])('rejects %p', (raw, problem) => {
    expect(parseConfig(raw)).toEqual({ kind: 'invalid', problems: [problem] });
  });
});
