// A stand-in test suite for the harness's own tests.
//
//   node fixture-suite.mjs pass            exit 0
//   node fixture-suite.mjs fail-on <k>     exit 1 on this copy's k-th run
//   node fixture-suite.mjs barrier         write a marker to $BARRIER_DIR, then
//                                          wait until $BARRIER_COUNT markers
//                                          exist; record pid and tmpdir
//
// Runs are counted in os.tmpdir(), which the harness gives each parallel copy
// to itself, so the count is per copy.
import { existsSync, readdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [mode, arg] = process.argv.slice(2);
const counter = path.join(os.tmpdir(), 'fixture-suite-count');
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(n));
console.log(`fixture invocation ${n} in ${os.tmpdir()}`);
for (let i = 1; i <= 200; i++) console.log(`fixture filler line ${i}`);

if (mode === 'pass') process.exit(0);

if (mode === 'fail-on') {
  if (n === Number(arg)) {
    console.error(`boom on invocation ${n}`);
    process.exit(1);
  }
  process.exit(0);
}

if (mode === 'barrier') {
  const dir = process.env.BARRIER_DIR;
  const want = Number(process.env.BARRIER_COUNT);
  writeFileSync(
    path.join(dir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, tmpdir: os.tmpdir() })
  );
  // Done once every copy has started: only possible if they run at once.
  const ready = () => readdirSync(dir).filter(f => f.endsWith('.json')).length >= want;
  if (ready()) process.exit(0);
  const watcher = watch(dir, () => {
    if (ready()) {
      watcher.close();
      process.exit(0);
    }
  });
  // A marker written between the first check and the watch starting.
  if (ready()) process.exit(0);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
