/**
 * Regression guard for MG-21 (CORRECTIVE model — "Option A") — the prod deploy
 * workflows are hardened so a push to `main` can never directly trigger a prod
 * deploy; a deploy only happens *after* the CI/CD Pipeline goes green on that
 * push, and only for the commit that is still the current main tip.
 *
 * Like the MG-20 guard next door, this is a *repo-tooling* invariant rather than
 * an api-interfaces behavior test. It lives here because api-interfaces is a leaf
 * shared lib already wired into the CI `lint-and-test` matrix
 * (`project: ['api','web','mobile','api-interfaces']`), so the guard runs on
 * every CI push, not just locally.
 *
 * Packaging validity of the built Functions artifact is a *separate* concern and
 * is covered by apps/api/src/verify-func-package.spec.ts (the invariants of the
 * `verify-func-package.js` validator the deploy job runs). This file owns only
 * the workflow-YAML invariants; the two suites are intentionally non-duplicative.
 *
 * What it protects (the MG-21 corrective invariants):
 *   app-deploy-prod.yml — auto-deploy the API only after a green CI run:
 *     - trigger is `workflow_run` on ['CI/CD Pipeline'], types [completed] — and
 *       there is NO `push` trigger and NO `workflow_dispatch` (a push must not
 *       reach prod without first passing CI).
 *     - the deploy job's `if` requires ALL of: the CI run's conclusion=='success',
 *       event=='push', head_branch=='main', AND vars.PROD_DEPLOY_ENABLED=='true'.
 *     - checkout pins `ref: github.event.workflow_run.head_sha` (the exact CI'd
 *       commit) rather than the default ref.
 *     - a stale-SHA guard step compares the CI'd head_sha to the current main tip
 *       and every subsequent (deploy) step is gated on its `fresh` output.
 *     - there is NO credential-guard job; `environment: production` appears ONLY
 *       on the deploy job, nowhere else.
 *     - Azure Functions Core Tools is pinned to an explicit version (never @latest).
 *   infra-deploy-prod.yml — manual/recovery, plan-only:
 *     - has `workflow_dispatch`, NO `push` trigger, and NO `terraform apply`
 *       anywhere (apply is deferred to MG-24 behind a remote state backend).
 *     - concurrency.cancel-in-progress === false (never cancel an in-flight apply).
 *     - a credential guard derives has_creds by reading AZURE_CREDENTIALS_PROD.
 *   ci.yml — the deploy-prod job is gone, while deploy-dev stays. The
 *     build-typescript artifact upload is RETAINED (deploy-dev downloads the
 *     api/web builds), and its workflow name is `CI/CD Pipeline` so the
 *     app-deploy-prod `workflow_run` trigger actually resolves.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');

interface WfStep {
  name?: string;
  id?: string;
  if?: string;
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
  name?: string;
  env?: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, WfJob>;
  [k: string]: unknown;
}

function rawWorkflow(file: string): string {
  return fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
}

function readWorkflow(file: string): Workflow {
  return yaml.load(rawWorkflow(file)) as Workflow;
}

/** The parsed `on:` mapping, tolerating a stray boolean-`true` key. */
function triggers(wf: Workflow): Record<string, unknown> {
  const on = (wf.on ?? (wf as Record<string, unknown>)[String(true)]) as unknown;
  return (on ?? {}) as Record<string, unknown>;
}

