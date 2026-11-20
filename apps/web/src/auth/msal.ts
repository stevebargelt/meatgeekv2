import {
  BrowserCacheLocation,
  EventType,
  PublicClientApplication,
  type AuthenticationResult,
  type IPublicClientApplication,
} from '@azure/msal-browser';
import type { AppConfig } from '../config/config';

/**
 * The SPA's MSAL instance. MSAL's browser flow is authorization code + PKCE;
 * there is no client secret. Tokens are cached in sessionStorage (MSAL's
 * default, stated here so nobody has to look it up).
 */
export function createMsalInstance(config: AppConfig): PublicClientApplication {
  const instance = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: BrowserCacheLocation.SessionStorage },
  });
  trackActiveAccount(instance);
  return instance;
}

/**
 * Keeps MSAL's active account set: after a redirect sign-in completes, and on
 * a reload when the session cache already holds an account.
 */
export function trackActiveAccount(instance: IPublicClientApplication): void {
  instance.addEventCallback(event => {
    if (
      (event.eventType === EventType.LOGIN_SUCCESS ||
        event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS) &&
      event.payload
    ) {
      const { account } = event.payload as AuthenticationResult;
      if (account) {
        instance.setActiveAccount(account);
      }
    }
  });
}

/** Run once after `initialize()`: picks up an account left in the session cache. */
export function restoreActiveAccount(instance: IPublicClientApplication): void {
  if (!instance.getActiveAccount()) {
    const [first] = instance.getAllAccounts();
    if (first) {
      instance.setActiveAccount(first);
    }
  }
}
