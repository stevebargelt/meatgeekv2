import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { ClaimDeviceRequest, Device } from '@meatgeekv2/api-interfaces';

import { deleteDevice, stopActiveCooks } from './devices';
import type {
  AcceptanceApi,
  AcceptanceResponse,
  Caller,
  DeviceRef,
  DeviceScriptRun,
  FreshDeviceRef,
  Proof,
  SimDeviceRun,
} from './proof';
import { ProofFailure } from './proof';

/**
 * HAR-140 (goal HAR-130) — the suite's devices take the path a real device
 * takes: enrol a certificate in DPS, register, mint a claim code, and be
 * claimed with that code (`POST /devices/claim`). Nothing calls `POST
 * /devices`.
 *
 * A proof that needs a device of its own gets a freshly enrolled one
 * ({@link enrolFreshDevice}), `acceptance-<label>-<runId>`, with a key made in
 * a new state dir. Its always-run last step ({@link cleanupFreshDevice})
 * releases it, deletes its DPS enrollment and hub identity with
 * `delete-device.sh --only-prefix acceptance-`, and removes the state dir.
 *
 * The claim code is a secret until it is used. It goes from `simdevice
 * claim-code` straight into the claim's request body. The runner logs neither
 * that line nor any request body, and no message here quotes either. The
 * state dir holds the device's private key: only its path is ever passed on.
 *
 * Two of the steps are real-time waits, each bounded by simdevice's own
 * `--timeout 2m` and the runner's kill just after it (live-acceptance.md,
 * "Real-time waits"): the DPS registration in {@link enrolFreshDevice}, and
 * the twin sync in {@link prepareClaim}.
 */

/** The prefix of every fresh device id, and delete-device.sh's `--only-prefix`. */
export const FRESH_DEVICE_PREFIX = 'acceptance-';

/** The device id rule (apps/api's DEVICE_ID_PATTERN, the same as the device's own). */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** simdevice's own limit on registering and syncing its twin. */
export const TWIN_SYNC_TIMEOUT = '2m';

/** The runner kills the twin sync this long after it starts: simdevice's own
 *  2 min, plus 30 s for it to give up and exit. */
export const TWIN_SYNC_KILL_MS = 150_000;

/**
 * Where `simdevice identity init` writes the device's certificate, relative to
 * its state dir: `<state dir>/identity/device.crt`. These are the data-pusher's
 * `identity.DirName` and `identity.CertFile`
 * (apps/data-pusher/internal/identity/identity.go); enrolment.spec.ts reads
 * that file and fails if they drift apart.
 */
export const IDENTITY_DIR = 'identity';
export const CERT_FILE = 'device.crt';

/** The certificate path of the device whose state dir is `stateDir`. */
export function certificatePath(stateDir: string): string {
  return join(stateDir, IDENTITY_DIR, CERT_FILE);
}

/** A device enrolled by {@link enrolFreshDevice}. `dir` is the temporary
 *  directory holding `stateDir`; cleanup removes it. */
export interface FreshDevice extends FreshDeviceRef {
  readonly dir: string;
}

/** The filesystem calls this file makes, so its self-test can watch them. */
export interface EnrolmentFs {
  /** Make a new empty directory whose name starts with `prefix`. */
  makeTempDir(prefix: string): string;
  remove(path: string): void;
}

const realFs: EnrolmentFs = {
  makeTempDir: prefix => mkdtempSync(join(process.env['RUNNER_TEMP']?.trim() || tmpdir(), prefix)),
  remove: path => rmSync(path, { recursive: true, force: true }),
};

let fs: EnrolmentFs = realFs;

/** Install a fake filesystem; returns a function restoring the previous one. */
export function setEnrolmentFs(next: EnrolmentFs): () => void {
  const previous = fs;
  fs = next;
  return () => {
    fs = previous;
  };
}

/** `acceptance-<label>-<runId>`, checked against the device id rule. */
export function freshDeviceId(api: Pick<AcceptanceApi, 'runId'>, label: string): string {
  const id = `${FRESH_DEVICE_PREFIX}${label}-${api.runId}`;
  if (!DEVICE_ID_PATTERN.test(id)) {
    throw new Error(`${JSON.stringify(id)} is not a valid device id`);
  }
  return id;
}

