/**
 * Regression guard for MG-23 — AUTOMATED DEV GITOPS RECONCILIATION (CI-run).
 *
 * Terminology, used precisely here and in the workflow it guards:
 *   MG-24 = Terraform reconciliation, OPERATOR-run (a human applied from a
 *           workstation against the persistent dev backend).
 *   MG-23 = automated dev GitOps reconciliation, CI-run: a non-applying plan on
 *           the PR, then an AUTOMATIC apply once the change merges to `main`.
 *
 * Like the MG-20/MG-21 guards next door, this is a *repo-tooling* invariant
 * rather than an api-interfaces behavior test. It lives here because
 * api-interfaces is a leaf shared lib already wired into the CI `lint-and-test`
 * matrix (`project: ['api','web','mobile','api-interfaces']`), so the guard runs
 * on every CI push, not only when someone remembers to run it locally.
 *
 * WHY THESE ASSERTIONS ARE WORTH THEIR WEIGHT. infra-apply-dev.yml applies
 * Terraform UNATTENDED, authenticated as an identity holding Contributor and a
 * conditioned Role Based Access Control Administrator on `meatgeek-v2-dev-rg`.
 * Under MG-24 a human read every plan before typing `apply`; under MG-23 nobody
 * does. Each invariant below is one of the controls that replaced that human,
 * and every one of them is a single-line edit away from being silently removed:
 *
 *   - the conclusion/event/head_branch TRIPLE GATE — without all three, a green
 *     CI run on an unmerged branch or a fork PR auto-applies unreviewed
 *     Terraform with RBAC-write rights;
 *   - DEV_TF_BACKEND_READY on every job — the activation switch, which must SKIP
 *     cleanly rather than fail red before an operator turns it on;
 *   - checkout pinned to the exact CI'd SHA — never a floating ref that may have
 *     advanced past what CI actually went green on;
 *   - top-level `contents: read` with `id-token: write` on the apply job ALONE;
 *   - `cancel-in-progress: false` — never kill an apply mid-state-mutation;
 *   - the gate SEQUENCE and its ORDER: plan-to-file -> pre-apply secret gate ->
 *     destroy circuit-breaker -> apply THAT SAVED FILE -> post-apply state gate
 *     -> final drift plan. A bare `terraform apply` re-plans at apply time and
 *     would execute a change set neither gate ever inspected;
 *   - `terraform init` WITH `-lockfile=readonly` and WITHOUT `-upgrade`, so the
 *     committed .terraform.lock.hcl binds provider hashes instead of a fresh
 *     runner resolving-and-executing whatever satisfies `~> 4.0`;
 *   - no artifact upload and no plan/state JSON on stdout — dev state contains
 *     live IoT Hub SAS keys, the one remaining live credential in an otherwise
 *     key-free stack;
 *   - every `uses:` SHA-pinned, so a compromised action tag cannot re-point at
 *     new code inside a privileged job;
 *   - the workflow_dispatch RECOVERY path takes NO shortcut (it enters the same
 *     single apply job) and carries a manual approval the automatic path does
 *     not;
 *   - MG-58's LIVE HOST-STORAGE GATE — the one assertion in this workflow made
 *     against the DEPLOYED SITE rather than against configuration text. Every
 *     other control here reads HCL, a plan document or state, and all of them
 *     were green while dev's Function App carried a scalar `AzureWebJobsStorage`
 *     connection string the provider injects and hides on read. Its load-bearing
 *     properties — placement after the convergence proof, unconditional
 *     execution, a settings document that reaches only the gate's stdin, a
 *     one-key/one-app remediation reached only when the key was actually found,
 *     and a failure that is never swallowed — are each a one-line edit away from
 *     being weakened back into the decorative gate this replaced.
 *
 * SCOPE: this file reads ONLY .github/workflows/infra-apply-dev.yml and the two
 * gate scripts it invokes. ci.yml, bootstrap.sh and the prod workflows are other
 * suites' territory, deliberately — so this guard stays meaningful regardless of
 * what else is mid-flight.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const WORKFLOW_FILE = path.join(REPO_ROOT, '.github', 'workflows', 'infra-apply-dev.yml');

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
  environment?: unknown;
  permissions?: Record<string, unknown>;
  'runs-on'?: string;
  env?: Record<string, unknown>;
  steps?: WfStep[];
}
interface Workflow {
  name?: string;
  on?: unknown;
  permissions?: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, WfJob>;
  [k: string]: unknown;
}

const RAW = fs.readFileSync(WORKFLOW_FILE, 'utf8');
const WF = yaml.load(RAW) as Workflow;
const JOBS = WF.jobs ?? {};
const APPLY = JOBS['apply'] ?? {};
const APPLY_STEPS: WfStep[] = APPLY.steps ?? [];

/** The parsed `on:` mapping, tolerating the YAML 1.1 boolean-`on` reading. */
function triggers(): Record<string, unknown> {
  const on = (WF.on ?? (WF as Record<string, unknown>)[String(true)]) as unknown;
  return (on ?? {}) as Record<string, unknown>;
}

/**
 * A job's `if`, normalized to single-spaced text. The YAML folded scalar (`>-`)
 * already collapses newlines, but collapsing runs of whitespace lets the
 * assertions below read as the expression a human would write rather than as
 * whitespace archaeology.
 */
function jobIf(job: WfJob): string {
  return String(job.if ?? '').replace(/\s+/g, ' ');
}

/**
 * Every `run:` body in the apply job, with shell comment lines stripped.
 *
 * The stripping matters: the workflow's comments deliberately NAME the
 * anti-patterns they forbid ("never a bare `terraform apply`", "never `cat` the
 * plan"). Scanning raw text would match the prohibition itself and turn every
 * well-documented guard into a false failure — so the shell-behaviour assertions
 * read executable lines only.
 */
function applyRunLines(): string[] {
  const lines: string[] = [];
  for (const s of APPLY_STEPS) {
    if (typeof s.run !== 'string') continue;
    for (const line of s.run.split('\n')) {
      const stripped = line.replace(/^\s+/, '');
      if (stripped.startsWith('#') || stripped === '') continue;
      lines.push(line);
    }
  }
  return lines;
}

/**
 * A `run:` body reduced to LOGICAL commands: shell comment lines dropped, and
 * backslash continuations joined into the single command the shell actually
 * sees.
 *
 * Line-at-a-time scanning is what the older assertions in this file do, and it
 * is adequate for one-line invocations. It is NOT adequate for the live
 * host-storage gate, whose `az ... appsettings list` spans four physical lines
 * and whose pipe into the gate script lands on the last of them — a per-line
 * check would read "an az invocation with no pipe" and "a gate invocation with
 * no input", i.e. exactly the shape it is meant to forbid, and would pass a
 * mutation that redirected the settings document to a file on line two.
 */
function logicalLines(run: string): string[] {
  const out: string[] = [];
  let acc = '';
  for (const raw of run.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;
    if (line.endsWith('\\')) {
      acc += `${line.slice(0, -1).trim()} `;
      continue;
    }
    out.push(`${acc}${line}`.trim());
    acc = '';
  }
  if (acc.trim() !== '') out.push(acc.trim());
  return out;
}

/** Every logical command line in the workflow, across every job and step. */
function allLogicalLines(): { job: string; step: string; line: string }[] {
  const out: { job: string; step: string; line: string }[] = [];
  for (const [jobName, job] of Object.entries(JOBS)) {
    for (const s of job.steps ?? []) {
      if (typeof s.run !== 'string') continue;
      for (const line of logicalLines(s.run)) {
        out.push({ job: jobName, step: String(s.name ?? '<unnamed>'), line });
      }
    }
  }
  return out;
}

/** Index of the first apply step whose `run` matches, else -1. */
function stepIndex(re: RegExp): number {
  return APPLY_STEPS.findIndex(s => typeof s.run === 'string' && re.test(s.run));
}

/** Index of the first apply step whose `uses` starts with `prefix`, else -1. */
function usesIndex(prefix: string): number {
  return APPLY_STEPS.findIndex(s => typeof s.uses === 'string' && s.uses.startsWith(prefix));
}

/** Every `uses:` in the workflow, across all jobs. */
function allUses(): string[] {
  const out: string[] = [];
  for (const job of Object.values(JOBS)) {
    for (const s of job.steps ?? []) if (typeof s.uses === 'string') out.push(s.uses);
  }
  return out;
}

/**
 * The workflow's YAML COMMENT prose, unwrapped: leading `#` markers stripped and
 * all whitespace collapsed to single spaces.
 *
 * The threat-model assertions below run against THIS rather than the raw text,
 * because a comment sentence is wrapped at whatever column it happened to reach.
 * Matching raw text would make every reflow of a paragraph a test failure, which
 * trains people to delete the assertion rather than keep the comment.
 */
const COMMENT_PROSE = RAW.split('\n')
  .filter(l => /^\s*#/.test(l))
  .map(l => l.replace(/^\s*#\s?/, ''))
  .join(' ')
  .replace(/\s+/g, ' ');

/* -------------------------------------------------------------------------- *
 * A TINY EVALUATOR FOR THE GITHUB EXPRESSION SUBSET THE JOB CONDITIONS USE.
 *
 * WHY THIS EXISTS RATHER THAN MORE REGEXES. The regression that made it
 * necessary was not a missing clause — every clause the reviewer asked for was
 * present, and every pattern-matching assertion above was green — it was a
 * REACHABILITY defect: `apply` declares `needs: [recovery_approval]`, that job
 * is SKIPPED on every automatic run, and GitHub's default rule skips a job whose
 * dependency was skipped. The whole automatic reconciler was dead, and dead in
 * the quietest possible way, because a skipped job is green. No amount of
 * "does the text contain X" proves a job actually RUNS; only evaluating the
 * condition does.
 *
 * The evaluator deliberately THROWS on any construct it does not model. A future
 * edit that reaches for `success()`, `hashFiles()`, `contains()` or an operator
 * outside this subset fails loudly here instead of being silently mis-evaluated
 * into a green test. Unmodelled is not "assume true".
 * -------------------------------------------------------------------------- */

type ExprValue = string | boolean | null;

interface RunState {
  /** The workflow run was cancelled — which is what REJECTING a deployment does. */
  cancelled: boolean;
}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === '!') {
      // `!=` is an operator; a lone `!` is negation.
      if (c === '!' && expr[i + 1] === '=') {
        tokens.push('!=');
        i += 2;
        continue;
      }
      tokens.push(c);
      i++;
      continue;
    }
    if (expr.startsWith('&&', i) || expr.startsWith('||', i) || expr.startsWith('==', i)) {
      tokens.push(expr.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = expr.indexOf("'", i + 1);
      if (end === -1) throw new Error(`unterminated string literal in: ${expr}`);
      tokens.push(expr.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expr.slice(i));
    if (!word) throw new Error(`unexpected character '${c}' in: ${expr}`);
    tokens.push(word[0]);
    i += word[0].length;
    continue;
  }
  return tokens;
}

/** Truthiness, GitHub-style: '' and null are falsey, any other string is true. */
function truthy(v: ExprValue): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null) return false;
  return v !== '';
}

