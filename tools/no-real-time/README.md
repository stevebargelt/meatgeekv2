# no-real-time

Fails when a non-live test file waits on real time: a sleep, a real timer, a
per-wait deadline, a read of the wall clock, a fixed port, or a pipe into
`grep -q` under pipefail. Goal HAR-106 took every test in MeatGeek off real
time; this guard keeps it that way (HAR-127). The rule it enforces, and how to
wait without a clock in each language, is in
[docs/development/deterministic-tests.md](../../docs/development/deterministic-tests.md).

Node built-ins only. Nothing to install. CI runs it on every pull request and
push to `main` as the `no-real-time-guard` job in `.github/workflows/ci.yml`.

```sh
node tools/no-real-time/check.mjs             # the whole tracked tree
node tools/no-real-time/check.mjs --verbose   # also: each excepted hit, each fake-clock file, each skipped path
node tools/no-real-time/check.mjs --untracked # also scan files git does not track yet (not ignored ones)
```

It scans **every** file in scope that `git ls-files` lists, not only a diff:
a whole-tree scan is what keeps the exception list honest (an exception that
matches nothing fails). Untracked and ignored files are skipped, so `git add` a
new test file (or pass `--untracked`) before you expect the guard to see it.

Each hit no exception covers prints one line, and the last line is a summary:

```
apps/web/src/zz-guard-probe.spec.ts:2: js-timer: a real timer (setTimeout / setInterval / AbortSignal.timeout) — await the event, or install fake timers (jest.useFakeTimers) and advance them
no-real-time: scanned 161 files (go 32, ts 99, js 21, sh 9); 1 violation, 6 excepted hits (5 exceptions), 0 stale; 5 on a fake clock; 51 out of scope by path
```

Exit codes: 0 clean, 1 a violation or a stale entry, 2 a usage error or a
malformed `exceptions.json`. `--root DIR`, `--exceptions FILE` and `--walk`
(list files by walking the file system instead of asking git) exist for the
guard's own tests.

## Files

| File              | What it is                                                                 |
| ----------------- | -------------------------------------------------------------------------- |
| `check.mjs`       | The CLI.                                                                   |
| `lib.mjs`         | Scope, the lexers, the rules, the exception matching.                      |
| `exceptions.json` | The reviewed exceptions and the out-of-scope paths, each with its reason.  |
| `run-tests.mjs`   | Runs `test/*.test.mjs` with file and test-count floors.                    |
| `test/`           | The guard's own tests and their fixtures (`test/fixtures/`, out of scope). |

## Scope

**Test files:** `*_test.go`, `*.spec.ts`, `*.spec.tsx`, `*.test.ts`,
`*.test.mjs`, `*.test.js`, `*.test.sh`, and
`apps/infrastructure/scripts/fixtures/run-*-fixtures.sh`.

**Test-only helpers:** `*.testing.ts`, `apps/web-e2e/src/fakes/**`,
`apps/web/src/test/**`, `apps/infrastructure/scripts/*/fake-*.mjs`,
`tools/test-repeat/test/**`, and the Go helper packages `internal/await`,
`internal/clock/clocktest` and `internal/iothub/iothubtest`. A helper's job is
often to provide waits, so one that legitimately touches a real clock is an
exception with a reason (`internal/await`, the hang guard itself, is).

Only `.go`, `.ts`, `.tsx`, `.mjs`, `.js`, `.cjs` and `.sh` files are scanned.

**Out of scope by path** (`outOfScope` in `exceptions.json`, each with its
reason): the live suites, which wait on a real cloud by design
(`apps/api/acceptance/live.acceptance.ts`, `apps/api/acceptance/proofs/**`,
`apps/api/acceptance/lib/**`, `apps/web-e2e/live/**` except its `*.test.ts`
files, which are non-live and stay in scope, and `apps/ios/MeatGeekLiveUITests/**`,
the live iOS proof), and the guard's own fixtures. An out-of-scope path that
matches no tracked file is stale and fails the check.

The guard has no Swift rules (the language list above), so no iOS test is
scanned today, and the live iOS entry (HAR-169) skips no scanned file yet. It
names the live target alone, so if Swift rules are added, `MeatGeekUITests`
and MeatGeekKit's tests are in scope and only the live proof is not; the
`live` case fixture (`test/fixtures/cases/live/apps/ios/`) proves a file beside
the live target is still a hit.

## Rules

Every rule has a stable id; the hit line names it. Comments are never hits.
String literals are: a timer written into a child process's source is code the
test runs.

