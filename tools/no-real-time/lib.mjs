// HAR-127 (goal HAR-106) — the no-real-time guard's scanner.
//
// A non-live test may wait only by awaiting the event, by a fake clock the
// test advances, or by polling a condition with no deadline of its own. This
// module finds the text in a test file that breaks that rule: a sleep, a real
// timer, a per-wait deadline, a read of the wall clock, a fixed port, a pipe
// into `grep -q` under pipefail. It is a text scan, not a type checker; what it
// cannot see is written down in README.md ("Blind spots").
//
// Node built-ins only.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// --- Scope ------------------------------------------------------------------

/** Test files: every file whose name says it is a test. */
export const TEST_FILES = [
  '**/*_test.go',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.test.ts',
  '**/*.test.mjs',
  '**/*.test.js',
  '**/*.test.sh',
  'apps/infrastructure/scripts/fixtures/run-*-fixtures.sh',
];

/**
 * Test-only helpers: code that exists only for tests. Their whole job is often
 * to provide waits, so one that legitimately touches a real clock is an
 * exception with a reason, not a silent gap.
 */
export const TEST_HELPERS = [
  '**/*.testing.ts',
  'apps/web-e2e/src/fakes/**',
  'apps/web/src/test/**',
  'apps/infrastructure/scripts/*/fake-*.mjs',
  'tools/test-repeat/test/**',
  '**/internal/await/**',
  '**/internal/clock/clocktest/**',
  '**/internal/iothub/iothubtest/**',
];

/** The Playwright tree: its own rules on top of the TS/JS ones. */
export const PLAYWRIGHT = ['apps/web-e2e/src/**'];

const EXT_LANG = {
  '.go': 'go',
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mjs': 'js',
  '.js': 'js',
  '.cjs': 'js',
  '.sh': 'sh',
};

export const LANGUAGES = ['go', 'ts', 'js', 'sh'];

/** go | ts | js | sh, or null for a file the guard has no rules for. */
export function languageOf(file) {
  return EXT_LANG[path.posix.extname(file)] ?? null;
}

/** `**` crosses directories (and `**\/` may match none), `*` and `?` do not. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map();
export function matchesAny(file, globs) {
  return globs.some(g => {
    if (!globCache.has(g)) globCache.set(g, globToRegExp(g));
    return globCache.get(g).test(file);
  });
}

export const inScope = file =>
  languageOf(file) !== null && matchesAny(file, [...TEST_FILES, ...TEST_HELPERS]);

// --- Lexing: blank comments (and, in the masked view, string contents) --------
//
// Every view keeps the text's length and its newlines, so an index in one is
// the same line and column in all of them.
//
//   code    comments blanked, strings kept. Most rules match here, so a timer
//           written into a child process's source string is still seen.
//   masked  comments and the contents of strings, template literals and
//           regular-expression literals blanked. For structure: finding the
//           end of a call and splitting its arguments, and for options (a
//           `timeout:` inside a string is not an option).

function blankInto(chars, from, to) {
  for (let k = from; k < to && k < chars.length; k++) if (chars[k] !== '\n') chars[k] = ' ';
}

const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
]);
const regexAllowedAfter = last =>
  last === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || REGEX_AFTER_WORD.has(last);

/** JS/TS. Quotes end at a newline, which bounds a JSX apostrophe to its line. */
export function lexJs(text) {
  const code = text.split('');
  const masked = text.split('');
  const n = text.length;
  const templates = []; // brace depth at each open `${`
  let depth = 0;
  let inTemplate = false;
  let last = '';
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (inTemplate) {
      if (c === '\\') {
        blankInto(masked, i, i + 2);
        i += 2;
      } else if (c === '`') {
        inTemplate = false;
        last = 'x';
        i++;
      } else if (c === '$' && text[i + 1] === '{') {
        templates.push(depth);
        depth++;
        inTemplate = false;
        last = '{';
        i += 2;
      } else {
        blankInto(masked, i, i + 1);
        i++;
      }
      continue;
    }
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      blankInto(code, i, j);
      blankInto(masked, i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const j = text.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      blankInto(code, i, end);
      blankInto(masked, i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blankInto(masked, i + 1, Math.min(j, n));
      i = text[j] === c ? j + 1 : j;
      last = 'x';
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      i++;
      continue;
    }
    if (c === '/' && regexAllowedAfter(last)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      if (text[j] === '/') {
        blankInto(masked, i + 1, j);
        j++;
        while (j < n && /[a-z]/i.test(text[j])) j++;
        i = j;
        last = 'x';
        continue;
      }
    }
    if (c === '{') depth++;
    else if (c === '}') {
      if (templates.length && templates[templates.length - 1] === depth - 1) {
        templates.pop();
        depth--;
        inTemplate = true;
        i++;
        continue;
      }
      depth--;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j])) j++;
      last = text.slice(i, j);
      i = j;
      continue;
    }
    last = c;
    i++;
  }
  return { code: code.join(''), masked: masked.join('') };
}

