import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useApi } from '../api/api-context';
import type { CookStatus } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage } from '../api/problem-message';
import type { TemperatureUnit } from '../live/format';
import type { TemperatureMessage } from '../live/hub';
import { buildChartSeries, type CookChart as CookChartData } from './chart-series';

// recharts is only downloaded by the page that draws a chart.
const CookChartView = lazy(() => import('./cook-chart-view'));

type ChartState =
  | { status: 'loading' }
  | { status: 'not-available' }
  | { status: 'error'; problem: ApiProblem }
  | { status: 'loaded'; chart: CookChartData };

/**
 * GET /cooks/{cookId}/chart drawn as one chart, with the readings pushed since
 * it loaded appended after its last bucket.
 *
 * Fetches once on mount, again when the cook goes from active to completed
 * (the stored series then covers the whole cook), and on Retry after an error.
 */
export function CookChart({
  cookId,
  cookStatus,
  pushed,
  unit,
}: {
  cookId: string;
  cookStatus: CookStatus;
  pushed: readonly TemperatureMessage[];
  unit: TemperatureUnit;
}) {
  const api = useApi();
  const [state, setState] = useState<ChartState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const { data, error, response } = await api.GET('/cooks/{cookId}/chart', {
          params: { path: { cookId } },
        });
        if (!current) return;
        if (data !== undefined) setState({ status: 'loaded', chart: data });
        else if (response.status === 404) setState({ status: 'not-available' });
        else setState({ status: 'error', problem: problemFromResponse(error, response) });
      } catch (err) {
        if (current) setState({ status: 'error', problem: problemFromError(err) });
      }
    })();
    return () => {
      current = false;
    };
  }, [api, cookId, cookStatus, attempt]);

  const chart = state.status === 'loaded' ? state.chart : undefined;
  const series = useMemo(
    () => (chart ? buildChartSeries(chart, pushed, unit) : undefined),
    [chart, pushed, unit]
  );

  let body;
  if (state.status === 'loading') {
    body = <p className="muted">Loading chart…</p>;
  } else if (state.status === 'not-available') {
    body = <p className="muted">Chart not available</p>;
  } else if (state.status === 'error') {
    body = (
      <>
        <ProblemMessage problem={state.problem} />
        <button
          type="button"
          onClick={() => {
            setState({ status: 'loading' });
            setAttempt(n => n + 1);
          }}
        >
          Retry
        </button>
      </>
    );
  } else if (!series || series.rows.length === 0) {
    body = <p className="muted">No readings yet</p>;
  } else {
    body = (
      <div
        className="chart-frame"
        data-rows={series.rows.length}
        data-last-t={series.rows[series.rows.length - 1].t}
      >
        <Suspense fallback={<p className="muted">Loading chart…</p>}>
          <CookChartView rows={series.rows} channels={series.channels} unit={unit} />
        </Suspense>
      </div>
    );
  }

  return (
    <section
      className="card cook-chart"
      data-testid="cook-chart"
      data-state={state.status}
      aria-label="Temperature chart"
    >
      <h2>Temperatures</h2>
      {body}
    </section>
  );
}
