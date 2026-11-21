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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [mode, arg] = process.argv.slice(2);
const counter = path.join(os.tmpdir(), 'fixture-suite-count');
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(n));
console.log(`fixture invocation ${n} in ${os.tmpdir()}`);
for (let i = 1; i <= 200; i++) console.log(`fixture filler line ${i}`);

// Exit by process.exitCode, never process.exit(): stdout is a pipe to the
// harness, and process.exit() can drop output still queued for it.
if (mode === 'pass') {
  process.exitCode = 0;
} else if (mode === 'fail-on') {
  if (n === Number(arg)) {
    // On stdout, so it is the last line of the tail whatever the interleaving
    // with stderr.
    console.log(`boom on invocation ${n}`);
    process.exitCode = 1;
  }
} else if (mode === 'barrier') {
  const dir = process.env.BARRIER_DIR;
  const want = Number(process.env.BARRIER_COUNT);
  writeFileSync(
    path.join(dir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, tmpdir: os.tmpdir() })
  );
  // Done once every copy has started: only possible if they run at once.
  const ready = () => readdirSync(dir).filter(f => f.endsWith('.json')).length >= want;
  // Re-check the directory until the condition holds. (fs.watch was tried
  // first: on macOS it can drop the event for the last marker, and the copy
  // then waits forever.)
  if (!ready()) {
    const timer = setInterval(() => {
      if (ready()) clearInterval(timer);
    }, 10);
  }
} else {
  console.error(`unknown mode ${mode}`);
  process.exitCode = 2;
}
