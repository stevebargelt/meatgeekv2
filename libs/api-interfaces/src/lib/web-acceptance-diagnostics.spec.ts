/**
 * HAR-126 (goal HAR-106): app-deploy-dev.yml's `web-acceptance` job uploads the
 * live browser proof's sign-in diagnostic (HAR-121) on failure, and only after
 * the job's leak check has passed on it.
 *
 * Like the other workflow guards in this lib, this is a repo-tooling invariant;
 * it lives here because api-interfaces runs on every CI push and its
 * test-repeat suite is selected by any change under .github/workflows/.
 *
 * Two halves:
 *   - the wiring: the leak check runs before the upload, is given the
 *     diagnostic glob, and the upload's `path` holds the same glob, gated on
 *     the check having finished;
 *   - the check itself (.github/scripts/web-acceptance-leak-check.cjs), run on
 *     fixture directories: a diagnostic with a finding is deleted and fails the
 *     check, a clean one passes and stays.
 *
 * No test here reads the clock: the TOTP cases pass a fixed `now` to run(),
 * and the CLI cases hold no 6-digit number, so their result cannot depend on
 * which 30 s window the real clock is in.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'app-deploy-dev.yml');
const SCRIPT = path.join(REPO_ROOT, '.github', 'scripts', 'web-acceptance-leak-check.cjs');

const DIAGNOSTIC_GLOB = 'dist/.playwright/web-e2e-live/test-results/**/sign-in-diagnostic.txt';
const SCREENSHOT_GLOB = 'dist/.playwright/web-e2e-live/test-results/**/*.png';

interface WfStep {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}
interface Workflow {
  jobs: Record<string, { steps?: WfStep[] }>;
}

const WF = yaml.load(fs.readFileSync(WORKFLOW, 'utf8')) as Workflow;
const STEPS = WF.jobs['web-acceptance']?.steps ?? [];

function stepIndex(pred: (s: WfStep) => boolean, what: string): number {
  const matches = STEPS.flatMap((s, i) => (pred(s) ? [i] : []));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${what} step in web-acceptance, found ${matches.length}`);
  }
  return matches[0];
}

const LEAK = stepIndex(s => s.id === 'leak-check', 'leak-check');
const UPLOADS = STEPS.flatMap((s, i) =>
  (s.uses ?? '').startsWith('actions/upload-artifact@') ? [i] : []
);
const UPLOAD = stepIndex(
  s => (s.uses ?? '').startsWith('actions/upload-artifact@'),
  'upload-artifact'
);

function pathLines(step: WfStep): string[] {
  return String(step.with?.['path'] ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

describe('app-deploy-dev.yml web-acceptance: leak check, then upload (HAR-126)', () => {
  it('runs the leak check before the upload, and uploads nowhere else', () => {
    expect(LEAK).toBeLessThan(UPLOAD);
    expect(UPLOADS).toEqual([UPLOAD]);
  });

  it("gives the leak check the proof's log and the diagnostic glob", () => {
    const step = STEPS[LEAK];
    expect(step.if).toBe('always()');
    const run = step.run ?? '';
    expect(run).toContain('node .github/scripts/web-acceptance-leak-check.cjs');
    expect(run).toContain('"$RUNNER_TEMP/web-acceptance.log"');
    expect(run).toContain(`'${DIAGNOSTIC_GLOB}'`);
    expect(Object.keys(step.env ?? {}).sort()).toEqual([
      'ACCEPTANCE_USER_PASSWORD',
      'ACCEPTANCE_USER_TOTP_SECRET',
    ]);
    // The proof writes its log there; the leak check must read that same file.
    const proof = STEPS.find(s => (s.run ?? '').includes('npx nx e2e-live web-e2e'));
    expect(proof?.run).toContain('tee "$RUNNER_TEMP/web-acceptance.log"');
  });

  it('uploads the screenshots and the diagnostic glob, on failure, only once the check finished', () => {
    const step = STEPS[UPLOAD];
    expect(pathLines(step)).toEqual([SCREENSHOT_GLOB, DIAGNOSTIC_GLOB]);
    expect(step.if).toBe("failure() && steps.leak-check.outputs.checked == 'true'");
    expect(step.with?.['name']).toBe('web-acceptance-diagnostics');
    expect(step.with?.['if-no-files-found']).toBe('ignore');
    expect(step.with?.['retention-days']).toBe(7);
  });

  // The step's own shell, run with `node` stubbed to exit with each code the
  // script can return: `checked` is set for 0 and 1 (every leaking diagnostic
  // deleted), never for 2 (the check could not vouch for what it matched).
  it.each([
    [0, true],
    [1, true],
    [2, false],
  ])('the step passes on node exit %i, and sets checked=%s', (rc, checked) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-check-step-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexit ${rc}\n`, { mode: 0o755 });
      const out = path.join(dir, 'github-output');
      fs.writeFileSync(out, '');
      const r = spawnSync('bash', ['-c', STEPS[LEAK].run ?? ''], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: dir, GITHUB_OUTPUT: out },
      });
      expect(r.status).toBe(rc);
      expect(fs.readFileSync(out, 'utf8')).toBe(checked ? 'checked=true\n' : '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no doc or workflow still names the old artifact', () => {
    const files = [
      ...fs.globSync('docs/**/*.md', { cwd: REPO_ROOT }),
      ...fs.globSync('.github/**/*.yml', { cwd: REPO_ROOT }),
      'README.md',
    ];
    const stale = files.filter(f =>
      fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').includes('web-acceptance-screenshots')
    );
    expect(stale).toEqual([]);
  });

  it("ci-cd.md's web-acceptance paragraph puts the leak check before the upload and names the diagnostic", () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/development/ci-cd.md'), 'utf8');
    const para = doc.split('\n').find(l => l.startsWith('**The web acceptance job (HAR-101).**'));
    expect(para).toBeDefined();
    // HAR-126 review: the check is no longer the job's last step, and it scans the diagnostics too.
    expect(para).not.toMatch(/The last step checks/);
    expect(para).toMatch(/sign-in-diagnostic\.txt/);
    expect(para).toMatch(/before the failure upload/);
  });
});

