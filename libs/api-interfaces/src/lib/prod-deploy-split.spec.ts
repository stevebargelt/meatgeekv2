/**
 * Regression guard for MG-21 — split prod deploy out of ci.yml into two
 * dedicated, credential-gated workflows.
 *
 * Like the MG-20 guard next door, this is a *repo-tooling* invariant rather than
 * an api-interfaces behavior test. It lives here because api-interfaces is a leaf
 * shared lib already wired into the CI `lint-and-test` matrix
 * (`project: ['api','web','mobile','api-interfaces']`), so the guard runs on
 * every CI push, not just locally.
 *
 * What it protects (the MG-21 split invariants):
 *   infra-deploy-prod.yml — manual/recovery only:
 *     - has `workflow_dispatch`, and NO `push` trigger (a path-triggered
 *       terraform apply against empty local state would recreate all prod infra;
 *       deferred to MG-24 behind a remote backend).
 *     - concurrency.cancel-in-progress === false (never cancel an in-flight
 *       infra apply).
 *   app-deploy-prod.yml — auto-deploy the API on merge to main:
 *     - push.branches includes `main`.
 *     - push.paths === ['apps/api/**','libs/**'] exactly — NO 'apps/web/**'
 *       (prod is API-only; web/Static-Web-Apps is dev-only).
 *     - has `workflow_dispatch` for manual re-runs.
 *     - concurrency.cancel-in-progress === false.
 *     - a deploy job gated on `needs.guard.outputs.has_creds == 'true'`.
 *   ci.yml — the deploy-prod job is gone, while deploy-dev stays. The
 *     build-typescript artifact upload is RETAINED (not removed): deploy-dev
 *     downloads the api/web builds to deploy them, so the upload is a required
 *     develop-deploy dependency, not orphaned prod-only tooling.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');

interface WfStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
}
interface WfJob {
  needs?: string | string[];
  if?: string;
  environment?: string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  outputs?: Record<string, unknown>;
  steps?: WfStep[];
}
interface Workflow {
  // `on:` is a string key under the YAML 1.2 core schema js-yaml v4 uses by
  // default, but guard against the YAML 1.1 boolean-`on` reading just in case.
  on?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, WfJob>;
  [k: string]: unknown;
}

function readWorkflow(file: string): Workflow {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8')) as Workflow;
}

/** The parsed `on:` mapping, tolerating a stray boolean-`true` key. */
function triggers(wf: Workflow): Record<string, unknown> {
  const on = (wf.on ?? (wf as Record<string, unknown>)[String(true)]) as unknown;
  return (on ?? {}) as Record<string, unknown>;
}

/**
 * The real teeth of MG-21: a prod deploy must be blocked when the repo has no
 * AZURE_CREDENTIALS_PROD secret. Asserting only that a deploy job references
 * `needs.guard.outputs.has_creds` (as the gating tests below do) is not enough —
 * a guard job hardcoded to emit `has_creds=true` would satisfy that yet still let
 * credential-less pushes reach `azure/login` and fail the deploy. So we verify the
 * guard actually READS the secret and DERIVES has_creds from its (non-)emptiness.
 */
function assertGuardDerivesCredsFromSecret(wf: Workflow): void {
  const jobs = wf.jobs ?? {};
  const guard = jobs['guard'];
  expect(guard).toBeDefined();

  // (1) has_creds is wired to a check step's output, not a literal in the map.
  const output = String((guard?.outputs ?? {})['has_creds'] ?? '');
  const idMatch = output.match(/steps\.([A-Za-z0-9_-]+)\.outputs\.has_creds/);
  expect(idMatch).toBeTruthy();
  const checkId = idMatch?.[1];

  // (2) that check step exists.
  const check = (guard?.steps ?? []).find(s => s.id === checkId);
  expect(check).toBeDefined();

  // (3) the step exposes AZURE_CREDENTIALS_PROD — via an env binding or a run ref.
  const secretEnvEntry = Object.entries(check?.env ?? {}).find(([, v]) =>
    /secrets\.AZURE_CREDENTIALS_PROD/.test(String(v))
  );
  const run = String(check?.run ?? '');
  const secretInRun = /AZURE_CREDENTIALS_PROD/.test(run);
  expect(Boolean(secretEnvEntry) || secretInRun).toBe(true);

  // (4) has_creds is DERIVED from the secret, not hardcoded. The run must set
  //     has_creds on BOTH branches and test the credential value for
  //     (non-)emptiness — a guard hardcoded to `has_creds=true` fails all three.
  const credVar = secretEnvEntry?.[0];
  expect(run).toMatch(/has_creds\s*=\s*true/);
  expect(run).toMatch(/has_creds\s*=\s*false/);
  const emptinessTest = credVar
    ? new RegExp(`-[nz]\\s+"?\\$\\{?${credVar}\\b`)
    : /-[nz]\s+"?\$\{?\{?\s*secrets\.AZURE_CREDENTIALS_PROD/;
  expect(run).toMatch(emptinessTest);
}

