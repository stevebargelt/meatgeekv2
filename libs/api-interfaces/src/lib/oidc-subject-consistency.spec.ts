/**
 * Regression guard for the MG-24 red-fix: "Dev CI OIDC token subject cannot
 * match the dev identity created by bootstrap."
 *
 * The dev deploy job authenticates to Azure via OIDC (`azure/login`). GitHub
 * mints a token whose SUBJECT is `repo:<owner>/<repo>:environment:<env>`, where
 * `<env>` is the job's declared `environment:`. That subject must EXACTLY match
 * a federated-identity-credential subject that
 * `apps/infrastructure/bootstrap/bootstrap.sh` creates — otherwise Azure rejects
 * the token and dev auth fails closed. The original bug was a silent DRIFT:
 * bootstrap federated `…:environment:dev` while the workflow declared
 * `environment: development`, so the two never matched.
 *
 * This suite is the deterministic anti-drift gate. It parses BOTH sides — the
 * workflow YAML and bootstrap.sh — and asserts, per environment, that every
 * Azure-authenticating job's presented OIDC subject is one the bootstrap
 * actually federates. It lives in api-interfaces (a leaf lib already wired into
 * the CI `lint-and-test` matrix) so it runs on every push, not just locally.
 *
 * Canonical subject scheme (do not drift):
 *   subject = repo:<owner>/<repo>:environment:<github-env>
 *   github-env ∈ { development, production }   (full words — the workflow
 *   `environment:` values), mapping to the short Terraform/state env dev/prod.
 *
 * The MG-21 prod-deploy-split.spec.ts owns the workflow-YAML structural
 * invariants; this file owns only the cross-artifact subject-consistency
 * invariant. The two suites are intentionally non-duplicative.
 *
 * MG-24 corrective item 4 (two-identity separation) does NOT change this
 * invariant. The OIDC subject is derived from the job's `environment:`, not from
 * WHICH service-principal client-id the login presents. Both the plan/read
 * identity (`vars.AZURE_CLIENT_ID`) and the app-deployment identity
 * (`vars.AZURE_APP_DEPLOY_CLIENT_ID`) bind the SAME per-environment GitHub
 * Environment, so both present the same bootstrap-federated subject — bootstrap
 * federates the subject once per environment and both SPs authenticate under it.
 * prod-deploy-split.spec.ts owns the which-identity assertion; this suite only
 * guards that the identity swap did not drop the `environment:` binding (which
 * would break the subject). The DEV_TF_BACKEND_READY gate is likewise invisible
 * here — the job still declares `environment: development` regardless of its
 * `if:` gate, so its subject is unchanged.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const BOOTSTRAP = path.join(REPO_ROOT, 'apps', 'infrastructure', 'bootstrap', 'bootstrap.sh');

interface WfStep {
  uses?: string;
}
interface WfJob {
  environment?: string;
  steps?: WfStep[];
}
interface Workflow {
  jobs?: Record<string, WfJob>;
}

function readWorkflow(file: string): Workflow {
  return yaml.load(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8')) as Workflow;
}

/** A default assigned via bash `${VAR:-default}` in bootstrap.sh. */
function bashDefault(src: string, varName: string): string {
  const m = src.match(new RegExp(`${varName}="\\$\\{${varName}:-([^}]*)\\}"`));
  if (!m) throw new Error(`could not parse ${varName} default from bootstrap.sh`);
  return m[1].trim();
}

const bootstrapSrc = fs.readFileSync(BOOTSTRAP, 'utf8');

// The two sides of the invariant, parsed from source.
const githubRepo = bashDefault(bootstrapSrc, 'GITHUB_REPO');
const federatedEnvs = bashDefault(bootstrapSrc, 'GITHUB_ENVIRONMENTS').split(/\s+/).filter(Boolean);
const bootstrapSubjects = new Set(
  federatedEnvs.map(env => `repo:${githubRepo}:environment:${env}`)
);

