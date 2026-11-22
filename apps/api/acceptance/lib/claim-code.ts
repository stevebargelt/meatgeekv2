import { spawn } from 'child_process';

import { clock } from './clock';

/**
 * HAR-138 (goal HAR-130) — reading a DPS-mode device's claim code (HAR-134)
 * with `simdevice claim-code --state-dir <dir>`, for the claim proofs that
 * come next.
 *
 * The claim code is a secret until it is used: whoever holds it can claim the
 * device. The runner never logs it (its redactor masks anything shaped like
 * one, {@link maskClaimCodes}), and nothing here puts it, or anything simdevice
 * printed on stdout, in an error message.
 */

/** simdevice's exit code when the device has not minted a claim code yet
 *  (dpsmode.ExitNoClaim). */
export const EXIT_NO_CLAIM = 3;

/** A `claim-code` run longer than this is killed. It only reads a file. */
const CLAIM_CODE_TIMEOUT_MS = 30_000;

/** How much of stderr an error carries. */
const STDERR_LIMIT = 500;

export type ClaimState = 'unclaimed' | 'claimed' | 'expired';

/** The line `simdevice claim-code` prints. `claimCode` and `expiresAt` only
 *  while the code is `unclaimed`. */
export interface ClaimCodeLine {
  readonly deviceId: string;
  readonly state: ClaimState;
  readonly claimCode?: string;
  readonly expiresAt?: string;
}

/** Exit {@link EXIT_NO_CLAIM}: no claim file in the state dir yet. */
export interface NoClaimYet {
  readonly state: 'no-claim-yet';
}

/** A claim-code run that failed. Carries the exit code and stderr (with any
 *  claim code masked); never stdout. */
export class ClaimCodeError extends Error {
  override name = 'ClaimCodeError';
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
  }
}

/** A claim code as simdevice prints it, `XXXX-XXXX-XXXX` in Crockford base32
 *  (no I, L, O or U), not inside a longer dashed or alphanumeric run (so the
 *  middle of a UUID is not one). */
const CLAIM_CODE =
  /(?<![0-9A-Za-z-])[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}(?![0-9A-Za-z-])/g;

/** `text` with everything shaped like a claim code replaced by `[redacted]`. */
export function maskClaimCodes(text: string): string {
  return text.replace(CLAIM_CODE, '[redacted]');
}

const STATES: readonly string[] = ['unclaimed', 'claimed', 'expired'];

/** The claim-code line in `stdout`, or undefined when it is not one. */
function parseLine(stdout: string): ClaimCodeLine | undefined {
  const lines = stdout.split('\n').filter(line => line.trim() !== '');
  if (lines.length !== 1) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    return undefined;
  }
  const line = parsed as Record<string, unknown> | null;
  if (
    !line ||
    typeof line !== 'object' ||
    typeof line['deviceId'] !== 'string' ||
    typeof line['state'] !== 'string' ||
    !STATES.includes(line['state']) ||
    (line['claimCode'] !== undefined && typeof line['claimCode'] !== 'string') ||
    (line['expiresAt'] !== undefined && typeof line['expiresAt'] !== 'string')
  ) {
    return undefined;
  }
  return {
    deviceId: line['deviceId'],
    state: line['state'] as ClaimState,
    ...(line['claimCode'] !== undefined ? { claimCode: line['claimCode'] as string } : {}),
    ...(line['expiresAt'] !== undefined ? { expiresAt: line['expiresAt'] as string } : {}),
  };
}

/**
 * Run `<bin> claim-code --state-dir <stateDir>` and return what it printed.
 * Exit 3 is {@link NoClaimYet}. Any other failure (another exit code, a
 * line that is not a claim-code line, the binary not starting, a run killed
 * after 30 s on the {@link clock}) throws a {@link ClaimCodeError}.
 *
 * The child gets only PATH and HOME: it reads one file, and needs no
 * credential.
 */
export function readClaimCode(bin: string, stateDir: string): Promise<ClaimCodeLine | NoClaimYet> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['claim-code', '--state-dir', stateDir], {
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    let killed = false;
    const cancelKill = clock().after(CLAIM_CODE_TIMEOUT_MS, () => {
      killed = true;
      child.kill('SIGKILL');
    });
    const errorText = () =>
      maskClaimCodes(Buffer.concat(stderr).toString('utf8').trim()).slice(0, STDERR_LIMIT);
    child.on('error', error => {
      cancelKill();
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new ClaimCodeError(
          `simdevice claim-code could not be started${code ? ` (${code})` : ''}`,
          null,
          ''
        )
      );
    });
    child.on('close', exitCode => {
      cancelKill();
      const err = errorText();
      const said = err === '' ? '' : `: ${err}`;
      if (killed && exitCode === null) {
        reject(
          new ClaimCodeError(
            `simdevice claim-code did not finish in ${CLAIM_CODE_TIMEOUT_MS} ms${said}`,
            null,
            err
          )
        );
        return;
      }
      if (exitCode === EXIT_NO_CLAIM) {
        resolve({ state: 'no-claim-yet' });
        return;
      }
      if (exitCode !== 0) {
        reject(
          new ClaimCodeError(
            `simdevice claim-code exited ${exitCode ?? '(killed)'}${said}`,
            exitCode,
            err
          )
        );
        return;
      }
      const line = parseLine(Buffer.concat(stdout).toString('utf8'));
      if (line === undefined) {
        reject(
          new ClaimCodeError(
            'simdevice claim-code exited 0 but did not print one claim-code JSON line ' +
              '(stdout not shown: it can hold the claim code)',
            exitCode,
            err
          )
        );
        return;
      }
      resolve(line);
    });
  });
}