/** A deploy job must gate on `needs.guard.outputs.has_creds == 'true'`. */
function assertDeployGatedOnGuard(wf: Workflow): void {
  const jobs = wf.jobs ?? {};
  const gated = Object.values(jobs).filter(
    j => typeof j.if === 'string' && /needs\.guard\.outputs\.has_creds\s*==\s*'true'/.test(j.if)
  );
  expect(gated.length).toBeGreaterThanOrEqual(1);
  for (const j of gated) {
    const needs = Array.isArray(j.needs) ? j.needs : [j.needs];
    expect(needs).toContain('guard');
  }
}

describe('MG-21: prod deploy split', () => {
  describe('infra-deploy-prod.yml (manual/recovery only)', () => {
    const wf = readWorkflow('infra-deploy-prod.yml');
    const on = triggers(wf);

    it('is manual-only: has workflow_dispatch and NO push trigger', () => {
      expect(Object.keys(on)).toContain('workflow_dispatch');
      // A push trigger here is the exact footgun MG-21 avoids until MG-24 wires
      // a terraform remote backend.
      expect(Object.keys(on)).not.toContain('push');
    });

    it('never cancels an in-flight infra apply', () => {
      expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
    });

    it('guard derives has_creds by reading AZURE_CREDENTIALS_PROD (not hardcoded)', () => {
      assertGuardDerivesCredsFromSecret(wf);
    });

    it('gates the deploy job on the guard credential check', () => {
      assertDeployGatedOnGuard(wf);
    });
  });

  describe('app-deploy-prod.yml (auto API deploy on merge)', () => {
    const wf = readWorkflow('app-deploy-prod.yml');
    const on = triggers(wf);
    const push = (on['push'] ?? {}) as { branches?: string[]; paths?: string[] };

    it('triggers on push to main', () => {
      expect(on).toHaveProperty('push');
      expect(push.branches).toContain('main');
    });

    it('is API-only: push.paths is exactly apps/api/** and libs/** (no apps/web/**)', () => {
      expect(push.paths).toEqual(['apps/api/**', 'libs/**']);
      expect(push.paths).not.toContain('apps/web/**');
    });

    it('also allows manual dispatch', () => {
      expect(Object.keys(on)).toContain('workflow_dispatch');
    });

    it('never cancels an in-flight app deploy', () => {
      expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
    });

    it('gates the deploy job on the guard credential check', () => {
      const jobs = wf.jobs ?? {};
      const gated = Object.values(jobs).filter(
        j => typeof j.if === 'string' && /needs\.guard\.outputs\.has_creds\s*==\s*'true'/.test(j.if)
      );
      expect(gated.length).toBeGreaterThanOrEqual(1);
      // The gated job must actually depend on the guard job that produces the output.
      for (const j of gated) {
        const needs = Array.isArray(j.needs) ? j.needs : [j.needs];
        expect(needs).toContain('guard');
      }
      // ...and the guard job must expose has_creds.
      expect(jobs['guard']?.outputs).toHaveProperty('has_creds');
    });

    it('guard derives has_creds by reading AZURE_CREDENTIALS_PROD (not hardcoded)', () => {
      assertGuardDerivesCredsFromSecret(wf);
    });
  });

  describe('ci.yml (deploy-prod removed, deploy-dev retained)', () => {
    const wf = readWorkflow('ci.yml');
    const jobs = wf.jobs ?? {};

    it('no longer contains a deploy-prod job', () => {
      expect(jobs).not.toHaveProperty('deploy-prod');
    });

    it('still contains the deploy-dev job (only prod was split out)', () => {
      expect(jobs).toHaveProperty('deploy-dev');
    });

    it('retains the build-artifact upload that feeds deploy-dev', () => {
      // MG-21 corrected AC: the build artifacts are RETAINED for deploy-dev — only
      // deploy-prod was split out. The upload lives on the build-typescript matrix
      // job, so its `name` is the templated `${{ matrix.app }}-build`, never a literal
      // `api-build`; scan for the upload step itself, not a resolved artifact name.
      const uploadsBuild = Object.values(jobs).some(job =>
        (job.steps ?? []).some(
          s =>
            typeof s.uses === 'string' &&
            s.uses.startsWith('actions/upload-artifact') &&
            /(\{\{\s*matrix\.app\s*\}\}|api|web)-build/.test(String((s.with ?? {})['name'] ?? ''))
        )
      );
      expect(uploadsBuild).toBe(true);
    });

    it('deploy-dev downloads both build artifacts it deploys (api + web)', () => {
      // deploy-dev deploys the API (`nx deploy api`) and dist/apps/web (static web
      // apps); each build comes from a separate matrix runner, so both must be
      // downloaded explicitly for the develop deploy to have its inputs.
      const downloaded = new Set(
        (jobs['deploy-dev']?.steps ?? [])
          .filter(s => typeof s.uses === 'string' && s.uses.startsWith('actions/download-artifact'))
          .map(s => String((s.with ?? {})['name'] ?? ''))
      );
      expect(downloaded).toContain('api-build');
      expect(downloaded).toContain('web-build');
    });
  });
});
