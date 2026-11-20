import type { IPublicClientApplication } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import type { ReactElement } from 'react';
import { BrowserRouter } from 'react-router-dom';
import App from './app/app';
import { ConfigErrorPage, NotConfiguredPage } from './app/status-pages';
import { createMsalInstance, restoreActiveAccount } from './auth/msal';
import { loadConfig, type AppConfig } from './config/config';

export interface BootstrapDeps {
  fetchConfig?: typeof fetch;
  createMsal?: (config: AppConfig) => IPublicClientApplication;
}

/**
 * Loads /config.json and decides what to render before anything renders:
 * a config error, the "not configured" page while clientId is empty, or the
 * app inside MSAL and the router.
 */
export async function bootstrap({
  fetchConfig,
  createMsal = createMsalInstance,
}: BootstrapDeps = {}): Promise<ReactElement> {
  const result = await loadConfig(fetchConfig);
  if (result.kind === 'invalid') {
    return <ConfigErrorPage problems={result.problems} />;
  }
  if (result.kind === 'not-configured') {
    return <NotConfiguredPage />;
  }

  let instance: IPublicClientApplication;
  try {
    instance = createMsal(result.config);
    await instance.initialize();
    restoreActiveAccount(instance);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return <ConfigErrorPage problems={[`Sign-in could not start: ${message}`]} />;
  }

  return (
    <MsalProvider instance={instance}>
      <BrowserRouter>
        <App config={result.config} />
      </BrowserRouter>
    </MsalProvider>
  );
}
