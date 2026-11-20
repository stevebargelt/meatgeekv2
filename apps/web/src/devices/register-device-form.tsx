import { useState, type FormEvent } from 'react';
import { useApi } from '../api/api-context';
import type { RegisterDeviceRequest } from '../api/client';
import { problemFromError, problemFromResponse, type ApiProblem } from '../api/problem';
import { ProblemMessage } from '../api/problem-message';
import { validateRegistration, type FieldErrors, type RegisterDeviceInput } from './validation';

const EMPTY: RegisterDeviceInput = { deviceId: '', name: '', model: '', location: '' };

const FIELDS: { key: keyof RegisterDeviceInput; label: string; optional?: boolean }[] = [
  { key: 'deviceId', label: 'Device ID' },
  { key: 'name', label: 'Name' },
  { key: 'model', label: 'Model' },
  { key: 'location', label: 'Location', optional: true },
];

export function RegisterDeviceForm({ onRegistered }: { onRegistered: () => void }) {
  const api = useApi();
  const [input, setInput] = useState<RegisterDeviceInput>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    const errors = validateRegistration(input);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const body: RegisterDeviceRequest = {
      deviceId: input.deviceId,
      name: input.name.trim(),
      model: input.model.trim(),
    };
    const location = input.location.trim();
    if (location !== '') body.location = location;

    setSubmitting(true);
    try {
      const { error, response } = await api.POST('/devices', { body });
      if (error !== undefined || !response.ok) {
        setProblem(problemFromResponse(error, response));
        return;
      }
      setInput(EMPTY);
      onRegistered();
    } catch (err) {
      setProblem(problemFromError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="card register-form"
      onSubmit={submit}
      noValidate
      aria-label="Register a device"
    >
      <h2>Register a device</h2>
      {FIELDS.map(({ key, label, optional }) => (
        <label key={key} className="field">
          <span>
            {label}
            {optional && <span className="muted"> (optional)</span>}
          </span>
          <input
            name={key}
            value={input[key]}
            onChange={e => setInput({ ...input, [key]: e.target.value })}
            aria-invalid={fieldErrors[key] ? true : undefined}
          />
          {fieldErrors[key] && <span className="field-error">{fieldErrors[key]}</span>}
        </label>
      ))}
      {problem && <ProblemMessage problem={problem} />}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Registering…' : 'Register'}
      </button>
    </form>
  );
}
