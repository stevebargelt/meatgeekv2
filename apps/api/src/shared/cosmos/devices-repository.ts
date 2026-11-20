import type { Container, ItemResponse, RequestOptions } from '@azure/cosmos';
import type { Device, DeviceConfiguration } from '@meatgeekv2/api-interfaces';

import { getCosmosAdapter } from './cosmos-adapter';

/**
 * HAR-20 (MG-80) — the devices data-access layer, built on the ONE shared Cosmos
 * adapter.
 *
 * PARTITIONING. The deployed devices container is partitioned on `/id`, i.e. the
 * device id (apps/infrastructure/modules/cosmos-db/main.tf,
 * `azurerm_cosmosdb_sql_container.devices_shared`). So:
 *
 *   - every single-device operation (read, create, replace) is a POINT operation
 *     with partition key = deviceId;
 *   - listing one owner's devices is the ONE query in this file,
 *     `SELECT * FROM c WHERE c.userId = @userId`. It fans out across partitions
 *     by design, because the container is keyed by device, and the `userId`
 *     index serves it. There is no other cross-partition query here.
 *
 * NAME UNIQUENESS. The container declares a unique key on `(userId, name)`, but
 * Cosmos enforces unique keys WITHIN a logical partition, and every device is its
 * own partition. The key can therefore never see two devices at once, and does
 * not stop one owner from naming two devices the same. The repository checks
 * names itself against the owner's device list (the same list query). Two
 * concurrent writes of the same name for the same owner can both pass that
 * check; that race is accepted at this scale.
 *
 * OWNERSHIP. A device's owner is the `userId` stored on it, which the handlers
 * set from the authenticated principal. {@link DevicesRepository.getDeviceOwnership}
 * answers `owned` / `foreign` / `unknown` from one point read, with no HTTP
 * concerns, so cook and SignalR authorization can reuse it.
 *
 * Nothing here puts an account, database, container, credential, or identity
 * value into a thrown message or a log line. The RU charge it surfaces is a bare
 * number.
 */

/** A device id: what the register route accepts and what may address Cosmos.
 *  Excludes the characters Cosmos forbids in ids (`/ \ ? #`). */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The configuration a device gets for every required {@link DeviceConfiguration}
 * field the caller leaves out. Frozen, and always copied before use.
 */
export const DEFAULT_DEVICE_CONFIGURATION: Readonly<DeviceConfiguration> = Object.freeze({
  temperatureUnit: 'fahrenheit',
  pollingInterval: 30,
  alertSettings: Object.freeze({
    highTempThreshold: 0,
    lowTempThreshold: 0,
    enableSounds: false,
    enablePushNotifications: false,
  }),
});

/** A partial configuration as a caller sends it. `alertSettings` may itself be
 *  partial: its fields merge one by one. */
export type DeviceConfigurationPatch = Omit<Partial<DeviceConfiguration>, 'alertSettings'> & {
  alertSettings?: Partial<DeviceConfiguration['alertSettings']>;
};

/** Removes keys whose value is `undefined`, so a merge never blanks a field. */
function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, member]) => member !== undefined)
  ) as Partial<T>;
}

/**
 * Merges `patch` field by field over `base`, filling any required field neither
 * supplies from {@link DEFAULT_DEVICE_CONFIGURATION}. `alertSettings` merges one
 * level deeper, so changing one threshold keeps the others.
 */
export function mergeDeviceConfiguration(
  base: Partial<DeviceConfiguration> | undefined,
  patch: DeviceConfigurationPatch | undefined
): DeviceConfiguration {
  const { alertSettings: baseAlerts, ...baseRest } = definedOnly(base);
  const { alertSettings: patchAlerts, ...patchRest } = definedOnly(patch);
  return {
    ...DEFAULT_DEVICE_CONFIGURATION,
    ...baseRest,
    ...patchRest,
    alertSettings: {
      ...DEFAULT_DEVICE_CONFIGURATION.alertSettings,
      ...definedOnly(baseAlerts),
      ...definedOnly(patchAlerts),
    },
  };
}

/**
 * The ONE place a stored devices document becomes an api-interfaces
 * {@link Device}. An ALLOW-list, checked against `keyof Device` at compile time
 * in both directions, so Cosmos system properties (`_rid`, `_self`, `_etag`,
 * `_attachments`, `_ts`) and any unmodelled stored field never reach a caller.
 */
const DEVICE_FIELDS = [
  'id',
  'userId',
  'name',
  'model',
  'location',
  'lastSeen',
  'isActive',
  'configuration',
  'connectionStatus',
  'firmware',
] as const satisfies readonly (keyof Device)[];

