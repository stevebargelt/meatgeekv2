import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/api-context';
import type { Cook, Device } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage } from '../api/problem-message';
import { StartCookForm } from '../cooks/start-cook-form';
import { validateLabel } from './validation';

interface DeviceRowProps {
  device: Device;
  /** The device's active cook, from the page's one GET /cooks?status=active. */
  activeCook?: Cook;
  /** Re-reads the list after a successful rename. */
  onChanged: () => void;
  /** The device has gone (404): the page says so and re-reads the list. */
  onNotFound: (problem: ApiProblem) => void;
}

/** Columns in the device table; the start-cook form row spans them all. */
export const DEVICE_COLUMNS = 5;

export function DeviceRow({ device, activeCook, onChanged, onNotFound }: DeviceRowProps) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [name, setName] = useState(device.name);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [saving, setSaving] = useState(false);

  function startEditing() {
    setName(device.name);
    setProblem(null);
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const invalid = validateLabel('Name', name);
    if (invalid) {
      setProblem({ message: invalid });
      return;
    }
    setProblem(null);
    setSaving(true);
    try {
      const { error, response } = await api.PATCH('/devices/{id}', {
        params: { path: { id: device.id } },
        body: { name: name.trim() },
      });
      if (response.status === 404) {
        setEditing(false);
        onNotFound({
          ...problemFromResponse(error, response),
          message: `Device ${device.id} was not found. The list has been refreshed.`,
        });
        return;
      }
      if (error !== undefined || !response.ok) {
        setProblem(problemFromResponse(error, response));
        return;
      }
      setEditing(false);
      onChanged();
    } catch (err) {
      setProblem(problemFromError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <tr>
        <td>
          {editing ? (
            <form className="rename-form" onSubmit={save} aria-label={`Rename ${device.name}`}>
              <input
                aria-label="New name"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
              />
              <button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              {device.name}{' '}
              <button type="button" className="link" onClick={startEditing}>
                Rename
              </button>
            </>
          )}
          {problem && <ProblemMessage problem={problem} />}
        </td>
        <td>
          <code>{device.id}</code>
        </td>
        <td>{device.model}</td>
        <td>{device.location ?? <span className="muted">—</span>}</td>
        <td>
          {activeCook ? (
            <Link to={`/cooks/${encodeURIComponent(activeCook.id)}`}>
              Cooking: {activeCook.name}
            </Link>
          ) : (
            !starting && (
              <button type="button" className="secondary" onClick={() => setStarting(true)}>
                Start cook
              </button>
            )
          )}
        </td>
      </tr>
      {starting && !activeCook && (
        <tr className="form-row">
          <td colSpan={DEVICE_COLUMNS}>
            <StartCookForm device={device} onClose={() => setStarting(false)} />
          </td>
        </tr>
      )}
    </>
  );
}
