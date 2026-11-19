#!/usr/bin/env node
// Self-test for check-honesty.mjs: runs the checker on every fixture under scripts/fixtures/
// and asserts its exit code, how many violations it reports, and what it names.
//
// Fixtures are stored as `*.c4.fixture` so likec4 never loads them into the real model
// (likec4 scans every `.c4` file under its workspace). Each fixture directory is copied into
// a temporary workspace together with the shared fixtures/spec.c4.fixture, renamed to `.c4`,
// and checked there. Each directory holds an expect.json: { exit, count, includes[] }.
//
// Exits 0 only when every violating fixture is rejected as expected and the clean one passes.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(SCRIPTS, 'fixtures');
const CHECKER = join(SCRIPTS, 'check-honesty.mjs');
const SUFFIX = '.c4.fixture';

const cases = readdirSync(FIXTURES, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

let failed = 0;
let rejected = 0;
for (const name of cases) {
  const dir = join(FIXTURES, name);
  const expect = JSON.parse(readFileSync(join(dir, 'expect.json'), 'utf8'));
  const workspace = mkdtempSync(join(tmpdir(), `honesty-${name}-`));
  try {
    copyFileSync(join(FIXTURES, `spec${SUFFIX}`), join(workspace, 'spec.c4'));
    for (const file of readdirSync(dir).filter(f => f.endsWith(SUFFIX))) {
      copyFileSync(join(dir, file), join(workspace, file.slice(0, -'.fixture'.length)));
    }
    const run = spawnSync(process.execPath, [CHECKER, workspace], { encoding: 'utf8' });
    const output = `${run.stdout}${run.stderr}`;
    const reported = output.split('\n').filter(l => l.startsWith('  - rule ')).length;
    const problems = [];
    if (run.status !== expect.exit) problems.push(`exit ${run.status}, expected ${expect.exit}`);
    if (reported !== expect.count)
      problems.push(`${reported} violation(s), expected ${expect.count}`);
    for (const text of expect.includes) {
      if (!output.includes(text)) problems.push(`output does not name: ${text}`);
    }
    if (problems.length > 0) {
      failed++;
      console.error(`FAIL ${name}: ${problems.join('; ')}\n${output.replace(/^/gm, '    ')}`);
    } else {
      if (expect.exit === 1) rejected++;
      console.log(`ok   ${name} (exit ${run.status}, ${reported} violation(s))`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`selftest: ${failed} of ${cases.length} fixture(s) failed`);
  process.exitCode = 1;
} else {
  console.log(
    `selftest: OK, the checker rejected all ${rejected} violating fixture(s) and passed the clean one`
  );
}
