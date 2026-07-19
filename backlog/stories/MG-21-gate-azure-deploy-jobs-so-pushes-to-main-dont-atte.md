---
id: MG-21
type: story
status: active
title: split prod deploy into standalone infra + app workflows (path-triggered)
created: 2026-07-18
---

## Problem

`ci.yml`'s `deploy-prod` job runs on every push to `main`, has no Azure creds, so it FAILS every push (red on otherwise-green runs). It also bundles Terraform infra apply with the app (Functions API) deploy in one job.

## Policy (operator-decided 2026-07-19)

Split prod deployment into two standalone workflows, removed from `ci.yml`. **Prod is API-only** (checked-in `deploy-prod` only runs `nx deploy api --env=prod`; the web/Static-Web-Apps deploy is dev-only and is NOT added here — that's a possible separate follow-up). This ticket is a behavior-preserving refactor plus the red-on-push fix.

- **`infra-deploy-prod.yml`** — trigger: **`workflow_dispatch` ONLY** (manual/recovery). Runs `terraform init/plan/apply` (prod.tfvars) with `AZURE_CREDENTIALS_PROD`. Auto-apply-on-merge (push + `paths: apps/infrastructure/**`) is DEFERRED to MG-24 because terraform currently has no remote state backend (azurerm block commented out, no tracked state) — path-triggered auto-apply against empty local state would try to recreate all prod infra. Do NOT add the push trigger until MG-24 wires the backend.
- **`app-deploy-prod.yml`** — trigger: `push` to `main` filtered to `paths: [apps/api/**, libs/**]`, plus `workflow_dispatch`. Builds its own api artifact (`npm ci` + `nx build api`) then `nx deploy api --env=prod`. API only — no web/SWA step, no `apps/web/**` path.

Design constraints (incorporating architect findings):
- **Credential-presence skip guard** — a guard job reads `AZURE_CREDENTIALS_PROD` in a step (secrets are illegal in job-level `if:`), emits `has_creds` as a job output; the deploy job `needs` the guard and gates on it. Absent secret → deploy job SKIPS clean (green), never fails. Applies to both push and dispatch. Single secret (API-only) — no partial-credential split.
- **Keep `environment: production`** on both the guard job and the deploy job (reviewer-LESS — merge/dispatch is the approval), so a prod secret that is environment-scoped still resolves. Dropping the environment would make an env-scoped secret invisible → silent skip-forever.
- **Concurrency guard**, environment-scoped/stable group, **`cancel-in-progress: false`** (never cancel mid `terraform apply` / mid `func publish`).
- **Self-contained builds** — app-deploy runs its own build; no dependency on a ci.yml run's artifacts. Remove the now-unused `api-build`/`*-build` artifact upload from `ci.yml`'s build step.
- `ci.yml` keeps all build/lint/test/security/validate-infrastructure jobs unchanged; only `deploy-prod` and the orphaned artifact upload leave it. `deploy-dev` is MG-23.

## Acceptance criteria

- `.github/workflows/infra-deploy-prod.yml` exists: **`workflow_dispatch` trigger only** (NO push trigger); runs terraform plan+apply (prod.tfvars) with `AZURE_CREDENTIALS_PROD`; guard-job credential-skip (skips clean when secret absent); `environment: production` on guard + deploy; concurrency guard with `cancel-in-progress: false`.
- `.github/workflows/app-deploy-prod.yml` exists: `push` to `main` scoped to `apps/api/**, libs/**` + `workflow_dispatch`; builds its own api artifact then `nx deploy api --env=prod` (API only, no web); credential-skip guard on `AZURE_CREDENTIALS_PROD`; `environment: production`; concurrency guard `cancel-in-progress: false`.
- `ci.yml` no longer contains `deploy-prod`, and its unused build-artifact upload is removed; all remaining jobs present and passing.
- A push to `main` touching NEITHER `apps/api/**` nor `libs/**` triggers NO deploy workflow — verified on a real post-merge push-to-main run: overall status green, no failed deploy job.
- A push to `main` touching `apps/api/**`/`libs/**` schedules `app-deploy-prod`, which (creds absent) SKIPS clean/green rather than failing.
- `infra-deploy-prod` does not run on any push (dispatch-only), verified by its trigger config.
- Deploy capability preserved, only re-triggered/gated (deploy steps intact, would run under the intended trigger with creds present).

## Context

Refiled MG-21, rescoped 2026-07-19 to a behavior-preserving prod split (API-only) + red-on-push fix. Auto-apply-on-merge + terraform remote backend = MG-24 (blocker). Dev mirror = MG-23. Web-to-prod deploy is an unfiled possible follow-up.
