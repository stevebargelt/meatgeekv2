import { createHash } from 'node:crypto';

import type { Container, ItemResponse } from '@azure/cosmos';

import { getCosmosAdapter } from './cosmos-adapter';

/**
 * #244 — the phones a user's alerts go to: each phone's APNs device token,
 * registered by the iOS app for the signed-in user.
 *
 * WHERE. One document per user in the users container, id
 * `push-tokens:<userId>`. The container is partitioned on `/id`, so the
 * document is its own partition and every operation is a point read or write;
 * no new container (and no Terraform) is needed. The users repository reads
 * only the document whose id is the user id itself, and never queries the
 * container, so it never sees this one. A user id is `"<tid>:<oid>"`, so no
 * user id can begin with `push-tokens:`.
 *
 * IDS, NOT TOKENS. A token is a delivery address: it is never returned, never
 * put in a URL and never logged. Each is known outside this file by its id,
 * the SHA-256 of the token in hex, which the app can compute itself and which
 * says nothing about the token.
 *
 * WRITES. Read, change, replace with If-Match; on a 412 (another phone wrote
 * in between) the change runs again on the new version, a bounded number of
 * times. A user keeps at most {@link MAX_PUSH_TOKENS_PER_USER} tokens; a new
 * one past that drops the least recently registered.
 *
 * Nothing here puts a token, a user id or Cosmos text in an error or a log.
 */

/** A token as APNs issues it: hex, 32 bytes today. Apple says the length can change. */
export const PUSH_TOKEN_PATTERN = /^[0-9a-fA-F]{64,200}$/;

/** A token id: the SHA-256 of the token, in lowercase hex. */
export const PUSH_TOKEN_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Phones per user. A user with more phones than this is not a case to design for. */
export const MAX_PUSH_TOKENS_PER_USER = 10;

/** Read-change-replace attempts on contention. */
export const PUSH_TOKENS_MAX_ATTEMPTS = 3;

export interface StoredPushToken {
  readonly id: string;
  readonly token: string;
  readonly registeredAt: string;
}

interface PushTokensDocument {
  readonly id: string;
  readonly userId: string;
  readonly tokens: StoredPushToken[];
}

/** What a caller sees of a registered token. */
export interface PushTokenSummary {
  readonly id: string;
  readonly registeredAt: string;
}

/** The id of a token: SHA-256 in hex. Tokens are case-insensitive hex. */
export function pushTokenId(token: string): string {
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}

export function pushTokensDocumentId(userId: string): string {
  return `push-tokens:${userId}`;
}

function statusCodeOf(error: unknown): number | undefined {
  const reported = error as { code?: unknown; statusCode?: unknown } | null | undefined;
  for (const value of [reported?.statusCode, reported?.code]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function chargeOf(error: unknown): number {
  const charge = (error as { requestCharge?: unknown } | null | undefined)?.requestCharge;
  return typeof charge === 'number' && Number.isFinite(charge) ? charge : 0;
}

/** A failed push-token operation: the numeric status and RU, no Cosmos text. */
export class PushTokensStoreError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly requestCharge: number
  ) {
    super('push tokens store operation failed');
    this.name = 'PushTokensStoreError';
  }
}

function summaryOf(token: StoredPushToken): PushTokenSummary {
  return { id: token.id, registeredAt: token.registeredAt };
}

function isStoredToken(value: unknown): value is StoredPushToken {
  const token = value as Partial<StoredPushToken> | null;
  return (
    typeof token?.id === 'string' &&
    typeof token.token === 'string' &&
    typeof token.registeredAt === 'string'
  );
}

