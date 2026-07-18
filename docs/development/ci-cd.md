# CI/CD Pipeline

MeatGeek V2 runs its continuous integration and deployment through a single GitHub Actions workflow, `.github/workflows/ci.yml`. This document describes the jobs that run, why the TypeScript build matrix is scoped the way it is, the branch-protection rules on `main`, and the npm/lockfile constraint the runners depend on.

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

## Deployment Jobs

Deployment jobs run only after the quality jobs and only on the matching branch. They are **not** part of branch protection.

| Job | Runs when | Depends on |
|-----|-----------|------------|
| `deploy-dev` | push to `develop` | `lint-and-test`, `build-typescript`, `build-go`, `validate-infrastructure` |
| `deploy-prod` | push to `main` | `lint-and-test`, `build-typescript`, `build-go`, `validate-infrastructure` |

Both deploy Terraform infrastructure and then the API/web artifacts. Deploy credentials come from repository secrets and are never committed.

## Branch Protection

`main` is protected. Merges require the following quality jobs to pass:

- `setup`
- `lint-and-test`
- `build-typescript`
- `build-go`
- `validate-infrastructure`
- `security-scan`

The `deploy-dev` and `deploy-prod` jobs are **excluded** from the required checks — deployment runs after a merge lands on the target branch, so it cannot be a merge gate.

Branch protection is configured on the GitHub repository (Settings → Branches), not in a tracked file. When you add or rename a required job in `ci.yml`, update the required-status-check list to match, or the new job will run without gating merges.

## npm and the Lockfile

`package.json` pins the toolchain via `"packageManager": "npm@10.9.8"`, and CI activates it with a `corepack enable` step before `npm ci` in every dependency-installing job (`setup`, `lint-and-test`, `build-typescript`, `security-scan`). Corepack reads the `packageManager` field and provisions npm 10.9.8 automatically, so both the runners and local contributors resolve dependencies with the same pinned npm. (`engines.npm` remains `>=10.0.0` as a floor.)

Why npm 10 rather than 11: npm 11 (the default in some local/container environments) omits the nested optional-peer entries (for example `babel-plugin-macros`, `cosmiconfig`, `yaml`) that npm 10 expects. A lockfile written by npm 11 therefore fails `npm ci` on the runners with a sync error. The npm-10 lockfile is a compatible superset, so it works under both.

With the pin in place, no manual workaround is needed. Run `corepack enable` once in your clone (see [Local Setup](local-setup.md)) and any `npm install` that touches dependencies will regenerate `package-lock.json` under npm 10.9.8 automatically.

## Related

- [NX Commands](nx-commands.md) — lint, test, and build commands used by these jobs
- [Local Setup](local-setup.md) — getting a workspace building locally, including the buildable-library and per-project ESLint requirements
- [Monorepo Structure](../architecture/monorepo-structure.md) — how libraries, aliases, and build boundaries fit together
