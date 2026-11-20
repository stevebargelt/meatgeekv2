import type { AcceptanceApi } from './proof';
import { ProofFailure } from './proof';

/**
 * Helpers the SignalR proofs share. None of them prints a SignalR url or an
 * access token: a proof's client logging is off, and errors are reduced to one
 * masked line.
 */

/** How long `start()` and `stop()` may take before a proof fails. */
export const CONNECT_TIMEOUT_MS = 30_000;

export interface NegotiateBody {
  url?: unknown;
  accessToken?: unknown;
  error?: unknown;
  reason?: unknown;
}

/** The shape of every code negotiate puts in a 503 `reason`. */
const SIGNALR_REASON = /^signalr_[a-z0-9_]{1,80}$/;

/**
 * The failure line for a non-200 negotiate: status, error code and `reason`
 * (HAR-59). Only a reason of the fixed `signalr_…` shape is printed; anything
 * else is reported as unrecognised.
 */
export function negotiateFailureMessage(status: number, body: unknown): string {
  const { error, reason } = (body ?? {}) as NegotiateBody;
  const code =
    typeof error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error) ? error : undefined;
  let why: string;
  if (reason === undefined) {
    why = 'no reason in the body';
  } else if (typeof reason === 'string' && SIGNALR_REASON.test(reason)) {
    why = `reason ${reason}`;
  } else {
    why = 'reason unrecognised, not printed';
  }
  return `expected 200, got ${status}${code ? ` (${code})` : ''}; ${why}`;
}

/** Rejects with a fixed message if `promise` has not settled in `ms`. */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProofFailure(`${what} did not finish in ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The error's name and first line, with the url and token masked. */
export function describeError(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  let line = raw.split('\n')[0];
  for (const secret of secrets) {
    if (secret) {
      line = line.split(secret).join('***');
    }
  }
  return line.replace(/https?:\/\/\S+/g, '<url>');
}

/**
 * HAR-77: fail unless `message`, received on hub target `target`, matches the
 * schema `x-signalr.messages.<target>` in openapi.yaml. The failure names the
 * target and the first schema errors with their path in the message, never a
 * value from it. Call it for every message a proof receives, once each: every
 * call counts towards the run's `CONTRACT … hub messages`.
 */
export function expectHubMessage(
  api: Pick<AcceptanceApi, 'contract'>,
  target: string,
  message: unknown
): void {
  const mismatch = api.contract.checkHubMessage(target, message);
  if (mismatch !== undefined) {
    throw new ProofFailure(mismatch);
  }
}
