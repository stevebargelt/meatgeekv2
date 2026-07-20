import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The validator is a plain CJS script so it stays host-runnable in CI without a
// TypeScript toolchain; the suite exercises the exported function directly.
const { verifyFuncPackage } = require('../tools/verify-func-package');

const VALID_HOST = {
  version: '2.0',
  extensionBundle: {
    id: 'Microsoft.Azure.Functions.ExtensionBundle',
    version: '[4.*, 5.0.0)',
  },
};
const VALID_PKG = {
  name: '@meatgeekv2/api',
  main: 'main.js',
  dependencies: { '@azure/functions': '^4.5.1' },
};

function makePackage(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'func-pkg-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

describe('verifyFuncPackage', () => {
  it('accepts a well-formed v4 package', () => {
    const dir = makePackage({
      'host.json': JSON.stringify(VALID_HOST),
      'package.json': JSON.stringify(VALID_PKG),
      'main.js': '// entry',
    });
    expect(verifyFuncPackage(dir)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a package missing host.json', () => {
    const dir = makePackage({
      'package.json': JSON.stringify(VALID_PKG),
      'main.js': '// entry',
    });
    const res = verifyFuncPackage(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toMatch(/host\.json missing/);
  });

  it('rejects a package.json main that does not resolve under the root', () => {
    const dir = makePackage({
      'host.json': JSON.stringify(VALID_HOST),
      'package.json': JSON.stringify({ ...VALID_PKG, main: 'dist/apps/api/main.js' }),
      'main.js': '// entry',
    });
    const res = verifyFuncPackage(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toMatch(/does not resolve to a file/);
  });

  it('rejects a lingering httpWorker block (invalid for the v4 model)', () => {
    const dir = makePackage({
      'host.json': JSON.stringify({ ...VALID_HOST, httpWorker: { description: {} } }),
      'package.json': JSON.stringify(VALID_PKG),
      'main.js': '// entry',
    });
    const res = verifyFuncPackage(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toMatch(/httpWorker/);
  });

  it('rejects unparseable host.json', () => {
    const dir = makePackage({
      'host.json': '{ not json',
      'package.json': JSON.stringify(VALID_PKG),
      'main.js': '// entry',
    });
    const res = verifyFuncPackage(dir);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toMatch(/not parseable/);
  });

  it('runs as a CLI and exits non-zero on an invalid package', () => {
    const dir = makePackage({ 'main.js': '// entry' });
    const script = path.join(__dirname, '..', 'tools', 'verify-func-package.js');
    expect(() => execFileSync('node', [script, dir])).toThrow();
  });
});
