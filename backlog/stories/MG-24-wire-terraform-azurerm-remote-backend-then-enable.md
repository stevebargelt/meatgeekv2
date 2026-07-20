---
id: MG-24
type: story
status: active
title: wire terraform azurerm remote backend, then enable infra auto-apply-on-merge (prod+dev)
created: 2026-07-19
---

## Problem

`apps/infrastructure` runs Terraform on LOCAL state — the `azurerm` backend is commented out (`main.tf:17-20`) and no `.tfstate` is tracked. Every `terraform init` starts from EMPTY state, so `plan` believes no resources exist and would try to CREATE all infra; `apply` then fails on existing resources or duplicates them. This makes any infra apply (auto or manual) unsafe. MG-21 ships `infra-deploy-prod` plan-only/dispatch-only because of this.

## Scope

1. **Wire the remote backend.** Enable `apps/infrastructure/backend-config.hcl` azurerm backend: uncomment the `backend "azurerm"` block in `main.tf`; `terraform init -backend-config=backend-config.hcl`. Provision the state storage account/container if absent.
2. **Establish AUTHORITATIVE state — do not create an empty remote state.** Locate the real current state: migrate authoritative local state into the remote backend, OR `terraform import` every existing production resource. Reconcile any conflicting state-key names (backend-config.hcl key vs whatever local state used). A fresh empty remote backend is NOT acceptance — it reproduces the recreate-everything hazard with a remote lock.
3. **Prove safety before enabling auto-apply.** The FIRST production `terraform plan` against the migrated/imported remote state must show NO resource recreation/deletion of existing infra (a near-no-op or additive-only plan), reviewed by a human. Only after that:
4. Enable auto-apply: add `push`+`paths: [apps/infrastructure/**]` to `infra-deploy-prod.yml` (and dev's), remove the plan-only restriction from MG-21, keep `workflow_dispatch`, keep `cancel-in-progress: false`.

## Acceptance criteria

- `backend "azurerm"` enabled; infra workflows `terraform init -backend-config=backend-config.hcl`; state persists remotely with blob-lease locking.
- Authoritative prod (and dev) state is MIGRATED or all existing resources IMPORTED; state-key names reconciled — evidenced by a plan.
- The first prod plan against remote state recognizes existing resources: NO destroy/recreate of live infra (reviewed, evidence attached).
- Auto-apply-on-merge is enabled ONLY after the above; before that, infra stays plan-only/dispatch-only (MG-21 posture).
- Concurrency `cancel-in-progress: false`; credential-skip guard retained.

## Context

Blocker split out of MG-21 (2026-07-19); AC expanded per external review — enabling a fresh backend without migrating/importing state still produces empty-state recreate hazard.

- **Also (residual of review finding #6):** align `infra-deploy-prod` credential/env/gating with the app model — env-scoped secret + a variable gate, with `environment: production` only on a real deploy job — so a plan-only manual dispatch records NO false production deployment. Deferred here because it is entangled with this ticket's infra remote-backend credential rework.
