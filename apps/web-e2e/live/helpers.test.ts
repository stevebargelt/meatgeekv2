import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  ClaimCodeError,
  DEFAULT_WEB_BASE_URL,
  DPS_REQUIRED_VARIABLES,
  LAST_HEARD_TEXT,
  LiveEnvError,
  REQUIRED_VARIABLES,
  checkDeployedSha,
  claimCodeResult,
  distinctiveGrillF,
  grillText,
  isAncestorCommit,
  livePanelConnection,
  livePanelGaveUp,
  msLeftInTotpWindow,
  normalizeTotpSecret,
  parseVersionJson,
  readLiveEnv,
  redact,
  simDeviceEnv,
  totpCode,
  waitForBuild,
  type Git,
  type SimDeviceCredential,
} from './helpers';
import { readClaimCode, startSimDevice } from './simdevice';

const EXPECTED = '1111111111111111111111111111111111111111';
const NEWER = '2222222222222222222222222222222222222222';
const UNRELATED = '3333333333333333333333333333333333333333';

/** RFC 6238 appendix B: the SHA-1 seed is the ASCII "12345678901234567890". */
const RFC6238_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const FULL_ENV: Record<string, string> = {
  EXPECTED_WEB_SHA: EXPECTED,
  ACCEPTANCE_USER_UPN: 'acceptance@example.test',
  ACCEPTANCE_USER_PASSWORD: 'not-a-real-password',
  ACCEPTANCE_USER_TOTP_SECRET: 'jbsw y3dp ehpk 3pxp',
  ACCEPTANCE_WEB_DEVICE_ID: 'meatgeek-dev-simulated-smoker-web',
  SIMDEVICE_WEB_CONNECTION_STRING: 'HostName=h;DeviceId=d;SharedAccessKey=k',
  ACCEPTANCE_SIMDEVICE_BIN: '/opt/simdevice',
};

const without = (...names: string[]) =>
  Object.fromEntries(Object.entries(FULL_ENV).filter(([name]) => !names.includes(name)));

function envError(env: Record<string, string | undefined>): LiveEnvError {
  try {
    readLiveEnv(env);
  } catch (error) {
    if (error instanceof LiveEnvError) return error;
    throw error;
  }
  throw new Error('readLiveEnv accepted the env');
}

describe('readLiveEnv', () => {
  it('reads every input, with the default web origin', () => {
    const env = readLiveEnv(FULL_ENV, new Date('2026-11-20T10:11:12.345Z'));
    expect(env).toEqual({
      webBaseUrl: DEFAULT_WEB_BASE_URL,
      expectedSha: EXPECTED,
      upn: 'acceptance@example.test',
      password: 'not-a-real-password',
      totpSecret: 'jbsw y3dp ehpk 3pxp',
      deviceId: 'meatgeek-dev-simulated-smoker-web',
      simdevice: {
        mode: 'connection-string',
        connectionString: 'HostName=h;DeviceId=d;SharedAccessKey=k',
      },
      simdeviceBin: '/opt/simdevice',
      runId: '20261120T101112Z',
    });
  });

  it('takes WEB_BASE_URL without its trailing slash, and the GitHub run id', () => {
    const env = readLiveEnv({
      ...FULL_ENV,
      WEB_BASE_URL: 'https://preview.example.test/',
      GITHUB_RUN_ID: '987654',
    });
    expect(env.webBaseUrl).toBe('https://preview.example.test');
    expect(env.runId).toBe('987654');
  });

  it.each(REQUIRED_VARIABLES)('names %s when it is missing', name => {
    const error = envError(without(name));
    expect(error.message).toContain(`Set ${name}.`);
    for (const other of REQUIRED_VARIABLES.filter(n => n !== name)) {
      expect(error.message).not.toContain(other);
    }
  });

  it('names every missing variable at once, and treats blank as missing', () => {
    const error = envError({ ...without('ACCEPTANCE_USER_UPN'), ACCEPTANCE_USER_PASSWORD: '  ' });
    expect(error.message).toContain('Set ACCEPTANCE_USER_UPN, ACCEPTANCE_USER_PASSWORD.');
  });

  it('names all seven when nothing is set', () => {
    expect(envError({}).message).toContain(`Set ${REQUIRED_VARIABLES.join(', ')}.`);
  });

  it('rejects a short sha, a non-https origin and a non-base32 secret, without echoing secrets', () => {
    const error = envError({
      ...FULL_ENV,
      EXPECTED_WEB_SHA: 'abc123',
      WEB_BASE_URL: 'http://meatgeekv2-web.vercel.app',
      ACCEPTANCE_USER_TOTP_SECRET: 'not base32 0189!',
    });
    expect(error.message).toContain('EXPECTED_WEB_SHA must be a full 40-character commit sha');
    expect(error.message).toContain('WEB_BASE_URL must be an https origin');
    expect(error.message).toContain('ACCEPTANCE_USER_TOTP_SECRET is not a base32 secret');
    expect(error.message).not.toContain('not base32 0189!');
  });

  it('never puts a secret in its message', () => {
    for (const name of REQUIRED_VARIABLES) {
      const message = envError(without(name)).message;
      expect(message).not.toContain(FULL_ENV['ACCEPTANCE_USER_PASSWORD']);
      expect(message).not.toContain(FULL_ENV['SIMDEVICE_WEB_CONNECTION_STRING']);
      expect(message).not.toContain(FULL_ENV['ACCEPTANCE_USER_TOTP_SECRET']);
    }
  });
});

