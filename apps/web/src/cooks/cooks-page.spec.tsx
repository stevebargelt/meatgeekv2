import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Cook } from '../api/client';
import {
  BRISKET_BOX,
  OFFSET,
  apiPath,
  installFetch,
  jsonResponse,
  makeCook,
  type RecordedRequest,
} from '../test/fakes';
import { renderPages } from '../test/render';
import { formatDateTime } from './time';

const ACTIVE = makeCook({ id: 'c3', name: 'Saturday brisket', startTime: '2026-11-20T14:00:00Z' });
const DONE = makeCook({
  id: 'c2',
  name: 'Pork butt',
  meatType: 'pork',
  deviceId: OFFSET.id,
  status: 'completed',
  startTime: '2026-11-18T10:00:00Z',
  endTime: '2026-11-18T22:30:00Z',
});
const UNKNOWN_DEVICE = makeCook({
  id: 'c1',
  name: 'Old cook',
  meatType: undefined,
  deviceId: 'gone-device',
  status: 'completed',
  startTime: '2026-11-01T10:00:00Z',
  endTime: '2026-11-01T18:00:00Z',
});

/** GET /devices and GET /cooks; `page` answers each cooks request. */
function fakeApi(page: (query: URLSearchParams) => { cooks: Cook[]; token?: string }) {
  return installFetch(req => {
    const path = apiPath(req);
    if (path === '/devices') return jsonResponse(200, { devices: [BRISKET_BOX, OFFSET] });
    if (path.startsWith('/cooks')) {
      const { cooks, token } = page(new URL(req.url).searchParams);
      return jsonResponse(200, {
        cooks,
        limit: 20,
        hasMore: token !== undefined,
        ...(token !== undefined ? { continuationToken: token } : {}),
      });
    }
    return jsonResponse(500, {
      error: 'INTERNAL_SERVER_ERROR',
      message: 'unexpected',
      requestId: 'r',
    });
  });
}

function cookCalls(requests: RecordedRequest[]) {
  return requests
    .filter(r => apiPath(r).startsWith('/cooks'))
    .map(r => Object.fromEntries(new URL(r.url).searchParams));
}

function bodyRows() {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1);
}

describe('cooks list', () => {
  it('renders the first page: name, meat type, device name, started, ended or "active", status', async () => {
    const { requests } = fakeApi(() => ({ cooks: [ACTIVE, DONE, UNKNOWN_DEVICE] }));
    renderPages('/cooks');

    expect(screen.getByText('Loading cooks…')).toBeTruthy();
    await screen.findByRole('table');
    await screen.findAllByText('Brisket Box');
    const rows = bodyRows();
    expect(rows).toHaveLength(3);

    const cells = (row: HTMLElement) =>
      within(row)
        .getAllByRole('cell')
        .map(c => c.textContent);
    expect(cells(rows[0])).toEqual([
      'Saturday brisket',
      'brisket',
      'Brisket Box',
      formatDateTime(ACTIVE.startTime),
      'active',
      'active',
    ]);
    expect(cells(rows[1])).toEqual([
      'Pork butt',
      'pork',
      'Offset',
      formatDateTime(DONE.startTime),
      formatDateTime(DONE.endTime as string),
      'completed',
    ]);
    // An unknown device shows its id; a cook without meatType shows a dash.
    expect(cells(rows[2])).toEqual([
      'Old cook',
      '—',
      'gone-device',
      formatDateTime(UNKNOWN_DEVICE.startTime),
      formatDateTime(UNKNOWN_DEVICE.endTime as string),
      'completed',
    ]);

    expect(
      within(rows[0]).getByRole('link', { name: 'Saturday brisket' }).getAttribute('href')
    ).toBe('/cooks/c3');
    expect(cookCalls(requests)).toEqual([{ limit: '20' }]);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('"Load more" sends the previous continuationToken, appends, and goes away when hasMore is false', async () => {
    const { requests } = fakeApi(query =>
      query.get('continuationToken') === 'tok-1'
        ? { cooks: [UNKNOWN_DEVICE] }
        : { cooks: [ACTIVE, DONE], token: 'tok-1' }
    );
    renderPages('/cooks');

    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(bodyRows().map(r => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      'Saturday brisket',
      'Pork butt',
      'Old cook',
    ]);
    expect(cookCalls(requests)).toEqual([
      { limit: '20' },
      { limit: '20', continuationToken: 'tok-1' },
    ]);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('sends the device and status filters as query parameters', async () => {
    const { requests } = fakeApi(query =>
      query.get('status') === 'completed' ? { cooks: [DONE] } : { cooks: [ACTIVE, DONE] }
    );
    renderPages('/cooks');
    await screen.findByRole('table');
    await screen.findByRole('option', { name: 'Offset' });

    await userEvent.selectOptions(screen.getByLabelText('Device'), OFFSET.id);
    await waitFor(() => expect(cookCalls(requests)).toHaveLength(2));
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'completed');
    await waitFor(() => expect(bodyRows()).toHaveLength(1));

    expect(cookCalls(requests)).toEqual([
      { limit: '20' },
      { limit: '20', deviceId: OFFSET.id },
      { limit: '20', deviceId: OFFSET.id, status: 'completed' },
    ]);
    expect(screen.getByTestId('location').textContent).toBe(
      `/cooks?deviceId=${OFFSET.id}&status=completed`
    );

    await userEvent.selectOptions(screen.getByLabelText('Device'), '');
    await waitFor(() => expect(cookCalls(requests)).toHaveLength(4));
    expect(cookCalls(requests)[3]).toEqual({ limit: '20', status: 'completed' });
  });

  it('reads the filters from the URL on load', async () => {
    const { requests } = fakeApi(() => ({ cooks: [] }));
    renderPages('/cooks?status=active&deviceId=meatgeek3');

    expect(await screen.findByText('No cooks match these filters.')).toBeTruthy();
    expect(cookCalls(requests)).toEqual([{ limit: '20', deviceId: 'meatgeek3', status: 'active' }]);
  });

  it('shows the empty state with no cooks', async () => {
    fakeApi(() => ({ cooks: [] }));
    renderPages('/cooks');
    expect(await screen.findByText(/You have no cooks yet/)).toBeTruthy();
  });

  it('shows the problem message when the list fails', async () => {
    installFetch(req =>
      apiPath(req) === '/devices'
        ? jsonResponse(200, { devices: [] })
        : jsonResponse(500, {
            error: 'INTERNAL_SERVER_ERROR',
            message: 'Cosmos is having a day',
            requestId: 'req-500',
          })
    );
    renderPages('/cooks');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Cosmos is having a day');
    expect(alert.textContent).toContain('req-500');
  });
});
