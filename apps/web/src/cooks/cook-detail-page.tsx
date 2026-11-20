import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/api-context';
import type { Cook } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage, ProblemText } from '../api/problem-message';
import { formatDateTime, formatElapsed, useNow } from './time';
import { deviceLabel, useDevices } from './use-devices';
import { TARGET_KEYS, TARGET_LABELS } from './validation';

type DetailState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; problem: ApiProblem }
  | { status: 'loaded'; cook: Cook };

/** GET /cooks/{cookId}: the cook's fields, and a Stop button while it is active. */
export function CookDetailPage() {
  const api = useApi();
  const { id = '' } = useParams<{ id: string }>();
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    (async () => {
      try {
        const { data, error, response } = await api.GET('/cooks/{cookId}', {
          params: { path: { cookId: id } },
        });
        if (!current) return;
        if (data !== undefined) setState({ status: 'loaded', cook: data });
        else if (response.status === 404) setState({ status: 'not-found' });
        else setState({ status: 'error', problem: problemFromResponse(error, response) });
      } catch (err) {
        if (current) setState({ status: 'error', problem: problemFromError(err) });
      }
    })();
    return () => {
      current = false;
    };
  }, [api, id]);

  if (state.status === 'loading') {
    return <p className="muted">Loading cook…</p>;
  }
  if (state.status === 'not-found') {
    return (
      <section>
        <h1>This cook was not found</h1>
        <p>
          <Link to="/cooks">Back to cooks</Link>
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <ProblemMessage problem={state.problem} />
        <p>
          <Link to="/cooks">Back to cooks</Link>
        </p>
      </section>
    );
  }
  return <CookDetail cook={state.cook} onStopped={cook => setState({ status: 'loaded', cook })} />;
}

function CookDetail({ cook, onStopped }: { cook: Cook; onStopped: (cook: Cook) => void }) {
  const devices = useDevices();
  const active = cook.status === 'active';
  const now = useNow(active);
  const targets = TARGET_KEYS.filter(key => cook.targetTemps?.[key] !== undefined);

  return (
    <section className="cook-detail">
      <p>
        <Link to="/cooks">← Cooks</Link>
      </p>
      <h1>{cook.name}</h1>
      <dl className="cook-fields">
        <Field label="Status">{cook.status}</Field>
        <Field label="Meat type">{cook.meatType}</Field>
        <Field label="Device">{deviceLabel(cook.deviceId, devices)}</Field>
        <Field label="Started">{formatDateTime(cook.startTime)}</Field>
        {cook.endTime ? (
          <Field label="Ended">{formatDateTime(cook.endTime)}</Field>
        ) : (
          active && (
            <Field label="Elapsed">{formatElapsed(now - new Date(cook.startTime).getTime())}</Field>
          )
        )}
        <Field label="Weight">{cook.weight !== undefined ? `${cook.weight} lb` : undefined}</Field>
        <Field label="Targets">
          {targets.length > 0 ? (
            <ul className="plain">
              {targets.map(key => (
                <li key={key}>
                  {TARGET_LABELS[key]}: {cook.targetTemps?.[key]} °F
                </li>
              ))}
            </ul>
          ) : undefined}
        </Field>
        <Field label="Notes">{cook.notes}</Field>
      </dl>

      {active && <StopCook cook={cook} onStopped={onStopped} />}

      {/* Filled by later issues: the live panel (SignalR) and the chart. */}
      {active && <section data-testid="cook-live-panel" aria-label="Live readings" />}
      <section data-testid="cook-chart" aria-label="Temperature chart" />
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children ?? <span className="muted">—</span>}</dd>
    </>
  );
}

type StopState =
  | { step: 'idle' }
  | { step: 'confirming' }
  | { step: 'stopping' }
  | { step: 'twin-failed'; problem: ApiProblem }
  | { step: 'problem'; problem: ApiProblem };

/**
 * Stop with a confirm step. POST /cooks/{cookId}/stop is safe to resend (a
 * completed cook is returned again), so a 503 offers Retry.
 */
function StopCook({ cook, onStopped }: { cook: Cook; onStopped: (cook: Cook) => void }) {
  const api = useApi();
  const [state, setState] = useState<StopState>({ step: 'idle' });

  async function stop() {
    setState({ step: 'stopping' });
    try {
      const { data, error, response } = await api.POST('/cooks/{cookId}/stop', {
        params: { path: { cookId: cook.id } },
      });
      if (data !== undefined) {
        onStopped(data);
        return;
      }
      const problem = problemFromResponse(error, response);
      setState(
        response.status === 503 && problem.code === 'DEVICE_TWIN_UPDATE_FAILED'
          ? { step: 'twin-failed', problem }
          : { step: 'problem', problem }
      );
    } catch (err) {
      setState({ step: 'problem', problem: problemFromError(err) });
    }
  }

  if (state.step === 'confirming') {
    return (
      <div className="card confirm" role="group" aria-label="Confirm stop">
        <p>Stop {cook.name}? The cook is marked completed and the device is told to stop.</p>
        <div className="actions">
          <button type="button" onClick={() => void stop()}>
            Yes, stop cook
          </button>
          <button type="button" className="secondary" onClick={() => setState({ step: 'idle' })}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (state.step === 'twin-failed') {
    return (
      <div className="notice" role="alert">
        <p>The cook was stopped, but the device was not told. Retry to tell the device.</p>
        <p className="problem">
          <ProblemText problem={state.problem} />
        </p>
        <button type="button" onClick={() => void stop()}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="actions">
      <button
        type="button"
        disabled={state.step === 'stopping'}
        onClick={() => setState({ step: 'confirming' })}
      >
        {state.step === 'stopping' ? 'Stopping…' : 'Stop cook'}
      </button>
      {state.step === 'problem' && <ProblemMessage problem={state.problem} />}
    </div>
  );
}
