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
 *
 * MG-23 REWORKS THE ENVIRONMENT MAP, and that rework is the point of this file
 * now. Before MG-23 every dev identity — plan, app-deploy, and (had it existed)
 * apply — federated the IDENTICAL subject `repo:<repo>:environment:development`.
 * Which identity a job actually assumed was decided ONLY by which client-id
 * string it passed to `azure/login`. That is not a boundary: a ONE-LINE
 * client-id edit merged to main silently upgrades a read-only job to a full
 * Contributor apply, and no GitHub Environment protection rule is ever
 * consulted. The map is now one environment per identity:
 *
 *   development-infra-apply  -> dev INFRA-APPLY identity (infra-apply-dev.yml)
 *   development              -> dev APP-DEPLOY identity  (MG-36)
 *   production               -> prod PLAN/READ identity  (both prod workflows)
 *
 * so the environment a job declares — and that environment's protection rules —
 * is what decides the privilege it can assume.
 *
 * THERE IS NO DEV PLAN ENVIRONMENT, AND NO FOURTH SUBJECT. As re-scoped on
 * 2026-07-27, PR validation is CREDENTIALLESS: it presents no OIDC subject at
 * all, because it holds no identity, binds no environment and is never granted
 * the token-minting permission. The dev plan identity that used to read live
 * state from a pull request is deleted rather than narrowed, so the strongest
 * assertion this file can make about the PR path is an ABSENCE — see the
 * "ci.yml is credentialless" test below. The PROD plan/read identity survives:
 * infra-deploy-prod.yml still authenticates as it under `production`.
 *
 * The MG-21 prod-deploy-split.spec.ts owns the workflow-YAML structural
 * invariants; this file owns only the cross-artifact subject-consistency
 * invariant. The two suites are intentionally non-duplicative.
 *
 * NOTE on jobs that bind an environment WITHOUT calling azure/login (the prod
 * `guard` job, and MG-23's recovery-approval gate): they consume the
 * environment's protection rules, not an identity. They present no OIDC subject,
 * so they are outside this suite's scope by construction — it keys off
 * azure/login steps.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const BOOTSTRAP = path.join(REPO_ROOT, 'apps', 'infrastructure', 'bootstrap', 'bootstrap.sh');

interface WfStep {
  uses?: string;
  run?: string;
  name?: string;
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

/**
 * A COMMITTED CONSTANT assigned as `VAR="literal"` in bootstrap.sh.
 *
 * MG-23 F16: GITHUB_REPO and the environment lists are no longer written as
 * `${VAR:-default}`. That form let an inherited environment variable re-point
 * the OIDC trust root of every identity at another repository, announced by
 * nothing but a log line. Parsing ONLY the constant form is deliberate — if
 * someone re-introduces the overridable form, this throws rather than silently
 * reading the default and pronouncing the suite green.
 */
function bashConstant(src: string, varName: string): string {
  if (new RegExp(`${varName}="\\$\\{${varName}:-`).test(src)) {
    throw new Error(
      `${varName} is env-overridable in bootstrap.sh (\${${varName}:-…}); it must be a committed constant (MG-23 F16)`
    );
  }
  const m = src.match(new RegExp(`^${varName}="([^"]*)"$`, 'm'));
  if (!m) throw new Error(`could not parse the ${varName} constant from bootstrap.sh`);
  return m[1].trim();
}

const bootstrapSrc = fs.readFileSync(BOOTSTRAP, 'utf8');

// The two sides of the invariant, parsed from source.
const githubRepo = bashConstant(bootstrapSrc, 'GITHUB_REPO');
const planIdentityEnvs = bashConstant(bootstrapSrc, 'PLAN_IDENTITY_ENVIRONMENTS')
  .split(/\s+/)
  .filter(Boolean);
const appDeployEnv = bashConstant(bootstrapSrc, 'APP_DEPLOY_ENVIRONMENT');
const infraApplyEnv = bashConstant(bootstrapSrc, 'INFRA_APPLY_ENVIRONMENT');

/**
 * The set of GitHub Environments an Azure identity federates.
 *
 * DERIVED HERE, exactly as bootstrap.sh derives GITHUB_ENVIRONMENTS — from the
 * three variables the identity functions actually read — rather than parsed
 * from GITHUB_ENVIRONMENTS itself.
 *
 * Why: GITHUB_ENVIRONMENTS used to be a hand-written literal that NO bootstrap
 * code expanded. Parsing it meant this suite asserted against a list that
 * nothing enforced, so the literal and the real federation loop could drift
 * apart with every test still green — the failure mode being an identity
 * federating a subject this suite never checked. Deriving from the enforcers
 * removes the second source of truth entirely.
 */
const federatedEnvs = Array.from(
  new Set([...planIdentityEnvs, appDeployEnv, infraApplyEnv].filter(Boolean))
).sort();
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

/**
 * Every workflow in the directory — GLOBBED, not a hardcoded list. A NEW
 * workflow that authenticates to Azure from an unfederated environment is
 * exactly the drift this suite exists to catch, and a hardcoded list would
 * silently exempt it. (MG-23's infra-apply-dev.yml is picked up this way.)
 */
const AZURE_WORKFLOWS = fs
  .readdirSync(WORKFLOWS)
  .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

describe('MG-24/MG-23: OIDC subject consistency (workflow ↔ bootstrap federated credentials)', () => {
  it('globs the workflow directory rather than trusting a hardcoded file list', () => {
    // Guard the guard: if the glob ever resolves to nothing, every cross-check
    // below would pass vacuously.
    expect(AZURE_WORKFLOWS.length).toBeGreaterThanOrEqual(4);
    expect(AZURE_WORKFLOWS).toEqual(expect.arrayContaining(['ci.yml', 'infra-apply-dev.yml']));
  });

  it('bootstrap federates EXACTLY three environments (MG-23), and never a bare dev', () => {
    // An EXACT-set assertion, deliberately not `arrayContaining`. A contains
    // check would still pass if a dev plan environment were re-added, which is
    // precisely the regression this re-scope exists to prevent.
    //
    // THREE FEDERATED, FOUR TOTAL — not a contradiction. This asserts on
    // FEDERATION, so it covers only environments backing an identity. The fourth
    // environment, `development-infra-apply-recovery`, is approval-only and
    // deliberately unfederated: it exists for its protection rules, and the
    // recovery_approval job that binds it has no id-token permission and never
    // calls azure/login. Federating it would mint it an identity, defeating it.
    // Topology table: docs/infrastructure/mg23-live-acceptance.md.
    expect([...federatedEnvs].sort()).toEqual([
      'development',
      'development-infra-apply',
      'production',
    ]);
    // The retired bare `dev` produced a subject no workflow job could match.
    expect(federatedEnvs).not.toContain('dev');
    // No dev plan environment, in any spelling.
    expect(federatedEnvs).not.toContain('development-infra-plan');
  });

  it('GITHUB_ENVIRONMENTS is DERIVED and ENFORCED, not a decorative literal', () => {
    // The map above is only worth asserting if bootstrap.sh actually builds and
    // uses it. GITHUB_ENVIRONMENTS was previously a hand-written list that no
    // code expanded: this suite and bootstrap.test.sh both asserted on it while
    // the real federation loop read three other variables, so the two could
    // drift apart silently. Both halves are pinned here.

    // (a) DERIVED — a command substitution over the enforcing variables, not a
    //     second hand-maintained list that can disagree with them.
    // Matched across lines: the derivation is a multi-line pipeline, so a
    // single-line `.*` would capture only its first continuation and miss two
    // of the three enforcers below.
    const assignment = bootstrapSrc.match(/^GITHUB_ENVIRONMENTS=("\$\([\s\S]*?\)")/m);
    expect(assignment).not.toBeNull();
    for (const enforcer of [
      'PLAN_IDENTITY_ENVIRONMENTS',
      'APP_DEPLOY_ENVIRONMENT',
      'INFRA_APPLY_ENVIRONMENT',
    ]) {
      expect(assignment?.[1]).toContain(enforcer);
    }

    // (b) ENFORCED — a fail-closed check exists AND main calls it, so two
    //     identities cannot silently collapse onto one environment (F8).
    expect(bootstrapSrc).toMatch(/^assert_federated_environment_map\(\) \{/m);
    expect(bootstrapSrc).toMatch(/^\s+assert_federated_environment_map$/m);
  });

  it('the two dev identities (apply, app-deploy) federate DISTINCT environments', () => {
    // This is the F8 invariant itself. If these collapse onto one environment,
    // the privilege a job assumes goes back to being decided by a client-id
    // string rather than by an environment protection rule.
    expect(appDeployEnv).toBe('development');
    expect(infraApplyEnv).toBe('development-infra-apply');
    expect(appDeployEnv).not.toBe(infraApplyEnv);

    // The plan identity is PROD-ONLY now. The prod plan/read identity survives
    // because infra-deploy-prod.yml still logs in as it under `production`.
    expect(planIdentityEnvs).toEqual(['production']);
    expect(planIdentityEnvs).not.toContain('development'); // NOT the app-deploy env
    expect(planIdentityEnvs).not.toContain(infraApplyEnv); // NOT the apply env

    const devSubjects = new Set(
      [infraApplyEnv, appDeployEnv].map(e => `repo:${githubRepo}:environment:${e}`)
    );
    expect(devSubjects.size).toBe(2);
    for (const s of devSubjects) expect(bootstrapSubjects).toContain(s);
  });

  it('GITHUB_REPO is a committed constant, not env-overridable (F16)', () => {
    // bashConstant throws on the `${VAR:-…}` form, so reaching here already
    // proves it; assert the parsed value too so a typo cannot pass.
    expect(githubRepo).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
    expect(bootstrapSrc).not.toMatch(/GITHUB_REPO="\$\{GITHUB_REPO:-/);
  });

  it('bootstrap builds the subject as repo:<repo>:environment:<env> (the OIDC-presented scheme)', () => {
    expect(bootstrapSrc).toMatch(/subject="repo:\$\{GITHUB_REPO\}:environment:\$\{env\}"/);
  });

  it('every Azure-authenticating job binds a GitHub Environment (so its OIDC subject is deterministic)', () => {
    // A job that calls azure/login with NO `environment:` presents a subject that
    // is not `…:environment:<env>` at all — it can never match a per-env
    // federated credential. Each such job must declare an environment, and that
    // environment must be one of the four in the map.
    let checked = 0;
    for (const file of AZURE_WORKFLOWS) {
      for (const { job, environment } of azureAuthedJobs(file)) {
        expect(`${file}:${job} environment=${environment}`).toMatch(
          new RegExp(`environment=(${federatedEnvs.join('|')})$`)
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0); // never pass by finding nothing
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

  it('ci.yml is CREDENTIALLESS: no environment, no OIDC token permission, no azure/login', () => {
    // REPLACES (and is strictly stronger than) the assertion that used to
    // require ci.yml's PR plan job to bind a dev plan environment. ci.yml is the
    // PR-reachable workflow, so any identity it can assume is reachable by
    // anyone who can open a pull request. The re-scope removed that identity
    // entirely rather than gating it, so the right invariant is no longer
    // "which environment does the PR job bind" — it is that there is NOTHING to
    // bind. Each of the four absences below is independently sufficient to stop
    // an Azure token being minted; asserting all four means a single-line edit
    // cannot quietly restore the credential path.
    const ci = readWorkflow('ci.yml');
    const raw = fs.readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8');

    // 1. No job binds a GitHub Environment at all.
    const ciEnvs = Object.values(ci.jobs ?? {})
      .map(j => j.environment)
      .filter(Boolean);
    expect(ciEnvs).toEqual([]);

    // 2. No job — and no workflow-level block — grants the OIDC token
    //    permission. Without it GitHub will not mint a federated token.
    expect(raw).not.toMatch(/id-token/);
    expect((ci as { permissions?: Record<string, string> }).permissions?.['id-token']).toBeUndefined();
    for (const job of Object.values(ci.jobs ?? {})) {
      expect((job as { permissions?: Record<string, string> }).permissions?.['id-token']).toBeUndefined();
    }

    // 3. Nothing authenticates to Azure.
    expect(raw).not.toMatch(/azure\/login/);
    expect(raw).not.toMatch(/secrets\.AZURE_/);

    // 4. And the property is PROVEN at runtime, not merely absent from the YAML.
    expect(raw).toContain('assert-credentialless.sh');
  });

  it('the post-merge apply job binds development-infra-apply, and ONLY that workflow does', () => {
    // The apply environment is where Contributor + conditioned RBAC-admin become
    // reachable. Exactly one workflow may bind it.
    const bindingFiles = AZURE_WORKFLOWS.filter(file =>
      Object.values(readWorkflow(file).jobs ?? {}).some(j => j.environment === infraApplyEnv)
    );
    expect(bindingFiles).toEqual(['infra-apply-dev.yml']);
    expect(bootstrapSubjects).toContain(`repo:${githubRepo}:environment:${infraApplyEnv}`);
  });

  it('dev and prod resolve to SEPARATE bootstrap subjects (no shared SP across environments)', () => {
    const prodSubject = `repo:${githubRepo}:environment:production`;
    expect(bootstrapSubjects).toContain(prodSubject);
    for (const devEnv of [infraApplyEnv, appDeployEnv]) {
      expect(`repo:${githubRepo}:environment:${devEnv}`).not.toBe(prodSubject);
    }

    // Both prod workflows authenticate under `production`, never a dev env.
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

  /**
   * SCRIPT-INJECTION GUARD — the other half of "which identity can a job assume".
   *
   * The assertions above prove a job can only assume the identity its environment
   * federates. That is worth nothing if an ATTACKER-SUPPLIED STRING can execute
   * arbitrary commands INSIDE that job, because then they get the identity too.
   *
   * A `${{ … }}` expression inside a `run:` block is substituted into the script
   * SOURCE by the runner BEFORE any shell parses it. When the expression resolves
   * to user-controlled text — a workflow_dispatch input, a PR title or branch
   * name, an issue body — a value like `'; <command>; echo '` closes the quote and
   * runs as a peer statement. On this repo's privileged paths that is command
   * execution as an identity holding Contributor + conditioned RBAC Administrator
   * on meatgeek-v2-dev-rg. Branch restrictions and reviewer gates narrow WHO can
   * reach such a job; they do not make the injection safe.
   *
   * THE SAFE FORM, and the only one this suite accepts: bind the expression to an
   * `env:` key (step- or job-level) and dereference it as a quoted shell variable.
   * The runner then passes the value through the process ENVIRONMENT, where the
   * shell treats it as DATA and never re-parses it as source. `env:` values are
   * therefore deliberately NOT flagged below — only `run:` bodies are.
   *
   * This globs every workflow, so it also covers workflows that do not exist yet.
   */
  describe('no untrusted `${{ }}` expression is interpolated into a `run:` script', () => {
    // Contexts an outside party can influence. `github.event.*` covers dispatch
    // inputs, PR titles/bodies/branch names and issue text; `inputs.*` is the
    // reusable-workflow/dispatch form; head_ref/ref_name/actor are attacker-
    // chosen on a PR-triggered run.
    const UNTRUSTED =
      /github\.event\b|(?:^|[^.\w])inputs\.|github\.head_ref|github\.ref_name|github\.actor|github\.triggering_actor/;

    /** Every `${{ … }}` expression appearing in a `run:` body, with provenance. */
    function runBlockExpressions(): Array<{ where: string; expr: string }> {
      const out: Array<{ where: string; expr: string }> = [];
      for (const file of AZURE_WORKFLOWS) {
        const wf = readWorkflow(file);
        for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
          for (const step of job.steps ?? []) {
            if (typeof step.run !== 'string') continue;
            const where = `${file}:${jobName}:${step.name ?? '(unnamed step)'}`;
            for (const m of step.run.matchAll(/\$\{\{([^}]*)\}\}/g)) {
              out.push({ where, expr: m[1].trim() });
            }
          }
        }
      }
      return out;
    }

    it('detects the unsafe form when it is present (positive control)', () => {
      // Guard the guard. If the matcher silently stopped matching, the assertion
      // below would pass by finding nothing and this suite would go green on a
      // live injection. Assert against a known-bad literal — the exact shape that
      // was flagged in review on infra-apply-dev.yml's recovery-approval step.
      expect(UNTRUSTED.test('github.event.inputs.authorized_changes')).toBe(true);
      expect(UNTRUSTED.test('inputs.authorized_changes')).toBe(true);
      expect(UNTRUSTED.test('github.head_ref')).toBe(true);
      // …and must NOT fire on the safe expressions real `run:` blocks do use.
      expect(UNTRUSTED.test('matrix.project')).toBe(false);
      expect(UNTRUSTED.test('env.NODE_VERSION')).toBe(false);
      expect(UNTRUSTED.test('vars.AZURE_CLIENT_ID')).toBe(false);
      expect(UNTRUSTED.test('steps.changed.outputs.infra')).toBe(false);
    });

    it('finds `run:` blocks to scan at all (never passes vacuously)', () => {
      expect(runBlockExpressions).toBeDefined();
      const anyRun = AZURE_WORKFLOWS.flatMap(f =>
        Object.values(readWorkflow(f).jobs ?? {}).flatMap(j =>
          (j.steps ?? []).filter(s => typeof s.run === 'string')
        )
      );
      expect(anyRun.length).toBeGreaterThan(10);
    });

    it('interpolates no attacker-controlled context into any `run:` body', () => {
      const offenders = runBlockExpressions()
        .filter(({ expr }) => UNTRUSTED.test(expr))
        .map(({ where, expr }) => `${where} -> \${{ ${expr} }}`);

      // The message matters: whoever trips this needs the fix, not just a red X.
      expect(offenders).toEqual([]);
    });

    it('binds the recovery destroy authorization through `env:`, the safe form', () => {
      // The specific site this guard was written for. Asserting the POSITIVE
      // shape as well as the absence of the negative means deleting the `env:`
      // binding fails here even if someone also deletes the scan above.
      const wf = readWorkflow('infra-apply-dev.yml');
      const step = (wf.jobs?.['recovery_approval']?.steps ?? []).find(
        s => typeof s.run === 'string'
      ) as (WfStep & { env?: Record<string, string> }) | undefined;
      expect(step).toBeDefined();
      const boundValues = Object.values(step?.env ?? {}).join(' ');
      expect(boundValues).toMatch(/github\.event\.inputs\.authorized_changes/);
      // The shell references the ENV VAR, quoted — data, not source.
      expect(step?.run).toMatch(/\$\{?AUTHORIZED_CHANGES\}?/);
      expect(step?.run).not.toMatch(/\$\{\{/);
    });
  });
});
