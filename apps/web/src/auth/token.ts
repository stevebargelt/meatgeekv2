import { InteractionRequiredAuthError, type IPublicClientApplication } from '@azure/msal-browser';

/** Thrown while the browser is navigating away to Entra for interaction. */
export class InteractionRedirectError extends Error {
  constructor() {
    super('Your session needs you to sign in again. Redirecting to Microsoft…');
    this.name = 'InteractionRedirectError';
  }
}

export type TokenGetter = () => Promise<string>;

/**
 * Returns a function that yields an access token for the API scope. Every
 * API call goes through it: `acquireTokenSilent` (cache, then refresh token),
 * and on `InteractionRequiredAuthError` a full-page `acquireTokenRedirect`.
 */
export function createTokenGetter(
  instance: IPublicClientApplication,
  apiScope: string
): TokenGetter {
  return async () => {
    const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
    if (!account) {
      throw new Error('You are not signed in.');
    }
    const request = { scopes: [apiScope], account };
    try {
      const result = await instance.acquireTokenSilent(request);
      return result.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        await instance.acquireTokenRedirect(request);
        throw new InteractionRedirectError();
      }
      throw err;
    }
  };
}
