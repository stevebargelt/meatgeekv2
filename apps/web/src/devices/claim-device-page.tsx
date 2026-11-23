import { useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../api/api-context';
import type { ClaimDeviceRequest } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage } from '../api/problem-message';
import {
  formatClaimCode,
  validateClaim,
  type ClaimDeviceInput,
  type FieldErrors,
} from './validation';

/** What each refusal of POST /devices/claim says. Every 403 is the same, as the API intends. */
export const CLAIM_MESSAGES = {
  refused:
    "That code doesn't match this device, or it has expired or been used. " +
    'Run the setup command on the device again to get a fresh code.',
  conflict: 'You already have a device with that name.',
  busy: 'The device service is busy — try again.',
} as const;

/**
 * `/devices/claim[?deviceId=<id>]`: claim a device with the code it shows
 * (HAR-130). The onboarding command prints this URL with the device id; the
 * code is never in a URL. It is held only in this form's state, and the field
 * is cleared once the claim succeeds.
 */
export function ClaimDevicePage() {
  const api = useApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [input, setInput] = useState<ClaimDeviceInput>(() => ({
    deviceId: params.get('deviceId') ?? '',
    claimCode: '',
    name: '',
    location: '',
  }));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Formatting the code moves characters, so the caret is put back after the
  // same symbols it was after.
  const codeField = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || codeField.current === null) return;
    codeField.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [input.claimCode]);

  function typeCode(event: ChangeEvent<HTMLInputElement>) {
    const { value, cursor } = formatClaimCode(
      event.target.value,
      event.target.selectionStart ?? event.target.value.length
    );
    caret.current = cursor;
    setInput(current => ({ ...current, claimCode: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    const errors = validateClaim(input);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    // The code goes as typed: the API normalizes it. No model: the API
    // stores "MeatGeek" (openapi-typescript types a defaulted field as
    // required, hence the cast below).
    const body: Omit<ClaimDeviceRequest, 'model'> = {
      deviceId: input.deviceId,
      claimCode: input.claimCode,
      name: input.name.trim(),
    };
    const location = input.location.trim();
    if (location !== '') body.location = location;

    setSubmitting(true);
    try {
      const { data, error, response } = await api.POST('/devices/claim', {
        body: body as ClaimDeviceRequest,
      });
      if (data !== undefined) {
        // Committed before the page goes, so the field is blank even then.
        flushSync(() => setInput(current => ({ ...current, claimCode: '' })));
        navigate('/');
        return;
      }
      setProblem(claimProblem(problemFromResponse(error, response)));
    } catch (err) {
      setProblem(problemFromError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const field = (key: keyof ClaimDeviceInput) => ({
    name: key,
    value: input[key],
    'aria-invalid': fieldErrors[key] ? true : undefined,
  });
  const set = (key: keyof ClaimDeviceInput) => (event: ChangeEvent<HTMLInputElement>) =>
    setInput(current => ({ ...current, [key]: event.target.value }));

  return (
    <section className="claim-device">
      <h1>Claim a device</h1>
      <p>
        Run the setup command on your device. It prints the device ID and a claim code; enter both
        here.
      </p>
      <form className="card" onSubmit={submit} noValidate aria-label="Claim a device">
        <label className="field">
          <span>Device ID</span>
          <input {...field('deviceId')} onChange={set('deviceId')} autoComplete="off" />
          <FieldError message={fieldErrors.deviceId} />
        </label>
        <label className="field">
          <span>Claim code</span>
          <input
            {...field('claimCode')}
            ref={codeField}
            onChange={typeCode}
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="claim-code"
          />
          <FieldError message={fieldErrors.claimCode} />
        </label>
        <label className="field">
          <span>Name</span>
          <input {...field('name')} onChange={set('name')} />
          <FieldError message={fieldErrors.name} />
        </label>
        <label className="field">
          <span>
            Location<span className="muted"> (optional)</span>
          </span>
          <input {...field('location')} onChange={set('location')} />
          <FieldError message={fieldErrors.location} />
        </label>
        {problem && <ProblemMessage problem={problem} />}
        <div className="actions">
          <button type="submit" disabled={submitting}>
            {submitting ? 'Claiming…' : 'Claim device'}
          </button>
          <Link to="/">Cancel</Link>
        </div>
      </form>
    </section>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  return message ? <span className="field-error">{message}</span> : null;
}

/** The message for a refused claim; a 400 or anything unexpected keeps the API's. */
function claimProblem(problem: ApiProblem): ApiProblem {
  if (problem.status === 403) return { ...problem, message: CLAIM_MESSAGES.refused };
  if (problem.status === 409) return { ...problem, message: CLAIM_MESSAGES.conflict };
  if (problem.status === 503) return { ...problem, message: CLAIM_MESSAGES.busy };
  return problem;
}