// HAR-138: DPS mode, from a state dir `simdevice identity init` made.
const ID_SCOPE = '0ne00SCOPE-VALUE';
const STATE_DIR = '/state/WEB-STATE-DIR-VALUE';
const DPS_ENV: Record<string, string> = {
  ...without('SIMDEVICE_WEB_CONNECTION_STRING'),
  ACCEPTANCE_WEB_STATE_DIR: STATE_DIR,
  ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE,
};
const dpsWithout = (...names: string[]) =>
  Object.fromEntries(Object.entries(DPS_ENV).filter(([name]) => !names.includes(name)));

describe('readLiveEnv in DPS mode (HAR-138)', () => {
  it('reads the DPS identity, with no connection string', () => {
    expect(readLiveEnv(DPS_ENV).simdevice).toEqual({
      mode: 'dps',
      idScope: ID_SCOPE,
      endpoint: undefined,
      deviceId: 'meatgeek-dev-simulated-smoker-web',
      stateDir: STATE_DIR,
    });
  });

  it('takes ACCEPTANCE_DPS_ENDPOINT when it is set', () => {
    const env = readLiveEnv({ ...DPS_ENV, ACCEPTANCE_DPS_ENDPOINT: ' dps.example.test ' });
    expect(env.simdevice).toMatchObject({ mode: 'dps', endpoint: 'dps.example.test' });
  });

  it.each(DPS_REQUIRED_VARIABLES.filter(name => name !== 'ACCEPTANCE_WEB_STATE_DIR'))(
    'names %s when it is missing, and says the run is in DPS mode',
    name => {
      const error = envError(dpsWithout(name));
      expect(error.message).toContain(`Set ${name}.`);
      expect(error.message).toContain(
        'ACCEPTANCE_WEB_STATE_DIR is set, so simdevice runs in DPS mode'
      );
      expect(error.message).not.toContain('SIMDEVICE_WEB_CONNECTION_STRING');
      expect(error.message).not.toContain(STATE_DIR);
    }
  );

  it('names every DPS input when nothing but the state dir is set', () => {
    expect(envError({ ACCEPTANCE_WEB_STATE_DIR: STATE_DIR }).message).toContain(
      `Set ${DPS_REQUIRED_VARIABLES.filter(n => n !== 'ACCEPTANCE_WEB_STATE_DIR').join(', ')}.`
    );
  });

  it('a state dir without an ID scope fails, naming the scope and not the state dir value', () => {
    const message = envError(dpsWithout('ACCEPTANCE_DPS_ID_SCOPE')).message;
    expect(message).toContain('Set ACCEPTANCE_DPS_ID_SCOPE.');
    expect(message).not.toContain(STATE_DIR);
  });

  it('without a state dir, it is connection-string mode: the connection string is required again', () => {
    const error = envError(dpsWithout('ACCEPTANCE_WEB_STATE_DIR'));
    expect(error.message).toContain('Set SIMDEVICE_WEB_CONNECTION_STRING.');
    expect(error.message).not.toContain('DPS mode');
    expect(error.message).not.toContain(ID_SCOPE);
  });

  it('an ID scope with a connection string and no state dir is connection-string mode', () => {
    const env = readLiveEnv({ ...FULL_ENV, ACCEPTANCE_DPS_ID_SCOPE: ID_SCOPE });
    expect(env.simdevice).toEqual({
      mode: 'connection-string',
      connectionString: FULL_ENV['SIMDEVICE_WEB_CONNECTION_STRING'],
    });
  });

  it('refuses a connection string and a state dir together, naming both, never their values', () => {
    const message = envError({ ...FULL_ENV, ...DPS_ENV }).message;
    expect(message).toContain('SIMDEVICE_WEB_CONNECTION_STRING and ACCEPTANCE_WEB_STATE_DIR');
    expect(message).toContain('simdevice runs in one mode');
    for (const value of [FULL_ENV['SIMDEVICE_WEB_CONNECTION_STRING'], STATE_DIR, ID_SCOPE]) {
      expect(message).not.toContain(value);
    }
  });
});

