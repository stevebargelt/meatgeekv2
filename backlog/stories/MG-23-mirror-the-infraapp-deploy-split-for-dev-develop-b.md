---
id: MG-23
type: story
status: active
title: automated dev infrastructure GitOps reconciliation (trunk-based main)
created: 2026-07-19
---

## Problem / policy (re-scoped 2026-07-23)

MG-24 proved **Terraform-owned greenfield provisioning + remote-state reconciliation from an OPERATOR-RUN apply** (workstation). It did NOT prove the automated delivery loop. **MG-23 proves automated dev GitOps reconciliation**: infrastructure changes flow through CI — PR plan, then automatic apply-on-merge to `main` — with NO operator-workstation apply for steady state. DEPENDS ON MG-24 (DONE: durable dev state `meatgeek-v2/dev.tfstate` + TF-owned Flex stack, live in West US 2).

## Branch model — CORRECTED (2026-07-23)

This repository has **NO `develop` branch** and uses **trunk-based `main`**. Do NOT create `develop` to satisfy the old ticket text. All dev GitOps flows key off `main`: PRs merge into `main`; automatic apply triggers on merge to `main`. Any separate branch strategy requires explicit operator approval. (The prior "mirror the prod split for the develop branch" framing is retired.)

## Scope

1. **PR plan (non-applying).** A PR that changes `apps/infrastructure/**` runs a dev Terraform `plan` against the PERSISTENT `meatgeek-v2/dev.tfstate` backend and runs the pre-apply secret-inspection gate (`scripts/tf-plan-secret-inspection.sh`). PR jobs NEVER apply. This supersedes the old plan-only `deploy-dev` job in `ci.yml` — remove `deploy-dev` and the now-orphaned build-artifact upload that only fed it.

2. **`infra-apply-dev` workflow (post-merge automatic apply).** After the CI/CD Pipeline succeeds for an infrastructure-changing commit merged to `main`, a new `infra-apply-dev` workflow runs, IN ORDER:
   - checks out the EXACT successful CI SHA (not a floating ref);
   - authenticates via the **`development` GitHub Environment OIDC identity**;
   - `terraform init` the persistent dev backend NONINTERACTIVELY (`-input=false`, `backend-dev.hcl` + the derived storage-account name);
   - creates a fresh `plan -out=<file>`;
   - runs the secret gate against that plan (pre-apply);
   - `apply`s THAT EXACT saved plan;
   - runs the post-apply STATE secret gate;
   - runs a final `plan` and REQUIRES no unexpected drift (the run FAILS on drift).

3. **Activation gate.** Every job above gates on repo/environment variable `DEV_TF_BACKEND_READY == 'true'` — set this NOW (MG-24 has proven the backend + stack). Missing/false configuration must SKIP CLEANLY (no failing/red job when unset).

4. **Concurrency.** Environment-scoped concurrency group (e.g. `infra-apply-dev-<env>`) with `cancel-in-progress: false`, so two applies cannot race or interrupt an in-flight state mutation.

5. **No human dispatch for normal reconciliation.** Normal dev reconciliation runs AUTOMATICALLY (point 2) — a human `workflow_dispatch` is NOT required. `workflow_dispatch` MAY exist ONLY as a branch-restricted RECOVERY path, and it MUST execute the SAME plan → pre-gate → apply-saved-plan → post-gate → final-plan sequence (no shortcut/bypass).

6. **Identity separation — least-privilege dev infra-apply SP (operator-specified 2026-07-23).** The CI PLAN identity stays READ-ONLY (`AZURE_CLIENT_ID` = Reader + container-scoped Storage Blob Data on `tfstate-dev`). The apply job uses a SEPARATE, **OIDC-only dev infra-apply service principal** — Contributor ALONE is INSUFFICIENT because Terraform owns `azurerm_role_assignment` resources. Bootstrap this SP with EXACTLY:
   - **Contributor** scoped ONLY to `meatgeek-v2-dev-rg`.
   - **Role Based Access Control Administrator** scoped ONLY to `meatgeek-v2-dev-rg`, WITH an Azure RBAC **condition** restricting role assignment/deletion to (a) the explicit ALLOWLIST of role definitions this Terraform stack manages, AND (b) principal types service-principal / managed-identity ONLY. It MUST NOT be able to grant **Owner, Contributor, User Access Administrator, or RBAC Administrator**.
   - **Storage Blob Data Contributor** scoped ONLY to the `tfstate-dev` container.
   - **NO** subscription-wide application permissions; **NO** Microsoft Graph permissions.
   - Federated credential restricted to `repo:<owner>/<repo>:environment:development`.
   - GitHub `development` Environment restricted to `main`.
   - Only the apply JOB receives `id-token: write`.
   ENUMERATE the Terraform-managed role definitions FROM THE ACTUAL GRAPH and TEST that the RBAC condition PERMITS all of them while REJECTING the privileged roles (Owner/Contributor/UAA/RBAC-Admin). Do NOT claim Contributor alone can reconcile the stack. Provision in the bootstrap boundary (`bootstrap.sh`), wired as a `development` env variable; DISTINCT from the read-only plan identity and the app-publish identity.

