import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MS,
  MS_ERROR_CONTAINERS,
  SignInPageChanged,
  signInDiagnostic,
  writeSignInDiagnostic,
  type ProbeLocator,
  type ProbePage,
} from './microsoft-sign-in';
import { totpCode } from './helpers';

/**
 * HAR-121: the sign-in diagnostic is written next to the failure screenshots
 * and uploaded from CI, so it must never hold the UPN, the password, the TOTP
 * secret or code, an input's value, a cookie or the URL's query or fragment.
 */

const UPN = 'acceptance@example.test';
const PASSWORD = 'Pa55-not-a-real-one';
const TOTP_SECRET = 'jbsw y3dp ehpk 3pxp';
const CODE = totpCode(TOTP_SECRET, 1_763_600_000_000);
const QUERY_TOKEN = 'eyJhbGciOiJub25lIn0.query-token';
const FRAGMENT_TOKEN = 'eyJhbGciOiJub25lIn0.fragment-token';
const COOKIE = 'ESTSAUTH=cookie-value-0123456789';

interface FakeElement {
  visible: boolean;
  text?: string;
  /** What a user typed. A probe that read it would leak it. */
  value?: string;
}

/**
 * A page on Microsoft's password step. Its inputs hold the UPN, the password
 * and a TOTP code, its URL carries tokens, and its username error echoes the
 * UPN. Every locator also answers `inputValue`, `evaluate` and
 * `getAttribute('value')` with those values, so a probe that asked for them
 * would put them in the output.
 */
function fakePage(): ProbePage & { cookies: string } {
  const elements = new Map<string, FakeElement[]>([
    [MS.upn, [{ visible: false, value: UPN }]],
    [MS.password, [{ visible: true, value: PASSWORD }]],
    [MS.otc, [{ visible: false, value: CODE }]],
    [MS.submit, [{ visible: true, text: 'Sign in' }]],
    [MS.usernameError, [{ visible: true, text: `  We couldn't find an account\n for ${UPN}.  ` }]],
    [MS.passwordError, [{ visible: false, text: '' }]],
    [MS_ERROR_CONTAINERS.alert, [{ visible: true, text: `Code ${CODE} was not accepted` }]],
  ]);
  const locator = (selector: string): ProbeLocator & Record<string, unknown> => {
    const found = elements.get(selector) ?? [];
    const first = found[0];
    return {
      count: async () => found.length,
      first: () => ({
        isVisible: async () => first?.visible ?? false,
        textContent: async () => (first ? (first.text ?? '') : null),
        inputValue: async () => first?.value ?? '',
        getAttribute: async (name: string) => (name === 'value' ? (first?.value ?? null) : null),
        evaluate: async () => first?.value,
      }),
      inputValue: async () => first?.value ?? '',
    };
  };
  return {
    url: () =>
      `https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize` +
      `?login_hint=${encodeURIComponent(UPN)}&code=${QUERY_TOKEN}#id_token=${FRAGMENT_TOKEN}`,
    title: async () => 'Sign in to your account',
    locator,
    cookies: COOKIE,
  };
}

const SECRETS = [UPN, PASSWORD, TOTP_SECRET, 'JBSWY3DPEHPK3PXP', CODE];

describe('signInDiagnostic', () => {
  it('contains none of the UPN, password, TOTP secret or code, an input value, a cookie or the query', async () => {
    const text = await signInDiagnostic(fakePage(), {
      failure: new SignInPageChanged('password', 'none of password, usernameError appeared'),
      secrets: SECRETS,
    });
    for (const secret of [
      UPN,
      encodeURIComponent(UPN),
      PASSWORD,
      TOTP_SECRET,
      'JBSWY3DPEHPK3PXP',
      CODE,
      QUERY_TOKEN,
      FRAGMENT_TOKEN,
      COOKIE,
      'login_hint',
      '?',
      '#id_token',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('never reads an input value, even with nothing to redact', async () => {
    // Without the redaction list, only what the probe chose to read is left.
    const text = await signInDiagnostic(fakePage(), { secrets: [] });
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(QUERY_TOKEN);
    expect(text).not.toContain(FRAGMENT_TOKEN);
  });

  it('holds the origin and path, the title, each selector and the error text', async () => {
    const text = await signInDiagnostic(fakePage(), {
      failure: new SignInPageChanged('password', 'none of password, usernameError appeared'),
      secrets: SECRETS,
    });
    const lines = text.split('\n');
    expect(lines).toContain(
      'failure: SignInPageChanged: Microsoft sign-in page changed at step password: ' +
        'none of password, usernameError appeared'
    );
    expect(lines).toContain(
      'url: https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize'
    );
    expect(lines).toContain('title: Sign in to your account');
    expect(lines).toContain(`  password       present (1), visible  ${MS.password}`);
    expect(lines).toContain(`  upn            present (1), hidden  ${MS.upn}`);
    expect(lines).toContain(`  kmsi           absent, hidden  ${MS.kmsi}`);
    for (const key of Object.keys(MS)) {
      expect(lines.some(line => line.startsWith(`  ${key} `))).toBe(true);
    }
    expect(lines).toContain(`  usernameError: "We couldn't find an account for [redacted]."`);
    expect(lines).toContain('  passwordError: (none)');
    expect(lines).toContain('  otcError: (none)');
    expect(lines).toContain('  alert: "Code [redacted] was not accepted"');
  });

  it('writes only the error name and first line of a failure', async () => {
    const failure = new Error(`first line\nCall log:\n  - fill("${PASSWORD}")`);
    const text = await signInDiagnostic(fakePage(), { failure, secrets: [] });
    expect(text.split('\n')).toContain('failure: Error: first line');
    expect(text).not.toContain('Call log');
  });

  it('writes the file, readable by its owner only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sign-in-diagnostic-'));
    try {
      const path = join(dir, 'test-results', 'proof', 'sign-in-diagnostic.txt');
      await writeSignInDiagnostic(fakePage(), path, { secrets: SECRETS });
      const written = readFileSync(path, 'utf8');
      expect(written).toBe(await signInDiagnostic(fakePage(), { secrets: SECRETS }));
      for (const secret of SECRETS) expect(written).not.toContain(secret);
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
