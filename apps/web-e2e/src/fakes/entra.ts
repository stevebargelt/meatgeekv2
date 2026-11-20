import { createHash, randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { base64Url, corsHeaders, fulfillJson, fulfillPreflight } from './http';
import type { TestConfig, TestUser } from './test-config';

const LOGIN_HOST = 'https://login.microsoftonline.com';

interface IssuedCode {
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

/**
 * Entra ID, faked with `page.route` on login.microsoftonline.com, so the app's
 * real MSAL runs its real `loginRedirect` and authorization code + PKCE
 * exchange:
 *
 * - OpenID discovery (and instance discovery, if MSAL asks) describe this
 *   tenant's endpoints.
 * - `authorize` (a full-page navigation) redirects back to the app's
 *   `redirect_uri` with a fresh `code` and the request's own `state`.
 * - `token` checks the code, the client and the PKCE verifier against what
 *   `authorize` received, and returns an unsigned id token (with the
 *   authorize request's `nonce` and `aud` = the client id), an access token
 *   for the API scope and a refresh token. MSAL checks the nonce; it does not
 *   verify id token signatures in the browser.
 *
 * Anything else on the host is answered 404 and listed in `unexpected`.
 */
export class FakeEntra {
  /** The bearer token the fake API expects on every call. */
  readonly accessToken = `e2e-access-token-${randomUUID()}`;
  readonly authorizeRequests: URL[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly unexpected: string[] = [];
  private readonly codes = new Map<string, IssuedCode>();

  constructor(
    private readonly config: TestConfig,
    private readonly user: TestUser
  ) {}

  async install(page: Page): Promise<void> {
    await page.route(`${LOGIN_HOST}/**`, route => this.handle(route));
  }

  private get tenantBase(): string {
    return `${LOGIN_HOST}/${this.config.tenantId}`;
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') return fulfillPreflight(route);

    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return fulfillJson(route, 200, this.openIdConfiguration());
    }
    if (url.pathname === '/common/discovery/instance') {
      return fulfillJson(route, 200, {
        tenant_discovery_endpoint: `${this.tenantBase}/v2.0/.well-known/openid-configuration`,
        'api-version': '1.1',
        metadata: [
          {
            preferred_network: 'login.microsoftonline.com',
            preferred_cache: 'login.windows.net',
            aliases: ['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com'],
          },
        ],
      });
    }
    if (url.pathname === `/${this.config.tenantId}/oauth2/v2.0/authorize`) {
      return this.authorize(route, url);
    }
    if (
      url.pathname === `/${this.config.tenantId}/oauth2/v2.0/token` &&
      request.method() === 'POST'
    ) {
      return this.token(route, new URLSearchParams(request.postData() ?? ''));
    }

    this.unexpected.push(`${request.method()} ${request.url()}`);
    return fulfillJson(route, 404, { error: 'not_found', error_description: 'Not faked.' });
  }

  private openIdConfiguration() {
    return {
      issuer: `${this.tenantBase}/v2.0`,
      authorization_endpoint: `${this.tenantBase}/oauth2/v2.0/authorize`,
      token_endpoint: `${this.tenantBase}/oauth2/v2.0/token`,
      end_session_endpoint: `${this.tenantBase}/oauth2/v2.0/logout`,
      jwks_uri: `${this.tenantBase}/discovery/v2.0/keys`,
      response_modes_supported: ['query', 'fragment', 'form_post'],
      response_types_supported: ['code', 'id_token', 'code id_token', 'id_token token'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'name', 'oid', 'tid'],
      tenant_region_scope: null,
      cloud_instance_name: 'microsoftonline.com',
      cloud_graph_host_name: 'graph.windows.net',
      msgraph_host: 'graph.microsoft.com',
    };
  }

  private async authorize(route: Route, url: URL): Promise<void> {
    this.authorizeRequests.push(url);
    const params = url.searchParams;
    const problems: string[] = [];
    if (params.get('client_id') !== this.config.clientId) problems.push('client_id');
    if (params.get('response_type') !== 'code') problems.push('response_type');
    if (params.get('code_challenge_method') !== 'S256') problems.push('code_challenge_method');
    for (const name of ['redirect_uri', 'state', 'nonce', 'code_challenge']) {
      if (!params.get(name)) problems.push(name);
    }
    if (problems.length > 0) {
      this.unexpected.push(`authorize request missing or wrong: ${problems.join(', ')}`);
      await route.fulfill({
        status: 400,
        contentType: 'text/plain',
        body: 'Bad authorize request',
      });
      return;
    }

    const redirectUri = params.get('redirect_uri') as string;
    const code = `e2e-code-${randomUUID()}`;
    this.codes.set(code, {
      nonce: params.get('nonce') as string,
      codeChallenge: params.get('code_challenge') as string,
      redirectUri,
    });
    const response = new URLSearchParams({
      code,
      state: params.get('state') as string,
      client_info: this.clientInfo(),
      session_state: randomUUID(),
    });
    // MSAL's default response mode for a redirect is the fragment.
    const separator = params.get('response_mode') === 'query' ? '?' : '#';
    await route.fulfill({
      status: 302,
      headers: { location: `${redirectUri}${separator}${response.toString()}` },
    });
  }

  private async token(route: Route, body: URLSearchParams): Promise<void> {
    this.tokenRequests.push(body);
    const fail = (description: string) => {
      this.unexpected.push(`token request rejected: ${description}`);
      return fulfillJson(route, 400, { error: 'invalid_grant', error_description: description });
    };
    if (body.get('client_id') !== this.config.clientId) return fail('client_id');

    let nonce: string | undefined;
    const grant = body.get('grant_type');
    if (grant === 'authorization_code') {
      const code = body.get('code') ?? '';
      const issued = this.codes.get(code);
      if (!issued) return fail('unknown or reused code');
      this.codes.delete(code);
      const verifier = body.get('code_verifier') ?? '';
      const challenge = base64Url(createHash('sha256').update(verifier).digest());
      if (challenge !== issued.codeChallenge) return fail('PKCE code_verifier does not match');
      if (body.get('redirect_uri') !== issued.redirectUri) return fail('redirect_uri');
      nonce = issued.nonce;
    } else if (grant !== 'refresh_token') {
      return fail(`grant_type ${grant}`);
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(route),
      body: JSON.stringify({
        token_type: 'Bearer',
        scope: this.config.apiScope,
        expires_in: 3600,
        ext_expires_in: 3600,
        access_token: this.accessToken,
        refresh_token: `e2e-refresh-token-${randomUUID()}`,
        id_token: this.idToken(nonce),
        client_info: this.clientInfo(),
      }),
    });
  }

  /** An unsigned JWT: `alg: none`. Only the claims matter to MSAL. */
  private idToken(nonce: string | undefined): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({
        ver: '2.0',
        iss: `${this.tenantBase}/v2.0`,
        aud: this.config.clientId,
        tid: this.config.tenantId,
        oid: this.user.oid,
        sub: this.user.oid,
        name: this.user.name,
        preferred_username: this.user.username,
        iat: now,
        nbf: now,
        exp: now + 3600,
        ...(nonce === undefined ? {} : { nonce }),
      })
    );
    return `${header}.${claims}.unsigned`;
  }

  private clientInfo(): string {
    return base64Url(JSON.stringify({ uid: this.user.oid, utid: this.config.tenantId }));
  }
}
