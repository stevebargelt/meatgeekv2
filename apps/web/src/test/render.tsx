import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ApiProvider } from '../api/api-context';
import { createApiClient, type ApiClient } from '../api/client';
import { AppRoutes } from '../app/app';
import { HubFactoryProvider } from '../live/hub-context';
import type { HubFactory } from '../live/hub';
import { TEST_CONFIG, createFakeHubs } from './fakes';

/** Shows the router's current path and query, so a test can see a navigation. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

/** The real openapi-fetch client, against TEST_CONFIG's API; the test's fake fetch answers. */
export function createTestClient(): ApiClient {
  return createApiClient({
    baseUrl: TEST_CONFIG.apiBaseUrl,
    getToken: async () => 'test-token',
  });
}

/**
 * The signed-in pages at `path`, calling the API through `client` (by default
 * createTestClient()); the test's fake fetch (installFetch) answers. SignalR
 * connections are fakes (`createHub`, by default one nobody drives): no test
 * opens a real connection.
 */
export function renderPages(
  path: string,
  { createHub, client = createTestClient() }: { createHub?: HubFactory; client?: ApiClient } = {}
) {
  return render(
    <ApiProvider client={client}>
      <HubFactoryProvider createHub={createHub ?? createFakeHubs().createHub}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>
      </HubFactoryProvider>
    </ApiProvider>
  );
}
