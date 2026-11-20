import type { Locator, Page } from '@playwright/test';
import { msLeftInTotpWindow, totpCode } from './helpers';

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

/** How long each sign-in page may take to show its element. */
export const STEP_TIMEOUT_MS = 30_000;

export interface SignInInput {
  readonly upn: string;
  readonly password: string;
  readonly totpSecret: string;
  /** The app's origin: back there means signed in. */
  readonly appOrigin: string;
  /** Called with a short note for the log; never a value that was typed. */
  readonly note?: (message: string) => void;
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
        `none of ${keys.join(', ')} appeared within ${STEP_TIMEOUT_MS / 1000} s`,
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
    throw new SignInPageChanged(step, `${selector} did not appear or take input`, page);
  }
}

async function clickAt(page: Page, step: string, selector: string) {
  try {
    await page.locator(selector).first().click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    throw new SignInPageChanged(step, `${selector} could not be clicked`, page);
  }
}

/**
 * From Microsoft's first sign-in page to the app: UPN → Next → password →
 * Sign in → (choose the authenticator-app code if asked) → TOTP code →
 * "Stay signed in?" No. Returns when the browser is back on the app's origin.
 */
export async function signInWithMicrosoft(page: Page, input: SignInInput): Promise<void> {
  const note = input.note ?? (() => undefined);
  const onApp = () => new URL(page.url()).origin === input.appOrigin;

  await fillAt(page, 'upn', MS.upn, input.upn);
  await clickAt(page, 'upn', MS.submit);

  const afterUpn = await firstOf(page, 'password', {
    password: page.locator(MS.password),
    usernameError: page.locator(MS.usernameError),
  });
  if (afterUpn === 'usernameError') {
    throw new Error('Microsoft does not know ACCEPTANCE_USER_UPN in this tenant (step upn)');
  }
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
    // A code typed in its last seconds can expire before Microsoft checks it.
    const left = msLeftInTotpWindow(Date.now());
    if (left < 5_000) await page.waitForTimeout(left + 250);
    await fillAt(page, 'totp', MS.otc, totpCode(input.totpSecret, Date.now()));
    try {
      await page.locator(MS.otc).first().press('Enter', { timeout: STEP_TIMEOUT_MS });
    } catch {
      throw new SignInPageChanged('totp', `${MS.otc} did not take Enter`, page);
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
    throw new SignInPageChanged('return to app', 'the browser did not come back to the app', page);
  }
}