/** The id of the device `device` names. */
export function deviceIdOf(api: AcceptanceApi, device: DeviceRef): string {
  if (device === 'simulated') return api.simulatedDeviceId;
  if (device === 'chart') {
    if (api.chartDeviceId === undefined) {
      throw new Error('the chart device is not configured');
    }
    return api.chartDeviceId;
  }
  return device.deviceId;
}

function expectRunExit0(what: string, run: SimDeviceRun): void {
  if (run.exitCode !== 0) {
    throw new ProofFailure(
      (run.killedAfterMs !== undefined
        ? `${what} did not exit within its ${run.killedAfterMs} ms limit and was killed`
        : `${what} exited ${run.exitCode ?? '(killed)'}, expected 0`) +
        (run.stderrFirstLine ? `: ${run.stderrFirstLine}` : '')
    );
  }
}

function expectScriptExit0(what: string, run: DeviceScriptRun): void {
  if (run.exitCode !== 0) {
    throw new ProofFailure(
      (run.killedAfterMs !== undefined
        ? `${what} did not exit within its ${run.killedAfterMs} ms limit and was killed`
        : `${what} exited ${run.exitCode ?? '(killed)'}, expected 0`) +
        (run.stderrFirstLine ? `: ${run.stderrFirstLine}` : '')
    );
  }
}

/** `simdevice --twin --count 0 --timeout 2m`: register (through DPS) and sync
 *  the twin, which mints a claim code when the device needs one, and send no
 *  reading. */
async function syncTwin(api: AcceptanceApi, device: DeviceRef): Promise<void> {
  const run = await api.runSimDevice(['--twin', '--count', '0', '--timeout', TWIN_SYNC_TIMEOUT], {
    device,
    timeoutMs: TWIN_SYNC_KILL_MS,
  });
  expectRunExit0(`simdevice --twin --count 0 for ${deviceIdOf(api, device)}`, run);
}

/**
 * Enrol a fresh device, `acceptance-<label>-<runId>`, the way the owner's Pi
 * is enrolled, in this order:
 *
 *   1. a new state dir under `$RUNNER_TEMP` (`os.tmpdir()` locally);
 *   2. `simdevice identity init`: the device makes its key there and writes
 *      its certificate, `identity/device.crt` ({@link certificatePath});
 *   3. `enrol-device.sh --device-id <id> --certificate <state dir>/identity/device.crt`
 *      (the runner adds `--auth-type login` and the host names);
 *   4. `simdevice --twin --count 0 --timeout 2m`: the device registers with
 *      DPS, which creates its hub identity, and mints its first claim code.
 *
 * `track` is handed the device as soon as its state dir exists, before
 * anything that can fail, so the group's cleanup step can undo a partial
 * enrolment.
 */
export async function enrolFreshDevice(
  api: AcceptanceApi,
  label: string,
  track: (device: FreshDevice) => void
): Promise<FreshDevice> {
  const deviceId = freshDeviceId(api, label);
  const dir = fs.makeTempDir(`${deviceId}-`);
  const device: FreshDevice = { deviceId, dir, stateDir: join(dir, 'state') };
  track(device);

  const init = await api.runSimDevice(
    ['identity', 'init', '--device-id', deviceId, '--state-dir', device.stateDir],
    { device }
  );
  expectRunExit0(`simdevice identity init for ${deviceId}`, init);

  const enrolled = await api.runDeviceScript('enrol-device.sh', [
    '--device-id',
    deviceId,
    '--certificate',
    certificatePath(device.stateDir),
  ]);
  expectScriptExit0(`enrol-device.sh for ${deviceId}`, enrolled);
  if (enrolled.resultLine !== `enrolled ${deviceId}`) {
    throw new ProofFailure(
      `enrol-device.sh printed ${JSON.stringify(enrolled.resultLine)}, not "enrolled ${deviceId}" ` +
        '(a fresh device id must have no enrollment yet)'
    );
  }

  await syncTwin(api, device);
  return device;
}

/**
 * Get `device`'s current claim code: sync its twin first (`simdevice --twin
 * --count 0`), which picks up a release, since a release raises the desired
 * claim generation and the device then mints a new code; then `simdevice
 * claim-code`. Fails unless the code is `unclaimed`.
 */
