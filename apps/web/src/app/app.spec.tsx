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
  connectionStatus: 'online',
};
const OFFSET = { ...BRISKET, id: 'offset-1', name: 'Offset', location: undefined };

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
    const answer = other(req);
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
    expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([`GET ${API}/devices`]);
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
    await waitFor(() => expect(requests).toHaveLength(3));

    expect(requests.map(r => r.method)).toEqual(['GET', 'PATCH', 'GET']);
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

describe('register a device', () => {
  async function fillAndSubmit(fields: Record<string, string>) {
    for (const [label, value] of Object.entries(fields)) {
      await userEvent.type(screen.getByLabelText(new RegExp(`^${label}`)), value);
    }
    await userEvent.click(screen.getByRole('button', { name: 'Register' }));
  }

  it('posts exactly {deviceId, name, model, location} and refreshes the list', async () => {
    signIn();
    let devices: unknown[] = [];
    const { requests } = installFetch(req => {
      if (req.method === 'POST') {
        devices = [BRISKET];
        return jsonResponse(201, BRISKET);
      }
      return jsonResponse(200, { devices });
    });
    renderApp();
    await screen.findByText(/You have no devices yet/);

    await fillAndSubmit({
      'Device ID': 'meatgeek3',
      Name: '  Brisket Box ',
      Model: 'MeatGeek V1',
      Location: 'Backyard',
    });

    expect(await screen.findByRole('table')).toBeTruthy();
    const post = requests.find(r => r.method === 'POST');
    expect(post?.url).toBe(`${API}/devices`);
    expect(post?.body).toEqual({
      deviceId: 'meatgeek3',
      name: 'Brisket Box',
      model: 'MeatGeek V1',
      location: 'Backyard',
    });
    expect(requests.map(r => r.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('leaves location out when it is blank', async () => {
    signIn();
    const { requests } = fakeApi([], req =>
      req.method === 'POST' ? jsonResponse(201, BRISKET) : undefined
    );
    renderApp();
    await screen.findByText(/You have no devices yet/);

    await fillAndSubmit({ 'Device ID': 'meatgeek3', Name: 'Brisket Box', Model: 'MeatGeek V1' });

    await waitFor(() => expect(requests.some(r => r.method === 'POST')).toBe(true));
    const post = requests.find(r => r.method === 'POST');
    expect(post?.body).toEqual({
      deviceId: 'meatgeek3',
      name: 'Brisket Box',
      model: 'MeatGeek V1',
    });
  });

  it('shows the server message inline on 409 DEVICE_CONFLICT', async () => {
    signIn();
    fakeApi([], req =>
      req.method === 'POST'
        ? jsonResponse(409, {
            error: 'DEVICE_CONFLICT',
            message: 'A device with this id or name already exists.',
            requestId: 'req-409',
          })
        : undefined
    );
    renderApp();
    await screen.findByText(/You have no devices yet/);

    await fillAndSubmit({ 'Device ID': 'meatgeek3', Name: 'Brisket Box', Model: 'MeatGeek V1' });

    const form = screen.getByRole('form', { name: 'Register a device' });
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('A device with this id or name already exists.');
    expect(alert.textContent).toContain('req-409');
  });

  it('checks the fields like the server does before posting', async () => {
    signIn();
    const { requests } = fakeApi([]);
    renderApp();
    await screen.findByText(/You have no devices yet/);

    await fillAndSubmit({ 'Device ID': 'has spaces', Name: '   ', Model: 'x'.repeat(101) });

    expect(screen.getByText(/Device ID must be 1-128 characters/)).toBeTruthy();
    expect(screen.getByText('Name is required.')).toBeTruthy();
    expect(screen.getByText('Model must be at most 100 characters.')).toBeTruthy();
    expect(requests.map(r => r.method)).toEqual(['GET']);
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
    expect(requests.map(r => r.method)).toEqual(['GET', 'PATCH', 'GET']);
  });
});