7. **Prove the GitOps loop LIVE** (acceptance): open a PR with a representative tag change to `apps/infrastructure/**` → PR runs the dev plan + secret gate (non-applying) → merge to `main` → CI/CD Pipeline succeeds → `infra-apply-dev` AUTOMATICALLY applies → post-apply gate green → final no-op plan. THEN revert via another PR and prove the SAME automatic reconciliation (apply → gate → no-op). Capture evidence (PR checks, the infra-apply-dev run logs, gate outputs, final no-op).

8. **Language.** Use precise terms throughout docs/comments/workflows: MG-24 proved **Terraform reconciliation** (operator-run); MG-23 proves **automated dev GitOps reconciliation** (CI-run).

### Also (stale-claim correction)
- Correct `infra-deploy-prod.yml` (and any doc/runbook prose) that describes ALL future applies as operator-only. Bootstrap was operator-gated; **steady-state reconciliation is intended to run through CI**. Fix the framing so it no longer implies applies are forever operator-only (prod's CI-run steady-state apply is MG-25's activation, but the "operator-only forever" language is wrong today).

## App-deployment SPLIT — superseded → MG-36 (2026-07-23)

The ORIGINAL MG-23 bundled an automated `app-deploy-dev` workflow (application code publish). Per the 2026-07-23 re-scope, MG-23 is **automated dev INFRASTRUCTURE GitOps reconciliation ONLY**. The automated dev APP-deployment work is **SPLIT OUT to MG-36** (filed 2026-07-23) — NOT an informal "later if wanted" note. **MG-36 carries forward ALL original MG-23 app-deploy acceptance criteria so none disappear**, and it:
- DEPENDS ON MG-21's successful manual dev publish + auth-smoke proof;
- retains the dedicated app-PUBLISH identity (`AZURE_APP_DEPLOY_CLIENT_ID`, Website Contributor scoped to the Function App);
- retains CI-gated, exact-successful-SHA deploy safety (no bare-push race).

MG-21 covers the one-off operator-run dev publish + auth smoke (not an automated workflow). This MG-23 does NOT touch application deployment.

## Acceptance criteria

- PRs touching `apps/infrastructure/**` run a NON-APPLYING dev plan against `meatgeek-v2/dev.tfstate` + the secret gate; PR jobs never apply.
- `infra-apply-dev` exists and, gated on `DEV_TF_BACKEND_READY=true`, runs the exact post-merge sequence in point 2 (checkout exact CI SHA → development OIDC → noninteractive init → fresh plan → pre-gate → apply saved plan → post-gate → final drift-free plan); skips cleanly when unset.
- Env-scoped concurrency with `cancel-in-progress:false`; normal reconciliation needs no `workflow_dispatch`; any dispatch is branch-restricted recovery running the identical sequence.
- A dedicated least-privilege dev infra-apply OIDC identity exists (bootstrap-provisioned, development-env-wired), distinct from the read-only plan identity; `deploy-dev` + orphaned artifact upload removed from `ci.yml`; remaining CI green.
- Live GitOps loop proven per point 7 (representative change PR → merge → auto-apply → post-gate → no-op; then revert PR → same), with captured evidence.
- `infra-deploy-prod.yml` stale operator-only-apply language corrected.

## Context

Re-scoped 2026-07-23 (trunk-based `main`, automated dev infra GitOps, 8-point definition). DEPENDS ON MG-24 (done). Do NOT create a `develop` branch; do NOT apply against ephemeral local state; do NOT touch V1.
