// HAR-119 — static scans for registry.test.mjs: which environment variables a
// suite's code reads, and which ones test-repeat.yml puts into the environment
// of the step that runs the harness. A helper, not a test file.
//
// What a scan can see, and so what the registry test can enforce:
//
//   JS/TS   process.env.NAME and process.env['NAME'] with no `??` or `||`
//           fallback after them.
//   Go      os.Getenv("NAME") and os.LookupEnv("NAME").
//   shell   $NAME, ${NAME} and ${NAME:?…} (no default) of a NAME that no
//           scanned shell file assigns, exports, reads or loops over.
//
// A read is the suite's own business, not the caller's, when the suite's code
// also writes the name: process.env.NAME = / delete process.env.NAME in JS,
// t.Setenv("NAME", …), os.Setenv("NAME", …) or a "NAME=…" literal in Go.
//
// What it cannot see: names computed at run time (process.env[key],
// os.Getenv(EnvConst)), variables a tool reads itself (NODE_EXTRA_CA_CERTS,
// TF_*, GOFLAGS), and anything in a language not listed. README.md says so.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.terraform', '.nx', 'dist', '.git']);
const NAME = '([A-Z][A-Z0-9_]*)';

export function kindOf(file) {
  if (/\.(m?js|cjs|tsx?)$/.test(file)) return 'js';
  if (file.endsWith('.go')) return 'go';
  if (file.endsWith('.sh')) return 'sh';
  return null;
}

/** Repo-relative files of a kind we scan, under `rel` (a file or directory). */
export function sourceFiles(repoRoot, rel, out = []) {
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) return out;
  if (!statSync(abs).isDirectory()) {
    if (kindOf(rel)) out.push(rel);
    return out;
  }
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    sourceFiles(repoRoot, path.posix.join(rel, e.name), out);
  }
  return out;
}

/**
 * The directories and files whose code a suite runs: every `paths` glob that is
 * a plain directory followed by `/**`, plus any .mjs/.js/.sh file named in its
 * command or prepare steps.
 */
export function suiteSourceRoots(repoRoot, suite) {
  const roots = new Set();
  for (const glob of suite.paths) {
    const dir = glob.replace(/\/\*\*$/, '');
    if (dir === glob || /[*?]/.test(dir)) continue;
    roots.add(dir);
  }
  const cwd = suite.cwd ?? '.';
  for (const arg of [...suite.command, ...(suite.prepare ?? []).flat()]) {
    if (!/\.(m?js|sh)$/.test(arg)) continue;
    for (const rel of [arg, path.posix.join(cwd, arg)])
      if (existsSync(path.join(repoRoot, rel))) roots.add(path.posix.normalize(rel));
  }
  return [...roots];
}

const withoutComments = (text, kind) =>
  text
    .split('\n')
    .filter(l => !(kind === 'sh' ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/).test(l))
    .join('\n');

const READS = {
  js: [
    new RegExp(`process\\.env\\.${NAME}\\b(?!\\s*(?:\\?\\?|\\|\\||=[^=]))`, 'g'),
    new RegExp(`process\\.env\\[['"\`]${NAME}['"\`]\\](?!\\s*(?:\\?\\?|\\|\\||=[^=]))`, 'g'),
  ],
  go: [new RegExp(`os\\.(?:Getenv|LookupEnv)\\("${NAME}"\\)`, 'g')],
  sh: [new RegExp(`\\$(?:\\{${NAME}(?:\\}|:?\\?)|${NAME}\\b)`, 'g')],
};

const WRITES = {
  js: [
    new RegExp(`process\\.env\\.${NAME}\\s*=[^=]`, 'g'),
    new RegExp(`process\\.env\\[['"\`]${NAME}['"\`]\\]\\s*=[^=]`, 'g'),
    new RegExp(`delete process\\.env(?:\\.|\\[['"\`])${NAME}`, 'g'),
  ],
  go: [new RegExp(`(?:t|os)\\.Setenv\\("${NAME}"`, 'g'), new RegExp(`"${NAME}=`, 'g')],
  sh: [
    new RegExp(`(?:^|[\\s;(&|])${NAME}=`, 'gm'),
    new RegExp(`\\bfor ${NAME} in\\b`, 'g'),
    new RegExp(`\\bread\\b[^\\n;|&]*?\\b${NAME}\\b`, 'g'),
    /\b(?:export|local|declare|readonly|unset|typeset)((?: -\w+)*(?: [A-Za-z_][A-Za-z0-9_]*)+)/g,
  ],
};

/** { reads: Map<name, file>, writes: Set<name> } over `files`. */
export function scanEnv(repoRoot, files) {
  const reads = new Map();
  const writes = new Set();
  for (const file of files) {
    const kind = kindOf(file);
    const text = withoutComments(readFileSync(path.join(repoRoot, file), 'utf8'), kind);
    for (const re of READS[kind])
      for (const m of text.matchAll(re)) {
        const name = m[1] ?? m[2];
        if (!reads.has(name)) reads.set(name, file);
      }
    for (const re of WRITES[kind])
      for (const m of text.matchAll(re))
        for (const name of m[1].trim().split(/\s+/)) if (!name.startsWith('-')) writes.add(name);
  }
  return { reads, writes };
}

/**
 * The jobs of a GitHub workflow that run `test-repeat.mjs run`, each with the
 * environment variables the workflow gives that step: workflow-level and
 * job-level `env:`, every step's `env:` in the job (a superset of the run
 * step's own), and every NAME the job writes to $GITHUB_ENV. Line-based, for
 * this repository's workflow shape: two-space indentation, `env:` as a block
 * mapping.
 */
export function workflowRunEnv(text) {
  const lines = text.split('\n');
  const workflowEnv = new Set();
  const jobs = [];
  let inJobs = false;
  let job = null;
  let envIndent = -1;
  let envTarget = null;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (body === '' || body.startsWith('#')) continue;
    if (envIndent >= 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(body);
      if (indent > envIndent && m) {
        envTarget.add(m[1]);
        continue;
      }
      if (indent <= envIndent) envIndent = -1;
    }
    if (indent === 0) {
      inJobs = body === 'jobs:';
      job = null;
      if (body === 'env:') {
        envIndent = 0;
        envTarget = workflowEnv;
      }
      continue;
    }
    if (inJobs && indent === 2 && /^[A-Za-z0-9_-]+:$/.test(body)) {
      job = { name: body.slice(0, -1), env: new Set(), text: '' };
      jobs.push(job);
      continue;
    }
    if (!job) continue;
    job.text += `${line}\n`;
    if (/^(?:- )?env:$/.test(body)) {
      envIndent = indent + (body.startsWith('- ') ? 2 : 0);
      envTarget = job.env;
    }
    if (/GITHUB_ENV/.test(body))
      for (const m of body.matchAll(/["'\s]([A-Z][A-Z0-9_]*)=/g)) job.env.add(m[1]);
  }
  return {
    workflowEnv,
    runJobs: jobs
      .filter(j => /tools\/test-repeat\/test-repeat\.mjs run\b/.test(j.text))
      .map(j => ({ ...j, env: new Set([...workflowEnv, ...j.env]) })),
  };
}
