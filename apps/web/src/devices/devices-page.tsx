import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/api-context';
import type { Cook, Device } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage } from '../api/problem-message';
import { DeviceRow } from './device-row';

type ListState =
  | { status: 'loading' }
  /** `readAt`: when the list answered, on the page's clock (HAR-143). */
  | { status: 'loaded'; devices: Device[]; readAt: number }
  | { status: 'error'; problem: ApiProblem };

/** The caller's active cooks keyed by device id, or why they could not be read. */
type ActiveCooks = Map<string, Cook> | { problem: ApiProblem } | undefined;

interface DevicesPageProps {
  /**
   * HAR-143: the clock each device's "last heard" age is measured on (epoch
   * ms). It is read once per load of the list, so the age is as of the same
   * moment as the connection it describes; nothing polls.
   */
  clock?: () => number;
}

export function DevicesPage({ clock = Date.now }: DevicesPageProps = {}) {
  const api = useApi();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [notice, setNotice] = useState<ApiProblem | null>(null);
  const [reloads, setReloads] = useState(0);
  const refresh = useCallback(() => {
    setNotice(null);
    setReloads(n => n + 1);
  }, []);
  const deviceGone = useCallback((problem: ApiProblem) => {
    setNotice(problem);
    setReloads(n => n + 1);
  }, []);
  // 204 from DELETE /devices/{id}: the device leaves the list, with no re-read.
  const released = useCallback((deviceId: string) => {
    setNotice(null);
    setState(current =>
      current.status === 'loaded'
        ? { ...current, devices: current.devices.filter(device => device.id !== deviceId) }
        : current
    );
  }, []);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const { data, error, response } = await api.GET('/devices');
        if (!current) return;
        if (data === undefined) {
          setState({ status: 'error', problem: problemFromResponse(error, response) });
        } else {
          setState({ status: 'loaded', devices: data.devices, readAt: clock() });
        }
      } catch (err) {
        if (current) setState({ status: 'error', problem: problemFromError(err) });
      }
    })();
    return () => {
      current = false;
    };
  }, [api, reloads, clock]);

  // One GET /cooks?status=active for the page, not one call per device. It is
  // not re-read when the device list is: renaming or releasing a device does
  // not start or stop a cook. A user has at most one active cook per device;
  // 100 is the API's largest page.
  const [activeCooks, setActiveCooks] = useState<ActiveCooks>(undefined);
  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const { data, error, response } = await api.GET('/cooks', {
          params: { query: { status: 'active', limit: 100 } },
        });
        if (!current) return;
        if (data === undefined) {
          setActiveCooks({ problem: problemFromResponse(error, response) });
        } else {
          setActiveCooks(new Map(data.cooks.map(cook => [cook.deviceId, cook])));
        }
      } catch (err) {
        if (current) setActiveCooks({ problem: problemFromError(err) });
      }
    })();
    return () => {
      current = false;
    };
  }, [api]);

  return (
    <section className="devices">
      <h1>Devices</h1>
      <p>
        <Link to="/devices/claim">Claim a device</Link>
      </p>
      {notice && <ProblemMessage problem={notice} />}
      {state.status === 'loaded' && activeCooks && 'problem' in activeCooks && (
        <ProblemMessage
          problem={{
            ...activeCooks.problem,
            message: `Could not check which devices are cooking: ${activeCooks.problem.message}`,
          }}
        />
      )}
      <DeviceList
        state={state}
        activeCooks={activeCooks instanceof Map ? activeCooks : undefined}
        onChanged={refresh}
        onReleased={released}
        onNotFound={deviceGone}
      />
    </section>
  );
}

interface DeviceListProps {
  state: ListState;
  activeCooks: Map<string, Cook> | undefined;
  onChanged: () => void;
  onReleased: (deviceId: string) => void;
  onNotFound: (problem: ApiProblem) => void;
}

function DeviceList({ state, activeCooks, onChanged, onReleased, onNotFound }: DeviceListProps) {
  if (state.status === 'loading') {
    return <p className="muted">Loading devices…</p>;
  }
  if (state.status === 'error') {
    return <ProblemMessage problem={state.problem} />;
  }
  if (state.devices.length === 0) {
    return (
      <p className="muted">You have no devices yet. Claim one with the code your device shows.</p>
    );
  }
  return (
    <table className="device-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">ID</th>
          <th scope="col">Model</th>
          <th scope="col">Location</th>
          <th scope="col">Status</th>
          <th scope="col">Cook</th>
        </tr>
      </thead>
      <tbody>
        {state.devices.map(device => (
          <DeviceRow
            key={device.id}
            device={device}
            now={state.readAt}
            activeCook={activeCooks?.get(device.id)}
            onChanged={onChanged}
            onReleased={onReleased}
            onNotFound={onNotFound}
          />
        ))}
      </tbody>
    </table>
  );
}
