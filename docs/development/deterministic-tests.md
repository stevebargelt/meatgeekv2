# Deterministic tests

Every non-live test in MeatGeek passes or fails on what the code does, never on
how fast the machine running it is. Goal HAR-106 took every test off real time:
each suite passes 50 runs in a row and 8 copies at once. This page is the rule
that keeps it that way, how to wait without a clock in each language used here,
how to prove a test, and the guard that enforces the rule.

## The rule

A non-live test may wait only by:

1. **awaiting the event** it is about (a channel, a callback, a child's exit, a
   readiness line);
2. **a fake clock the test advances**;
3. **polling a condition with no deadline of its own**, bounded only by the
   runner's hang guard (`go test -timeout`, Jest's `testTimeout`, test-repeat's
   `timeoutSec`).

It may not:

- sleep;
- use a per-wait deadline that decides pass or fail;
- assert on elapsed time;
- let an assertion depend on the wall clock, unless the clock is frozen or
  injected;
- assert that "nothing happened within X ms";
- bind a fixed port.

**Why.** A test with a real-time wait is a bet that the machine is fast enough.
On a loaded CI runner, or with 8 copies sharing 4 vCPUs, the bet loses
sometimes, and a test that fails sometimes is one nobody trusts. Of the eight
times `main` went red on 2026-11-19 and 2026-11-20, three were a
timing-dependent test. A hang guard is different: it only ever fires on a test
that would otherwise never finish, so it cannot turn a slow pass into a failure.

## How to wait without a clock

### Go

- **Wait on a signal from the fake.** `iothubtest.Broker` and
  `clocktest.Fake` both expose `Changed()`; `internal/await` blocks until a
  condition holds, re-checking only when one of its sources changes, bounded by
  the test binary's own deadline (`t.Deadline()`, from `go test -timeout`). A
  stuck wait fails naming what it waited for. From
  `apps/data-pusher/cmd/twin_reconnect_test.go`:

  ```go
  clk := clocktest.New(time.Unix(1_700_000_000, 0))
  client, err := iothub.NewAzureClient(twinTestConnStr,
      iothub.WithBrokerURL(broker.URL()),
      iothub.WithClock(clk))
  // ...
  broker.DropConnections()
  await.Until(t, "the reconnect backoff after the drop",
      func() bool { return slices.Contains(clk.Pending(), time.Second) },
      func() any { return clk.Pending() }, clk)
  clk.Advance(time.Second)
  await.Until(t, "a reconnect", func() bool { return broker.Connections() >= 2 },
      func() any { return broker.Connections() }, broker)
  ```

- **Inject `clock.Clock`.** Product code takes a `clock.Clock` (`iothub.WithClock`,
  simdevice's `Env.Clock`); a test passes `clocktest.Fake` and calls
  `Advance`. For a deadline, use `clock.WithTimeout(ctx, clk, d)`, not
  `context.WithTimeout`: it is done when the fake reaches `d`
  (`internal/clock/clock_test.go`).
- **A product call that blocks until its context is done** gets
  `await.Context(t)`: done at the hang guard, never sooner.
- **`testing/synctest`** runs a test in a bubble whose clock is fake and
  advances only when every goroutine in it is blocked. Use it where nothing does
  real I/O (a real socket is outside the bubble). It is in the standard library
  from Go 1.25. No test here uses it yet; the guard allows the `time` package in
  a file that does.
- **Listen on `127.0.0.1:0`** and read the port from the listener, as
  `iothubtest.NewBroker` does.
- **Run with `-race`.** Every Go suite in test-repeat does.

### Jest / TypeScript

- **Fake timers.** `jest.useFakeTimers({ now })`, then `setSystemTime` and
  `advanceTimersByTime` (or `advanceTimersByTimeAsync`), and
  `jest.useRealTimers()` in `afterEach`. `apps/web/src/live/live-panel.spec.tsx`
  starts every test at a fixed `T0` and advances it by hand:

  ```ts
  function fakeTimers() {
    jest.useFakeTimers({ now: T0 });
  }
  afterEach(() => jest.useRealTimers());
  // ...
  act(() => jest.advanceTimersByTime(29_000));
  ```

  A test that is not about time but renders a timestamp can fake only `Date`
  (`stopTheClock()` in the same file, with `doNotFake` for the timers).

- **Inject `now`.** `UsersRepository` (`apps/api/src/shared/cosmos/users-repository.ts`)
  takes `now: () => Date`; `apps/api/src/functions/users/users.spec.ts` passes
  `() => new Date(NOW)` and asserts that a new profile's `createdAt` is exactly
  `NOW`.
- **React Testing Library's `findBy*` and `waitFor`** poll until their
  condition holds, bounded only by the runner: in `apps/web`, `testTimeout` is
  30 s (`jest.config.ts`) and `asyncUtilTimeout` 25 s (`src/test/setup.ts`), so a
  wait that can never succeed still fails with RTL's own message. Never pass a
  `timeout` option.
- **A fake clock for code that sleeps.** The API acceptance self-test
  (`apps/api/acceptance/acceptance-runner.spec.ts`) replaces the live suite's
  clock with `FakeClock`: `sleep(ms)` resolves when the test advances the clock,
  and `sleepUntilWoken` (`lib/clock.ts`) returns at the wake event or at the
  fake deadline, whichever the test makes happen first.
- **A no-deadline readiness poll on a specific condition.**
  `awaitReadable` in `apps/api/src/shared/cosmos/emulator-tier.testing.ts`
  re-reads a Cosmos container until it answers, looping only on the emulator's
  "create in progress" answer (404/1013) and yielding one turn of the event
  loop (`setImmediate`) between reads. Any other error fails at once. There is
  no deadline; Jest's `testTimeout` is the hang guard, and it reports the
  pending wait by name.
- **Hang guards go in the runner config**, not in a test: `testTimeout` in the
  project's `jest.config.ts` (`libs/api-specs` sets 90 s for its codegen
  `beforeAll`), never `jest.setTimeout` or a third argument to `it`.

