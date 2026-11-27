import type { AcceptanceApi } from '../lib/proof';
import { defineProofs } from '../lib/proof';

/**
 * #243 (spec #237, "Sending to Apple") — the deployed API can reach Apple's
 * push service: the Function App signs its provider token through the Key Vault
 * under its managed identity, and Apple's sandbox accepts that token.
 *
 * `GET /health/apns` sends one push to a made-up device token. Apple checks the
 * provider token before the device token, so the answer `400 BadDeviceToken`
 * (route status 200) proves the token was accepted. A provider-token refusal
 * (`InvalidProviderToken`, `ExpiredProviderToken`, ...) or a Key Vault failure
 * answers 503 and fails the proof, with the route's fixed code and Apple's
 * reason word in the message. Nothing reaches a device, and the response never
 * carries a token, the key or a team id.
 *
 * It needs the owner's key imported into the dev Key Vault and the APNS_KEY_ID
 * and APNS_TEAM_ID secrets set (docs/infrastructure/apns-key-vault.md).
 */

/** Only fixed codes and Apple's reason words are echoed into a failure line. */
const SAFE_WORD = /^[A-Za-z_0-9]{1,64}$/;

export default defineProofs('apns health', () => [
  {
    name: 'GET /health/apns: Apple accepts the provider token the Function App signed',
    async run(api: AcceptanceApi) {
      const response = await api.request<{
        status?: string;
        error?: string;
        reason?: string;
        probeStatusCode?: number;
      }>({
        method: 'GET',
        path: '/health/apns',
        expectRequestCharge: false,
      });
      const body = response.body;
      const word = (value: unknown): string =>
        typeof value === 'string' && SAFE_WORD.test(value) ? value : 'unrecognised';
      api.check(
        response,
        response.status === 200 && body?.status === 'healthy',
        `APNs health answered ${response.status}: error ${word(body?.error)}, ` +
          `reason ${word(body?.reason)}, status ${
            typeof body?.probeStatusCode === 'number' ? body.probeStatusCode : 'none'
          }`
      );
    },
  },
]);
