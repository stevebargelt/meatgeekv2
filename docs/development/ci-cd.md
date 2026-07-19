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

The `deploy-dev` job lives in `ci.yml`. It runs on push to `develop`, after `lint-and-test`, `build-typescript`, `build-go`, and `validate-infrastructure`, and deploys Terraform infrastructure, the Functions API, and the web app (Azure Static Web Apps) using the `AZURE_CREDENTIALS` secret and the `development` environment.

### Prod

Production deployment is **not** in `ci.yml`. It lives in two standalone workflows so infrastructure and the app can be deployed independently:

| Workflow | Triggers | What it deploys |
|----------|----------|-----------------|
| `infra-deploy-prod.yml` | `workflow_dispatch` only (manual / recovery) | Terraform infrastructure (`terraform apply` against `apps/infrastructure`) |
| `app-deploy-prod.yml` | push to `main` scoped to `apps/api/**` and `libs/**`, plus `workflow_dispatch` | Functions API only, via `nx deploy api --env=prod` |

Prod is **API-only** — there is no prod web / Static Web Apps deploy; the web app is deployed to dev only.

`app-deploy-prod.yml` builds its own artifact (`corepack enable` → `npm ci` → `nx build api`); there is no artifact sharing between workflows.

**Infra is manual-only for now.** Auto-apply-on-merge (a push trigger on `apps/infrastructure/**`) is intentionally deferred to MG-24 until Terraform has an `azurerm` remote state backend. With today's local-state posture, a path-triggered apply would plan against empty state and try to recreate all prod infrastructure, so infra prod deploys are run by hand via `workflow_dispatch`.

**Credentials and environment.** Both prod workflows require the `AZURE_CREDENTIALS_PROD` repository secret and target the reviewer-less `production` environment, with `concurrency` set to not cancel in-progress runs. Each workflow's `guard` job checks for `AZURE_CREDENTIALS_PROD`: if the secret is absent, the deploy job **skips cleanly (green)** rather than failing — so a push to `main` is never red just because prod credentials are not set. Deploy credentials come from repository secrets and are never committed.

## Branch Protection

`main` is protected. Merges require the following quality jobs to pass:

- `setup`
- `lint-and-test`
- `build-typescript`
- `build-go`
- `validate-infrastructure`
- `security-scan`

Deployment is **excluded** from the required checks — the `deploy-dev` job and the standalone prod deploy workflows (`infra-deploy-prod.yml`, `app-deploy-prod.yml`) run after a merge lands on the target branch, so they cannot be a merge gate.

Branch protection is configured on the GitHub repository (Settings → Branches), not in a tracked file. When you add or rename a required job in `ci.yml`, update the required-status-check list to match, or the new job will run without gating merges.

## npm and the Lockfile

`package.json` pins the toolchain via `"packageManager": "npm@10.9.8"`, and CI activates it with a `corepack enable` step before `npm ci` in every dependency-installing job (`setup`, `lint-and-test`, `build-typescript`, `security-scan`). Corepack reads the `packageManager` field and provisions npm 10.9.8 automatically, so both the runners and local contributors resolve dependencies with the same pinned npm. (`engines.npm` remains `>=10.0.0` as a floor.)

Why npm 10 rather than 11: npm 11 (the default in some local/container environments) omits the nested optional-peer entries (for example `babel-plugin-macros`, `cosmiconfig`, `yaml`) that npm 10 expects. A lockfile written by npm 11 therefore fails `npm ci` on the runners with a sync error. The npm-10 lockfile is a compatible superset, so it works under both.

With the pin in place, no manual workaround is needed. Run `corepack enable` once in your clone (see [Local Setup](local-setup.md)) and any `npm install` that touches dependencies will regenerate `package-lock.json` under npm 10.9.8 automatically.

## Related

- [NX Commands](nx-commands.md) — lint, test, and build commands used by these jobs
- [Local Setup](local-setup.md) — getting a workspace building locally, including the buildable-library and per-project ESLint requirements
- [Monorepo Structure](../architecture/monorepo-structure.md) — how libraries, aliases, and build boundaries fit together
