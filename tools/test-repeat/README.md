# test-repeat

Runs a test suite N times in a row and reports how many runs passed. Goal
HAR-106 (every test in MeatGeek is deterministic) uses it as evidence: a suite
counts as fixed when it passes 50 runs in a row in CI, plus one run under load.

Node built-ins only. Nothing to install for the harness itself; each suite
needs whatever its own runner needs (`npm ci`, Go, Terraform, Chromium, the
Cosmos emulator).

## Files

| File                                      | What it is                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `suites.mjs`                              | The registry: every non-live suite, its command for one run, its affected paths, what it needs.          |
| `test-repeat.mjs`                         | The CLI (`list`, `run`, `select`, `summary`).                                                            |
| `lib.mjs`                                 | Selection, shard arithmetic, the repeat loop, the summary table.                                         |
| `terraform-tests.sh`                      | The `terraform-tests` suite: backend-less init once, then `terraform test` in every test-bearing module. |
| `run-tests.mjs`                           | Runs the harness's own tests (`test/*.test.mjs`) with file and test-count floors.                        |
| `test/env-scan.mjs`                       | The static scans behind the registry test's environment checks (see Environment).                        |
| `../../.github/workflows/test-repeat.yml` | The pull-request workflow.                                                                               |

## Running a suite locally

```sh
node tools/test-repeat/test-repeat.mjs list
node tools/test-repeat/test-repeat.mjs run go-data-pusher --runs 50
node tools/test-repeat/test-repeat.mjs run api --runs 50 --shard 2/4     # runs 14-26 of 50
node tools/test-repeat/test-repeat.mjs run web-e2e --runs 1 --parallel 8 # 8 copies at once
```

Every run executes for real: commands call jest, `go test -count=1`,
playwright, node or bash directly, never an Nx target, so nothing is a cache
hit. Preparation (generated OpenAPI types for `web`, `nx build web` for the
Playwright suite, `terraform init`) runs once before the loop; `--skip-prepare`
skips it.

The loop stops at the first failing run and prints:

```
go-data-pusher: 2/50 passed, failed on run 3
----- go-data-pusher: output tail of failing run 3 (last 80 lines; full log …) -----
```

A passing run's log is deleted; a failing run's full log is kept in
`--log-dir` (default `$TMPDIR/test-repeat-logs`), named
`<suite>-<pass>-<id>-copy<c>-run<n>.log`: `<pass>` is `repeat` or `load`
(`--kind`), and `<id>` is 8 random hex characters chosen per invocation so that
no file in the directory already starts with that prefix. A later invocation
into the same directory (the load pass after the serial pass, a re-run) never
reuses a name, so it never deletes or overwrites an earlier failure's log, and
the `full log …` path in the output-tail header still exists when the job
ends. No clock is involved in the name. Each run has a hang guard
(`timeoutSec` in the registry, `--run-timeout` to override) far above a normal
run: a run that exceeds it is killed with everything it started and counts as
failed.

Exit codes: 0 every run passed, 1 a run failed, 2 a usage or prepare error.
`--result file.json` writes the machine-readable result the workflow uses.

### Environment

A run does not inherit the caller's environment. It gets exactly:

1. the variables in `ENV_ALLOWLIST` (`lib.mjs`) that the caller has set:
   `PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`, `SHELL`, `CI`, `GITHUB_*`,
   `RUNNER_*`, `GO*`, `NODE_OPTIONS`, `npm_config_*`, `COREPACK_*`, `NX_*`, and
   on Windows `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `PATHEXT`,
   `USERPROFILE`, `USERNAME`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`,
   `LOCALAPPDATA`, `ProgramData`, `ProgramFiles*`, `NUMBER_OF_PROCESSORS`,
   `PROCESSOR_ARCHITECTURE` (a trailing `*` is a prefix; on Windows names
   match case-insensitively);
2. the suite's `passEnv`: further names to pass through from the caller, when
   set (`api-emulator` passes `NODE_EXTRA_CA_CERTS`, the emulator's
   certificate, which the workflow writes to `GITHUB_ENV`);
3. the suite's `env`, which wins over both;
4. its own `TMPDIR`, `TMP` and `TEMP` (each parallel copy its own).

Anything else the caller has set is dropped: a `TF_DESTROY_GUARD_*` exported in
a shell, an `AZURE_*` credential, a `TZ`, the workflow step's own `SUITE` and
`RUNS`. A suite's prepare steps get the same, except that they keep the
caller's temp dir variables. Every suite that runs Terraform sets
`CHECKPOINT_DISABLE=1`, so no run calls HashiCorp's version check;
`terraform-tests.sh` sets it itself too, and shortens a `TMPDIR` over 60
characters to a fresh `mktemp -d /tmp/tf.XXXXXX` (removed on exit), by the same
rule the harness uses, so running it directly behaves the same.

`test/registry.test.mjs` checks, statically, that nothing a suite needs is
dropped:

- every variable `test-repeat.yml` puts into the environment of a step that
  runs the harness (workflow `env:`, the job's step `env:` blocks, writes to
  `$GITHUB_ENV`) is allowlisted, in the `passEnv` of every suite that job runs,
  used only on the step's own command line (`--runs "$RUNS"`), or used only in
  `${{ env.NAME }}` expressions;