### Playwright

- **Auto-waiting locators and `expect`.** `await expect(locator).toBeVisible()`
  waits for the condition; never `page.waitForTimeout`, and never a `timeout`
  option on an action or an `expect` (the hang guard is `playwright.config.ts`).
- **Freeze the browser's clock.** `freezeClock(page)` in
  `apps/web-e2e/src/fakes/clock.ts` calls `page.clock.setFixedTime`, so the
  page's `Date.now()` and `new Date()` are a fixed instant; `frozenIso(offset)`
  builds the timestamps the fake API sends. `page.clock.install` gives fake
  timers too.
- **A port per copy.** The config serves the build on `WEB_E2E_PORT`
  (4300 when unset, `--strictPort`); test-repeat gives each concurrent copy its
  own, 4300 + its copy number.

### Shell

- **Wait on the child's own signal, then on the child.** Have the child write
  a readiness line to a FIFO or a socket once it is ready, `read` it (no `-t`),
  act, then `wait $pid`. The iot-fixture SIGKILL test (HAR-112,
  `send-fixture.test.mjs`, "realSpawn enforces a HARD timeout") is the pattern:
  the child connects back, installs its SIGTERM trap, then writes `ready`, so
  "ready" means "a SIGTERM now is ignored", and the test never guesses how long
  that takes.
- **No `producer | grep -q` under pipefail.** `grep -q` exits at its first
  match; the producer's next write gets SIGPIPE, and pipefail turns the match
  into a failure, depending on scheduling. Use a here-string
  (`grep -q 'x' <<<"$out"`), a file argument, or the suites' `matches()` helper
  (`matches() { grep "$@" >/dev/null; }` in `bootstrap.test.sh`), which reads
  all of its input (HAR-121, HAR-125).
- **Scrub inherited environment.** A fixture that depends on a variable being
  unset unsets it (`run-destroy-guard-fixtures.sh` unsets
  `TF_DESTROY_GUARD_AUTHORIZED_CHANGES` per case); test-repeat runs each suite
  with only an allowlisted environment.

## The live suites are the exception

The live acceptance suite and the live browser proof wait on a real cloud by
design, and are out of the guard's scope by path. Every real-time wait they
make has a row in [Live Acceptance → Real-time waits](live-acceptance.md#real-time-waits)
with its bound and why, and a timeout message that names what it waited for. A
new live wait needs a new row.

## How to prove a test

- **The 20-run rule.** Run each test file you added or changed 20 times in a
  row (5 if one run takes over a minute), with `-race` for Go. One failure in
  20 is a bug: find the cause. Raising a timeout or adding a retry is not a fix.
- **test-repeat.** Every non-live suite is registered in
  `tools/test-repeat/suites.mjs`:

  ```sh
  node tools/test-repeat/test-repeat.mjs run <suite> --runs 50
  node tools/test-repeat/test-repeat.mjs run <suite> --runs 1 --parallel 8
  ```

  On a pull request, `.github/workflows/test-repeat.yml` runs every suite whose
  paths the change touches 50 times. The label `test-repeat:load` adds a pass
  with 8 copies at once; `test-repeat:all` runs every suite 50 times. See
  [tools/test-repeat/README.md](../../tools/test-repeat/README.md).

## The guard

```sh
node tools/no-real-time/check.mjs
```

It scans every tracked test file and test-only helper (not only a diff) and
prints `file:line: <rule id>: <what it found> — <how to fix>` for each real
sleep or real-time wait that no exception covers, and exits non-zero. The rules,
their ids and the exact scope are in
[tools/no-real-time/README.md](../../tools/no-real-time/README.md).

CI runs it on every pull request and every push to `main`, as the
`no-real-time-guard` job in `.github/workflows/ci.yml` (HAR-128); a failure
lists each hit in the run summary. See [CI/CD](ci-cd.md#quality-jobs).

**Adding an exception.** Fix the test first if you can. If a wait truly cannot
be an event, a fake clock or a no-deadline poll, add an entry to
`tools/no-real-time/exceptions.json`, `{ path, rule, line | pattern, reason }`,
in the same pull request, and say why in its description. The reason is
reviewed like code. An entry that matches nothing fails the check, so delete it
when its hit goes away. The list stays short (about 15 at most); past that, the
rule needs refining, not more exceptions.

**What it cannot catch.** It reads text in test files, so it does not see:

- waits inside product code a test calls (inject the clock instead);
- aliases such as `const wait = setTimeout`, or a sleeping helper imported from
  outside its scope;
- a member call on a real timer object (`foo.setTimeout(…)`): member calls are
  taken to be an injected clock;
- whether a call runs before fake timers (or a synctest bubble) are installed:
  that allowance is per file;
- real network or child-process latency a test depends on without a timer;
- goroutine or event-loop ordering assumptions;
- the caller's environment (`TZ`, locale, a stray variable);
- generated or dynamically built code (`eval`, source assembled at run time);
- anything not visible as text in a test file: runner flags, configs, helpers
  outside its scope globs, a new test file naming convention;
- `pipefail` inherited from a sourced file, and quoting that spans lines in
  shell.
