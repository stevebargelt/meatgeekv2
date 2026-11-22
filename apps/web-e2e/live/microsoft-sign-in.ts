import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { msLeftInTotpWindow, normalizeTotpSecret, redact, totpCode } from './helpers';

/**
 * Microsoft's real sign-in pages (login.microsoftonline.com), driven by the
 * stable element ids they have used for years, never by copy text. When
 * Microsoft changes the pages, this map is the one place to update.
 * See "When Microsoft changes its sign-in pages" in
 * docs/development/live-acceptance.md.
 */
export const MS = {
  upn: '#i0116',
  /** "We couldn't find an account with that username." */
  usernameError: '#usernameError',
  /**
   * The UPN page already holds an `#i0118`: an off-screen, aria-hidden copy for
   * password managers, which Playwright counts as visible. The password
   * page's own field is the one without that class.
   */
  password: '#i0118:not(.moveOffScreen):not([aria-hidden="true"])',
  /** "Next", "Sign in" and, on "Stay signed in?", "Yes". */
  submit: '#idSIButton9',
  passwordError: '#passwordError',
  /** The authenticator-app code box. */
  otc: '#idTxtBx_SAOTCC_OTC',
  otcError: '#idSpan_SAOTCC_Error_OTC',
  /** "Verify your identity": the authenticator-app code among the methods. */
  otcMethod: '[data-value="PhoneAppOTP"]',
  /** "Sign in another way", under a push prompt the user cannot approve. */
  otherWay: '#signInAnotherWay',
  /** "Stay signed in?" is on screen. */
  kmsi: '#KmsiCheckboxField, #kmsiTitle',
  /** "No" on "Stay signed in?". */
  kmsiNo: '#idBtn_Back',
} as const;

/**
 * Microsoft's own error text, read into the sign-in diagnostic. `alert` is
 * any ARIA alert, for an error page none of the three ids covers.
 */
export const MS_ERROR_CONTAINERS = {
  usernameError: MS.usernameError,
  passwordError: MS.passwordError,
  otcError: MS.otcError,
  alert: '[role="alert"]',
} as const;

/**
 * How long each sign-in page may take to show its element. HAR-121 measured
 * the whole sign-in step at 2.5 to 13.4 s over 18 passing runs, the UPN and
 * password pages together at 1.6 to 3.7 s; see "Real-time waits" in
 * docs/development/live-acceptance.md.
 */
export const STEP_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_S = STEP_TIMEOUT_MS / 1000;

export interface SignInInput {
  readonly upn: string;
  readonly password: string;
  readonly totpSecret: string;
  /** The app's origin: back there means signed in. */
  readonly appOrigin: string;
  /** Called with a short note for the log; never a value that was typed. */
  readonly note?: (message: string) => void;
  /**
   * Where to write the sign-in diagnostic when a step fails (HAR-121). It
   * holds no typed value, cookie or query string; see `signInDiagnostic`.
   */
  readonly diagnosticPath?: string;
}

/** The sign-in page moved on to something this code does not know. */
export class SignInPageChanged extends Error {
  override name = 'SignInPageChanged';
  constructor(step: string, detail: string, page?: Page) {
    super(`Microsoft sign-in page changed at step ${step}: ${detail}${where(page)}`);
  }
}

/** ` (on <origin><path>)`: never the query or fragment, which carry auth state. */
function where(page: Page | undefined): string {
  if (!page) return '';
  try {
    const url = new URL(page.url());
    return ` (on ${url.origin}${url.pathname})`;
  } catch {
    return '';
  }
}

/**
 * Wait up to STEP_TIMEOUT_MS for the first of `outcomes` to hold, polling.
 * Returns its key. Each outcome is a locator to be visible, or a predicate.
 */
