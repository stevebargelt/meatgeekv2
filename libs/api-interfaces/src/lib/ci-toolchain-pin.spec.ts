/**
 * Regression guard for MG-20 — pin npm to prevent npm 11 / npm 10 lockfile skew.
 *
 * This is a *repo-tooling* invariant, not an api-interfaces behavior test. It
 * lives here because api-interfaces is a leaf shared lib already wired into the
 * CI `lint-and-test` matrix (`project: ['api','web','mobile','api-interfaces']`),
 * so the guard executes on every CI push — not only when run locally.
 *
 * What it protects:
 *   1. Root package.json pins `packageManager` to an npm 10.x version. Dropping
 *      the pin, or bumping the major to 11, is the exact skew this ticket fixes.
 *   2. Every ci.yml job that runs `npm ci` first runs `corepack enable`, so the
 *      pinned npm (not the runner's ambient npm) resolves the lockfile. A new
 *      install job added without corepack enable — or corepack enable reordered
 *      after npm ci — reintroduces the skew silently. This test fails loudly.
 *   3. The corepack download prompt is suppressed in CI, so `corepack enable`
 *      can fetch the pinned npm non-interactively instead of hanging.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../../');

function readRootPackageJson(): Record<string, unknown> {
  const p = path.join(REPO_ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

interface CiStep {
  name?: string;
  run?: string;
  uses?: string;
}
interface CiJob {
  steps?: CiStep[];
}
interface CiWorkflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, CiJob>;
}

function readCiWorkflow(): CiWorkflow {
  const p = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
  return yaml.load(fs.readFileSync(p, 'utf8')) as CiWorkflow;
}

/** Index of the first step whose `run` contains `needle`, else -1. */
function firstRunStepIndex(steps: CiStep[], needle: string): number {
  return steps.findIndex(s => typeof s.run === 'string' && s.run.includes(needle));
}

describe('MG-20: npm toolchain pin', () => {
  describe('root package.json', () => {
    const pkg = readRootPackageJson();

    it('pins packageManager to an npm 10.x version', () => {
      const pm = pkg['packageManager'];
      expect(typeof pm).toBe('string');
      // Must be npm (not yarn/pnpm) and major version 10 — a bump to npm@11
      // is precisely the lockfile skew MG-20 exists to prevent.
      expect(pm).toMatch(/^npm@10\.\d+\.\d+$/);
    });

    it('keeps the engines.npm floor consistent with the pin (>=10)', () => {
      const engines = (pkg['engines'] ?? {}) as Record<string, string>;
      expect(engines['npm']).toBeDefined();
      expect(engines['npm']).toMatch(/>=\s*10/);
    });
  });

  describe('.github/workflows/ci.yml', () => {
    const wf = readCiWorkflow();
    const jobs = wf.jobs ?? {};

    it('suppresses the corepack download prompt so CI enable is non-interactive', () => {
      const env = (wf.env ?? {}) as Record<string, unknown>;
      // Value may be parsed as string '0' or number 0 depending on quoting.
      expect(String(env['COREPACK_ENABLE_DOWNLOAD_PROMPT'])).toBe('0');
    });

    it('runs `corepack enable` before `npm ci` in every install job', () => {
      const installJobs = Object.entries(jobs).filter(
        ([, job]) => firstRunStepIndex(job.steps ?? [], 'npm ci') !== -1
      );

      // Sanity: the change touched setup, lint-and-test, build-typescript,
      // security-scan — if this drops to zero the workflow was gutted.
      expect(installJobs.length).toBeGreaterThanOrEqual(4);

      // Build a per-job verdict so a failure names the offending job(s) in the
      // jest diff rather than just reporting two bare indices.
      const ordering = installJobs.map(([jobName, job]) => {
        const steps = job.steps ?? [];
        const corepackIdx = firstRunStepIndex(steps, 'corepack enable');
        const npmCiIdx = firstRunStepIndex(steps, 'npm ci');
        return {
          job: jobName,
          corepackBeforeNpmCi: corepackIdx >= 0 && corepackIdx < npmCiIdx,
        };
      });

      expect(ordering).toEqual(
        installJobs.map(([jobName]) => ({ job: jobName, corepackBeforeNpmCi: true }))
      );
    });

    it('leaves the deploy jobs free of npm ci (nothing to pin there)', () => {
      for (const jobName of ['deploy-dev', 'deploy-prod']) {
        const job = jobs[jobName];
        expect(job).toBeDefined();
        expect(firstRunStepIndex(job.steps ?? [], 'npm ci')).toBe(-1);
      }
    });
  });
});
