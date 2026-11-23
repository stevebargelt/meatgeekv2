import { claimDevice, cleanupFreshDevice, enrolFreshDevice, FreshDevice } from '../lib/enrolment';
import type { AcceptanceApi, DeviceScriptRun } from '../lib/proof';
import { defineProofs, ProofFailure } from '../lib/proof';

/**
 * HAR-142 (goal HAR-130, DoD 5) — a revoked device is accepted by nothing.
 *
 * A fresh device, `acceptance-revoke-<runId>`, enrolled through DPS (so its
 * state dir holds its hub assignment) and claimed by the owner:
 *
 *   1. `revoke-device.sh --device-id <id>` (HAR-135; the runner adds `--auth-type
 *      login` and the host names) → exit 0, `revoked <id>`: its DPS enrollment
 *      and its IoT Hub identity are disabled;
 *   2. `simdevice --count 1` as the device, with its cached assignment, must
 *      fail: IoT Hub refuses the disabled identity, the device drops the
 *      assignment and registers again, and DPS refuses the disabled
 *      enrollment. It must exit non-zero on its own (not be killed), print no
 *      reading, and its last stderr line (simdevice's own failure line) must
 *      name a refusal;
 *   3. `revoke-device.sh` again → `already revoked <id>`.
 *
 * The always-run last step releases the device (the API still holds the
 * owner's claim: revoking does not touch it) and deletes its DPS enrollment
 * and hub identity. There is no reinstate proof; the device is just deleted.
 */

/** The refused send's limit: the runner kills it this long after it starts.
 *  simdevice's own bounds end it well before (its 30 s send limit, DPS's
 *  answer to the registration); `--timeout` is not one of them, as it bounds
 *  only `--twin`. */
export const REVOKED_SEND_KILL_MS = 120_000;

/** What simdevice's failure line says when a revoked device is refused:
 *  DPS's "refused the enrollment" / "is disabled", or the hub's "not
 *  authorised" when the identity is refused before it registers again. */
const REFUSAL = /refused|disabled|not authori[sz]ed/i;

function expectScriptLine(run: DeviceScriptRun, expected: string): void {
  if (run.exitCode !== 0) {
    throw new ProofFailure(
      (run.killedAfterMs !== undefined
        ? `revoke-device.sh did not exit within its ${run.killedAfterMs} ms limit and was killed`
        : `revoke-device.sh exited ${run.exitCode ?? '(killed)'}, expected 0`) +
        (run.stderrFirstLine ? `: ${run.stderrFirstLine}` : '')
    );
  }
  if (run.resultLine !== expected) {
    throw new ProofFailure(
      `revoke-device.sh printed ${JSON.stringify(run.resultLine)}, not ${JSON.stringify(expected)}`
    );
  }
}

export default defineProofs('device revoke', () => {
  let fresh: FreshDevice | undefined;
  let claimed = false;
  let revoked = false;

  const device = (): FreshDevice => {
    if (!fresh) {
      throw new Error('no device was enrolled by an earlier proof');
    }
    return fresh;
  };

  return [
    {
      name: 'a fresh device acceptance-revoke-<runId> is enrolled through DPS and claimed by the owner (201)',
      async run(api: AcceptanceApi) {
        const enrolled = await enrolFreshDevice(api, 'revoke', d => {
          fresh = d;
        });
        const response = await claimDevice(api, enrolled, {
          name: `Acceptance revoke ${api.runId}`,
          model: 'Acceptance Rig',
          location: 'CI',
        });
        api.expectStatus(response, 201);
        claimed = true;
      },
    },
    {
      name: 'revoke-device.sh revokes it: exit 0, "revoked acceptance-revoke-<runId>"',
      async run(api: AcceptanceApi) {
        const { deviceId } = device();
        const run = await api.runDeviceScript('revoke-device.sh', ['--device-id', deviceId]);
        expectScriptLine(run, `revoked ${deviceId}`);
        revoked = true;
      },
    },
    {
      name: 'simdevice --count 1 as the revoked device is refused by the hub and by DPS: it exits non-zero and sends nothing',
      async run(api: AcceptanceApi) {
        const { deviceId } = device();
        if (!revoked) {
          throw new Error('the device was not revoked by an earlier proof');
        }
        const run = await api.runSimDevice(['--count', '1'], {
          device: device(),
          timeoutMs: REVOKED_SEND_KILL_MS,
        });
        if (run.killedAfterMs !== undefined) {
          throw new ProofFailure(
            `simdevice as the revoked ${deviceId} did not exit within its ${run.killedAfterMs} ms ` +
              'limit and was killed: it should be refused at once'
          );
        }
        if (run.exitCode === 0 || run.messages.length > 0) {
          throw new ProofFailure(
            `simdevice as the revoked ${deviceId} exited ${run.exitCode} and printed ` +
              `${run.messages.length} reading(s): the revoked device was accepted`
          );
        }
        const last = run.stderrLastLine ?? '';
        if (!REFUSAL.test(last)) {
          throw new ProofFailure(
            `simdevice as the revoked ${deviceId} exited ${run.exitCode}, but its last stderr ` +
              `line names no refusal: ${JSON.stringify(last)}`
          );
        }
      },
    },
    {
      name: 'revoke-device.sh again prints "already revoked acceptance-revoke-<runId>"',
      async run(api: AcceptanceApi) {
        const { deviceId } = device();
        const run = await api.runDeviceScript('revoke-device.sh', ['--device-id', deviceId]);
        expectScriptLine(run, `already revoked ${deviceId}`);
      },
    },
    cleanupFreshDevice(
      'always: acceptance-revoke-<runId> is released and its enrollment and hub identity deleted',
      () => ({ device: fresh, claimed })
    ),
  ];
});
