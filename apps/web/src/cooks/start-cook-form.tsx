import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../api/api-context';
import type { Device, StartCookRequest } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage, ProblemText } from '../api/problem-message';
import {
  EMPTY_START_COOK,
  TARGET_KEYS,
  TARGET_LABELS,
  toStartCookRequest,
  validateStartCook,
  type StartCookErrors,
  type StartCookInput,
} from './validation';

type Outcome =
  | { kind: 'problem'; problem: ApiProblem }
  | { kind: 'already-active'; problem: ApiProblem; activeCookId: string }
  | { kind: 'twin-failed'; problem: ApiProblem; body: StartCookRequest };

const FIELDS: { key: keyof StartCookInput; label: string; optional?: boolean }[] = [
  { key: 'name', label: 'Name' },
  { key: 'meatType', label: 'Meat type' },
  { key: 'weight', label: 'Weight (lb)', optional: true },
  ...TARGET_KEYS.map(key => ({ key, label: `${TARGET_LABELS[key]} (°F)`, optional: true })),
];

const NUMERIC = new Set<keyof StartCookInput>(['weight', ...TARGET_KEYS]);

/**
 * Starts a cook on one device. The cook id is generated once, when the form
 * mounts (one start intent), and sent on every submit and retry of it: it is
 * the API's idempotency key. Closing the form unmounts it, so reopening is a
 * new intent with a new id.
 */
export function StartCookForm({ device, onClose }: { device: Device; onClose: () => void }) {
  const api = useApi();
  const navigate = useNavigate();
  const [cookId] = useState(() => crypto.randomUUID());
  const [input, setInput] = useState<StartCookInput>(EMPTY_START_COOK);
  const [fieldErrors, setFieldErrors] = useState<StartCookErrors>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [sending, setSending] = useState(false);

  async function send(body: StartCookRequest) {
    setSending(true);
    try {
      const { data, error, response } = await api.POST('/cooks', { body });
      if (data !== undefined) {
        navigate(`/cooks/${encodeURIComponent(body.id)}`);
        return;
      }
      const problem = problemFromResponse(error, response);
      const activeCookId = stringField(error, 'activeCookId');
      if (response.status === 409 && problem.code === 'COOK_ALREADY_ACTIVE' && activeCookId) {
        setOutcome({ kind: 'already-active', problem, activeCookId });
      } else if (response.status === 503 && problem.code === 'DEVICE_TWIN_UPDATE_FAILED') {
        setOutcome({ kind: 'twin-failed', problem, body });
      } else {
        setOutcome({ kind: 'problem', problem });
      }
    } catch (err) {
      setOutcome({ kind: 'problem', problem: problemFromError(err) });
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const errors = validateStartCook(input);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    void send(toStartCookRequest(cookId, device.id, input));
  }

  return (
    <form
      className="card start-cook-form"
      onSubmit={submit}
      noValidate
      aria-label={`Start a cook on ${device.name}`}
    >
      <h2>Start a cook on {device.name}</h2>
      <div className="field-grid">
        {FIELDS.map(({ key, label, optional }) => (
          <label key={key} className="field">
            <span>
              {label}
              {optional && <span className="muted"> (optional)</span>}
            </span>
            <input
              name={key}
              value={input[key]}
              inputMode={NUMERIC.has(key) ? 'decimal' : undefined}
              onChange={e => setInput({ ...input, [key]: e.target.value })}
              aria-invalid={fieldErrors[key] ? true : undefined}
            />
            {fieldErrors[key] && <span className="field-error">{fieldErrors[key]}</span>}
          </label>
        ))}
      </div>

      {outcome?.kind === 'already-active' && (
        <div className="problem" role="alert">
          This device already has an active cook.{' '}
          <Link to={`/cooks/${encodeURIComponent(outcome.activeCookId)}`}>
            Open the active cook
          </Link>
        </div>
      )}
      {outcome?.kind === 'twin-failed' && (
        <div className="notice" role="alert">
          <p>
            The cook was saved, but the device was not told about it. Retry to tell the device.{' '}
            <Link to={`/cooks/${encodeURIComponent(outcome.body.id)}`}>Open the cook</Link>
          </p>
          <p className="problem">
            <ProblemText problem={outcome.problem} />
          </p>
          <button type="button" disabled={sending} onClick={() => void send(outcome.body)}>
            {sending ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      {outcome?.kind === 'problem' && <ProblemMessage problem={outcome.problem} />}

      <div className="actions">
        <button type="submit" disabled={sending}>
          {sending ? 'Starting…' : 'Start'}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
