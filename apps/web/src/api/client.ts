import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { components, paths } from '@meatgeekv2/api-specs/types';
import type { TokenGetter } from '../auth/token';

/**
 * A client typed by libs/api-specs/spec/openapi.yaml. The types are generated
 * by `nx run api-specs:generate-types` before every web build, test, lint and
 * typecheck, so a path, method or body the spec does not declare fails `tsc`.
 */
export type ApiClient = Client<paths>;
export type Device = components['schemas']['Device'];
export type RegisterDeviceRequest = components['schemas']['RegisterDeviceRequest'];
export type Cook = components['schemas']['Cook'];
export type CookStatus = components['schemas']['CookStatus'];
export type StartCookRequest = components['schemas']['StartCookRequest'];
export type CookListResponse = components['schemas']['CookListResponse'];

export interface ApiClientOptions {
  baseUrl: string;
  getToken: TokenGetter;
}

export function createApiClient({ baseUrl, getToken }: ApiClientOptions): ApiClient {
  const client = createClient<paths>({ baseUrl });
  client.use(authAndRequestIdMiddleware(getToken));
  return client;
}

/**
 * Adds `Authorization: Bearer <token>` and a fresh `X-Request-ID` to every
 * request. The token comes from the token getter on each call, so an expired
 * token is refreshed silently (or by redirect) rather than reused.
 */
export function authAndRequestIdMiddleware(getToken: TokenGetter): Middleware {
  return {
    async onRequest({ request }) {
      const token = await getToken();
      request.headers.set('Authorization', `Bearer ${token}`);
      request.headers.set('X-Request-ID', crypto.randomUUID());
      return request;
    },
  };
}
