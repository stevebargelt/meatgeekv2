import type {
  Container,
  ItemResponse,
  JSONObject,
  OperationInput,
  OperationResponse,
  RequestOptions,
  SqlParameter,
} from '@azure/cosmos';
import type { Cook, CookStatus, TargetsPending } from '@meatgeekv2/api-interfaces';

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
  'targetsReached',
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

/** A stored cook with the fields that are stored but never returned: the target
 *  rule's pending readings (see apps/api/src/functions/cooks/target-rule.ts). */
export interface StoredCookDocument extends Cook {
  targetsPending?: TargetsPending;
}

/** What {@link CooksRepository.updateActiveCook} did. */
export type ActiveCookUpdate = 'updated' | 'unchanged' | 'notActive';

/** Read-then-replace attempts {@link CooksRepository.updateActiveCook} makes
 *  when another writer keeps changing the cook between its read and its write. */
export const UPDATE_ACTIVE_COOK_MAX_ATTEMPTS = 3;

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

/**
 * MG-84 — at most one active cook per (user, device).
 *
 * The rule is held by a small LOCK document that lives in the same `/userId`
 * partition as the cooks it guards, so it can be written in the SAME
 * transactional batch as the cook: either the cook and its lock both commit or
 * neither does. Its id is `active-device:<deviceId>`. Cook ids are UUIDs, so the
 * prefix keeps the two id spaces apart. `docType` marks it so the list query can
 * exclude it; it never goes through {@link toCook} and never reaches a caller.
 */
export const ACTIVE_DEVICE_LOCK_DOC_TYPE = 'activeDeviceLock';

/** The id of the lock document for one device (within the caller's partition).
 *  The device id is URI-encoded because Cosmos ids may not contain `/`, `\`,
 *  `?` or `#`; ordinary device ids such as `meatgeek3` are unchanged. */
export function activeDeviceLockId(deviceId: string): string {
  return `active-device:${encodeURIComponent(deviceId)}`;
}

/** The stored lock document. Never returned to a caller. */
export interface ActiveDeviceLock {
  readonly id: string;
  readonly userId: string;
  readonly docType: typeof ACTIVE_DEVICE_LOCK_DOC_TYPE;
  readonly deviceId: string;
  /** The cook currently holding the device. */
  readonly cookId: string;
}

/**
 * Bounded number of start batches {@link CooksRepository.startCook} runs. A
 * retry happens only when the lock changed under us (a stale lock was taken
 * over or released between our read and our batch), so the common case is one
 * batch and the cap only bounds a pathological race on the shared RU pool.
 */
export const START_COOK_MAX_ATTEMPTS = 3;

/**
 * What a start did. The handler maps these to 201 / 200 (or 422) / 409.
 *   - `created`: this call wrote the cook and took the device lock.
 *   - `replayed`: a cook with this id already exists in the caller's partition
 *     (a retry, or a concurrent duplicate that won). `cook` is the STORED cook;
 *     the handler checks it matches the request.
 *   - `deviceBusy`: another non-terminal cook holds the device.
 */
export type StartCookResult =
  | { readonly outcome: 'created'; readonly cook: Cook; readonly requestCharge: number }
  | { readonly outcome: 'replayed'; readonly cook: Cook; readonly requestCharge: number }
  | {
      readonly outcome: 'deviceBusy';
      readonly activeCookId: string;
      readonly requestCharge: number;
    };

/** A cook in one of these states no longer holds its device. */
function isTerminal(status: Cook['status']): boolean {
  return status === 'completed' || status === 'cancelled';
}

/** The outcome of one transactional batch, read per operation. */
interface BatchOutcome {
  readonly ok: boolean;
  /** Per-operation status codes, in operation order (424 = rolled back because
   *  another operation failed). */
  readonly statuses: readonly (number | undefined)[];
  readonly results: readonly OperationResponse[];
  readonly requestCharge: number;
}

/** The first real failure in a batch (424 Failed Dependency is only a rollback). */
function firstFailure(statuses: readonly (number | undefined)[]): number | undefined {
  return statuses.find(code => code !== undefined && (code < 200 || code > 299) && code !== 424);
}

/** An error carrying only a numeric status, so the handler can log the status
 *  without any Cosmos error text. */
