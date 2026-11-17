import type { Container, ItemResponse, RequestOptions } from '@azure/cosmos';
import type { Cook } from '@meatgeekv2/api-interfaces';

import { getCosmosAdapter } from './cosmos-adapter';

/**
 * MG-85 — the ONE place a stored cooks document becomes an api-interfaces
 * {@link Cook}.
 *
 * Cosmos stamps every document it returns with system properties (`_rid`,
 * `_self`, `_etag`, `_attachments`, `_ts`). They are not part of the Cook
 * contract and `_rid`/`_self` expose internal Cosmos resource ids, so nothing
 * the repository hands back may carry them — not the HTTP bodies, and not the
 * SignalR envelopes built from the same cook.
 *
 * This is an ALLOW-list, not a strip-underscores deny-list: a field reaches a
 * caller only because the contract names it. The list is checked against
 * `keyof Cook` at compile time in both directions, so a field added to the
 * contract fails the type-check here until it is mapped.
 */
const COOK_FIELDS = [
  'id',
  'userId',
  'deviceId',
  'name',
  'status',
  'startTime',
  'endTime',
  'meatType',
  'weight',
  'targetTemps',
  'actualDuration',
  'maxTemps',
  'notes',
  'photos',
  'rating',
  'isPublic',
] as const satisfies readonly (keyof Cook)[];

type UnmappedCookField = Exclude<keyof Cook, (typeof COOK_FIELDS)[number]>;
/** Compile-time guard: fails if the Cook contract gains a field not listed above. */
const cookFieldsAreExhaustive: [UnmappedCookField] extends [never] ? true : never = true;
void cookFieldsAreExhaustive;

/** A cooks document as Cosmos returns it: the Cook fields PLUS whatever system
 *  (or legacy) properties the store carries at runtime, which the static type
 *  cannot see. Never returned to a caller without going through {@link toCook}. */
type StoredCook = Cook;

/**
 * Projects a stored document onto the api-interfaces Cook shape. Absent fields
 * stay absent (no `undefined` keys are introduced).
 */
export function toCook(document: StoredCook): Cook {
  const source = document as unknown as Record<string, unknown>;
  const cook: Record<string, unknown> = {};
  for (const field of COOK_FIELDS) {
    if (source[field] !== undefined) {
      cook[field] = source[field];
    }
  }
  return cook as unknown as Cook;
}

/**
 * MG-59 — the cooks data-access layer, built on the ONE shared Cosmos adapter.
 *
 * The deployed cooks container is partitioned on `/userId` (see
 * apps/infrastructure/modules/cosmos-db/main.tf — `azurerm_cosmosdb_sql_container
 * .cooks_shared`, `partition_key_paths = ["/userId"]`, and outputs.tf's
 * `destination_partition_keys.cooks = "/userId"`). Every operation here addresses
 * a document WITHIN a single user's partition:
 *
 *   - a write derives its partition value from the document's own `userId`;
 *   - a point-read passes `(id, userId)` so the SDK routes to exactly one
 *     partition instead of fanning the read across the whole container;
 *   - a list is a SINGLE-PARTITION query keyed on `userId` with a bounded page
 *     size and continuation-token pagination.
 *
 * This matters because the cooks container draws from a database-level 400 RU/s
 * shared offer that the IoT temperature-ingest path also spends against. A
 * cross-partition scan — or offset pagination, which re-charges every skipped
 * document — could exhaust that shared pool. So `userId` is the partition axis,
 * never a caller-supplied filter, and there is no `ReadAll`/cross-partition path
 * anywhere in this file.
 *
 * `userId` is supplied by the caller (the handlers derive it from the
 * authenticated Easy Auth principal — MG-59 step 3); the repository never reads
 * an identity from a request and never invents one. Nothing here puts an
 * account, database, container, credential, or identity value into a thrown
 * message or a log line — the RU charge it surfaces for measurement is a bare
 * number.
 */

/** The page size used when a caller asks for none. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Bounded number of read-then-update attempts {@link CooksRepository.stopCook}
 * makes before giving up under sustained write contention. Each retry follows a
 * 412 (Precondition Failed) — another writer replaced the document between our
 * read and our conditional write. The cap keeps a pathological write-storm from
 * spinning against the shared 400 RU/s pool; the idempotent completed-guard means
 * the common two-concurrent-stops race resolves on the FIRST retry, not by
 * exhausting attempts.
 */
export const STOP_COOK_MAX_ATTEMPTS = 3;

/**
 * The hard cap on a single page. listCooks lands on the shared 400 RU/s offer,
 * so an unbounded page (or a caller asking for thousands) is clamped here rather
 * than trusted — one page can only spend so much of the shared budget.
 */
export const MAX_PAGE_SIZE = 100;

