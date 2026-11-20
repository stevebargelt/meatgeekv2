import { HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';

import type { AcceptanceApi } from '../lib/proof';
import { defineProofs, ProofFailure } from '../lib/proof';

/**
 * HAR-57 (MG-30) — POST /negotiate hands the caller a working SignalR
 * connection to the deployed service, scoped to the caller.
 *
 *   1. `POST /negotiate` answers 200 with a `url` and an `accessToken` (minted
 *      by the API through the SignalR data-plane REST API under managed
 *      identity). It reads the caller's devices, so it reports its RU.
 *   2. A `@microsoft/signalr` client opens a connection with that url and token
 *      (`accessTokenFactory`), and `start()` resolves: the service accepted the
 *      token the API minted.
 *   3. The connection stops cleanly.
 *
 * Nothing here prints the url or the token, and the client's own logging is
 * off, so neither can reach the run output.
 *
 * HAR-59: when negotiate answers anything but 200, the failure line carries the
 * body's `reason` (e.g. `signalr_add_user_to_group_status_404`), so the run log
 * names the SignalR call that failed and its status. Only a reason of the fixed
 * `signalr_…` shape is printed; anything else is reported as unrecognised.
 */

/** How long `start()` and `stop()` may take before the proof fails. */
const CONNECT_TIMEOUT_MS = 30_000;

interface NegotiateBody {
  url?: unknown;
  accessToken?: unknown;
  error?: unknown;
  reason?: unknown;
}

/** The shape of every code negotiate puts in a 503 `reason`. */
const SIGNALR_REASON = /^signalr_[a-z0-9_]{1,80}$/;

/** The failure line for a non-200 negotiate: status, error code and `reason`. */
function negotiateFailureMessage(status: number, body: unknown): string {
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
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
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
function describeError(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  let line = raw.split('\n')[0];
  for (const secret of secrets) {
    if (secret) {
      line = line.split(secret).join('***');
    }
  }
  return line.replace(/https?:\/\/\S+/g, '<url>');
}

export default defineProofs('signalr negotiate', () => {
  let connection: { url: string; accessToken: string } | undefined;

  return [
    {
      name: 'POST /negotiate returns a url and an accessToken',
      async run(api: AcceptanceApi) {
        const response = await api.request<NegotiateBody>({ method: 'POST', path: '/negotiate' });
        api.check(
          response,
          response.status === 200,
          negotiateFailureMessage(response.status, response.body)
        );
        const body = response.body;
        api.check(response, body !== null && typeof body === 'object', 'body is not a JSON object');
        api.check(
          response,
          typeof body.url === 'string' && /^https?:\/\/\S+\/client\/\?hub=/.test(body.url),
          'url is not a SignalR client url (…/client/?hub=…)'
        );
        api.check(
          response,
          typeof body.accessToken === 'string' && body.accessToken.length > 0,
          'accessToken is missing'
        );
        connection = { url: body.url as string, accessToken: body.accessToken as string };
      },
    },
    {
      name: 'a SignalR client connects with that url and token, then stops',
      async run() {
        if (!connection) {
          throw new Error('no connection info from an earlier proof');
        }
        const { url, accessToken } = connection;
        const hub = new HubConnectionBuilder()
          .withUrl(url, { accessTokenFactory: () => accessToken })
          .configureLogging(LogLevel.None)
          .build();

        try {
          await within(hub.start(), CONNECT_TIMEOUT_MS, 'start()');
        } catch (error) {
          await hub.stop().catch(() => undefined);
          if (error instanceof ProofFailure) {
            throw error;
          }
          throw new ProofFailure(`start() failed: ${describeError(error, [url, accessToken])}`);
        }
        if (hub.state !== HubConnectionState.Connected) {
          await hub.stop().catch(() => undefined);
          throw new ProofFailure(`after start() the connection is ${hub.state}, not Connected`);
        }

        await within(hub.stop(), CONNECT_TIMEOUT_MS, 'stop()');
        if ((hub.state as HubConnectionState) !== HubConnectionState.Disconnected) {
          throw new ProofFailure(`after stop() the connection is ${hub.state}, not Disconnected`);
        }
      },
    },
  ];
});