// ---------------------------------------------------------------------------
// simdevice's environment, read off the spawn call (HAR-138)

const CONNECTION_STRING = 'HostName=h;DeviceId=d;SharedAccessKey=c2VjcmV0LWtleQ==';
const CLAIM_CODE = '7K3M-9QXR-2HTV';

const BY_CONNECTION_STRING: SimDeviceCredential = {
  mode: 'connection-string',
  connectionString: CONNECTION_STRING,
};
const DPS: SimDeviceCredential = {
  mode: 'dps',
  idScope: ID_SCOPE,
  endpoint: undefined,
  deviceId: 'meatgeek-dev-simulated-smoker-web',
  stateDir: STATE_DIR,
};

/** A stand-in for a ChildProcess: the test writes its output and ends it. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = jest.fn();
  /** Write `out` and `err`, end both streams and close with `code`. */
  finish(out: string, err: string, code: number | null): void {
    this.stdout.end(out);
    this.stderr.end(err);
    let ended = 0;
    const close = () => {
      ended += 1;
      if (ended < 2) return;
      this.exitCode = code;
      this.emit('close', code);
    };
    this.stdout.on('end', close);
    this.stderr.on('end', close);
    this.stdout.resume();
    this.stderr.resume();
  }
}

const childProcess = jest.requireActual<typeof import('node:child_process')>('node:child_process');

