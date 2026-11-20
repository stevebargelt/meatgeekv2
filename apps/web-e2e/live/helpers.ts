import { spawnSync } from 'node:child_process';
import { createGuardrails, generateSync } from 'otplib';

/**
 * The pure parts of the live browser proof (HAR-99): reading its inputs, the
 * build check, the ancestor check and the TOTP code. None of them needs a
 * browser, so jest covers them (helpers.test.ts).
 *
 * Nothing here writes to the console. Error messages name variables, never
 * their values, except the two commit shas, which are not secret.
 */

export const DEFAULT_WEB_BASE_URL = 'https://meatgeekv2-web.vercel.app';

/** Every input the proof cannot run without, in the order the docs list them. */
export const REQUIRED_VARIABLES = [
  'EXPECTED_WEB_SHA',
  'ACCEPTANCE_USER_UPN',
  'ACCEPTANCE_USER_PASSWORD',
  'ACCEPTANCE_USER_TOTP_SECRET',
  'ACCEPTANCE_WEB_DEVICE_ID',
  'SIMDEVICE_WEB_CONNECTION_STRING',
  'ACCEPTANCE_SIMDEVICE_BIN',
] as const;

export interface LiveEnv {
  /** The web app's origin, no trailing slash. */
  readonly webBaseUrl: string;
  readonly expectedSha: string;
  readonly upn: string;
  readonly password: string;
  readonly totpSecret: string;
  readonly deviceId: string;
  readonly simdeviceConnectionString: string;
  readonly simdeviceBin: string;
  /** Names this run's cook: the GitHub Actions run id, or a timestamp locally. */
  readonly runId: string;
}

/** A missing or malformed input. The message names variables, never values. */
export class LiveEnvError extends Error {
  override name = 'LiveEnvError';
}

const SHA = /^[0-9a-f]{40}$/;

export const isCommitSha = (value: string): boolean => SHA.test(value);

/**
 * Read and check the proof's inputs. Throws one LiveEnvError naming every
 * variable that is unset or blank, then (once all are set) every one that is
 * malformed.
 */
export function readLiveEnv(
  env: Readonly<Record<string, string | undefined>>,
  now: Date = new Date()
): LiveEnv {
  const value = (name: string) => env[name]?.trim() ?? '';
  const missing = REQUIRED_VARIABLES.filter(name => value(name) === '');
  if (missing.length > 0) {
    throw new LiveEnvError(
      `The live browser proof is missing ${missing.length === 1 ? 'an input' : 'inputs'}. ` +
        `Set ${missing.join(', ')}. ` +
        'See "Live browser proof" in docs/development/live-acceptance.md.'
    );
  }

  const problems: string[] = [];
  const webBaseUrl = (value('WEB_BASE_URL') || DEFAULT_WEB_BASE_URL).replace(/\/+$/, '');
  if (!isWebOrigin(webBaseUrl)) {
    problems.push(`WEB_BASE_URL must be an https origin (or http://localhost), got ${webBaseUrl}`);
  }
  const expectedSha = value('EXPECTED_WEB_SHA').toLowerCase();
  if (!isCommitSha(expectedSha)) {
    problems.push(
      `EXPECTED_WEB_SHA must be a full 40-character commit sha, got ${value('EXPECTED_WEB_SHA')}`
    );
  }
  // Not the secret itself: only whether it is base32.
  if (!/^[A-Z2-7]+$/.test(normalizeTotpSecret(value('ACCEPTANCE_USER_TOTP_SECRET')))) {
    problems.push('ACCEPTANCE_USER_TOTP_SECRET is not a base32 secret');
  }
  if (problems.length > 0) {
    throw new LiveEnvError(`The live browser proof has bad inputs: ${problems.join('; ')}.`);
  }

  return {
    webBaseUrl,
    expectedSha,
    upn: value('ACCEPTANCE_USER_UPN'),
    password: env['ACCEPTANCE_USER_PASSWORD'] ?? '',
    totpSecret: value('ACCEPTANCE_USER_TOTP_SECRET'),
    deviceId: value('ACCEPTANCE_WEB_DEVICE_ID'),
    simdeviceConnectionString: value('SIMDEVICE_WEB_CONNECTION_STRING'),
    simdeviceBin: value('ACCEPTANCE_SIMDEVICE_BIN'),
    runId: value('GITHUB_RUN_ID') || now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z'),
  };
}

function isWebOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return (
      (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)) &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// TOTP

/** Authenticator apps show secrets in groups, lower case, sometimes padded. */
export function normalizeTotpSecret(secret: string): string {
  return secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
}

export const TOTP_PERIOD_S = 30;

/**
 * otplib refuses secrets under 16 bytes by default (its `MIN_SECRET_BYTES`, a
 * rule for secrets you generate). Microsoft generates this one, and an Entra
 * authenticator-app secret is 16 base32 characters: 10 bytes. We only compute
 * codes for a secret we were handed, so accept any length.
 */
const TOTP_GUARDRAILS = createGuardrails({ MIN_SECRET_BYTES: 1 });

/** The 6-digit RFC 6238 code (SHA-1, 30 s) for `secret` at `nowMs`. */
export function totpCode(secret: string, nowMs: number, digits = 6): string {
  return generateSync({
    secret: normalizeTotpSecret(secret),
    epoch: Math.floor(nowMs / 1000),
    digits,
    guardrails: TOTP_GUARDRAILS,
  });
}

/** Milliseconds until the code for `nowMs` stops being current. */
export function msLeftInTotpWindow(nowMs: number): number {
  const periodMs = TOTP_PERIOD_S * 1000;
  return periodMs - (nowMs % periodMs);
}

// ---------------------------------------------------------------------------
// Which build production serves

/** The `sha` in a version.json body, or undefined when there is none. */
export function parseVersionJson(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    const sha = (parsed as { sha?: unknown } | null)?.sha;
    return typeof sha === 'string' && sha.trim() !== '' ? sha.trim() : undefined;
  } catch {
    return undefined;
  }
}

export type BuildVerdict =
  | { readonly ready: true; readonly how: 'exact' | 'descendant' }
  | { readonly ready: false; readonly reason: string };

/**
 * Is the build production serves (`deployed`, from version.json) the expected
 * commit, or one that contains it? A newer `main` commit may already be live
 * by the time this run looks, which is just as good.
 */
export function checkDeployedSha(
  deployed: string | undefined,
  expected: string,
  isAncestor: (ancestor: string, descendant: string) => boolean
): BuildVerdict {
  if (deployed === undefined) return { ready: false, reason: 'version.json has no sha' };
  const sha = deployed.toLowerCase();
  if (sha === expected.toLowerCase()) return { ready: true, how: 'exact' };
  if (sha === 'local') {
    return { ready: false, reason: 'production serves a build with no commit (sha "local")' };
  }
  if (!isCommitSha(sha)) {
    return { ready: false, reason: `version.json's sha ${deployed} is not a commit sha` };
  }
  if (isAncestor(expected.toLowerCase(), sha)) return { ready: true, how: 'descendant' };
  return { ready: false, reason: `production serves ${sha}, which does not contain ${expected}` };
}

/** Runs git with `args` in the current directory and returns its exit status. */
export type Git = (args: readonly string[]) => number | null;

export const runGit: Git = args =>
  spawnSync('git', args, { stdio: 'ignore', timeout: 120_000 }).status;

/**
 * True when `ancestor` is an ancestor of (or the same commit as)
 * `descendant`, by `git merge-base --is-ancestor`. When git cannot answer
 * (exit 128: a commit is not in this clone), fetches both commits from
 * `origin` and asks once more. A shallow clone may not hold enough history to
 * see the link; fetch with full history (`fetch-depth: 0`) where it runs.
 */
