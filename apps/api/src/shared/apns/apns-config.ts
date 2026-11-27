/**
 * #243 (spec #237, "Sending to Apple") — the APNs settings the Function App
 * reads. Every one is non-secret and published by Terraform; the signing key
 * itself never reaches the app, only Key Vault's answer to "sign this".
 */

export const APNS_SETTINGS = [
  'APNS_KEY_VAULT_URI',
  'APNS_KEY_NAME',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_BUNDLE_ID',
  'APNS_HOST',
] as const;

export type ApnsSetting = (typeof APNS_SETTINGS)[number];

export interface ApnsConfig {
  readonly keyVaultUri: string;
  readonly keyName: string;
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  readonly host: string;
}

/** The code names the missing setting, never a value. */
export class ApnsConfigError extends Error {
  constructor(readonly code: `${ApnsSetting}_missing`) {
    super(code);
    this.name = 'ApnsConfigError';
  }
}

/** Reads the six settings; throws {@link ApnsConfigError} for the first that is absent. */
export function readApnsConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): ApnsConfig {
  const read = (name: ApnsSetting): string => {
    const value = env[name]?.trim();
    if (!value) {
      throw new ApnsConfigError(`${name}_missing`);
    }
    return value;
  };
  return {
    keyVaultUri: read('APNS_KEY_VAULT_URI'),
    keyName: read('APNS_KEY_NAME'),
    keyId: read('APNS_KEY_ID'),
    teamId: read('APNS_TEAM_ID'),
    bundleId: read('APNS_BUNDLE_ID'),
    host: read('APNS_HOST'),
  };
}
