import type { AcceptanceApi } from '../lib/proof';
import { defineProofs } from '../lib/proof';

/**
 * HAR-11 proof 1 — the cooks list refuses a caller with no Authorization
 * header. No Cosmos call is made for a rejected caller, so no RU header is
 * expected.
 */
export default defineProofs('cooks auth', () => [
  {
    name: 'GET /cooks without a token is refused with 401',
    async run(api: AcceptanceApi) {
      const response = await api.request({
        method: 'GET',
        path: '/cooks',
        authenticated: false,
        expectRequestCharge: false,
      });
      api.expectStatus(response, 401);
    },
  },
]);
