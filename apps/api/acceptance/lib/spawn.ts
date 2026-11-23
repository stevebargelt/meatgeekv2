import { ChildProcessByStdio, spawn as nodeSpawn } from 'child_process';
import type { Readable } from 'stream';

/**
 * HAR-140 — the one way the live suite starts a child process: simdevice, its
 * `claim-code` read, and the device scripts.
 *
 * Live, it is `child_process.spawn`. The self-test installs its own with
 * {@link setSpawn}. Each fresh device is enrolled, registered, read and
 * deleted by about six processes per run, and the self-test runs the whole
 * suite well over a hundred times, so it answers those in-process (it checks
 * the same arguments and environment). Its tests of the hand-over itself still
 * start real ones.
 */
export type ChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export type Spawn = (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;

/** stdio is piped, never inherited: nothing the child prints reaches the log raw. */
export const realSpawn: Spawn = (bin, args, env) =>
  nodeSpawn(bin, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });

let current: Spawn = realSpawn;

/** Start `bin` with `args` and exactly `env`, stdout and stderr piped. */
export function spawnProcess(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): ChildProcess {
  return current(bin, args, env);
}

/** Install `next`; returns a function restoring the previous one. */
export function setSpawn(next: Spawn): () => void {
  const previous = current;
  current = next;
  return () => {
    current = previous;
  };
}
