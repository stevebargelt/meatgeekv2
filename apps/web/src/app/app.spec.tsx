import { InteractionRequiredAuthError, InteractionStatus } from '@azure/msal-browser';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  TEST_ACCOUNT,
  TEST_CONFIG,
  createFakeMsal,
  installFetch,
  jsonResponse,
  type FakeMsal,
  type RecordedRequest,
} from '../test/fakes';
import { App } from './app';

// msal-react is mocked down to the one hook the app uses; the fake instance
// stands in for PublicClientApplication.
let mockMsal: { instance: FakeMsal; accounts: unknown[]; inProgress: InteractionStatus };
jest.mock('@azure/msal-react', () => ({
  MsalProvider: ({ children }: { children: unknown }) => children,
  useMsal: () => mockMsal,
}));

const API = TEST_CONFIG.apiBaseUrl;
const BRISKET = {
  id: 'meatgeek3',
  userId: 'tid:oid',
  name: 'Brisket Box',
  model: 'MeatGeek V1',
  location: 'Backyard',
  isActive: true,
};
const OFFSET = { ...BRISKET, id: 'offset-1', name: 'Offset', location: undefined };

/** GET /cooks?status=active: the devices page's one call; no device is cooking. */
function noActiveCooks(req: RecordedRequest): Response | undefined {
  return req.method === 'GET' && req.url.startsWith(`${API}/cooks?`)
    ? jsonResponse(200, { cooks: [], limit: 100, hasMore: false })
    : undefined;
}

/** The requests that are not the devices page's active-cook lookup. */
function deviceCalls(requests: RecordedRequest[]) {
  return requests.filter(r => !r.url.startsWith(`${API}/cooks?`));
}

function signIn(account = TEST_ACCOUNT) {
  const instance = createFakeMsal(account);
  mockMsal = { instance, accounts: [account], inProgress: InteractionStatus.None };
  return instance;
}

function renderApp() {
  return render(
    <MemoryRouter>
      <App config={TEST_CONFIG} />
    </MemoryRouter>
  );
}

/** A fake API holding a device list, answering GET /devices from it. */
function fakeApi(
  devices: unknown[],
  other: (req: RecordedRequest) => Response | undefined = () => undefined
) {
  return installFetch(req => {
    const answer = other(req) ?? noActiveCooks(req);
    if (answer) return answer;
    if (req.method === 'GET' && req.url === `${API}/devices`) {
      return jsonResponse(200, { devices });
    }
    return jsonResponse(500, {
      error: 'INTERNAL_SERVER_ERROR',
      message: 'unexpected',
      requestId: 'r',
    });
  });
}

