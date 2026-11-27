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
 * ONE HOLDER PER PHONE. A token belongs to the account that registered it
 * last: a second document, id `push-token-owner:<tokenId>`, names the user
 * that holds it. Registering a token another user holds moves it: the token
 * leaves the other user's document first, then the owner document changes, so
 * a phone signed in to a new account stops getting the old account's alerts,
 * and a move that failed halfway finishes at the phone's next registration.
 * Removing a token, or dropping it for an eleventh phone, forgets its owner
 * when that is the user. A token
 * registered before this document existed gets one at its next registration
 * (the app registers on every launch).
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

/** The id of the document naming the user that holds a token. */
export function pushTokenOwnerDocumentId(tokenId: string): string {
  return `push-token-owner:${tokenId}`;
}

interface PushTokenOwnerDocument {
  readonly id: string;
  readonly tokenId: string;
  readonly userId: string;
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

  private async readOwner(
    tokenId: string
  ): Promise<{ userId?: string; etag?: string; requestCharge: number }> {
    const id = pushTokenOwnerDocumentId(tokenId);
    try {
      const response: ItemResponse<PushTokenOwnerDocument> = await this.container
        .item(id, id)
        .read<PushTokenOwnerDocument>();
      if (response.statusCode === 404 || response.resource === undefined) {
        return { requestCharge: response.requestCharge };
      }
      const userId = response.resource.userId;
      return {
        userId: typeof userId === 'string' ? userId : '',
        etag: response.etag,
        requestCharge: response.requestCharge,
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) {
        return { requestCharge: chargeOf(error) };
      }
      throw new PushTokensStoreError(statusCodeOf(error), chargeOf(error));
    }
  }

  /**
   * Makes `userId` the holder of `tokenId`. The token leaves the previous
   * holder's document before the owner document names `userId`, so a failure
   * in between leaves the previous holder named, and the next registration
   * finishes the move.
   */
  private async claimOwner(tokenId: string, userId: string): Promise<{ requestCharge: number }> {
    const id = pushTokenOwnerDocumentId(tokenId);
    const document: PushTokenOwnerDocument = { id, tokenId, userId };
    let requestCharge = 0;
    for (let attempt = 1; ; attempt++) {
      const current = await this.readOwner(tokenId);
      requestCharge += current.requestCharge;
      if (current.userId === userId) {
        return { requestCharge };
      }
      if (current.userId !== undefined && current.userId !== '') {
        const taken = await this.removeFromUser(current.userId, tokenId);
        requestCharge += taken.requestCharge;
      }
      try {
        const response =
          current.userId !== undefined
            ? await this.container
                .item(id, id)
                .replace<PushTokenOwnerDocument>(
                  document,
                  current.etag
                    ? { accessCondition: { type: 'IfMatch', condition: current.etag } }
                    : undefined
                )
            : await this.container.items.create<PushTokenOwnerDocument>(document);
        requestCharge += response.requestCharge;
        return { requestCharge };
      } catch (error) {
        const status = statusCodeOf(error);
        requestCharge += chargeOf(error);
        if (
          (status === 412 || status === 409 || status === 404) &&
          attempt < PUSH_TOKENS_MAX_ATTEMPTS
        ) {
          continue;
        }
        throw new PushTokensStoreError(status, requestCharge);
      }
    }
  }

  /** Forgets who holds `tokenId`, when it is `userId`. */
  private async releaseOwner(tokenId: string, userId: string): Promise<number> {
    const current = await this.readOwner(tokenId);
    if (current.userId !== userId) {
      return current.requestCharge;
    }
    const id = pushTokenOwnerDocumentId(tokenId);
    try {
      const response = await this.container
        .item(id, id)
        .delete(
          current.etag
            ? { accessCondition: { type: 'IfMatch', condition: current.etag } }
            : undefined
        );
      return current.requestCharge + response.requestCharge;
    } catch (error) {
      const status = statusCodeOf(error);
      // Gone already, or another user took it over in between: theirs now.
      if (status === 404 || status === 412) {
        return current.requestCharge + chargeOf(error);
      }
      throw new PushTokensStoreError(status, current.requestCharge + chargeOf(error));
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
   * A token another user holds moves to `userId`: it leaves their document.
   */
  async register(
    userId: string,
    token: string
  ): Promise<{ token: PushTokenSummary; created: boolean; requestCharge: number }> {
    const normalized = token.toLowerCase();
    const id = pushTokenId(normalized);
    const registeredAt = this.now().toISOString();
    let created = true;
    let dropped: string[] = [];
    const result = await this.update(userId, tokens => {
      created = !tokens.some(t => t.id === id);
      const others = [...tokens.filter(t => t.id !== id)].sort(
        (a, b) => Date.parse(b.registeredAt) - Date.parse(a.registeredAt)
      );
      const kept = others.slice(0, MAX_PUSH_TOKENS_PER_USER - 1);
      dropped = others.slice(MAX_PUSH_TOKENS_PER_USER - 1).map(t => t.id);
      return [...kept, { id, token: normalized, registeredAt }];
    });
    let requestCharge = result.requestCharge;
    requestCharge += (await this.claimOwner(id, userId)).requestCharge;
    for (const droppedId of dropped) {
      requestCharge += await this.releaseOwner(droppedId, userId);
    }
    return { token: { id, registeredAt }, created, requestCharge };
  }

  /**
   * Removes the token with this id, and forgets its holder when that is
   * `userId`. Removing one that is not there is not an error.
   */
  async remove(
    userId: string,
    tokenId: string
  ): Promise<{ removed: boolean; requestCharge: number }> {
    const result = await this.removeFromUser(userId, tokenId);
    const released = await this.releaseOwner(tokenId, userId);
    return { removed: result.removed, requestCharge: result.requestCharge + released };
  }

  private async removeFromUser(
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
