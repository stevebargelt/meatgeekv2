import type { Plugin } from 'vite';

/** Written at the root of the build output, so served as `/version.json`. */
export const VERSION_FILE = 'version.json';

/** Where the commit comes from, first set wins: Vercel's build, then GitHub Actions'. */
export const SHA_VARIABLES = ['VERCEL_GIT_COMMIT_SHA', 'GITHUB_SHA'] as const;

export type BuildEnv = Readonly<Record<string, string | undefined>>;

/** The commit this build is of, or `local` when neither variable is set. */
export function buildSha(env: BuildEnv): string {
  for (const name of SHA_VARIABLES) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return 'local';
}

/**
 * Writes `version.json` = `{"sha": "<commit>"}` into the build output (HAR-99).
 * Vercel tells GitHub about a deployment only through a commit status, so the
 * live browser proof reads this file to learn which commit production serves.
 * vercel.json serves it with `Cache-Control: no-store`.
 */
export function versionJson(env: BuildEnv): Plugin {
  return {
    name: 'meatgeek-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: VERSION_FILE,
        source: `${JSON.stringify({ sha: buildSha(env) })}\n`,
      });
    },
  };
}