/** Go: line and block comments; interpreted strings and runes end at a newline. */
export function lexGo(text) {
  const code = text.split('');
  const masked = text.split('');
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      blankInto(code, i, j);
      blankInto(masked, i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      const j = text.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      blankInto(code, i, end);
      blankInto(masked, i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blankInto(masked, i + 1, Math.min(j, n));
      i = text[j] === c ? j + 1 : j;
    } else if (c === '`') {
      let j = text.indexOf('`', i + 1);
      if (j < 0) j = n;
      blankInto(masked, i + 1, j);
      i = j + 1;
    } else i++;
  }
  return { code: code.join(''), masked: masked.join('') };
}

/**
 * Shell: a `#` that starts a word, outside quotes on its line, starts a
 * comment. (Quotes are tracked per line; a quoted string that spans lines is
 * rare in these scripts.) Strings are kept: shell has no masked view.
 */
export function lexSh(text) {
  const lines = text.split('\n').map(line => {
    let quote = '';
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (quote) {
        if (c === '\\' && quote === '"') k++;
        else if (c === quote) quote = '';
      } else if (c === '\\') k++;
      else if (c === "'" || c === '"') quote = c;
      else if (c === '#' && (k === 0 || /\s/.test(line[k - 1])))
        return line.slice(0, k) + ' '.repeat(line.length - k);
    }
    return line;
  });
  const code = lines.join('\n');
  return { code, masked: code };
}

const LEXERS = { go: lexGo, ts: lexJs, js: lexJs, sh: lexSh };

// --- Structure helpers ----------------------------------------------------------

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);

/** Index of the `)` matching the `(` at `open` in the masked view, or -1. */
export function closingParen(masked, open) {
  if (masked[open] !== '(') return -1;
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const c = masked[k];
    if (OPEN[c]) depth++;
    else if (CLOSE.has(c)) {
      depth--;
      if (depth === 0) return c === ')' ? k : -1;
    }
  }
  return -1;
}

/** The top-level arguments of the call whose `(` is at `open`: [{ from, to }]. */
export function callArgs(masked, open) {
  const close = closingParen(masked, open);
  if (close < 0) return null;
  const args = [];
  let depth = 0;
  let from = open + 1;
  for (let k = open + 1; k < close; k++) {
    const c = masked[k];
    if (OPEN[c]) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (c === ',' && depth === 0) {
      args.push({ from, to: k });
      from = k + 1;
    }
  }
  if (masked.slice(from, close).trim() !== '') args.push({ from, to: close });
  return { close, args };
}

/**
 * True when the name at `at` whose `(` is at `open` is being defined, not
 * called: `function sleep(`, `async sleep(`, or a method `sleep(ms) {`.
 */
