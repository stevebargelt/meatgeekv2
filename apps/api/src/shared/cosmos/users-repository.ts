import type { Container, ItemResponse, RequestOptions } from '@azure/cosmos';
import type { User, UserPreferences } from '@meatgeekv2/api-interfaces';

import { getCosmosAdapter } from './cosmos-adapter';
import { getDevicesRepository, type DevicesRepository } from './devices-repository';

/**
 * HAR-27 (MG-81) — the users data-access layer, built on the ONE shared Cosmos
 * adapter.
 *
 * IDENTITY AND PARTITIONING. A user document's `id` is the authenticated
 * principal's `userId`, `"<tid>:<oid>"` (see shared/auth/principal.ts). The
 * deployed users container is partitioned on `/id`
 * (apps/infrastructure/modules/cosmos-db/main.tf,
 * `azurerm_cosmosdb_sql_container.users_shared`), so every operation in this
 * file is a POINT read or write with partition key = that userId. There is no
 * query against the users container at all.
 *
 * EMAIL IS NOT UNIQUE. The container declares a unique key on `/email`, but
 * Cosmos enforces unique keys WITHIN a logical partition, and every user is its
 * own partition, so the key never sees two users at once. The profile is keyed
 * by the principal; email is contact data. No cross-partition email check is
 * made, by decision.
 *
 * DEVICES ARE NOT STORED. `User.devices` is filled on every read from
 * {@link DevicesRepository.listDevicesByOwner}, so device ownership has one
 * source of truth (the devices container). Its RU is added to the total.
 *
 * NOT SET HERE. `subscription` and `lastLogin` are neither written nor returned.
 *
 * Nothing here puts an account, database, container, credential, or identity
 * value into a thrown message or a log line. The RU charge it surfaces is a bare
 * number.
 */

/** The preferences a profile gets for every field the caller leaves out on
 *  create. Deeply frozen, and always copied before use. */
export const DEFAULT_USER_PREFERENCES: Readonly<UserPreferences> = deepFreeze({
  temperatureUnit: 'fahrenheit',
  timeZone: 'UTC',
  notifications: {
    tempAlerts: true,
    cookComplete: true,
    deviceOffline: true,
    weeklyReports: false,
    productUpdates: false,
    pushNotifications: {
      enabled: true,
      sound: true,
      vibration: true,
      quietHours: {
        enabled: false,
        startTime: '22:00',
        endTime: '07:00',
      },
    },
    email: {
      enabled: false,
      frequency: 'daily',
    },
    sms: {
      enabled: false,
    },
  },
  defaultTargetTemps: {},
  privacy: {
    shareData: false,
    publicProfile: false,
    allowAnalytics: false,
  },
  display: {
    theme: 'auto',
    compactMode: false,
    showAdvancedMetrics: false,
  },
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) {
      deepFreeze(member);
    }
    Object.freeze(value);
  }
  return value;
}

/** A plain JSON object: not null, not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keys that would reach an object's prototype if assigned. Dropped by the merge. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A deep copy of a JSON value, so a merge result never shares structure with
 *  its inputs (or with the frozen defaults). */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJson);
  }
  if (isPlainObject(value)) {
    return deepMerge({}, value);
  }
  return value;
}

/**
 * The deep-merge rule for preferences: plain objects merge key by key; scalars
 * and arrays REPLACE. A key whose patch value is `undefined` is left as it was.
 * Returns a fresh object; neither input is modified.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!UNSAFE_KEYS.has(key)) {
      result[key] = cloneJson(value);
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key) || value === undefined) {
      continue;
    }
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : cloneJson(value);
  }
  return result;
}

/** `patch` deep-merged over `base`, typed as preferences. */
export function mergeUserPreferences(
  base: Partial<UserPreferences> | undefined,
  patch: Partial<UserPreferences> | undefined
): UserPreferences {
  return deepMerge(
    (base ?? {}) as Record<string, unknown>,
    (patch ?? {}) as Record<string, unknown>
  ) as unknown as UserPreferences;
}

/**
 * The User fields kept in the document and returned from it. An ALLOW-list:
 * Cosmos system properties (`_rid`, `_self`, `_etag`, `_attachments`, `_ts`)
 * and any unmodelled stored field never reach a caller.
 */
const STORED_USER_FIELDS = ['id', 'email', 'name', 'preferences', 'createdAt'] as const;