- every variable a suite's code reads by name with no fallback is allowlisted,
  in its `passEnv` or `env`, written by the suite's own code, or listed in
  `droppedEnv` (`suites.mjs`) with the reason. The scan covers each suite's
  `paths` directories and the files its commands name: `process.env.NAME` and
  `process.env['NAME']` without `??`/`||` after them, `os.Getenv("NAME")` and
  `os.LookupEnv("NAME")`, and shell `$NAME`, `${NAME}`, `${NAME:?}` of a name no
  scanned shell file assigns. A read with a fallback (`?? 'x'`, `${NAME:-x}`)
  is optional: dropping it can only remove a caller's override.

The limit: a static scan cannot see a name computed at run time
(`process.env[key]`, `os.Getenv(EnvConst)`), a variable a tool reads itself
(`NODE_EXTRA_CA_CERTS`, `TF_*`, `GOFLAGS`, `PLAYWRIGHT_*`), or what the runner
image sets that the allowlist does not cover. The proof for those is a harness
change's CI run, which runs every suite once in CI's own environment.

### `--parallel K` (load)

K copies of the suite run at once, each with its own temp dir (`TMPDIR`, `TMP`,
`TEMP`), each doing its own runs and stopping at its own first failure; each
copy is reported on its own line. The working tree is shared. A suite whose
`maxParallel` is lower is capped and the summary says why:
`playwright-web-e2e` serves on the fixed port 4300, so it cannot run two copies.

A suite's `loadArgs` are appended to its command in every copy when it runs as
more than one copy, never in the serial pass; the log and the summary row name
them. Every Jest suite runs its load copies with `--maxWorkers=1`: a Jest
starts (cores - 1) workers, one `api` run with 3 workers peaks at 2.5 GB, and 8
such copies exhausted the 16 GB runner, which GitHub then shut down (exit 143).
With one worker a run peaks at 742 MB (HAR-113).

### `--shard i/S`

Shard i of S gets a contiguous block of the N run numbers, so a failure is
reported by its global run number. Shard counts come from the first CI run's
per-run times, to keep a job near 20 minutes at N = 50: `api` 3 (68.4 s a run,
1019 tests), `api-interfaces` 2 (44.4 s), `terraform-tests` 3 (70.7 s).
Re-measure and adjust `shards` in `suites.mjs` if a job grows past 25 minutes.

## In CI: `.github/workflows/test-repeat.yml`

On every pull request to `main` (opened, synchronize, reopened, labeled):

1. `select` runs the harness self-tests, then maps
   `git diff --name-only <base>...HEAD` onto the registry's `paths` globs.
2. One matrix job per selected suite (and shard) runs it with N = 50. The Cosmos
   emulator suite has its own job on `windows-2025`, with the same pinned
   emulator and start script (`.github/scripts/cosmos-emulator.ps1`) as
   `ci.yml`'s `api-cosmos-emulator`.
3. `summary` totals the shards into one table in the job summary — suite,
   affected?, runs requested, runs passed, first failing run, duration — with a
   row for every suite (an unaffected one says "not affected"). It fails if any
   selected pass failed or reported nothing.

What is selected:

| Pull request                                   | Suites                                               | Runs       |
| ---------------------------------------------- | ---------------------------------------------------- | ---------- |
| changes files a suite's `paths` match          | those suites                                         | 50         |
| changes `tools/test-repeat/**` or the workflow | every suite                                          | 1          |
|                                                | except `test-repeat-harness` (the harness's tests)   | 50         |
| has label `test-repeat:all`                    | every suite                                          | 50         |
| has label `test-repeat:load`                   | adds one pass per selected suite with `--parallel 8` | 1 per copy |

A harness change wins over an app change: such a pull request runs every suite
once, proving each command still works without putting suites that are not
fixed yet through 50 runs. Keep harness changes out of fix pull requests, or add
`test-repeat:all`. The exception is the harness's own tests, the
`test-repeat-harness` suite (`selfTest: true`): a harness change is exactly
what they test, so it runs them the full 50 times (and, with
`test-repeat:load`, 8 copies at once).

The workflow holds no secret, no environment and no OIDC permission, so it runs
on fork pull requests.

## Adding a suite

Add an entry to `suites.mjs`. `test/registry.test.mjs` fails when a jest config
under `apps/` or `libs/`, or an `apps/infrastructure/scripts/fixtures/run-*.sh`,
has no entry, and when the suite's code reads a variable it would not get (see
Environment): list it in `passEnv` if a run needs it from the caller. The live suites (`api:acceptance`, `web-e2e:e2e-live`) are out of
scope and must stay out.

## Self-tests

```sh
node tools/test-repeat/run-tests.mjs
```

The workflow's `select` job runs them once before anything else; the
`test-repeat-harness` suite runs them 50 times on every harness change. They
wait on no clock: each test runs the CLI to completion and asserts on what it
printed and wrote, and no fixture run has a hang guard, so how fast a child
process starts cannot decide a result. The suite's `timeoutSec` is the one hang
guard.
