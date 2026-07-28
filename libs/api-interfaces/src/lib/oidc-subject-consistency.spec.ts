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
 *   subject = <sub_claim_prefix>:environment:<github-env>
 *
 * MG-42 MADE THE PREFIX A RUNTIME FACT, NOT A CONSTANT. GitHub lets a repo/org
 * customize the OIDC `sub` claim, and this one does: the live customization
 * injects the numeric owner-id and repo-id, so the prefix an Actions token
 * actually carries is `repo:<owner>@<owner-id>/<repo>@<repo-id>`, not
 * `repo:<owner>/<repo>`. bootstrap.sh hardcoded the latter, so Entra matched no
 * federated identity record and every azure/login failed AADSTS700213. It now
 * READS the prefix from `repos/<repo>/actions/oidc/customization/sub` and PROVES
 * the answer names the committed GITHUB_REPO before using it.
 *
 * What that means for THIS suite: the prefix is no longer knowable from source,
 * so the invariant it owns — "the environment a job declares is one the
 * bootstrap federates" — is asserted under BOTH prefix shapes below. The env
 * suffix is the part this file can and does pin; the prefix half is proven
 * behaviourally by running bootstrap.sh's own resolver against a stubbed `gh`.
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
import { spawnSync } from 'child_process';
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

/**
 * The two prefix shapes a federated subject can legitimately carry (MG-42).
 *
 * DEFAULT is what GitHub mints for a repo with no `sub` customization. CUSTOM is
 * the shape THIS repo presents — owner-id and repo-id injected — captured live
 * on 2026-07-27 as `repo:stevebargelt@4857343/meatgeekv2@1304558512`.
 *
 * Every cross-check below runs under BOTH. Pinning only the default form would
 * re-assert the exact assumption MG-42 disproved; pinning only the custom form
 * would hardcode two account-specific ids into an anti-drift suite. What this
 * file actually owns is the ENVIRONMENT half of the subject, and that half must
 * hold whichever prefix the live repo turns out to have.
 */
const [repoOwner, repoName] = githubRepo.split('/');
const DEFAULT_PREFIX = `repo:${githubRepo}`;
const CUSTOM_PREFIX = `repo:${repoOwner}@4857343/${repoName}@1304558512`;
const PROBE_PREFIXES = [DEFAULT_PREFIX, CUSTOM_PREFIX];

