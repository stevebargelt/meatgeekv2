import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BRISKET_BOX,
  OFFSET,
  apiPath,
  errorResponse,
  installFetch,
  jsonResponse,
  type RecordedRequest,
} from '../test/fakes';
import { renderPages } from '../test/render';
import { RELEASE_MESSAGES } from './device-row';

/** Two devices; `release` answers each DELETE /devices/{id}. */
function fakeApi(release: (req: RecordedRequest) => Response) {
  return installFetch(req => {
    const path = apiPath(req);
    if (req.method === 'DELETE') return release(req);
    if (req.method === 'GET' && path === '/devices') {
      return jsonResponse(200, { devices: [BRISKET_BOX, OFFSET] });
    }
    if (req.method === 'GET' && path.startsWith('/cooks?')) {
      return jsonResponse(200, { cooks: [], limit: 100, hasMore: false });
    }
    return errorResponse(500, 'INTERNAL_SERVER_ERROR', 'unexpected', 'r');
  });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;
const confirmGroup = (name: string) =>
  screen.getByRole('group', { name: `Confirm release of ${name}` });
const deletes = (requests: RecordedRequest[]) => requests.filter(r => r.method === 'DELETE');

async function releaseBrisket() {
  await userEvent.click(
    within(await rowOf('Brisket Box')).getByRole('button', { name: 'Release' })
  );
  await userEvent.click(
    within(confirmGroup('Brisket Box')).getByRole('button', { name: 'Yes, release' })
  );
}

describe('release a device', () => {
  it('asks first, with what releasing means, and Cancel sends nothing', async () => {
    const { requests } = fakeApi(() => new Response(null, { status: 204 }));
    renderPages('/');

    await userEvent.click(
      within(await rowOf('Brisket Box')).getByRole('button', { name: 'Release' })
    );

    const group = confirmGroup('Brisket Box');
    expect(group.textContent).toContain(
      "Release Brisket Box? You'll need a new code from the device to claim it again."
    );
    await userEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /^Confirm release/ })).toBeNull();
    expect(deletes(requests)).toHaveLength(0);
  });

  it('on 204 sends DELETE /devices/{id} and takes the row off the list', async () => {
    const { requests } = fakeApi(() => new Response(null, { status: 204 }));
    renderPages('/');

    await releaseBrisket();

    await waitFor(() => expect(screen.queryByText('Brisket Box')).toBeNull());
    expect(screen.getByText('Offset')).toBeTruthy();
    expect(deletes(requests).map(r => apiPath(r))).toEqual([`/devices/${BRISKET_BOX.id}`]);
    // The list is not re-read: the one GET /devices is the page's first.
    expect(requests.filter(r => r.method === 'GET' && apiPath(r) === '/devices')).toHaveLength(1);
  });

  it('on 409 COOK_ACTIVE says to stop the cook first and keeps the row', async () => {
    fakeApi(() =>
      errorResponse(409, 'COOK_ACTIVE', 'Stop the active cook before releasing this device')
    );
    renderPages('/');

    await releaseBrisket();

    const row = await rowOf('Brisket Box');
    const alert = await within(row).findByRole('alert');
    expect(alert.textContent).toContain(RELEASE_MESSAGES.cookActive);
    expect(alert.textContent).toContain('req-409');
    expect(screen.queryByRole('group', { name: /^Confirm release/ })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Release' })).toBeTruthy();
  });

  it('on 503 says to try again, and a second try can succeed', async () => {
    let answers = 0;
    const { requests } = fakeApi(() =>
      answers++ === 0
        ? errorResponse(503, 'DEVICE_TWIN_UPDATE_FAILED', 'The device twin could not be patched.')
        : new Response(null, { status: 204 })
    );
    renderPages('/');

    await releaseBrisket();
    const alert = await within(await rowOf('Brisket Box')).findByRole('alert');
    expect(alert.textContent).toContain(RELEASE_MESSAGES.busy);

    await releaseBrisket();
    await waitFor(() => expect(screen.queryByText('Brisket Box')).toBeNull());
    expect(deletes(requests)).toHaveLength(2);
  });

  it('on 404 says the device was not found and re-reads the list', async () => {
    const { requests } = fakeApi(() => errorResponse(404, 'DEVICE_NOT_FOUND', 'Device not found'));
    renderPages('/');

    await releaseBrisket();

    expect(await screen.findByText(/meatgeek3 was not found/)).toBeTruthy();
    await waitFor(() =>
      expect(requests.filter(r => r.method === 'GET' && apiPath(r) === '/devices')).toHaveLength(2)
    );
  });
});
