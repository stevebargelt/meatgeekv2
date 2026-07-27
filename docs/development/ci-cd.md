# CI/CD Pipeline

MeatGeek V2 runs continuous integration through `.github/workflows/ci.yml`, and deploys through separate workflows. Dev **infrastructure** reconciles automatically through CI: `ci.yml`'s `validate-infrastructure` job validates every infrastructure change **credentiallessly** — it holds no Azure identity at all — and `.github/workflows/infra-apply-dev.yml` applies on merge to `main`. Production deployment is split into two standalone workflows — `.github/workflows/infra-deploy-prod.yml` and `.github/workflows/app-deploy-prod.yml`. This document describes the CI jobs that run, why the TypeScript build matrix is scoped the way it is, how the dev GitOps loop and the prod deploys work, the branch-protection rules on `main`, and the npm/lockfile constraint the runners depend on.

**Terminology used throughout, and in the tickets:** **MG-24** = *Terraform reconciliation* (operator-run, from a workstation, against the persistent remote backend). **MG-23** = *automated dev GitOps reconciliation* (CI-run, no operator apply for steady state).

## Triggers

The pipeline runs on:

- **push** to `main`
- **pull_request** targeting `main`

This repository is **trunk-based on `main`**. There is no `develop` branch and none will be created; `develop` was removed from the trigger lists under MG-23 as dead configuration.

Environment defaults used across jobs: Node.js `20`, Go `1.21`.

## Quality Jobs

