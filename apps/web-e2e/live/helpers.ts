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

/** Every input the proof cannot run without, in the order the docs list them,
 *  when simdevice runs with a connection string (the old mode). */
export const REQUIRED_VARIABLES = [
  'EXPECTED_WEB_SHA',
  'ACCEPTANCE_USER_UPN',
  'ACCEPTANCE_USER_PASSWORD',
  'ACCEPTANCE_USER_TOTP_SECRET',
  'ACCEPTANCE_WEB_DEVICE_ID',
  'SIMDEVICE_WEB_CONNECTION_STRING',
  'ACCEPTANCE_SIMDEVICE_BIN',
] as const;

/**
 * HAR-138: the same, in DPS mode (ACCEPTANCE_WEB_STATE_DIR is set). The device
 * is its own X.509 identity in that state dir, so no connection string; the
 * DPS ID scope instead. ACCEPTANCE_DPS_ENDPOINT is optional.
 */
export const DPS_REQUIRED_VARIABLES = [
  'EXPECTED_WEB_SHA',
  'ACCEPTANCE_USER_UPN',
  'ACCEPTANCE_USER_PASSWORD',
  'ACCEPTANCE_USER_TOTP_SECRET',
  'ACCEPTANCE_WEB_DEVICE_ID',
  'ACCEPTANCE_WEB_STATE_DIR',
  'ACCEPTANCE_DPS_ID_SCOPE',
  'ACCEPTANCE_SIMDEVICE_BIN',
] as const;

/** How simdevice gets the web device: a connection string, or DPS mode. */
export type SimDeviceCredential =
  | { readonly mode: 'connection-string'; readonly connectionString: string }
  | {
      readonly mode: 'dps';
      readonly idScope: string;
      readonly endpoint: string | undefined;
      readonly deviceId: string;
      readonly stateDir: string;
    };

/**
 * The whole environment simdevice runs with: PATH and HOME from `base`, plus
 * the credential. A connection string goes in as SIMDEVICE_CONNECTION_STRING;
 * DPS mode sets MEATGEEK_DPS_ID_SCOPE, MEATGEEK_DEVICE_ID, MEATGEEK_STATE_DIR
 * and, when given, MEATGEEK_DPS_ENDPOINT, and no connection string at all.
 */
export function simDeviceEnv(
  credential: SimDeviceCredential,
  base: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const env: Record<string, string> = { PATH: base['PATH'] ?? '', HOME: base['HOME'] ?? '' };
  if (credential.mode === 'connection-string') {
    env['SIMDEVICE_CONNECTION_STRING'] = credential.connectionString;
    return env;
  }
  env['MEATGEEK_DPS_ID_SCOPE'] = credential.idScope;
  env['MEATGEEK_DEVICE_ID'] = credential.deviceId;
  env['MEATGEEK_STATE_DIR'] = credential.stateDir;
  if (credential.endpoint !== undefined) env['MEATGEEK_DPS_ENDPOINT'] = credential.endpoint;
  return env;
}

