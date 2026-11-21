import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Cook } from '../api/client';
import {
  BRISKET_BOX,
  apiPath,
  createFakeHubs,
  installFetch,
  installResizeObserver,
  jsonResponse,
  makeCook,
  makeTemperature,
  type RecordedRequest,
} from '../test/fakes';
import { renderPages } from '../test/render';
import type { CookChart } from './chart-series';

const COOK = makeCook({ id: 'cook-1', startTime: '2026-11-20T14:00:00.000Z' });
const COMPLETED: Cook = { ...COOK, status: 'completed', endTime: '2026-11-20T23:15:00.000Z' };

const CHART: CookChart = {
  cookId: 'cook-1',
  deviceId: BRISKET_BOX.id,
  startTime: COOK.startTime,
  bucketSeconds: 3600,
  points: [
    {
      t: '2026-11-20T14:00:00.000Z',
      grill: { min: 220, max: 240, avg: 230 },
      probe1: { min: 40, max: 120, avg: 80 },
    },
    {
      t: '2026-11-20T15:00:00.000Z',
      grill: { min: 225, max: 235, avg: 229.5 },
      probe1: { min: 120, max: 150, avg: 135 },
    },
  ],
};

interface Server {
  cook: Cook;
  /** Answers GET /cooks/cook-1/chart; `call` counts from 1. */
  chart: (call: number) => Response;
}

/** The detail page's API: the cook, devices, the chart, and the live panel's calls. */
function fakeServer(server: Server) {
  let chartCalls = 0;
  const fetch = installFetch((req: RecordedRequest) => {
    const path = apiPath(req);
    if (req.method === 'GET' && path === '/cooks/cook-1') return jsonResponse(200, server.cook);
    if (req.method === 'GET' && path === '/cooks/cook-1/chart') return server.chart(++chartCalls);
    if (path === '/devices') return jsonResponse(200, { devices: [BRISKET_BOX] });
    if (path === `/devices/${BRISKET_BOX.id}`) return jsonResponse(200, BRISKET_BOX);
    if (req.method === 'POST' && path === '/negotiate') {
      return jsonResponse(200, { url: 'https://mg.service.signalr.net/client/', accessToken: 't' });
    }
    if (path === `/temperatures/current/${BRISKET_BOX.id}`) {
      return jsonResponse(404, { error: 'NO_READINGS', message: 'No reading', requestId: 'r' });
    }
    return jsonResponse(500, { error: 'INTERNAL_SERVER_ERROR', message: 'unexpected' });
  });
  return { ...fetch, chartCalls: () => chartCalls };
}

function chartSection(): HTMLElement {
  return screen.getByTestId('cook-chart');
}

function avgLines(): Element[] {
  return Array.from(chartSection().querySelectorAll('svg .recharts-line'));
}

