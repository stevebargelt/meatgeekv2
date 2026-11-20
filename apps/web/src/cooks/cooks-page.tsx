import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../api/api-context';
import type { Cook, Device } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage } from '../api/problem-message';
import { formatDateTime } from './time';
import { deviceLabel, useDevices } from './use-devices';

export const PAGE_SIZE = 20;

/** The statuses the list can be filtered by. */
const STATUS_FILTERS = ['active', 'completed'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

type ListState =
  | { status: 'loading' }
  | { status: 'error'; problem: ApiProblem }
  | {
      status: 'loaded';
      cooks: Cook[];
      continuationToken?: string;
      hasMore: boolean;
      loadingMore: boolean;
      moreProblem?: ApiProblem;
    };

/**
 * GET /cooks, newest first as the API returns them, 20 at a time with a
 * "Load more" that sends the previous page's continuationToken. The device
 * and status filters live in the URL (`?deviceId=&status=`) and go to the
 * API as its query parameters.
 */
export function CooksPage() {
  const api = useApi();
  const devices = useDevices();
  const [searchParams, setSearchParams] = useSearchParams();
  const deviceId = searchParams.get('deviceId') || undefined;
  const statusParam = searchParams.get('status');
  const status = STATUS_FILTERS.find(s => s === statusParam);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  // Bumped on every filter change, so a page that arrives for an old filter
  // is dropped instead of appended.
  const generation = useRef(0);

  async function fetchPage(continuationToken: string | undefined) {
    const { data, error, response } = await api.GET('/cooks', {
      params: { query: { limit: PAGE_SIZE, deviceId, status, continuationToken } },
    });
    if (data === undefined) {
      return { ok: false as const, problem: problemFromResponse(error, response) };
    }
    return { ok: true as const, page: data };
  }

  useEffect(() => {
    const mine = ++generation.current;
    setState({ status: 'loading' });
    (async () => {
      try {
        const result = await fetchPage(undefined);
        if (generation.current !== mine) return;
        setState(
          result.ok
            ? {
                status: 'loaded',
                cooks: result.page.cooks,
                continuationToken: result.page.continuationToken,
                hasMore: result.page.hasMore,
                loadingMore: false,
              }
            : { status: 'error', problem: result.problem }
        );
      } catch (err) {
        if (generation.current === mine)
          setState({ status: 'error', problem: problemFromError(err) });
      }
    })();
    // fetchPage reads only api, deviceId and status.
  }, [api, deviceId, status]);

  async function loadMore() {
    if (state.status !== 'loaded' || state.loadingMore) return;
    const mine = generation.current;
    setState({ ...state, loadingMore: true, moreProblem: undefined });
    let next: Partial<Extract<ListState, { status: 'loaded' }>>;
    try {
      const result = await fetchPage(state.continuationToken);
      next = result.ok
        ? {
            cooks: [...state.cooks, ...result.page.cooks],
            continuationToken: result.page.continuationToken,
            hasMore: result.page.hasMore,
          }
        : { moreProblem: result.problem };
    } catch (err) {
      next = { moreProblem: problemFromError(err) };
    }
    if (generation.current !== mine) return;
    setState(prev => (prev.status === 'loaded' ? { ...prev, ...next, loadingMore: false } : prev));
  }

  function setFilter(key: 'deviceId' | 'status', value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  }

  return (
    <section className="cooks">
      <h1>Cooks</h1>
      <form className="filters" aria-label="Filter cooks" onSubmit={e => e.preventDefault()}>
        <label className="field">
          <span>Device</span>
          <select value={deviceId ?? ''} onChange={e => setFilter('deviceId', e.target.value)}>
            <option value="">All devices</option>
            {deviceOptions(devices, deviceId).map(device => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select value={status ?? ''} onChange={e => setFilter('status', e.target.value)}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
          </select>
        </label>
      </form>
      <CookList state={state} devices={devices} filtered={deviceId !== undefined || !!status} />
      {state.status === 'loaded' && state.moreProblem && (
        <ProblemMessage problem={state.moreProblem} />
      )}
      {state.status === 'loaded' && state.hasMore && (
        <button type="button" disabled={state.loadingMore} onClick={() => void loadMore()}>
          {state.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}

/** The caller's devices, plus the filtered one if it is not among them (e.g. deleted). */
function deviceOptions(devices: Device[] | undefined, selected: string | undefined) {
  const options = (devices ?? []).map(device => ({ id: device.id, name: device.name }));
  if (selected && !options.some(option => option.id === selected)) {
    options.push({ id: selected, name: selected });
  }
  return options;
}

function CookList({
  state,
  devices,
  filtered,
}: {
  state: ListState;
  devices: Device[] | undefined;
  filtered: boolean;
}) {
  if (state.status === 'loading') {
    return <p className="muted">Loading cooks…</p>;
  }
  if (state.status === 'error') {
    return <ProblemMessage problem={state.problem} />;
  }
  if (state.cooks.length === 0) {
    return (
      <p className="muted">
        {filtered
          ? 'No cooks match these filters.'
          : 'You have no cooks yet. Start one from a device on the Devices page.'}
      </p>
    );
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Meat type</th>
          <th scope="col">Device</th>
          <th scope="col">Started</th>
          <th scope="col">Ended</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {state.cooks.map(cook => (
          <tr key={cook.id}>
            <td>
              <Link to={`/cooks/${encodeURIComponent(cook.id)}`}>{cook.name}</Link>
            </td>
            <td>{cook.meatType ?? <span className="muted">—</span>}</td>
            <td>{deviceLabel(cook.deviceId, devices)}</td>
            <td>{formatDateTime(cook.startTime)}</td>
            <td>
              {cook.endTime ? (
                formatDateTime(cook.endTime)
              ) : cook.status === 'active' ? (
                'active'
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td>{cook.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
