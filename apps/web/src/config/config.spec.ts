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

  it('accepts the committed public/config.json shape', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const committed = require('../../public/config.json');
    expect(parseConfig(committed).kind).toBe('not-configured');
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