describe('simdevice spawn (HAR-138)', () => {
  let children: FakeChild[];
  let spawnSpy: jest.SpyInstance;
  beforeEach(() => {
    children = [];
    spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation((() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof childProcess.spawn);
  });
  afterEach(() => spawnSpy.mockRestore());

  const spawned = () =>
    spawnSpy.mock.calls.map(([bin, args, options]) => ({
      bin,
      args,
      env: (options as { env: Record<string, string> }).env,
    }));
  const base = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' };

  it('DPS mode: PATH, HOME and the three MEATGEEK_* variables, no connection string', () => {
    const run = startSimDevice('/opt/simdevice', DPS, ['--count', '10']);
    run.kill();
    expect(spawned()).toEqual([
      {
        bin: '/opt/simdevice',
        args: ['--count', '10'],
        env: {
          ...base,
          MEATGEEK_DPS_ID_SCOPE: ID_SCOPE,
          MEATGEEK_DEVICE_ID: 'meatgeek-dev-simulated-smoker-web',
          MEATGEEK_STATE_DIR: STATE_DIR,
        },
      },
    ]);
  });

  it('DPS mode with an endpoint: the fourth variable', () => {
    startSimDevice('/opt/simdevice', { ...DPS, endpoint: 'dps.example.test' }, []);
    expect(spawned()[0].env).toEqual({
      ...base,
      MEATGEEK_DPS_ID_SCOPE: ID_SCOPE,
      MEATGEEK_DPS_ENDPOINT: 'dps.example.test',
      MEATGEEK_DEVICE_ID: 'meatgeek-dev-simulated-smoker-web',
      MEATGEEK_STATE_DIR: STATE_DIR,
    });
  });

  it("connection-string mode: today's env, PATH, HOME and SIMDEVICE_CONNECTION_STRING only", () => {
    startSimDevice('/opt/simdevice', BY_CONNECTION_STRING, ['--count', '10']);
    expect(spawned()[0].env).toEqual({ ...base, SIMDEVICE_CONNECTION_STRING: CONNECTION_STRING });
    expect(spawned()[0].args).toEqual(['--count', '10']);
  });

  it('simDeviceEnv takes nothing from the base env but PATH and HOME', () => {
    const env = simDeviceEnv(DPS, {
      PATH: '/bin',
      HOME: '/home/x',
      SIMDEVICE_CONNECTION_STRING: CONNECTION_STRING,
      ACCEPTANCE_USER_PASSWORD: 'pw',
      MEATGEEK_DPS_ENDPOINT: 'inherited.example.test',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/x',
      MEATGEEK_DPS_ID_SCOPE: ID_SCOPE,
      MEATGEEK_DEVICE_ID: 'meatgeek-dev-simulated-smoker-web',
      MEATGEEK_STATE_DIR: STATE_DIR,
    });
  });

  describe('a claim code in simdevice output never reaches a result or an error (leak)', () => {
    it.each([
      ['DPS', DPS],
      ['connection-string', BY_CONNECTION_STRING],
    ])(
      '%s mode: the first reading keeps only its three fields; stderr is masked',
      async (_m, credential) => {
        const run = startSimDevice('/opt/simdevice', credential, []);
        children[0].finish(
          `${JSON.stringify({
            deviceId: 'd',
            timestamp: 't',
            sentAt: 's',
            claimCode: CLAIM_CODE,
          })}\n`,
          `minted ${CLAIM_CODE} with ${CONNECTION_STRING}\n`,
          0
        );
        await expect(run.first).resolves.toEqual({ deviceId: 'd', timestamp: 't', sentAt: 's' });
        const exit = await run.exit;
        expect(exit.stderrFirstLine).toContain('minted [redacted]');
        expect(JSON.stringify(exit)).not.toContain(CLAIM_CODE);
        if (credential.mode === 'connection-string') {
          expect(exit.stderrFirstLine).not.toContain(CONNECTION_STRING);
        }
      }
    );

    it('a first line that is not JSON fails without quoting it', async () => {
      const run = startSimDevice('/opt/simdevice', DPS, []);
      children[0].finish(`claim code ${CLAIM_CODE}\n`, '', 0);
      const error = (await run.first.catch((e: unknown) => e)) as Error;
      expect(error.message).toBe('simdevice printed a first line that is not JSON');
    });

    it('an exit before any reading names stderr, masked', async () => {
      const run = startSimDevice('/opt/simdevice', DPS, []);
      children[0].finish('', `could not register: code ${CLAIM_CODE}\n`, 1);
      const error = (await run.first.catch((e: unknown) => e)) as Error;
      expect(error.message).toBe(
        'simdevice exited 1 before sending a reading: could not register: code [redacted]'
      );
    });
  });

  describe('readClaimCode', () => {
    it('runs claim-code on the state dir, with only PATH and HOME', async () => {
      const reading = readClaimCode('/opt/simdevice', STATE_DIR);
      children[0].finish(`${JSON.stringify({ deviceId: 'w', state: 'claimed' })}\n`, '', 0);
      await expect(reading).resolves.toEqual({ deviceId: 'w', state: 'claimed' });
      expect(spawned()).toEqual([
        { bin: '/opt/simdevice', args: ['claim-code', '--state-dir', STATE_DIR], env: base },
      ]);
    });

    it('is "no claim yet" on exit 3', async () => {
      const reading = readClaimCode('/opt/simdevice', STATE_DIR);
      children[0].finish('', 'simdevice claim-code: no claim file\n', 3);
      await expect(reading).resolves.toEqual({ state: 'no-claim-yet' });
    });

    it('throws a ClaimCodeError on another exit, with stderr and without stdout', async () => {
      const reading = readClaimCode('/opt/simdevice', STATE_DIR);
      children[0].finish(`{"claimCode":"${CLAIM_CODE}"} STDOUT-MARKER\n`, 'permission denied\n', 1);
      const error = (await reading.catch((e: unknown) => e)) as ClaimCodeError;
      expect(error).toBeInstanceOf(ClaimCodeError);
      expect(error.exitCode).toBe(1);
      expect(error.message).toBe('simdevice claim-code exited 1: permission denied');
      expect(error.message).not.toContain('STDOUT-MARKER');
      expect(error.message).not.toContain(CLAIM_CODE);
    });

    it('throws when simdevice cannot be started', async () => {
      const reading = readClaimCode('/opt/simdevice', STATE_DIR);
      children[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      await expect(reading).rejects.toThrow('simdevice claim-code could not be started (ENOENT)');
    });
  });
});

describe('claimCodeResult (HAR-138)', () => {
  it.each([
    [
      {
        deviceId: 'w',
        state: 'unclaimed',
        claimCode: CLAIM_CODE,
        expiresAt: '2026-11-22T12:00:00Z',
      },
    ],
    [{ deviceId: 'w', state: 'claimed' }],
    [{ deviceId: 'w', state: 'expired' }],
  ])('parses %j', line => {
    expect(claimCodeResult(0, `${JSON.stringify(line)}\n`, '')).toEqual(line);
  });

  it('is "no claim yet" on exit 3, whatever it printed', () => {
    expect(claimCodeResult(3, 'anything', 'no claim file')).toEqual({ state: 'no-claim-yet' });
  });

  it.each([
    ['an unknown state', `{"deviceId":"w","state":"stolen","claimCode":"${CLAIM_CODE}"}`],
    ['two lines', `{"deviceId":"w","state":"claimed"}\n{"deviceId":"w","state":"claimed"}`],
    ['not JSON', `the code is ${CLAIM_CODE}`],
    ['a claim code that is not a string', '{"deviceId":"w","state":"unclaimed","claimCode":7}'],
  ])('throws on exit 0 with %s, never quoting stdout', (_what, stdout) => {
    let error: unknown;
    try {
      claimCodeResult(0, stdout, '');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ClaimCodeError);
    expect((error as Error).message).toContain('did not print one claim-code JSON line');
    expect((error as Error).message).not.toContain(CLAIM_CODE);
    expect((error as Error).message).not.toContain('"deviceId"');
  });

  it('throws on a kill (no exit code), with stderr masked and capped', () => {
    expect(() => claimCodeResult(null, CLAIM_CODE, `${CLAIM_CODE} ${'x'.repeat(600)}`)).toThrow(
      new RegExp(`^simdevice claim-code exited \\(killed\\): \\[redacted\\] x{489}$`)
    );
  });
});

describe('totpCode', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 SHA-1 test vector at T=%i', (seconds, code) => {
    expect(totpCode(RFC6238_SECRET, seconds * 1000, 8)).toBe(code);
  });

  it('gives the 6-digit code an authenticator app shows', () => {
    expect(totpCode(RFC6238_SECRET, 59_000)).toBe('287082');
  });

  it('accepts the secret grouped, lower case and padded', () => {
    expect(normalizeTotpSecret('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq====')).toBe(RFC6238_SECRET);
    expect(totpCode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000)).toBe('287082');
  });

  // An Entra authenticator-app secret is 16 base32 characters, 10 bytes:
  // under otplib's default 16-byte minimum. The codes were computed with
  // node:crypto's HMAC-SHA1, independently of otplib.
  it.each([
    [59, '996554'],
    [1111111109, '071271'],
  ])('accepts a 10-byte secret, as Entra issues (T=%i)', (seconds, code) => {
    expect(totpCode('jbsw y3dp ehpk 3pxp', seconds * 1000)).toBe(code);
  });

  it('counts down the 30 s window', () => {
    expect(msLeftInTotpWindow(60_000)).toBe(30_000);
    expect(msLeftInTotpWindow(89_999)).toBe(1);
  });
});

