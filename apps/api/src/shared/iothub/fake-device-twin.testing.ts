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
 */
export class FakeTwinHub implements DeviceTwinPort {
  private readonly twins = new Map<string, { version: number; desired: Record<string, unknown> }>();
  readonly gets: string[] = [];
  readonly patches: Array<{ deviceId: string; desired: DesiredPatch; etag: string }> = [];
  /** Runs before each PATCH is applied; may write to the hub itself. */
  beforePatch?: (deviceId: string, desired: DesiredPatch) => Promise<void> | void;

  addDevice(deviceId: string, desired: Record<string, unknown> = {}): this {
    this.twins.set(deviceId, { version: 1, desired: { ...desired } });
    return this;
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
    const twin = this.twins.get(deviceId);
    if (!twin) {
      throw new DeviceTwinError('get_twin', 404);
    }
    return {
      etag: this.etagOf(twin.version),
      desired: { ...twin.desired, $version: twin.version },
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
