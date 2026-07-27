---
id: MG-23
type: story
status: active
title: automated dev infrastructure GitOps reconciliation (trunk-based main)
created: 2026-07-19
---

### MG-23 — automated dev infrastructure GitOps reconciliation (trunk-based main)

## Problem / policy (re-scoped 2026-07-27 — SIMPLIFIED: no PR-reachable Azure plan identity)

MG-24 (done) proved Terraform reconciliation from an operator-run apply against the persistent dev backend. MG-23 proves AUTOMATED dev GitOps reconciliation: infra changes flow through CI — CREDENTIALLESS PR validation, then automatic apply-on-merge to `main` — with no operator-workstation apply for steady state. Trunk-based `main`; NO `develop` branch.

This design REPLACES the earlier PR-plan-identity model. A PR-reachable Azure identity with live state access was the source of a complexity spiral (read-only-vs-write state authority, protected-env verification, shared-key bypass). It is REMOVED: PR validation is fully credentialless; only the post-merge apply path authenticates to Azure.

DEPENDS ON MG-24 (done). App-deployment is MG-36. Supply-chain (snyk pin, module provider locking) is MG-39. Reconciliation-liveness alerting is MG-38.

## Model

### PR validation — CREDENTIALLESS
- ci.yml carries exactly ONE infrastructure job, `validate-infrastructure`. It runs on EVERY pull request and push (no path filter, no `detect_infra_changes` gate) — it needs no credential, so running it unconditionally costs nothing and closes the "changed a file outside the path filter" hole.
- Sequence, in order: `assert-credentialless.sh` -> `terraform fmt -check -recursive` -> `terraform init -backend=false -input=false -lockfile=readonly` -> `terraform validate` -> `terraform test` (root) -> `tf-static-checks.sh` (incl. allowlist-drift + out-of-RG-scope + mock-provider assertion) -> `bootstrap.test.sh` -> destroy-guard fixtures (bash AND dash) -> per-module `terraform test` (modules/functions, modules/iot-hub, modules/monitoring; empty discovery FAILS) -> pinned OTel collector config validate. NOTE `-backend=false` belongs to `init`, NOT to validate/test — those commands reject it.
- The job declares `permissions: contents: read` ONLY (NO `id-token: write`), binds NO GitHub environment, calls NO `azure/login`, carries no client/subscription id, and sets `env:` `ARM_USE_OIDC`/`ARM_USE_CLI`/`ARM_USE_MSI`/`ARM_USE_AKS_WORKLOAD_IDENTITY` all to `'false'` so the provider refuses ambient credentials. Tests are mock-provider / non-applying only.
- `assert-credentialless.sh` FAILS the job at runtime on any ARM_*/AZURE_* credential material, cached `az login`, or ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN pair, and on zero discovered test files (it cannot certify an empty gate).
- The PR plan identity, the live PR `terraform plan`, and the `development-infra-plan` environment are REMOVED (not gated). Removing the CODE does not remove the LIVE Azure/GitHub objects and re-running bootstrap does not either — decommissioning them is an operator step (docs/infrastructure/mg23-live-acceptance.md §3, blocking check B8).

### Green-main reconciliation — AUTOMATIC (no manual approval)
- After required CI succeeds on main, `infra-apply-dev` automatically reconciles the exact current main SHA using ONLY the dedicated dev infra-apply OIDC identity.
- Sequence: noninteractive AAD-authenticated backend init -> fresh `plan -out` -> fail-closed secret gate + fail-closed destroy/removal gate on that plan -> re-check the SHA is still current main immediately before apply -> `apply` that exact saved plan -> post-apply secret gate -> final no-drift plan (fails on drift).
- Gated on DEV_TF_BACKEND_READY=='true'; skips cleanly when unset. Environment-scoped concurrency (cancel-in-progress:false) + 90m apply timeout preserved. No manual deployment approval on the normal path.
- A superseded automatic run skips cleanly and never applies stale trunk (liveness alerting = MG-38).

### Recovery — SEPARATE, MANUAL
- Branch-restricted workflow_dispatch running the IDENTICAL gated sequence, behind an explicitly created + verified protected environment. Waiting for recovery approval must NEVER block normal automatic reconciliation (apply-time concurrency acquired only post-approval, or a separate workflow).

### Identity — least-privilege, dedicated
- OIDC-only dev infra-apply SP: Contributor + conditioned RBAC-Admin (allowlist of graph-enumerated role defs; principalType SP-only; denies Owner/Contributor/UAA/RBAC-Admin) scoped ONLY to meatgeek-v2-dev-rg + Storage Blob Data Contributor scoped ONLY to the tfstate-dev container. NO subscription scope, NO Graph. Federated ONLY to the apply (+ recovery) environment(s).
- Subscription budget stays bootstrap/operator-owned (count-guarded out of the CI-applied graph). Provider RP registration is a bootstrap precondition (resource_provider_registrations = "none").

