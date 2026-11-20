import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api/api-context';
import type { Cook, Device } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage } from '../api/problem-message';
import { DeviceRow } from './device-row';
import { RegisterDeviceForm } from './register-device-form';

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; devices: Device[] }
  | { status: 'error'; problem: ApiProblem };

/** The caller's active cooks keyed by device id, or why they could not be read. */
type ActiveCooks = Map<string, Cook> | { problem: ApiProblem } | undefined;

export function DevicesPage() {
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

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const { data, error, response } = await api.GET('/devices');
        if (!current) return;
        if (data === undefined) {
          setState({ status: 'error', problem: problemFromResponse(error, response) });
        } else {
          setState({ status: 'loaded', devices: data.devices });
        }
      } catch (err) {
        if (current) setState({ status: 'error', problem: problemFromError(err) });
      }
    })();
    return () => {
      current = false;
    };
  }, [api, reloads]);

  // One GET /cooks?status=active for the page, not one call per device. It is
  // not re-read when the device list is: renaming or registering a device does
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
        onNotFound={deviceGone}
      />
      <RegisterDeviceForm onRegistered={refresh} />
    </section>
  );
}

interface DeviceListProps {
  state: ListState;
  activeCooks: Map<string, Cook> | undefined;
  onChanged: () => void;
  onNotFound: (problem: ApiProblem) => void;
}

function DeviceList({ state, activeCooks, onChanged, onNotFound }: DeviceListProps) {
  if (state.status === 'loading') {
    return <p className="muted">Loading devices…</p>;
  }
  if (state.status === 'error') {
    return <ProblemMessage problem={state.problem} />;
  }
  if (state.devices.length === 0) {
    return <p className="muted">You have no devices yet. Register one below.</p>;
  }
  return (
    <table className="device-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">ID</th>
          <th scope="col">Model</th>
          <th scope="col">Location</th>
          <th scope="col">Cook</th>
        </tr>
      </thead>
      <tbody>
        {state.devices.map(device => (
          <DeviceRow
            key={device.id}
            device={device}
            activeCook={activeCooks?.get(device.id)}
            onChanged={onChanged}
            onNotFound={onNotFound}
          />
        ))}
      </tbody>
    </table>
  );
}