These jobs run on every push and pull request and gate merges into `main` (see [Branch Protection](#branch-protection)).

| Job | What it does | Matrix |
|-----|--------------|--------|
| `setup` | Installs dependencies with `npm ci` and computes affected apps/libs via `npx nx show projects --affected` | — |
| `lint-and-test` | Runs `nx lint <project>` and `nx test <project> --coverage`, then uploads coverage to Codecov | `api`, `web`, `mobile`, `api-interfaces` |
| `build-typescript` | Runs `nx build <app>` and uploads the `dist/apps/<app>` artifact | `api`, `web` |
| `build-go` | Runs `make build`, `make test`, and `make build-arm` for each Go app | `device-controller`, `data-pusher` |
| `validate-infrastructure` | The **credentialless** infrastructure gate — see [PR validation](#dev-infrastructure--automated-gitops-reconciliation-mg-23). `assert-credentialless.sh` → `terraform fmt -check -recursive` → `terraform init -backend=false -input=false -lockfile=readonly` → `terraform validate` → `terraform test` → `tf-static-checks.sh` → `bootstrap.test.sh` → destroy-guard fixtures → per-module `terraform test` → OTel config validate | — |
| `security-scan` | `npm audit --audit-level=moderate` and a Snyk scan (both `continue-on-error`) | — |

`ci.yml` carries exactly **one** infrastructure job, `validate-infrastructure`, and it runs on **every** pull request and every push — not only on PRs touching `apps/infrastructure/**`. The two earlier pull-request-only infrastructure jobs (`detect_infra_changes` and the PR-time plan job) are **both gone**: with no Azure identity to protect, there is nothing for a change-detection job to gate, and running the checks unconditionally means a change that breaks them cannot slip through by touching a file outside the path filter. It **is** a required status check — see [Branch Protection](#branch-protection).

### Why the TypeScript build matrix is `api` + `web` only

`build-typescript` compiles only the apps that NX builds with `@nx/js:tsc`/bundlers — `api` (Azure Functions) and `web` (React/Vite). `mobile` is a React Native app; it is not `tsc`-built in CI, so it is intentionally **absent** from the `build-typescript` matrix. `mobile` is still linted and tested (it appears in the `lint-and-test` matrix); it is simply not compiled here.

Adding a new buildable TypeScript app? Add it to the `build-typescript` matrix. A new React Native target does **not** belong there — keep it in `lint-and-test` only.

## Deployment

Deployment is **not** part of branch protection — it runs after a merge lands on `main`, so it can never be a merge gate.

### Dev infrastructure — automated GitOps reconciliation (MG-23)

Dev infrastructure reconciles **through CI**. That is the intended steady state: an infrastructure change is written in a PR, **validated credentiallessly** by CI, reviewed, merged, and applied by CI. Nobody runs an apply from a workstation to keep dev in sync.

The loop is two halves:

| Half | Where | Identity / Environment | What it does |
|------|-------|------------------------|--------------|
| **PR validation (credentialless)** | `ci.yml` → `validate-infrastructure` | **no identity, no environment** | `assert-credentialless.sh` → `terraform fmt -check -recursive` → `terraform init -backend=false -input=false -lockfile=readonly` → `terraform validate` → `terraform test` (root) → `tf-static-checks.sh` → `bootstrap.test.sh` → destroy-guard fixtures → per-module `terraform test` (`modules/functions`, `modules/iot-hub`, `modules/monitoring`) → OTel config validate. **No `terraform plan`, no backend, no Azure login** |
| **Apply on merge** | `infra-apply-dev.yml` → `apply` | infra-apply identity, `development-infra-apply` | plan → pre-apply secret gate → destructive-change circuit-breaker → apply **that saved plan** → post-apply state gate → final drift plan that **fails on drift** |

**PR validation (`validate-infrastructure`) is credentialless — that is the design, not an omission.** The job declares `permissions: contents: read` and nothing else: **no** `id-token: write`, so GitHub never injects the OIDC token-request pair; **no** `environment:`, so no federated credential can be selected; **no** `azure/login`; and no client id or subscription id anywhere in the file. An `env:` block additionally pins `ARM_USE_OIDC`, `ARM_USE_CLI`, `ARM_USE_MSI` and `ARM_USE_AKS_WORKLOAD_IDENTITY` to `'false'`, so the `azurerm` provider **refuses** ambient credentials even if a future edit or a self-hosted runner leaves some lying around. The first step, `scripts/assert-credentialless.sh`, proves at runtime what the declaration claims statically — it fails the job if any `ARM_*`/`AZURE_*` credential material, cached `az login`, or `ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN` is present, and it also fails if it discovers zero test files, so it cannot certify an empty gate.

Everything after that runs against the checked-out tree alone. `terraform init` passes `-backend=false -input=false -lockfile=readonly`; **`-backend=false` is an `init` flag and is not accepted by `terraform validate` or `terraform test`** — it belongs on `init` alone, and it is exactly why this job needs no state credential: with no backend configured, nothing reaches `meatgeek-v2/dev.tfstate`. `terraform test` runs against **mock providers**, so it provisions nothing. `tf-plan-secret-inspection.sh` and `tf-plan-destroy-guard.sh` are never pointed at a real plan before a merge — there is no plan to inspect. Both are exercised as **fixture regressions**, so what CI proves pre-merge is that each gate still fails closed on the crafted fixtures (under bash *and* dash), not that a particular plan is clean. They are wired into **different jobs**, which is worth knowing if you go looking for them: the destroy-guard fixtures are a `validate-infrastructure` step (`run-destroy-guard-fixtures.sh`), while the secret-gate fixtures are driven from the `api-interfaces` leg of `lint-and-test`, whose Jest suite shells out to `run-flex-secret-gate-fixtures.sh`. Both jobs are required checks, so neither regression can be skipped — but only `infra-apply-dev.yml` ever runs either gate against a real plan or real state.

**What that costs, stated plainly:** a pull request no longer gets a remote-state plan, so a reviewer cannot see the concrete resource diff before merge. The authoritative plan is the one `infra-apply-dev.yml` takes **post-merge** against real state, under the apply identity, screened by the pre-apply secret gate and the destroy circuit-breaker, and proven convergent by the final drift plan. What it buys is that no pull-request-reachable job holds an Azure identity, so attacker-supplied PR code has no path to `tfstate-dev` or the live IoT Hub SAS keys in it. **Restoring a PR-time plan cannot be done without re-granting a PR-reachable identity read on live state** — that is a threat-model change, not a CI convenience change.

**Apply on merge (`infra-apply-dev.yml`).** It triggers on `workflow_run` after the **CI/CD Pipeline** completes, and only when `conclusion == 'success'`, `event == 'push'`, and `head_branch == 'main'` — all three, because `workflow_run` also fires for PR-triggered and fork CI runs. It checks out `workflow_run.head_sha` (the exact commit CI went green on, never a floating ref), applies the exact saved plan, and ends with a `-detailed-exitcode` plan that **fails the run on any drift**. A `workflow_dispatch` entry exists as a **branch-restricted recovery path only**; it runs the identical sequence with no shortcut and carries its own manual approval, which the automatic path deliberately does not.

**Stale trunk is never applied.** Because a `workflow_run` apply is queued against the SHA that CI went green on, `main` can move on before that run reaches Azure. The apply job therefore checks that its SHA is still the tip of `main` **before** authenticating, and **re-checks immediately before `terraform apply`** to close the window between the two. A run that has been superseded by a newer commit **skips cleanly** — green, not red — and leaves reconciliation to the newer commit's own run. The recovery `workflow_dispatch` path pins `main` at startup and re-checks the same way; if `main` moved while the run sat waiting for approval, it stops and requires a fresh recovery run rather than applying a trunk state nobody approved.

**What the circuit-breaker protects.** It is not destroy-only. It blocks any plan that would **destroy** a resource *or* **`forget`** one — the action a `removed { destroy = false }` block produces, which drops a resource out of Terraform management while leaving it alive in Azure, and which every downstream control (secret gate, drift plan) would otherwise report as green. Authorization is an **exact, action-qualified token set** supplied on the recovery path, so approving `delete:<address>` cannot authorize `forget:<address>`, and current and deposed objects sharing one address are enumerated and approved individually. The gate fails closed on any plan shape it cannot classify. The exact token syntax and the operator procedure live in [MG-23 live acceptance & activation](../infrastructure/mg23-live-acceptance.md).

Every job in both halves gates on the repository variable `vars.DEV_TF_BACKEND_READY == 'true'` and **skips cleanly** (green, not red) when it is unset. Activation is operator-controlled and has prerequisites — see [MG-23 live acceptance & activation](../infrastructure/mg23-live-acceptance.md).

**State locking.** Only the **apply** half touches state at all, so it is the only half that locks. Every `terraform plan` and `terraform apply` inside `infra-apply-dev.yml` passes `-lock-timeout=5m`, so a contending operation **waits** for the Azure blob lease on `meatgeek-v2/dev.tfstate` instead of failing immediately (`init` does not lock), and the apply-vs-apply case is separately serialized by the `infra-apply-dev-development-infra-apply` concurrency group with `cancel-in-progress: false`. The PR half has no lock semantics to discuss because it opens no backend: `terraform init -backend=false` means there is no state to lease, contend for, or corrupt.

**What CI reconciliation does *not* cover.** Bootstrap (remote state + the OIDC identities), creation of `meatgeek-v2-dev-rg` itself, subscription-scoped configuration, and disaster recovery remain **operator** actions. The dev apply identity is scoped to `meatgeek-v2-dev-rg`, so Terraform can only *adopt* that resource group — if dev state or the RG is lost, the GitOps loop cannot rebuild it. "CI reconciles dev infrastructure" does not imply a rebuild capability. The final drift plan proves convergence of Terraform-managed **control-plane** resources only; out-of-band role assignments and Cosmos data-plane `sqlRoleAssignments` are invisible to it, and Activity Log alerts are the compensating control.

**Dev applications** (the Functions API and the web app) are not deployed by this loop — they are owned by their own deploy targets and workflows.

**Credentials.** **The pull-request path holds no identity at all** — `validate-infrastructure` binds no environment, declares no `id-token: write`, and calls no `azure/login`, so nothing reachable from a PR can authenticate to Azure. Everything that *does* authenticate runs post-merge or on dispatch.

There are **two** dev identities left, plus prod, all authenticating via **per-environment OIDC** rather than the retired long-lived `AZURE_CREDENTIALS` service-principal secret; each job declares `permissions: id-token: write` scoped to itself. Under MG-23 the *environment* — not the client id a job happens to pass — is what selects the identity: `development-infra-apply` federates the infra-apply identity, `development` federates the app-publish identity, and `production` federates the prod plan/read identity (which is unchanged by MG-23 and still used by `infra-deploy-prod.yml`). Before MG-23 the dev identities federated the identical `environment:development` subject, so a one-line client-id edit could silently upgrade a low-privilege job to full apply; it no longer can, because the OIDC subject would stop matching and the login would fail closed. Neither dev identity can authenticate to prod's `environment:production`.

A fourth environment, `development-infra-apply-recovery`, gates the recovery `workflow_dispatch` path with a required reviewer. It is **approval-only and deliberately not federated** — the `recovery_approval` job binds it purely to pick up its protection rules, holds no `id-token` permission, and never calls `azure/login`.

### Prod

Production deployment is **not** in `ci.yml`. It lives in two standalone workflows so infrastructure and the app can be deployed independently:

| Workflow | Triggers | What it deploys |
|----------|----------|-----------------|
| `infra-deploy-prod.yml` | `workflow_dispatch` only (manual / recovery) | Terraform infrastructure — **plan-only** (`terraform init` binding the prod remote backend + `terraform plan`, **no `apply`**); the prod apply is still the operator's out-of-band step until **MG-25** activates CI-run prod reconciliation |
| `app-deploy-prod.yml` | `workflow_run` — after the **CI/CD Pipeline** workflow completes (no push trigger, no `workflow_dispatch`) | Functions API only, via `nx deploy api --functionApp=<prod Function App name>` |

Prod is **API-only** — no workflow in this repo deploys the web frontend, in prod or in dev. That is a statement about **automation**, not about capability: `apps/web/project.json` defines a working `deploy` target, and `nx deploy web --args="--env=<env>"` (an operator-run `az staticwebapp deploy` against a locally built `dist/apps/web`) is how the frontend ships today. See [Azure Deployment](nx-commands.md#azure-deployment).

MG-23 removed the plan-only `deploy-dev` job and the CI **upload** of the web bundle. Nothing in this repo runs `download-artifact`, so that upload had no consumer and `nx deploy web` never depended on it — the removal did not break the deploy path. `nx build web` still runs in CI, so the web app keeps its compile-time signal. Adding a web deploy **workflow** is out of MG-23's scope.

#### App deploy: CI-gated via `workflow_run`

`app-deploy-prod.yml` does **not** trigger on push. It runs on `workflow_run` when the **CI/CD Pipeline** workflow (`ci.yml`) *completes*, and only deploys when **all** of the following hold on the triggering CI run:

- `conclusion == 'success'` — CI was green
- `event == 'push'` — it was a push, not a pull request
- `head_branch == 'main'` — the push targeted `main`
- `vars.PROD_DEPLOY_ENABLED == 'true'` — the operator switch (a **repository variable**, not a secret) is flipped on

This means prod app deploys only ever happen **after green CI on a push to `main`**, and never for a PR or a red build. `PROD_DEPLOY_ENABLED` is the master on/off switch: leave it unset (or anything other than `'true'`) to keep prod deploys dark; set it to `'true'` when you want green pushes to `main` to ship.

**Stale-SHA guard.** The deploy job checks out the exact commit CI ran against (`github.event.workflow_run.head_sha`), but first compares that SHA to the current `main` tip. If `main` has already advanced past the CI'd commit, the job **skips cleanly (green, not a failure)** — it never deploys a commit that is no longer the head of `main`. When several pushes land in quick succession, only the run whose commit is still the tip deploys.

**Retrying a failed deploy.** There is **no `workflow_dispatch`** on the app deploy. To retry, use GitHub's **re-run** on the relevant Actions run (the CI/CD Pipeline run, or the deploy run itself) — there is no manual trigger to invoke by hand.

**Build and package check.** The job builds its own artifact (`corepack enable` → `npm ci` → `nx build api`); there is no artifact sharing between workflows. Before publishing it runs `node apps/api/tools/verify-func-package.js dist/apps/api`, which validates that the build is a well-formed Azure Functions (Node v4) package — `host.json` and `package.json` present and correct at the package root. Azure Functions Core Tools is pinned via `FUNC_CORE_TOOLS_VERSION` (currently `4.12.1`) so the publish toolchain does not drift.

#### Infra deploy: plan-only, manual — pending MG-25

`infra-deploy-prod.yml` is **`workflow_dispatch`-only** and **plan-only** — it binds the per-environment `azurerm` remote backend (`terraform init -reconfigure -backend-config=environments/backend-prod.hcl -backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"` — the derived state-account name is injected as an extra `-backend-config` because the `backend-*.hcl` files deliberately omit it; prod's isolated state key `meatgeek-v2/prod.tfstate`) and runs `terraform plan -var-file=environments/prod.tfvars -out=tfplan`, but **does not `apply`**.

This is a **not-yet**, not a never. CI-run reconciliation is the intended steady state for both environments; dev is live under MG-23 and **prod activates under MG-25**. Prod stays manual today because prod state is still greenfield — an unattended apply would create the entire prod stack on its first run — and because prod has no equivalent of dev's least-privilege infra-apply identity yet. Until MG-25, prod infra runs are dispatched by hand, stop at the plan, and the apply is the operator's out-of-band step after reviewing that plan.

**Credentials and environment.** Both prod workflows authenticate via **per-environment OIDC** — `azure/login@v2` with the GitHub-Environment-scoped federated credential (subject `environment:production`), **not** the retired long-lived `AZURE_CREDENTIALS_PROD` service-principal secret. Each declares `permissions: id-token: write` so `azure/login` can mint a short-lived OIDC token, and reads the `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` **`production` Environment variables** (with `ARM_SUBSCRIPTION_ID` sourced from `AZURE_SUBSCRIPTION_ID` for Terraform). These variables only resolve for jobs that declare `environment: production` — in `app-deploy-prod.yml` that is the deploy job; in `infra-deploy-prod.yml` both the `guard` and `deploy-infra` jobs. Both workflows set `concurrency` to not cancel in-progress runs. The infra workflow's `guard` job checks that the three OIDC Environment variables are set and skips cleanly (green) if any is absent. The app workflow has no such guard — it is gated by `PROD_DEPLOY_ENABLED`. There are no long-lived deploy secrets to commit.

## Branch Protection

`main` is protected. Merges require the following quality jobs to pass:

- `setup`
- `lint-and-test`
- `build-typescript`
- `build-go`
- `validate-infrastructure`
- `security-scan`

`validate-infrastructure` **is** a required check, and under MG-23 it carries the whole *Terraform-side* pre-merge gate: with no PR-time plan, the credentialless sequence (`assert-credentialless.sh` → `fmt -check` → backend-less `init` → `validate` → `terraform test` → `tf-static-checks.sh` → `bootstrap.test.sh` → destroy-guard fixtures → per-module `terraform test` → OTel config validate) is what stands between a bad infrastructure change and an automatic post-merge apply. It is not quite alone: the `api-interfaces` leg of `lint-and-test` is also required, and it is where the workflow-structure specs (the apply workflow's trigger gating and job reachability, the OIDC subject map, the toolchain pins) and the secret-gate fixture regression actually execute — so a change that quietly rewrote the apply workflow's gating would fail there, not here. Because neither job needs a credential, both run unconditionally on every PR, so there is no "absent on most PRs" problem to work around — which is precisely why they can be required at all, where the old PR-only plan job could not.

Deployment and reconciliation are **excluded** from the required checks — `infra-apply-dev.yml` and `app-deploy-prod.yml` are triggered by CI *completing* on a push to `main`, and `infra-deploy-prod.yml` is manual, so none of them can be a merge gate.

Branch protection on `main` is **load-bearing under MG-23**: a merge to `main` now drives an automatic infrastructure apply holding Contributor and a conditioned Role Based Access Control Administrator on `meatgeek-v2-dev-rg`. Tightening it — `enforce_admins` plus review requirements — is a prerequisite for setting `DEV_TF_BACKEND_READY` to `true`, and is covered in [MG-23 live acceptance & activation](../infrastructure/mg23-live-acceptance.md).

Branch protection is configured on the GitHub repository (Settings → Branches), not in a tracked file. When you add or rename a required job in `ci.yml`, update the required-status-check list to match, or the new job will run without gating merges.

## npm and the Lockfile

`package.json` pins the toolchain via `"packageManager": "npm@10.9.8"`, and CI activates it with a `corepack enable` step before `npm ci` in every dependency-installing job (`setup`, `lint-and-test`, `build-typescript`, `security-scan`). Corepack reads the `packageManager` field and provisions npm 10.9.8 automatically, so both the runners and local contributors resolve dependencies with the same pinned npm. (`engines.npm` remains `>=10.0.0` as a floor.)

Why npm 10 rather than 11: npm 11 (the default in some local/container environments) omits the nested optional-peer entries (for example `babel-plugin-macros`, `cosmiconfig`, `yaml`) that npm 10 expects. A lockfile written by npm 11 therefore fails `npm ci` on the runners with a sync error. The npm-10 lockfile is a compatible superset, so it works under both.

With the pin in place, no manual workaround is needed. Run `corepack enable` once in your clone (see [Local Setup](local-setup.md)) and any `npm install` that touches dependencies will regenerate `package-lock.json` under npm 10.9.8 automatically.

## Related

- [NX Commands](nx-commands.md) — lint, test, and build commands used by these jobs
- [Local Setup](local-setup.md) — getting a workspace building locally, including the buildable-library and per-project ESLint requirements
- [Monorepo Structure](../architecture/monorepo-structure.md) — how libraries, aliases, and build boundaries fit together