/** `devices` is computed from the devices container; these two are not set by
 *  this slice and are never returned. */
type ComputedUserField = 'devices';
type UnservedUserField = 'lastLogin' | 'subscription';

type UnmappedUserField = Exclude<
  keyof User,
  (typeof STORED_USER_FIELDS)[number] | ComputedUserField | UnservedUserField
>;
/** Compile-time guard: fails if the User contract gains a field not accounted for above. */
const userFieldsAreExhaustive: [UnmappedUserField] extends [never] ? true : never = true;
void userFieldsAreExhaustive;

/** A users document as written: the stored User fields. As read, it also carries
 *  system properties the static type cannot see. Never returned without {@link toUser}. */
export type StoredUser = Pick<User, (typeof STORED_USER_FIELDS)[number]>;

/** Projects a stored document and the caller's device ids onto the User shape. */
export function toUser(document: StoredUser, devices: readonly string[]): User {
  const source = document as unknown as Record<string, unknown>;
  const user: Record<string, unknown> = {};
  for (const field of STORED_USER_FIELDS) {
    if (source[field] !== undefined) {
      user[field] = source[field];
    }
  }
  user['devices'] = [...devices];
  return user as unknown as User;
}

/** What PUT /users/me writes, after validation. */
export interface UserProfileInput {
  readonly name: string;
  readonly email: string;
  readonly preferences?: Partial<UserPreferences>;
}

export type GetUserResult =
  | { readonly outcome: 'found'; readonly user: User; readonly requestCharge: number }
  | { readonly outcome: 'notFound'; readonly requestCharge: number };

export type PutUserResult =
  | { readonly outcome: 'created'; readonly user: User; readonly requestCharge: number }
  | { readonly outcome: 'updated'; readonly user: User; readonly requestCharge: number }
  | { readonly outcome: 'concurrentUpdate'; readonly requestCharge: number };

/** The numeric status a Cosmos error carries. Nothing from its text is read. */
function statusCodeOf(error: unknown): number | undefined {
  const reported = error as { code?: unknown; statusCode?: unknown } | null | undefined;
  for (const value of [reported?.statusCode, reported?.code]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

/** The RU a thrown Cosmos error reported, or 0. */
function chargeOf(error: unknown): number {
  const charge = (error as { requestCharge?: unknown } | null | undefined)?.requestCharge;
  return typeof charge === 'number' && Number.isFinite(charge) ? charge : 0;
}

/**
 * A failed users operation, re-thrown with the RU spent by the whole operation
 * (the reads before it included) and the numeric status. It carries no Cosmos
 * error text.
 */
export class UsersStoreError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly requestCharge: number
  ) {
    super('users store operation failed');
    this.name = 'UsersStoreError';
  }
}

/** The devices query the users repository needs: the caller's devices. */
export type DeviceOwnerSource = Pick<DevicesRepository, 'listDevicesByOwner'>;

export class UsersRepository {
  /**
   * @param container the users container from the shared adapter
   *   (`adapter.getUsersContainer()`).
   * @param devices where `User.devices` comes from: the devices repository's
   *   owner query. Both are injected so unit tests run on fakes.
   * @param now the clock that stamps `createdAt` on a new profile. Injected so
   *   tests can pin it; defaults to the real clock.
   */
  constructor(
    private readonly container: Container,
    private readonly devices: DeviceOwnerSource,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Point read of the raw document with its ETag. Partition key = userId. A 404
   *  is a miss, not a throw. */
  private async readDocument(
    userId: string
  ): Promise<{ document: StoredUser | undefined; etag?: string; requestCharge: number }> {
    try {
      const response: ItemResponse<StoredUser> = await this.container
        .item(userId, userId)
        .read<StoredUser>();
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
        return { document: undefined, requestCharge: chargeOf(error) };
      }
      throw new UsersStoreError(statusCodeOf(error), chargeOf(error));
    }
  }

  /** The caller's device ids, from the devices owner query. */
  private async deviceIds(
    userId: string,
    chargeSoFar: number
  ): Promise<{ ids: string[]; requestCharge: number }> {
    try {
      const { devices, requestCharge } = await this.devices.listDevicesByOwner(userId);
      return { ids: devices.map(device => device.id), requestCharge };
    } catch (error) {
      throw new UsersStoreError(statusCodeOf(error), chargeSoFar + chargeOf(error));
    }
  }

