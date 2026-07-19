---
id: MG-21
type: story
status: active
title: split prod deploy into standalone infra + app workflows (path-triggered)
created: 2026-07-18
---

## Problem

`ci.yml`'s `deploy-prod` job ran on every push to `main`, had no Azure creds, so it FAILED every push (red on otherwise-green runs). It also bundled a Terraform infra apply with the app (Functions API) deploy in one job.

## Policy (operator-decided 2026-07-19)

Split prod deployment into two standalone workflows, removed from `ci.yml`. **Prod is API-only** (checked-in `deploy-prod` only runs `nx deploy api --env=prod`; the web/Static-Web-Apps deploy is dev-only and is NOT added here — possible separate follow-up). Behavior-preserving refactor + red-on-push fix.

- **`infra-deploy-prod.yml`** — trigger: **`workflow_dispatch` ONLY** (manual/recovery). `terraform init/plan/apply` (prod.tfvars) with `AZURE_CREDENTIALS_PROD`. Auto-apply-on-merge (push + `paths: apps/infrastructure/**`) is DEFERRED to MG-24 (terraform has no remote state backend; path-triggered apply against empty local state would recreate all prod infra). Do NOT add the push trigger until MG-24.
- **`app-deploy-prod.yml`** — trigger: `push` to `main` filtered to `paths: [apps/api/**, libs/**]`, plus `workflow_dispatch`. Builds its own api artifact (`npm ci` + `nx build api`) then `nx deploy api --env=prod`. API only — no web/SWA, no `apps/web/**` path.

Design constraints (incorporating architect findings):
- **Credential-presence skip guard** — a guard job reads `AZURE_CREDENTIALS_PROD` in a step (secrets illegal in job-level `if:`), emits `has_creds`; deploy job `needs` the guard and gates on it. Absent secret → deploy job SKIPS clean (green). Single secret (API-only) — no partial-credential split.
- **Keep `environment: production`** on guard + deploy jobs (reviewer-LESS — merge/dispatch is approval) so an environment-scoped prod secret still resolves.
- **Concurrency guard**, stable env-scoped group, **`cancel-in-progress: false`**.
- **Self-contained builds** — app-deploy runs its own build; no dependency on a ci.yml run's artifacts.
- **Leave `ci.yml`'s build-artifact upload IN PLACE.** It is NOT orphaned: `deploy-dev` (retained in `ci.yml` until MG-23) still `download-artifact`s `api-build`/`*-build`. Removing the upload breaks the develop deploy path. Only the `deploy-prod` JOB leaves `ci.yml`; all other jobs (incl. the upload step and `deploy-dev`) stay untouched. (The upload becomes removable in MG-23 when `deploy-dev` is split out.)
- `deploy-dev` is out of scope (MG-23).

## Acceptance criteria

- `.github/workflows/infra-deploy-prod.yml` exists: **`workflow_dispatch` only** (NO push); terraform plan+apply (prod.tfvars) with `AZURE_CREDENTIALS_PROD`; guard-job credential-skip; `environment: production` on guard + deploy; concurrency `cancel-in-progress: false`.
- `.github/workflows/app-deploy-prod.yml` exists: `push` to `main` scoped to `apps/api/**, libs/**` + `workflow_dispatch`; builds own api artifact then `nx deploy api --env=prod` (API only); credential-skip guard on `AZURE_CREDENTIALS_PROD`; `environment: production`; concurrency `cancel-in-progress: false`.
- `ci.yml` no longer contains the `deploy-prod` job; ALL other jobs remain and pass, INCLUDING the build-artifact upload (deploy-dev depends on it) and `deploy-dev` itself. (MG-21 must not regress the develop deploy path.)
- A push to `main` touching NEITHER `apps/api/**` nor `libs/**` triggers NO prod deploy workflow — verified on a real post-merge push-to-main run: overall status green, no failed deploy job.
- A push to `main` touching `apps/api/**`/`libs/**` schedules `app-deploy-prod`, which (creds absent) SKIPS the deploy job clean/green rather than failing.
- `infra-deploy-prod` does not run on any push (dispatch-only), per its trigger config.
- Deploy capability preserved, only re-triggered/gated.

## Context

Refiled MG-21, rescoped 2026-07-19 to a behavior-preserving prod split (API-only) + red-on-push fix. Auto-apply-on-merge + terraform remote backend = MG-24. Dev mirror = MG-23. AC corrected 2026-07-19: the build-artifact upload is retained (deploy-dev needs it), not removed — earlier AC wrongly called it orphaned (review-loop caught it).
