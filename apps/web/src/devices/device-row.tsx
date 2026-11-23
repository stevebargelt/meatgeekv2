import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/api-context';
import type { Cook, Device } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage } from '../api/problem-message';
import { StartCookForm } from '../cooks/start-cook-form';
import { connectionText } from './connection';
import { validateLabel } from './validation';

interface DeviceRowProps {
  device: Device;
  /** HAR-143: when the list was read (epoch ms, from the page's clock); the
   *  connection's "last heard" age is relative to it. */
  now: number;
  /** The device's active cook, from the page's one GET /cooks?status=active. */
  activeCook?: Cook;
  /** Re-reads the list after a successful rename. */
  onChanged: () => void;
  /** The device was released (204): the page drops it from the list. */
  onReleased: (deviceId: string) => void;
  /** The device has gone (404): the page says so and re-reads the list. */
  onNotFound: (problem: ApiProblem) => void;
}

/** Columns in the device table; the start-cook and release rows span them all. */
export const DEVICE_COLUMNS = 6;

/** What a refused DELETE /devices/{id} says, by status. */
export const RELEASE_MESSAGES = {
  cookActive: 'Stop the active cook on this device before releasing it.',
  busy: 'The device service is busy — try again.',
} as const;

export function DeviceRow({
  device,
  now,
  activeCook,
  onChanged,
  onReleased,
  onNotFound,
}: DeviceRowProps) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [name, setName] = useState(device.name);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const [release, setRelease] = useState<'idle' | 'confirming' | 'releasing'>('idle');
  const [releaseProblem, setReleaseProblem] = useState<ApiProblem | null>(null);

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

  function confirmRelease() {
    setReleaseProblem(null);
    setRelease('confirming');
  }

  async function releaseDevice() {
    setRelease('releasing');
    try {
      const { error, response } = await api.DELETE('/devices/{id}', {
        params: { path: { id: device.id } },
      });
      if (response.status === 204) {
        onReleased(device.id);
        return;
      }
      const problem = problemFromResponse(error, response);
      if (response.status === 404) {
        onNotFound({
          ...problem,
          message: `Device ${device.id} was not found. The list has been refreshed.`,
        });
        return;
      }
      setRelease('idle');
      setReleaseProblem(
        response.status === 409 && problem.code === 'COOK_ACTIVE'
          ? { ...problem, message: RELEASE_MESSAGES.cookActive }
          : response.status === 503
            ? { ...problem, message: RELEASE_MESSAGES.busy }
            : problem
      );
    } catch (err) {
      setRelease('idle');
      setReleaseProblem(problemFromError(err));
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
              {release === 'idle' && (
                <button type="button" className="link" onClick={confirmRelease}>
                  Release
                </button>
              )}
            </>
          )}
          {problem && <ProblemMessage problem={problem} />}
          {releaseProblem && <ProblemMessage problem={releaseProblem} />}
        </td>
        <td>
          <code>{device.id}</code>
        </td>
        <td>{device.model}</td>
        <td>{device.location ?? <span className="muted">—</span>}</td>
        <td>
          <span
            className={`connection connection-${device.connection?.state ?? 'unknown'}`}
            data-testid="device-connection"
          >
            {connectionText(device.connection, now)}
          </span>
        </td>
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
      {release !== 'idle' && (
        <tr className="form-row">
          <td colSpan={DEVICE_COLUMNS}>
            <div
              className="card confirm"
              role="group"
              aria-label={`Confirm release of ${device.name}`}
            >
              <p>
                Release {device.name}? You'll need a new code from the device to claim it again.
              </p>
              <div className="actions">
                <button
                  type="button"
                  disabled={release === 'releasing'}
                  onClick={() => void releaseDevice()}
                >
                  {release === 'releasing' ? 'Releasing…' : 'Yes, release'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={release === 'releasing'}
                  onClick={() => setRelease('idle')}
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