const subjectFor = (prefix: string, env: string) => `${prefix}:environment:${env}`;
/** The set of subjects bootstrap federates, under a given prefix. */
const subjectsUnder = (prefix: string) =>
  new Set(federatedEnvs.map(env => subjectFor(prefix, env)));

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

    // Distinctness is a property of the environment suffix, so it must hold
    // under either prefix shape (MG-42).
    for (const prefix of PROBE_PREFIXES) {
      const devSubjects = new Set([infraApplyEnv, appDeployEnv].map(e => subjectFor(prefix, e)));
      expect(devSubjects.size).toBe(2);
      for (const s of devSubjects) expect(subjectsUnder(prefix)).toContain(s);
    }
  });

  it('GITHUB_REPO is a committed constant, not env-overridable (F16)', () => {
    // bashConstant throws on the `${VAR:-…}` form, so reaching here already
    // proves it; assert the parsed value too so a typo cannot pass.
    expect(githubRepo).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
    expect(bootstrapSrc).not.toMatch(/GITHUB_REPO="\$\{GITHUB_REPO:-/);
  });

  it('bootstrap builds every subject from the DERIVED prefix, never a hardcoded literal (MG-42)', () => {
    // The hardcoded `repo:${GITHUB_REPO}:environment:${env}` was the MG-42 bug:
    // on a repo that customizes the `sub` claim it names a subject no token
    // carries, and because ensure_federated_credential reconciles on SUBJECT,
    // every bootstrap re-run rewrote the hand-corrected credential back to it.
    expect(bootstrapSrc).not.toMatch(/subject="repo:\$\{GITHUB_REPO\}:environment:/);

    // All THREE identities — prod plan/read, dev app-deploy, dev infra-apply —
    // compose through the single helper. Counted, not merely present: a call
    // site left behind is a credential that still federates the wrong subject.
    const composed = bootstrapSrc.match(
      /^\s*subject="\$\(federated_environment_subject "\$env"\)" \|\| exit 1$/gm
    );
    expect(composed).toHaveLength(3);

    // The composer appends the environment scope and nothing else, so trust
    // stays gated by GitHub Environment protection rules rather than by a ref.
    expect(bootstrapSrc).toMatch(/^federated_environment_subject\(\) \{/m);
    expect(bootstrapSrc).toMatch(/printf '%s:environment:%s'/);
    expect(bootstrapSrc).not.toMatch(/subject.*:ref:refs\/heads/);
  });

  it('the derived prefix is VALIDATED against the committed trust root and resolved before any identity (MG-42/F16)', () => {
    // Reading half the OIDC trust binding from a remote API is a real weakening
    // of F16 — whatever answers that API gets a say in which repository's
    // workflows may assume identities holding Contributor on the dev RG. The
    // validation is what pays for it, so its existence is pinned here.
    expect(bootstrapSrc).toMatch(/^assert_oidc_subject_prefix\(\) \{/m);
    expect(bootstrapSrc).toMatch(/^resolve_oidc_subject_prefix\(\) \{/m);
    // The resolver must go through the validator — a resolve that assigned the
    // global directly would make the check decorative.
    const resolver = bootstrapSrc.match(/^resolve_oidc_subject_prefix\(\) \{[\s\S]*?\n\}/m)?.[0] ?? '';
    expect(resolver).toContain('assert_oidc_subject_prefix');
    expect(resolver.indexOf('assert_oidc_subject_prefix')).toBeLessThan(
      resolver.indexOf('OIDC_SUBJECT_PREFIX="$prefix"')
    );

    // The prefix global inherits F16 verbatim: no env-override form, ever.
    expect(bootstrapSrc).toMatch(/^OIDC_SUBJECT_PREFIX=""$/m);
    expect(bootstrapSrc).not.toMatch(/OIDC_SUBJECT_PREFIX="\$\{OIDC_SUBJECT_PREFIX:-/);

    // main() resolves BEFORE the first identity, so an unprovable prefix aborts
    // while nothing has been provisioned.
    const mainBody = bootstrapSrc.match(/^main\(\) \{[\s\S]*?\n\}/m)?.[0] ?? '';
    const code = mainBody
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n');
    const resolveAt = code.indexOf('resolve_oidc_subject_prefix');
    const firstIdentityAt = code.search(/bootstrap_[a-z_]*identity/);
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(firstIdentityAt).toBeGreaterThanOrEqual(0);
    expect(resolveAt).toBeLessThan(firstIdentityAt);
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
    // Run under BOTH prefix shapes (MG-42): the presented subject and the
    // federated subject share whatever prefix the live repo has, so the
    // cross-check is about the environment half agreeing — and it must agree
    // regardless of which prefix that is.
    for (const prefix of PROBE_PREFIXES) {
      for (const file of AZURE_WORKFLOWS) {
        for (const { environment } of azureAuthedJobs(file)) {
          const subject = subjectFor(prefix, environment as string);
          // The core cross-check: the presented subject MUST be a bootstrap-created
          // federated subject, per environment.
          expect(subjectsUnder(prefix)).toContain(subject);
        }
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
    for (const prefix of PROBE_PREFIXES) {
      expect(subjectsUnder(prefix)).toContain(subjectFor(prefix, infraApplyEnv));
    }
  });

  it('dev and prod resolve to SEPARATE bootstrap subjects (no shared SP across environments)', () => {
    for (const prefix of PROBE_PREFIXES) {
      const prodSubject = subjectFor(prefix, 'production');
      expect(subjectsUnder(prefix)).toContain(prodSubject);
      for (const devEnv of [infraApplyEnv, appDeployEnv]) {
        expect(subjectFor(prefix, devEnv)).not.toBe(prodSubject);
      }
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
    for (const prefix of PROBE_PREFIXES) {
      const prodSubject = subjectFor(prefix, 'production');
      for (const { environment } of authedJobs) {
        expect(environment).toBe('production');
        expect(subjectsUnder(prefix)).toContain(subjectFor(prefix, environment as string));
      }
      expect(subjectsUnder(prefix)).toContain(prodSubject);
    }
  });

  /**
   * MG-42 — the prefix half of the subject, proven BEHAVIOURALLY.
   *
   * The assertions above pin the ENVIRONMENT half by reading source. The prefix
   * half cannot be read from source any more: it is whatever
   * `repos/<repo>/actions/oidc/customization/sub` says. So these tests run
   * bootstrap.sh's OWN resolver, with `gh` replaced by a shell function, and
   * assert on the value it produces.
   *
   * NO NETWORK AND NO CREDENTIALS ARE USED OR WANTED. `gh` is stubbed (a shell
   * function, which `command -v` also resolves), `az` is never reached, and
   * main() is guarded by BASH_SOURCE so sourcing provisions nothing. A test
   * suite must never be able to touch the live tenant.
   *
   * The negative cases carry the weight. Honouring a custom prefix fixes an
   * outage; refusing an unprovable one is what keeps F16 intact once the value
   * comes from off-box.
   */
  describe('MG-42: resolve_oidc_subject_prefix (bootstrap.sh, with `gh` stubbed)', () => {
    /**
     * Source bootstrap.sh, install a `gh` stub, resolve, and echo the result.
     *
     * `set +e` AFTER the source, because bootstrap.sh sets errexit for its own
     * run and we need to observe a non-zero exit rather than be killed by it.
     * stdout of the source and the resolver is discarded so the only thing on
     * stdout is the value under test.
     */
    function resolvePrefix(ghStub: string): { status: number; prefix: string } {
      const script = `
        . "${BOOTSTRAP}" >/dev/null 2>&1
        set +e
        ${ghStub}
        resolve_oidc_subject_prefix >/dev/null 2>&1 || exit 1
        printf '%s' "$OIDC_SUBJECT_PREFIX"
      `;
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      return { status: r.status ?? 1, prefix: (r.stdout ?? '').trim() };
    }

    /**
     * The stubs emit a REALISTIC STATUS LINE because the resolver reads one.
     *
     * It runs `gh api -i`, which prints the response status line and headers on
     * stdout ahead of the body — on success AND on an HTTP error — while the
     * human-readable diagnostic goes to stderr. That status line is the only
     * authoritative statement of what THIS request returned, and it replaced an
     * unanchored `grep -q 'HTTP 404'` over gh's stderr that decided the
     * DESTRUCTIVE default-prefix fallback (see the regression test below).
     */
    const headers = (statusLine: string) =>
      statusLine
        ? `printf '%s\\r\\n' '${statusLine}'; printf 'content-type: application/json\\r\\n'; printf '\\r\\n';`
        : '';
    /** A stub whose `gh api` succeeds (HTTP 200) with the given JSON body. */
    const apiOk = (body: string) => `
      gh() { case "\${1:-}" in
        auth) return 0 ;;
        api)  ${headers('HTTP/2.0 200 OK')} printf '%s' '${body}' ;;
      esac; return 0; }`;
    /**
     * A stub whose `gh api` fails, writing `err` to stderr under `statusLine`.
     * An empty `statusLine` models the no-response case (DNS/proxy), where gh
     * never got a status at all. `failBody` is the response body on stdout —
     * used to prove a body cannot spoof the real status line.
     */
    const apiFail = (err: string, statusLine: string, failBody = '') => `
      gh() { case "\${1:-}" in
        auth) return 0 ;;
        api)  ${headers(statusLine)} printf '%s' '${err}' >&2; printf '%s' '${failBody}'; return 1 ;;
      esac; return 0; }`;

    it('HONOURS a custom sub_claim_prefix — the live 2026-07-27 shape', () => {
      // This is the fix: the id-injected prefix is what the token actually
      // carries, so it is what the federated credential must be created for.
      const { status, prefix } = resolvePrefix(
        apiOk(`{"use_default": false, "include_claim_keys": ["repo"], "sub_claim_prefix": "${CUSTOM_PREFIX}"}`)
      );
      expect(status).toBe(0);
      expect(prefix).toBe(CUSTOM_PREFIX);
      // ...and the composed subject is exactly what an environment-scoped job
      // presents, so azure/login stops failing AADSTS700213.
      expect(subjectFor(prefix, infraApplyEnv)).toBe(
        `repo:${repoOwner}@4857343/${repoName}@1304558512:environment:development-infra-apply`
      );
    });

    /**
     * THE CANONICAL LIVE FIXTURE — and the case every earlier fixture in this
     * repo got wrong.
     *
     * The string below is the VERBATIM body returned by
     *   gh api repos/stevebargelt/meatgeekv2/actions/oidc/customization/sub
     * run against the real repository on the host, 2026-07-27, re-confirmed
     * 2026-07-28. Recorded fact, not an invention: the field order, the
     * `use_default: true`, and the `use_immutable_subject` key are all part of
     * what was observed. Do not tidy it.
     *
     * `use_default` is TRUE **and** a custom prefix is present. These are not
     * mutually exclusive on this account — `use_default` describes the claim-KEY
     * list (`include_claim_keys`), while the enterprise policy injects the
     * owner-id/repo-id prefix independently of it. A resolver that lets
     * `use_default` veto the prefix resolves this body to
     * `repo:stevebargelt/meatgeekv2`, the exact broken subject MG-42 exists to
     * eliminate; and since ensure_federated_credential reconciles ON SUBJECT, a
     * run would delete the hand-corrected development-infra-apply credential and
     * recreate it dead (AADSTS700213).
     */
    const LIVE_BODY =
      '{"use_default":true,"use_immutable_subject":false,"sub_claim_prefix":"repo:stevebargelt@4857343/meatgeekv2@1304558512"}';

    it('HONOURS sub_claim_prefix over use_default — the VERBATIM live 2026-07-27 response', () => {
      const { status, prefix } = resolvePrefix(apiOk(LIVE_BODY));
      expect(status).toBe(0);
      expect(prefix).toBe('repo:stevebargelt@4857343/meatgeekv2@1304558512');
      expect(prefix).not.toBe(DEFAULT_PREFIX);
      expect(subjectFor(prefix, infraApplyEnv)).toBe(
        'repo:stevebargelt@4857343/meatgeekv2@1304558512:environment:development-infra-apply'
      );
    });

    it('FALLS BACK to the default prefix only when NOTHING contradicts use_default', () => {
      // Two spellings of the same fact: use_default with no prefix to contradict
      // it, and the 404 the endpoint returns when nothing is configured. BOTH
      // halves matter in the first case — a body carrying a prefix alongside
      // use_default=true resolves the other way (see the live fixture above).
      for (const stub of [
        apiOk('{"use_default": true}'),
        apiFail('gh: Not Found (HTTP 404)', 'HTTP/2.0 404 Not Found'),
      ]) {
        const { status, prefix } = resolvePrefix(stub);
        expect(status).toBe(0);
        expect(prefix).toBe(DEFAULT_PREFIX);
      }
    });

    it('ABORTS on use_default=false with an unreadable sub_claim_prefix (MG-42-F1)', () => {
      // `use_default: false` is GitHub positively stating that this repository
      // DOES customize its sub claim. A missing/empty prefix alongside it means
      // "a customization exists and its prefix could not be read" — the same
      // epistemic position as the 403/5xx/network cases below, every one of
      // which dies. Falling back here writes the default subject over three live
      // credentials on a guess. Note the first shape is GitHub's *documented*
      // response body, so this branch is easy to enter by accident.
      for (const body of [
        '{"use_default": false, "include_claim_keys": ["repo","context"]}',
        '{"use_default": false, "include_claim_keys": []}',
        '{"use_default": false, "sub_claim_prefix": ""}',
        '{"use_default": false, "sub_claim_prefix": null}',
      ]) {
        const { status, prefix } = resolvePrefix(apiOk(body));
        expect(`${body} -> exit ${status} prefix '${prefix}'`).toBe(`${body} -> exit 1 prefix ''`);
      }
    });

    it('REFUSES a prefix naming another repository (the F16 trust root holds)', () => {
      // The attack the validation exists for: a poisoned/redirected answer that
      // re-points every identity — the dev apply identity included — at another
      // repo's workflows. Near-miss shapes are covered too, since a
      // contains-check would wave `meatgeekv2-fork` straight through.
      for (const evil of [
        'repo:attacker/meatgeekv2',
        `repo:${repoOwner}/${repoName}-fork`,
        `repo:${repoOwner}-evil/${repoName}`,
        'repo:attacker@1/meatgeekv2@2',
        `repo:${repoOwner}/${repoName}:ref:refs/heads/main`,
      ]) {
        const { status } = resolvePrefix(apiOk(`{"sub_claim_prefix": "${evil}"}`));
        expect(`${evil} -> exit ${status}`).toBe(`${evil} -> exit 1`);
      }
    });

    it('REFUSES a gh failure that is not an unambiguous "no customization configured"', () => {
      // A 5xx/403/network error says NOTHING about the repo's configuration.
      // Falling back to the default prefix on one would rewrite the live
      // credentials to a subject no token matches — the MG-42 outage, re-caused
      // by the fix. Fail closed instead.
      for (const [err, line] of [
        ['gh: Server Error (HTTP 500)', 'HTTP/2.0 500 Internal Server Error'],
        ['gh: Forbidden (HTTP 403)', 'HTTP/2.0 403 Forbidden'],
        ['error connecting to api.github.com', ''],
      ]) {
        const { status } = resolvePrefix(apiFail(err, line));
        expect(`${err} -> exit ${status}`).toBe(`${err} -> exit 1`);
      }
      // Unparseable JSON is not "no customization" either.
      expect(resolvePrefix(apiOk('not json at all')).status).toBe(1);
      // Nor is an unauthenticated gh — whose 404s would otherwise be
      // indistinguishable from "nothing is configured".
      const unauthed = `gh() { case "\${1:-}" in auth) return 1 ;; esac; return 0; }`;
      expect(resolvePrefix(unauthed).status).toBe(1);
    });

    /**
     * THE ROUND-2 REGRESSION (red-wide, HIGH).
     *
     * The destructive default-prefix fallback used to be decided by an
     * UNANCHORED substring grep over gh's stderr — `grep -q 'HTTP 404'`. Any gh
     * failure whose human-readable diagnostic merely CONTAINED that text took
     * the fallback, though the endpoint's configuration was never established: a
     * captive-portal or proxy error page, a reworded gh diagnostic, an unrelated
     * nested 404 in a multi-part message. On this repository the fallback
     * resolves `repo:stevebargelt/meatgeekv2`, and ensure_federated_credential
     * reconciles ON SUBJECT — so it would delete and recreate all three live
     * credentials on a subject no token carries (AADSTS700213), the
     * hand-corrected development-infra-apply one included. A self-inflicted
     * outage, no attacker required.
     *
     * The resolver now takes an authoritative status from the `gh api -i` status
     * line and matches it ANCHORED. Same class of defect as the round-1
     * precedence bug: a plausible read of an ambiguous signal, on the one code
     * path whose failure mode is destructive.
     */
    it('REFUSES a non-404 failure whose diagnostic merely CONTAINS "HTTP 404" (MG-42 round 2)', () => {
      for (const [err, line] of [
        // A proxy/captive-portal error page that mentions a 404 upstream.
        ['<html>Proxy Error</html> upstream said: HTTP 404', 'HTTP/2.0 502 Bad Gateway'],
        // A multi-part diagnostic with an unrelated nested 404.
        ['gh: Server Error (HTTP 500); a dependent call returned HTTP 404', 'HTTP/2.0 500 Internal Server Error'],
        ['gh: Forbidden (HTTP 403) - see HTTP 404 handling in the docs', 'HTTP/2.0 403 Forbidden'],
        // No response at all: there is no status, so there is no fact to read.
        ['error connecting to api.github.com (captive portal returned HTTP 404)', ''],
      ]) {
        const { status, prefix } = resolvePrefix(apiFail(err, line));
        expect(`${line || '<no status>'} -> exit ${status} prefix '${prefix}'`).toBe(
          `${line || '<no status>'} -> exit 1 prefix ''`
        );
      }
      // Only the FIRST line of the response is ever read as a status line, so a
      // body carrying a verbatim 404 status line cannot spoof the real one.
      const spoof = resolvePrefix(
        apiFail(
          'gh: Server Error (HTTP 500)',
          'HTTP/2.0 500 Internal Server Error',
          'HTTP/2.0 404 Not Found\\n{"message":"Not Found"}'
        )
      );
      expect(`spoofed-body -> exit ${spoof.status} prefix '${spoof.prefix}'`).toBe(
        "spoofed-body -> exit 1 prefix ''"
      );
      // A near-miss status line is not an exact 404 either: the code is delimited.
      for (const line of [
        'HTTP/2.0 4045 Nonsense',
        'HTTP/2.0 500 upstream HTTP/2.0 404 Not Found',
        'not a status line at all',
      ]) {
        const { status, prefix } = resolvePrefix(apiFail('gh: failed', line));
        expect(`${line} -> exit ${status} prefix '${prefix}'`).toBe(`${line} -> exit 1 prefix ''`);
      }
      // ...and the ANTI-OVER-BROADNESS control: a genuine exact 404 still falls
      // back, so the tightening did not simply disable the fallback.
      const genuine = resolvePrefix(
        apiFail('gh: Not Found (HTTP 404)', 'HTTP/2.0 404 Not Found', '{"message":"Not Found"}')
      );
      expect(genuine.status).toBe(0);
      expect(genuine.prefix).toBe(DEFAULT_PREFIX);
    });

    it('never composes a subject from an unresolved prefix or an empty environment', () => {
      // Either would federate a subject matching nothing — or something
      // unintended — and do it while reporting success.
      const compose = (prefix: string, env: string) =>
        spawnSync(
          'bash',
          [
            '-c',
            `. "${BOOTSTRAP}" >/dev/null 2>&1; set +e; OIDC_SUBJECT_PREFIX='${prefix}' federated_environment_subject '${env}'`,
          ],
          { encoding: 'utf8' }
        );
      expect(compose('', 'development').status).not.toBe(0);
      expect(compose(DEFAULT_PREFIX, '').status).not.toBe(0);
      // ...and the working case still works, so the guards are not vacuous.
      const good = compose(CUSTOM_PREFIX, infraApplyEnv);
      expect(good.status).toBe(0);
      expect(good.stdout).toBe(subjectFor(CUSTOM_PREFIX, infraApplyEnv));
    });
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
