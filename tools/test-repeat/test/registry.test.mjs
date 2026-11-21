// The registry lists every non-live suite in the repository, and stays that
// way: a new jest config or fixture harness without an entry fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suites } from '../suites.mjs';
import { KNOWN_NEEDS } from '../lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const commandText = s => s.command.join(' ');

function findFiles(dir, pred, out = []) {
  for (const e of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', '.terraform', '.nx', 'dist', '.git'].includes(e.name)) continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) findFiles(rel, pred, out);
    else if (pred(e.name, rel)) out.push(rel);
  }
  return out;
}

test('ids are unique and entries are well formed', () => {
  const ids = suites.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of suites) {
    assert.match(s.id, /^[a-z0-9-]+$/, s.id);
    assert.ok(Array.isArray(s.command) && s.command.length > 0, s.id);
    assert.ok(Array.isArray(s.paths) && s.paths.length > 0, `${s.id} has affected paths`);
    for (const n of s.needs) assert.ok(KNOWN_NEEDS.includes(n), `${s.id}: unknown need ${n}`);
    assert.ok(existsSync(path.join(REPO_ROOT, s.cwd ?? '.')), `${s.id}: cwd exists`);
    assert.ok(s.timeoutSec > 0, `${s.id} has a hang guard`);
    if (s.needs.includes('go'))
      assert.ok(existsSync(path.join(REPO_ROOT, s.goModFile)), `${s.id}: goModFile`);
  }
});

test('every jest config except the live acceptance one has a suite', () => {
  const configs = [
    ...findFiles('apps', n => /^jest(\..+)?\.config\.ts$/.test(n)),
    ...findFiles('libs', n => /^jest(\..+)?\.config\.ts$/.test(n)),
  ].filter(f => f !== 'apps/api/acceptance/jest.config.ts');
  assert.ok(configs.length >= 8, `found ${configs.length} jest configs`);
  for (const c of configs)
    assert.ok(
      suites.some(s => s.command.includes(c)),
      `no suite runs ${c}`
    );
});

test('every fixture harness under apps/infrastructure/scripts/fixtures has a suite', () => {
  const runners = readdirSync(path.join(REPO_ROOT, 'apps/infrastructure/scripts/fixtures')).filter(
    f => /^run-.*\.sh$/.test(f)
  );
  assert.ok(runners.length >= 7);
  for (const f of runners) {
    assert.ok(
      suites.some(s => commandText(s) === `bash apps/infrastructure/scripts/fixtures/${f}`),
      `no suite runs ${f}`
    );
  }
});

test('the Go, Node, shell, Terraform and browser suites the issue names are all present', () => {
  const ids = new Set(suites.map(s => s.id));
  for (const id of [
    'go-data-pusher',
    'go-device-controller',
    'api',
    'api-emulator',
    'web',
    'web-e2e',
    'api-interfaces',
    'api-specs',
    'data-models',
    'utils',
    'iot-fixture',
    'iot-fixture-sdk',
    'cosmos-export',
    'cosmos-export-sdk',
    'bootstrap',
    'bootstrap-oidc-subject',
    'terraform-tests',
    'playwright-web-e2e',
  ]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  const go = suites.filter(s => s.needs.includes('go'));
  for (const s of go) {
    assert.ok(s.command.includes('-race'), `${s.id} runs with the race detector`);
    assert.ok(s.command.includes('-count=1'), `${s.id} bypasses the go test cache`);
  }
});

test('no suite reaches the live cloud or goes through Nx', () => {
  for (const s of suites) {
    const text = commandText(s);
    assert.doesNotMatch(text, /acceptance|playwright\.live|e2e-live/, s.id);
    assert.doesNotMatch(
      text,
      /\bnx\b/,
      `${s.id}: the repeated command must not be an Nx target (cache)`
    );
  }
});