// ---------------------------------------------------------------------------
// The check itself
// ---------------------------------------------------------------------------

const FAKE_PASSWORD = 'Fake-Pa55word!';
// A made-up base32 secret, 10 bytes like Entra's.
const FAKE_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const NOW = 1_700_000_000;

// otplib's dependencies ship only ES modules, which this lib's Jest does not
// compile, so otplib (in the TOTP cases and in the script's run()) is only
// ever loaded by a plain `node`, as the workflow runs it.
function inNode<T>(code: string, input: unknown): T {
  // `node -e <code> <arg>`: the code reads its input as process.argv[1].
  const r = spawnSync(process.execPath, ['-e', code, JSON.stringify(input)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  });
  if (r.status !== 0) throw new Error(`node -e failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

/** The fake secret's TOTP code at each epoch, by the proof's own guardrails. */
function totp(...epochs: number[]): string[] {
  return inNode<string[]>(
    `const { createGuardrails, generateSync } = require('otplib');
     const guardrails = createGuardrails({ MIN_SECRET_BYTES: 1 });
     const { secret, epochs } = JSON.parse(process.argv[1]);
     process.stdout.write(JSON.stringify(
       epochs.map(epoch => generateSync({ secret, epoch, digits: 6, guardrails }))));`,
    { secret: FAKE_TOTP_SECRET, epochs }
  );
}

// The shape of a real diagnostic (apps/web-e2e/live/microsoft-sign-in.ts),
// with no 6-digit number in it.
const CLEAN = [
  'Microsoft sign-in diagnostic (HAR-121): no typed value, cookie or query string.',
  'failure: Microsoft sign-in page changed at step password: none of #i0118 appeared within 30 s',
  'page: https://login.microsoftonline.com/common/login',
  'title: Sign in to your account',
  'selector #i0116 upn: present, visible',
  'selector #i0118 password: absent',
  '#usernameError: [redacted] was not found',
].join('\n');

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let root: string;
const results = 'dist/.playwright/web-e2e-live/test-results';

function diag(test: string, text: string): string {
  const file = path.join(root, results, test, 'sign-in-diagnostic.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function cli(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [SCRIPT, path.join(root, 'web-acceptance.log'), DIAGNOSTIC_GLOB],
    {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', ...env },
    }
  );
}

/** The script's run(), on the fixed clock NOW. */
function runAt(opts: { password?: string; totpSecret?: string }): { code: number; out: string } {
  return inNode(
    `const o = JSON.parse(process.argv[1]);
     const lines = [];
     const code = require(o.script).run({ ...o, log: line => lines.push(line) });
     process.stdout.write(JSON.stringify({ code, out: lines.join('\\n') }));`,
    {
      script: SCRIPT,
      logPath: path.join(root, 'web-acceptance.log'),
      diagnosticGlob: DIAGNOSTIC_GLOB,
      password: opts.password ?? '',
      totpSecret: opts.totpSecret ?? '',
      now: NOW,
      cwd: root,
    }
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-check-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('web-acceptance-leak-check.cjs on a fixture directory (HAR-126)', () => {
  const env = {
    ACCEPTANCE_USER_PASSWORD: FAKE_PASSWORD,
    ACCEPTANCE_USER_TOTP_SECRET: FAKE_TOTP_SECRET,
  };

  it('finds a password in a diagnostic, deletes the file and fails, printing no secret', () => {
    fs.writeFileSync(path.join(root, 'web-acceptance.log'), 'PASS 1 open the app\n');
    const file = diag('proof-chromium', `${CLEAN}\n#passwordError: ${FAKE_PASSWORD} is wrong`);

    const r = cli(env);

    expect(r.status).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    const rel = path.join(results, 'proof-chromium', 'sign-in-diagnostic.txt');
    expect(r.stdout).toContain(`leak check: ${rel}: password: FOUND`);
    expect(r.stdout).toContain(`leak check: ${rel}: FAILED: password on line(s) 8`);
    expect(r.stdout).toContain(`leak check: ${rel}: deleted, so the upload cannot include it`);
    expect(r.stdout).toContain('leak check: proof log: password: none');
    expect(r.stdout + r.stderr).not.toContain(FAKE_PASSWORD);
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOTP_SECRET);
  });

  it('passes a clean diagnostic and leaves it for the upload', () => {
    fs.writeFileSync(path.join(root, 'web-acceptance.log'), 'PASS 1 open the app\n');
    const file = diag('proof-chromium', CLEAN);

    const r = cli(env);

    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(CLEAN);
    const rel = path.join(results, 'proof-chromium', 'sign-in-diagnostic.txt');
    // The window count is left out: it is the number of distinct codes, which
    // depends on the real clock this CLI run reads.
    for (const what of [
      'connection-string key field',
      'claim code',
      'PEM private key block',
      'JSON claimCode value',
      'password',
      'TOTP secret',
      'TOTP code',
    ]) {
      for (const label of [rel, 'proof log']) {
        expect(r.stdout).toMatch(
          new RegExp(
            `^leak check: ${reEscape(label)}: ${reEscape(what)}( \\(\\d+ windows\\))?: none$`,
            'm'
          )
        );
      }
    }
    expect(r.stdout).toContain(`leak check: ${rel}: passed (7 lines)`);
    expect(r.stdout).not.toContain('FOUND');
  });

  it('deletes only the diagnostic with a finding; a clean one next to it stays', () => {
    const bad = diag('a-chromium', `${CLEAN}\nHostName=h;DeviceId=d;SharedAccess${'K'}ey=abc`);
    const good = diag('b-chromium', CLEAN);

    const r = cli(env);

    expect(r.status).toBe(1);
    expect(fs.existsSync(bad)).toBe(false);
    expect(fs.existsSync(good)).toBe(true);
    expect(r.stdout).toContain('leak check: sign-in diagnostics: 2 matching');
    expect(r.stdout).toContain('connection-string key field: FOUND');
  });

  // HAR-138: a DPS-mode device's claim code (HAR-134), which nobody knows in
  // advance, is found by its shape; a UUID's dashed middle is not one.
  it('finds a claim code in the log and in a diagnostic, deleting that diagnostic', () => {
    const claimCode = ['7K3M', '9QXR', '2HTV'].join('-');
    const log = path.join(root, 'web-acceptance.log');
    fs.writeFileSync(log, `PASS 1\nclaimCode ${claimCode}\n`);
    const bad = diag('a-chromium', `${CLEAN}\n{"claimCode":"${claimCode}"}`);
    const good = diag('b-chromium', `${CLEAN}\ncook 6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b`);

    const r = cli(env);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('leak check: proof log: FAILED: claim code on line(s) 2');
    expect(fs.existsSync(bad)).toBe(false);
    expect(fs.existsSync(good)).toBe(true);
    expect(r.stdout).toContain(
      `leak check: ${path.join(results, 'a-chromium', 'sign-in-diagnostic.txt')}: claim code: FOUND`
    );
    expect(r.stdout).toContain(
      `leak check: ${path.join(results, 'b-chromium', 'sign-in-diagnostic.txt')}: claim code: none`
    );
    expect(r.stdout + r.stderr).not.toContain(claimCode);
  });

  // HAR-139: each simulated device holds its own private key, and its claim
  // code may be printed in a shape the claim-code scan does not know.
  it('finds a PEM private key block of any kind, in the log and in a diagnostic', () => {
    const begin = (kind: string) => `-----BEGIN ${kind}PRIVATE ${'K'}EY-----`;
    const log = path.join(root, 'web-acceptance.log');
    fs.writeFileSync(log, `PASS 1\n${begin('')}\nMIGHAgEAMBMG\n${begin('EC ')}\n`);
    const bad = diag('a-chromium', `${CLEAN}\n${begin('ENCRYPTED ')}`);
    const good = diag('b-chromium', `${CLEAN}\n-----BEGIN CERTIFICATE-----`);

    const r = cli(env);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      'leak check: proof log: FAILED: PEM private key block on line(s) 2, 4'
    );
    expect(fs.existsSync(bad)).toBe(false);
    expect(fs.existsSync(good)).toBe(true);
    expect(r.stdout).toContain(
      `leak check: ${path.join(results, 'a-chromium', 'sign-in-diagnostic.txt')}: PEM private key block: FOUND`
    );
    expect(r.stdout).toContain(
      `leak check: ${path.join(results, 'b-chromium', 'sign-in-diagnostic.txt')}: PEM private key block: none`
    );
    expect(r.stdout + r.stderr).not.toContain('MIGHAgEAMBMG');
  });

  it('finds a JSON claimCode string value of any shape, but not a null one', () => {
    const member = `"claim${'C'}ode"`;
    const log = path.join(root, 'web-acceptance.log');
    fs.writeFileSync(
      log,
      `PASS 1\n{${member}:"abc123"}\n{${member}: null}\n{"event":"claim", ${member} : "x"}\n`
    );

    const r = cli(env);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      'leak check: proof log: FAILED: JSON claimCode value on line(s) 2, 4'
    );
    expect(r.stdout + r.stderr).not.toContain('abc123');
  });

  it('fails on a leak in the log, and leaves a clean diagnostic (the log is not uploaded)', () => {
    const log = path.join(root, 'web-acceptance.log');
    fs.writeFileSync(log, `PASS 1\nsecret ${FAKE_TOTP_SECRET.toLowerCase()}\n`);
    const good = diag('proof-chromium', CLEAN);

    const r = cli(env);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('leak check: proof log: FAILED: TOTP secret on line(s) 2');
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.existsSync(good)).toBe(true);
  });

  it('checks the diagnostics when the proof wrote no log', () => {
    const file = diag('proof-chromium', `${CLEAN}\n${FAKE_PASSWORD}`);

    const r = cli(env);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('leak check: proof log: the proof did not run');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('passes with nothing to check: no log and no diagnostic', () => {
    const r = cli(env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('leak check: sign-in diagnostics: 0 matching');
  });

  it('exits 2 on a usage error', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('web-acceptance-leak-check.cjs TOTP windows, on a fixed clock', () => {
  it('finds a code from 30 min before the check, and the secret normalized from how it is stored', () => {
    const codeFile = diag('code-chromium', `${CLEAN}\nthe code was ${totp(NOW - 30 * 60)[0]}.`);
    const secretFile = diag('secret-chromium', `${CLEAN}\nkey ${FAKE_TOTP_SECRET}`);

    // Stored as an authenticator app shows it: lower case, in groups.
    const { code, out } = runAt({ password: FAKE_PASSWORD, totpSecret: 'jbsw y3dp ehpk 3pxp' });

    expect(code).toBe(1);
    expect(fs.existsSync(codeFile)).toBe(false);
    expect(fs.existsSync(secretFile)).toBe(false);
    expect(out).toMatch(/code-chromium\/sign-in-diagnostic\.txt: TOTP code \(\d+ windows\): FOUND/);
    expect(out).toMatch(/secret-chromium\/sign-in-diagnostic\.txt: TOTP secret: FOUND/);
  });

  it('ignores a code from outside the windows, and a code inside a longer number', () => {
    // A code from 3 h before NOW, which equals none of the window's codes.
    const epochs: number[] = [];
    for (let t = NOW - 35 * 60; t <= NOW + 60; t += 30) epochs.push(t);
    const [old, inWindow, ...window] = totp(NOW - 3 * 60 * 60, NOW, ...epochs);
    expect(window).toContain(inWindow);
    expect(window).not.toContain(old);
    const file = diag('proof-chromium', `${CLEAN}\nold ${old}\nid 9${inWindow}9`);

    const { code, out } = runAt({ password: FAKE_PASSWORD, totpSecret: FAKE_TOTP_SECRET });

    expect(code).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    expect(out).not.toContain('FOUND');
  });

  it('cannot finish on a TOTP secret it cannot decode: exits 2 and deletes every diagnostic', () => {
    const a = diag('a-chromium', CLEAN);
    const b = diag('b-chromium', CLEAN);

    const { code, out } = runAt({ password: FAKE_PASSWORD, totpSecret: '1!!!' });

    expect(code).toBe(2);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(out).toContain('leak check: could not finish (Error)');
    expect(out).not.toContain('1!!!');
  });
});
