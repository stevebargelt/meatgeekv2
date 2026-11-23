import type { ClaimCodeLine, NoClaimYet } from './lib/claim-code';
import {
  claimDevice,
  cleanupFreshDevice,
  enrolFreshDevice,
  FreshDevice,
  freshDeviceId,
  prepareClaim,
  setEnrolmentFs,
} from './lib/enrolment';
import type {
  AcceptanceApi,
  AcceptanceResponse,
  DeviceRef,
  DeviceScript,
  DeviceScriptRun,
  RequestOptions,
  SimDeviceOptions,
  SimDeviceRun,
} from './lib/proof';
import { ProofFailure } from './lib/proof';

/**
 * HAR-140 — ./lib/enrolment against a recording fake AcceptanceApi and a fake
 * filesystem (setEnrolmentFs). Nothing is spawned and nothing waits: each fake
 * call answers at once from the test's script, so the order of the calls is
 * the thing under test. The real runner, the real child processes and a stub
 * API are covered by acceptance-runner.spec.ts.
 */

const RUN_ID = '20261122235959-a1b2c3';
const CODE = '7K3M-9QXR-2HTV';

const ok: SimDeviceRun = {
  exitCode: 0,
  messages: [],
  unparsedLines: 0,
  stderrFirstLine: undefined,
};
const scriptOk = (resultLine: string): DeviceScriptRun => ({
  exitCode: 0,
  resultLine,
  stderrFirstLine: undefined,
});

interface Script {
  simdevice?: (args: readonly string[], device: DeviceRef) => SimDeviceRun;
  claimCode?: (device: DeviceRef) => ClaimCodeLine | NoClaimYet;
  deviceScript?: (script: DeviceScript, args: readonly string[]) => DeviceScriptRun;
  request?: (options: RequestOptions) => { status: number; body?: unknown; charge?: number };
}

/** A fake api that records every call as one line, in order. */
function fakeApi(script: Script = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const name = (device: DeviceRef) => (typeof device === 'string' ? device : device.deviceId);
  const api: AcceptanceApi = {
    runId: RUN_ID,
    simulatedDeviceId: 'meatgeek-dev-simulated-smoker',
    chartDeviceId: 'meatgeek-dev-simulated-smoker-chart',
    contract: { checkHubMessage: () => undefined } as unknown as AcceptanceApi['contract'],
    async runSimDevice(args: readonly string[], options?: SimDeviceOptions) {
      const device = options?.device ?? 'simulated';
      calls.push(`simdevice[${name(device)}] ${args.join(' ')}`);
      return script.simdevice?.(args, device) ?? ok;
    },
    async readClaimCode(device: DeviceRef) {
      calls.push(`claim-code[${name(device)}]`);
      return (
        script.claimCode?.(device) ?? {
          deviceId:
            device === 'simulated'
              ? api.simulatedDeviceId
              : device === 'chart'
                ? (api.chartDeviceId as string)
                : device.deviceId,
          state: 'unclaimed',
          claimCode: CODE,
          expiresAt: '2026-11-23T23:59:59Z',
        }
      );
    },
    async runDeviceScript(which: DeviceScript, args: readonly string[]) {
      calls.push(`${which} ${args.join(' ')}`);
      if (script.deviceScript) return script.deviceScript(which, args);
      const id = args[args.indexOf('--device-id') + 1];
      return scriptOk(which === 'enrol-device.sh' ? `enrolled ${id}` : `deleted ${id}`);
    },
    metric: () => undefined,
    async request<T>(options: RequestOptions): Promise<AcceptanceResponse<T>> {
      calls.push(`${options.method} ${options.path}${options.as === 'peer' ? ' (peer)' : ''}`);
      bodies.push(options.body);
      const answer = script.request?.(options) ?? defaultAnswer(options);
      return {
        method: options.method,
        route: options.route ?? options.path,
        as: options.as ?? 'owner',
        status: answer.status,
        latencyMs: 1,
        requestCharge: answer.charge ?? 2.5,
        headers: new Headers(),
        body: answer.body as T,
      };
    },
    expectStatus(response, expected) {
      if (response.status !== expected) {
        throw new ProofFailure(`expected ${expected}, got ${response.status}`, response);
      }
    },
    check(response, condition, message): asserts condition {
      if (!condition) throw new ProofFailure(message, response);
    },
  };
  return { api, calls, bodies };
}

