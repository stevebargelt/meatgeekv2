import { render, screen } from '@testing-library/react';
import { bootstrap } from './bootstrap';
import { TEST_CONFIG, createFakeMsal, jsonResponse } from './test/fakes';

jest.mock('@azure/msal-react', () => ({
  MsalProvider: ({ children }: { children: unknown }) => children,
  useMsal: () => ({ instance: mockInstance, accounts: [], inProgress: 'none' }),
}));
const mockInstance = createFakeMsal(null);

function serveConfig(body: unknown, status = 200) {
  return jest.fn(async () => jsonResponse(status, body)) as unknown as typeof fetch;
}

describe('bootstrap', () => {
  it('renders the not-configured page when clientId is empty', async () => {
    const createMsal = jest.fn();
    const element = await bootstrap({
      fetchConfig: serveConfig({ ...TEST_CONFIG, clientId: '' }),
      createMsal,
    });
    render(element);
    expect(screen.getByRole('heading', { name: 'Sign-in is not configured yet' })).toBeTruthy();
    expect(createMsal).not.toHaveBeenCalled();
  });

  it('names every missing field when the config is the wrong shape', async () => {
    const element = await bootstrap({ fetchConfig: serveConfig({ clientId: 42 }) });
    render(element);
    const items = screen.getAllByRole('listitem').map(li => li.textContent);
    expect(items).toEqual([
      '"apiBaseUrl" is missing or empty.',
      '"tenantId" is missing or empty.',
      '"apiScope" is missing or empty.',
      '"clientId" is missing or not a string.',
    ]);
  });

  it('renders a readable error when /config.json is missing', async () => {
    const element = await bootstrap({ fetchConfig: serveConfig('Not Found', 404) });
    render(element);
    expect(screen.getByText('/config.json answered HTTP 404.')).toBeTruthy();
  });

  it('initializes MSAL and renders the sign-in page when configured', async () => {
    const createMsal = jest.fn(() => mockInstance as never);
    const element = await bootstrap({ fetchConfig: serveConfig(TEST_CONFIG), createMsal });
    render(element);
    expect(createMsal).toHaveBeenCalledWith(TEST_CONFIG);
    expect(mockInstance.initialize).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});