describe('cook chart', () => {
  // The chart view is a React.lazy chunk that pulls in recharts. Its load is
  // an event: await it here, once, so the tests below never race it. React.lazy's
  // import() then resolves from jest's module registry, and each test waits for
  // the drawn SVG lines (the chunk loaded and rendered), with no deadline of its
  // own (src/test/setup.ts).
  beforeAll(async () => {
    await import('./cook-chart-view');
  });

  let restoreResizeObserver: () => void;
  beforeEach(() => {
    restoreResizeObserver = installResizeObserver();
  });
  afterEach(() => restoreResizeObserver());

  it('shows loading, then an SVG chart with one avg line per channel present', async () => {
    const api = fakeServer({ cook: COMPLETED, chart: () => jsonResponse(200, CHART) });
    renderPages('/cooks/cook-1');

    await screen.findByRole('heading', { name: 'Saturday brisket' });
    expect(within(chartSection()).getByText('Loading chart…')).toBeTruthy();

    await waitFor(() => expect(avgLines()).toHaveLength(2));
    expect(chartSection().querySelector('svg')).not.toBeNull();
    expect(chartSection().querySelector('.chart-line-grill')).not.toBeNull();
    expect(chartSection().querySelector('.chart-line-probe1')).not.toBeNull();
    expect(chartSection().querySelector('.chart-line-probe2')).toBeNull();
    // The legend names each channel drawn.
    const legend = chartSection().querySelector('.recharts-legend-wrapper');
    expect(legend?.textContent).toBe('GrillProbe 1');
    expect(chartSection().getAttribute('data-state')).toBe('loaded');
    expect(api.chartCalls()).toBe(1);
  });

  it('shows "Chart not available" on 404', async () => {
    fakeServer({
      cook: COMPLETED,
      chart: () => jsonResponse(404, { error: 'NOT_FOUND', message: 'Cook not found' }),
    });
    renderPages('/cooks/cook-1');
    expect(await within(await screen.findByTestId('cook-chart')).findByText('Chart not available'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the problem on 500, and Retry fetches the chart again', async () => {
    const api = fakeServer({
      cook: COMPLETED,
      chart: call =>
        call === 1
          ? jsonResponse(500, {
              error: 'INTERNAL_SERVER_ERROR',
              message: 'Something broke',
              requestId: 'req-500',
            })
          : jsonResponse(200, CHART),
    });
    renderPages('/cooks/cook-1');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Something broke');
    expect(alert.textContent).toContain('req-500');
    await userEvent.click(within(chartSection()).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(avgLines()).toHaveLength(2));
    expect(api.chartCalls()).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows "No readings yet" when the chart has no points', async () => {
    fakeServer({ cook: COMPLETED, chart: () => jsonResponse(200, { ...CHART, points: [] }) });
    renderPages('/cooks/cook-1');
    expect(await within(await screen.findByTestId('cook-chart')).findByText('No readings yet'));
    expect(chartSection().querySelector('svg')).toBeNull();
  });

  it("appends a temperature pushed over the page's one hub connection, and refetches when the cook completes", async () => {
    const server: Server = { cook: COOK, chart: () => jsonResponse(200, CHART) };
    const api = fakeServer(server);
    const hubs = createFakeHubs();
    renderPages('/cooks/cook-1', { createHub: hubs.createHub });

    await waitFor(() => expect(avgLines()).toHaveLength(2));
    await waitFor(() => expect(hubs.latest().start).toHaveBeenCalled());
    const frame = () => chartSection().querySelector('.chart-frame') as HTMLElement;
    expect(frame().getAttribute('data-rows')).toBe('2');

    // After the last bucket ([15:00, 16:00)): appended. Inside it: already counted.
    act(() =>
      hubs.latest().emit('temperature', makeTemperature({ timestamp: '2026-11-20T15:30:00.000Z' }))
    );
    expect(frame().getAttribute('data-rows')).toBe('2');
    const pushedAt = '2026-11-20T16:00:30.000Z';
    act(() =>
      hubs.latest().emit('temperature', makeTemperature({ timestamp: pushedAt, probe2Temp: 70 }))
    );
    expect(frame().getAttribute('data-rows')).toBe('3');
    expect(frame().getAttribute('data-last-t')).toBe(String(Date.parse(pushedAt)));
    // probe2 is only in the pushed row, and gets its own line.
    await waitFor(() => expect(avgLines()).toHaveLength(3));

    // Another device's reading never reaches the chart.
    act(() =>
      hubs
        .latest()
        .emit(
          'temperature',
          makeTemperature({ deviceId: 'offset-1', timestamp: '2026-11-20T16:05:00.000Z' })
        )
    );
    expect(frame().getAttribute('data-rows')).toBe('3');

    // The live panel's connection is the page's only one.
    expect(hubs.createHub).toHaveBeenCalledTimes(1);
    expect(api.requests.filter(r => apiPath(r) === '/negotiate')).toHaveLength(1);

    // The cook ends: the chart is read again, once.
    server.cook = COMPLETED;
    act(() =>
      hubs.latest().emit('cook_stopped', {
        type: 'cook_stopped',
        timestamp: '2026-11-20T23:15:00.000Z',
        messageId: '6c0f8a43-8d9b-4f4f-9d3e-2b1d7a1f0c11',
        deviceId: BRISKET_BOX.id,
        userId: COOK.userId,
        correlation: { id: 'req-1' },
        payload: COMPLETED,
      })
    );
    await waitFor(() => expect(screen.queryByTestId('cook-live-panel')).toBeNull());
    await waitFor(() => expect(api.chartCalls()).toBe(2));
    expect(hubs.createHub).toHaveBeenCalledTimes(1);
  });
});
