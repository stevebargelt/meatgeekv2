import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Cook } from '../api/client';
import {
  BRISKET_BOX,
  apiPath,
  installFetch,
  jsonResponse,
  makeCook,
  type RecordedRequest,
} from '../test/fakes';
import { renderPages } from '../test/render';
import { formatDateTime } from './time';

const COOK = makeCook({
  id: 'cook-1',
  name: 'Saturday brisket',
  meatType: 'brisket',
  startTime: '2026-11-20T14:00:00.000Z',
  weight: 12.5,
  targetTemps: { grill: 225, probe1: 203 },
  notes: 'Post oak, wrapped at 165',
});
const STOPPED_AT = '2026-11-20T23:15:00.000Z';

/** GET /devices, GET /cooks/cook-1 answering `cook`, and `stop` answering each stop. */
function fakeApi(
  cook: Cook | null,
  stop: (req: RecordedRequest) => Response = () =>
    jsonResponse(200, { ...COOK, status: 'completed', endTime: STOPPED_AT })
) {
  return installFetch(req => {
    const path = apiPath(req);
    if (path === '/devices') return jsonResponse(200, { devices: [BRISKET_BOX] });
    if (req.method === 'GET' && path === '/cooks/cook-1') {
      return cook
        ? jsonResponse(200, cook)
        : jsonResponse(404, {
            error: 'NOT_FOUND',
            message: 'Cook not found',
            requestId: 'req-404',
          });
    }
    if (req.method === 'POST' && path === '/cooks/cook-1/stop') return stop(req);
    return jsonResponse(500, {
      error: 'INTERNAL_SERVER_ERROR',
      message: 'unexpected',
      requestId: 'r',
    });
  });
}

function field(label: string): string | null {
  const term = screen.getByText(label, { selector: 'dt' });
  return (term.nextElementSibling as HTMLElement).textContent;
}

function stops(requests: RecordedRequest[]) {
  return requests.filter(r => r.method === 'POST');
}

describe('cook detail', () => {
  afterEach(() => jest.useRealTimers());

  it('renders the cook: name, meat type, device, times, weight, targets, notes', async () => {
    fakeApi(COOK);
    renderPages('/cooks/cook-1');

    expect(screen.getByText('Loading cook…')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Saturday brisket' })).toBeTruthy();
    await waitFor(() => expect(field('Device')).toBe('Brisket Box'));
    expect(field('Status')).toBe('active');
    expect(field('Meat type')).toBe('brisket');
    expect(field('Started')).toBe(formatDateTime(COOK.startTime));
    expect(field('Elapsed')).toMatch(/^\d+:\d\d:\d\d$/);
    expect(field('Weight')).toBe('12.5 lb');
    expect(field('Targets')).toBe('Grill target: 225 °FProbe 1 target: 203 °F');
    expect(field('Notes')).toBe('Post oak, wrapped at 165');
    expect(screen.queryByText('Ended', { selector: 'dt' })).toBeNull();
  });

  it('has the live-panel and chart regions for an active cook, and no live panel once completed', async () => {
    fakeApi(COOK);
    const { unmount } = renderPages('/cooks/cook-1');
    await screen.findByRole('heading', { name: 'Saturday brisket' });
    expect(screen.getByTestId('cook-live-panel').textContent).toBe('');
    expect(screen.getByTestId('cook-chart').textContent).toBe('');
    unmount();

    fakeApi({ ...COOK, status: 'completed', endTime: STOPPED_AT });
    renderPages('/cooks/cook-1');
    await screen.findByRole('heading', { name: 'Saturday brisket' });
    expect(screen.queryByTestId('cook-live-panel')).toBeNull();
    expect(screen.getByTestId('cook-chart')).toBeTruthy();
    expect(field('Ended')).toBe(formatDateTime(STOPPED_AT));
    expect(screen.queryByText('Elapsed', { selector: 'dt' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop cook' })).toBeNull();
  });

  it('shows dashes for fields an older cook does not have', async () => {
    fakeApi(makeCook({ id: 'cook-1', meatType: undefined, status: 'completed' }));
    renderPages('/cooks/cook-1');
    await screen.findByRole('heading', { name: 'Saturday brisket' });
    for (const label of ['Meat type', 'Weight', 'Targets', 'Notes']) {
      expect(field(label)).toBe('—');
    }
  });

  it('updates the elapsed time once a second', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-20T15:00:00.000Z') });
    fakeApi(COOK);
    renderPages('/cooks/cook-1');
    await screen.findByRole('heading', { name: 'Saturday brisket' });

    expect(field('Elapsed')).toBe('1:00:00');
    act(() => jest.advanceTimersByTime(1000));
    expect(field('Elapsed')).toBe('1:00:01');
    act(() => jest.advanceTimersByTime(61_000));
    expect(field('Elapsed')).toBe('1:01:02');
  });

  it('renders "This cook was not found" with a link back on 404', async () => {
    fakeApi(null);
    renderPages('/cooks/cook-1');
    expect(await screen.findByRole('heading', { name: 'This cook was not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to cooks' }).getAttribute('href')).toBe('/cooks');
  });

  it('stops only after confirming, then shows the cook completed with its end time', async () => {
    const { requests } = fakeApi(COOK);
    renderPages('/cooks/cook-1');

    await userEvent.click(await screen.findByRole('button', { name: 'Stop cook' }));
    expect(stops(requests)).toHaveLength(0);
    const confirm = screen.getByRole('group', { name: 'Confirm stop' });

    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(stops(requests)).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Stop cook' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, stop cook' }));

    await waitFor(() => expect(field('Status')).toBe('completed'));
    expect(field('Ended')).toBe(formatDateTime(STOPPED_AT));
    expect(stops(requests).map(apiPath)).toEqual(['/cooks/cook-1/stop']);
    expect(stops(requests)[0].body).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Stop cook' })).toBeNull();
    expect(screen.queryByTestId('cook-live-panel')).toBeNull();
  });

  it('on 503 DEVICE_TWIN_UPDATE_FAILED offers Retry, which resends the stop', async () => {
    let calls = 0;
    const { requests } = fakeApi(COOK, () =>
      ++calls === 1
        ? jsonResponse(503, {
            error: 'DEVICE_TWIN_UPDATE_FAILED',
            message: 'The device twin could not be updated.',
            requestId: 'req-503',
            cookId: 'cook-1',
            reason: 'TWIN_UPDATE_FAILED',
          })
        : jsonResponse(200, { ...COOK, status: 'completed', endTime: STOPPED_AT })
    );
    renderPages('/cooks/cook-1');

    await userEvent.click(await screen.findByRole('button', { name: 'Stop cook' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, stop cook' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The cook was stopped, but the device was not told');
    expect(alert.textContent).toContain('req-503');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(field('Status')).toBe('completed'));
    expect(stops(requests).map(apiPath)).toEqual(['/cooks/cook-1/stop', '/cooks/cook-1/stop']);
  });

  it.each([
    [404, 'NOT_FOUND', 'Cook not found'],
    [403, 'DEVICE_NOT_OWNED', 'Device not owned by the caller'],
  ])('on stop %i %s shows the problem', async (status, error, message) => {
    fakeApi(COOK, () => jsonResponse(status, { error, message, requestId: `req-${status}` }));
    renderPages('/cooks/cook-1');

    await userEvent.click(await screen.findByRole('button', { name: 'Stop cook' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, stop cook' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain(`req-${status}`);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(field('Status')).toBe('active');
  });
});
