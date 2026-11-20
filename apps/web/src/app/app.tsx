import { InteractionStatus } from '@azure/msal-browser';
import { useMsal } from '@azure/msal-react';
import { useMemo } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ApiProvider } from '../api/api-context';
import { createApiClient } from '../api/client';
import { createTokenGetter } from '../auth/token';
import type { AppConfig } from '../config/config';
import { CookDetailPage } from '../cooks/cook-detail-page';
import { CooksPage } from '../cooks/cooks-page';
import { DevicesPage } from '../devices/devices-page';

/** The signed-in frame (header, nav, routes) or the sign-in page. */
export function App({ config }: { config: AppConfig }) {
  const { instance, accounts, inProgress } = useMsal();
  const account = instance.getActiveAccount() ?? accounts[0];
  const client = useMemo(
    () =>
      createApiClient({
        baseUrl: config.apiBaseUrl,
        getToken: createTokenGetter(instance, config.apiScope),
      }),
    [instance, config.apiBaseUrl, config.apiScope]
  );

  if (!account) {
    return (
      <div className="app">
        <header className="app-header">
          <span className="brand">MeatGeek</span>
        </header>
        <main className="status-page">
          {inProgress === InteractionStatus.None ? (
            <>
              <h1>Sign in to MeatGeek</h1>
              <p>Use your Microsoft account to see and manage your devices.</p>
              <button
                type="button"
                onClick={() => instance.loginRedirect({ scopes: [config.apiScope] })}
              >
                Sign in
              </button>
            </>
          ) : (
            <p className="muted">Signing in…</p>
          )}
        </main>
      </div>
    );
  }

  return (
    <ApiProvider client={client}>
      <div className="app">
        <header className="app-header">
          <span className="brand">MeatGeek</span>
          <nav aria-label="Main">
            <NavLink to="/" end>
              Devices
            </NavLink>
            <NavLink to="/cooks">Cooks</NavLink>
          </nav>
          <span className="user">
            <span className="user-name">{account.name ?? account.username}</span>
            <button
              type="button"
              className="secondary"
              onClick={() => instance.logoutRedirect({ account })}
            >
              Sign out
            </button>
          </span>
        </header>
        <main className="app-main">
          <AppRoutes />
        </main>
      </div>
    </ApiProvider>
  );
}

/** The signed-in pages. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<DevicesPage />} />
      <Route path="/cooks" element={<CooksPage />} />
      <Route path="/cooks/:id" element={<CookDetailPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
