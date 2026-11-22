import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  ClaimCodeError,
  claimCodeResult,
  redact,
  simDeviceEnv,
  type ClaimCodeLine,
  type NoClaimYet,
  type SimDeviceCredential,
} from './helpers';

/** One stdout line of simdevice: a reading IoT Hub accepted. */
export interface SentLine {
  readonly deviceId: string;
  /** The payload's timestamp, stamped just before the send. */
  readonly timestamp: string;
  readonly sentAt: string;
}

export interface SimDeviceExit {
  readonly code: number | null;
  readonly lines: number;
  /** stderr's first line, with the connection string and any claim code
   *  redacted. */
  readonly stderrFirstLine: string;
}

export interface SimDeviceRun {
  /** Resolves with the first reading sent; rejects if simdevice exits first. */
  readonly first: Promise<SentLine>;
  readonly exit: Promise<SimDeviceExit>;
  /** Stops a run that is still going (SIGKILL). */
  kill(): void;
}

/**
 * Start simdevice as the web device. The credential goes to it only through
 * its own environment ({@link simDeviceEnv}: $SIMDEVICE_CONNECTION_STRING, or
 * in DPS mode the MEATGEEK_* variables), never on the command line, and
 * nothing it writes is echoed; stderr's first line is kept, redacted, for a
 * failure message. Of the first stdout line only the reading's three fields
 * are kept.
 */
export function startSimDevice(
  bin: string,
  credential: SimDeviceCredential,
  args: readonly string[]
): SimDeviceRun {
  const secrets = credential.mode === 'connection-string' ? [credential.connectionString] : [];
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: simDeviceEnv(credential, process.env),
  });

  let lines = 0;
  let stderrFirstLine = '';
  let resolveFirst: (line: SentLine) => void = () => undefined;
  let rejectFirst: (error: Error) => void = () => undefined;
  const first = new Promise<SentLine>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  // Nobody may await `first` (a step that failed earlier): never unhandled.
  first.catch(() => undefined);

  createInterface({ input: child.stdout }).on('line', text => {
    lines += 1;
    if (lines !== 1) return;
    try {
      const sent = JSON.parse(text) as Partial<Record<keyof SentLine, unknown>> | null;
      resolveFirst({
        deviceId: String(sent?.deviceId ?? ''),
        timestamp: String(sent?.timestamp ?? ''),
        sentAt: String(sent?.sentAt ?? ''),
      });
    } catch {
      rejectFirst(new Error('simdevice printed a first line that is not JSON'));
    }
  });
  createInterface({ input: child.stderr }).on('line', text => {
    if (!stderrFirstLine) stderrFirstLine = redact(text, secrets).slice(0, 300);
  });

  const exit = new Promise<SimDeviceExit>(resolve => {
    child.on('error', error => {
      stderrFirstLine ||= `could not start ${bin}: ${error.message}`;
      resolve({ code: null, lines, stderrFirstLine });
    });
    child.on('close', code => resolve({ code, lines, stderrFirstLine }));
  });
  void exit.then(result =>
    rejectFirst(
      new Error(
        `simdevice exited ${result.code ?? '(killed)'} before sending a reading` +
          (result.stderrFirstLine ? `: ${result.stderrFirstLine}` : '')
      )
    )
  );

  return {
    first,
    exit,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

/**
 * HAR-138: run `<bin> claim-code --state-dir <stateDir>` and return the
 * device's claim code line, or {@link NoClaimYet} on exit 3. Any other failure
 * throws a {@link ClaimCodeError} with the exit code and stderr, never stdout
 * (see claimCodeResult). The child gets only PATH and HOME: it reads one file.
 * The claim code is a secret until used; never log it.
 */
export function readClaimCode(bin: string, stateDir: string): Promise<ClaimCodeLine | NoClaimYet> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['claim-code', '--state-dir', stateDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new ClaimCodeError(
          `simdevice claim-code could not be started${code ? ` (${code})` : ''}`,
          null,
          ''
        )
      );
    });
    child.on('close', code => {
      try {
        resolve(
          claimCodeResult(
            code,
            Buffer.concat(stdout).toString('utf8'),
            Buffer.concat(stderr).toString('utf8')
          )
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}