export async function prepareClaim(api: AcceptanceApi, device: DeviceRef): Promise<string> {
  const deviceId = deviceIdOf(api, device);
  await syncTwin(api, device);
  const line = await api.readClaimCode(device);
  if (line.state === 'no-claim-yet') {
    throw new ProofFailure(
      `${deviceId} has not minted a claim code (simdevice claim-code exit 3 after a twin sync)`
    );
  }
  if (line.deviceId !== deviceId) {
    throw new ProofFailure(`simdevice claim-code read device ${line.deviceId}, not ${deviceId}`);
  }
  if (line.state !== 'unclaimed' || line.claimCode === undefined) {
    throw new ProofFailure(
      `${deviceId}'s claim code is ${line.state}, not unclaimed: it cannot be claimed with it`
    );
  }
  return line.claimCode;
}

/** The claim body apart from the id and the code. */
export type ClaimBody = Omit<ClaimDeviceRequest, 'deviceId' | 'claimCode'>;

/**
 * `POST /devices/claim` for `device` with the code it shows now
 * ({@link prepareClaim}). Expects 201 (claimed) or 200 (the caller already
 * held it: a retry), with a request charge, and a Device with the device's id.
 */
export async function claimDevice(
  api: AcceptanceApi,
  device: DeviceRef,
  body: ClaimBody,
  as: Caller = 'owner'
): Promise<AcceptanceResponse<Device>> {
  const code = await prepareClaim(api, device);
  return postClaim(api, deviceIdOf(api, device), code, body, as);
}

/** `POST /devices/claim` with a code already read: 201 or 200, as above. */
export async function postClaim(
  api: AcceptanceApi,
  deviceId: string,
  claimCode: string,
  body: ClaimBody,
  as: Caller = 'owner'
): Promise<AcceptanceResponse<Device>> {
  const request: ClaimDeviceRequest = { ...body, deviceId, claimCode };
  // A refusal (403 CLAIM_REFUSED) carries no request charge by design, so the
  // charge is checked here, for the answers that must have one.
  const response = await api.request<Device>({
    method: 'POST',
    path: '/devices/claim',
    body: request,
    as,
    expectRequestCharge: false,
  });
  if (response.status !== 201 && response.status !== 200) {
    const code = (response.body as { error?: unknown } | null)?.error;
    throw new ProofFailure(
      `expected 201 or 200, got ${response.status}` +
        (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` (${code})` : ''),
      response
    );
  }
  api.check(
    response,
    response.requestCharge !== undefined,
    'missing x-meatgeek-request-charge header'
  );
  api.check(
    response,
    response.body?.id === deviceId,
    `device.id ${response.body?.id} is not ${deviceId}`
  );
  return response;
}

/**
 * The claim code each standing device was claimed with in a run, by
 * `<runId> <deviceId>`, so the run's later groups can claim it again with the
 * same code. Kept in memory only, never written or logged.
 */
const standingCodes = new Map<string, string>();

/**
 * HAR-140: make a standing device (the simulated or the chart device) the
 * owner's with its own claim code. It is claimed once per run and never
 * released: its history and rollups, which the volume and chart proofs rely on
 * across runs, are bounded by `claimedAt` (HAR-136), and the chart device
 * keeps an active cook, so a release would be `409 COOK_ACTIVE`.
 *
 * - DPS mode (CI). The workflow gives each standing device a fresh state dir
 *   every run, so it shows a new unclaimed code. The run's first claim of the
 *   device runs {@link prepareClaim} and `POST /devices/claim`: `201` when the
 *   owner did not hold it, `200` when the owner did (the stored device, and
 *   its `claimedAt`, unchanged). Each later group claims it again with the
 *   same code, held in memory: `200`, the same caller again. A device whose
 *   code shows `claimed` (a local state dir reused from an earlier run) must
 *   already be the caller's: `GET /devices/{id}` `200`.
 * - Connection-string mode (local runs only). The device has no claim code to
 *   show, so it cannot be claimed here. It must already be the caller's:
 *   `GET /devices/{id}` `200`.
 */