/** Every job (name, env) across a workflow that has an azure/login step. */
function azureAuthedJobs(file: string): Array<{ job: string; environment?: string }> {
  const wf = readWorkflow(file);
  const out: Array<{ job: string; environment?: string }> = [];
  for (const [name, job] of Object.entries(wf.jobs ?? {})) {
    const usesLogin = (job.steps ?? []).some(
      s => typeof s.uses === 'string' && s.uses.startsWith('azure/login')
    );
    if (usesLogin) out.push({ job: name, environment: job.environment });
  }
  return out;
}

const AZURE_WORKFLOWS = ['ci.yml', 'infra-deploy-prod.yml', 'app-deploy-prod.yml'];

describe('MG-24: OIDC subject consistency (workflow ↔ bootstrap federated credentials)', () => {
  it('bootstrap federates the canonical full-word GitHub Environments (development, production), not bare dev', () => {
    // The retired bare `dev` is exactly what produced a subject the workflow's
    // `environment: development` job could never match.
    expect(federatedEnvs).toEqual(expect.arrayContaining(['development', 'production']));
    expect(federatedEnvs).not.toContain('dev');
  });

  it('bootstrap builds the subject as repo:<repo>:environment:<env> (the OIDC-presented scheme)', () => {
    expect(bootstrapSrc).toMatch(/subject="repo:\$\{GITHUB_REPO\}:environment:\$\{env\}"/);
  });

  it('every Azure-authenticating job binds a GitHub Environment (so its OIDC subject is deterministic)', () => {
    // A job that calls azure/login with NO `environment:` presents a subject that
    // is not `…:environment:<env>` at all — it can never match a per-env
    // federated credential. Each such job must declare an environment.
    for (const file of AZURE_WORKFLOWS) {
      for (const { job, environment } of azureAuthedJobs(file)) {
        expect(`${file}:${job} environment=${environment}`).toMatch(
          /environment=(development|production)/
        );
      }
    }
  });

  it('every Azure-authenticating job presents an OIDC subject the bootstrap federates', () => {
    for (const file of AZURE_WORKFLOWS) {
      for (const { environment } of azureAuthedJobs(file)) {
        const subject = `repo:${githubRepo}:environment:${environment}`;
        // The core cross-check: the presented subject MUST be a bootstrap-created
        // federated subject, per environment.
        expect(bootstrapSubjects).toContain(subject);
      }
    }
  });

  it('dev (ci.yml deploy-dev) and prod (infra/app-deploy-prod) resolve to SEPARATE bootstrap subjects', () => {
    const ci = readWorkflow('ci.yml');
    expect(ci.jobs?.['deploy-dev']?.environment).toBe('development');
    const devSubject = `repo:${githubRepo}:environment:development`;
    const prodSubject = `repo:${githubRepo}:environment:production`;
    expect(bootstrapSubjects).toContain(devSubject);
    expect(bootstrapSubjects).toContain(prodSubject);
    expect(devSubject).not.toBe(prodSubject); // no shared SP/subject across envs

    // Both prod workflows authenticate under `production`, never `development`.
    for (const file of ['infra-deploy-prod.yml', 'app-deploy-prod.yml']) {
      for (const { environment } of azureAuthedJobs(file)) {
        expect(environment).toBe('production');
      }
    }
  });

  it('app-deploy-prod func-publish keeps its production environment after the two-identity swap (item 4)', () => {
    // MG-24 item 4 swaps the func-publish login to the app-deployment identity
    // (AZURE_APP_DEPLOY_CLIENT_ID). That is a DIFFERENT service principal, but its
    // OIDC subject is still `…:environment:production` — the subject is env-derived,
    // not identity-derived. Guard that the swap did not drop the `environment:`
    // binding, which would leave the login with a non-bootstrap-federated subject.
    const authedJobs = azureAuthedJobs('app-deploy-prod.yml');
    expect(authedJobs.length).toBeGreaterThan(0);
    const prodSubject = `repo:${githubRepo}:environment:production`;
    for (const { environment } of authedJobs) {
      expect(environment).toBe('production');
      expect(bootstrapSubjects).toContain(`repo:${githubRepo}:environment:${environment}`);
    }
    expect(bootstrapSubjects).toContain(prodSubject);
  });
});
