import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../api/api-context';
import type { Device } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage } from '../api/problem-message';
import { DeviceRow } from './device-row';
import { RegisterDeviceForm } from './register-device-form';

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; devices: Device[] }
  | { status: 'error'; problem: ApiProblem };

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

  return (
    <section className="devices">
      <h1>Devices</h1>
      {notice && <ProblemMessage problem={notice} />}
      <DeviceList state={state} onChanged={refresh} onNotFound={deviceGone} />
      <RegisterDeviceForm onRegistered={refresh} />
    </section>
  );
}

interface DeviceListProps {
  state: ListState;
  onChanged: () => void;
  onNotFound: (problem: ApiProblem) => void;
}

function DeviceList({ state, onChanged, onNotFound }: DeviceListProps) {
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
        </tr>
      </thead>
      <tbody>
        {state.devices.map(device => (
          <DeviceRow
            key={device.id}
            device={device}
            onChanged={onChanged}
            onNotFound={onNotFound}
          />
        ))}
      </tbody>
    </table>
  );
}