export interface LiveEnv {
  /** The web app's origin, no trailing slash. */
  readonly webBaseUrl: string;
  readonly expectedSha: string;
  readonly upn: string;
  readonly password: string;
  readonly totpSecret: string;
  readonly deviceId: string;
  /** HAR-138: the web device's connection string, or its DPS identity. */
  readonly simdevice: SimDeviceCredential;
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
 *
 * HAR-138: ACCEPTANCE_WEB_STATE_DIR set means DPS mode, which needs
 * {@link DPS_REQUIRED_VARIABLES}; otherwise {@link REQUIRED_VARIABLES}. Both it
 * and SIMDEVICE_WEB_CONNECTION_STRING set is refused before anything else.
 */
export function readLiveEnv(
  env: Readonly<Record<string, string | undefined>>,
  now: Date = new Date()
): LiveEnv {
  const value = (name: string) => env[name]?.trim() ?? '';
  const dps = value('ACCEPTANCE_WEB_STATE_DIR') !== '';
  if (dps && value('SIMDEVICE_WEB_CONNECTION_STRING') !== '') {
    throw new LiveEnvError(
      'The live browser proof was given SIMDEVICE_WEB_CONNECTION_STRING and ' +
        'ACCEPTANCE_WEB_STATE_DIR. simdevice runs in one mode: set the connection string, ' +
        'or the state dir for DPS mode. ' +
        'See "Live browser proof" in docs/development/live-acceptance.md.'
    );
  }
  const required: readonly string[] = dps ? DPS_REQUIRED_VARIABLES : REQUIRED_VARIABLES;
  const missing = required.filter(name => value(name) === '');
  if (missing.length > 0) {
    throw new LiveEnvError(
      `The live browser proof is missing ${missing.length === 1 ? 'an input' : 'inputs'}. ` +
        `Set ${missing.join(', ')}. ` +
        (dps ? '(ACCEPTANCE_WEB_STATE_DIR is set, so simdevice runs in DPS mode.) ' : '') +
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
    simdevice: dps
      ? {
          mode: 'dps',
          idScope: value('ACCEPTANCE_DPS_ID_SCOPE'),
          endpoint: value('ACCEPTANCE_DPS_ENDPOINT') || undefined,
          deviceId: value('ACCEPTANCE_WEB_DEVICE_ID'),
          stateDir: value('ACCEPTANCE_WEB_STATE_DIR'),
        }
      : { mode: 'connection-string', connectionString: value('SIMDEVICE_WEB_CONNECTION_STRING') },
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

/**
 * A claim code as simdevice prints it (HAR-134): `XXXX-XXXX-XXXX` in Crockford
 * base32 (no I, L, O or U), not inside a longer dashed or alphanumeric run, so
 * the middle of a UUID is not one.
 */
const CLAIM_CODE =
  /(?<![0-9A-Za-z-])[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}(?![0-9A-Za-z-])/g;

/** `text` with everything shaped like a claim code replaced. Whoever holds a
 *  device's unused claim code can claim it, and nobody knows it in advance. */
export function maskClaimCodes(text: string): string {
  return text.replace(CLAIM_CODE, '[redacted]');
}

/** `text` with every secret replaced, for anything a child process wrote.
 *  HAR-138: then anything shaped like a claim code too. */
export function redact(text: string, secrets: readonly string[]): string {
  return maskClaimCodes(
    secrets
      .filter(secret => secret.length >= 4)
      .reduce((out, secret) => out.split(secret).join('[redacted]'), text)
  );
}

/** simdevice's exit code when the device has not minted a claim code yet. */
export const EXIT_NO_CLAIM = 3;

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

/** A `simdevice claim-code` run that failed. Carries the exit code and stderr
 *  (claim codes masked), never stdout. */
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

const CLAIM_STATES: readonly string[] = ['unclaimed', 'claimed', 'expired'];

/**
 * What a finished `simdevice claim-code` run means: exit 0 with one
 * claim-code JSON line is that line; exit 3 is {@link NoClaimYet}; anything
 * else throws a {@link ClaimCodeError} whose message holds the exit code and
 * stderr's first 500 characters, never stdout.
 */
export function claimCodeResult(
  exitCode: number | null,
  stdout: string,
  stderr: string
): ClaimCodeLine | NoClaimYet {
  const err = maskClaimCodes(stderr.trim()).slice(0, 500);
  const said = err === '' ? '' : `: ${err}`;
  if (exitCode === EXIT_NO_CLAIM) return { state: 'no-claim-yet' };
  if (exitCode !== 0) {
    throw new ClaimCodeError(
      `simdevice claim-code exited ${exitCode ?? '(killed)'}${said}`,
      exitCode,
      err
    );
  }
  const lines = stdout.split('\n').filter(line => line.trim() !== '');
  let line: Record<string, unknown> | null = null;
  try {
    line = lines.length === 1 ? (JSON.parse(lines[0]) as Record<string, unknown> | null) : null;
  } catch {
    line = null;
  }
  if (
    !line ||
    typeof line !== 'object' ||
    typeof line['deviceId'] !== 'string' ||
    typeof line['state'] !== 'string' ||
    !CLAIM_STATES.includes(line['state']) ||
    (line['claimCode'] !== undefined && typeof line['claimCode'] !== 'string') ||
    (line['expiresAt'] !== undefined && typeof line['expiresAt'] !== 'string')
  ) {
    throw new ClaimCodeError(
      'simdevice claim-code exited 0 but did not print one claim-code JSON line ' +
        '(stdout not shown: it can hold the claim code)',
      exitCode,
      err
    );
  }
  return {
    deviceId: line['deviceId'],
    state: line['state'] as ClaimState,
    ...(line['claimCode'] !== undefined ? { claimCode: line['claimCode'] as string } : {}),
    ...(line['expiresAt'] !== undefined ? { expiresAt: line['expiresAt'] as string } : {}),
  };
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

/**
 * Whether the panel has stopped trying: "Sign in again" means negotiate
 * answered 401, after which the app tries nothing more
 * (apps/web/src/live/live-connection.ts). Waiting longer cannot connect it.
 */
export function livePanelGaveUp(state: string | null, badge: string | null): boolean {
  return state === 'stale' && (badge ?? '').trim() === 'Sign in again';
}

/**
 * HAR-143: a device row's connection text when IoT Hub has heard from the
 * device: "Connected · last heard <age> ago" or "Offline · last heard <age>
 * ago", the age in the app's duration style ("12 s", "3 min 4 s", "2 h 5 min";
 * apps/web/src/devices/connection.ts). "Connected" alone, "Offline · never
 * heard from" and "Status unknown" do not match.
 */
export const LAST_HEARD_TEXT =
  /^(Connected|Offline) · last heard (\d+ s|\d+ min \d+ s|\d+ h \d+ min) ago$/;
