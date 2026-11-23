/**
 * HAR-138 (goal HAR-130) — how the runner hands `simdevice` a device. HAR-146:
 * DPS mode is the only mode. A device is its own X.509 identity in a state dir
 * that `simdevice identity init` created and the device's certificate is
 * enrolled for. The child gets `MEATGEEK_DPS_ID_SCOPE`, `MEATGEEK_DEVICE_ID`,
 * `MEATGEEK_STATE_DIR` and, when given, `MEATGEEK_DPS_ENDPOINT`.
 *
 * {@link deviceCredential} reads one device's inputs; {@link simDeviceEnv} is
 * the one place a child's environment is built. Error messages name
 * variables, never their values.
 */

/** The DPS ID scope every device uses. */
export const DPS_ID_SCOPE_ENV = 'ACCEPTANCE_DPS_ID_SCOPE';
/** Optional; simdevice defaults to `global.azure-devices-provisioning.net`. */
export const DPS_ENDPOINT_ENV = 'ACCEPTANCE_DPS_ENDPOINT';

/** HAR-140: the DPS service host (`<dps>.azure-devices-provisioning.net`) and
 *  the IoT hub host the device scripts name the services by. CI's identity
 *  holds data-plane roles only, so the scripts cannot look either up in ARM. */
export const DPS_HOST_ENV = 'ACCEPTANCE_DPS_HOST';
export const IOT_HUB_HOST_ENV = 'ACCEPTANCE_IOT_HUB_HOST';

/** The four variables simdevice reads. */
export const MEATGEEK_DPS_ENV = [
  'MEATGEEK_DPS_ID_SCOPE',
  'MEATGEEK_DPS_ENDPOINT',
  'MEATGEEK_DEVICE_ID',
  'MEATGEEK_STATE_DIR',
] as const;

/** A device simdevice runs as: its DPS identity. */
export interface DeviceCredential {
  readonly idScope: string;
  readonly endpoint: string | undefined;
  readonly deviceId: string;
  readonly stateDir: string;
}

/** The runner inputs that name one device. */
export interface DeviceInputs {
  /** How a message names it, e.g. `the simulated device`. */
  readonly device: string;
  readonly idVariable: string;
  readonly stateDirVariable: string;
}

export const SIM_DEVICE_INPUTS: DeviceInputs = {
  device: 'the simulated device',
  idVariable: 'ACCEPTANCE_SIM_DEVICE_ID',
  stateDirVariable: 'ACCEPTANCE_SIM_STATE_DIR',
};

export const CHART_DEVICE_INPUTS: DeviceInputs = {
  device: 'the chart device',
  idVariable: 'ACCEPTANCE_CHART_DEVICE_ID',
  stateDirVariable: 'ACCEPTANCE_CHART_STATE_DIR',
};

type Env = Readonly<Record<string, string | undefined>>;

const valueOf = (env: Env, name: string): string => env[name]?.trim() ?? '';

/**
 * The credential of `inputs`' device, or undefined when its state dir is not
 * set. The ID scope, device id and state dir are read but not checked here;
 * the caller's required-input rules cover them.
 */
export function deviceCredential(env: Env, inputs: DeviceInputs): DeviceCredential | undefined {
  const stateDir = valueOf(env, inputs.stateDirVariable);
  if (stateDir === '') return undefined;
  const endpoint = valueOf(env, DPS_ENDPOINT_ENV);
  return {
    idScope: valueOf(env, DPS_ID_SCOPE_ENV),
    endpoint: endpoint === '' ? undefined : endpoint,
    deviceId: valueOf(env, inputs.idVariable),
    stateDir,
  };
}

/**
 * The environment a simdevice child runs with: `base` (already stripped of
 * what no child may inherit), without any SIMDEVICE_* or MEATGEEK_* variable
 * of its own, plus the one device's DPS variables.
 */
export function simDeviceEnv(
  base: Readonly<NodeJS.ProcessEnv>,
  credential: DeviceCredential
): NodeJS.ProcessEnv {
  const env = withoutDeviceInputs(base);
  env['MEATGEEK_DPS_ID_SCOPE'] = credential.idScope;
  env['MEATGEEK_DEVICE_ID'] = credential.deviceId;
  env['MEATGEEK_STATE_DIR'] = credential.stateDir;
  if (credential.endpoint !== undefined) env['MEATGEEK_DPS_ENDPOINT'] = credential.endpoint;
  return env;
}

/** A copy of `base` without any SIMDEVICE_* variable or the MEATGEEK_* DPS
 *  variables: no child inherits a device input it was not handed. */
export function withoutDeviceInputs(base: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of Object.keys(env)) {
    if (name.startsWith('SIMDEVICE_')) delete env[name];
  }
  for (const name of MEATGEEK_DPS_ENV) delete env[name];
  return env;
}
