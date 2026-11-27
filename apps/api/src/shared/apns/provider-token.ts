import type { MessageSigner } from './key-vault-signer';

/**
 * #243 — the APNs provider token: an ES256 JWT `{alg, kid}.{iss, iat}` signed
 * through Key Vault.
 *
 * Apple refuses a token older than 60 minutes and answers
 * `TooManyProviderTokenUpdates` when a provider mints one more often than every
 * 20 minutes. The token is cached per instance and replaced once it is
 * {@link PROVIDER_TOKEN_REFRESH_MS} old (30 minutes, inside both limits).
 * Concurrent callers share one signing call.
 */

export const PROVIDER_TOKEN_REFRESH_MS = 30 * 60 * 1000;

export interface ProviderTokenOptions {
  readonly signer: MessageSigner;
  readonly keyId: string;
  readonly teamId: string;
  /** Milliseconds since the epoch. Injected so tests own the clock. */
  readonly now: () => number;
}

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export class ProviderTokenCache {
  private cached: { token: string; issuedAtMs: number } | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(private readonly options: ProviderTokenOptions) {}

  async get(): Promise<string> {
    const nowMs = this.options.now();
    if (this.cached && nowMs - this.cached.issuedAtMs < PROVIDER_TOKEN_REFRESH_MS) {
      return this.cached.token;
    }
    this.inFlight ??= this.mint(nowMs).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async mint(nowMs: number): Promise<string> {
    const signingInput = `${b64url({ alg: 'ES256', kid: this.options.keyId })}.${b64url({
      iss: this.options.teamId,
      iat: Math.floor(nowMs / 1000),
    })}`;
    const signature = await this.options.signer.signEs256(signingInput);
    const token = `${signingInput}.${signature.toString('base64url')}`;
    this.cached = { token, issuedAtMs: nowMs };
    return token;
  }
}
