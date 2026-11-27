/**
 * #243 — the APNs path: Key Vault signing, the provider-token cache, the
 * client over the transport seam, the HTTP/2 transport against a local h2c
 * server, and the config. No Azure, no Apple, no clock: the cache's clock is a
 * variable.
 */
import { createServer, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import type { TokenCredential } from '@azure/core-auth';

import { ApnsClient } from './apns-client';
import { ApnsConfigError, readApnsConfig } from './apns-config';
import { Http2ApnsTransport, type ApnsRequest, type ApnsTransport } from './apns-transport';
import {
  KEY_VAULT_API_VERSION,
  KEY_VAULT_TOKEN_SCOPE,
  KeyVaultSignError,
  KeyVaultSigner,
  type MessageSigner,
} from './key-vault-signer';
import { PROVIDER_TOKEN_REFRESH_MS, ProviderTokenCache } from './provider-token';

const MIN = 60 * 1000;
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');

function countingSigner(): MessageSigner & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    async signEs256(message) {
      messages.push(message);
      return Buffer.alloc(64, 7);
    },
  };
}

describe('ProviderTokenCache', () => {
  it('signs an ES256 JWT with kid, iss and iat', async () => {
    const signer = countingSigner();
    const cache = new ProviderTokenCache({
      signer,
      keyId: 'KEYID12345',
      teamId: 'TEAMID1234',
      now: () => BASE_MS,
    });
    const [header, claims, signature] = (await cache.get()).split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEYID12345',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'TEAMID1234',
      iat: BASE_MS / 1000,
    });
    expect(Buffer.from(signature, 'base64url')).toEqual(Buffer.alloc(64, 7));
    expect(signer.messages).toEqual([`${header}.${claims}`]);
  });

  it('refreshes no more often than every 20 minutes and at least every 60', () => {
    expect(PROVIDER_TOKEN_REFRESH_MS).toBeGreaterThanOrEqual(20 * MIN);
    expect(PROVIDER_TOKEN_REFRESH_MS).toBeLessThanOrEqual(60 * MIN);
  });

  it('reuses the token until it is old enough, then signs again', async () => {
    const signer = countingSigner();
    let now = BASE_MS;
    const cache = new ProviderTokenCache({ signer, keyId: 'K', teamId: 'T', now: () => now });

    const first = await cache.get();
    now += PROVIDER_TOKEN_REFRESH_MS - 1;
    expect(await cache.get()).toBe(first);
    expect(signer.messages).toHaveLength(1);

    now += 1;
    const second = await cache.get();
    expect(second).not.toBe(first);
    expect(signer.messages).toHaveLength(2);
  });

  it('shares one signing call between concurrent callers', async () => {
    const signer = countingSigner();
    const cache = new ProviderTokenCache({ signer, keyId: 'K', teamId: 'T', now: () => BASE_MS });
    const tokens = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(new Set(tokens).size).toBe(1);
    expect(signer.messages).toHaveLength(1);
  });

  it('does not cache a failed signing', async () => {
    let fail = true;
    const signer: MessageSigner = {
      async signEs256() {
        if (fail) throw new KeyVaultSignError('key_vault_sign_failed', 403);
        return Buffer.alloc(64);
      },
    };
    const cache = new ProviderTokenCache({ signer, keyId: 'K', teamId: 'T', now: () => BASE_MS });
    await expect(cache.get()).rejects.toBeInstanceOf(KeyVaultSignError);
    fail = false;
    await expect(cache.get()).resolves.toEqual(expect.any(String));
  });
});

