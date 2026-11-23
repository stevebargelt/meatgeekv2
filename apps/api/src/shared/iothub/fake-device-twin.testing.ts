import {
  DeviceTwinError,
  type DesiredPatch,
  type DeviceTwin,
  type DeviceTwinPort,
} from './device-twin';

/**
 * HAR-66 — an in-memory IoT Hub that behaves like the service REST API for the
 * two twin calls the API makes: a device without a twin answers 404, a PATCH
 * whose etag is stale answers 412, `null` deletes a desired property, and every
 * accepted PATCH bumps the version and the etag. Test-only.
 *
 * `beforePatch` runs between a caller's GET and its PATCH, so a test can land a
 * competing write there and model a race deterministically.
 *
 * HAR-130: a twin also has reported properties, which only the device writes
 * ({@link FakeTwinHub.report}). `failNext` makes the next GET or PATCH answer a
 * given status, for the claim route's 503 path.
 */
export class FakeTwinHub implements DeviceTwinPort {
  private readonly twins = new Map<
    string,
    {
      version: number;
      desired: Record<string, unknown>;
      reported: Record<string, unknown>;
      connection?: { connectionState?: string; lastActivityTime?: string };
    }
  >();
  private readonly failures: Array<{ operation: 'get_twin' | 'patch_twin'; status?: number }> = [];
  readonly gets: string[] = [];
  readonly patches: Array<{ deviceId: string; desired: DesiredPatch; etag: string }> = [];
  /** Runs before each PATCH is applied; may write to the hub itself. */
  beforePatch?: (deviceId: string, desired: DesiredPatch) => Promise<void> | void;

  addDevice(
    deviceId: string,
    desired: Record<string, unknown> = {},
    reported: Record<string, unknown> = {}
  ): this {
    this.twins.set(deviceId, { version: 1, desired: { ...desired }, reported: { ...reported } });
    return this;
  }

  /** A reported-properties write by the device itself. `null` deletes. */
  report(deviceId: string, reported: Readonly<Record<string, string | null>>): void {
    const twin = this.twins.get(deviceId);
    if (!twin) {
      throw new Error(`no twin for ${deviceId}`);
    }
    for (const [key, value] of Object.entries(reported)) {
      if (value === null) {
        delete twin.reported[key];
      } else {
        twin.reported[key] = value;
      }
    }
  }

  /**
   * HAR-143: the twin's top-level `connectionState` and `lastActivityTime`,
   * which IoT Hub itself maintains. A twin without them returns neither.
   */
  setConnection(
    deviceId: string,
    connection: { connectionState?: string; lastActivityTime?: string }
  ): this {
    const twin = this.twins.get(deviceId);
    if (!twin) {
      throw new Error(`no twin for ${deviceId}`);
    }
    twin.connection = { ...connection };
    return this;
  }

  /** The next GET or PATCH fails: with `status`, or as a network failure. */
  failNext(operation: 'get_twin' | 'patch_twin', status?: number): void {
    this.failures.push({ operation, status });
  }

  private takeFailure(operation: 'get_twin' | 'patch_twin'): void {
    const index = this.failures.findIndex(failure => failure.operation === operation);
    if (index !== -1) {
      const [failure] = this.failures.splice(index, 1);
      throw new DeviceTwinError(operation, failure.status);
    }
  }

  /** The desired cook properties as the device would read them. */
  desired(deviceId: string): Record<string, unknown> | undefined {
    const twin = this.twins.get(deviceId);
    return twin && { ...twin.desired };
  }

  /** A write by someone else (another API instance), bypassing the etag. */
  forceWrite(deviceId: string, desired: DesiredPatch): void {
    this.apply(deviceId, desired);
  }

  async getTwin(deviceId: string): Promise<DeviceTwin> {
    this.gets.push(deviceId);
    this.takeFailure('get_twin');
    const twin = this.twins.get(deviceId);
    if (!twin) {
      throw new DeviceTwinError('get_twin', 404);
    }
    return {
      etag: this.etagOf(twin.version),
      desired: { ...twin.desired, $version: twin.version },
      reported: { ...twin.reported },
      ...twin.connection,
    };
  }

  async patchDesired(deviceId: string, desired: DesiredPatch, etag: string): Promise<void> {
    this.patches.push({ deviceId, desired, etag });
    const hook = this.beforePatch;
    if (hook) {
      // One shot, so the hook's own writes do not recurse into it.
      this.beforePatch = undefined;
      await hook(deviceId, desired);
    }
    this.takeFailure('patch_twin');
    const twin = this.twins.get(deviceId);
    if (!twin) {
      throw new DeviceTwinError('patch_twin', 404);
    }
    if (etag !== this.etagOf(twin.version)) {
      throw new DeviceTwinError('patch_twin', 412);
    }
    this.apply(deviceId, desired);
  }

  private apply(deviceId: string, desired: DesiredPatch): void {
    const twin = this.twins.get(deviceId);
    if (!twin) {
      throw new DeviceTwinError('patch_twin', 404);
    }
    for (const [key, value] of Object.entries(desired)) {
      if (value === null) {
        delete twin.desired[key];
      } else {
        twin.desired[key] = value;
      }
    }
    twin.version += 1;
  }

  private etagOf(version: number): string {
    return `etag-${version}`;
  }
}
