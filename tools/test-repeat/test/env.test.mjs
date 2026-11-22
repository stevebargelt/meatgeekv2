// HAR-119 — the environment a run gets: the allowlist, passEnv, env and its own
// temp dir, and nothing else from the caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envNameMatches, ENV_ALLOWLIST, suiteEnv } from '../lib.mjs';

const caller = {
  PATH: '/usr/bin',
  HOME: '/home/me',
  LC_ALL: 'C',
  GITHUB_SHA: 'abc',
  RUNNER_TEMP: '/rt',
  GOFLAGS: '-mod=mod',
  npm_config_cache: '/c',
  NX_DAEMON: 'false',
  TMPDIR: '/caller-tmp',
  TF_DESTROY_GUARD_EXPECTED_DESTROYS: 'x',
  AZURE_CLIENT_ID: 'leak',
  NODE_EXTRA_CA_CERTS: '/cert.pem',
  OVERRIDDEN: 'caller',
};

test('a run gets the allowlisted variables, its passEnv, its env and its temp dir, nothing else', () => {
  const env = suiteEnv(
    { passEnv: ['NODE_EXTRA_CA_CERTS'], env: { OVERRIDDEN: 'suite', ADDED: '1' } },
    { parentEnv: caller, platform: 'linux', tmp: '/t/tr1-x' }
  );
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/me',
    LC_ALL: 'C',
    GITHUB_SHA: 'abc',
    RUNNER_TEMP: '/rt',
    GOFLAGS: '-mod=mod',
    npm_config_cache: '/c',
    NX_DAEMON: 'false',
    NODE_EXTRA_CA_CERTS: '/cert.pem',
    OVERRIDDEN: 'suite',
    ADDED: '1',
    TMPDIR: '/t/tr1-x',
    TMP: '/t/tr1-x',
    TEMP: '/t/tr1-x',
  });
});

test('without passEnv a caller variable is dropped, whatever its name looks like', () => {
  const env = suiteEnv({}, { parentEnv: caller, platform: 'linux', tmp: '/t' });
  for (const name of [
    'TF_DESTROY_GUARD_EXPECTED_DESTROYS',
    'AZURE_CLIENT_ID',
    'NODE_EXTRA_CA_CERTS',
  ])
    assert.equal(Object.hasOwn(env, name), false, name);
});

test("a prepare step (no temp dir of its own) keeps the caller's temp dir variables", () => {
  const env = suiteEnv({}, { parentEnv: caller, platform: 'linux' });
  assert.equal(env.TMPDIR, '/caller-tmp');
  assert.equal(Object.hasOwn(env, 'TF_DESTROY_GUARD_EXPECTED_DESTROYS'), false);
});

test('names match exactly or by a trailing-* prefix, case-insensitively only on Windows', () => {
  assert.ok(envNameMatches('PATH', ['PATH'], 'linux'));
  assert.ok(!envNameMatches('Path', ['PATH'], 'linux'));
  assert.ok(envNameMatches('Path', ['PATH'], 'win32'));
  assert.ok(envNameMatches('ProgramFiles(x86)', ['ProgramFiles*'], 'win32'));
  assert.ok(envNameMatches('GOROOT', ['GO*'], 'linux'));
  assert.ok(!envNameMatches('PATHEXT', ['PATH'], 'linux'), 'exact means exact');
  const win = suiteEnv(
    {},
    {
      parentEnv: { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', LEAK: '1' },
      platform: 'win32',
      tmp: 'C:\\t',
    }
  );
  assert.deepEqual(Object.keys(win).sort(), [
    'ComSpec',
    'Path',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]);
});

test('the allowlist is the HAR-119 decision, plus only what toolchains need to start', () => {
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_*',
    'TERM',
    'SHELL',
    'CI',
    'GITHUB_*',
    'RUNNER_*',
    'GO*',
    'NODE_OPTIONS',
    'npm_config_*',
    'NX_*',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramFiles*',
  ])
    assert.ok(ENV_ALLOWLIST.includes(name), name);
  // Nothing that carries a credential, a cloud target or a test switch.
  for (const name of [
    'AZURE_CLIENT_ID',
    'ARM_SUBSCRIPTION_ID',
    'TF_VAR_x',
    'TF_LOG',
    'NODE_EXTRA_CA_CERTS',
    'DEBUG',
    'TZ',
  ])
    assert.ok(!envNameMatches(name, ENV_ALLOWLIST, 'linux'), name);
});
