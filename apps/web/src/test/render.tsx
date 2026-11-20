import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ApiProvider } from '../api/api-context';
import { createApiClient } from '../api/client';
import { AppRoutes } from '../app/app';
import { TEST_CONFIG } from './fakes';

/** Shows the router's current path and query, so a test can see a navigation. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

/**
 * The signed-in pages at `path`, calling the API through the real
 * openapi-fetch client; the test's fake fetch (installFetch) answers.
 */
export function renderPages(path: string) {
  const client = createApiClient({
    baseUrl: TEST_CONFIG.apiBaseUrl,
    getToken: async () => 'test-token',
  });
  return render(
    <ApiProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </ApiProvider>
  );
}