describe('KeyVaultSigner', () => {
  const credential = (token = 'entra-token'): TokenCredential & { scopes: unknown[] } => {
    const scopes: unknown[] = [];
    return {
      scopes,
      async getToken(scope) {
        scopes.push(scope);
        return { token, expiresOnTimestamp: Date.parse('2099-01-01T00:00:00.000Z') };
      },
    };
  };

  it('sends a SHA-256 digest of the message to the key and returns the raw signature', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ value: Buffer.alloc(64, 9).toString('base64url') }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const cred = credential();
    const signer = new KeyVaultSigner({
      vaultUri: 'https://vault-x.vault.azure.net/',
      keyName: 'apns-auth-key',
      credential: cred,
      fetchFn,
    });

    const signature = await signer.signEs256('header.claims');

    expect(signature).toHaveLength(64);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://vault-x.vault.azure.net/keys/apns-auth-key//sign?api-version=${KEY_VAULT_API_VERSION}`
    );
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer entra-token');
    expect(cred.scopes).toEqual([KEY_VAULT_TOKEN_SCOPE]);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.alg).toBe('ES256');
    // The vault was handed the SHA-256 digest, never the message.
    expect(Buffer.from(body.value, 'base64url')).toEqual(
      createHash('sha256').update('header.claims').digest()
    );
    expect(signature).toEqual(Buffer.alloc(64, 9));
  });

  const failing = (response: () => Response | Promise<Response>, cred = credential()) =>
    new KeyVaultSigner({
      vaultUri: 'https://vault-x.vault.azure.net/',
      keyName: 'apns-auth-key',
      credential: cred,
      fetchFn: (async () => response()) as unknown as typeof fetch,
    });

  it('reports the vault status, and nothing from its body, when the sign is refused', async () => {
    const signer = failing(() => new Response('{"error":{"message":"secret-ish text"}}', { status: 403 }));
    const error = await signer.signEs256('m').catch((e: KeyVaultSignError) => e);
    expect(error).toBeInstanceOf(KeyVaultSignError);
    expect(error).toMatchObject({ code: 'key_vault_sign_failed', status: 403 });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('refuses a signature that is not 64 bytes', async () => {
    const signer = failing(() => new Response(JSON.stringify({ value: 'AAAA' }), { status: 200 }));
    await expect(signer.signEs256('m')).rejects.toMatchObject({ code: 'key_vault_bad_signature' });
  });

  it('refuses an unreadable body', async () => {
    const signer = failing(() => new Response('not json', { status: 200 }));
    await expect(signer.signEs256('m')).rejects.toMatchObject({ code: 'key_vault_bad_signature' });
  });

  it('reports a credential failure without its text', async () => {
    const cred: TokenCredential = {
      async getToken() {
        throw new Error('token-text');
      },
    };
    const error = await failing(() => new Response('{}'), cred as never)
      .signEs256('m')
      .catch((e: KeyVaultSignError) => e);
    expect(error).toMatchObject({ code: 'key_vault_token_failed' });
    expect((error as Error).message).not.toContain('token-text');
  });

  it('reports a network failure as a sign failure', async () => {
    const signer = failing(() => {
      throw new TypeError('connect ECONNREFUSED');
    });
    await expect(signer.signEs256('m')).rejects.toMatchObject({ code: 'key_vault_sign_failed' });
  });
});