function batchError(statusCode: number | undefined): Error {
  return Object.assign(new Error('cooks transactional batch failed'), { statusCode });
}

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
  /** MG-87: only cooks on this device. Combines with {@link status} by AND. */
  readonly deviceId?: string;
  /** MG-87: only cooks in this status. Combines with {@link deviceId} by AND. */
  readonly status?: CookStatus;
}

/** A partition document that is not a cook: it carries `docType` (today only
 *  the MG-84 device lock). Cooks never carry one; the list query filters on
 *  the same rule (`NOT IS_DEFINED(c.docType)`). */
function isLockDocument(document: object): boolean {
  return (document as { docType?: unknown }).docType !== undefined;
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
   * Point-reads a cook by `(userId, id)`. Passing `userId` as the partition-key
   * value routes the read to exactly one partition — NOT a cross-partition scan
   * filtered down to one document. A missing document (404) is a normal miss:
   * `cook` comes back `undefined`, not an error.
   *
   * HAR-75: the MG-84 device lock (`active-device:<deviceId>`) shares the
   * partition but is not a cook. A document carrying `docType` is a miss too,
   * so neither GET /cooks/{id} nor a stop can address a lock as a cook.
   */
  async getCook(userId: string, id: string): Promise<CookResult> {
    const { document, requestCharge } = await this.readCookWithEtag(userId, id);
    if (document === undefined || isLockDocument(document)) {
      return { cook: undefined, requestCharge };
    }
    return { cook: toCook(document), requestCharge };
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
  private readCookWithEtag(userId: string, id: string) {
    return this.readDocument<StoredCook>(userId, id);
  }

  /** {@link readCookWithEtag} for any document in the caller's partition (the
   *  device lock included). */
  private async readDocument<T extends object>(
    userId: string,
    id: string
  ): Promise<{ document: T | undefined; etag?: string; requestCharge: number }> {
    try {
      const response: ItemResponse<T> = await this.container.item(id, userId).read<T>();
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
   * Runs one TRANSACTIONAL batch in the caller's partition. Cosmos commits every
   * operation or none. A failed batch does not throw: the SDK returns 207 with a
   * status per operation (the failing one carries its own code, the rest 424),
   * so the outcome is read per operation here. A transport-level failure still
   * throws and propagates to the handler.
   */
  private async runBatch(userId: string, operations: OperationInput[]): Promise<BatchOutcome> {
    const response = await this.container.items.batch(operations, userId);
    const results = response.result ?? [];
    const statuses = operations.map((_, index) => results[index]?.statusCode);
    return {
      ok: statuses.every(code => code !== undefined && code >= 200 && code <= 299),
      statuses,
      results,
      requestCharge: results.reduce((sum, result) => sum + (result.requestCharge ?? 0), 0),
    };
  }

  /**
   * MG-84 — retry-safe start. The cook's id is supplied by the client and reused
   * on every retry, so Cosmos' own `(partition, id)` uniqueness is the
   * idempotency check: a second create of the same id fails with 409 and is
   * answered from the stored cook instead of writing a second one. Concurrent
   * duplicates collapse the same way, because exactly one create can win.
   *
   * The same batch creates the device lock ({@link ActiveDeviceLock}), so "one
   * active cook per (user, device)" holds without a check-then-write race:
   *
   *   - op 0 (create cook) 409 → `replayed`: the stored cook is returned. This is
   *     checked first, so a retry of the cook that HOLDS the device is a replay,
   *     not a busy device.
   *   - op 1 (lock) fails → read the lock. If its cook is still non-terminal the
   *     device is busy. If the lock is stale (its cook is completed, cancelled or
   *     missing) the next batch replaces it under If-Match; if it vanished, the
   *     next batch creates it. Bounded by {@link START_COOK_MAX_ATTEMPTS}.
   *   - both commit → `created`.
   */
  async startCook(cook: Cook): Promise<StartCookResult> {
    const { userId, deviceId } = cook;
    const lockId = activeDeviceLockId(deviceId);
    const lock: ActiveDeviceLock = {
      id: lockId,
      userId,
      docType: ACTIVE_DEVICE_LOCK_DOC_TYPE,
      deviceId,
      cookId: cook.id,
    };
    const lockBody = lock as unknown as JSONObject;
    let lockOperation: OperationInput = { operationType: 'Create', resourceBody: lockBody };
    let requestCharge = 0;
    let lastFailure: number | undefined;

    for (let attempt = 1; attempt <= START_COOK_MAX_ATTEMPTS; attempt++) {
      const batch = await this.runBatch(userId, [
        { operationType: 'Create', resourceBody: cook as unknown as JSONObject },
        lockOperation,
      ]);
      requestCharge += batch.requestCharge;

      if (batch.ok) {
        const stored = batch.results[0]?.resourceBody as unknown as StoredCook | undefined;
        return { outcome: 'created', cook: toCook(stored ?? cook), requestCharge };
      }

      const [cookStatus, lockStatus] = batch.statuses;
      if (cookStatus === 409) {
        const existing = await this.readCookWithEtag(userId, cook.id);
        requestCharge += existing.requestCharge;
        if (!existing.document) {
          // Cooks are never deleted, so a 409 without a readable cook is not a
          // replay we can answer. Surface it as a failure.
          throw batchError(409);
        }
        return { outcome: 'replayed', cook: toCook(existing.document), requestCharge };
      }

      lastFailure = firstFailure(batch.statuses);
      if (lockStatus !== 409 && lockStatus !== 412 && lockStatus !== 404) {
        throw batchError(lastFailure);
      }

      // The lock is held, or changed since we last looked. Decide from its
      // current state.
      const held = await this.readDocument<ActiveDeviceLock>(userId, lockId);
      requestCharge += held.requestCharge;
      if (!held.document) {
        lockOperation = { operationType: 'Create', resourceBody: lockBody };
        continue;
      }

      const holder = await this.readCookWithEtag(userId, held.document.cookId);
      requestCharge += holder.requestCharge;
      if (holder.document && !isTerminal(holder.document.status)) {
        return { outcome: 'deviceBusy', activeCookId: held.document.cookId, requestCharge };
      }

      // Stale lock: take it over, but only the version we just read.
      lockOperation = {
        operationType: 'Replace',
        id: lockId,
        resourceBody: lockBody,
        ...(held.etag ? { ifMatch: held.etag } : {}),
      };
    }

    throw batchError(lastFailure);
  }

  /**
   * HAR-66 — the cook that currently holds `deviceId` in the caller's partition,
   * the value the device twin's `activeCookId` must carry. Two point reads, no
   * query: the MG-84 lock, then the cook it names. The lock only counts while
   * that cook is non-terminal; a stale lock (its cook completed, cancelled or
   * missing) means no active cook.
   */
  async getActiveCookIdForDevice(
    userId: string,
    deviceId: string
  ): Promise<{ readonly cookId: string | undefined; readonly requestCharge: number }> {
    const lock = await this.readDocument<ActiveDeviceLock>(userId, activeDeviceLockId(deviceId));
    let requestCharge = lock.requestCharge;
    if (!lock.document) {
      return { cookId: undefined, requestCharge };
    }
    const holder = await this.readCookWithEtag(userId, lock.document.cookId);
    requestCharge += holder.requestCharge;
    if (!holder.document || isTerminal(holder.document.status)) {
      return { cookId: undefined, requestCharge };
    }
    return { cookId: lock.document.cookId, requestCharge };
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

      // MG-84: if this cook holds its device lock, release the lock in the same
      // transactional batch as the stop, so the device is free exactly when the
      // cook is completed. A cook without a lock (created before MG-84, or whose
      // lock was taken over as stale) takes the plain replace below.
      const lockId = activeDeviceLockId(existing.document.deviceId);
      const lock = await this.readDocument<ActiveDeviceLock>(userId, lockId);
      requestCharge += lock.requestCharge;
      if (lock.document?.cookId === id) {
        const batch = await this.runBatch(userId, [
          {
            operationType: 'Replace',
            id,
            resourceBody: stopped as unknown as JSONObject,
            ...(existing.etag ? { ifMatch: existing.etag } : {}),
          },
          { operationType: 'Delete', id: lockId },
        ]);
        requestCharge += batch.requestCharge;
        if (batch.ok) {
          const stored = batch.results[0]?.resourceBody as unknown as StoredCook | undefined;
          return { cook: toCook(stored ?? stopped), requestCharge, transitioned: true };
        }
        // 412: the cook changed since our read (a concurrent stop). 404: the lock
        // went away. Either way re-read and decide again within the budget.
        const failure = firstFailure(batch.statuses);
        if ((failure === 412 || failure === 404) && attempt < STOP_COOK_MAX_ATTEMPTS) {
          continue;
        }
        throw batchError(failure);
      }

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
   * Changes a RUNNING cook (status `active`) in place, for a writer that is not
   * the cook's owner acting through a route: the target rule. `change` gets the
   * whole stored document, stored-only fields included, and returns the fields
   * to set, or `undefined` to write nothing.
   *
   * The replace carries If-Match on the ETag just read, so it can never undo a
   * concurrent stop or another change: on 412 the cook is read again and
   * `change` runs again on the new version, within
   * {@link UPDATE_ACTIVE_COOK_MAX_ATTEMPTS}. A cook that is missing, a lock
   * document, or no longer active is `notActive` and is not written.
   */
  async updateActiveCook(
    userId: string,
    id: string,
    change: (cook: StoredCookDocument) => Partial<StoredCookDocument> | undefined
  ): Promise<{ readonly outcome: ActiveCookUpdate; readonly requestCharge: number }> {
    let requestCharge = 0;
    for (let attempt = 1; ; attempt++) {
      const existing = await this.readCookWithEtag(userId, id);
      requestCharge += existing.requestCharge;
      const document = existing.document as StoredCookDocument | undefined;
      if (!document || isLockDocument(document) || document.status !== 'active') {
        return { outcome: 'notActive', requestCharge };
      }
      const fields = change(document);
      if (fields === undefined) {
        return { outcome: 'unchanged', requestCharge };
      }
      try {
        const response = await this.container
          .item(id, userId)
          .replace<StoredCookDocument>({ ...document, ...fields }, ifMatch(existing.etag));
        requestCharge += response.requestCharge;
        return { outcome: 'updated', requestCharge };
      } catch (error) {
        if (statusCodeOf(error) === 412 && attempt < UPDATE_ACTIVE_COOK_MAX_ATTEMPTS) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Lists a SINGLE user's cooks as a single-partition query keyed on `userId`.
   * Both the `WHERE c.userId = @userId` predicate and the `partitionKey` option
   * pin the query to one partition, so there is no cross-partition fan-out. The
   * page size is clamped and the next page is reached with the returned
   * continuation token — never an offset, which would re-charge skipped
   * documents against the shared pool. `userId` is the partition axis and the
   * ONLY thing that scopes this query; a caller cannot widen it.
   *
   * MG-87: optional `deviceId` / `status` filters narrow the page further. Each
   * is a bound parameter, never concatenated into the SQL, and they combine with
   * AND. The query stays in the caller's partition and keeps the newest-first
   * order and continuation-token paging.
   *
   * Not done: a point-read fast path for `deviceId` + `status=active` through the
   * MG-84 `active-device:<deviceId>` lock document. It would save a query, but the
   * filtered single-partition query is cheap at this scale and keeps one code
   * path. Revisit if the data-pusher's reconcile shows up in the RU budget.
   */
  async listCooksByUser(userId: string, options: ListCooksOptions = {}): Promise<CookPage> {
    const maxItemCount = clampPageSize(options.maxItemCount);

    // MG-84: device lock documents share the partition; only cooks are listed.
    const predicates = ['c.userId = @userId', 'NOT IS_DEFINED(c.docType)'];
    const parameters: SqlParameter[] = [{ name: '@userId', value: userId }];
    if (options.deviceId !== undefined) {
      predicates.push('c.deviceId = @deviceId');
      parameters.push({ name: '@deviceId', value: options.deviceId });
    }
    if (options.status !== undefined) {
      predicates.push('c.status = @status');
      parameters.push({ name: '@status', value: options.status });
    }

    const iterator = this.container.items.query<StoredCook>(
      {
        query: `SELECT * FROM c WHERE ${predicates.join(' AND ')} ORDER BY c.startTime DESC`,
        parameters,
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
