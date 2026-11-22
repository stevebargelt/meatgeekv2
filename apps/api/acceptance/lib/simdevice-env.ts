/**
 * HAR-138 (goal HAR-130) — how the runner hands `simdevice` a device. Two
 * modes, chosen per device from the runner's inputs:
 *
 * - **connection string** (today's CI): the device's IoT Hub connection string,
 *   as the child's `SIMDEVICE_CONNECTION_STRING`;
 * - **DPS**: the device's own X.509 identity in a state dir that
 *   `simdevice identity init` created and the device's certificate is enrolled
 *   for. The child gets `MEATGEEK_DPS_ID_SCOPE`, `MEATGEEK_DEVICE_ID`,
 *   `MEATGEEK_STATE_DIR` and, when given, `MEATGEEK_DPS_ENDPOINT`, and no
 *   `SIMDEVICE_CONNECTION_STRING` at all (simdevice refuses both).
 *
 * {@link deviceMode} picks the mode; {@link simDeviceEnv} is the one place a
 * child's environment is built, for both. Error messages name variables, never
 * their values.
 */

/** The DPS ID scope every DPS-mode device uses. */
export const DPS_ID_SCOPE_ENV = 'ACCEPTANCE_DPS_ID_SCOPE';
/** Optional; simdevice defaults to `global.azure-devices-provisioning.net`. */
export const DPS_ENDPOINT_ENV = 'ACCEPTANCE_DPS_ENDPOINT';

/** The four variables simdevice reads in DPS mode. */
export const MEATGEEK_DPS_ENV = [
  'MEATGEEK_DPS_ID_SCOPE',
  'MEATGEEK_DPS_ENDPOINT',
  'MEATGEEK_DEVICE_ID',
  'MEATGEEK_STATE_DIR',
] as const;

export type DeviceCredential =
  | { readonly mode: 'connection-string'; readonly connectionString: string }
  | {
      readonly mode: 'dps';
      readonly idScope: string;
      readonly endpoint: string | undefined;
      readonly deviceId: string;
      readonly stateDir: string;
    };

/** The runner inputs that name one device. */
export interface DeviceInputs {
  /** How a message names it, e.g. `the simulated device`. */
  readonly device: string;
  readonly idVariable: string;
  readonly connectionStringVariable: string;
  readonly stateDirVariable: string;
}

export const SIM_DEVICE_INPUTS: DeviceInputs = {
  device: 'the simulated device',
  idVariable: 'ACCEPTANCE_SIM_DEVICE_ID',
  connectionStringVariable: 'SIMDEVICE_CONNECTION_STRING',
  stateDirVariable: 'ACCEPTANCE_SIM_STATE_DIR',
};

export const CHART_DEVICE_INPUTS: DeviceInputs = {
  device: 'the chart device',
  idVariable: 'ACCEPTANCE_CHART_DEVICE_ID',
  connectionStringVariable: 'SIMDEVICE_CHART_CONNECTION_STRING',
  stateDirVariable: 'ACCEPTANCE_CHART_STATE_DIR',
};

export type DeviceMode =
  | { readonly kind: 'configured'; readonly credential: DeviceCredential }
  /** Neither a connection string nor a state dir: whatever the caller did
   *  before DPS mode existed (a missing-input failure, or a proof's own rule). */
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly message: string };

type Env = Readonly<Record<string, string | undefined>>;

const valueOf = (env: Env, name: string): string => env[name]?.trim() ?? '';

/**
 * The mode `inputs`' device runs in:
 * - its state dir and {@link DPS_ID_SCOPE_ENV} set → DPS;
 * - its connection string set, and no state dir → connection string;
 * - both set, or a state dir without the ID scope → an error;
 * - neither → `none`.
 * The device id is read but not checked here; the caller's required-input rule
 * covers it.
 */
export function deviceMode(env: Env, inputs: DeviceInputs): DeviceMode {
  const connectionString = valueOf(env, inputs.connectionStringVariable);
  const stateDir = valueOf(env, inputs.stateDirVariable);
  const idScope = valueOf(env, DPS_ID_SCOPE_ENV);
  if (connectionString !== '' && stateDir !== '') {
    return {
      kind: 'error',
      message:
        `${inputs.connectionStringVariable} and ${inputs.stateDirVariable} are both set; ` +
        `${inputs.device} runs in one mode: set the connection string, or the state dir for DPS mode`,
    };
  }
  if (stateDir !== '') {
    if (idScope === '') {
      return {
        kind: 'error',
        message:
          `${inputs.stateDirVariable} is set but ${DPS_ID_SCOPE_ENV} is not; ` +
          `DPS mode for ${inputs.device} needs both`,
      };
    }
    const endpoint = valueOf(env, DPS_ENDPOINT_ENV);
    return {
      kind: 'configured',
      credential: {
        mode: 'dps',
        idScope,
        endpoint: endpoint === '' ? undefined : endpoint,
        deviceId: valueOf(env, inputs.idVariable),
        stateDir,
      },
    };
  }
  if (connectionString !== '') {
    return { kind: 'configured', credential: { mode: 'connection-string', connectionString } };
  }
  return { kind: 'none' };
}

/**
 * The environment a simdevice child runs with: `base` (already stripped of
 * what no child may inherit), without any device input of its own, plus the
 * one device's credential.
 */
export function simDeviceEnv(
  base: Readonly<NodeJS.ProcessEnv>,
  credential: DeviceCredential
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env['SIMDEVICE_CONNECTION_STRING'];
  for (const name of MEATGEEK_DPS_ENV) delete env[name];
  if (credential.mode === 'connection-string') {
    env['SIMDEVICE_CONNECTION_STRING'] = credential.connectionString;
    return env;
  }
  env['MEATGEEK_DPS_ID_SCOPE'] = credential.idScope;
  env['MEATGEEK_DEVICE_ID'] = credential.deviceId;
  env['MEATGEEK_STATE_DIR'] = credential.stateDir;
  if (credential.endpoint !== undefined) env['MEATGEEK_DPS_ENDPOINT'] = credential.endpoint;
  return env;
}