function defaultAnswer(options: RequestOptions): {
  status: number;
  body?: unknown;
  charge?: number;
} {
  if (options.method === 'POST' && options.path === '/devices/claim') {
    const body = options.body as { deviceId: string };
    return { status: 201, body: { id: body.deviceId } };
  }
  if (options.method === 'DELETE') return { status: 204 };
  if (options.method === 'GET' && options.path.startsWith('/cooks')) {
    return { status: 200, body: { cooks: [], hasMore: false } };
  }
  return { status: 404 };
}

/** The fake filesystem: one temp dir per call, and every remove recorded. */
let made: string[];
let removed: string[];
let restoreFs: () => void;

beforeEach(() => {
  made = [];
  removed = [];
  restoreFs = setEnrolmentFs({
    makeTempDir: prefix => {
      const dir = `/fake-tmp/${prefix}${made.length}`;
      made.push(dir);
      return dir;
    },
    remove: path => {
      removed.push(path);
    },
  });
});

afterEach(() => restoreFs());

const DEVICE_ID = `acceptance-temp-${RUN_ID}`;
const DIR = `/fake-tmp/${DEVICE_ID}-0`;
const STATE = `${DIR}/state`;
const fresh: FreshDevice = { deviceId: DEVICE_ID, dir: DIR, stateDir: STATE };

describe('freshDeviceId', () => {
  it('is acceptance-<label>-<runId>, a valid device id', () => {
    expect(freshDeviceId({ runId: RUN_ID }, 'temp')).toBe(DEVICE_ID);
  });

  it('refuses a label that makes an invalid device id', () => {
    expect(() => freshDeviceId({ runId: RUN_ID }, 'has space')).toThrow('is not a valid device id');
  });
});

describe('enrolFreshDevice', () => {
  it('makes a state dir, then identity init, enrol-device.sh and a DPS registration, in that order', async () => {
    const { api, calls } = fakeApi();
    const tracked: FreshDevice[] = [];
    const device = await enrolFreshDevice(api, 'temp', d => tracked.push(d));

    expect(device).toEqual(fresh);
    expect(made).toEqual([DIR]);
    expect(tracked).toEqual([fresh]);
    expect(calls).toEqual([
      `simdevice[${DEVICE_ID}] identity init --device-id ${DEVICE_ID} --state-dir ${STATE}`,
      `enrol-device.sh --device-id ${DEVICE_ID} --certificate ${STATE}/device.crt`,
      `simdevice[${DEVICE_ID}] --twin --count 0 --timeout 2m`,
    ]);
  });

  it('hands the device to track before the first step that can fail', async () => {
    const { api, calls } = fakeApi({
      simdevice: () => ({ ...ok, exitCode: 1, stderrFirstLine: 'identity: cannot write key' }),
    });
    const tracked: FreshDevice[] = [];
    await expect(enrolFreshDevice(api, 'temp', d => tracked.push(d))).rejects.toThrow(
      `simdevice identity init for ${DEVICE_ID} exited 1, expected 0: identity: cannot write key`
    );
    expect(tracked).toEqual([fresh]);
    expect(calls).toHaveLength(1);
  });

  it('fails, and registers nothing, when enrol-device.sh fails', async () => {
    const { api, calls } = fakeApi({
      deviceScript: () => ({ exitCode: 1, resultLine: undefined, stderrFirstLine: 'az failed' }),
    });
    await expect(enrolFreshDevice(api, 'temp', () => undefined)).rejects.toThrow(
      `enrol-device.sh for ${DEVICE_ID} exited 1, expected 0: az failed`
    );
    expect(calls.filter(c => c.includes('--twin'))).toEqual([]);
  });

  it('fails when the enrollment already existed (a fresh id must be new)', async () => {
    const { api } = fakeApi({ deviceScript: () => scriptOk(`unchanged ${DEVICE_ID}`) });
    await expect(enrolFreshDevice(api, 'temp', () => undefined)).rejects.toThrow(
      `not "enrolled ${DEVICE_ID}"`
    );
  });

  it('names the time limit when the DPS registration is killed', async () => {
    const { api } = fakeApi({
      simdevice: args =>
        args[0] === '--twin' ? { ...ok, exitCode: null, killedAfterMs: 150_000 } : ok,
    });
    await expect(enrolFreshDevice(api, 'temp', () => undefined)).rejects.toThrow(
      'did not exit within its 150000 ms limit and was killed'
    );
  });
});