| Id                    | Language   | Finds                                                                                                                  |
| --------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `go-sleep`            | Go         | `time.Sleep(`                                                                                                          |
| `go-after`            | Go         | `time.After(`, `time.AfterFunc(`                                                                                       |
| `go-tick`             | Go         | `time.Tick(`                                                                                                           |
| `go-timer`            | Go         | `time.NewTimer(`, `time.NewTicker(`                                                                                    |
| `go-context-timeout`  | Go         | `context.WithTimeout` / `WithDeadline` (and `…Cause`) whose arguments hold a literal duration or `time.Now`            |
| `go-wall-clock`       | Go         | `time.Now()`, `time.Since(`, `time.Until(`                                                                             |
| `go-eventually`       | Go         | Gomega `Eventually` / `Consistently`, testify `Eventually` / `EventuallyWithT` / `Never`                               |
| `go-fixed-port`       | Go         | `net.Listen*` / `http.ListenAndServe*` on a non-zero literal port (`"host:8080"`, `Port: 8080`)                        |
| `js-timer`            | TS/JS      | `setTimeout(`, `setInterval(` (bare or on `globalThis`/`window`/`global`/`self`), `AbortSignal.timeout(`               |
| `js-timers-import`    | TS/JS      | an import or require of `timers` / `timers/promises` (catches `import { setTimeout as delay }`)                        |
| `js-sleep`            | TS/JS      | a bare `sleep(` call                                                                                                   |
| `js-date-now`         | TS/JS      | `Date.now()`                                                                                                           |
| `js-new-date`         | TS/JS      | `new Date()` and `Date()` with no argument                                                                             |
| `js-performance-now`  | TS/JS      | `performance.now(`, `process.hrtime`                                                                                   |
| `js-wait-timeout`     | TS/JS      | a `timeout:` option on RTL `waitFor`, `waitForElementToBeRemoved`, `findBy*`, `findAllBy*`                             |
| `js-listen-port`      | TS/JS      | `.listen(<non-zero literal>)`, `.listen({ port: <non-zero> })`                                                         |
| `js-test-timeout`     | TS/JS      | `jest.setTimeout(`; a numeric last argument to `it`/`test`/`describe`/hooks; a `{ timeout: … }` option to them         |
| `pw-wait-for-timeout` | Playwright | `waitForTimeout(` under `apps/web-e2e/src/**`                                                                          |
| `pw-explicit-timeout` | Playwright | a `timeout:` option, `test.setTimeout(`, `setDefaultTimeout(`, `setDefaultNavigationTimeout(` under `apps/web-e2e/src` |
| `sh-sleep`            | Shell      | `sleep <n>` (a number, a variable, a quoted value or `infinity`)                                                       |
| `sh-timeout`          | Shell      | `timeout <n>` / `gtimeout <n>`, with or without options                                                                |
| `sh-read-timeout`     | Shell      | `read -t`                                                                                                              |
| `sh-wall-clock`       | Shell      | `date … +%s`, `$SECONDS`, `$EPOCHSECONDS`, `$EPOCHREALTIME`                                                            |
| `sh-grep-q-pipefail`  | Shell      | a pipe into `grep -q` / `--quiet` / `--silent` (or `egrep`/`fgrep`) in a file that sets `-o pipefail`                  |

`sh-grep-q-pipefail` is not a clock. It is the scheduling race that made
`bootstrap (load x8)` pass 7 of 8 (HAR-121, HAR-125): `grep -q` exits at its
first match, the writer's next write gets SIGPIPE, and pipefail turns a match
into a failure, depending on how the two processes were scheduled.

Refinements, each a decision about what the text means (and so each also a
blind spot, below):

- **A fake clock in the file.** A TS/JS file that calls `useFakeTimers(` (Jest,
  sinon) or `mock.timers.enable(` (node:test) may use `setTimeout`,
  `setInterval`, `Date.now()` and `new Date()`: they read the fake clock. A Go
  file that calls `synctest.Test(` or `synctest.Run(` may use the `time`
  rules' functions (`go-sleep`, `go-after`, `go-tick`, `go-timer`,
  `go-context-timeout`, `go-wall-clock`): inside the bubble they are fake. The
  allowance is per file.
- **A member call is an injected clock.** `clock.sleep(…)`,
  `timers.setTimeout(…)`, `clk.After(…)`, `fake.Tick(…)` are not hits; only the
  bare global (or `globalThis.`/`window.`) and Go's `time.` package are.
- **A definition is not a call.** `function sleep(…)`, `async sleep(…)`, and a
  method `setTimeout(fn, ms) {` are not hits.
