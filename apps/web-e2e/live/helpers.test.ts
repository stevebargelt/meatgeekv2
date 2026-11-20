import {
  DEFAULT_WEB_BASE_URL,
  LiveEnvError,
  REQUIRED_VARIABLES,
  checkDeployedSha,
  distinctiveGrillF,
  grillText,
  isAncestorCommit,
  msLeftInTotpWindow,
  normalizeTotpSecret,
  parseVersionJson,
  readLiveEnv,
  redact,
  totpCode,
  waitForBuild,
  type Git,
} from './helpers';

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
      simdeviceConnectionString: 'HostName=h;DeviceId=d;SharedAccessKey=k',
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
    expect(isAncestorCommit(parent, head)).toBe(true);
    expect(isAncestorCommit(head, parent)).toBe(false);
    expect(isAncestorCommit(head, head)).toBe(true);
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
});