describe('prepareClaim', () => {
  it('syncs the twin before it reads the claim code', async () => {
    const { api, calls } = fakeApi();
    await expect(prepareClaim(api, fresh)).resolves.toBe(CODE);
    expect(calls).toEqual([
      `simdevice[${DEVICE_ID}] --twin --count 0 --timeout 2m`,
      `claim-code[${DEVICE_ID}]`,
    ]);
  });

  it('works for a standing device too', async () => {
    const { api, calls } = fakeApi();
    await prepareClaim(api, 'chart');
    expect(calls).toEqual(['simdevice[chart] --twin --count 0 --timeout 2m', 'claim-code[chart]']);
  });

  it.each(['claimed', 'expired'] as const)(
    'fails when the code is %s, without quoting the line',
    async state => {
      const { api } = fakeApi({ claimCode: () => ({ deviceId: DEVICE_ID, state }) });
      const error = (await prepareClaim(api, fresh).catch(e => e)) as Error;
      expect(error).toBeInstanceOf(ProofFailure);
      expect(error.message).toBe(
        `${DEVICE_ID}'s claim code is ${state}, not unclaimed: it cannot be claimed with it`
      );
    }
  );

  it('fails when the device has minted no code', async () => {
    const { api } = fakeApi({ claimCode: () => ({ state: 'no-claim-yet' }) });
    await expect(prepareClaim(api, fresh)).rejects.toThrow('has not minted a claim code');
  });

  it('fails when claim-code read another device', async () => {
    const { api } = fakeApi({
      claimCode: () => ({ deviceId: 'someone-else', state: 'unclaimed', claimCode: CODE }),
    });
    await expect(prepareClaim(api, fresh)).rejects.toThrow('read device someone-else');
  });

  it('does not read the code when the twin sync fails', async () => {
    const { api, calls } = fakeApi({ simdevice: () => ({ ...ok, exitCode: 1 }) });
    await expect(prepareClaim(api, fresh)).rejects.toThrow('exited 1');
    expect(calls.some(c => c.startsWith('claim-code'))).toBe(false);
  });
});

describe('claimDevice', () => {
  it('posts the code the device just showed, after the twin sync and the read', async () => {
    const { api, calls, bodies } = fakeApi();
    const response = await claimDevice(api, fresh, { name: 'Acceptance', model: 'Rig' });
    expect(response.status).toBe(201);
    expect(calls).toEqual([
      `simdevice[${DEVICE_ID}] --twin --count 0 --timeout 2m`,
      `claim-code[${DEVICE_ID}]`,
      'POST /devices/claim',
    ]);
    expect(bodies[0]).toEqual({
      name: 'Acceptance',
      model: 'Rig',
      deviceId: DEVICE_ID,
      claimCode: CODE,
    });
  });

  it('accepts 200, the same caller claiming again', async () => {
    const { api } = fakeApi({
      request: o => ({ status: 200, body: { id: (o.body as { deviceId: string }).deviceId } }),
    });
    await expect(claimDevice(api, fresh, { name: 'Acceptance' })).resolves.toMatchObject({
      status: 200,
    });
  });

  it('fails on a refusal with its error code and never the claim code', async () => {
    const { api } = fakeApi({
      request: () => ({
        status: 403,
        body: { error: 'CLAIM_REFUSED', message: `no ${CODE}` },
        charge: undefined,
      }),
    });
    const error = (await claimDevice(api, fresh, { name: 'Acceptance' }).catch(e => e)) as Error;
    expect(error.message).toBe('expected 201 or 200, got 403 (CLAIM_REFUSED)');
    expect(error.message).not.toContain(CODE);
  });

  it('fails when a 201 has no request charge', async () => {
    const { api } = fakeApi();
    const real = api.request.bind(api);
    api.request = async <T>(o: RequestOptions) => ({
      ...(await real<T>(o)),
      requestCharge: undefined,
    });
    await expect(claimDevice(api, fresh, { name: 'Acceptance' })).rejects.toThrow(
      'missing x-meatgeek-request-charge header'
    );
  });
});