async function firstOf<K extends string>(
  page: Page,
  step: string,
  outcomes: Record<K, Locator | (() => boolean)>
): Promise<K> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const keys = Object.keys(outcomes) as K[];
  for (;;) {
    for (const key of keys) {
      const outcome = outcomes[key];
      const holds =
        typeof outcome === 'function'
          ? outcome()
          : await outcome
              .first()
              .isVisible()
              .catch(() => false);
      if (holds) return key;
    }
    if (Date.now() > deadline) {
      throw new SignInPageChanged(
        step,
        `none of ${keys.join(', ')} appeared within ${STEP_TIMEOUT_S} s`,
        page
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** Fill `selector` once it is visible. The value is never part of an error. */
async function fillAt(page: Page, step: string, selector: string, value: string) {
  const field = page.locator(selector).first();
  try {
    await field.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await field.fill(value, { timeout: STEP_TIMEOUT_MS });
  } catch {
    throw new SignInPageChanged(
      step,
      `${selector} did not appear or take input within ${STEP_TIMEOUT_S} s`,
      page
    );
  }
}

async function clickAt(page: Page, step: string, selector: string) {
  try {
    await page.locator(selector).first().click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    throw new SignInPageChanged(
      step,
      `${selector} could not be clicked within ${STEP_TIMEOUT_S} s`,
      page
    );
  }
}

/**
 * From Microsoft's first sign-in page to the app: UPN → Next → password →
 * Sign in → (choose the authenticator-app code if asked) → TOTP code →
 * "Stay signed in?" No. Returns when the browser is back on the app's origin.
 * On a failure it writes the sign-in diagnostic to `input.diagnosticPath`,
 * when set, and rethrows.
 */
export async function signInWithMicrosoft(page: Page, input: SignInInput): Promise<void> {
  // Every value typed, so the diagnostic can redact it should a page echo one.
  const typed: string[] = [];
  try {
    await signIn(page, input, typed);
  } catch (error) {
    if (input.diagnosticPath) {
      const written = await writeSignInDiagnostic(page, input.diagnosticPath, {
        failure: error,
        secrets: [
          input.upn,
          input.password,
          input.totpSecret,
          normalizeTotpSecret(input.totpSecret),
          ...typed,
        ],
      }).then(
        () => true,
        () => false
      );
      input.note?.(
        written
          ? `Sign-in diagnostic: ${input.diagnosticPath}`
          : 'Could not write the sign-in diagnostic'
      );
    }
    throw error;
  }
}

async function signIn(page: Page, input: SignInInput, typed: string[]): Promise<void> {
  const note = input.note ?? (() => undefined);
  const onApp = () => new URL(page.url()).origin === input.appOrigin;

  typed.push(input.upn);
  await fillAt(page, 'upn', MS.upn, input.upn);
  await clickAt(page, 'upn', MS.submit);

  const afterUpn = await firstOf(page, 'password', {
    password: page.locator(MS.password),
    usernameError: page.locator(MS.usernameError),
  });
  if (afterUpn === 'usernameError') {
    throw new Error('Microsoft does not know ACCEPTANCE_USER_UPN in this tenant (step upn)');
  }
  typed.push(input.password);
  await fillAt(page, 'password', MS.password, input.password);
  await clickAt(page, 'password', MS.submit);

  type Outcome = 'otc' | 'method' | 'otherWay' | 'passwordError' | 'otcError' | 'kmsi' | 'app';
  let next: Outcome = await firstOf(page, 'second factor', {
    otc: page.locator(MS.otc),
    method: page.locator(MS.otcMethod),
    otherWay: page.locator(MS.otherWay),
    passwordError: page.locator(MS.passwordError),
    kmsi: page.locator(MS.kmsi),
    app: onApp,
  });
  if (next === 'passwordError') {
    throw new Error('Microsoft rejected the password for ACCEPTANCE_USER_UPN (step password)');
  }
  if (next === 'otherWay') {
    // A push the run cannot approve: ask for another method instead.
    await clickAt(page, 'choose method', MS.otherWay);
    next = await firstOf(page, 'choose method', {
      method: page.locator(MS.otcMethod),
      otc: page.locator(MS.otc),
    });
  }
  if (next === 'method') {
    await clickAt(page, 'choose method', MS.otcMethod);
    next = await firstOf(page, 'totp', { otc: page.locator(MS.otc) });
  }
  if (next === 'otc') {
    // A code typed in its last seconds can expire before Microsoft checks it:
    // with under 5 s left, wait for the next window (at most 5.25 s).
    const left = msLeftInTotpWindow(Date.now());
    if (left < 5_000) {
      note(`Waiting ${((left + 250) / 1000).toFixed(1)} s for the next TOTP window`);
      await page.waitForTimeout(left + 250);
    }
    const code = totpCode(input.totpSecret, Date.now());
    typed.push(code);
    await fillAt(page, 'totp', MS.otc, code);
    try {
      await page.locator(MS.otc).first().press('Enter', { timeout: STEP_TIMEOUT_MS });
    } catch {
      throw new SignInPageChanged(
        'totp',
        `${MS.otc} did not take Enter within ${STEP_TIMEOUT_S} s`,
        page
      );
    }
    next = await firstOf(page, 'stay signed in', {
      kmsi: page.locator(MS.kmsi),
      otcError: page.locator(MS.otcError),
      app: onApp,
    });
    if (next === 'otcError') {
      throw new Error(
        'Microsoft rejected the TOTP code (step totp): check ACCEPTANCE_USER_TOTP_SECRET ' +
          "and this machine's clock"
      );
    }
  } else {
    note('Microsoft did not ask for a second factor on this sign-in');
  }
  if (next === 'kmsi') {
    await clickAt(page, 'stay signed in', MS.kmsiNo);
  }

  try {
    await page.waitForURL(url => url.origin === input.appOrigin, { timeout: STEP_TIMEOUT_MS });
  } catch {
    throw new SignInPageChanged(
      'return to app',
      `the browser did not come back to the app (${input.appOrigin}) within ${STEP_TIMEOUT_S} s`,
      page
    );
  }
}

// ---------------------------------------------------------------------------
// The sign-in diagnostic (HAR-121)

/**
 * What the diagnostic may read off a page. Deliberately narrow: no input
 * value, no cookie, no screenshot, no evaluate. A Playwright `Page` is one.
 */
export interface ProbePage {
  url(): string;
  title(): Promise<string>;
  locator(selector: string): ProbeLocator;
}
export interface ProbeLocator {
  count(): Promise<number>;
  first(): {
    isVisible(): Promise<boolean>;
    textContent(options?: { timeout?: number }): Promise<string | null>;
  };
}

export interface SignInDiagnosticInput {
  /** What failed. Only its name and first line are written, redacted. */
  readonly failure?: unknown;
  /** Removed wherever they appear: the UPN, password, TOTP secret, every value typed. */
  readonly secrets: readonly string[];
}

/** The longest error text kept from one container. */
const ERROR_TEXT_MAX = 300;

/**
 * A text snapshot of a sign-in page for telling a slow page from a changed
 * one: the URL's origin and path (no query, no fragment: they carry auth
 * state), the title, whether each `MS` selector is present and visible, and
 * the text of Microsoft's error containers. It never reads an input's value
 * and every secret in `secrets` is redacted, so even a page that echoes the
 * UPN in an error writes `[redacted]`.
 */
export async function signInDiagnostic(
  page: ProbePage,
  input: SignInDiagnosticInput
): Promise<string> {
  const lines = ['Microsoft sign-in diagnostic (HAR-121): no typed value, cookie or query string.'];
  if (input.failure !== undefined) lines.push(`failure: ${firstLine(input.failure)}`);
  lines.push(`url: ${originAndPath(page.url())}`);
  lines.push(`title: ${oneLine(await page.title().catch(() => '(unreadable)'))}`);

  lines.push('selectors (present, visible):');
  const width = Math.max(...Object.keys(MS).map(key => key.length));
  for (const [key, selector] of Object.entries(MS)) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => -1);
    const visible =
      count > 0
        ? await locator
            .first()
            .isVisible()
            .catch(() => false)
        : false;
    const present = count < 0 ? 'unreadable' : count > 0 ? `present (${count})` : 'absent';
    lines.push(
      `  ${key.padEnd(width)}  ${present}, ${visible ? 'visible' : 'hidden'}  ${selector}`
    );
  }

  lines.push('error text:');
  for (const [key, selector] of Object.entries(MS_ERROR_CONTAINERS)) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    // Present already, so this reads at once; the bound only stops a page
    // that is closing from holding up the failure.
    const text =
      count > 0
        ? await locator
            .first()
            .textContent({ timeout: 1_000 })
            .catch(() => null)
        : null;
    const shown = text === null || oneLine(text) === '' ? '(none)' : JSON.stringify(clip(text));
    lines.push(`  ${key}: ${shown}`);
  }
  return `${redact(lines.join('\n'), input.secrets)}\n`;
}

/** Write `signInDiagnostic` to `path`, creating its directory. */
export async function writeSignInDiagnostic(
  page: ProbePage,
  path: string,
  input: SignInDiagnosticInput
): Promise<void> {
  const text = await signInDiagnostic(page, input);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
}

function originAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? parsed.protocol : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(unreadable)';
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string): string {
  const line = oneLine(text);
  return line.length > ERROR_TEXT_MAX ? `${line.slice(0, ERROR_TEXT_MAX)}…` : line;
}

function firstLine(failure: unknown): string {
  const text = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
  return clip(text.split('\n')[0] ?? '');
}
