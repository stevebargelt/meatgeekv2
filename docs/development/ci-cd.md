# CI/CD Pipeline

MeatGeek V2 runs continuous integration through `.github/workflows/ci.yml`, and deploys through separate workflows. Dev deployment still lives in `ci.yml` (the `deploy-dev` job on `develop`); production deployment is split into two standalone workflows — `.github/workflows/infra-deploy-prod.yml` and `.github/workflows/app-deploy-prod.yml`. This document describes the CI jobs that run, why the TypeScript build matrix is scoped the way it is, how prod deploys work, the branch-protection rules on `main`, and the npm/lockfile constraint the runners depend on.

## Triggers

The pipeline runs on:

- **push** to `main` or `develop`
- **pull_request** targeting `main` or `develop`

Environment defaults used across jobs: Node.js `20`, Go `1.21`.

## Quality Jobs

These jobs run on every push and pull request and gate merges into `main` (see [Branch Protection](#branch-protection)).

| Job | What it does | Matrix |
|-----|--------------|--------|
| `setup` | Installs dependencies with `npm ci` and computes affected apps/libs via `npx nx show projects --affected` | — |
| `lint-and-test` | Runs `nx lint <project>` and `nx test <project> --coverage`, then uploads coverage to Codecov | `api`, `web`, `mobile`, `api-interfaces` |
| `build-typescript` | Runs `nx build <app>` and uploads the `dist/apps/<app>` artifact | `api`, `web` |
| `build-go` | Runs `make build`, `make test`, and `make build-arm` for each Go app | `device-controller`, `data-pusher` |
| `validate-infrastructure` | `terraform fmt -check`, `terraform init -backend=false`, and `terraform validate` against `apps/infrastructure` | — |
| `security-scan` | `npm audit --audit-level=moderate` and a Snyk scan (both `continue-on-error`) | — |

### Why the TypeScript build matrix is `api` + `web` only

`build-typescript` compiles only the apps that NX builds with `@nx/js:tsc`/bundlers — `api` (Azure Functions) and `web` (React/Vite). `mobile` is a React Native app; it is not `tsc`-built in CI, so it is intentionally **absent** from the `build-typescript` matrix. `mobile` is still linted and tested (it appears in the `lint-and-test` matrix); it is simply not compiled here.

Adding a new buildable TypeScript app? Add it to the `build-typescript` matrix. A new React Native target does **not** belong there — keep it in `lint-and-test` only.

## Deployment

Deployment is **not** part of branch protection — it runs after a merge lands on the target branch, so it can never be a merge gate.

### Dev

The `deploy-dev` job lives in `ci.yml`. It runs on push to `develop`, after `lint-and-test`, `build-typescript`, `build-go`, and `validate-infrastructure`, under the `development` GitHub Environment.

It is **plan-only** — it runs `terraform init -backend=false` and `terraform plan -var-file=environments/dev.tfvars` and stops. It does **not** apply infrastructure and does **not** deploy the Functions API or the web app. Against the greenfield V2 stack, a CI apply against empty, ephemeral local state would try to *create* all dev infrastructure inside CI; per the MG-24 hard-safety rule the live greenfield dev plan/apply is the operator's out-of-pipeline acceptance step (see the [bootstrap runbook](../infrastructure/bootstrap-runbook.md)), and app/web deploys are owned by the dedicated deploy workflows.

Authentication is **per-environment OIDC**, not the retired long-lived `AZURE_CREDENTIALS` service-principal secret. The job declares `permissions: id-token: write` and authenticates with `azure/login@v2` using the GitHub-Environment-scoped federated credential (subject `environment:development`) and the `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` **Environment variables**. Because those variables are bound to `development`, they resolve to a *separate* federated identity from prod's `environment:production` — the dev CI identity can never authenticate to prod, and no long-lived secret is stored.

### Prod

Production deployment is **not** in `ci.yml`. It lives in two standalone workflows so infrastructure and the app can be deployed independently:

| Workflow | Triggers | What it deploys |
|----------|----------|-----------------|
| `infra-deploy-prod.yml` | `workflow_dispatch` only (manual / recovery) | Terraform infrastructure — **plan-only** (`terraform init` binding the prod remote backend + `terraform plan`, **no `apply`**); apply is the operator's out-of-band step |
| `app-deploy-prod.yml` | `workflow_run` — after the **CI/CD Pipeline** workflow completes (no push trigger, no `workflow_dispatch`) | Functions API only, via `nx deploy api --env=prod` |

Prod is **API-only** — there is no prod web / Static Web Apps deploy; the web app is deployed to dev only.

#### App deploy: CI-gated via `workflow_run`

`app-deploy-prod.yml` does **not** trigger on push. It runs on `workflow_run` when the **CI/CD Pipeline** workflow (`ci.yml`) *completes*, and only deploys when **all** of the following hold on the triggering CI run:

- `conclusion == 'success'` — CI was green
- `event == 'push'` — it was a push, not a pull request
- `head_branch == 'main'` — the push targeted `main`
- `vars.PROD_DEPLOY_ENABLED == 'true'` — the operator switch (a **repository variable**, not a secret) is flipped on

This means prod app deploys only ever happen **after green CI on a push to `main`**, and never for a PR, a `develop` push, or a red build. `PROD_DEPLOY_ENABLED` is the master on/off switch: leave it unset (or anything other than `'true'`) to keep prod deploys dark; set it to `'true'` when you want green pushes to `main` to ship.

**Stale-SHA guard.** The deploy job checks out the exact commit CI ran against (`github.event.workflow_run.head_sha`), but first compares that SHA to the current `main` tip. If `main` has already advanced past the CI'd commit, the job **skips cleanly (green, not a failure)** — it never deploys a commit that is no longer the head of `main`. When several pushes land in quick succession, only the run whose commit is still the tip deploys.

**Retrying a failed deploy.** There is **no `workflow_dispatch`** on the app deploy. To retry, use GitHub's **re-run** on the relevant Actions run (the CI/CD Pipeline run, or the deploy run itself) — there is no manual trigger to invoke by hand.

**Build and package check.** The job builds its own artifact (`corepack enable` → `npm ci` → `nx build api`); there is no artifact sharing between workflows. Before publishing it runs `node apps/api/tools/verify-func-package.js dist/apps/api`, which validates that the build is a well-formed Azure Functions (Node v4) package — `host.json` and `package.json` present and correct at the package root. Azure Functions Core Tools is pinned via `FUNC_CORE_TOOLS_VERSION` (currently `4.12.1`) so the publish toolchain does not drift.

#### Infra deploy: plan-only, manual

`infra-deploy-prod.yml` is **`workflow_dispatch`-only** and **plan-only** — it binds the per-environment `azurerm` remote backend (`terraform init -reconfigure -backend-config=environments/backend-prod.hcl`, prod's isolated state key `meatgeek-v2/prod.tfstate`) and runs `terraform plan -var-file=environments/prod.tfvars -out=tfplan`, but **does not `apply`**. Auto-apply-on-merge (a push trigger on `apps/infrastructure/**`) and the `apply` step itself stay deferred by design: even with the remote backend now shipped, an auto-apply against greenfield V2 state would try to create all prod infrastructure in CI. The live greenfield prod plan+apply is the operator's out-of-band acceptance step (MG-24), so infra prod runs are dispatched by hand and stop at the plan.

**Credentials and environment.** Both prod workflows authenticate via **per-environment OIDC** — `azure/login@v2` with the GitHub-Environment-scoped federated credential (subject `environment:production`), **not** the retired long-lived `AZURE_CREDENTIALS_PROD` service-principal secret. Each declares `permissions: id-token: write` so `azure/login` can mint a short-lived OIDC token, and reads the `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` **`production` Environment variables** (with `ARM_SUBSCRIPTION_ID` sourced from `AZURE_SUBSCRIPTION_ID` for Terraform). These variables only resolve for jobs that declare `environment: production` — in `app-deploy-prod.yml` that is the deploy job; in `infra-deploy-prod.yml` both the `guard` and `deploy-infra` jobs. Both workflows set `concurrency` to not cancel in-progress runs. The infra workflow's `guard` job checks that the three OIDC Environment variables are set and skips cleanly (green) if any is absent. The app workflow has no such guard — it is gated by `PROD_DEPLOY_ENABLED`. There are no long-lived deploy secrets to commit.

## Branch Protection

`main` is protected. Merges require the following quality jobs to pass:

- `setup`
- `lint-and-test`
- `build-typescript`
- `build-go`
- `validate-infrastructure`
- `security-scan`

Deployment is **excluded** from the required checks — the `deploy-dev` job runs after a merge lands on the target branch, and the standalone prod deploy workflows run *after* CI (`app-deploy-prod.yml` is triggered by CI completing; `infra-deploy-prod.yml` is manual), so neither can be a merge gate.

Branch protection is configured on the GitHub repository (Settings → Branches), not in a tracked file. When you add or rename a required job in `ci.yml`, update the required-status-check list to match, or the new job will run without gating merges.

## npm and the Lockfile

`package.json` pins the toolchain via `"packageManager": "npm@10.9.8"`, and CI activates it with a `corepack enable` step before `npm ci` in every dependency-installing job (`setup`, `lint-and-test`, `build-typescript`, `security-scan`). Corepack reads the `packageManager` field and provisions npm 10.9.8 automatically, so both the runners and local contributors resolve dependencies with the same pinned npm. (`engines.npm` remains `>=10.0.0` as a floor.)

Why npm 10 rather than 11: npm 11 (the default in some local/container environments) omits the nested optional-peer entries (for example `babel-plugin-macros`, `cosmiconfig`, `yaml`) that npm 10 expects. A lockfile written by npm 11 therefore fails `npm ci` on the runners with a sync error. The npm-10 lockfile is a compatible superset, so it works under both.

With the pin in place, no manual workaround is needed. Run `corepack enable` once in your clone (see [Local Setup](local-setup.md)) and any `npm install` that touches dependencies will regenerate `package-lock.json` under npm 10.9.8 automatically.

## Related

- [NX Commands](nx-commands.md) — lint, test, and build commands used by these jobs
- [Local Setup](local-setup.md) — getting a workspace building locally, including the buildable-library and per-project ESLint requirements
- [Monorepo Structure](../architecture/monorepo-structure.md) — how libraries, aliases, and build boundaries fit together