export class PushTokensRepository {
  constructor(
    private readonly container: Container,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async read(
    userId: string
  ): Promise<{ tokens: StoredPushToken[]; etag?: string; exists: boolean; requestCharge: number }> {
    const id = pushTokensDocumentId(userId);
    try {
      const response: ItemResponse<PushTokensDocument> = await this.container
        .item(id, id)
        .read<PushTokensDocument>();
      if (response.statusCode === 404 || response.resource === undefined) {
        return { tokens: [], exists: false, requestCharge: response.requestCharge };
      }
      const stored = Array.isArray(response.resource.tokens) ? response.resource.tokens : [];
      return {
        tokens: stored.filter(isStoredToken),
        etag: response.etag,
        exists: true,
        requestCharge: response.requestCharge,
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) {
        return { tokens: [], exists: false, requestCharge: chargeOf(error) };
      }
      throw new PushTokensStoreError(statusCodeOf(error), chargeOf(error));
    }
  }

  /**
   * Runs `change` on the stored tokens and writes the result, unless it
   * returns `undefined` (nothing to write). Retries on 412 and on a 409 from
   * two first registrations racing.
   */
  private async update(
    userId: string,
    change: (tokens: StoredPushToken[]) => StoredPushToken[] | undefined
  ): Promise<{ tokens: StoredPushToken[]; requestCharge: number }> {
    const id = pushTokensDocumentId(userId);
    let requestCharge = 0;
    for (let attempt = 1; ; attempt++) {
      const current = await this.read(userId);
      requestCharge += current.requestCharge;
      const next = change(current.tokens);
      if (next === undefined) {
        return { tokens: current.tokens, requestCharge };
      }
      const document: PushTokensDocument = { id, userId, tokens: next };
      try {
        const response = current.exists
          ? await this.container
              .item(id, id)
              .replace<PushTokensDocument>(
                document,
                current.etag
                  ? { accessCondition: { type: 'IfMatch', condition: current.etag } }
                  : undefined
              )
          : await this.container.items.create<PushTokensDocument>(document);
        requestCharge += response.requestCharge;
        return { tokens: next, requestCharge };
      } catch (error) {
        const status = statusCodeOf(error);
        requestCharge += chargeOf(error);
        if ((status === 412 || status === 409) && attempt < PUSH_TOKENS_MAX_ATTEMPTS) {
          continue;
        }
        throw new PushTokensStoreError(status, requestCharge);
      }
    }
  }

  /** The user's tokens, for sending. Never returned to a caller. */
  async listTokens(userId: string): Promise<{ tokens: StoredPushToken[]; requestCharge: number }> {
    const { tokens, requestCharge } = await this.read(userId);
    return { tokens, requestCharge };
  }

  /** The user's tokens as a caller may see them: ids and times only. */
  async listSummaries(
    userId: string
  ): Promise<{ tokens: PushTokenSummary[]; requestCharge: number }> {
    const { tokens, requestCharge } = await this.read(userId);
    return { tokens: tokens.map(summaryOf), requestCharge };
  }

  /**
   * Registers `token` for `userId`. Registering a token again moves its
   * `registeredAt` to now. `created` is false when it was already registered.
   */
  async register(
    userId: string,
    token: string
  ): Promise<{ token: PushTokenSummary; created: boolean; requestCharge: number }> {
    const normalized = token.toLowerCase();
    const id = pushTokenId(normalized);
    const registeredAt = this.now().toISOString();
    let created = true;
    const result = await this.update(userId, tokens => {
      created = !tokens.some(t => t.id === id);
      const others = tokens.filter(t => t.id !== id);
      const kept = [...others]
        .sort((a, b) => Date.parse(b.registeredAt) - Date.parse(a.registeredAt))
        .slice(0, MAX_PUSH_TOKENS_PER_USER - 1);
      return [...kept, { id, token: normalized, registeredAt }];
    });
    return { token: { id, registeredAt }, created, requestCharge: result.requestCharge };
  }

  /** Removes the token with this id. Removing one that is not there is not an error. */
  async remove(
    userId: string,
    tokenId: string
  ): Promise<{ removed: boolean; requestCharge: number }> {
    let removed = false;
    const result = await this.update(userId, tokens => {
      const kept = tokens.filter(t => t.id !== tokenId);
      removed = kept.length !== tokens.length;
      return removed ? kept : undefined;
    });
    return { removed, requestCharge: result.requestCharge };
  }
}

export function getPushTokensRepository(): PushTokensRepository {
  return new PushTokensRepository(getCosmosAdapter().getUsersContainer());
}