function isDefinition(ctx, at, open) {
  const before = ctx.code.slice(Math.max(0, at - 24), at);
  if (/\b(?:function\s*\*?|async|get|set|static)\s+$/.test(before)) return true;
  const close = closingParen(ctx.masked, open);
  if (close < 0) return false;
  const after = ctx.masked.slice(close + 1, close + 200);
  return /^\s*(?::\s*[\w$][^{};=]*?)?\s*\{/.test(after);
}

// --- Rules --------------------------------------------------------------------
//
// Each rule: a stable id, the languages it applies to, an optional path filter,
// whether a fake-clock file is allowed it, what it found, how to fix it, and
// find(ctx) => [{ at, text }]. `ctx` is { file, lang, code, masked }.

const all = (re, s) => [...s.matchAll(re)].map(m => ({ at: m.index, text: m[0], m }));
// Every call pattern ends at its `(`. Inside a string the masked view has no
// `(` there, so the structural helpers below find no call and report no hit.
const parenOf = (ctx, hit) => hit.at + hit.text.length - 1;

const LITERAL_DURATION =
  /\btime\.(?:Nanosecond|Microsecond|Millisecond|Second|Minute|Hour)\b|\btime\.(?:Now|Since|Until)\s*\(/;
const NUMBER = /^[\d_]+(?:\.\d+)?(?:e\d+)?$/i;
const KEEP_ALIVE =
  /^\(\s*(?:\(\s*\)\s*=>\s*(?:\{\s*\}|undefined|void 0)|function\s*\(\s*\)\s*\{\s*\})\s*,/;

/** @type {Rule[]} */
export const RULES = [
  // --- Go -------------------------------------------------------------------
  {
    id: 'go-sleep',
    langs: ['go'],
    fakeClockAllowed: true,
    found: 'time.Sleep',
    fix: 'wait on the event (a channel or signal from the fake), or advance a clocktest.Fake',
    find: ctx => all(/\btime\.Sleep\s*\(/g, ctx.code),
  },
  {
    id: 'go-after',
    langs: ['go'],
    fakeClockAllowed: true,
    found: 'time.After / time.AfterFunc',
    fix: 'select on the event, bounded by t.Deadline() through internal/await, or inject clock.Clock',
    find: ctx => all(/\btime\.After(?:Func)?\s*\(/g, ctx.code),
  },
  {
    id: 'go-tick',
    langs: ['go'],
    fakeClockAllowed: true,
    found: 'time.Tick',
    fix: 'inject clock.Clock and drive it with clocktest.Fake',
    find: ctx => all(/\btime\.Tick\s*\(/g, ctx.code),
  },
  {
    id: 'go-timer',
    langs: ['go'],
    fakeClockAllowed: true,
    found: 'time.NewTimer / time.NewTicker',
    fix: 'inject clock.Clock and drive it with clocktest.Fake',
    find: ctx => all(/\btime\.New(?:Timer|Ticker)\s*\(/g, ctx.code),
  },
  {
    id: 'go-context-timeout',
    langs: ['go'],
    fakeClockAllowed: true,
    found: 'context.WithTimeout / WithDeadline with a literal duration',
    fix: 'bound the wait by t.Deadline() (internal/await) or use clock.WithTimeout on an injected clock',
    find: ctx =>
      all(/\bcontext\.With(?:Timeout|Deadline)(?:Cause)?\s*\(/g, ctx.code).filter(h => {
        const call = callArgs(ctx.masked, parenOf(ctx, h));
        return call && LITERAL_DURATION.test(ctx.code.slice(h.at, call.close));
      }),
  },
  {
    id: 'go-wall-clock',
    langs: ['go'],
    fakeClockAllowed: true,
    found: 'time.Now / time.Since / time.Until',
    fix: 'inject clock.Clock (clocktest.Fake), or use a fixed time.Date(...)',
    find: ctx => all(/\btime\.(?:Now\s*\(\s*\)|Since\s*\(|Until\s*\()/g, ctx.code),
  },
  {
    id: 'go-eventually',
    langs: ['go'],
    found: 'Eventually / Consistently / Never (a per-wait deadline)',
    fix: 'wait on the event; a poll may be bounded only by the test deadline (internal/await)',
    find: ctx =>
      all(
        /(?<![\w$])(?:Eventually|EventuallyWithT|Consistently)f?\s*\(|\.Never(?:f)?\s*\(/g,
        ctx.code
      ),
  },
  {
    id: 'go-fixed-port',
    langs: ['go'],
    found: 'a listener on a fixed port',
    fix: 'listen on 127.0.0.1:0 and read the port back from the listener',
    find: ctx =>
      all(
        /\b(?:net\.Listen(?:TCP|UDP|Packet)?|http\.ListenAndServe(?:TLS)?)\s*\(/g,
        ctx.code
      ).filter(h => {
        const call = callArgs(ctx.masked, parenOf(ctx, h));
        if (!call) return false;
        const args = ctx.code.slice(h.at, call.close);
        const port = /"[^"\n]*:(\d+)"/.exec(args) ?? /\bPort:\s*(\d+)/.exec(args);
        return port !== null && Number(port[1]) !== 0;
      }),
  },

  // --- TS / JS ----------------------------------------------------------------
  {
    id: 'js-timer',
    langs: ['ts', 'js'],
    fakeClockAllowed: true,
    found: 'a real timer (setTimeout / setInterval / AbortSignal.timeout)',
    fix: 'await the event, or install fake timers (jest.useFakeTimers) and advance them',
    find: ctx =>
      all(
        /(?<![\w$.])(?:setTimeout|setInterval)\s*\(|\b(?:globalThis|window|global|self)\s*\.\s*(?:setTimeout|setInterval)\s*\(|\bAbortSignal\s*\.\s*timeout\s*\(/g,
        ctx.code
      ).filter(h => {
        const open = parenOf(ctx, h);
        if (isDefinition(ctx, h.at, open)) return false;
        // A keep-alive (`setInterval(() => {}, n)`) runs nothing, so it cannot
        // decide anything; it holds a child process open until it is signalled.
        return !(/setInterval/.test(h.text) && KEEP_ALIVE.test(ctx.code.slice(open)));
      }),
  },
  {
    id: 'js-timers-import',
    langs: ['ts', 'js'],
    found: "an import of node's timers module",
    fix: 'await the event, or use fake timers the test advances',
    find: ctx =>
      all(
        /\b(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"](?:node:)?timers(?:\/promises)?['"]/g,
        ctx.code
      ),
  },
  {
    id: 'js-sleep',
    langs: ['ts', 'js'],
    found: 'sleep(...)',
    fix: 'await the event, or inject a fake clock the test advances',
    find: ctx =>
      all(/(?<![\w$.])sleep\s*\(/g, ctx.code).filter(
        h => !isDefinition(ctx, h.at, parenOf(ctx, h))
      ),
  },
  {
    id: 'js-date-now',
    langs: ['ts', 'js'],
    fakeClockAllowed: true,
    found: 'Date.now()',
    fix: 'inject now, or freeze it with jest.useFakeTimers({ now })',
    find: ctx => all(/\bDate\s*\.\s*now\s*\(\s*\)/g, ctx.code),
  },
  {
    id: 'js-new-date',
    langs: ['ts', 'js'],
    fakeClockAllowed: true,
    found: 'new Date() with no argument',
    fix: 'pass a fixed date, inject now, or freeze it with jest.useFakeTimers({ now })',
    find: ctx => all(/\bnew\s+Date\s*\(\s*\)|(?<![\w$.])(?<!new\s+)Date\s*\(\s*\)/g, ctx.code),
  },
  {
    id: 'js-performance-now',
    langs: ['ts', 'js'],
    found: 'performance.now / process.hrtime (elapsed time)',
    fix: 'do not measure elapsed time in a test; assert on the outcome',
    find: ctx => all(/\bperformance\s*\.\s*now\s*\(|\bprocess\s*\.\s*hrtime\b/g, ctx.code),
  },
  {
    id: 'js-wait-timeout',
    langs: ['ts', 'js'],
    found: 'an explicit timeout on waitFor / findBy*',
    fix: "drop it: the runner's hang guard (testTimeout, asyncUtilTimeout) bounds the wait",
    find: ctx =>
      all(
        /(?<![\w$])(?:waitFor|waitForElementToBeRemoved|find(?:All)?By[A-Z]\w*)\s*\(/g,
        ctx.code
      ).filter(h => {
        const call = callArgs(ctx.masked, parenOf(ctx, h));
        return call && /\btimeout\s*:/.test(ctx.masked.slice(h.at, call.close));
      }),
  },
  {
    id: 'js-listen-port',
    langs: ['ts', 'js'],
    found: 'a listener on a fixed port',
    fix: 'listen on port 0 and read server.address().port',
    find: ctx =>
      all(/\.listen\s*\(/g, ctx.code).filter(h => {
        const call = callArgs(ctx.masked, parenOf(ctx, h));
        if (!call || call.args.length === 0) return false;
        const first = ctx.code.slice(call.args[0].from, call.args[0].to).trim();
        const port = /^([\d_]+)$/.exec(first) ?? /\bport\s*:\s*([\d_]+)/.exec(first);
        return port !== null && Number(port[1].replace(/_/g, '')) !== 0;
      }),
  },
  {
    id: 'js-test-timeout',
    langs: ['ts', 'js'],
    found: 'a per-test timeout',
    fix: 'set the hang guard once in the runner config (testTimeout in jest.config.ts)',
    find: ctx => [
      ...all(/\bjest\s*\.\s*setTimeout\s*\(/g, ctx.code),
      ...all(
        /(?<![\w$.])(?:it|test|describe|beforeAll|beforeEach|afterAll|afterEach)(?:\s*\.\s*(?:only|skip|concurrent|failing))?\s*\(/g,
        ctx.code
      ).filter(h => {
        const call = callArgs(ctx.masked, parenOf(ctx, h));
        if (!call || call.args.length < 2) return false;
        const text = a => ctx.masked.slice(a.from, a.to).trim();
        const lastArg = text(call.args[call.args.length - 1]);
        return (
          NUMBER.test(lastArg) ||
          call.args.some(a => /^\{/.test(text(a)) && /\btimeout\s*:/.test(text(a)))
        );
      }),
    ],
  },

  // --- Playwright (apps/web-e2e/src/**) ----------------------------------------
  {
    id: 'pw-wait-for-timeout',
    langs: ['ts', 'js'],
    paths: PLAYWRIGHT,
    found: 'page.waitForTimeout',
    fix: 'wait for a locator or an expect(...) to hold: Playwright auto-waits',
    find: ctx => all(/\bwaitForTimeout\s*\(/g, ctx.code),
  },
  {
    id: 'pw-explicit-timeout',
    langs: ['ts', 'js'],
    paths: PLAYWRIGHT,
    found: 'an explicit timeout on an action, an expect or a test',
    fix: 'drop it: the hang guard belongs in playwright.config.ts',
    find: ctx => [
      ...all(/(?<![\w$])timeout\s*:/g, ctx.masked),
      ...all(/\b(?:test\s*\.\s*setTimeout|setDefault(?:Navigation)?Timeout)\s*\(/g, ctx.code),
    ],
  },

  // --- Shell --------------------------------------------------------------------
  {
    id: 'sh-sleep',
    langs: ['sh'],
    found: 'sleep',
    fix: "wait on the child's own signal (a readiness line on a FIFO or socket), then wait $pid",
    find: ctx => all(/(?:^|[\s;&|(`{])sleep\s+(?:[\d.$"']|infinity)/gm, ctx.code),
  },
  {
    id: 'sh-timeout',
    langs: ['sh'],
    found: 'timeout <n> (a per-command deadline)',
    fix: "wait on the child's own signal; the runner's hang guard bounds the suite",
    find: ctx =>
      all(/(?:^|[\s;&|(`{])g?timeout\s+(?:-\S*\s+(?:[A-Z]+\s+)?)*['"]?[\d.$]/gm, ctx.code),
  },
  {
    id: 'sh-read-timeout',
    langs: ['sh'],
    found: 'read -t (a read with a deadline)',
    fix: 'read without -t: the writer closing its end is the event',
    find: ctx => all(/(?:^|[\s;&|(`{])read\s+[^;&|\n]*?(?<=\s)-[A-Za-z]*t/gm, ctx.code),
  },
  {
    id: 'sh-wall-clock',
    langs: ['sh'],
    found: 'the wall clock (date +%s, $SECONDS, $EPOCHSECONDS)',
    fix: 'do not measure elapsed time; assert on the outcome, or pass a fixed time in',
    find: ctx =>
      all(/\bdate\b[^;&|\n]*\+%s|\$\{?(?:SECONDS|EPOCHSECONDS|EPOCHREALTIME)\b/g, ctx.code),
  },
  {
    id: 'sh-grep-q-pipefail',
    langs: ['sh'],
    found: 'a pipe into grep -q under pipefail',
    fix: 'grep a variable through a here-string (grep -q x <<<"$v") or use matches()',
    find: ctx => {
      if (!/\bset\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*o\s+pipefail\b/.test(ctx.code)) return [];
      return all(/(?<!\|)\|&?\s*[ef]?grep\b([^|;&)\n]*)/g, ctx.code).filter(h => {
        for (const tok of h.m[1].trim().split(/\s+/)) {
          if (tok === '--') return false;
          if (tok === '--quiet' || tok === '--silent' || /^-[A-Za-z]*q[A-Za-z]*$/.test(tok))
            return true;
        }
        return false;
      });
    },
  },
];

export const RULE_IDS = RULES.map(r => r.id);

/**
 * A per-file allowance: a file that installs a fake clock may call what that
 * clock fakes. The guard cannot tell whether a given call runs before the fake
 * is installed (README, "Blind spots").
 */
export function fakeClockOf(lang, code) {
  if (lang === 'ts' || lang === 'js')
    return /\buseFakeTimers\s*\(|\bmock\s*\.\s*timers\s*\.\s*enable\s*\(/.test(code)
      ? 'fake timers'
      : null;
  if (lang === 'go') return /\bsynctest\s*\.\s*(?:Test|Run)\s*\(/.test(code) ? 'synctest' : null;
  return null;
}

// --- Scanning --------------------------------------------------------------------

function lineStarts(text) {
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') starts.push(k + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Every hit in one file's text: [{ file, line, rule, found, fix, lineText }]. */
export function scanText(file, text) {
  const lang = languageOf(file);
  if (!lang) return { hits: [], fakeClock: null };
  const { code, masked } = LEXERS[lang](text);
  const ctx = { file, lang, code, masked };
  const fakeClock = fakeClockOf(lang, code);
  const starts = lineStarts(text);
  const rawLines = text.split('\n');
  const seen = new Set();
  const hits = [];
  for (const rule of RULES) {
    if (!rule.langs.includes(lang)) continue;
    if (rule.paths && !matchesAny(file, rule.paths)) continue;
    if (fakeClock && rule.fakeClockAllowed) continue;
    for (const h of rule.find(ctx)) {
      // A match may start on the separator before the name (`;sleep 1`).
      const at = h.at + (h.text.length - h.text.trimStart().length);
      const line = lineOf(starts, at);
      const key = `${rule.id}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        file,
        line,
        rule: rule.id,
        found: rule.found,
        fix: rule.fix,
        lineText: rawLines[line - 1].trim(),
      });
    }
  }
  hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return { hits, fakeClock };
}

// --- Files ------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.nx', 'dist', '.terraform']);

/** Tracked files under `root` (repo-relative to it), as git lists them. */
export function gitFiles(root, { untracked = false } = {}) {
  const args = ['-C', root, 'ls-files', '-z', '--cached'];
  if (untracked) args.push('--others', '--exclude-standard');
  const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

/** Every file under `root`, walking the file system (the guard's own fixtures). */
export function walkFiles(root, rel = '', out = []) {
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(root, child, out);
    else out.push(child);
  }
  return out.sort();
}

// --- Exceptions ---------------------------------------------------------------------

/**
 * exceptions.json:
 *   outOfScope  [{ path: glob, except?: [glob], reason }]  whole paths the
 *               guard does not scan (the live suites; its own fixtures).
 *   exceptions  [{ path, rule, line | pattern, reason }]  single hits it
 *               accepts: `line` is the hit's line text (trimmed) exactly,
 *               `pattern` a regular expression tested against it.
 * Returns { config, errors }.
 */
export function parseExceptions(json) {
  const errors = [];
  let config;
  try {
    config = JSON.parse(json);
  } catch (e) {
    return { config: null, errors: [`exceptions file is not JSON: ${e.message}`] };
  }
  const outOfScope = config.outOfScope ?? [];
  const exceptions = config.exceptions ?? [];
  if (!Array.isArray(outOfScope)) errors.push('outOfScope must be an array');
  if (!Array.isArray(exceptions)) errors.push('exceptions must be an array');
  if (errors.length) return { config: null, errors };
  const reasoned = (e, where) => {
    if (typeof e.reason !== 'string' || e.reason.trim() === '')
      errors.push(`${where}: every entry needs a non-empty reason`);
  };
  outOfScope.forEach((e, k) => {
    const where = `outOfScope[${k}] (${e.path})`;
    if (typeof e.path !== 'string' || e.path === '') errors.push(`${where}: path is required`);
    if (e.except !== undefined && !Array.isArray(e.except))
      errors.push(`${where}: except must be an array of globs`);
    reasoned(e, where);
  });
  exceptions.forEach((e, k) => {
    const where = `exceptions[${k}] (${e.path}, ${e.rule})`;
    if (typeof e.path !== 'string' || e.path === '') errors.push(`${where}: path is required`);
    if (!RULE_IDS.includes(e.rule)) errors.push(`${where}: unknown rule "${e.rule}"`);
    const hasLine = typeof e.line === 'string' && e.line.trim() !== '';
    const hasPattern = typeof e.pattern === 'string' && e.pattern !== '';
    if (hasLine === hasPattern) errors.push(`${where}: give exactly one of line or pattern`);
    if (hasPattern) {
      try {
        new RegExp(e.pattern);
      } catch (err) {
        errors.push(`${where}: pattern is not a regular expression: ${err.message}`);
      }
    }
    reasoned(e, where);
  });
  return { config: { outOfScope, exceptions }, errors };
}

const exceptionCovers = (e, hit) =>
  e.path === hit.file &&
  e.rule === hit.rule &&
  (e.line !== undefined
    ? e.line.trim() === hit.lineText
    : new RegExp(e.pattern).test(hit.lineText));

const outOfScopeCovers = (e, file) =>
  matchesAny(file, [e.path]) && !(e.except && matchesAny(file, e.except));

/**
 * The whole check over `files` (repo-relative) read from `root`.
 * Returns { scanned: {go, ts, js, sh}, skipped, fakeClockFiles, violations,
 *           excused, stale, staleScope }.
 */
export function check({
  root,
  files,
  config,
  read = f => readFileSync(path.join(root, f), 'utf8'),
}) {
  const scanned = Object.fromEntries(LANGUAGES.map(l => [l, 0]));
  const skipped = [];
  const fakeClockFiles = [];
  const hits = [];
  const scopeUse = config.outOfScope.map(() => 0);
  for (const file of files) {
    config.outOfScope.forEach((e, k) => {
      if (outOfScopeCovers(e, file)) scopeUse[k]++;
    });
    if (!inScope(file)) continue;
    if (config.outOfScope.some(e => outOfScopeCovers(e, file))) {
      skipped.push(file);
      continue;
    }
    let text;
    try {
      text = read(file);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // tracked, deleted in the working tree
      throw e;
    }
    const result = scanText(file, text);
    scanned[languageOf(file)]++;
    if (result.fakeClock) fakeClockFiles.push({ file, fakeClock: result.fakeClock });
    hits.push(...result.hits);
  }
  const used = config.exceptions.map(() => 0);
  const violations = [];
  const excused = [];
  for (const hit of hits) {
    const k = config.exceptions.findIndex(e => exceptionCovers(e, hit));
    if (k < 0) violations.push(hit);
    else {
      used[k]++;
      excused.push({ hit, reason: config.exceptions[k].reason });
    }
  }
  const stale = config.exceptions.filter((_, k) => used[k] === 0);
  const staleScope = config.outOfScope.filter((_, k) => scopeUse[k] === 0);
  return { scanned, skipped, fakeClockFiles, violations, excused, stale, staleScope };
}

/** `file:line: rule: what it found — how to fix` */
export const formatHit = h => `${h.file}:${h.line}: ${h.rule}: ${h.found} — ${h.fix}`;

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string[]} langs
 * @property {string[]} [paths]
 * @property {boolean} [fakeClockAllowed]
 * @property {string} found
 * @property {string} fix
 * @property {(ctx: object) => {at: number, text: string}[]} find
 */