describe('checkDeployedSha', () => {
  const ancestry = (ancestor: string, descendant: string) =>
    ancestor === EXPECTED && descendant === NEWER;

  it('is ready on the exact sha', () => {
    expect(checkDeployedSha(EXPECTED, EXPECTED, () => false)).toEqual({
      ready: true,
      how: 'exact',
    });
    expect(checkDeployedSha(EXPECTED.toUpperCase(), EXPECTED, () => false)).toEqual({
      ready: true,
      how: 'exact',
    });
  });

  it('is ready on a descendant sha', () => {
    expect(checkDeployedSha(NEWER, EXPECTED, ancestry)).toEqual({ ready: true, how: 'descendant' });
  });

  it('waits on an unrelated sha, naming both', () => {
    const verdict = checkDeployedSha(UNRELATED, EXPECTED, ancestry);
    expect(verdict).toEqual({
      ready: false,
      reason: `production serves ${UNRELATED}, which does not contain ${EXPECTED}`,
    });
  });

  it('waits on local without asking git', () => {
    const isAncestor = jest.fn(() => true);
    expect(checkDeployedSha('local', EXPECTED, isAncestor)).toMatchObject({ ready: false });
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it('waits on no sha or a malformed one without asking git', () => {
    const isAncestor = jest.fn(() => true);
    expect(checkDeployedSha(undefined, EXPECTED, isAncestor)).toMatchObject({ ready: false });
    expect(checkDeployedSha('--upload-pack=x', EXPECTED, isAncestor)).toMatchObject({
      ready: false,
    });
    expect(isAncestor).not.toHaveBeenCalled();
  });
});

describe('parseVersionJson', () => {
  it('reads the sha', () => {
    expect(parseVersionJson(`{"sha":"${EXPECTED}"}\n`)).toBe(EXPECTED);
  });

  it('is undefined for HTML, no sha or a non-string sha', () => {
    expect(parseVersionJson('<!doctype html><html></html>')).toBeUndefined();
    expect(parseVersionJson('{}')).toBeUndefined();
    expect(parseVersionJson('{"sha":42}')).toBeUndefined();
    expect(parseVersionJson('null')).toBeUndefined();
  });
});

describe('isAncestorCommit', () => {
  const fakeGit = (statuses: (number | null)[]) => {
    const calls: string[][] = [];
    const git: Git = args => {
      calls.push([...args]);
      return args[0] === 'fetch' ? 0 : (statuses.shift() ?? 0);
    };
    return { git, calls };
  };

  it('is true on exit 0 and false on exit 1, without fetching', () => {
    const yes = fakeGit([0]);
    expect(isAncestorCommit(EXPECTED, NEWER, yes.git)).toBe(true);
    expect(yes.calls).toEqual([['merge-base', '--is-ancestor', EXPECTED, NEWER]]);
    const no = fakeGit([1]);
    expect(isAncestorCommit(EXPECTED, UNRELATED, no.git)).toBe(false);
    expect(no.calls).toHaveLength(1);
  });

  it('fetches both commits when one is unknown, then asks again', () => {
    const { git, calls } = fakeGit([128, 0]);
    expect(isAncestorCommit(EXPECTED, NEWER, git)).toBe(true);
    expect(calls).toEqual([
      ['merge-base', '--is-ancestor', EXPECTED, NEWER],
      ['fetch', '--quiet', '--no-tags', 'origin', EXPECTED, NEWER],
      ['merge-base', '--is-ancestor', EXPECTED, NEWER],
    ]);
  });

  it('throws, naming both, when git still cannot tell', () => {
    const { git } = fakeGit([128, 128]);
    expect(() => isAncestorCommit(EXPECTED, NEWER, git)).toThrow(
      `git could not compare ${EXPECTED} and ${NEWER} (exit 128), even after fetching both from origin`
    );
  });

  it('refuses anything but a full sha', () => {
    const { git, calls } = fakeGit([0]);
    expect(() => isAncestorCommit('--all', NEWER, git)).toThrow('is not a full commit sha');
    expect(calls).toEqual([]);
  });

  it('answers for real commits in this repository', () => {
    // The ancestry of the commit checked out here. Skipped quietly where
    // there is no git history (a source tarball).
    const { spawnSync } =
      jest.requireActual<typeof import('node:child_process')>('node:child_process');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const parent = spawnSync('git', ['rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(parent)) return;
    // HAR-121: real git, but not runGit: its 120 s kill is a live bound, and a
    // killed git would turn this answer into a fetch. Here git runs to its end.
    const git: Git = args => spawnSync('git', args, { stdio: 'ignore' }).status;
    expect(isAncestorCommit(parent, head, git)).toBe(true);
    expect(isAncestorCommit(head, parent, git)).toBe(false);
    expect(isAncestorCommit(head, head, git)).toBe(true);
  });
});

describe('waitForBuild', () => {
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  it('returns at once when production already serves the sha', async () => {
    const result = await waitForBuild({
      versionUrl: 'https://web/version.json',
      expectedSha: EXPECTED,
      fetchVersion: async () => JSON.stringify({ sha: EXPECTED }),
      isAncestor: () => false,
      ...clock(),
    });
    expect(result).toEqual({ servedSha: EXPECTED, how: 'exact', waitedMs: 0 });
  });

  it('polls every 15 s until a descendant is served, through read failures', async () => {
    const bodies = [
      () => JSON.stringify({ sha: UNRELATED }),
      () => {
        throw new Error('503');
      },
      () => JSON.stringify({ sha: NEWER }),
    ];
    const result = await waitForBuild({
      versionUrl: 'https://web/version.json',
      expectedSha: EXPECTED,
      fetchVersion: async () => (bodies.shift() as () => string)(),
      isAncestor: (a, d) => a === EXPECTED && d === NEWER,
      ...clock(),
    });
    expect(result).toEqual({ servedSha: NEWER, how: 'descendant', waitedMs: 30_000 });
  });

  it('gives up after 15 min, naming both shas', async () => {
    const fetchVersion = jest.fn(async () => JSON.stringify({ sha: UNRELATED }));
    await expect(
      waitForBuild({
        versionUrl: 'https://web/version.json',
        expectedSha: EXPECTED,
        fetchVersion,
        isAncestor: () => false,
        ...clock(),
      })
    ).rejects.toThrow(
      `Production did not serve ${EXPECTED} or a commit after it within 15 min: ` +
        `https://web/version.json last reported ${UNRELATED} (production serves ${UNRELATED}, ` +
        `which does not contain ${EXPECTED})`
    );
    // t = 0, 15 s, …, 15 min: 61 looks.
    expect(fetchVersion).toHaveBeenCalledTimes(61);
  });
});

describe('the pushed reading', () => {
  it('picks a grill value from 300.0 to 399.9 with one decimal', () => {
    expect(distinctiveGrillF(1_763_600_000_123)).toBe(312.3);
    expect(distinctiveGrillF(0)).toBe(300);
    expect(distinctiveGrillF(999)).toBe(399.9);
  });

  it('shows it as the web app does', () => {
    expect(grillText(312.3, 'fahrenheit')).toBe('312.3 °F');
    expect(grillText(300, undefined)).toBe('300 °F');
    expect(grillText(312.3, 'celsius')).toBe('155.7 °C');
  });
});

describe('redact', () => {
  it('replaces every secret', () => {
    expect(redact('key=abcd1234 and abcd1234', ['abcd1234'])).toBe('key=[redacted] and [redacted]');
  });

  it('HAR-138: masks anything shaped like a claim code, but not a UUID or a device id', () => {
    expect(redact(`claim ${CLAIM_CODE}.`, [])).toBe('claim [redacted].');
    for (const text of [
      '6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b',
      '6F1E2D3C-4B5A-4987-8A6B-5C4D3E2F1A0B',
      'meatgeek-dev-simulated-smoker-web',
    ]) {
      expect(redact(text, [])).toBe(text);
    }
  });
});

describe('livePanelConnection (step 5)', () => {
  it('is connected while waiting for a first reading or live', () => {
    expect(livePanelConnection('waiting', 'Waiting')).toBe('connected');
    expect(livePanelConnection('live', 'Live')).toBe('connected');
  });

  it("is connected when the backfill is the last run's old reading on a standing device", () => {
    // HAR-101, Deploy Dev App run 44833909340: the panel connected, backfilled
    // a reading from the previous run and opened stale.
    expect(livePanelConnection('stale', 'No reading for 24 min 13 s')).toBe('connected');
    expect(livePanelConnection('stale', 'No reading for 31 s')).toBe('connected');
  });

  it('is not connected while connecting, reconnecting or signed out', () => {
    expect(livePanelConnection('connecting', 'Connecting…')).toBe(
      'not connected (data-state connecting, badge "Connecting…")'
    );
    expect(livePanelConnection('stale', 'Reconnecting…')).toBe(
      'not connected (data-state stale, badge "Reconnecting…")'
    );
    expect(livePanelConnection('stale', 'Sign in again')).toBe(
      'not connected (data-state stale, badge "Sign in again")'
    );
  });

  it('has given up only on "Sign in again", after which the app tries nothing more', () => {
    expect(livePanelGaveUp('stale', 'Sign in again')).toBe(true);
    expect(livePanelGaveUp('stale', ' Sign in again ')).toBe(true);
    expect(livePanelGaveUp('stale', 'Reconnecting…')).toBe(false);
    expect(livePanelGaveUp('connecting', 'Connecting…')).toBe(false);
    expect(livePanelGaveUp('stale', 'No reading for 24 min 0 s')).toBe(false);
    expect(livePanelGaveUp(null, null)).toBe(false);
  });

  it('is not connected for a missing panel or badge copy it does not know', () => {
    expect(livePanelConnection(null, null)).toBe('not connected (data-state none, badge "")');
    expect(livePanelConnection('stale', 'No reading for')).toMatch(/^not connected/);
    expect(livePanelConnection('stale', 'Offline')).toMatch(/^not connected/);
  });
});

describe('LAST_HEARD_TEXT (HAR-143, step 8)', () => {
  it.each([
    'Connected · last heard 0 s ago',
    'Connected · last heard 12 s ago',
    'Offline · last heard 3 min 4 s ago',
    'Offline · last heard 26 h 0 min ago',
  ])('matches %s', text => {
    expect(text).toMatch(LAST_HEARD_TEXT);
  });

  it.each([
    'Connected',
    'Offline · never heard from',
    'Status unknown',
    'Offline · last heard ago',
    'Online · last heard 12 s ago',
  ])('does not match %s', text => {
    expect(text).not.toMatch(LAST_HEARD_TEXT);
  });
});
