import { accessSync, constants } from 'node:fs';
import { LiveEnvError, readLiveEnv } from './helpers';

/**
 * Runs before any browser starts: a missing or bad input fails the run at
 * once, naming the variable (never its value).
 */
export default function globalSetup(): void {
  const env = readLiveEnv(process.env);
  try {
    accessSync(env.simdeviceBin, constants.X_OK);
  } catch {
    throw new LiveEnvError(
      `ACCEPTANCE_SIMDEVICE_BIN (${env.simdeviceBin}) is not an executable file; ` +
        'build it with: make -C apps/data-pusher build'
    );
  }
}
