import type { InvocationContext } from '@azure/functions';

import { ApnsClient, type PushRequest, type PushResult } from '../../shared/apns/apns-client';
import { ApnsConfigError } from '../../shared/apns/apns-config';
import { KeyVaultSignError } from '../../shared/apns/key-vault-signer';
import { apnsHealthHandler, checkApnsHealth, MADE_UP_DEVICE_TOKEN } from './apns-health';

function clientAnswering(result: PushResult | Error) {
  const sent: PushRequest[] = [];
  const client = {
    async send(push: PushRequest) {
      sent.push(push);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as ApnsClient;
  return { sent, factory: () => client };
}

const clock = () => 1000;

describe('checkApnsHealth', () => {
  it('is healthy when Apple answers BadDeviceToken for the made-up token', async () => {
    const { sent, factory } = clientAnswering({
      accepted: false,
      status: 400,
      reason: 'BadDeviceToken',
    });
    expect(await checkApnsHealth(factory, clock)).toEqual({ status: 'healthy', responseTime: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].deviceToken).toBe(MADE_UP_DEVICE_TOKEN);
    expect(sent[0].deviceToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is unhealthy, with Apple’s reason, when Apple refuses the provider token', async () => {
    const { factory } = clientAnswering({ accepted: false, status: 403, reason: 'InvalidProviderToken' });
    expect(await checkApnsHealth(factory, clock)).toEqual({
      status: 'unhealthy',
      responseTime: 0,
      error: 'apns_rejected',
      reason: 'InvalidProviderToken',
      probeStatusCode: 403,
    });
  });

  it('names a missing setting', async () => {
    const { factory } = clientAnswering(new ApnsConfigError('APNS_TEAM_ID_missing'));
    expect(await checkApnsHealth(factory, clock)).toMatchObject({
      status: 'unhealthy',
      error: 'APNS_TEAM_ID_missing',
    });
  });

  it('reports the Key Vault step and status when signing fails', async () => {
    const { factory } = clientAnswering(new KeyVaultSignError('key_vault_sign_failed', 403));
    expect(await checkApnsHealth(factory, clock)).toMatchObject({
      error: 'key_vault_sign_failed',
      probeStatusCode: 403,
    });
  });

  it('reports an unreachable Apple without the error text', async () => {
    const { factory } = clientAnswering(new Error('ECONNRESET secret.host'));
    const result = await checkApnsHealth(factory, clock);
    expect(result).toMatchObject({ error: 'apns_unreachable' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('apnsHealthHandler', () => {
  const context = (): InvocationContext & { errors: string[] } => {
    const errors: string[] = [];
    return {
      invocationId: 'inv-1',
      log: () => undefined,
      error: (message: string) => errors.push(message),
      errors,
    } as unknown as InvocationContext & { errors: string[] };
  };

  it('answers 200 with the request id when healthy', async () => {
    const { factory } = clientAnswering({ accepted: false, status: 400, reason: 'BadDeviceToken' });
    const response = await apnsHealthHandler({} as never, context(), factory);
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ 'X-Request-ID': 'inv-1' });
    expect(response.jsonBody).toMatchObject({ status: 'healthy', requestId: 'inv-1' });
  });

  it('answers 503 and logs only fixed codes when unhealthy', async () => {
    const { factory } = clientAnswering({ accepted: false, status: 403, reason: 'ExpiredProviderToken' });
    const ctx = context();
    const response = await apnsHealthHandler({} as never, ctx, factory);
    expect(response.status).toBe(503);
    expect(ctx.errors).toEqual([
      'APNs health check failed: apns_rejected (ExpiredProviderToken) (status 403)',
    ]);
  });
});
