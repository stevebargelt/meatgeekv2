/**
 * MG-59 / MG-82 — repo-wide FAIL-CLOSED guard: no HTTP/handler source under
 * apps/api/src/functions may return inline fixture / mock data.
 *
 * WHY THIS EXISTS
 * The V2 API once shipped handlers that answered 200 from hand-rolled inline
 * mocks (a fabricated device list, a canned temperature reading, a `user-1`
 * tenant stamped onto every cook). Every route is now backed by real Cosmos
 * persistence: cooks (MG-59), devices (MG-80), users (MG-81), temperatures
 * (MG-79) and recipes (MG-82). This guard keeps it that way. It scans every
 * handler source mechanically and FAILS the build if any of them carries a
 * fixture marker, so an edit that quietly re-mocks a route, or a brand-new
 * handler that ships with canned data, cannot pass CI. There is no allowlist
 * and no exemption: every `.ts` file under apps/api/src/functions (other than
 * specs and declarations) is checked. The check does not rely on a human
 * noticing a mock in review.
 *
 * HOW IT DETECTS FIXTURES
 * Handler comments legitimately DISCUSS the mocks they removed (e.g. "does NOT
 * hardcode `userId: 'user-1'`"). So the scanner strips comments FIRST and then
 * matches a small, documented set of markers against the executable code only
 * (see FIXTURE_MARKERS). A marker matching real code — a `user-1` string
 * literal, a `mock*`-named binding, an inline typed-array-of-objects literal,
 * hardcoded decimal telemetry — is treated as an inline fixture.
 */
import * as fs from 'fs';
import * as path from 'path';

/** apps/api/src/functions — this file lives at its root. */
const FUNCTIONS_ROOT = __dirname;

/** This guard is itself a `.spec.ts` and is excluded by the spec filter, but name
 *  it explicitly for clarity. */
const SELF = 'no-inline-fixtures.spec.ts';

/**
 * Fixture markers, matched against COMMENT-STRIPPED handler code only. Each is a
 * mechanical signal of hand-rolled inline data rather than a real dependency call.
 * Kept deliberately small and documented so the guard is auditable.
 */
interface FixtureMarker {
  readonly id: string;
  readonly why: string;
  readonly pattern: RegExp;
}

const FIXTURE_MARKERS: readonly FixtureMarker[] = [
  {
    id: 'fabricated-tenant',
    why: "a hardcoded 'user-1' (or other fake tenant) partition/owner value",
    pattern: /['"`]user-1['"`]/,
  },
  {
    id: 'mock-named-binding',
    why: 'a binding literally named mock* (e.g. `const mockCooks = ...`)',
    pattern: /\b(?:const|let|var)\s+\w*[Mm]ock\w*\b/,
  },
  {
    id: 'return-mock',
    why: 'a value named mock/fixture/placeholder returned directly as the body',
    pattern: /\breturn\s+(?:mock|fixture|placeholder|dummy)/i,
  },
  {
    id: 'inline-typed-array-literal',
    why: 'an inline typed array seeded with object literals (e.g. `const devices: Device[] = [{ ... }]`)',
    pattern: /\b(?:const|let|var)\s+\w+\s*:\s*\w+\[\]\s*=\s*\[\s*\{/,
  },
  {
    id: 'hardcoded-decimal-telemetry',
    why: 'hardcoded decimal field values (canned probe/temperature/correction data)',
    pattern: /[:=]\s*-?\d+\.\d+/,
  },
];

/**
 * Strip `//` line and block comments while preserving string/template literals,
 * so a docblock that merely NAMES a mock does not trip a marker but a real
 * `'user-1'` string literal in code does. Newlines inside comments are preserved
 * to keep the code shape intact. Handler files contain no `//` sequences inside
 * string literals (verified for this tree), but strings are skipped anyway so the
 * stripper stays correct if one is added later.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  type State = 'code' | 'line' | 'block' | 'squote' | 'dquote' | 'template';
  let state: State = 'code';

  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';

    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'") {
        state = 'squote';
      } else if (c === '"') {
        state = 'dquote';
      } else if (c === '`') {
        state = 'template';
      }
      out += c;
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') {
        out += c;
      }
      i += 1;
      continue;
    }

    // Inside a string / template literal: copy through, honour escapes, and
    // return to code at the matching closing quote.
    out += c;
    if (c === '\\') {
      out += c2;
      i += 2;
      continue;
    }
    if (
      (state === 'squote' && c === "'") ||
      (state === 'dquote' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
    }
    i += 1;
  }

  return out;
}

/** All markers a source trips, matched against its comment-stripped code. */
function fixtureMarkersIn(source: string): string[] {
  const code = stripComments(source);
  return FIXTURE_MARKERS.filter(m => m.pattern.test(code)).map(m => m.id);
}

/** Recursively collect handler source files (non-spec, non-declaration `.ts`). */
function handlerSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...handlerSourceFiles(abs));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (entry.name === SELF) continue;
    found.push(abs);
  }
  return found;
}