describe('ApnsClient', () => {
  function fakeTransport(answer: { status: number; body?: string; apnsId?: string }) {
    const sent: ApnsRequest[] = [];
    const transport: ApnsTransport = {
      async send(request) {
        sent.push(request);
        return { status: answer.status, body: answer.body ?? '', apnsId: answer.apnsId };
      },
    };
    return { sent, transport };
  }
  const tokens = { get: async () => 'provider.jwt.token' };

  it('sends to the device token with Apple’s headers and the provider token', async () => {
    const { sent, transport } = fakeTransport({ status: 200, apnsId: 'abc' });
    const client = new ApnsClient({
      transport,
      tokens,
      host: 'api.sandbox.push.apple.com',
      bundleId: 'com.meatgeek.ios',
    });

    const result = await client.send({
      deviceToken: 'devtok',
      pushType: 'alert',
      payload: { aps: { alert: 'hi' } },
    });

    expect(result).toEqual({ accepted: true, status: 200, apnsId: 'abc' });
    expect(sent).toEqual([
      {
        authority: 'https://api.sandbox.push.apple.com',
        deviceToken: 'devtok',
        headers: {
          authorization: 'bearer provider.jwt.token',
          'apns-topic': 'com.meatgeek.ios',
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body: '{"aps":{"alert":"hi"}}',
      },
    ]);
  });

  it('reports Apple’s reason on a refusal and never the provider token', async () => {
    const { transport } = fakeTransport({ status: 400, body: '{"reason":"BadDeviceToken"}' });
    const client = new ApnsClient({ transport, tokens, host: 'h', bundleId: 'b' });
    const result = await client.send({ deviceToken: 'x', pushType: 'alert', payload: {} });
    expect(result).toEqual({ accepted: false, status: 400, reason: 'BadDeviceToken' });
    expect(JSON.stringify(result)).not.toContain('provider.jwt.token');
  });

  it('ignores a reason that is not a plain word', async () => {
    const { transport } = fakeTransport({ status: 500, body: '{"reason":"<script>"}' });
    const client = new ApnsClient({ transport, tokens, host: 'h', bundleId: 'b' });
    expect(await client.send({ deviceToken: 'x', pushType: 'alert', payload: {} })).toEqual({
      accepted: false,
      status: 500,
    });
  });
});

describe('Http2ApnsTransport', () => {
  let server: Http2Server;
  let authority: string;
  const seen: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = createServer();
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        seen.push({ ...headers, body: Buffer.concat(chunks).toString() });
        stream.respond({ ':status': 400, 'apns-id': 'id-1' });
        stream.end('{"reason":"BadDeviceToken"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    authority = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('posts to /3/device/<token> over HTTP/2 and returns status, apns-id and body', async () => {
    const response = await new Http2ApnsTransport().send({
      authority,
      deviceToken: 'abc123',
      headers: { authorization: 'bearer t', 'apns-topic': 'com.meatgeek.ios' },
      body: '{"aps":{}}',
    });

    expect(response).toEqual({ status: 400, apnsId: 'id-1', body: '{"reason":"BadDeviceToken"}' });
    expect(seen[0]).toMatchObject({
      ':method': 'POST',
      ':path': '/3/device/abc123',
      authorization: 'bearer t',
      'apns-topic': 'com.meatgeek.ios',
      body: '{"aps":{}}',
    });
  });

  it('fails with a bare error when nothing answers', async () => {
    await expect(
      new Http2ApnsTransport().send({
        authority: 'http://127.0.0.1:1',
        deviceToken: 'x',
        headers: {},
        body: '',
      })
    ).rejects.toMatchObject({ message: 'apns_unreachable' });
  });
});

describe('readApnsConfig', () => {
  const full = {
    APNS_KEY_VAULT_URI: 'https://v.vault.azure.net/',
    APNS_KEY_NAME: 'apns-auth-key',
    APNS_KEY_ID: 'KEYID12345',
    APNS_TEAM_ID: 'TEAMID1234',
    APNS_BUNDLE_ID: 'com.meatgeek.ios',
    APNS_HOST: 'api.sandbox.push.apple.com',
  };

  it('reads the six settings', () => {
    expect(readApnsConfig(full)).toEqual({
      keyVaultUri: 'https://v.vault.azure.net/',
      keyName: 'apns-auth-key',
      keyId: 'KEYID12345',
      teamId: 'TEAMID1234',
      bundleId: 'com.meatgeek.ios',
      host: 'api.sandbox.push.apple.com',
    });
  });

  it.each(Object.keys(full))('names %s when it is missing, not its value', (name) => {
    const env: Record<string, string | undefined> = { ...full, [name]: '  ' };
    const error = (() => {
      try {
        readApnsConfig(env);
      } catch (e) {
        return e as ApnsConfigError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ApnsConfigError);
    expect(error?.code).toBe(`${name}_missing`);
  });
});
