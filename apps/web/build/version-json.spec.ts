import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Rollup } from 'vite';
import { buildSha, versionJson, type BuildEnv } from './version-json';

/** Run the plugin's generateBundle hook and return what it emitted. */
function emitted(env: BuildEnv): Rollup.EmittedAsset[] {
  const plugin = versionJson(env);
  const hook = plugin.generateBundle;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  if (!handler) throw new Error('versionJson has no generateBundle hook');
  const files: Rollup.EmittedAsset[] = [];
  const context = {
    emitFile: (file: Rollup.EmittedAsset) => {
      files.push(file);
      return 'ref';
    },
  };
  // Only emitFile is used; the rest of the rollup context is not needed.
  (handler as (...args: unknown[]) => void).call(context, {}, {}, false);
  return files;
}

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

describe('versionJson', () => {
  it('runs only for builds', () => {
    expect(versionJson({}).apply).toBe('build');
  });

  it('writes version.json with VERCEL_GIT_COMMIT_SHA', () => {
    expect(emitted({ VERCEL_GIT_COMMIT_SHA: SHA, GITHUB_SHA: OTHER })).toEqual([
      { type: 'asset', fileName: 'version.json', source: `{"sha":"${SHA}"}\n` },
    ]);
  });

  it('falls back to GITHUB_SHA', () => {
    expect(emitted({ GITHUB_SHA: OTHER })[0].source).toBe(`{"sha":"${OTHER}"}\n`);
  });

  it('writes local when no value is set', () => {
    expect(emitted({})).toEqual([
      { type: 'asset', fileName: 'version.json', source: '{"sha":"local"}\n' },
    ]);
  });
});

describe('buildSha', () => {
  it('treats an empty or blank variable as unset', () => {
    expect(buildSha({ VERCEL_GIT_COMMIT_SHA: '', GITHUB_SHA: OTHER })).toBe(OTHER);
    expect(buildSha({ VERCEL_GIT_COMMIT_SHA: '  ', GITHUB_SHA: ' ' })).toBe('local');
  });

  it('trims the value', () => {
    expect(buildSha({ VERCEL_GIT_COMMIT_SHA: ` ${SHA}\n` })).toBe(SHA);
  });
});

describe('vercel.json', () => {
  it('serves version.json with Cache-Control: no-store', () => {
    const vercel = JSON.parse(readFileSync(resolve(__dirname, '../../../vercel.json'), 'utf8')) as {
      headers?: { source: string; headers: { key: string; value: string }[] }[];
    };
    const rule = vercel.headers?.find(entry => entry.source === '/version.json');
    expect(rule?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' });
  });
});