export function isAncestorCommit(ancestor: string, descendant: string, git: Git = runGit): boolean {
  for (const sha of [ancestor, descendant]) {
    // Never hand git something that could be read as an option.
    if (!isCommitSha(sha)) throw new Error(`${sha} is not a full commit sha`);
  }
  const ask = () => git(['merge-base', '--is-ancestor', ancestor, descendant]);
  let status = ask();
  if (status === 0) return true;
  if (status === 1) return false;
  git(['fetch', '--quiet', '--no-tags', 'origin', ancestor, descendant]);
  status = ask();
  if (status === 0) return true;
  if (status === 1) return false;
  throw new Error(
    `git could not compare ${ancestor} and ${descendant} (exit ${status ?? 'killed'}), ` +
      'even after fetching both from origin'
  );
}

export interface WaitForBuildOptions {
  readonly versionUrl: string;
  readonly expectedSha: string;
  /** The body of version.json; throw when it could not be read. */
  readonly fetchVersion: () => Promise<string>;
  readonly isAncestor: (ancestor: string, descendant: string) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export interface BuildWait {
  readonly servedSha: string;
  readonly how: 'exact' | 'descendant';
  readonly waitedMs: number;
}

/**
 * Poll version.json every 15 s, for at most 15 min, until production serves
 * the expected commit or a descendant of it. On timeout the error names both
 * shas and why the last look did not count.
 */
export async function waitForBuild(options: WaitForBuildOptions): Promise<BuildWait> {
  const { intervalMs = 15_000, timeoutMs = 15 * 60_000 } = options;
  const started = options.now();
  let served: string | undefined;
  let reason = 'not read yet';
  for (;;) {
    try {
      served = parseVersionJson(await options.fetchVersion());
      const verdict = checkDeployedSha(served, options.expectedSha, (a, d) =>
        options.isAncestor(a, d)
      );
      if (verdict.ready) {
        return { servedSha: served as string, how: verdict.how, waitedMs: options.now() - started };
      }
      reason = verdict.reason;
    } catch (error) {
      reason = `could not read it: ${error instanceof Error ? error.message : String(error)}`;
    }
    const waited = options.now() - started;
    if (waited + intervalMs > timeoutMs) {
      throw new Error(
        `Production did not serve ${options.expectedSha} or a commit after it within ` +
          `${Math.round(timeoutMs / 60_000)} min: ${options.versionUrl} last reported ` +
          `${served ?? 'no sha'} (${reason})`
      );
    }
    await options.sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// The pushed reading

/**
 * A grill temperature (°F) no earlier run is likely to have left on screen:
 * 300.0 to 399.9, one decimal, picked from `seed` (the run's start time).
 * The synthetic curve stays near 225, so it never collides with that either.
 */
export function distinctiveGrillF(seed: number): number {
  return 300 + (Math.abs(Math.trunc(seed)) % 1000) / 10;
}

/**
 * What the live panel shows for `fahrenheit` on a device with `unit`: the
 * web app's formatTemperature (apps/web/src/live/format.ts), one decimal.
 */
export function grillText(fahrenheit: number, unit: 'fahrenheit' | 'celsius' | undefined): string {
  const celsius = unit === 'celsius';
  const value = celsius ? ((fahrenheit - 32) * 5) / 9 : fahrenheit;
  const rounded = Math.round(value * 10) / 10;
  return `${Object.is(rounded, -0) ? 0 : rounded} ${celsius ? '°C' : '°F'}`;
}

/** `text` with every secret replaced, for anything a child process wrote. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter(secret => secret.length >= 4)
    .reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

/**
 * Whether the cook page's live panel is connected to the hub, from its
 * `data-state` and badge text (docs/applications/web-app.md, "Live panel").
 *
 * `waiting` and `live` are connected. `stale` covers both a connected panel
 * whose backfilled reading is old ("No reading for …", the usual case on a
 * standing device the last run left a reading on) and a lost connection
 * ("Reconnecting…", "Sign in again"); only the first is connected. Anything
 * else, including `connecting` and badge copy this does not know, is not.
 * Returns `connected`, or what the panel shows, for the failure message.
 */
export function livePanelConnection(state: string | null, badge: string | null): string {
  const text = (badge ?? '').trim();
  if (state === 'waiting' || state === 'live') return 'connected';
  if (state === 'stale' && /^No reading for \S/.test(text)) return 'connected';
  return `not connected (data-state ${state ?? 'none'}, badge "${text}")`;
}
