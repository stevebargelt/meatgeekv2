import { ManagedIdentityCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/core-auth';

import { HUB_NAME } from '../../functions/signalr/envelope';

/**
 * HAR-57 (MG-30) — the API's client for the Azure SignalR Service data-plane
 * REST API. It mints client access tokens for a user and manages which groups a
 * user is in. negotiate and register-device use it; the cook producers still
 * send through the Functions SignalR output binding.
 *
 * WHY NOT THE FUNCTIONS BINDING
 * The SignalR connection-info input binding can only take its userId from a
 * binding expression. Our userId is the principal's `"<tid>:<oid>"`, which no
 * expression can produce (the Easy Auth `x-ms-client-principal-id` header is the
 * oid alone). So negotiate mints the token itself through this client.
 *
 * AUTH
 * Local auth is disabled on the service, so there is no access key to sign with.
 * Every call carries an Entra token for `https://signalr.azure.com/.default`
 * from ManagedIdentityCredential, the same credential the Cosmos adapter uses
 * (never DefaultAzureCredential). The Function App identity holds
 * `SignalR Service Owner`.
 *
 * SANITIZED FAILURES
 * Every failure is a {@link SignalRUnavailableError} carrying a fixed operation
 * name and, when the service answered, its numeric status. The error never
 * carries the endpoint, the user id, a group name, a token, or the text of the
 * underlying error, so a caller may log `error.code` verbatim.
 */

/** The app setting Terraform publishes for identity-based SignalR. */
export const SIGNALR_SERVICE_URI_SETTING = 'AzureSignalRConnectionString__serviceUri';

/** The Entra scope for the SignalR data plane. */
export const SIGNALR_TOKEN_SCOPE = 'https://signalr.azure.com/.default';

/**
 * The data-plane REST API version this client speaks (HAR-59). `2024-12-01` is
 * a published stable version whose reference documents all three operations
 * this client uses. `2022-11-01`, used before, is a Web PubSub version and is
 * not a published SignalR one; `:generateToken` first appears in `2023-07-01`.
 * Source: https://learn.microsoft.com/azure/azure-signalr/swagger/signalr-data-plane-rest-v20241201
 */
export const SIGNALR_API_VERSION = '2024-12-01';

/** Lifetime of a client access token minted by negotiate. */
export const CLIENT_TOKEN_MINUTES = 60;

/** How long one REST call may take before it counts as a failure. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The group a device's readings and events are sent to. */
export function deviceGroup(deviceId: string): string {
  return `device-${deviceId}`;
}

/** What a client needs to open its connection. */
export interface SignalRClientConnection {
  /** `{serviceUri}/client/?hub={hub}` */
  readonly url: string;
  readonly accessToken: string;
}

/** The operations this client performs; also the fixed names in its errors. */
export type SignalROperation =
  | 'configuration'
  | 'credential'
  | 'generate_token'
  | 'remove_user_from_all_groups'
  | 'add_user_to_group';

/**
 * A SignalR call failed, or SignalR is not configured. Carries only fixed text:
 * the operation and, when the service answered, its numeric status.
 */
export class SignalRUnavailableError extends Error {
  /** Safe to log, e.g. `signalr_add_user_to_group_status_403`. */
  readonly code: string;

  constructor(
    readonly operation: SignalROperation,
    readonly status?: number
  ) {
    const code =
      status === undefined
        ? `signalr_${operation}_failed`
        : `signalr_${operation}_status_${status}`;
    super(code);
    this.name = 'SignalRUnavailableError';
    this.code = code;
  }
}

/** The group operations register-device and negotiate depend on. */
export interface SignalRGroupsPort {
  removeUserFromAllGroups(userId: string): Promise<void>;
  addUserToGroup(group: string, userId: string): Promise<void>;
}

/** Everything negotiate needs from SignalR. */
export interface SignalRManagementPort extends SignalRGroupsPort {
  generateClientToken(userId: string): Promise<SignalRClientConnection>;
}

/** Constructor seams, so unit tests run with a stub credential and a stub fetch. */
export interface SignalRManagementSeams {
  readonly credential: TokenCredential;
  readonly fetch: typeof fetch;
}

/**
 * Reads and checks the service URI. Throws {@link SignalRUnavailableError}
 * (`configuration`) when it is missing, blank or not an https URL; the value
 * itself never reaches the error.
 */
export function resolveSignalRServiceUri(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[SIGNALR_SERVICE_URI_SETTING]?.trim();
  if (!raw) {
    throw new SignalRUnavailableError('configuration');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SignalRUnavailableError('configuration');
  }
  if (parsed.protocol !== 'https:') {
    throw new SignalRUnavailableError('configuration');
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

export class SignalRManagementClient implements SignalRManagementPort {
  constructor(
    private readonly serviceUri: string,
    private readonly hub: string,
    private readonly seams: SignalRManagementSeams
  ) {}

  /** `POST /api/hubs/{hub}/:generateToken?userId=…&minutesToExpire=60` */
  async generateClientToken(userId: string): Promise<SignalRClientConnection> {
    const query = new URLSearchParams({
      userId,
      minutesToExpire: String(CLIENT_TOKEN_MINUTES),
    });
    const response = await this.call(
      'generate_token',
      'POST',
      `/api/hubs/${encodeURIComponent(this.hub)}/:generateToken`,
      query
    );
    let token: unknown;
    try {
      token = ((await response.json()) as { token?: unknown } | null)?.token;
    } catch {
      token = undefined;
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new SignalRUnavailableError('generate_token', response.status);
    }
    return {
      url: `${this.serviceUri}/client/?hub=${encodeURIComponent(this.hub)}`,
      accessToken: token,
    };
  }

  /** `DELETE /api/hubs/{hub}/users/{user}/groups` */
  async removeUserFromAllGroups(userId: string): Promise<void> {
    await this.call(
      'remove_user_from_all_groups',
      'DELETE',
      `/api/hubs/${encodeURIComponent(this.hub)}/users/${encodeURIComponent(userId)}/groups`
    );
  }

  /**
   * `PUT /api/hubs/{hub}/users/{user}/groups/{group}` (HAR-59). The versioned
   * API has no `/groups/{group}/users/{user}` route; that shape is the legacy
   * `/api/v1` one. No `ttl`: the user stays in the group whether or not it has
   * a connection yet, which is what negotiate needs before the client connects.
   */
  async addUserToGroup(group: string, userId: string): Promise<void> {
    await this.call(
      'add_user_to_group',
      'PUT',
      `/api/hubs/${encodeURIComponent(this.hub)}/users/${encodeURIComponent(
        userId
      )}/groups/${encodeURIComponent(group)}`
    );
  }

  /**
   * One authenticated REST call. Any non-2xx answer, a network failure or a
   * timeout becomes a {@link SignalRUnavailableError} for `operation`.
   */
  private async call(
    operation: SignalROperation,
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    query: URLSearchParams = new URLSearchParams()
  ): Promise<Response> {
    let bearer: string;
    try {
      const token = await this.seams.credential.getToken(SIGNALR_TOKEN_SCOPE);
      if (!token?.token) {
        throw new Error('no token');
      }
      bearer = token.token;
    } catch {
      // The credential's error can name the identity endpoint; it is dropped.
      throw new SignalRUnavailableError('credential');
    }

    query.set('api-version', SIGNALR_API_VERSION);
    let response: Response;
    try {
      response = await this.seams.fetch(`${this.serviceUri}${path}?${query.toString()}`, {
        method,
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // A fetch failure's text and cause carry the host; they are dropped.
      throw new SignalRUnavailableError(operation);
    }
    if (!response.ok) {
      throw new SignalRUnavailableError(operation, response.status);
    }
    return response;
  }
}

let shared: SignalRManagementClient | undefined;

/**
 * The client the deployed app uses, built on first call and reused for the life
 * of the host so the credential's token cache survives warm invocations. Throws
 * {@link SignalRUnavailableError} (`configuration`) when the service URI setting
 * is missing; a later call retries.
 */
export function getSignalRManagementClient(): SignalRManagementClient {
  if (!shared) {
    shared = new SignalRManagementClient(resolveSignalRServiceUri(), HUB_NAME, {
      credential: new ManagedIdentityCredential(),
      fetch: (input, init) => fetch(input, init),
    });
  }
  return shared;
}