export async function claimStandingDevice(
  api: AcceptanceApi,
  which: 'simulated' | 'chart',
  body: ClaimBody
): Promise<void> {
  const deviceId = deviceIdOf(api, which);
  if (!api.inDpsMode(which)) {
    await expectHeld(
      api,
      deviceId,
      "in connection-string mode a standing device shows no claim code, so it must already be the caller's"
    );
    return;
  }
  const key = `${api.runId} ${deviceId}`;
  const known = standingCodes.get(key);
  if (known !== undefined) {
    const again = await postClaim(api, deviceId, known, body);
    api.expectStatus(again, 200);
    return;
  }
  await syncTwin(api, which);
  const line = await api.readClaimCode(which);
  if (line.state === 'claimed') {
    await expectHeld(
      api,
      deviceId,
      "its state dir shows its code already claimed, so it must be the caller's"
    );
    return;
  }
  if (line.state !== 'unclaimed' || line.claimCode === undefined || line.deviceId !== deviceId) {
    throw new ProofFailure(
      line.state === 'no-claim-yet'
        ? `${deviceId} has not minted a claim code (simdevice claim-code exit 3 after a twin sync)`
        : line.deviceId !== deviceId
          ? `simdevice claim-code read device ${line.deviceId}, not ${deviceId}`
          : `${deviceId}'s claim code is ${line.state}, not unclaimed: it cannot be claimed with it`
    );
  }
  await postClaim(api, deviceId, line.claimCode, body);
  standingCodes.set(key, line.claimCode);
}

/** `GET /devices/{id}` must be `200` with the device: the caller holds it. */
async function expectHeld(api: AcceptanceApi, deviceId: string, why: string): Promise<void> {
  const owned = await api.request<Device>({
    method: 'GET',
    path: `/devices/${encodeURIComponent(deviceId)}`,
    route: '/devices/{id}',
  });
  api.check(
    owned,
    owned.status === 200,
    `${deviceId} is not the caller's (expected 200, got ${owned.status}); ${why}`
  );
  api.check(owned, owned.body?.id === deviceId, `device.id is not ${deviceId}`);
}

/** What a group's cleanup step needs to know about its fresh device. */
export interface FreshDeviceState {
  /** Set once the state dir exists ({@link enrolFreshDevice}'s `track`). */
  readonly device: FreshDevice | undefined;
  /** `POST /devices/claim` answered 201 or 200: the owner holds it. */
  readonly claimed: boolean;
  /** An earlier step released it (`DELETE /devices/{id}` 204). */
  readonly released?: boolean;
}

/**
 * The last step of a group with a fresh device, run even after an earlier step
 * failed (`always`). Each part runs even when the one before it failed, and
 * the first failure is reported once all have run:
 *
 *   1. `DELETE /devices/{id}` as the owner: 204 when the claim was confirmed;
 *      204 or 404 when it was not (it may or may not have happened); skipped
 *      when an earlier step released it. With `stopCooksFirst`, any cook left
 *      active on the device is stopped first, or the release is 409;
 *   2. `delete-device.sh --device-id <id> --only-prefix acceptance-`: its DPS
 *      enrollment and hub identity go (`already deleted` when enrolment never
 *      got that far is fine);
 *   3. the state dir, with the device's key, is removed.
 */
export function cleanupFreshDevice(
  name: string,
  state: () => FreshDeviceState,
  options: { readonly stopCooksFirst?: boolean } = {}
): Proof {
  return {
    name,
    always: true,
    async run(api: AcceptanceApi) {
      const { device, claimed, released } = state();
      if (device === undefined) {
        return;
      }
      const failures: unknown[] = [];
      const attempt = async (step: () => Promise<void>) => {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      };

      if (!released) {
        await attempt(async () => {
          if (options.stopCooksFirst) {
            await stopActiveCooks(api, device.deviceId);
          }
          const response = await deleteDevice(api, device.deviceId);
          if (claimed) {
            api.expectStatus(response, 204);
          } else {
            api.check(
              response,
              response.status === 204 || response.status === 404,
              `expected 204 or 404, got ${response.status}`
            );
          }
        });
      }
      await attempt(async () => {
        const deleted = await api.runDeviceScript('delete-device.sh', [
          '--device-id',
          device.deviceId,
          '--only-prefix',
          FRESH_DEVICE_PREFIX,
        ]);
        expectScriptExit0(`delete-device.sh for ${device.deviceId}`, deleted);
      });
      await attempt(async () => {
        fs.remove(device.dir);
      });

      if (failures.length > 0) {
        throw failures[0];
      }
    },
  };
}