/** A write/read that resolved to a single cook, with its measured RU cost. */
export interface CookResult {
  /** The persisted cook, or `undefined` when no document exists in the
   *  addressed partition (a point-read miss). */
  readonly cook: Cook | undefined;
  /** RU charge read from the response diagnostics — a bare number, safe to log. */
  readonly requestCharge: number;
}

/** A stop's outcome: the cook plus whether THIS call performed the transition. */
export interface StopCookResult extends CookResult {
  /** `true` only when this call's write moved the cook to `completed`. An
   *  already-completed cook returned idempotently (a retry, or a concurrent stop
   *  that won the race) is `false` — the caller must not re-announce it. */
  readonly transitioned: boolean;
}

/** A single page of a user's cooks, with its measured RU cost. */
export interface CookPage {
  readonly cooks: Cook[];
  /** Opaque continuation token for the next page, or `undefined` when the
   *  partition is fully drained. NEVER an offset. */
  readonly continuationToken?: string;
  /** RU charge for THIS page only — a bare number, safe to log. */
  readonly requestCharge: number;
}

/** Pagination inputs for a single user's cook list. Offset is deliberately
 *  absent: it would re-charge skipped documents against the shared pool. */
export interface ListCooksOptions {
  /** Requested page size; clamped to [1, {@link MAX_PAGE_SIZE}]. */
  readonly maxItemCount?: number;
  /** Opaque token from a prior page's {@link CookPage.continuationToken}. */
  readonly continuationToken?: string;
}

/** Clamps a requested page size into the safe range. */
function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

/**
 * The numeric status a Cosmos error phrased. Used ONLY to recognise a 404 (an
 * absent document in the caller's partition) and turn it into a `cook:
 * undefined` miss rather than a throw. Everything else propagates so the handler
 * can sanitise it; nothing from the error text is read here.
 */