/** Path relative to apps/api/src/functions, POSIX-normalised for stable compares. */
function relFromFunctions(abs: string): string {
  return path.relative(FUNCTIONS_ROOT, abs).split(path.sep).join('/');
}

describe('MG-59/MG-82: no handler under apps/api/src/functions returns inline fixture data (fail-closed)', () => {
  const allSources = handlerSourceFiles(FUNCTIONS_ROOT).map(abs => ({
    rel: relFromFunctions(abs),
    markers: fixtureMarkersIn(fs.readFileSync(abs, 'utf8')),
  }));

  it("discovers every entity's handlers, so none can slip past the scan", () => {
    const rels = allSources.map(s => s.rel);
    expect(rels).toEqual(
      expect.arrayContaining([
        'cooks/list-cooks.ts',
        'cooks/start-cook.ts',
        'cooks/stop-cook.ts',
        'devices/get-devices.ts',
        'temperatures/get-current.ts',
        'users/get-user-profile.ts',
        'recipes/list-recipes.ts',
        'recipes/create-recipe.ts',
        'recipes/get-recipe.ts',
        'recipes/update-recipe.ts',
        'recipes/delete-recipe.ts',
      ])
    );
  });

  it('every handler is fixture-free, with no exemption', () => {
    const offenders = allSources
      .filter(s => s.markers.length > 0)
      .map(s => `${s.rel} [${s.markers.join(', ')}]`);

    // If this fails, a handler grew an inline fixture: remove it and read from
    // the real repository/adapter instead. There is no allowlist to add it to.
    expect(offenders).toEqual([]);
  });

  describe('fails closed when a fixture is reintroduced', () => {
    // The detector operates on source text, so we prove fail-closed behaviour by
    // feeding it mutated cook-handler sources — no files are written.
    const cleanCook = fs.readFileSync(path.join(FUNCTIONS_ROOT, 'cooks', 'start-cook.ts'), 'utf8');

    it('confirms the pristine cook handler is clean before mutation', () => {
      expect(fixtureMarkersIn(cleanCook)).toEqual([]);
    });

    it("catches a reintroduced 'user-1' tenant in code", () => {
      const remocked = cleanCook.replace(
        'const { userId } = principalResult.principal;',
        "const { userId } = principalResult.principal;\n    const owner = 'user-1'; void owner;"
      );
      expect(remocked).not.toEqual(cleanCook);
      expect(fixtureMarkersIn(remocked)).toContain('fabricated-tenant');
    });

    it('catches a reintroduced inline mock array', () => {
      const remocked =
        cleanCook + '\nconst mockCooks: Cook[] = [{ id: "cook-1" } as Cook];\nvoid mockCooks;\n';
      const markers = fixtureMarkersIn(remocked);
      expect(markers).toEqual(
        expect.arrayContaining(['mock-named-binding', 'inline-typed-array-literal'])
      );
    });

    it('catches reintroduced hardcoded decimal telemetry', () => {
      const remocked = cleanCook + '\nconst grillTemp = 225.5;\nvoid grillTemp;\n';
      expect(fixtureMarkersIn(remocked)).toContain('hardcoded-decimal-telemetry');
    });

    it('a comment mentioning the removed mock does NOT trip the guard', () => {
      // Regression guard for the stripper: prose about `user-1` / `mock` is fine.
      const commentOnly =
        cleanCook +
        "\n// historical note: this route used to hardcode userId: 'user-1' and return a mock array\n";
      expect(fixtureMarkersIn(commentOnly)).toEqual([]);
    });
  });

  describe('fails closed for a new handler that grows a fixture', () => {
    it('flags a hypothetical new handler carrying inline data', () => {
      // Simulates a brand-new handler shipped with canned data: the scanner
      // flags it, so the `every handler is fixture-free` assertion above would
      // fail the build.
      const newHandler = `
        import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
        export async function getWidgetsHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
          const widgets: Widget[] = [{ id: 'w1', reading: 42.0 }];
          return { status: 200, jsonBody: { widgets } };
        }
      `;
      expect(fixtureMarkersIn(newHandler).length).toBeGreaterThan(0);
    });
  });
});