function lookup(pathExpr: string, ctx: Record<string, unknown>): ExprValue {
  let cur: unknown = ctx;
  for (const part of pathExpr.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) return null;
  }
  if (cur === undefined || cur === null) return null;
  if (typeof cur === 'string' || typeof cur === 'boolean') return cur;
  throw new Error(`context path '${pathExpr}' resolved to an unmodelled value`);
}

function evaluateExpression(
  expr: string,
  ctx: Record<string, unknown>,
  state: RunState
): ExprValue {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  function primary(): ExprValue {
    const t = take();
    if (t === undefined) throw new Error(`unexpected end of expression: ${expr}`);
    if (t === '(') {
      const v = or();
      if (take() !== ')') throw new Error(`unbalanced parentheses in: ${expr}`);
      return v;
    }
    if (t === '!') return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t === 'true') return true;
    if (t === 'false') return false;
    // A function call is `name` followed by `(` `)`.
    if (peek() === '(') {
      take();
      if (take() !== ')') throw new Error(`only zero-argument functions are modelled: ${expr}`);
      if (t === 'always') return true;
      if (t === 'cancelled') return state.cancelled;
      // success()/failure()/anything else: refuse to guess.
      throw new Error(`unmodelled function '${t}()' in: ${expr}`);
    }
    return lookup(t, ctx);
  }

  function comparison(): ExprValue {
    const left = primary();
    const op = peek();
    if (op === '==' || op === '!=') {
      take();
      const right = primary();
      // GitHub compares strings CASE-INSENSITIVELY. Modelling it case-sensitively
      // would let this file claim a skip that the real service would RUN.
      const eq =
        typeof left === 'string' && typeof right === 'string'
          ? left.toLowerCase() === right.toLowerCase()
          : left === right;
      return op === '==' ? eq : !eq;
    }
    return left;
  }

  function and(): ExprValue {
    let v = comparison();
    while (peek() === '&&') {
      take();
      const rhs = comparison();
      v = truthy(v) ? rhs : v;
    }
    return v;
  }

  function or(): ExprValue {
    let v = and();
    while (peek() === '||') {
      take();
      const rhs = and();
      v = truthy(v) ? v : rhs;
    }
    return v;
  }

  const result = or();
  if (pos !== tokens.length) throw new Error(`trailing tokens in: ${expr}`);
  return result;
}

/**
 * Does GitHub run this job?
 *
 * Two models, because GitHub's exact override rule for a SKIPPED dependency is
 * not something this repository can test against the real service:
 *   'strict'  — only `always()` overrides the implicit needs-succeeded check.
 *   'lenient' — any status-check function (`always()`, `cancelled()`, ...) does.
 * The assertions below require the workflow to behave correctly under BOTH, so
 * the reachability of the automatic path does not rest on a belief about which
 * one is true.
 */
function jobRuns(
  job: WfJob,
  ctx: Record<string, unknown>,
  state: RunState,
  model: 'strict' | 'lenient'
): boolean {
  const expr = String(job.if ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const needs = typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []);
  const overrides =
    model === 'strict'
      ? /\balways\s*\(\s*\)/.test(expr)
      : /\b(always|cancelled|success|failure)\s*\(\s*\)/.test(expr);
  if (needs.length > 0 && !overrides) {
    const allSucceeded = needs.every(n => lookup(`needs.${n}.result`, ctx) === 'success');
    if (!allSucceeded) return false;
  }
  if (expr === '') return !state.cancelled;
  return truthy(evaluateExpression(expr, ctx, state));
}

