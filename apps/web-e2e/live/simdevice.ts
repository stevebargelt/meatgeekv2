import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { redact } from './helpers';

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
  /** stderr's first line, with the connection string redacted. */
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
 * Start simdevice as the web device. The connection string goes to it only
 * through its own environment ($SIMDEVICE_CONNECTION_STRING), never on the
 * command line, and nothing it writes is echoed; stderr's first line is kept,
 * redacted, for a failure message.
 */
export function startSimDevice(
  bin: string,
  connectionString: string,
  args: readonly string[]
): SimDeviceRun {
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      SIMDEVICE_CONNECTION_STRING: connectionString,
    },
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
      resolveFirst(JSON.parse(text) as SentLine);
    } catch {
      rejectFirst(new Error('simdevice printed a first line that is not JSON'));
    }
  });
  createInterface({ input: child.stderr }).on('line', text => {
    if (!stderrFirstLine) stderrFirstLine = redact(text, [connectionString]).slice(0, 300);
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
