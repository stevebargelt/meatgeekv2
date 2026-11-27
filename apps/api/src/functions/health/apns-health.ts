import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import type { ApnsClient } from '../../shared/apns/apns-client';
import { ApnsConfigError } from '../../shared/apns/apns-config';
import { KeyVaultSignError, type KeyVaultSignFailure } from '../../shared/apns/key-vault-signer';
import { getSharedApnsClient } from '../../shared/apns/shared-client';

/**
 * #243 — health check for the API's path to Apple. It signs a provider token
 * through Key Vault under the Function App's identity and sends one push to a
 * made-up device token on the configured APNs host. Apple checks the provider
 * token before the device token, so:
 *
 *   - `400 BadDeviceToken`  → Apple accepted the token this app signed: healthy;
 *   - anything else         → unhealthy, with Apple's `reason` or the step that
 *                             failed (a fixed code), and a numeric status.
 *
 * Nothing reaches a device. The body never carries the token, the key, a team
 * id, or a dependency's error text.
 */

/** Not a device: 64 hex characters, the shape Apple expects, that no phone owns. */
export const MADE_UP_DEVICE_TOKEN = '0'.repeat(64);

export type ApnsHealthFailure =
  | ApnsConfigError['code']
  | KeyVaultSignFailure
  | 'apns_unreachable'
  | 'apns_rejected';

export interface ApnsHealthResult {
  status: 'healthy' | 'unhealthy';
  responseTime: number;
  error?: ApnsHealthFailure;
  /** Apple's own reason word (`InvalidProviderToken`, ...). */
  reason?: string;
  /** The numeric status Apple or Key Vault answered with. */
  probeStatusCode?: number;
}

export type ApnsClientFactory = () => ApnsClient;

/** Production wiring: one client per warm instance, shared with the target alerts. */
const sharedClientFactory: ApnsClientFactory = getSharedApnsClient;

export async function checkApnsHealth(
  clientFactory: ApnsClientFactory = sharedClientFactory,
  now: () => number = () => Date.now()
): Promise<ApnsHealthResult> {
  const startedAt = now();
  const unhealthy = (
    error: ApnsHealthFailure,
    extra: { reason?: string; probeStatusCode?: number } = {}
  ): ApnsHealthResult => ({ status: 'unhealthy', responseTime: now() - startedAt, error, ...extra });

  try {
    const result = await clientFactory().send({
      deviceToken: MADE_UP_DEVICE_TOKEN,
      pushType: 'alert',
      priority: 5,
      payload: { aps: { alert: 'MeatGeek APNs health probe' } },
    });
    if (result.status === 400 && result.reason === 'BadDeviceToken') {
      return { status: 'healthy', responseTime: now() - startedAt };
    }
    return unhealthy('apns_rejected', {
      probeStatusCode: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  } catch (error) {
    if (error instanceof ApnsConfigError) {
      return unhealthy(error.code);
    }
    if (error instanceof KeyVaultSignError) {
      return unhealthy(error.code, error.status === undefined ? {} : { probeStatusCode: error.status });
    }
    return unhealthy('apns_unreachable');
  }
}

export async function apnsHealthHandler(
  _request: HttpRequest,
  context: InvocationContext,
  clientFactory?: ApnsClientFactory
): Promise<HttpResponseInit> {
  context.log('Processing APNs health check');
  const result = await checkApnsHealth(clientFactory);

  if (result.status !== 'healthy') {
    // Fixed codes, Apple's reason word and a number: nothing that can carry a token.
    context.error(
      `APNs health check failed: ${result.error}` +
        (result.reason ? ` (${result.reason})` : '') +
        (result.probeStatusCode === undefined ? '' : ` (status ${result.probeStatusCode})`)
    );
  }

  return {
    status: result.status === 'healthy' ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': context.invocationId },
    jsonBody: {
      status: result.status,
      responseTime: result.responseTime,
      error: result.error,
      reason: result.reason,
      probeStatusCode: result.probeStatusCode,
      requestId: context.invocationId,
    },
  };
}