describe('MG-23: infra-apply-dev.yml — automated dev GitOps reconciliation', () => {
  it('parses as a workflow with exactly the two expected jobs', () => {
    expect(WF.name).toBeDefined();
    // One apply job (so both entry paths provably share one gate sequence) plus
    // the recovery-approval gate. A third job here means someone added a second
    // copy of the sequence, which is the drift this shape exists to prevent.
    expect(Object.keys(JOBS).sort()).toEqual(['apply', 'recovery_approval']);
    expect(APPLY_STEPS.length).toBeGreaterThan(0);
  });

  describe('triggers', () => {
    it('runs on workflow_run of the CI/CD Pipeline, completed', () => {
      const on = triggers();
      const wr = (on['workflow_run'] ?? {}) as Record<string, unknown>;
      expect(wr['workflows']).toEqual(['CI/CD Pipeline']);
      expect(wr['types']).toEqual(['completed']);
    });

    it('has NO push or pull_request trigger', () => {
      // A `push` trigger would run the workflow FILE FROM THE PUSHED REF. The
      // whole point of workflow_run here is that the executing workflow file
      // always comes from the default branch, so a PR cannot rewrite the apply
      // steps and have its rewrite run with Contributor + RBAC Administrator.
      const on = triggers();
      expect(Object.keys(on)).not.toContain('push');
      expect(Object.keys(on)).not.toContain('pull_request');
      expect(Object.keys(on)).not.toContain('pull_request_target');
    });

    it('exposes workflow_dispatch only as the recovery entry, with an exact-ADDRESS-SET destroy input', () => {
      const on = triggers();
      const wd = (on['workflow_dispatch'] ?? {}) as Record<string, unknown>;
      const inputs = (wd['inputs'] ?? {}) as Record<string, unknown>;
      expect(Object.keys(inputs)).toContain('authorized_changes');
      // The retired COUNT input must not come back. A count authorizes an arity,
      // and a different set of resources of the same arity satisfies it — so an
      // authorization issued for two disposable resources would also clear the
      // Cosmos account and the IoT Hub.
      expect(Object.keys(inputs)).not.toContain('expected_destroys');
      // Nor the action-UNQUALIFIED predecessor. `authorized_destroys` named bare
      // addresses, so an approval to DESTROY a resource also cleared a
      // `removed { destroy = false }` block that ORPHANS the same address out of
      // Terraform management instead — different decision, same token.
      expect(Object.keys(inputs)).not.toContain('authorized_destroys');

      // Not required, and defaulted to empty: the recovery path's NORMAL case
      // authorizes no destroys at all.
      const ad = inputs['authorized_changes'] as Record<string, unknown>;
      expect(ad['required']).not.toBe(true);
      expect(String(ad['default'] ?? '')).toBe('');

      // The description must say what the operator is actually supplying — an
      // ACTION-QUALIFIED token, not a bare address, and not a count.
      const desc = String(ad['description'] ?? '');
      expect(desc).toMatch(/address/i);
      expect(desc).toMatch(/action-qualified/i);
      expect(desc).toMatch(/delete:/);
      expect(desc).toMatch(/forget:/);
      expect(desc).toMatch(/deposed/i);
    });
  });

  describe('the triple gate (a security control, not boilerplate)', () => {
    const gate = jobIf(APPLY);

    it("requires the triggering CI run's conclusion == 'success'", () => {
      expect(gate).toMatch(/github\.event\.workflow_run\.conclusion == 'success'/);
    });

    it("requires the triggering CI run's event == 'push' (never a PR run)", () => {
      expect(gate).toMatch(/github\.event\.workflow_run\.event == 'push'/);
    });

    it("requires the triggering CI run's head_branch == 'main' (never a branch or fork)", () => {
      expect(gate).toMatch(/github\.event\.workflow_run\.head_branch == 'main'/);
    });

    it('keeps !cancelled(), so a REJECTED recovery deployment can never apply', () => {
      // Rejecting a deployment review CANCELS the run, so `!cancelled()` is what
      // stops a rejected recovery from applying anyway. `always()` alone would
      // push straight through it — it may appear only ALONGSIDE `!cancelled()`,
      // where its job is to override the implicit needs-succeeded check (see the
      // reachability block below). The semantics are proven there by evaluating
      // the expression; this is the cheap textual backstop.
      expect(gate).toMatch(/!cancelled\(\)/);
    });
  });

  describe('REACHABILITY of the apply job (the automatic reconciler must actually run)', () => {
    /** The context of a green CI run on a push to main, with dev activated. */
    function automatic(
      over: {
        conclusion?: string;
        event?: string;
        head_branch?: string;
        ready?: string | null;
        approval?: string;
      } = {}
    ) {
      return {
        github: {
          event_name: 'workflow_run',
          ref: 'refs/heads/main',
          repository: 'stevebargelt/meatgeekv2',
          event: {
            workflow_run: {
              conclusion: over.conclusion ?? 'success',
              event: over.event ?? 'push',
              head_branch: over.head_branch ?? 'main',
              head_sha: 'a'.repeat(40),
            },
          },
        },
        // `recovery_approval` is SKIPPED here: its own `if` requires a
        // workflow_dispatch. This is the exact condition the defect died on.
        needs: { recovery_approval: { result: over.approval ?? 'skipped' } },
        vars: over.ready === null ? {} : { DEV_TF_BACKEND_READY: over.ready ?? 'true' },
      };
    }

    /** The context of an operator-fired recovery dispatch on main. */
    function dispatch(over: { approval?: string; ref?: string; ready?: string | null } = {}) {
      return {
        github: {
          event_name: 'workflow_dispatch',
          ref: over.ref ?? 'refs/heads/main',
          repository: 'stevebargelt/meatgeekv2',
          sha: 'b'.repeat(40),
          event: { inputs: { authorized_changes: '' } },
        },
        needs: { recovery_approval: { result: over.approval ?? 'success' } },
        vars: over.ready === null ? {} : { DEV_TF_BACKEND_READY: over.ready ?? 'true' },
      };
    }

    const MODELS: ('strict' | 'lenient')[] = ['strict', 'lenient'];

    /** Runs under BOTH needs-override models, reported as a pair so a failure names which. */
    function verdicts(job: WfJob, ctx: Record<string, unknown>, cancelled = false) {
      return MODELS.map(m => ({ model: m, runs: jobRuns(job, ctx, { cancelled }, m) }));
    }

    it('the evaluator itself is not vacuous (self-test)', () => {
      // If this evaluator silently returned true for everything, every assertion
      // below would be worthless. Pin its behaviour on known inputs first.
      const st = { cancelled: false };
      expect(evaluateExpression("'a' == 'a'", {}, st)).toBe(true);
      expect(evaluateExpression("'a' == 'b'", {}, st)).toBe(false);
      expect(evaluateExpression("x.y == 'b'", { x: { y: 'b' } }, st)).toBe(true);
      // A missing context value is null, and null never equals a string — this is
      // what makes an UNSET DEV_TF_BACKEND_READY skip rather than apply.
      expect(evaluateExpression("x.missing == 'true'", { x: {} }, st)).toBe(false);
      // Case-insensitive string equality, as GitHub does it.
      expect(evaluateExpression("x.y == 'B'", { x: { y: 'b' } }, st)).toBe(true);
      expect(evaluateExpression('always() && !cancelled()', {}, st)).toBe(true);
      expect(evaluateExpression('always() && !cancelled()', {}, { cancelled: true })).toBe(false);
      expect(
        truthy(
          evaluateExpression(
            "(a.b == 'x' || a.b == 'y') && a.c == 'z'",
            { a: { b: 'y', c: 'z' } },
            st
          )
        )
      ).toBe(true);
      expect(
        truthy(
          evaluateExpression(
            "(a.b == 'x' || a.b == 'y') && a.c == 'z'",
            { a: { b: 'q', c: 'z' } },
            st
          )
        )
      ).toBe(false);
      // Anything unmodelled must THROW rather than be guessed at.
      expect(() => evaluateExpression('success()', {}, st)).toThrow(/unmodelled function/);
      expect(() => evaluateExpression('contains(a, b)', {}, st)).toThrow();
    });

    it('RUNS on the normal automatic path even though recovery_approval was SKIPPED', () => {
      // THE REGRESSION THIS FILE EXISTS FOR. `apply` needs `recovery_approval`,
      // which never runs on a workflow_run trigger. If a skipped dependency skips
      // `apply`, every green push to main silently reconciles NOTHING while the
      // run still shows green. Correct under both override models or it is not
      // correct at all.
      expect(verdicts(APPLY, automatic())).toEqual([
        { model: 'strict', runs: true },
        { model: 'lenient', runs: true },
      ]);
    });

    it('the approval job really is SKIPPED on the automatic path (the premise above)', () => {
      // If this ever started RUNNING on workflow_run it would put a human gate on
      // automatic reconciliation, which MG-23 rules out.
      expect(verdicts(JOBS['recovery_approval'] ?? {}, automatic())).toEqual([
        { model: 'strict', runs: false },
        { model: 'lenient', runs: false },
      ]);
    });

    it('still REQUIRES the recovery approval on the workflow_dispatch path', () => {
      const gate = JOBS['recovery_approval'] ?? {};
      // The approval job runs on dispatch...
      expect(verdicts(gate, dispatch())).toEqual([
        { model: 'strict', runs: true },
        { model: 'lenient', runs: true },
      ]);
      // ...and only its SUCCESS lets the apply through.
      expect(verdicts(APPLY, dispatch({ approval: 'success' }))).toEqual([
        { model: 'strict', runs: true },
        { model: 'lenient', runs: true },
      ]);
      for (const result of ['skipped', 'failure', 'cancelled']) {
        expect({ result, verdicts: verdicts(APPLY, dispatch({ approval: result })) }).toEqual({
          result,
          verdicts: [
            { model: 'strict', runs: false },
            { model: 'lenient', runs: false },
          ],
        });
      }
    });

    it('never applies on cancellation — a REJECTED recovery deployment cancels the run', () => {
      // Rejecting a deployment review cancels the run. `always()` alone would
      // apply anyway; the paired `!cancelled()` is what stops it, on both paths.
      expect(verdicts(APPLY, dispatch({ approval: 'success' }), true)).toEqual([
        { model: 'strict', runs: false },
        { model: 'lenient', runs: false },
      ]);
      expect(verdicts(APPLY, automatic(), true)).toEqual([
        { model: 'strict', runs: false },
        { model: 'lenient', runs: false },
      ]);
    });

    it('skips cleanly when DEV_TF_BACKEND_READY is unset or false', () => {
      // 'TRUE' is deliberately NOT in this list: GitHub's string equality is
      // case-insensitive, so 'TRUE' genuinely activates. Claiming otherwise
      // would be a comfortable falsehood.
      for (const ready of [null, 'false', '1', '']) {
        expect({ ready, verdicts: verdicts(APPLY, automatic({ ready })) }).toEqual({
          ready,
          verdicts: [
            { model: 'strict', runs: false },
            { model: 'lenient', runs: false },
          ],
        });
      }
    });

    it('does not apply when any leg of the triple gate is missing', () => {
      const broken = [
        { label: 'CI failed', ctx: automatic({ conclusion: 'failure' }) },
        { label: 'CI run was a pull_request', ctx: automatic({ event: 'pull_request' }) },
        { label: 'CI run was on a branch', ctx: automatic({ head_branch: 'feature/x' }) },
      ];
      for (const { label, ctx } of broken) {
        expect({ label, verdicts: verdicts(APPLY, ctx) }).toEqual({
          label,
          verdicts: [
            { model: 'strict', runs: false },
            { model: 'lenient', runs: false },
          ],
        });
      }
    });

    it('does not apply on a dispatch from a branch other than main', () => {
      expect(verdicts(APPLY, dispatch({ ref: 'refs/heads/feature/x' }))).toEqual([
        { model: 'strict', runs: false },
        { model: 'lenient', runs: false },
      ]);
    });

    it('does not apply when the approval job FAILED on the automatic path either', () => {
      // A recovery_approval that errored (rather than being skipped) is not an
      // approval, whichever trigger produced it.
      expect(verdicts(APPLY, automatic({ approval: 'failure' }))).toEqual([
        { model: 'strict', runs: false },
        { model: 'lenient', runs: false },
      ]);
    });

    it('states the dependency result EXPLICITLY rather than relying on !cancelled()', () => {
      // The textual backstop for the semantic proof above: the override must be
      // written down, so a future edit that deletes `always()` or the
      // result == 'skipped' allowance trips this as well as the evaluator.
      const gate = jobIf(APPLY);
      expect(gate).toMatch(/needs\.recovery_approval\.result == 'skipped'/);
      expect(gate).toMatch(/needs\.recovery_approval\.result == 'success'/);
      expect(gate).toMatch(/\balways\(\)/);
      expect(gate).toMatch(/!cancelled\(\)/);
      expect(APPLY.needs).toEqual(['recovery_approval']);
    });
  });

  describe('DEV_TF_BACKEND_READY activation gate', () => {
    it("gates EVERY job on vars.DEV_TF_BACKEND_READY == 'true'", () => {
      // Missing or false => the job SKIPS. A skipped job is green; the switch
      // must never produce an expected-red run before activation.
      const jobNames = Object.keys(JOBS);
      expect(jobNames.length).toBeGreaterThan(0);
      const verdict = jobNames.map(n => ({
        job: n,
        gated: /vars\.DEV_TF_BACKEND_READY == 'true'/.test(jobIf(JOBS[n])),
      }));
      expect(verdict).toEqual(jobNames.map(n => ({ job: n, gated: true })));
    });

    it('never treats an unset switch as enabled', () => {
      // e.g. `!= 'false'` or a `|| true` fallback would make the default ON.
      expect(RAW).not.toMatch(/DEV_TF_BACKEND_READY\s*!=/);
      expect(RAW).not.toMatch(/vars\.DEV_TF_BACKEND_READY\s*\|\|/);
    });
  });

  describe('least privilege', () => {
    it('grants only `contents: read` at the workflow level', () => {
      // infra-deploy-prod.yml's workflow-level `id-token: write` is the
      // anti-pattern deliberately NOT copied here: it lets every job in the
      // workflow mint an Azure OIDC token whether it needs one or not.
      expect(WF.permissions).toEqual({ contents: 'read' });
    });

    it('grants `id-token: write` to the apply job and to no other job', () => {
      const withIdToken = Object.entries(JOBS)
        .filter(([, j]) => String((j.permissions ?? {})['id-token'] ?? '') === 'write')
        .map(([n]) => n);
      expect(withIdToken).toEqual(['apply']);
    });

    it('gives the recovery-approval gate no Azure reach at all', () => {
      const gate = JOBS['recovery_approval'] ?? {};
      expect((gate.permissions ?? {})['id-token']).toBeUndefined();
      // It is an approval, not a deploy: no action, no login, no terraform.
      const runs = (gate.steps ?? []).map(s => `${s.uses ?? ''} ${s.run ?? ''}`).join('\n');
      expect(runs).not.toMatch(/azure\/login/);
      expect(runs).not.toMatch(/terraform/);
    });

    it('runs the apply against its own GitHub Environment', () => {
      // `development-infra-apply` is what makes the apply identity's OIDC subject
      // genuinely differ from the app-deploy identity's (`development`) and the
      // prod plan identity's (`production`). Before MG-23 every dev identity
      // federated the identical `environment:development` subject and was chosen
      // only by which client-id a job passed — so a one-line client-id edit
      // silently upgraded a read-only job to full apply. MG-23 closed that both
      // ways: the environments are now distinct, and the dev plan identity that
      // shared the subject was deleted outright when PR validation went
      // credentialless.
      expect(APPLY.environment).toBe('development-infra-apply');
    });

    it('authenticates as the dedicated infra-apply identity, not the plan or app-deploy identity', () => {
      const login = APPLY_STEPS.find(s => (s.uses ?? '').startsWith('azure/login'));
      expect(login).toBeDefined();
      const clientId = String((login?.with ?? {})['client-id'] ?? '');
      expect(clientId).toMatch(/vars\.AZURE_INFRA_APPLY_CLIENT_ID\b/);
      expect(clientId).not.toMatch(/vars\.AZURE_CLIENT_ID\b/);
      expect(clientId).not.toMatch(/vars\.AZURE_APP_DEPLOY_CLIENT_ID\b/);
      // OIDC, never a long-lived service-principal secret.
      expect((login?.with ?? {})['creds']).toBeUndefined();
      expect(RAW).not.toMatch(/secrets\.AZURE_CREDENTIALS/);
    });
  });

  describe('concurrency', () => {
    it('is acquired on the APPLY JOB, never at the workflow level', () => {
      // A workflow-level group is held from the moment the RUN starts — which,
      // on the recovery path, is while `recovery_approval` sits parked on a
      // human reviewer. A dispatch left unapproved would hold the
      // infrastructure-apply group indefinitely, and because GitHub keeps at
      // most ONE pending entry per group, the automatic post-merge runs queued
      // behind it are silently discarded rather than merely delayed. Automatic
      // reconciliation would stop, with no red job anywhere to say so.
      expect(WF.concurrency).toBeUndefined();

      const c = (APPLY as Record<string, unknown>)['concurrency'] as
        | { group?: string; 'cancel-in-progress'?: boolean }
        | undefined;
      expect(c).toBeDefined();
      expect(String(c?.group ?? '')).toContain('development-infra-apply');
      // Cancelling mid-apply leaves state and reality disagreeing.
      expect(c?.['cancel-in-progress']).toBe(false);
    });

    it('leaves the parked recovery approval holding no apply concurrency', () => {
      const gate = (JOBS['recovery_approval'] ?? {}) as Record<string, unknown>;
      const gateConcurrency = gate['concurrency'] as { group?: string } | undefined;
      // Either no group at all, or one that is NOT the apply group — what must
      // never happen is the approval job sitting on the group the applies use.
      const applyGroup = String(
        ((APPLY as Record<string, unknown>)['concurrency'] as { group?: string })?.group ?? ''
      );
      expect(applyGroup).not.toBe('');
      expect(String(gateConcurrency?.group ?? '')).not.toBe(applyGroup);
    });

    it('still serializes recovery and automatic applies against the same state', () => {
      // The whole point of moving the group is that a WAITING approval blocks
      // nothing — not that applies stop excluding each other. Both entry paths
      // funnel into the one apply job, so they share its group by construction,
      // and terraform's own blob lease is the second layer.
      const terraformJobs = Object.entries(JOBS)
        .filter(([, j]) => (j.steps ?? []).some(s => /terraform /.test(String(s.run ?? ''))))
        .map(([n]) => n);
      expect(terraformJobs).toEqual(['apply']);
      for (const line of applyRunLines()) {
        if (/terraform (plan|apply)\b/.test(line)) expect(line).toMatch(/-lock-timeout=/);
      }
    });
  });

  describe('run-time ceiling', () => {
    it('bounds the apply job with a realistic timeout', () => {
      // The runner default is 360 minutes. A wedged apply would hold both the
      // concurrency group and the Azure blob lease on meatgeek-v2/dev.tfstate
      // for six hours before anything noticed.
      const t = (APPLY as Record<string, unknown>)['timeout-minutes'];
      expect(typeof t).toBe('number');
      expect(t).toBe(90);
    });

    it('never force-unlocks state automatically', () => {
      // `terraform force-unlock` from automation is a state-corruption
      // primitive: it releases a lease whose holder may still be mid-write, so
      // the next run interleaves against it. Recovery from a timed-out apply is
      // an operator action, and the workflow says where the procedure lives.
      for (const line of applyRunLines()) {
        expect(line).not.toMatch(/force-unlock/);
      }
      expect(COMMENT_PROSE).toMatch(/force-unlock/);
      expect(COMMENT_PROSE).toMatch(/OPERATOR action/i);
    });
  });

  describe('stale-SHA protection (never apply superseded trunk)', () => {
    const iFresh = APPLY_STEPS.findIndex(s => s.id === 'freshness');
    const iFreshFinal = APPLY_STEPS.findIndex(s => s.id === 'freshness_final');
    const iLoginS = usesIndex('azure/login');
    const iApplyS = stepIndex(/terraform apply\b/);

    it('checks the main tip BEFORE authenticating to Azure', () => {
      // A superseded run must not even mint an OIDC token for an identity
      // holding Contributor + RBAC Administrator.
      expect(iFresh).toBe(0);
      expect(iLoginS).toBeGreaterThan(iFresh);
    });

    it('RE-checks immediately before the apply, closing the TOCTOU window', () => {
      // init + plan + two gates take minutes; main can advance during any of
      // them. Without the re-check this run would apply a tree that predates a
      // change already on main — a silent unattended ROLLBACK that the final
      // drift plan cannot catch, because it compares reality against the STALE
      // tree this run checked out and therefore reports CONVERGED.
      expect(iFreshFinal).toBeGreaterThan(-1);
      expect(iApplyS).toBeGreaterThan(iFreshFinal);
      // Nothing may run between the re-check and the apply.
      expect(iApplyS).toBe(iFreshFinal + 1);
    });

    it('resolves the tip live rather than trusting the event payload', () => {
      for (const idx of [iFresh, iFreshFinal]) {
        const run = String(APPLY_STEPS[idx]?.run ?? '');
        expect(run).toMatch(/gh api/);
        expect(run).toMatch(/commits\/main/);
        // Fail closed on an unresolvable SHA: comparing "" to "" reads as fresh.
        expect(run).toMatch(/\[0-9a-f\]\{40\}/);
      }
    });

    it('RETRIES the tip lookup with backoff, so one API blip cannot redden a reconcile', () => {
      // Under `set -eu` an unretried `gh api` makes every transient
      // api.github.com failure — a 502, a secondary rate limit, a dropped
      // connection — fail a gate that sits on the critical path of every push
      // to main. At the SECOND gate it is worse than noise: the plan has been
      // taken and the state lease on meatgeek-v2/dev.tfstate is held, so a
      // transient blip fails the run while holding the lease.
      for (const idx of [iFresh, iFreshFinal]) {
        const run = String(APPLY_STEPS[idx]?.run ?? '');
        // A bounded, backing-off retry loop around the lookup.
        const backoff = run.match(/for\s+delay\s+in\s+([0-9 ]+);/);
        expect(backoff).not.toBeNull();
        const delays = String(backoff?.[1] ?? '')
          .trim()
          .split(/\s+/)
          .map(Number);
        // Bounded: more than one attempt, but not an unbounded wait.
        expect(delays.length).toBeGreaterThanOrEqual(3);
        expect(delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120);
        // Backing OFF, not a hot loop: strictly increasing, first attempt immediate.
        expect(delays[0]).toBe(0);
        expect(delays).toEqual([...delays].sort((a, b) => a - b));
        expect(new Set(delays).size).toBe(delays.length);
        expect(run).toMatch(/sleep\s+"?\$\{?delay/);
        // The retry must not become a way to pass the gate without an answer:
        // exhaustion still fails closed rather than assuming "fresh".
        expect(run).toMatch(/\[\s+-n\s+"\$TIP"\s+\]\s+\|\|/);
        // ...and the failure branch must not set fresh=true.
        const exhausted = run.slice(run.indexOf('[ -n "$TIP" ]'));
        expect(exhausted.slice(0, exhausted.indexOf('}'))).not.toMatch(/fresh=true/);
      }
    });

    it('SKIPS CLEANLY on the automatic path and FAILS on the recovery path', () => {
      for (const idx of [iFresh, iFreshFinal]) {
        const run = String(APPLY_STEPS[idx]?.run ?? '');
        // workflow_dispatch: the operator reviewed a specific plan, possibly
        // with a destroy authorization attached. Silently skipping would leave
        // them believing a recovery ran.
        expect(run).toMatch(/workflow_dispatch/);
        expect(run).toMatch(/exit 1/);
        // workflow_run: superseded is not a failure — a newer run is already
        // queued for the newer SHA. A red job here is noise that trains people
        // to ignore this workflow.
        expect(run).toMatch(/fresh=false/);
        expect(run).toMatch(/fresh=true/);
      }
    });

    it('gates every Azure-touching step on the guard', () => {
      // A step that forgets the `if:` runs on a superseded tree.
      const ungated = APPLY_STEPS.filter((s, i) => {
        if (i === iFresh) return false;
        // The always() shred, matched on WHAT IT REMOVES. The bare `rm -f` this
        // used to match is a substring of any step that cleans up a temp file —
        // MG-58's live host-storage gate does, and it was silently inheriting
        // the shred's exemption instead of being held to a stated one.
        if (/rm -f[^\n]*tfplan\.bin/.test(String(s.run ?? ''))) return false;
        // MG-58's live host-storage gate is EXEMPT on the same reasoning as the
        // post-apply state gate below, and the exemption is stated rather than
        // inherited: it must run even when a timeout kill pre-empted the
        // freshness steps, because a partially-applied run is the case most
        // likely to have UPDATED the Function App and re-injected the key. Its
        // equivalent guard lives in the step BODY, keyed on `.terraform/`.
        if (/assert-live-host-storage\.sh/.test(String(s.run ?? ''))) {
          expect(String(s.if ?? '').trim()).toBe('always()');
          expect(String(s.run ?? '')).toMatch(/\.terraform/);
          return false;
        }
        // The post-apply state secret gate is EXEMPT, and the exemption is the
        // point rather than an oversight: it must run even when a timeout kill
        // pre-empted the freshness steps entirely (see the always() test below).
        // Its equivalent guard lives in the step BODY — it no-ops unless
        // `.terraform/` proves a backend was actually bound — which is strictly
        // stronger here, because it reads real runner state instead of a step
        // output that a cancellation may have prevented from ever being written.
        // Matched on the POST-apply shape specifically (state piped into the
        // gate). The PRE-apply gate also runs this script — against the saved
        // plan FILE — and stays freshness-gated like every other step.
        if (/terraform show -json[^\n]*tf-plan-secret-inspection\.sh/.test(String(s.run ?? ''))) {
          expect(String(s.run ?? '')).toMatch(/\.terraform/);
          return false;
        }
        return !/steps\.freshness\.outputs\.fresh == 'true'/.test(String(s.if ?? ''));
      }).map(s => s.name);
      expect(ungated).toEqual([]);
    });

    it('gates the apply and the final drift plan on BOTH checks', () => {
      // The post-apply state gate is deliberately NOT in this list — it is
      // always()-run so a partial apply's mutated state is still inspected.
      const mustHaveBoth = [iApplyS, stepIndex(/-detailed-exitcode/)];
      for (const idx of mustHaveBoth) {
        expect(idx).toBeGreaterThan(-1);
        expect(String(APPLY_STEPS[idx]?.if ?? '')).toMatch(
          /steps\.freshness_final\.outputs\.fresh == 'true'/
        );
      }
    });
  });

  describe('checkout', () => {
    it("pins the checkout to the exact CI'd SHA, never a floating ref", () => {
      const checkout = APPLY_STEPS.find(s => (s.uses ?? '').startsWith('actions/checkout'));
      expect(checkout).toBeDefined();
      const ref = String((checkout?.with ?? {})['ref'] ?? '');
      expect(ref).toMatch(/github\.event\.workflow_run\.head_sha/);
    });

    it('is the first step that touches the repo or Azure', () => {
      // Only the stale-SHA guard precedes it — it needs no checkout (it reads
      // the tip through the API), and a superseded run should not even clone.
      expect(usesIndex('actions/checkout')).toBe(1);
      expect(APPLY_STEPS[0]?.id).toBe('freshness');
    });
  });

  describe('the gate sequence and its order', () => {
    const iLogin = usesIndex('azure/login');
    const iInit = stepIndex(/terraform init\b/);
    const iPlan = stepIndex(/terraform plan[^\n]*-out=/);
    const iPreGate = stepIndex(/tf-plan-secret-inspection\.sh\s+tfplan\.bin/);
    const iDestroy = stepIndex(/tf-plan-destroy-guard\.sh\s+tfplan\.bin/);
    const iApply = stepIndex(/terraform apply\b/);
    const iPostGate = stepIndex(/terraform show -json[^\n]*tf-plan-secret-inspection\.sh/);
    const iDrift = stepIndex(/terraform plan[^\n]*-detailed-exitcode/);

    it('contains every required step', () => {
      expect({ iLogin, iInit, iPlan, iPreGate, iDestroy, iApply, iPostGate, iDrift }).toEqual(
        expect.objectContaining({
          iLogin: expect.any(Number),
          iInit: expect.any(Number),
        })
      );
      for (const [label, idx] of Object.entries({
        'azure/login': iLogin,
        'terraform init': iInit,
        'terraform plan -out': iPlan,
        'pre-apply secret gate': iPreGate,
        'destroy circuit-breaker': iDestroy,
        'terraform apply': iApply,
        'post-apply state gate': iPostGate,
        'final drift plan': iDrift,
      })) {
        expect({ step: label, present: idx !== -1 }).toEqual({ step: label, present: true });
      }
    });

    it('orders them: login -> init -> plan -> pre-gate -> destroy-breaker -> apply -> post-gate -> drift plan', () => {
      // The order IS the control. A destroy-breaker after the apply, or a
      // secret gate after the apply only, inspects a change set that already
      // executed.
      const order = [iLogin, iInit, iPlan, iPreGate, iDestroy, iApply, iPostGate, iDrift];
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // ...and strictly increasing (no two of these collapsed into one step,
      // which would let a `&&` chain short-circuit a gate).
      expect(new Set(order).size).toBe(order.length);
    });

    it('applies THAT EXACT saved plan file — never a bare `terraform apply`', () => {
      const applyLines = applyRunLines().filter(l => /terraform apply\b/.test(l));
      expect(applyLines.length).toBe(1);
      // The saved plan file must be the final positional argument.
      expect(applyLines[0]).toMatch(/terraform apply[^\n]*\btfplan\.bin\s*$/);
      // A re-plan at apply time would execute a change set neither gate saw.
      expect(applyLines[0]).not.toMatch(/-var-file/);
    });

    it('runs both gates as REAL executed steps against real, executable scripts', () => {
      // Until MG-23 tf-plan-secret-inspection.sh was referenced by NO workflow.
      // MG-23 requires it as an EXECUTED gate, not a documented intention.
      for (const rel of [
        'apps/infrastructure/scripts/tf-plan-secret-inspection.sh',
        'apps/infrastructure/scripts/tf-plan-destroy-guard.sh',
      ]) {
        const p = path.join(REPO_ROOT, rel);
        expect({ script: rel, exists: fs.existsSync(p) }).toEqual({ script: rel, exists: true });
        // eslint-disable-next-line no-bitwise
        const executable = (fs.statSync(p).mode & 0o111) !== 0;
        expect({ script: rel, executable }).toEqual({ script: rel, executable: true });
      }
    });

    it('never lets a gate failure be swallowed', () => {
      // `continue-on-error` on a gate step, or a trailing `|| true`, converts a
      // fail-closed gate into a decorative one.
      for (const s of APPLY_STEPS) {
        expect((s as Record<string, unknown>)['continue-on-error']).toBeUndefined();
      }
      for (const line of applyRunLines()) {
        if (/tf-plan-(secret-inspection|destroy-guard)\.sh/.test(line)) {
          expect(line).not.toMatch(/\|\||\btrue\b|continue/);
        }
      }
    });

    it('fails the run on drift rather than merely reporting it', () => {
      const drift = APPLY_STEPS[iDrift];
      const run = String(drift?.run ?? '');
      expect(run).toMatch(/-detailed-exitcode/);
      // exit code 2 from -detailed-exitcode means "changes present" — it must be
      // converted into a failure, not logged and swallowed.
      expect(run).toMatch(/exit 1/);
    });

    it('INSPECTS STATE EVEN WHEN THE APPLY FAILED, without making the run green', () => {
      // A `terraform apply` that fails part-way through has STILL MUTATED
      // STATE: every resource created before the failure is written to
      // meatgeek-v2/dev.tfstate together with its computed attributes. A
      // partial apply is therefore exactly the case where a credential can
      // reach state — and a success-gated inspection is the one run that would
      // never look at it. So the post-apply gate is always-run.
      const post = APPLY_STEPS[iPostGate];
      const postIf = String(post?.if ?? '');
      // UNCONDITIONAL always(), and specifically NOT `!cancelled()`. A
      // `timeout-minutes` kill CANCELS the job, and the job is most likely to be
      // killed while wedged mid-write — the partial-apply case this gate exists
      // for. Under `!cancelled()` the gate skipped exactly then, leaving mutated
      // state uninspected. This is the regression that must not come back.
      expect(postIf.trim()).toBe('always()');
      expect(postIf).not.toMatch(/cancelled\(\)/);
      // Nor may it depend on the freshness step outputs: a timeout can kill the
      // job before `freshness_final` records one, and a step conditioned on an
      // output that was never written does not run — the same hole one level
      // down. The "did this run touch state at all?" question is answered inside
      // the step body instead, from the runner's actual state.
      expect(postIf).not.toMatch(/steps\.freshness/);

      // ALWAYS-RUN MUST NOT BECOME ALWAYS-PASS. The apply's own failure keeps
      // the job red; this step adds a failure rather than replacing one, so it
      // must carry no error tolerance of any kind.
      expect((post as Record<string, unknown>)['continue-on-error']).toBeUndefined();
      // Nor may the APPLY step tolerate its own failure — that is what would
      // actually turn a partial apply green.
      expect((APPLY_STEPS[iApply] as Record<string, unknown>)['continue-on-error']).toBeUndefined();

      // Running unconditionally means the step must handle a run that never got
      // as far as binding a backend — checkout skipped, init failed, a superseded
      // automatic run. `.terraform/` exists only once `terraform init` has bound
      // the backend, so its absence is positive proof no state was mutated and
      // the step no-ops cleanly. Without this guard, `always()` would turn every
      // cleanly-skipped run red.
      const run = String(post?.run ?? '');
      expect(run).toMatch(/\.terraform/);
      const noopBranch = run.slice(0, run.indexOf('terraform state list'));
      expect(noopBranch).toMatch(/exit 0/);

      // The empty-state branch is a NO-OP for a run that wrote nothing, not a
      // bypass: an unreadable state must fail closed rather than exit 0.
      expect(run).toMatch(/terraform state list/);
      expect(run).toMatch(/exit 0/);
      expect(run).toMatch(/exit 1/);
      const inconclusive = run.slice(0, run.indexOf('exit 1'));
      expect(inconclusive).toMatch(/failing closed/i);
    });

    it('SURFACES WHY state was unreadable, without printing state', () => {
      // Failing closed is right; failing closed with nothing but "could not read
      // state" is not. That branch is an INCIDENT path — expired credentials, a
      // deleted or re-keyed state account, a corrupt state document, a backend
      // that moved — and terraform's own error is the only thing that tells those
      // apart. Discarding it leaves the operator with a red step and no lead on
      // the one path where they most need one.
      const run = String(APPLY_STEPS[iPostGate]?.run ?? '');

      // STDERR is CAPTURED, not sent to /dev/null. The regression being pinned is
      // literally `terraform state list 2>/dev/null`.
      expect(run).toMatch(/terraform state list\b/);
      expect(run).not.toMatch(/terraform state list[^\n]*2>\s*\/dev\/null/);
      expect(run).toMatch(/terraform state list[^\n]*2>\s*"?\$/);

      // ...and it is actually PRINTED on the failure path, before the fail-closed
      // exit. Captured-then-discarded would satisfy the check above while leaving
      // the operator exactly as blind.
      const inconclusive = run.slice(0, run.indexOf('exit 1'));
      expect(inconclusive).toMatch(/cat\s+"\$STATE_ERR"\s*>&2/);

      // WHAT MUST NOT LEAK: stdout. `terraform state list` writes resource
      // ADDRESSES to stdout — that is the state read — and it stays captured in
      // STATE_ADDRS, never echoed. Only stderr, which carries terraform's
      // diagnostic text and not resource values, reaches the log.
      expect(run).toMatch(/STATE_ADDRS="\$\(terraform state list/);
      expect(run).not.toMatch(/echo[^\n]*\$STATE_ADDRS/);
      expect(run).not.toMatch(/cat[^\n]*\$STATE_ADDRS/);
    });

    it('keeps the FINAL DRIFT PLAN success-gated, so it cannot run after a failed apply', () => {
      // The drift plan is a convergence PROOF; running it after a partial apply
      // would prove nothing and would only relabel a known failure. It must
      // stay implicitly success()-gated — the always-run relaxation belongs to
      // the state secret gate alone.
      const driftIf = String(APPLY_STEPS[iDrift]?.if ?? '');
      expect(driftIf).not.toMatch(/!cancelled\(\)|always\(\)/);
    });
  });

  /* ------------------------------------------------------------------------ *
   * MG-58 GUARD 4 — THE LIVE HOST-STORAGE GATE.
   *
   * WHY THIS BLOCK EXISTS AT ALL. PR #42 added the correct identity-based
   * host-storage setting, two convergence plans came back clean, eleven CI
   * checks went green, the dev apply succeeded — and host storage was still
   * dead, because hashicorp/azurerm v4.81.0 itself composes and writes a scalar
   * `AzureWebJobsStorage` connection string with an EMPTY AccountKey on every
   * Function App create AND Update, and on read routes it out of `app_settings`
   * into `storage_access_key`. The Functions host resolves the connection-string
   * form first and never reaches the identity form. The key is therefore absent
   * from HCL, absent from the saved plan, absent from post-apply state — so
   * every gate in this workflow that reads one of those surfaces was
   * TRUTHFULLY green about a site that was broken.
   *
   * Guards 1-3 (the module's tftests and the fixture harnesses) are regression
   * fences against a HUMAN reintroducing the key in HCL. This step is the only
   * thing in the system that can observe the defect that actually shipped, which
   * makes each of its properties below load-bearing rather than stylistic.
   * ------------------------------------------------------------------------ */
  describe('MG-58 guard 4: the live host-storage gate (asserted on the DEPLOYED site)', () => {
    const GATE_SCRIPT = 'apps/infrastructure/scripts/assert-live-host-storage.sh';
    const iLive = stepIndex(/assert-live-host-storage\.sh/);
    const iDriftPlan = stepIndex(/terraform plan[^\n]*-detailed-exitcode/);
    const iShred = stepIndex(/rm -f[^\n]*tfplan\.bin/);
    const LIVE = APPLY_STEPS[iLive] ?? {};
    const LIVE_RUN = String(LIVE.run ?? '');
    const LIVE_LINES = logicalLines(LIVE_RUN);

    // The az INVOCATIONS, distinguished from the `echo` lines that merely NAME
    // them on the failure paths. Scanning for the command as a substring would
    // pick up `echo "az functionapp config appsettings list reported:"` and
    // report a settings read with no pipe into the gate — a false failure that
    // trains people to delete the assertion rather than keep the message.
    const AZ_LIST = /^(?:if\s+!\s+)?az functionapp config appsettings list\b/;
    const AZ_DELETE = /^(?:if\s+!\s+)?az functionapp config appsettings delete\b/;

    /**
     * The `GATE_RC == 3` (key-present) branch only — from the `elif` that opens
     * it to the `else` that closes it. Every assertion about the remediation is
     * scoped to this slice, so "the delete is guarded on the key having been
     * found" is proven by WHERE the delete is, not merely by the branch existing
     * somewhere in the same step.
     */
    const keyFoundBranch = (() => {
      const start = LIVE_RUN.indexOf('elif [ "$GATE_RC" -eq 3 ]');
      if (start === -1) return '';
      const rest = LIVE_RUN.slice(start);
      const close = /\n\s*else\b/.exec(rest);
      return close ? rest.slice(0, close.index) : rest;
    })();

    it('exists as a real step in the apply job, and in no other job', () => {
      expect(iLive).toBeGreaterThan(-1);
      const carriers = allLogicalLines()
        .filter(l => /assert-live-host-storage\.sh/.test(l.line))
        .map(l => l.job);
      expect(Array.from(new Set(carriers))).toEqual(['apply']);
      // Exactly one step carries it: a second copy would be a second gate
      // sequence to drift out of step with this one.
      expect(
        APPLY_STEPS.filter(s => /assert-live-host-storage\.sh/.test(String(s.run ?? ''))).length
      ).toBe(1);
    });

    it('invokes a REAL, EXECUTABLE gate script rather than a documented intention', () => {
      const p = path.join(REPO_ROOT, GATE_SCRIPT);
      expect({ script: GATE_SCRIPT, exists: fs.existsSync(p) }).toEqual({
        script: GATE_SCRIPT,
        exists: true,
      });
      // eslint-disable-next-line no-bitwise
      const executable = fs.existsSync(p) && (fs.statSync(p).mode & 0o111) !== 0;
      expect({ script: GATE_SCRIPT, executable }).toEqual({
        script: GATE_SCRIPT,
        executable: true,
      });
      // ...and the expected account name is passed, so the assertion is
      // live-versus-DESIRED rather than live-versus-itself.
      expect(LIVE_RUN).toMatch(/assert-live-host-storage\.sh\s+--account-name\s+"\$SA"/);
    });

    it('runs AFTER the final drift plan and BEFORE the shred', () => {
      // Order is the control, exactly as it is for the pre-apply gates. The
      // drift plan is the convergence PROOF and must be measured against live
      // state this step has not yet perturbed; remediating first would let a
      // change land between the apply and the proof. Placing it before the
      // shred keeps it inside the job's real work rather than in teardown.
      expect(iDriftPlan).toBeGreaterThan(-1);
      expect(iShred).toBeGreaterThan(-1);
      expect(iLive).toBeGreaterThan(iDriftPlan);
      expect(iLive).toBeLessThan(iShred);
    });

    it('is UNCONDITIONALLY always(), never freshness-gated', () => {
      // Same reasoning as the post-apply state gate, one level along: a
      // `timeout-minutes` kill can land before `freshness_final` ever writes an
      // output, and a step conditioned on an output that was never written does
      // not run — while a partially-applied run is precisely the case most
      // likely to have UPDATED the Function App and re-injected the key.
      const liveIf = String(LIVE.if ?? '');
      expect(liveIf.trim()).toBe('always()');
      expect(liveIf).not.toMatch(/steps\.freshness/);
      expect(liveIf).not.toMatch(/cancelled\(\)/);
    });

    it('resolves the three outcomes distinctly, and only "could not have happened" exits 0', () => {
      // nothing bound / no Function App in state -> clean exit 0, because the
      // run provably cannot have caused an injection.
      const preamble = LIVE_RUN.slice(
        0,
        LIVE_RUN.indexOf('az functionapp config appsettings list')
      );
      expect(preamble).toMatch(/\.terraform/);
      expect(preamble).toMatch(/terraform state list/);
      expect(preamble).toMatch(/azurerm_function_app/);
      expect(preamble).toMatch(/exit 0/);

      // ...but an unreadable state or an unreadable SITE is NOT "nothing to
      // see": it fails closed and prints the CLI's own stderr, which is the only
      // thing that tells expired credentials from a deleted app.
      expect(LIVE_RUN).toMatch(/failing closed/i);
      expect(LIVE_RUN).toMatch(/az functionapp config appsettings list[\s\S]*2>\s*"?\$/);
      const afterRead = LIVE_RUN.slice(LIVE_RUN.indexOf('if [ "$AZ_RC" -ne 0 ]'));
      const unreadable = afterRead.slice(0, afterRead.indexOf('exit 1') + 'exit 1'.length);
      expect(unreadable).toMatch(/cat\s+"\$ERR"\s*>&2/);
      expect(unreadable).toMatch(/exit 1/);
      // The az read's stderr must be CAPTURED, not discarded — the regression
      // being pinned is a bare `2>/dev/null` on the read.
      expect(LIVE_RUN).not.toMatch(/appsettings list[\s\S]{0,200}?2>\s*\/dev\/null/);
    });

    it('never lets the settings DOCUMENT out of the gate’s stdin', () => {
      // `az functionapp config appsettings list` returns VALUES — connection
      // strings among them — and this job's log is retained and broadly
      // readable. The document is piped straight into the gate: no file, no
      // `tee`, no artifact, no echo, and no command substitution that would
      // park it in a shell variable someone later prints.
      const listCmds = LIVE_LINES.filter(l => AZ_LIST.test(l));
      expect(listCmds.length).toBeGreaterThan(0);
      for (const cmd of listCmds) {
        expect({
          cmd,
          pipedToGate: /\|\s*scripts\/assert-live-host-storage\.sh/.test(cmd),
        }).toEqual({ cmd, pipedToGate: true });
        // No stdout redirection anywhere in the invocation. `2>"$ERR"` and
        // `>&2` are stderr and are allowed; anything else is a file.
        expect({ cmd, stdoutRedirected: /(?<!2)>(?!&2)/.test(cmd) }).toEqual({
          cmd,
          stdoutRedirected: false,
        });
        expect(cmd).not.toMatch(/\btee\b/);
        expect(cmd).not.toMatch(/\bupload-artifact\b/);
      }
      // Never captured into a shell variable — a capture is what makes a later
      // `echo "$SETTINGS"` possible, and it is the one edit that would satisfy
      // every per-invocation check above while still putting the document in the
      // log. There is no assignment form of this command anywhere in the step.
      expect(LIVE_RUN).not.toMatch(/\$\(\s*(?:if\s+!\s+)?az functionapp config appsettings list/);
      expect(LIVE_RUN).not.toMatch(/=\s*"?\$\([^)]*appsettings list/);
      // The only lines that print the command's NAME are fixed diagnostic
      // labels — no substitution, so nothing of the document can ride along.
      for (const line of LIVE_LINES.filter(l =>
        /^(echo|cat|printf)\b[^\n]*appsettings list/.test(l)
      )) {
        expect({ line, substitutes: /\$\(|`/.test(line) }).toEqual({ line, substitutes: false });
      }
      // The gate's own stdout is safe by construction (names and reasons only),
      // so it is the one thing that may reach the log.
      expect(LIVE).not.toHaveProperty('uses');
    });

    it('discards the DELETE’s stdout, which echoes the full settings list on success', () => {
      const delCmds = LIVE_LINES.filter(l => AZ_DELETE.test(l));
      expect(delCmds.length).toBe(1);
      expect(delCmds[0]).toMatch(/>\s*\/dev\/null/);
      expect(delCmds[0]).toMatch(/--output none/);
      // Its stderr is captured separately so the failure path can print the
      // CLI's diagnostic without printing the document.
      expect(delCmds[0]).toMatch(/2>\s*"\$DEL_ERR"/);
    });

    it('remediates EXACTLY one setting key on EXACTLY one app', () => {
      // The app-settings sub-resource is replace-the-whole-collection, so a
      // broader delete would strip provider-injected settings the module never
      // declares — health-check ping-failure, the App Insights connection
      // string, deployment storage — and the loss would be invisible in HCL for
      // precisely the reason the current defect is.
      const delCmds = allLogicalLines().filter(l => AZ_DELETE.test(l.line));
      expect(delCmds.length).toBe(1);
      // ...and it is in the apply job, not somewhere a lesser gate could reach.
      expect(delCmds[0].job).toBe('apply');
      const del = delCmds[0].line;

      const named = /--setting-names\s+(.*?)\s+--/.exec(del);
      expect(named).not.toBeNull();
      expect(
        String(named?.[1] ?? '')
          .trim()
          .split(/\s+/)
      ).toEqual(['AzureWebJobsStorage']);
      // The identity form must never be in the blast radius: deleting it is the
      // rollback that is strictly worse than the defect.
      expect(del).not.toMatch(/AzureWebJobsStorage__/);

      // One app, and both it and the resource group come from `terraform
      // output` rather than from a literal — a hardcoded name would let this
      // step mutate whatever app that string happens to address.
      expect((del.match(/--name\b/g) ?? []).length).toBe(1);
      expect(del).toMatch(/--name\s+"\$APP"/);
      expect(del).toMatch(/--resource-group\s+"\$RG"/);
      expect(LIVE_RUN).toMatch(/APP="\$\(terraform output -raw function_app_name/);
      expect(LIVE_RUN).toMatch(/RG="\$\(terraform output -raw resource_group_name/);
      expect(LIVE_RUN).toMatch(/SA="\$\(terraform output -raw storage_account_name/);
      // No live resource name may be spelled out in the step.
      expect(LIVE_RUN).not.toMatch(/mgv2dev/i);
      expect(LIVE_RUN).not.toMatch(/meatgeek-v2-dev-rg/);
    });

    it('reaches the delete ONLY when the gate reported the key present', () => {
      // Steady state on the many pushes that touch no infrastructure is zero
      // deletions: the remediation is conditional on PRESENCE (the gate's
      // dedicated exit code 3), not on the gate having failed for any reason.
      expect(LIVE_RUN).toMatch(/GATE_RC="?\$\{?RC\[1\]/);
      expect(keyFoundBranch).not.toBe('');
      expect(keyFoundBranch).toMatch(/az functionapp config appsettings delete/);
      // ...and it appears nowhere else in the step.
      expect(LIVE_RUN.indexOf('az functionapp config appsettings delete')).toBeGreaterThan(
        LIVE_RUN.indexOf('elif [ "$GATE_RC" -eq 3 ]')
      );
      // A gate verdict that is neither clean nor key-present is a REJECTION,
      // and it must fail rather than fall through to remediation.
      const other = LIVE_RUN.slice(LIVE_RUN.indexOf(keyFoundBranch) + keyFoundBranch.length);
      expect(other).toMatch(/exit 1/);
      expect(other).not.toMatch(/appsettings delete/);
    });

    it('RE-READS and RE-ASSERTS after deleting, rather than trusting the delete', () => {
      // A delete that reported success is not proof the site is clean; only
      // reading it back is. The re-read goes through the same gate, and its own
      // failure to read fails closed.
      expect((LIVE_RUN.match(/assert-live-host-storage\.sh/g) ?? []).length).toBe(2);
      expect(keyFoundBranch).toMatch(/az functionapp config appsettings list/);
      expect(keyFoundBranch).toMatch(/assert-live-host-storage\.sh/);
      expect(keyFoundBranch).toMatch(/RE_RC/);
    });

    it('DETECTS collateral setting loss around the delete, and fails RED on it', () => {
      // `az functionapp config appsettings delete` is NOT a server-side per-key
      // delete. The app-settings sub-resource is replace-the-whole-collection,
      // so the CLI GETs the collection, drops the key CLIENT-SIDE and PUTs it
      // all back with no ETag and no If-Match — the same read-modify-write
      // hazard the ADR uses to reject a second azapi writer. The mechanism
      // NARROWS that window; it does not eliminate it. So the residual is
      // DETECTED rather than assumed away: the setting NAME set is captured
      // before and after and must differ by exactly the one removed key.
      const before = /--names-out\s+"\$NAMES_BEFORE"/;
      const after = /--names-out\s+"\$NAMES_AFTER"/;
      expect(LIVE_RUN).toMatch(before);
      expect(LIVE_RUN).toMatch(after);
      // BOTH sets come from the GATE, never from a second `az ... list` piped
      // somewhere other than the gate — that shape is what the stdin invariant
      // above forbids, and it is one edit away from `.[].value`.
      for (const cmd of LIVE_LINES.filter(l => /--names-out/.test(l))) {
        expect({ cmd, viaGate: /assert-live-host-storage\.sh/.test(cmd) }).toEqual({
          cmd,
          viaGate: true,
        });
      }
      expect(LIVE_RUN).not.toMatch(/appsettings list[\s\S]{0,200}?\|\s*jq/);

      // The comparison exists, is a set difference in BOTH directions, and its
      // failure is RED — anything else lost, and anything gained.
      expect(keyFoundBranch).toMatch(/comm -23/);
      expect(keyFoundBranch).toMatch(/comm -13/);
      const lossBranch = keyFoundBranch.slice(keyFoundBranch.indexOf('COLLATERAL SETTING LOSS'));
      expect(lossBranch).toMatch(/exit 1/);
      expect(keyFoundBranch).not.toMatch(/COLLATERAL SETTING LOSS[\s\S]*?\|\| true/);
    });

    it('does NOT collapse the two re-assert outcomes into one message', () => {
      // They mean different things and point an operator at different places
      // during an incident: exit 3 means the delete did not take and the key is
      // STILL present; any other nonzero means the delete SUCCEEDED and a
      // different violation remains. Both still fail the run — this is about
      // naming the right cause, not softening the failure.
      expect(keyFoundBranch).toMatch(/RE_RC\[1\]\}?"\s+-eq 3/);
      const stillPresent = /REMEDIATION DID NOT TAKE[^\n]*STILL PRESENT/;
      expect(keyFoundBranch).toMatch(stillPresent);
      // The non-3 branch must NOT reuse the "did not take" wording.
      const elifIdx = keyFoundBranch.indexOf('elif [ "${RE_RC[1]}" -ne 0 ]');
      expect(elifIdx).toBeGreaterThan(-1);
      const otherViolation = keyFoundBranch.slice(elifIdx);
      expect(otherViolation).not.toMatch(/REMEDIATION DID NOT TAKE/);
      expect(otherViolation).toMatch(/WAS REMOVED/);
      expect(otherViolation).toMatch(/another reason/);
      expect(otherViolation).toMatch(/exit 1/);
    });

    it('FAILS THE RUN even after a successful remediation (no silent self-heal)', () => {
      // The deliberate policy choice, with its cost accepted in the ADR. A
      // remediation that left the run green would reproduce the EXACT property
      // that let a non-fix ship past eleven green checks — an invisible defect
      // behind a green pipeline — and would mask the moment a provider upgrade
      // changes this behaviour in either direction.
      expect(keyFoundBranch).toMatch(/exit 1/);
      expect(keyFoundBranch).not.toMatch(/exit 0/);
      // The last statement of the branch is the failure, not the "remediated"
      // message: an `exit 1` sitting above a later success path would be dead.
      const branchLines = logicalLines(keyFoundBranch).filter(l => l !== '');
      expect(branchLines[branchLines.length - 1]).toBe('exit 1');
    });

    it('names the CAUSE and points at the ADR and the runbook when it fails', () => {
      // The operator hitting this red step did not cause it and cannot fix it
      // in HCL. A failure that only said "scalar key present" would send them
      // hunting for a human edit or drift that does not exist.
      expect(keyFoundBranch).toMatch(/azurerm/i);
      expect(keyFoundBranch).toMatch(
        /learnings\/decisions\/mg-58-host-storage-managed-identity\.md/
      );
      expect(keyFoundBranch).toMatch(/docs\/infrastructure\/mg58-host-storage-verification\.md/);
    });

    it('never swallows its own failure', () => {
      // `continue-on-error` on the step, or a trailing `|| true` on the assert
      // path, converts a fail-closed gate into a decorative one — which is the
      // failure mode this whole gate exists to end.
      expect((LIVE as Record<string, unknown>)['continue-on-error']).toBeUndefined();
      for (const line of LIVE_LINES) {
        if (/assert-live-host-storage\.sh/.test(line)) {
          expect({ line, tolerant: /\|\||\btrue\b|continue-on-error/.test(line) }).toEqual({
            line,
            tolerant: false,
          });
        }
      }
      // `set -e` is not enough on a pipeline whose exit code is inspected, so
      // the step reads PIPESTATUS explicitly rather than swallowing either half.
      expect(LIVE_RUN).toMatch(/set -eu/);
      expect(LIVE_RUN).toMatch(/PIPESTATUS/);
    });

    it('takes NO new authority: no second login, no new permission, no new job', () => {
      // The step runs inside the EXISTING apply job under the `azure/login`
      // already performed, its existing environment, and its existing
      // `id-token: write`. MG-58's brief forbids any RBAC change, and the
      // cheapest way to violate that accidentally is a new credentialed job.
      const withIdToken = Object.entries(JOBS)
        .filter(([, j]) => String((j.permissions ?? {})['id-token'] ?? '') === 'write')
        .map(([n]) => n);
      expect(withIdToken).toEqual(['apply']);
      expect(APPLY.environment).toBe('development-infra-apply');
      expect(allUses().filter(u => u.startsWith('azure/login')).length).toBe(1);
      expect((LIVE as Record<string, unknown>)['permissions']).toBeUndefined();
      expect((LIVE as Record<string, unknown>)['environment']).toBeUndefined();
      expect(LIVE_RUN).not.toMatch(/\baz login\b/);
    });
  });

  describe('non-interactive, lock-bound terraform invocation', () => {
    it('inits the persistent dev backend non-interactively', () => {
      const init = APPLY_STEPS[stepIndex(/terraform init\b/)];
      const run = String(init?.run ?? '');
      expect(run).toMatch(/-input=false/);
      expect(run).toMatch(/-backend-config=environments\/backend-dev\.hcl/);
      // The state-account name is DERIVED once by the shared helper, never a
      // literal that could drift from the hcl.
      expect(run).toMatch(/scripts\/state-account-name\.sh/);
      expect(run).toMatch(/storage_account_name=/);
    });

    it('never passes -upgrade to terraform init', () => {
      // Without -upgrade, terraform honours the committed .terraform.lock.hcl and
      // installs the exact provider builds whose hashes it records. With
      // -upgrade, a fresh runner resolves whatever satisfies `azurerm ~> 4.0`
      // and then EXECUTES it holding Contributor + RBAC Administrator.
      for (const line of applyRunLines()) {
        if (/terraform init\b/.test(line)) expect(line).not.toMatch(/-upgrade/);
      }
      expect(applyRunLines().join('\n')).not.toMatch(/terraform init[\s\S]{0,200}?-upgrade/);
    });

    it('passes -lockfile=readonly to terraform init', () => {
      // The absence of -upgrade is NECESSARY BUT NOT SUFFICIENT, and this is the
      // assertion that covers the gap. Omitting -upgrade only declines to ASK for
      // newer providers; `init` will still AMEND .terraform.lock.hcl on its own
      // (a provider missing from the lock, a platform hash not recorded) without
      // saying so. `-lockfile=readonly` makes the committed lock authoritative:
      // init FAILS rather than rewriting it.
      //
      // It matters most precisely here. This is the highest-privilege job in the
      // repo, it runs unattended, and any lock rewrite it performed would be
      // thrown away with the runner — so the providers it then executed with
      // Contributor + RBAC Administrator would be ones no reviewer ever saw a
      // hash for, and no artifact would survive to say which they were.
      const initInvocations = applyRunLines().filter(line => /terraform init\b/.test(line));
      expect(initInvocations.length).toBeGreaterThan(0);
      // Asserted on the whole init invocation, not the single matched line: the
      // command is written across continuations, and -lockfile=readonly sits on
      // the first line only by convention, not by requirement.
      expect(applyRunLines().join('\n')).toMatch(/terraform init[\s\S]{0,200}?-lockfile=readonly/);
    });

    it('passes -input=false to every terraform invocation that can prompt', () => {
      for (const line of applyRunLines()) {
        if (/terraform (init|plan|apply)\b/.test(line)) {
          expect({ line: line.trim(), noninteractive: /-input=false/.test(line) }).toEqual({
            line: line.trim(),
            noninteractive: true,
          });
        }
      }
    });

    it('passes -lock-timeout to every terraform plan and apply (init does not lock)', () => {
      // The apply takes the Azure blob lease on meatgeek-v2/dev.tfstate, and
      // terraform defaults to failing IMMEDIATELY when that lease is held.
      // A pull request is not a contender: PR validation is CREDENTIALLESS and
      // runs `terraform init -backend=false`, so it never binds this backend and
      // never touches the lease. Apply-versus-apply is serialized by the
      // environment-scoped concurrency group. What remains is the contender no
      // concurrency group can see: an operator running plan/apply/import or a
      // state migration from a workstation, plus the tail of a just-finished run
      // whose lease is not yet released. Without a timeout either of those turns
      // a reconcile red for a reason unrelated to the change, so the apply path
      // waits instead. `-lock=false` is never correct on this path — it would be
      // state corruption, not a convenience.
      const locking = applyRunLines().filter(l => /terraform (plan|apply)\b/.test(l));
      expect(locking.length).toBeGreaterThanOrEqual(3); // plan, apply, drift plan
      for (const line of locking) {
        expect({ line: line.trim(), waitsForLock: /-lock-timeout=/.test(line) }).toEqual({
          line: line.trim(),
          waitsForLock: true,
        });
      }
    });
  });

  describe('secret hygiene', () => {
    it('SHA-pins every `uses:` (40-hex), so a moved tag cannot re-point a privileged job', () => {
      const uses: string[] = [];
      for (const job of Object.values(JOBS)) {
        for (const s of job.steps ?? []) if (typeof s.uses === 'string') uses.push(s.uses);
      }
      expect(uses.length).toBeGreaterThan(0);
      const verdict = uses.map(u => ({ uses: u, shaPinned: /@[0-9a-f]{40}$/.test(u) }));
      expect(verdict).toEqual(uses.map(u => ({ uses: u, shaPinned: true })));
    });

    it('uploads no artifacts — the saved plan never leaves the runner', () => {
      // Executable surface only: the workflow's own comments NAME the
      // anti-pattern they forbid, and a raw-text scan would match the
      // prohibition itself.
      expect(allUses().filter(u => /upload-artifact|actions\/cache/.test(u))).toEqual([]);
      for (const line of applyRunLines()) {
        expect(line).not.toMatch(/upload-artifact/);
      }
    });

    it('never writes plan or state JSON to the job log', () => {
      // Dev state contains live IoT Hub SAS keys — the one remaining live
      // credential in an otherwise key-free stack.
      const lines = applyRunLines();
      for (const line of lines) {
        expect(line).not.toMatch(/\bcat\b[^\n]*tfplan/);
        expect(line).not.toMatch(/\btee\b/);
        // Any `terraform show` must be PIPED straight into a gate, never printed
        // and never redirected into a file that a later step might echo.
        if (/terraform show\b/.test(line)) {
          expect({ line: line.trim(), piped: /terraform show[^\n]*\|/.test(line) }).toEqual({
            line: line.trim(),
            piped: true,
          });
          expect(line).not.toMatch(/terraform show[^\n]*>/);
        }
      }
      // The setup-terraform stdout-capturing wrapper is disabled, so terraform
      // output does not get a second life inside step outputs.
      const setup = APPLY_STEPS.find(s => (s.uses ?? '').startsWith('hashicorp/setup-terraform'));
      expect((setup?.with ?? {})['terraform_wrapper']).toBe(false);
    });

    it('removes the saved plan when the job ends', () => {
      const shred = APPLY_STEPS.find(s => /rm -f[^\n]*tfplan\.bin/.test(String(s.run ?? '')));
      expect(shred).toBeDefined();
      expect(String(shred?.if ?? '')).toMatch(/always\(\)/);
    });
  });

  describe('shell-injection hardening of `run:` bodies', () => {
    // A `${{ ... }}` expression inside a `run:` block is expanded by GitHub into
    // the script TEXT before the shell ever parses it. When the expression reads
    // an operator- or contributor-controlled context, the value is therefore
    // SOURCE, not data: an `authorized_changes` dispatch input of
    // `'; <command>; echo '` closes the quote and executes arbitrary commands.
    // On this workflow that lands in a job on the privileged recovery path,
    // alongside an identity holding Contributor + Role Based Access Control
    // Administrator on the dev resource group.
    //
    // The safe form — used everywhere in this workflow — binds the expression to
    // an `env:` entry at the step or job level and dereferences it as "$VAR" in
    // the shell, where it arrives as data the shell never re-parses.
    const CONTROLLED =
      /\$\{\{\s*(github\.event\b|inputs\.|github\.head_ref\b|github\.ref_name\b|github\.actor\b)/;

    /** Every executable `run:` line across EVERY job, shell comments stripped. */
    function allRunLines(): { job: string; step: string; line: string }[] {
      const out: { job: string; step: string; line: string }[] = [];
      for (const [jobName, job] of Object.entries(JOBS)) {
        for (const s of job.steps ?? []) {
          if (typeof s.run !== 'string') continue;
          for (const line of s.run.split('\n')) {
            const stripped = line.replace(/^\s+/, '');
            // Strip shell comments: this file's own guidance NAMES the forbidden
            // pattern, and a raw scan would match the prohibition itself.
            if (stripped.startsWith('#') || stripped === '') continue;
            out.push({ job: jobName, step: String(s.name ?? '<unnamed>'), line });
          }
        }
      }
      return out;
    }

    it('never interpolates a controlled context directly into a shell script', () => {
      const lines = allRunLines();
      expect(lines.length).toBeGreaterThan(0);
      const offenders = lines
        .filter(l => CONTROLLED.test(l.line))
        .map(l => `${l.job} / ${l.step}: ${l.line.trim()}`);
      expect(offenders).toEqual([]);
    });

    it('binds the recovery destroy-authorization input via `env:`, not inline', () => {
      const step = (JOBS['recovery_approval']?.steps ?? []).find(s =>
        /AUTHORIZED_CHANGES/.test(String(s.run ?? ''))
      );
      expect(step).toBeDefined();

      // The input reaches the script through an env binding...
      const bound = { ...(JOBS['recovery_approval']?.env ?? {}), ...(step?.env ?? {}) };
      expect(String(bound['AUTHORIZED_CHANGES'] ?? '')).toMatch(
        /\$\{\{\s*github\.event\.inputs\.authorized_changes\s*\}\}/
      );

      // ...and the script dereferences the VARIABLE, never the expression.
      const run = String(step?.run ?? '');
      expect(run).toMatch(/\$\{?AUTHORIZED_CHANGES\}?/);
      expect(run).not.toMatch(/\$\{\{/);
    });

    it('binds the apply job destroy authorization the same way', () => {
      // The apply job's job-level binding (TF_DESTROY_GUARD_AUTHORIZED_CHANGES)
      // is the pattern the recovery step mirrors; assert it stays an `env:`
      // assignment rather than migrating into a `run:` body.
      const env = APPLY.env ?? {};
      expect(String(env['TF_DESTROY_GUARD_AUTHORIZED_CHANGES'] ?? '')).toMatch(
        /\$\{\{\s*github\.event\.inputs\.authorized_changes\s*\}\}/
      );
      for (const line of applyRunLines()) {
        expect(line).not.toMatch(/\$\{\{/);
      }
    });
  });

  describe('the workflow_dispatch RECOVERY path', () => {
    it('takes no shortcut — it enters the same single apply job', () => {
      // There is exactly ONE job that runs terraform, so there is no second copy
      // of the plan -> pre-gate -> destroy-breaker -> apply -> post-gate ->
      // drift sequence that could drift out of step with the first.
      const terraformJobs = Object.entries(JOBS)
        .filter(([, j]) => (j.steps ?? []).some(s => /terraform /.test(String(s.run ?? ''))))
        .map(([n]) => n);
      expect(terraformJobs).toEqual(['apply']);
      expect(jobIf(APPLY)).toMatch(/github\.event_name == 'workflow_dispatch'/);
    });

    it('is branch-restricted to main', () => {
      // workflow_dispatch can otherwise be fired from ANY branch that carries the
      // file, which would apply an unmerged tree.
      expect(jobIf(JOBS['recovery_approval'] ?? {})).toMatch(/github\.ref == 'refs\/heads\/main'/);
      expect(jobIf(APPLY)).toMatch(/github\.ref == 'refs\/heads\/main'/);
    });

    it('carries a manual approval gate that the automatic path does not', () => {
      const gate = JOBS['recovery_approval'] ?? {};
      // The approval is carried by its OWN environment, because GitHub
      // deployment protection rules are per-ENVIRONMENT, not per-trigger: a
      // required reviewer on `development-infra-apply` would gate the AUTOMATIC
      // apply too, which is precisely what MG-23 rules out.
      expect(typeof gate.environment).toBe('string');
      expect(gate.environment).not.toBe(APPLY.environment);
      expect(jobIf(gate)).toMatch(/github\.event_name == 'workflow_dispatch'/);

      // The apply requires that approval ONLY on the dispatch path...
      const applyIf = jobIf(APPLY);
      expect(applyIf).toMatch(/needs\.recovery_approval\.result == 'success'/);
      // ...and the workflow_run clause must NOT mention it, or the automatic
      // path would inherit an approval it is not supposed to have.
      const workflowRunClause = applyIf.slice(
        applyIf.indexOf("github.event_name == 'workflow_run'"),
        applyIf.indexOf("github.event_name == 'workflow_dispatch'")
      );
      expect(workflowRunClause).not.toMatch(/recovery_approval/);

      // Job id uses an underscore: `needs.recovery-approval` parses as a
      // SUBTRACTION in a GitHub expression and would silently evaluate to a
      // number, not the job result.
      expect(Object.keys(JOBS)).toContain('recovery_approval');
      expect(Object.keys(JOBS)).not.toContain('recovery-approval');
      expect(APPLY.needs).toEqual(['recovery_approval']);
    });

    it('sources destroy authorization ONLY from the dispatch input, never a sticky variable', () => {
      // A repository/environment variable would stay set after the merge it was
      // written for, and would then wave through a later plan nobody reviewed.
      const env = (APPLY.env ?? {}) as Record<string, unknown>;
      const override = String(env['TF_DESTROY_GUARD_AUTHORIZED_CHANGES'] ?? '');
      expect(override).toMatch(/github\.event\.inputs\.authorized_changes/);
      expect(override).not.toMatch(/\bvars\./);
      expect(override).not.toMatch(/\|\|/);
      // The retired count variable must not be wired anywhere in the apply job.
      expect(Object.keys(env)).not.toContain('TF_DESTROY_GUARD_EXPECTED_DESTROYS');
    });
  });

  describe('the comments that carry the threat model', () => {
    it("records F18's closed escalation paths as invalidating preconditions", () => {
      // The reasoning that makes an unattended apply with RBAC-write rights
      // acceptable rests on all three of these staying closed. A future change
      // that opens one must not be able to claim nobody wrote it down.
      expect(COMMENT_PROSE).toMatch(/NO Microsoft Graph permissions/i);
      expect(COMMENT_PROSE).toMatch(/NO subscription-scoped role assignments/i);
      expect(COMMENT_PROSE).toMatch(/meatgeek-v2-tfstate-rg/);
      expect(COMMENT_PROSE).toMatch(/INVALIDATES THIS THREAT MODEL/i);
    });

    it('does NOT claim the apply identity is the only one with dev-state access', () => {
      // bootstrap.sh also grants the dev APP-DEPLOY identity Storage Blob Data
      // READER on the same tfstate-dev container, so an exclusivity claim here
      // is simply false — and a false invariant in a threat-model comment is
      // worse than none, because the next reader reasons from it. The accurate
      // statement is narrower: this is the only identity that can WRITE state,
      // and no PR-REACHABLE identity holds any role on it.
      expect(COMMENT_PROSE).not.toMatch(/ONLY IDENTITY IN THE SYSTEM WITH ACCESS TO DEV STATE/i);
      expect(COMMENT_PROSE).toMatch(/Storage Blob Data READER/i);
      expect(COMMENT_PROSE).toMatch(/NO PR-REACHABLE IDENTITY HOLDS ANY ROLE ON tfstate-dev/i);
      // ...and it must say whose ticket that residual belongs to, rather than
      // leaving it looking like an oversight.
      expect(COMMENT_PROSE).toMatch(/MG-36/);
    });

    it('says a benign perpetual diff is fixed at the resource, never masked here', () => {
      // The drift plan runs AFTER the apply has committed, so exit 2 is a
      // report rather than a rollback. That is correct — but it means a
      // resource the provider re-plans on every run would redden every merge,
      // and the tempting "fix" is to tolerate exit 2, which silently retires
      // the convergence proof for every future run.
      expect(COMMENT_PROSE).toMatch(/PERPETUAL/i);
      expect(COMMENT_PROSE).toMatch(/FIX IT AT THE RESOURCE/i);
    });

    it('states what the final drift plan can and cannot prove', () => {
      expect(COMMENT_PROSE).toMatch(/control-plane/i);
      expect(COMMENT_PROSE).toMatch(/sqlRoleAssignments/);
      expect(COMMENT_PROSE).toMatch(/out-of-band/i);
      expect(COMMENT_PROSE).toMatch(/Activity Log alerts/i);
    });

    it('states the workflow_run paths-filter decision explicitly', () => {
      expect(COMMENT_PROSE).toMatch(/supports NO `paths:` filter/i);
      expect(COMMENT_PROSE).toMatch(/DECISION, not an oversight/i);
    });

    it('states the concurrency queue-depth-1 residual honestly', () => {
      // Convergence holds; per-commit auditability does not. Saying so in the
      // file is the difference between an accepted residual and a latent lie.
      //
      // The convergence half must stay QUALIFIED. This assertion used to require
      // the bare phrase "CONVERGENCE still holds", which pinned an over-claim:
      // the surviving run only ever fires off a CI run that concluded `success`,
      // so a RED CI on the newest commit leaves the queue-dropped SHAs
      // unreconciled with nothing red anywhere. Requiring the qualifier and the
      // MG-38 cross-reference means re-introducing an unconditional "convergence
      // holds" fails here instead of shipping as a comment an operator trusts.
      expect(COMMENT_PROSE).toMatch(/CONVERGENCE holds WHEN THE SURVIVING RUN EXECUTES/i);
      expect(COMMENT_PROSE).not.toMatch(/CONVERGENCE still holds/i);
      expect(COMMENT_PROSE).toMatch(/MG-38/);
      expect(COMMENT_PROSE).toMatch(/AUDITABILITY DOES NOT/i);
    });

    it('points at the operator-gated activation procedure', () => {
      expect(COMMENT_PROSE).toMatch(/docs\/infrastructure\/mg23-live-acceptance\.md/);
    });

    it('uses the MG-23 / MG-24 terms precisely', () => {
      expect(COMMENT_PROSE).toMatch(/MG-24 = Terraform reconciliation, OPERATOR-run/);
      expect(COMMENT_PROSE).toMatch(/MG-23 = automated dev GitOps reconciliation, CI-run/);
    });
  });
});