describe('cleanupFreshDevice', () => {
  const steps = (claimed: boolean, released = false) =>
    cleanupFreshDevice('always: cleanup', () => ({ device: fresh, claimed, released }));

  it('is an always step', () => {
    expect(steps(true).always).toBe(true);
  });

  it('releases, then deletes the enrollment and hub identity, then removes the state dir', async () => {
    const { api, calls } = fakeApi();
    await steps(true).run(api);
    expect(calls).toEqual([
      `DELETE /devices/${DEVICE_ID}`,
      `delete-device.sh --device-id ${DEVICE_ID} --only-prefix acceptance-`,
    ]);
    expect(removed).toEqual([DIR]);
  });

  it('stops any active cook first when asked', async () => {
    const { api, calls } = fakeApi();
    await cleanupFreshDevice('c', () => ({ device: fresh, claimed: true }), {
      stopCooksFirst: true,
    }).run(api);
    expect(calls[0]).toBe(`GET /cooks?deviceId=${DEVICE_ID}&status=active`);
    expect(calls[1]).toBe(`DELETE /devices/${DEVICE_ID}`);
  });

  it('does nothing when no device was made', async () => {
    const { api, calls } = fakeApi();
    await cleanupFreshDevice('c', () => ({ device: undefined, claimed: false })).run(api);
    expect(calls).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('skips the release an earlier step already did', async () => {
    const { api, calls } = fakeApi();
    await steps(true, true).run(api);
    expect(calls).toEqual([`delete-device.sh --device-id ${DEVICE_ID} --only-prefix acceptance-`]);
    expect(removed).toEqual([DIR]);
  });

  it('accepts 404 for a claim that was never confirmed', async () => {
    const { api } = fakeApi({ request: () => ({ status: 404 }) });
    await expect(steps(false).run(api)).resolves.toBeUndefined();
  });

  it('refuses 404 for a confirmed claim, but still deletes the rest', async () => {
    const { api, calls } = fakeApi({ request: () => ({ status: 404 }) });
    await expect(steps(true).run(api)).rejects.toThrow('expected 204, got 404');
    expect(calls[1]).toBe(`delete-device.sh --device-id ${DEVICE_ID} --only-prefix acceptance-`);
    expect(removed).toEqual([DIR]);
  });

  it('runs after a failed enrolment and cleans up what it left', async () => {
    // identity init fails, so enrolFreshDevice throws after tracking the device.
    const { api, calls } = fakeApi({ simdevice: () => ({ ...ok, exitCode: 1 }) });
    let device: FreshDevice | undefined;
    await expect(enrolFreshDevice(api, 'temp', d => (device = d))).rejects.toThrow();
    calls.length = 0;
    await cleanupFreshDevice('c', () => ({ device, claimed: false })).run(api);
    expect(calls).toEqual([
      `DELETE /devices/${DEVICE_ID}`,
      `delete-device.sh --device-id ${DEVICE_ID} --only-prefix acceptance-`,
    ]);
    expect(removed).toEqual([DIR]);
  });

  it('reports a failed delete-device.sh after removing the state dir', async () => {
    const { api } = fakeApi({
      deviceScript: () => ({ exitCode: 4, resultLine: undefined, stderrFirstLine: 'refusing' }),
    });
    await expect(steps(true).run(api)).rejects.toThrow(
      `delete-device.sh for ${DEVICE_ID} exited 4, expected 0: refusing`
    );
    expect(removed).toEqual([DIR]);
  });
});
