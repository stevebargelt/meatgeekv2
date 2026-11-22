#!/usr/bin/env node
// HAR-127 (goal HAR-106) — the no-real-time guard.
//
//   node tools/no-real-time/check.mjs [--root DIR] [--exceptions FILE]
//                                     [--walk] [--untracked] [--verbose]
//
// Scans every test file and test-only helper git tracks (not only a diff) and
// fails on a real sleep or a real-time wait that no exception covers, and on an
// exception or out-of-scope path that covers nothing (stale). README.md has
// the rules, the exception format and the blind spots.
//
// Exit codes: 0 clean, 1 a violation or a stale entry, 2 a usage or config error.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, formatHit, gitFiles, LANGUAGES, parseExceptions, walkFiles } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function usage(message) {
  if (message) console.error(`no-real-time: ${message}`);
  console.error(
    'usage: node tools/no-real-time/check.mjs [--root DIR] [--exceptions FILE] [--walk] [--untracked] [--verbose]'
  );
  process.exit(2);
}

const opts = {
  root: path.resolve(HERE, '../..'),
  exceptions: path.join(HERE, 'exceptions.json'),
  walk: false,
  untracked: false,
  verbose: false,
};
const argv = process.argv.slice(2);
for (let k = 0; k < argv.length; k++) {
  const a = argv[k];
  if (a === '--root' || a === '--exceptions') {
    const v = argv[++k];
    if (!v) usage(`${a} needs a value`);
    opts[a.slice(2)] = path.resolve(v);
  } else if (a === '--walk') opts.walk = true;
  else if (a === '--untracked') opts.untracked = true;
  else if (a === '--verbose') opts.verbose = true;
  else if (a === '--help' || a === '-h') usage();
  else usage(`unknown argument ${a}`);
}

let json;
try {
  json = readFileSync(opts.exceptions, 'utf8');
} catch (e) {
  usage(`cannot read ${opts.exceptions}: ${e.message}`);
}
const { config, errors } = parseExceptions(json);
if (errors.length) {
  for (const e of errors) console.error(`no-real-time: ${path.basename(opts.exceptions)}: ${e}`);
  process.exit(2);
}

let files;
try {
  files = opts.walk ? walkFiles(opts.root) : gitFiles(opts.root, { untracked: opts.untracked });
} catch (e) {
  usage(`cannot list files under ${opts.root}: ${e.message}`);
}

const r = check({ root: opts.root, files, config });

for (const h of r.violations) console.log(formatHit(h));
for (const e of r.stale)
  console.log(
    `${e.path}: stale exception: ${e.rule} ${e.line !== undefined ? `line "${e.line}"` : `pattern /${e.pattern}/`} matches nothing — delete the entry`
  );
for (const e of r.staleScope)
  console.log(`${e.path}: stale out-of-scope path: it matches no file — delete the entry`);

if (opts.verbose) {
  for (const { hit, reason } of r.excused) console.log(`excepted ${formatHit(hit)} (${reason})`);
  for (const { file, fakeClock } of r.fakeClockFiles)
    console.log(`fake clock (${fakeClock}): ${file}`);
  for (const f of r.skipped) console.log(`out of scope: ${f}`);
}

const total = LANGUAGES.reduce((n, l) => n + r.scanned[l], 0);
const perLang = LANGUAGES.map(l => `${l} ${r.scanned[l]}`).join(', ');
const failed = r.violations.length + r.stale.length + r.staleScope.length;
console.log(
  `no-real-time: scanned ${total} files (${perLang}); ` +
    `${r.violations.length} violation${r.violations.length === 1 ? '' : 's'}, ` +
    `${r.excused.length} excepted hit${r.excused.length === 1 ? '' : 's'} (${config.exceptions.length} exception${config.exceptions.length === 1 ? '' : 's'}), ` +
    `${r.stale.length + r.staleScope.length} stale; ` +
    `${r.fakeClockFiles.length} on a fake clock; ` +
    `${r.skipped.length} out of scope by path`
);
process.exit(failed ? 1 : 0);
