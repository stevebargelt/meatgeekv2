# MeatGeek V2: guide for engineers and agents

MeatGeek V2 monitors BBQ temperatures and manages cooks. A device (a Raspberry Pi, or `simdevice` in dev) sends
readings to Azure IoT Hub; an Azure Functions API stores them in Cosmos DB and pushes them over SignalR to a React web
app and a native iOS app. Azure is managed with Terraform: dev is live and applied by CI; prod is API-only and its
deploy is switched off.

## Layout

An Nx 19 monorepo with npm workspaces (`apps/*`, `libs/*`). CI uses Node 24. `package.json` pins npm 10.9.8 in
`packageManager`; `corepack npm <args>` runs that version (plain `corepack enable` does not shim npm).

| Path | What it is | Toolchain |
|---|---|---|
| `apps/api` | Azure Functions API (Node v4 programming model) | TypeScript, webpack, Jest |
| `apps/web` | Web client; Vercel builds and serves it | React 18, Vite, Jest |
| `apps/web-e2e` | Browser tests of `web`: offline main path (`src/`) and the live proof (`live/`) | Playwright; Jest for helpers |
| `apps/ios` | Native iPhone client. Not an Nx project | Swift, Xcode 26, SwiftPM |
| `apps/data-pusher` | Device service that sends readings to IoT Hub; `cmd/simdevice` is the dev device | Go, Make |
| `apps/device-controller` | Raspberry Pi temperature controller | Go, Make |
| `apps/infrastructure` | Terraform root and `modules/`, bootstrap, deploy-gate scripts and their fixtures | Terraform ~1.9, bash, Node |
| `libs/api-specs` | OpenAPI 3.0 contract: the only thing API, web and iOS share | YAML, TypeScript |
| `libs/api-interfaces` | Shared TypeScript types (`@meatgeekv2/api-interfaces`) | TypeScript |
| `libs/data-models`, `libs/utils` | Cook and temperature domain logic; date utilities | TypeScript |
| `docs/architecture/likec4` | Architecture model; its own npm package, outside the workspaces | LikeC4 |
| `tools/no-real-time`, `tools/test-repeat` | Guard against real time in tests; runner that repeats suites | Node |

## Commands

Run from the repository root. Install: `corepack npm ci`.

TypeScript projects (`api`, `web`, `web-e2e`, `api-interfaces`, `api-specs`, `data-models`, `utils`). CI's
`lint-and-test` job runs these two per project; the third line runs them for all seven:

```sh
npx nx lint <project>
npx nx test <project> --coverage
npx nx run-many -t lint test -p api web web-e2e api-interfaces api-specs data-models utils
```