  /** The caller's profile: one point read, then the devices owner query. */
  async getUser(userId: string): Promise<GetUserResult> {
    const { document, requestCharge } = await this.readDocument(userId);
    if (!document) {
      return { outcome: 'notFound', requestCharge };
    }
    const devices = await this.deviceIds(userId, requestCharge);
    return {
      outcome: 'found',
      user: toUser(document, devices.ids),
      requestCharge: requestCharge + devices.requestCharge,
    };
  }

  /**
   * Creates or replaces the caller's profile.
   *
   *   - No profile: `create` (never upsert) with `createdAt` = now and the
   *     supplied preferences deep-merged over {@link DEFAULT_USER_PREFERENCES}.
   *     A 409 (a concurrent PUT created it first) is retried ONCE as the update
   *     path.
   *   - A profile: `replace` conditioned on the ETag just read (If-Match),
   *     keeping `createdAt` and deep-merging preferences over the stored ones.
   *     A 412 is `concurrentUpdate`; it is not retried.
   *
   * The devices owner query runs before the write, so a failure there writes
   * nothing.
   */
  async putUser(userId: string, input: UserProfileInput): Promise<PutUserResult> {
    const existing = await this.readDocument(userId);
    let requestCharge = existing.requestCharge;
    const devices = await this.deviceIds(userId, requestCharge);
    requestCharge += devices.requestCharge;

    if (existing.document) {
      return this.replace(
        userId,
        input,
        existing.document,
        existing.etag,
        devices.ids,
        requestCharge
      );
    }

    const document: StoredUser = {
      id: userId,
      name: input.name,
      email: input.email,
      preferences: mergeUserPreferences(DEFAULT_USER_PREFERENCES, input.preferences),
      createdAt: this.now().toISOString(),
    };
    try {
      const response = await this.container.items.create<StoredUser>(document);
      requestCharge += response.requestCharge;
      return {
        outcome: 'created',
        user: toUser(response.resource ?? document, devices.ids),
        requestCharge,
      };
    } catch (error) {
      const status = statusCodeOf(error);
      requestCharge += chargeOf(error);
      if (status !== 409) {
        throw new UsersStoreError(status, requestCharge);
      }
    }

    // A concurrent PUT created the profile between our read and our create.
    // Retry once as the update path, over what it wrote.
    let reread: Awaited<ReturnType<UsersRepository['readDocument']>>;
    try {
      reread = await this.readDocument(userId);
    } catch (error) {
      throw new UsersStoreError(statusCodeOf(error), requestCharge + chargeOf(error));
    }
    requestCharge += reread.requestCharge;
    if (!reread.document) {
      return { outcome: 'concurrentUpdate', requestCharge };
    }
    return this.replace(userId, input, reread.document, reread.etag, devices.ids, requestCharge);
  }

  private async replace(
    userId: string,
    input: UserProfileInput,
    stored: StoredUser,
    etag: string | undefined,
    deviceIds: readonly string[],
    chargeSoFar: number
  ): Promise<PutUserResult> {
    // Replace the WHOLE stored document so unmodelled stored fields survive; only
    // the value returned is projected to User. id and createdAt never change.
    const next: StoredUser = {
      ...stored,
      name: input.name,
      email: input.email,
      preferences: mergeUserPreferences(
        mergeUserPreferences(DEFAULT_USER_PREFERENCES, stored.preferences),
        input.preferences
      ),
      id: stored.id,
      createdAt: stored.createdAt,
    };
    const options: RequestOptions | undefined = etag
      ? { accessCondition: { type: 'IfMatch', condition: etag } }
      : undefined;
    try {
      const response = await this.container.item(userId, userId).replace<StoredUser>(next, options);
      return {
        outcome: 'updated',
        user: toUser(response.resource ?? next, deviceIds),
        requestCharge: chargeSoFar + response.requestCharge,
      };
    } catch (error) {
      const status = statusCodeOf(error);
      const requestCharge = chargeSoFar + chargeOf(error);
      if (status === 412) {
        return { outcome: 'concurrentUpdate', requestCharge };
      }
      throw new UsersStoreError(status, requestCharge);
    }
  }
}

/** The repository wired to the shared adapter's users container and the devices
 *  repository's owner query. */
export function getUsersRepository(): UsersRepository {
  return new UsersRepository(getCosmosAdapter().getUsersContainer(), getDevicesRepository());
}
