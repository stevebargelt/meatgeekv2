import { ManagedIdentityCredential } from '@azure/identity';

import { ApnsClient } from './apns-client';
import { readApnsConfig } from './apns-config';
import { Http2ApnsTransport } from './apns-transport';
import { KeyVaultSigner } from './key-vault-signer';
import { ProviderTokenCache } from './provider-token';

/**
 * #243, #244 — the production APNs client, built once per warm instance so the
 * provider-token cache lives across invocations (and is shared by the health
 * probe and the target alerts). Throws ApnsConfigError when a setting is
 * missing; nothing is cached then, so the next call reads the settings again.
 */
let sharedClient: ApnsClient | undefined;

export function getSharedApnsClient(): ApnsClient {
  if (!sharedClient) {
    const config = readApnsConfig();
    sharedClient = new ApnsClient({
      transport: new Http2ApnsTransport(),
      tokens: new ProviderTokenCache({
        signer: new KeyVaultSigner({
          vaultUri: config.keyVaultUri,
          keyName: config.keyName,
          credential: new ManagedIdentityCredential(),
        }),
        keyId: config.keyId,
        teamId: config.teamId,
        now: () => Date.now(),
      }),
      host: config.host,
      bundleId: config.bundleId,
    });
  }
  return sharedClient;
}