- Build: `npx nx build api` and `npx nx build web` (CI's `build-typescript` job builds these two).
- Type-check: `npx nx typecheck web` and `npx nx typecheck web-e2e`. `web:build` and `web:test` depend on
  `web:typecheck`. The other projects have no `typecheck` target; their build and ts-jest catch type errors.
- One test file: `npx nx test api --testFile=apps/api/src/functions/health/cosmos-health.spec.ts`.
- Browser tests (CI's `web-e2e` job): `npx playwright install chromium`, then `npx nx e2e web-e2e`.
- Needs a Cosmos DB emulator: `npx nx run api:test-emulator` runs the `*.emulator.spec.ts` files against
  `COSMOS_EMULATOR_ENDPOINT`. CI runs it on `windows-2025`; see [the emulator tier](docs/development/ci-cd.md#cosmos-emulator-tier-har-12).
- Needs the live dev deployment and the acceptance identity, so it runs only in Deploy Dev App:
  `npx nx run api:acceptance` and `npx nx e2e-live web-e2e`. See [live acceptance](docs/development/live-acceptance.md).

Go (CI's `build-go` job; CI does not lint Go). `make test` is `go test -race`, plus `-tags testserver` in device-controller:

```sh
cd apps/data-pusher && make build && make test && make build-arm
cd apps/device-controller && make build && make test && make build-arm   # make build needs Linux (go-gpiocdev)
cd apps/data-pusher && go test -race -run TestClaimCode_Pusher ./cmd/   # one test
```

Terraform (CI's `validate-infrastructure` job; no Azure credential, no remote state):

```sh
cd apps/infrastructure
terraform fmt -check -recursive
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
terraform test
bash scripts/tf-static-checks.sh
terraform -chdir=modules/cosmos-db init -backend=false -input=false -lockfile=readonly   # one module
terraform -chdir=modules/cosmos-db test
```

The job also runs each tested module, the bootstrap tests and the gate fixtures: `node tools/test-repeat/test-repeat.mjs
list` prints each with its command. The `infrastructure` Nx targets `init`, `plan`, `apply`, `destroy` use real state.

iOS (needs a Mac with Xcode 26 and an iPhone 17 simulator; the `ios` workflow, `ios.yml`, runs on `macos-26` only when
a pull request or push touches `apps/ios/**` or `libs/api-specs/spec/**`):

```sh
xcodebuild test -project apps/ios/MeatGeek.xcodeproj -scheme MeatGeek \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=latest' -skipPackagePluginValidation
```

Add `-only-testing:MeatGeekKitTests` for one target. CI also fails if a test target it ran ran zero tests. On a pull
request it skips `MeatGeekUITests` (`-skip-testing:MeatGeekUITests`); a push to `main` runs them.

Other CI checks (`test-repeat.yml` runs, nightly on `main`, each suite changed since its last run 50 times; the last line
is that, locally):

```sh
node tools/no-real-time/check.mjs                      # no-real-time-guard job
npm ci --prefix docs/architecture/likec4 && npm --prefix docs/architecture/likec4 run check   # architecture-model
node tools/test-repeat/test-repeat.mjs run utils --runs 20
```

## Conventions

- Commit subject: `type(scope): <what changed>`, e.g. `fix(ios): sign-in always uses the system browser`. Types in
  use: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`. The squash merge appends `(#<pr>)`. A pull request that
  finishes a GitHub issue says `Closes #<n>` in its body. Older subjects carry `HAR-<n>` or `MG-<n>`: ids from
  trackers this repository no longer uses.
- Where tests live: `*.spec.ts` next to the source; `*.emulator.spec.ts` only for the emulator tier (excluded from
  `nx test api`); the live API suite in `apps/api/acceptance/`; the live browser proof in `apps/web-e2e/live/`; Go
  `*_test.go` next to the package; Terraform `*.tftest.hcl` under `tests/` of the root or a module (CI finds new ones
  on its own); iOS in the `apps/ios/MeatGeek*Tests` targets.
- No test depends on real time: `no-real-time-guard` fails on sleeps, real timeouts and wall-clock assertions.
  Exceptions: `tools/no-real-time/exceptions.json`. See [deterministic tests](docs/development/deterministic-tests.md).
- The API and the contract must agree. `apps/api/src/contract/contract.spec.ts` (in `nx test api`) fails when a route
  registered in `apps/api/src/main.ts` is missing from the spec or the reverse, when an operation lacks `bearerAuth`
  or a `401`, or when error codes or SignalR messages differ from the spec. See [api-specs](libs/api-specs/README.md).
- Generated files:
  - After any change under `libs/api-specs/spec/`, run `npx nx run api-specs:bundle-ios` and commit
    `apps/ios/MeatGeekKit/Sources/MeatGeekAPI/openapi.yaml`. `nx test api-specs` fails while it is stale.
  - `libs/api-specs/src/generated/` is not committed. `npx nx generate-types api-specs` writes it, and `web`'s
    build, lint, typecheck and test run it first.
- Lockfiles: write `package-lock.json` with the pinned npm (`corepack npm install ...`); see
  [npm and the lockfile](docs/development/ci-cd.md#npm-and-the-lockfile).
  Terraform providers are locked by committed `.terraform.lock.hcl` files (root and each tested module), and CI inits
  with `-lockfile=readonly`, so a provider change updates the lock file in the same pull request.
- Secrets never enter the repository. Local API settings go in the untracked `apps/api/local.settings.json` or in
  environment variables.
- Checks required to merge (branch protection on `main`): `setup`, `lint-and-test` for `api`, `web` and
  `api-interfaces`, both `build-typescript` and both `build-go` legs, `validate-infrastructure`, `security-scan`.
  Every other CI/CD Pipeline job, including the other `lint-and-test` legs and `web-e2e`, runs on each pull request
  without gating the merge; so does `ios.yml`, on the iOS paths only. `security-scan`'s `npm audit` and Snyk steps are `continue-on-error`; Snyk
  runs only on push to `main`, so `SNYK_TOKEN` never reaches a pull request run.

## What a merge to `main` starts

1. `ci.yml` (CI/CD Pipeline) runs on the push.
2. `architecture-site.yml` publishes the LikeC4 model to <https://stevebargelt.github.io/meatgeekv2/>.
3. `infra-apply-dev.yml`, once CI on that push is green: plans against dev state, refuses unauthorized destroys,
   applies to `meatgeek-v2-dev-rg`, then fails on drift.
4. `app-deploy-dev.yml`, after the apply: publishes the API to the dev Function App, then runs `api:acceptance` and
   the live browser proof against it.
5. `app-deploy-prod.yml`, after green CI: deploys the API to prod only when the repository variable
   `PROD_DEPLOY_ENABLED` is `true`. It is not set, so the job skips.
6. Vercel, outside GitHub Actions, builds `apps/web` from `vercel.json` for <https://meatgeekv2-web.vercel.app>.

Also on a merge that touches `apps/ios/**` or `libs/api-specs/spec/**`: `ios.yml` builds the iOS app and runs every
test target, the stub UI tests included. Nothing waits on it.

Not started by a merge: `infra-deploy-prod.yml` (manual, plan only), `ios-live-proof.yml` (daily at 09:17 UTC and on
demand), `test-repeat.yml` (nightly at 07:17 UTC on what changed since its last run, every suite on Sundays, and on
demand; a failing suite opens a `needs-triage` issue), `infra-dev-apply-watch.yml` (every 6 hours and on demand; goes
red when a green `main` SHA has been left unapplied to dev for over 2 hours; see [MG-38](docs/infrastructure/mg23-live-acceptance.md#mg-38--a-superseded-skip-behind-a-red-ci-stalls-reconciliation-silently)).

## Agent skills

### Issue tracker

GitHub Issues on `stevebargelt/meatgeekv2`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Deeper docs

- Development: [CI/CD](docs/development/ci-cd.md), [local setup](docs/development/local-setup.md),
  [Nx commands](docs/development/nx-commands.md), [live acceptance](docs/development/live-acceptance.md),
  [test repeat](tools/test-repeat/README.md), [no-real-time guard](tools/no-real-time/README.md)
- Architecture: [overview](docs/architecture/system-overview.md), [data flow](docs/architecture/data-flow.md),
  [diagrams](https://stevebargelt.github.io/meatgeekv2/) (from the `.c4` files in [the model](docs/architecture/likec4/README.md)),
  [monorepo](docs/architecture/monorepo-structure.md), [observability](docs/monitoring/observability.md)
- Projects: [iOS app](apps/ios/README.md), [data-pusher](apps/data-pusher/README.md), [API contract](libs/api-specs/README.md)
- Runbooks: [devices](docs/devices/runbook.md), [bootstrap](docs/infrastructure/bootstrap-runbook.md),
  [dev GitOps acceptance](docs/infrastructure/mg23-live-acceptance.md), [Terraform](docs/infrastructure/terraform-setup.md)