type UnmappedDeviceField = Exclude<keyof Device, (typeof DEVICE_FIELDS)[number]>;
/** Compile-time guard: fails if the Device contract gains a field not listed above. */
const deviceFieldsAreExhaustive: [UnmappedDeviceField] extends [never] ? true : never = true;
void deviceFieldsAreExhaustive;

/** A devices document as Cosmos returns it: the Device fields plus system
 *  properties the static type cannot see. Never returned without {@link toDevice}. */
type StoredDevice = Device;

/** Projects a stored document onto the Device shape. Absent fields stay absent. */
export function toDevice(document: StoredDevice): Device {
  const source = document as unknown as Record<string, unknown>;
  const device: Record<string, unknown> = {};
  for (const field of DEVICE_FIELDS) {
    if (source[field] !== undefined) {
      device[field] = source[field];
    }
  }
  return device as unknown as Device;
}

/**
 * Who owns a device, from one point read.
 *   - `owned`: the device exists and its `userId` is the caller's.
 *   - `foreign`: the device exists and belongs to someone else.
 *   - `unknown`: there is no such device (or the id could never be one).
 * Callers that answer over HTTP should treat `foreign` like `unknown` (404), so
 * a response does not reveal that someone else's device exists.
 */
export type DeviceOwnership =
  | { readonly status: 'owned'; readonly device: Device; readonly requestCharge: number }
  | { readonly status: 'foreign'; readonly requestCharge: number }
  | { readonly status: 'unknown'; readonly requestCharge: number };

/** A register's outcome. `conflict` covers a taken id (whoever owns it) and a
 *  name the owner already uses, without saying which. */
export type RegisterDeviceResult =
  | { readonly outcome: 'created'; readonly device: Device; readonly requestCharge: number }
  | { readonly outcome: 'conflict'; readonly requestCharge: number };

/** The fields PATCH may change. */
export interface DeviceUpdate {
  readonly name?: string;
  readonly location?: string;
  readonly configuration?: DeviceConfigurationPatch;
}

/** An update's outcome. `notFound` covers both unknown and foreign devices. */
export type UpdateDeviceResult =
  | { readonly outcome: 'updated'; readonly device: Device; readonly requestCharge: number }
  | { readonly outcome: 'notFound'; readonly requestCharge: number }
  | { readonly outcome: 'nameConflict'; readonly requestCharge: number }
  | { readonly outcome: 'concurrentUpdate'; readonly requestCharge: number };

/** A user's devices, with the RU the list query cost. */
export interface DeviceList {
  readonly devices: Device[];
  readonly requestCharge: number;
}

/** Page size for the owner query's internal paging (all pages are read). */
const LIST_PAGE_SIZE = 100;

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
 * A failed write, re-thrown with the RU spent by the whole operation (the reads
 * before it included) and the numeric status. It carries no Cosmos error text.
 */
export class DevicesStoreError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly requestCharge: number
  ) {
    super('devices store operation failed');
    this.name = 'DevicesStoreError';
  }
}

export class DevicesRepository {
  /**
   * @param container the devices container from the shared adapter
   *   (`adapter.getDevicesContainer()`). Injected so unit tests run against a
   *   fake with no Azure and no credentials.
   */
  constructor(private readonly container: Container) {}