function statusCodeOf(error: unknown): number | undefined {
  const reported = error as { code?: unknown; statusCode?: unknown } | null | undefined;
  for (const value of [reported?.statusCode, reported?.code]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

/**
 * Builds the If-Match request option for an optimistic-concurrency write. When
 * the ETag is absent (a fake in a unit test, or a store that did not surface one)
 * the write proceeds unconditionally rather than fabricating a condition — the
 * concurrency guard is best-effort on the ETag actually read, never invented.
 */
function ifMatch(etag: string | undefined): RequestOptions | undefined {
  return etag ? { accessCondition: { type: 'IfMatch', condition: etag } } : undefined;
}

export class CooksRepository {
  /**
   * @param container the cooks container from the shared adapter
   *   (`adapter.getCooksContainer()`). Injected so unit tests run against a fake
   *   with no Azure and no credentials.
   */
  constructor(private readonly container: Container) {}

  /**
   * Persists a new cook. The partition value is the document's own `userId`, so
   * the write lands in that user's partition — the addressing the point-read and
   * list below rely on. Returns the stored cook and the write's RU charge.
   */
  async createCook(cook: Cook): Promise<CookResult> {
    const response: ItemResponse<StoredCook> = await this.container.items.create<StoredCook>(cook);
    return {
      cook: toCook(response.resource ?? cook),
      requestCharge: response.requestCharge,
    };
  }

  /**
   * Point-reads a cook by `(userId, id)`. Passing `userId` as the partition-key
   * value routes the read to exactly one partition — NOT a cross-partition scan
   * filtered down to one document. A missing document (404) is a normal miss:
   * `cook` comes back `undefined`, not an error.
   */
  async getCook(userId: string, id: string): Promise<CookResult> {
    const { document, requestCharge } = await this.readCookWithEtag(userId, id);
    return { cook: document && toCook(document), requestCharge };
  }

  /**
   * Point-read that also surfaces the document's ETag, so a caller can perform an
   * optimistic-concurrency (If-Match) write against the exact version it read.
   * The ETag is Cosmos' per-document version token; it is opaque and carries no
   * account/database/container/identity text, so it is safe to hold and pass to a
   * conditional replace. A 404 (absent in the partition) yields `document:
   * undefined` and no ETag — a miss, not a throw.
   *
   * Returns the RAW stored document (system properties included) because
   * stopCook replaces the whole document and must not drop stored fields it does
   * not model; public methods map it through {@link toCook} before returning.
   */
  private async readCookWithEtag(
    userId: string,
    id: string
  ): Promise<{ document: StoredCook | undefined; etag?: string; requestCharge: number }> {
    try {
      const response: ItemResponse<StoredCook> = await this.container
        .item(id, userId)
        .read<StoredCook>();
      // v4 returns 404 with an undefined resource rather than throwing; treat a
      // 404 status the same as a missing resource.
      if (response.statusCode === 404 || response.resource === undefined) {
        return { document: undefined, requestCharge: response.requestCharge };
      }
      return {
        document: response.resource,
        etag: response.etag,
        requestCharge: response.requestCharge,
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) {
        return { document: undefined, requestCharge: 0 };
      }
      throw error;
    }
  }

  /**
   * Read-then-update stop transition with OPTIMISTIC CONCURRENCY. Point-reads the
   * cook in the caller's partition; if it is absent there, returns `cook:
   * undefined` (a 404 for the handler) WITHOUT writing. Otherwise transitions it
   * to `completed`, stamps the supplied `endTime`, and replaces the
   * correctly-addressed document with an `If-Match` on the ETag it just read.
   *
   * Why If-Match: two concurrent stop requests for the SAME cook would otherwise
   * both read the active document and both write `completed` with their own
   * `endTime` — a lost update, where the second writer silently overwrites the
   * first's `endTime`. With If-Match, only the writer whose ETag still matches
   * wins; the loser gets a 412 (Precondition Failed). On a 412 we re-read within a
   * bounded attempt budget ({@link STOP_COOK_MAX_ATTEMPTS}). The re-read now sees a
   * `completed` cook, and the idempotent guard below returns THAT persisted final
   * state rather than clobbering it — so concurrent stops converge on ONE
   * `endTime` instead of racing. Only sustained contention across every attempt
   * propagates the 412 to the handler, which sanitizes it to a fixed 5xx.
   *
   * The whole document is replaced within its `(id, userId)` address, so the
   * partition value cannot drift. RU charge sums every read and the winning write.
   * `transitioned` is true only when this call's replace succeeded.
   */
  async stopCook(userId: string, id: string, endTime: string): Promise<StopCookResult> {
    let requestCharge = 0;

    for (let attempt = 1; attempt <= STOP_COOK_MAX_ATTEMPTS; attempt++) {
      const existing = await this.readCookWithEtag(userId, id);
      requestCharge += existing.requestCharge;

      // Absent in this partition — a miss. No write, no cross-partition fallback.
      if (!existing.document) {
        return { cook: undefined, requestCharge, transitioned: false };
      }

      // Idempotent stop: an already-completed cook (e.g. a concurrent request won
      // the race) is returned as-is. This is what makes two concurrent stops
      // converge on the winner's endTime instead of the last write silently
      // overwriting it.
      if (existing.document.status === 'completed') {
        return { cook: toCook(existing.document), requestCharge, transitioned: false };
      }

      // Replace the WHOLE stored document (unmodelled stored fields survive the
      // write); only the value returned to the caller is projected to Cook.
      const stopped: StoredCook = {
        ...existing.document,
        status: 'completed',
        endTime,
      };

      try {
        const response: ItemResponse<StoredCook> = await this.container
          .item(id, userId)
          .replace<StoredCook>(stopped, ifMatch(existing.etag));
        requestCharge += response.requestCharge;
        return {
          cook: toCook(response.resource ?? stopped),
          requestCharge,
          transitioned: true,
        };
      } catch (error) {
        // 412 = another writer replaced the document between our read and write.
        // Re-read and retry within the budget; on the final attempt (or any other
        // error) it propagates to the handler, which sanitizes it.
        if (statusCodeOf(error) === 412 && attempt < STOP_COOK_MAX_ATTEMPTS) {
          continue;
        }
        throw error;
      }
    }

    // Unreachable: the loop always returns or throws on the final attempt. Kept so
    // the method is total for the type-checker.
    return { cook: undefined, requestCharge, transitioned: false };
  }

  /**
   * Lists a SINGLE user's cooks as a single-partition query keyed on `userId`.
   * Both the `WHERE c.userId = @userId` predicate and the `partitionKey` option
   * pin the query to one partition, so there is no cross-partition fan-out. The
   * page size is clamped and the next page is reached with the returned
   * continuation token — never an offset, which would re-charge skipped
   * documents against the shared pool. `userId` is the partition axis and the
   * ONLY thing that scopes this query; a caller cannot widen it.
   */
  async listCooksByUser(userId: string, options: ListCooksOptions = {}): Promise<CookPage> {
    const maxItemCount = clampPageSize(options.maxItemCount);

    const iterator = this.container.items.query<StoredCook>(
      {
        query: 'SELECT * FROM c WHERE c.userId = @userId ORDER BY c.startTime DESC',
        parameters: [{ name: '@userId', value: userId }],
      },
      {
        partitionKey: userId,
        maxItemCount,
        continuationToken: options.continuationToken,
      }
    );

    const response = await iterator.fetchNext();

    return {
      cooks: response.resources.map(toCook),
      continuationToken: response.hasMoreResults ? response.continuationToken : undefined,
      requestCharge: response.requestCharge,
    };
  }
}

/**
 * The repository wired to the shared adapter's cooks container. Both the cooks
 * handlers and (through the adapter) the health probe reach Cosmos through this
 * same client/credential/database/container — a green health check cannot
 * diverge from the handlers' real path.
 */
export function getCooksRepository(): CooksRepository {
  return new CooksRepository(getCosmosAdapter().getCooksContainer());
}