describe('signed out', () => {
  it('shows a Sign in button that calls loginRedirect with the configured scope', async () => {
    const instance = createFakeMsal(null);
    mockMsal = { instance, accounts: [], inProgress: InteractionStatus.None };
    const { fetchMock } = fakeApi([]);
    renderApp();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(instance.loginRedirect).toHaveBeenCalledWith({ scopes: [TEST_CONFIG.apiScope] });
    expect(screen.queryByRole('heading', { name: 'Devices' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows progress, not the button, while MSAL handles the redirect', () => {
    mockMsal = {
      instance: createFakeMsal(null),
      accounts: [],
      inProgress: InteractionStatus.HandleRedirect,
    };
    renderApp();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText('Signing in…')).toBeTruthy();
  });
});

describe('signed in', () => {
  it("shows the user's name and signs out with logoutRedirect", async () => {
    const instance = signIn();
    fakeApi([]);
    renderApp();

    expect(screen.getByText('Pat Pitmaster')).toBeTruthy();
    await screen.findByText(/You have no devices yet/);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(instance.logoutRedirect).toHaveBeenCalledWith({ account: TEST_ACCOUNT });
  });

  it('has a nav with Devices and Cooks', async () => {
    signIn();
    fakeApi([]);
    renderApp();
    await screen.findByText(/You have no devices yet/);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Devices' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Cooks' })).toBeTruthy();
  });

  it('renders the device list from GET /devices', async () => {
    signIn();
    const { requests } = fakeApi([BRISKET, OFFSET]);
    renderApp();

    expect(screen.getByText('Loading devices…')).toBeTruthy();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Brisket Box')).toBeTruthy();
    expect(within(rows[0]).getByText('meatgeek3')).toBeTruthy();
    expect(within(rows[0]).getByText('MeatGeek V1')).toBeTruthy();
    expect(within(rows[0]).getByText('Backyard')).toBeTruthy();
    expect(within(rows[1]).getByText('Offset')).toBeTruthy();
    expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
      `GET ${API}/devices`,
      `GET ${API}/cooks?status=active&limit=100`,
    ]);
  });

  it('shows the empty state when there are no devices', async () => {
    signIn();
    fakeApi([]);
    renderApp();
    expect(await screen.findByText(/You have no devices yet/)).toBeTruthy();
  });

  it('shows the server message and request id when the list fails', async () => {
    signIn();
    installFetch(() =>
      jsonResponse(500, {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Cosmos is having a day',
        requestId: 'req-500',
      })
    );
    renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Cosmos is having a day');
    expect(alert.textContent).toContain('req-500');
  });

  it('sends Authorization: Bearer <token from acquireTokenSilent> and an X-Request-ID on every request', async () => {
    const instance = signIn();
    const { requests } = fakeApi([BRISKET], req =>
      req.method === 'PATCH' ? jsonResponse(200, { ...BRISKET, name: 'Renamed' }) : undefined
    );
    renderApp();

    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    await userEvent.clear(screen.getByLabelText('New name'));
    await userEvent.type(screen.getByLabelText('New name'), 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(deviceCalls(requests)).toHaveLength(3));

    expect(deviceCalls(requests).map(r => r.method)).toEqual(['GET', 'PATCH', 'GET']);
    expect(instance.acquireTokenSilent).toHaveBeenCalledWith({
      scopes: [TEST_CONFIG.apiScope],
      account: TEST_ACCOUNT,
    });
    const ids = new Set<string>();
    for (const req of requests) {
      expect(req.headers.get('Authorization')).toBe('Bearer token-from-silent');
      const id = req.headers.get('X-Request-ID') ?? '';
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(requests.length);
  });

  it('falls back to acquireTokenRedirect on InteractionRequiredAuthError', async () => {
    const instance = signIn();
    instance.acquireTokenSilent.mockRejectedValue(
      new InteractionRequiredAuthError('interaction_required', 'consent needed')
    );
    const { fetchMock } = fakeApi([]);
    renderApp();

    await waitFor(() =>
      expect(instance.acquireTokenRedirect).toHaveBeenCalledWith({
        scopes: [TEST_CONFIG.apiScope],
        account: TEST_ACCOUNT,
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toContain('Redirecting');
  });
});

describe('rename a device', () => {
  async function rename(to: string) {
    await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    await userEvent.clear(screen.getByLabelText('New name'));
    await userEvent.type(screen.getByLabelText('New name'), to);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('sends PATCH /devices/{id} with {name} and refreshes the list', async () => {
    signIn();
    let devices = [BRISKET];
    const { requests } = installFetch(req => {
      const cooks = noActiveCooks(req);
      if (cooks) return cooks;
      if (req.method === 'PATCH') {
        devices = [{ ...BRISKET, name: 'Big Smoke' }];
        return jsonResponse(200, devices[0]);
      }
      return jsonResponse(200, { devices });
    });
    renderApp();

    await rename(' Big Smoke ');

    expect(await screen.findByText('Big Smoke')).toBeTruthy();
    const patch = requests.find(r => r.method === 'PATCH');
    expect(patch?.url).toBe(`${API}/devices/meatgeek3`);
    expect(patch?.body).toEqual({ name: 'Big Smoke' });
  });

  it('shows the server message inline on 409', async () => {
    signIn();
    fakeApi([BRISKET], req =>
      req.method === 'PATCH'
        ? jsonResponse(409, {
            error: 'DEVICE_CONFLICT',
            message: 'You already have a device with this name.',
            requestId: 'req-dup',
          })
        : undefined
    );
    renderApp();

    await rename('Offset');

    const row = screen
      .getByRole('form', { name: 'Rename Brisket Box' })
      .closest('tr') as HTMLElement;
    const alert = await within(row).findByRole('alert');
    expect(alert.textContent).toContain('You already have a device with this name.');
    expect(alert.textContent).toContain('req-dup');
  });

  it('says the device was not found on 404 and refreshes the list', async () => {
    signIn();
    let devices: unknown[] = [BRISKET];
    const { requests } = installFetch(req => {
      const cooks = noActiveCooks(req);
      if (cooks) return cooks;
      if (req.method === 'PATCH') {
        devices = [];
        return jsonResponse(404, {
          error: 'DEVICE_NOT_FOUND',
          message: 'Device not found',
          requestId: 'req-404',
        });
      }
      return jsonResponse(200, { devices });
    });
    renderApp();

    await rename('Gone');

    expect(await screen.findByText(/meatgeek3 was not found/)).toBeTruthy();
    expect(await screen.findByText(/You have no devices yet/)).toBeTruthy();
    expect(deviceCalls(requests).map(r => r.method)).toEqual(['GET', 'PATCH', 'GET']);
  });
});
