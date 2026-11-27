import { connect } from 'node:http2';

/**
 * #243 — the one seam to Apple. A request is what was sent to which device
 * token with which headers; a response is what Apple answered. Tests use fakes
 * of this interface; production uses {@link Http2ApnsTransport}, built on
 * Node's own `node:http2`. No dependency.
 */

export interface ApnsRequest {
  /** `https://api.sandbox.push.apple.com`: scheme and host, no path. */
  readonly authority: string;
  readonly deviceToken: string;
  /** Includes `authorization: bearer <provider token>`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ApnsResponse {
  readonly status: number;
  /** Apple's `apns-id` response header, when present. */
  readonly apnsId?: string;
  /** Apple's JSON body: a `reason` on a refusal, empty on 200. */
  readonly body: string;
}

export interface ApnsTransport {
  send(request: ApnsRequest): Promise<ApnsResponse>;
}

/** Thrown when no answer came from Apple. Carries no request detail. */
export class ApnsTransportError extends Error {
  constructor() {
    super('apns_unreachable');
    this.name = 'ApnsTransportError';
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/** One HTTP/2 session per request: pushes are rare, and a session is cheap to open. */
export class Http2ApnsTransport implements ApnsTransport {
  send(request: ApnsRequest): Promise<ApnsResponse> {
    return new Promise<ApnsResponse>((resolve, reject) => {
      const session = connect(request.authority);
      const fail = () => {
        session.destroy();
        reject(new ApnsTransportError());
      };
      session.on('error', fail);
      session.setTimeout(REQUEST_TIMEOUT_MS, fail);

      const stream = session.request({
        ':method': 'POST',
        ':path': `/3/device/${request.deviceToken}`,
        ...request.headers,
      });
      let status = 0;
      let apnsId: string | undefined;
      const chunks: Buffer[] = [];
      stream.on('response', (headers) => {
        status = Number(headers[':status']);
        const id = headers['apns-id'];
        apnsId = typeof id === 'string' ? id : undefined;
      });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', fail);
      stream.on('end', () => {
        session.close();
        if (status === 0) {
          // The stream ended with no response headers (a GOAWAY, a reset).
          reject(new ApnsTransportError());
          return;
        }
        resolve({
          status,
          ...(apnsId ? { apnsId } : {}),
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      stream.end(request.body);
    });
  }
}
