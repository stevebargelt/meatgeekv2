import type { ApnsTransport } from './apns-transport';
import type { ProviderTokenCache } from './provider-token';

/**
 * #243 — sends one push through the transport seam with a fresh-enough provider
 * token. It reports Apple's status and reason and nothing else: the provider
 * token never appears in a result or an error.
 */

export interface PushRequest {
  readonly deviceToken: string;
  readonly payload: unknown;
  readonly pushType: 'alert' | 'background' | 'liveactivity';
  /** Overrides the topic (live activities use `<bundle>.push-type.liveactivity`). */
  readonly topic?: string;
  readonly priority?: 5 | 10;
}

export interface PushResult {
  readonly accepted: boolean;
  readonly status: number;
  /** Apple's `reason` on a refusal, e.g. `BadDeviceToken`. */
  readonly reason?: string;
  readonly apnsId?: string;
}

export interface ApnsClientOptions {
  readonly transport: ApnsTransport;
  readonly tokens: Pick<ProviderTokenCache, 'get'>;
  readonly host: string;
  readonly bundleId: string;
}

export class ApnsClient {
  constructor(private readonly options: ApnsClientOptions) {}

  async send(push: PushRequest): Promise<PushResult> {
    const token = await this.options.tokens.get();
    const response = await this.options.transport.send({
      authority: `https://${this.options.host}`,
      deviceToken: push.deviceToken,
      headers: {
        authorization: `bearer ${token}`,
        'apns-topic': push.topic ?? this.options.bundleId,
        'apns-push-type': push.pushType,
        'apns-priority': String(push.priority ?? 10),
        'content-type': 'application/json',
      },
      body: JSON.stringify(push.payload),
    });
    const reason = parseReason(response.body);
    return {
      accepted: response.status === 200,
      status: response.status,
      ...(reason ? { reason } : {}),
      ...(response.apnsId ? { apnsId: response.apnsId } : {}),
    };
  }
}

function parseReason(body: string): string | undefined {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === 'string' && /^[A-Za-z]{1,64}$/.test(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}
