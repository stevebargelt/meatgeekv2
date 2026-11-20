import { ManagedIdentityCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/core-auth';

/**
 * HAR-66 (goal HAR-55) — the API's client for the IoT Hub service REST API's
 * device twin operations. The active cook is device state: the API writes it to
 * the twin's desired properties, and data-pusher on the Pi reads it (HAR-58).
 *
 * NO IOT SDK
 * Two REST calls are all the API needs, so it speaks them directly with fetch,
 * the same way the SignalR data-plane client does.
 *
 * AUTH
 * Every call carries an Entra token for `https://iothubs.azure.net/.default`
 * from ManagedIdentityCredential (never DefaultAzureCredential, never a shared
 * access key). The Function App identity holds `IoT Hub Twin Contributor` where
 * `api_device_twin_writer_enabled` is on (dev since HAR-64).
 *
 * SANITIZED FAILURES
 * Every failure is a {@link DeviceTwinError} carrying a fixed operation name
 * and, when the hub answered, its numeric status. It never carries the host,
 * the device id, a token, or the text of the underlying error, so a caller may
 * log `error.code` verbatim.
 */

/** The app setting Terraform publishes with the hub's hostname (HAR-56). */
export const IOTHUB_SERVICE_HOSTNAME_SETTING = 'IOTHUB_SERVICE_HOSTNAME';

/** The Entra scope for the IoT Hub service API. */
export const IOTHUB_TOKEN_SCOPE = 'https://iothubs.azure.net/.default';

/** The IoT Hub service REST API version this client speaks. */
export const IOTHUB_API_VERSION = '2021-04-12';

/** How long one REST call may take before it counts as a failure. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A hostname: labels of letters, digits and hyphens. No scheme, port or path. */
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** The twin as this API reads it: its etag and its desired properties. */
export interface DeviceTwin {
  readonly etag: string;
  /** `properties.desired`, including IoT Hub's own `$metadata` and `$version`. */
  readonly desired: Readonly<Record<string, unknown>>;
}

/**
 * A desired-properties patch. `null` deletes the property (IoT Hub's own rule),
 * which is how "absent" reaches the device.
 */
export type DesiredPatch = Readonly<Record<string, string | null>>;

/** The operations this client performs; also the fixed names in its errors. */
export type DeviceTwinOperation = 'configuration' | 'credential' | 'get_twin' | 'patch_twin';

/**
 * A twin call failed, or the hub is not configured. Carries only fixed text:
 * the operation and, when the hub answered, its numeric status.
 */
export class DeviceTwinError extends Error {
  /** Safe to log, e.g. `iothub_patch_twin_status_412`. */
  readonly code: string;

  constructor(
    readonly operation: DeviceTwinOperation,
    readonly status?: number
  ) {
    const code =
      status === undefined ? `iothub_${operation}_failed` : `iothub_${operation}_status_${status}`;
    super(code);
    this.name = 'DeviceTwinError';
    this.code = code;
  }

  /** The `If-Match` etag no longer matched: someone else wrote the twin. */
  get isPreconditionFailed(): boolean {
    return this.status === 412;
  }

  /** The hub has no device with this id, so it has no twin. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** The twin operations the sync depends on. */
export interface DeviceTwinPort {
  getTwin(deviceId: string): Promise<DeviceTwin>;
  patchDesired(deviceId: string, desired: DesiredPatch, etag: string): Promise<void>;
}

/** Constructor seams, so unit tests run with a stub credential and a stub fetch. */
export interface DeviceTwinSeams {
  readonly credential: TokenCredential;
  readonly fetch: typeof fetch;
}

/**
 * Reads and checks the hub hostname. Throws {@link DeviceTwinError}
 * (`configuration`) when it is missing, blank or not a bare hostname; the value
 * itself never reaches the error.
 */
export function resolveIotHubHostname(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[IOTHUB_SERVICE_HOSTNAME_SETTING]?.trim();
  if (!raw || !HOSTNAME_PATTERN.test(raw)) {
    throw new DeviceTwinError('configuration');
  }
  return raw.toLowerCase();
}

/**
 * An HTTP entity tag is a quoted string. IoT Hub returns the twin etag bare
 * (`AAAAAAAAAAE=`), and the service SDKs quote it before sending it back in
 * `If-Match`; this does the same, leaving an already-quoted tag alone.
 */
export function quoteEtag(etag: string): string {
  return etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"') ? etag : `"${etag}"`;
}

export class DeviceTwinClient implements DeviceTwinPort {
  constructor(
    private readonly hostname: string,
    private readonly seams: DeviceTwinSeams
  ) {}

  /** `GET /twins/{id}` — the twin's etag and desired properties. */
  async getTwin(deviceId: string): Promise<DeviceTwin> {
    const response = await this.call('get_twin', 'GET', deviceId);
    let body: { etag?: unknown; properties?: { desired?: unknown } } | null;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = null;
    }
    const etag = body?.etag;
    const desired = body?.properties?.desired ?? {};
    if (
      typeof etag !== 'string' ||
      etag.length === 0 ||
      typeof desired !== 'object' ||
      desired === null
    ) {
      throw new DeviceTwinError('get_twin', response.status);
    }
    return { etag, desired: desired as Record<string, unknown> };
  }

  /**
   * `PATCH /twins/{id}` with `{ properties: { desired } }`, conditional on the
   * etag read by {@link getTwin}. A 412 means the twin changed since; the error
   * says so through {@link DeviceTwinError.isPreconditionFailed}.
   */
  async patchDesired(deviceId: string, desired: DesiredPatch, etag: string): Promise<void> {
    await this.call('patch_twin', 'PATCH', deviceId, {
      headers: { 'Content-Type': 'application/json', 'If-Match': quoteEtag(etag) },
      body: JSON.stringify({ properties: { desired } }),
    });
  }

  /**
   * One authenticated REST call. Any non-2xx answer, a network failure or a
   * timeout becomes a {@link DeviceTwinError} for `operation`.
   */
  private async call(
    operation: 'get_twin' | 'patch_twin',
    method: 'GET' | 'PATCH',
    deviceId: string,
    extra: { headers?: Record<string, string>; body?: string } = {}
  ): Promise<Response> {
    let bearer: string;
    try {
      const token = await this.seams.credential.getToken(IOTHUB_TOKEN_SCOPE);
      if (!token?.token) {
        throw new Error('no token');
      }
      bearer = token.token;
    } catch {
      // The credential's error can name the identity endpoint; it is dropped.
      throw new DeviceTwinError('credential');
    }

    const query = new URLSearchParams({ 'api-version': IOTHUB_API_VERSION });
    const url = `https://${this.hostname}/twins/${encodeURIComponent(deviceId)}?${query.toString()}`;
    let response: Response;
    try {
      response = await this.seams.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, ...extra.headers },
        body: extra.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // A fetch failure's text and cause carry the host; they are dropped.
      throw new DeviceTwinError(operation);
    }
    if (!response.ok) {
      throw new DeviceTwinError(operation, response.status);
    }
    return response;
  }
}

let shared: DeviceTwinClient | undefined;

/**
 * The client the deployed app uses, built on first call and reused for the life
 * of the host so the credential's token cache survives warm invocations. Throws
 * {@link DeviceTwinError} (`configuration`) when the hostname setting is
 * missing; a later call retries.
 */
export function getDeviceTwinClient(): DeviceTwinClient {
  if (!shared) {
    shared = new DeviceTwinClient(resolveIotHubHostname(), {
      credential: new ManagedIdentityCredential(),
      fetch: (input, init) => fetch(input, init),
    });
  }
  return shared;
}
