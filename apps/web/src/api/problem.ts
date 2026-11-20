/**
 * What the UI shows when a call fails. The API's error bodies are flat,
 * `{error, message, requestId}` (the 401 variant carries `reason` in place of
 * `message`); `requestId` is kept so a user can quote it to support.
 */
export interface ApiProblem {
  status?: number;
  code?: string;
  message: string;
  requestId?: string;
}

/** Builds an ApiProblem from an openapi-fetch `error` body and its response. */
export function problemFromResponse(body: unknown, response: Response): ApiProblem {
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const code = stringField(fields, 'error');
  const reason = stringField(fields, 'reason');
  const message =
    stringField(fields, 'message') ??
    (response.status === 401
      ? `You are not authorized${reason ? ` (${reason})` : ''}. Try signing out and in again.`
      : `The request failed with HTTP ${response.status}.`);
  return {
    status: response.status,
    code,
    message,
    requestId:
      stringField(fields, 'requestId') ?? response.headers.get('X-Request-ID') ?? undefined,
  };
}

/** Builds an ApiProblem from a thrown error (network failure, token failure). */
export function problemFromError(err: unknown): ApiProblem {
  return { message: err instanceof Error ? err.message : String(err) };
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