/**
 * The infra guard still gates on a real credential read: a prod infra run must be
 * blocked when the repo has no AZURE_CREDENTIALS_PROD secret. Asserting only that a
 * deploy job references `needs.guard.outputs.has_creds` is not enough — a guard job
 * hardcoded to emit `has_creds=true` would satisfy that yet still let
 * credential-less runs reach `azure/login`. So we verify the guard actually READS
 * the secret and DERIVES has_creds from its (non-)emptiness.
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

describe('MG-21: prod deploy split (corrective / Option A)', () => {
  describe('app-deploy-prod.yml (auto API deploy, gated on a green CI run)', () => {
    const wf = readWorkflow('app-deploy-prod.yml');
    const raw = rawWorkflow('app-deploy-prod.yml');
    const on = triggers(wf);
    const jobs = wf.jobs ?? {};
    const deploy = jobs['deploy-api'];
    const steps = deploy?.steps ?? [];

    it('triggers on workflow_run of "CI/CD Pipeline" (completed) only', () => {
      expect(Object.keys(on)).toContain('workflow_run');
      const workflowRun = (on['workflow_run'] ?? {}) as {
        workflows?: string[];
        types?: string[];
      };
      expect(workflowRun.workflows).toEqual(['CI/CD Pipeline']);
      expect(workflowRun.types).toEqual(['completed']);
    });

    it('has NO push trigger and NO workflow_dispatch (a push cannot reach prod directly)', () => {
      expect(Object.keys(on)).not.toContain('push');
      expect(Object.keys(on)).not.toContain('workflow_dispatch');
    });

    it('deploy job gate requires success + push + main + PROD_DEPLOY_ENABLED (all AND-ed)', () => {
      expect(deploy).toBeDefined();
      const cond = String(deploy?.if ?? '').replace(/\s+/g, ' ');
      expect(cond).toMatch(/github\.event\.workflow_run\.conclusion\s*==\s*'success'/);
      expect(cond).toMatch(/github\.event\.workflow_run\.event\s*==\s*'push'/);
      expect(cond).toMatch(/github\.event\.workflow_run\.head_branch\s*==\s*'main'/);
      expect(cond).toMatch(/vars\.PROD_DEPLOY_ENABLED\s*==\s*'true'/);
      // All four are required conjuncts — no `||` may weaken the gate.
      expect(cond).not.toContain('||');
    });

    it('checkout pins ref to the CI-run head_sha (not the default ref)', () => {
      const checkout = steps.find(
        s => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout')
      );
      expect(checkout).toBeDefined();
      expect(String((checkout?.with ?? {})['ref'] ?? '')).toMatch(
        /github\.event\.workflow_run\.head_sha/
      );
    });

    it('has a stale-SHA guard step, and every later (deploy) step is gated on its fresh output', () => {
      // The guard is the step that compares the CI'd SHA to the current main tip
      // and emits fresh=true|false.
      const guardStep = steps.find(
        s =>
          /fresh\s*=\s*true/.test(String(s.run ?? '')) &&
          /fresh\s*=\s*false/.test(String(s.run ?? ''))
      );
      expect(guardStep).toBeDefined();
      const freshId = guardStep?.id;
      expect(freshId).toBeTruthy();

      // It must actually read the CI'd head_sha and fetch the current main tip —
      // otherwise it isn't comparing the two SHAs at all.
      const guardText = `${Object.values(guardStep?.env ?? {})
        .map(String)
        .join('\n')}\n${String(guardStep?.run ?? '')}`;
      expect(guardText).toMatch(/github\.event\.workflow_run\.head_sha/);
      expect(guardText).toMatch(/\bmain\b/);

      // Every step after the guard (checkout, build, verify, login, deploy) is
      // gated on fresh == 'true' so a superseded commit is skipped, not deployed.
      const guardIdx = steps.indexOf(guardStep as WfStep);
      const laterSteps = steps.slice(guardIdx + 1);
      expect(laterSteps.length).toBeGreaterThan(0);
      const freshGate = new RegExp(`steps\\.${freshId}\\.outputs\\.fresh\\s*==\\s*'true'`);
      for (const s of laterSteps) {
        expect(String(s.if ?? '')).toMatch(freshGate);
      }

      // ...and the actual deploy step is one of them.
      const deployStep = laterSteps.find(s => /nx deploy api/.test(String(s.run ?? '')));
      expect(deployStep).toBeDefined();
    });

    it('has NO credential-guard job (no guard job, no has_creds output)', () => {
      expect(jobs).not.toHaveProperty('guard');
      for (const job of Object.values(jobs)) {
        expect(job.outputs ?? {}).not.toHaveProperty('has_creds');
      }
    });

    it('binds environment: production ONLY to the deploy job (deploy-api), nowhere else', () => {
      const jobsWithEnv = Object.entries(jobs).filter(([, j]) => j.environment !== undefined);
      expect(jobsWithEnv.map(([name]) => name)).toEqual(['deploy-api']);
      expect(deploy?.environment).toBe('production');
      // Belt-and-braces against a stray environment: line anywhere in the file.
      const envLines = raw.match(/^\s*environment:\s*production\b/gm) ?? [];
      expect(envLines.length).toBe(1);
    });

    it('pins Azure Functions Core Tools to a concrete version (never @latest)', () => {
      const version = String((wf.env ?? {})['FUNC_CORE_TOOLS_VERSION'] ?? '');
      expect(version).toMatch(/^\d+\.\d+/); // e.g. 4.12.1 — a real version, not a tag
      expect(version).not.toBe('latest');

      const pinStep = steps.find(s => /azure-functions-core-tools@/.test(String(s.run ?? '')));
      expect(pinStep).toBeDefined();
      const pinRun = String(pinStep?.run ?? '');
      expect(pinRun).not.toMatch(/azure-functions-core-tools@latest\b/);
      // The install references the pinned version — either the env var or a literal.
      expect(pinRun).toMatch(
        /azure-functions-core-tools@(\$\{\{\s*env\.FUNC_CORE_TOOLS_VERSION\s*\}\}|\d+\.\d+)/
      );
    });

    it('never cancels an in-flight app deploy', () => {
      expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
    });
  });

  describe('infra-deploy-prod.yml (manual/recovery, plan-only)', () => {
    const wf = readWorkflow('infra-deploy-prod.yml');
    const raw = rawWorkflow('infra-deploy-prod.yml');
    const on = triggers(wf);

    it('is manual-only: has workflow_dispatch and NO push trigger', () => {
      expect(Object.keys(on)).toContain('workflow_dispatch');
      // A push trigger here is the exact footgun MG-21 avoids until MG-24 wires
      // a terraform remote backend.
      expect(Object.keys(on)).not.toContain('push');
    });

    it('is plan-only: NO `terraform apply` step anywhere (deferred to MG-24)', () => {
      const jobs = wf.jobs ?? {};
      const hasApplyStep = Object.values(jobs).some(job =>
        (job.steps ?? []).some(s => /terraform\s+apply\b/.test(String(s.run ?? '')))
      );
      expect(hasApplyStep).toBe(false);
      // Raw-text backstop: no apply hiding in a comment-stripped-but-live command.
      expect(raw).not.toMatch(/terraform\s+apply\b/);
    });

    it('never cancels an in-flight infra apply', () => {
      expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
    });

    it('guard derives has_creds by reading AZURE_CREDENTIALS_PROD (not hardcoded)', () => {
      assertGuardDerivesCredsFromSecret(wf);
    });

    it('gates the deploy job on the guard credential check', () => {
      const jobs = wf.jobs ?? {};
      const gated = Object.values(jobs).filter(
        j => typeof j.if === 'string' && /needs\.guard\.outputs\.has_creds\s*==\s*'true'/.test(j.if)
      );
      expect(gated.length).toBeGreaterThanOrEqual(1);
      for (const j of gated) {
        const needs = Array.isArray(j.needs) ? j.needs : [j.needs];
        expect(needs).toContain('guard');
      }
    });
  });

  describe('ci.yml (deploy-prod removed, deploy-dev retained)', () => {
    const wf = readWorkflow('ci.yml');
    const jobs = wf.jobs ?? {};

    it('is named "CI/CD Pipeline" so app-deploy-prod\'s workflow_run trigger resolves', () => {
      // The app-deploy-prod trigger keys off this exact workflow name.
      expect(wf.name).toBe('CI/CD Pipeline');
    });

    it('no longer contains a deploy-prod job', () => {
      expect(jobs).not.toHaveProperty('deploy-prod');
    });

    it('still contains the deploy-dev job (only prod was split out)', () => {
      expect(jobs).toHaveProperty('deploy-dev');
    });

    it('retains the build-artifact upload that feeds deploy-dev', () => {
      // The upload lives on the build-typescript matrix job, so its `name` is the
      // templated `${{ matrix.app }}-build`, never a literal `api-build`; scan for
      // the upload step itself, not a resolved artifact name.
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