- **A keep-alive is not a wait.** `setInterval(() => {}, n)` and
  `setInterval(() => undefined, n)` run nothing, so they cannot decide anything;
  they hold a child process open until a signal ends it.
- **Only a literal duration.** `context.WithTimeout(ctx, d)` and
  `context.WithDeadline(ctx, at)` with a computed bound (such as
  `internal/await`'s guard) are not `go-context-timeout` hits.

## Exceptions

`exceptions.json` has two lists:

```json
{
  "outOfScope": [{ "path": "<glob>", "except": ["<glob>"], "reason": "…" }],
  "exceptions": [
    { "path": "<file>", "rule": "<rule id>", "line": "<the line's text, trimmed>", "reason": "…" },
    { "path": "<file>", "rule": "<rule id>", "pattern": "<regular expression>", "reason": "…" }
  ]
}
```

An exception names one file, one rule, and the line it covers by its text
(`line`, exact after trimming) or a regular expression tested against it
(`pattern`), never by number, so an edit above it does not stale it. Every
entry needs a reason a reviewer can check: why this wait cannot be an event, a
fake clock, or a no-deadline poll. An entry that covers no hit fails the check
as stale; delete it.

To add one: fix the test first if you can (the doc has the patterns). If you
cannot, add the entry with its reason in the same pull request, and say why in
the description; the reviewer reviews the entry like code. Keep the list short:
if it would pass about 15 entries, the rule is too broad. Refine the rule in
`lib.mjs` instead, with a fixture that shows the refinement, and add the
refinement to the blind spots below.

## Blind spots

The guard reads text in test files. It cannot see:

- **Waits inside product code a test calls.** A test that calls a function
  which sleeps, or which reads `Date.now()`, passes the guard. Product code is
  out of scope; inject its clock (as `UsersRepository` takes `now`) and the test
  can control it.
- **Aliases.** `const wait = setTimeout`, `const { now } = Date`, a helper
  imported from another module that sleeps. (`import { setTimeout as delay }
from 'node:timers/promises'` is caught, by `js-timers-import`.)
- **A member call that is not an injected clock.** `foo.setTimeout(…)` on a
  real timer object passes, by the refinement above.
- **Whether a call runs before the fake clock is installed.** The fake-timers
  and synctest allowances are per file: a `setTimeout` in a file that installs
  fake timers in one `describe` and not another passes.
- **Real network or child-process latency** a test depends on without a timer:
  a race between two real processes, an assertion that one finishes first.
- **Goroutine or event-loop ordering** assumptions with no timer in sight.
- **The caller's environment**: a variable, a `TZ`, a locale that changes a
  result (test-repeat drops the caller's environment for its runs).
- **Generated or dynamically built code**: source assembled at run time
  (`'set' + 'Timeout'`), `eval`, a file written by the test and then run.
- **Anything not visible as text in a test file**: runner flags, a config's
  hang guard, a fixed port in a config file, a deadline in a shared helper
  outside the scope globs.
- **Test helpers outside the scope globs.** A new helper directory must be added
  to `TEST_HELPERS` in `lib.mjs` to be scanned.
- **Shell quotes that span lines** and heredoc bodies: the shell lexer tracks
  quotes per line, so a `#` inside a multi-line string may hide the rest of its
  line, and a `sleep` inside a heredoc that writes a fake script is a hit.
- **`pipefail` from elsewhere.** `sh-grep-q-pipefail` looks for `set -o
pipefail` in the same file; a script that inherits it from a sourced file, or
  turns it off for one block (`set +o pipefail`), is judged by the file.
- **A test a pattern does not match by name.** A new test file naming
  convention must be added to `TEST_FILES`.

## Tests

```sh
node tools/no-real-time/run-tests.mjs
node tools/test-repeat/test-repeat.mjs run no-real-time-guard --runs 50
```

`test/rules.test.mjs` scans every fixture under `test/fixtures/rules/`. A
fixture marks each line that must be a hit with a trailing `expect: <rule id>`
comment; every other line, including the near misses written beside each
violation, must be none. There is a violating fixture for every rule in every
language it applies to, a clean fixture per language, a fake-timers fixture and
a synctest fixture. `test/check.test.mjs` runs the CLI on the case trees under
`test/fixtures/cases/` (the acceptance probe, an exception that suppresses its
hit, stale entries, the live paths) and on the repository itself, and asserts
on the exit code and the output. No test waits on a clock: each runs the
scanner or the CLI to completion. The suite is `no-real-time-guard` in
`tools/test-repeat/suites.mjs`.
