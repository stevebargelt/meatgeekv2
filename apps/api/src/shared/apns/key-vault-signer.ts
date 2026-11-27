import { createHash } from 'node:crypto';
import type { TokenCredential } from '@azure/core-auth';

/**
 * #243 — signs an ES256 message with a Key Vault key, under the caller's
 * credential. The key never leaves the vault: Key Vault gets a SHA-256 digest
 * and answers with the raw 64-byte signature (R || S), which is exactly the
 * form a JWT carries.
 *
 * NO SDK: one REST call, spoken with fetch like the other Azure clients here.
 *
 * SANITIZED FAILURES: {@link KeyVaultSignError} carries a fixed code and the
 * vault's numeric status, never a token, a URL or the vault's error text.
 */

export const KEY_VAULT_TOKEN_SCOPE = 'https://vault.azure.net/.default';
export const KEY_VAULT_API_VERSION = '7.4';
const REQUEST_TIMEOUT_MS = 10_000;

export type KeyVaultSignFailure =
  | 'key_vault_token_failed'
  | 'key_vault_sign_failed'
  | 'key_vault_bad_signature';

export class KeyVaultSignError extends Error {
  constructor(
    readonly code: KeyVaultSignFailure,
    readonly status?: number
  ) {
    super(code);
    this.name = 'KeyVaultSignError';
  }
}

/** Signs a message; resolves the raw ES256 signature (64 bytes, R || S). */
export interface MessageSigner {
  signEs256(message: string): Promise<Buffer>;
}

export interface KeyVaultSignerOptions {
  readonly vaultUri: string;
  readonly keyName: string;
  readonly credential: TokenCredential;
  readonly fetchFn?: typeof fetch;
}

export class KeyVaultSigner implements MessageSigner {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: KeyVaultSignerOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async signEs256(message: string): Promise<Buffer> {
    let token: string;
    try {
      const accessToken = await this.options.credential.getToken(KEY_VAULT_TOKEN_SCOPE);
      if (!accessToken) {
        throw new Error('no token');
      }
      token = accessToken.token;
    } catch {
      throw new KeyVaultSignError('key_vault_token_failed');
    }

    const base = this.options.vaultUri.replace(/\/+$/, '');
    // An empty key version in the path (the double slash): Key Vault signs with
    // the key's current version, as the Azure SDK's own client does.
    const url = `${base}/keys/${encodeURIComponent(this.options.keyName)}//sign?api-version=${KEY_VAULT_API_VERSION}`;
    const digest = createHash('sha256').update(message).digest().toString('base64url');

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ alg: 'ES256', value: digest }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new KeyVaultSignError('key_vault_sign_failed');
    }
    if (!response.ok) {
      throw new KeyVaultSignError('key_vault_sign_failed', response.status);
    }

    let value: unknown;
    try {
      value = ((await response.json()) as { value?: unknown }).value;
    } catch {
      throw new KeyVaultSignError('key_vault_bad_signature', response.status);
    }
    const signature =
      typeof value === 'string' ? Buffer.from(value, 'base64url') : Buffer.alloc(0);
    if (signature.length !== 64) {
      throw new KeyVaultSignError('key_vault_bad_signature', response.status);
    }
    return signature;
  }
}