  /**
   * Point-reads the raw stored document (system properties included) with its
   * ETag. Partition key = the device id. A 404 is a miss, not a throw. An id that
   * cannot be a device id is a miss without a read.
   */
  private async readDocument(
    deviceId: string
  ): Promise<{ document: StoredDevice | undefined; etag?: string; requestCharge: number }> {
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      return { document: undefined, requestCharge: 0 };
    }
    try {
      const response: ItemResponse<StoredDevice> = await this.container
        .item(deviceId, deviceId)
        .read<StoredDevice>();
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
      throw error;
    }
  }

  /** Who owns `deviceId`, relative to `userId`. One point read. */
  async getDeviceOwnership(userId: string, deviceId: string): Promise<DeviceOwnership> {
    const { document, requestCharge } = await this.readDocument(deviceId);
    if (!document) {
      return { status: 'unknown', requestCharge };
    }
    if (document.userId !== userId) {
      return { status: 'foreign', requestCharge };
    }
    return { status: 'owned', device: toDevice(document), requestCharge };
  }

  /**
   * HAR-81: the owner of `deviceId`, from one point read, with no caller to
   * compare against. `undefined` when no device has that id (or the stored
   * document has no owner). The live-reading push uses it to address each
   * reading to its owner's SignalR user.
   */
  async getDeviceOwner(
    deviceId: string
  ): Promise<{ readonly userId: string | undefined; readonly requestCharge: number }> {
    const { document, requestCharge } = await this.readDocument(deviceId);
    const userId =
      typeof document?.userId === 'string' && document.userId.length > 0
        ? document.userId
        : undefined;
    return { userId, requestCharge };
  }

  /**
   * Every device `userId` owns: `SELECT * FROM c WHERE c.userId = @userId`,
   * cross-partition by design (see the file header), sorted by name.
   */
  async listDevicesByOwner(userId: string): Promise<DeviceList> {
    const response = await this.container.items
      .query<StoredDevice>(
        {
          query: 'SELECT * FROM c WHERE c.userId = @userId',
          parameters: [{ name: '@userId', value: userId }],
        },
        { maxItemCount: LIST_PAGE_SIZE }
      )
      .fetchAll();
    const devices = response.resources
      .map(toDevice)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { devices, requestCharge: response.requestCharge };
  }

  /**
   * Creates the device with Cosmos `create` (never upsert), so an existing id is
   * a 409 rather than an overwrite. The owner's names are checked first.
   */
  async registerDevice(device: Device): Promise<RegisterDeviceResult> {
    const owned = await this.listDevicesByOwner(device.userId);
    let requestCharge = owned.requestCharge;
    if (owned.devices.some(existing => existing.name === device.name)) {
      return { outcome: 'conflict', requestCharge };
    }

    try {
      const response = await this.container.items.create<StoredDevice>(device);
      requestCharge += response.requestCharge;
      return { outcome: 'created', device: toDevice(response.resource ?? device), requestCharge };
    } catch (error) {
      const status = statusCodeOf(error);
      if (status === 409) {
        return { outcome: 'conflict', requestCharge: requestCharge + chargeOf(error) };
      }
      throw new DevicesStoreError(status, requestCharge + chargeOf(error));
    }
  }

  /**
   * Applies `update` to a device the caller owns: point read, merge, then a
   * replace conditioned on the ETag just read. A 412 (someone wrote in between)
   * is `concurrentUpdate`; it is not retried. A rename is checked against the
   * owner's other devices first.
   */
  async updateDevice(
    userId: string,
    deviceId: string,
    update: DeviceUpdate
  ): Promise<UpdateDeviceResult> {
    const existing = await this.readDocument(deviceId);
    let requestCharge = existing.requestCharge;
    const stored = existing.document;
    if (!stored || stored.userId !== userId) {
      return { outcome: 'notFound', requestCharge };
    }

    if (update.name !== undefined && update.name !== stored.name) {
      const owned = await this.listDevicesByOwner(userId);
      requestCharge += owned.requestCharge;
      if (owned.devices.some(other => other.id !== deviceId && other.name === update.name)) {
        return { outcome: 'nameConflict', requestCharge };
      }
    }

    // Replace the WHOLE stored document so unmodelled stored fields survive; only
    // the value returned is projected to Device. id and userId never change.
    const next: StoredDevice = {
      ...stored,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.location !== undefined ? { location: update.location } : {}),
      ...(update.configuration !== undefined
        ? { configuration: mergeDeviceConfiguration(stored.configuration, update.configuration) }
        : {}),
      id: stored.id,
      userId: stored.userId,
    };

    const options: RequestOptions | undefined = existing.etag
      ? { accessCondition: { type: 'IfMatch', condition: existing.etag } }
      : undefined;
    try {
      const response = await this.container
        .item(deviceId, deviceId)
        .replace<StoredDevice>(next, options);
      requestCharge += response.requestCharge;
      return { outcome: 'updated', device: toDevice(response.resource ?? next), requestCharge };
    } catch (error) {
      const status = statusCodeOf(error);
      if (status === 412) {
        return { outcome: 'concurrentUpdate', requestCharge: requestCharge + chargeOf(error) };
      }
      if (status === 409) {
        return { outcome: 'nameConflict', requestCharge: requestCharge + chargeOf(error) };
      }
      throw new DevicesStoreError(status, requestCharge + chargeOf(error));
    }
  }
}

/** The repository wired to the shared adapter's devices container. */
export function getDevicesRepository(): DevicesRepository {
  return new DevicesRepository(getCosmosAdapter().getDevicesContainer());
}

/**
 * Who owns `deviceId`, relative to the authenticated `userId`, through the
 * shared adapter. The entry point for cook and SignalR authorization. May throw
 * `CosmosConfigError` (unconfigured app) or a Cosmos error; it never returns HTTP.
 */
export function getDeviceOwnership(userId: string, deviceId: string): Promise<DeviceOwnership> {
  return getDevicesRepository().getDeviceOwnership(userId, deviceId);
}