### Environments — explicitly created + verified (NO GitHub auto-creation)
- `development-infra-apply`: FEDERATED to the dev infra-apply identity; automatic; main-only deployment branch policy; NO manual approval.
- `development-infra-apply-recovery`: main-only, REQUIRED REVIEWERS; APPROVAL-ONLY and deliberately NOT federated — nothing logs into Azure under it; the `recovery_approval` job binds it purely for its protection rules and holds no `id-token` permission.
- Bootstrap/activation explicitly creates and verifies BOTH as blocking pre-activation checks; DEV_TF_BACKEND_READY cannot be enabled until BOTH report PROTECTED. Neither may be left to GitHub auto-creation (auto-created environments have no protection rules).
- The complete set of FEDERATED environments after MG-23 is exactly three: `development-infra-apply` (dev infra-apply), `development` (app-deploy, MG-36), `production` (prod plan/read — SURVIVES; infra-deploy-prod.yml still authenticates under it). State containers remain exactly `tfstate-dev` and `tfstate-prod`.

## Acceptance criteria

- Every PR and push runs the single credentialless `validate-infrastructure` job in the order above (assert-credentialless -> fmt -check -recursive -> init -backend=false -input=false -lockfile=readonly -> validate -> test -> static checks -> bootstrap.test -> destroy-guard fixtures -> per-module test -> OTel validate), with `permissions: contents: read` only, NO id-token:write, NO Azure secrets, NO environment, ARM_USE_* disarmed, mock-provider/non-applying tests only, and FAIL if a test attempts real Azure auth/provisioning. PR plan identity + live PR plan + the retired plan environment removed from the code; live-object decommission is an operator step (see the acceptance doc §3/B8).
- infra-apply-dev automatically reconciles the exact current main SHA post-CI-success via the infra-apply OIDC identity, running the full gated sequence (AAD init -> saved plan -> fail-closed secret + destroy/removal gates -> SHA re-check -> apply saved plan -> post-secret gate -> no-drift plan); gated on DEV_TF_BACKEND_READY, cleanly skipped when unset; concurrency serialization + 90m timeout; no manual approval on the normal path.
- Recovery is a separate branch-restricted workflow_dispatch running the identical sequence behind a verified protected environment; recovery approval never blocks normal reconciliation.
- Dedicated least-privilege infra-apply OIDC identity as specified; distinct from app-deploy; no subscription scope, no Graph.
- Both `development-infra-apply` and `development-infra-apply-recovery` are explicitly created and verified (policies as above); neither relies on GitHub auto-creation; DEV_TF_BACKEND_READY stays false until both verify PROTECTED.
- deploy-dev + orphaned artifact upload removed from ci.yml; dead develop-branch config removed; infra-deploy-prod.yml stale operator-only-apply language corrected; committed provider lock for the root module. Remaining CI green.
- Pre-merge quality blockers (all four met):
  1. Secret gate fails CLOSED on temp-file failure, missing tools, invalid JSON, unexpected schema; a valid EMPTY resource_changes array still PASSES.
  2. No blind identity selection in the MG-23 bootstrap path — 0 or >1 matches FAIL; new objects followed by returned IDs.
  3. Exact roles + environments verified (bootstrap.test asserts the apply identity's exact grants + both environments' protection).
  4. Focused executable regression tests for those controls (incl. secret-gate fail-closed paths; bash AND dash gate fixtures both actually running).
- Live GitOps loop proven (AC7): representative change PR (credentialless validation goes GREEN — there is no approval to wait for) -> merge -> CI green -> automatic apply -> post-gate -> no-op; then revert PR -> same. OPERATOR-GATED (needs Azure creds post-merge). MG-23 stays OPEN until captured; only the deterministic half merges.
- Retired dev plan identity DECOMMISSIONED in the tenant and on GitHub, verified across all five objects: app registration, service principal, subscription Reader assignment, tfstate-dev blob-data assignment, and the retired plan GitHub Environment + its scoped AZURE_CLIENT_ID — plus a sweep proving no federated credential anywhere still names that environment's subject. Exact steps and verification commands: docs/infrastructure/mg23-live-acceptance.md §3; blocking check B8. OPERATOR-GATED.

## Out of scope / deferred
- AC7 live proof: operator-gated after merge.
- Reconciliation-liveness alerting -> MG-38. Supply-chain (snyk@master pin + SNYK_TOKEN removal from PR-executed code; provider locking in all CI-invoked modules incl modules/monitoring) -> MG-39. App-deploy identity hardening -> MG-36. NO repository-wide security/trust-framework work under MG-23.

## Context
Re-scoped 2026-07-27 (simplified, credentialless PR validation; PR plan identity removed). Supersedes the prior PR-plan-identity design. DEPENDS ON MG-24 (done). Do NOT create a develop branch; do NOT touch V1.
