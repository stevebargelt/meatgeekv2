---
id: MG-24
type: story
status: active
title: wire terraform azurerm remote backend, then enable infra auto-apply-on-merge (prod+dev)
created: 2026-07-19
---

## Problem

`apps/infrastructure` runs Terraform on LOCAL state — the `azurerm` backend block is commented out (`main.tf:17-20`) and no `.tfstate` is tracked. Every CI `terraform init` starts from empty state, so `plan` believes no resources exist and would try to CREATE all infra; `apply` then fails on existing resources (or duplicates). This makes path-triggered "auto-apply infra on merge" unsafe, which is why MG-21 ships `infra-deploy-prod` as `workflow_dispatch`-only.

## Scope

1. Wire the existing `apps/infrastructure/backend-config.hcl` azurerm remote backend: uncomment the `backend "azurerm"` block in `main.tf`; have the infra deploy workflow(s) run `terraform init -backend-config=backend-config.hcl` so state is persistent and blob-lease-locked. Provision the state storage account/container if not already present.
2. Once persistent+locked state is in place, ADD the auto-apply-on-merge trigger to `infra-deploy-prod.yml` (and `infra-deploy-dev.yml` from MG-23): `push` to `main`/`develop` filtered to `paths: [apps/infrastructure/**]`, keeping `workflow_dispatch`. Merge = approval (no reviewer). Keep `-auto-approve`.

## Acceptance criteria

- `backend "azurerm"` enabled in `main.tf`; infra workflow `terraform init` uses `-backend-config=backend-config.hcl`; a plan/apply persists state remotely and acquires a lock.
- `infra-deploy-prod` (and `-dev`) gain the push+`apps/infrastructure/**` trigger; a real infra-path merge schedules the apply against persistent state (not empty).
- Concurrency guard still `cancel-in-progress: false`; credential-skip guard retained.

## Context

Blocker split out of MG-21 (2026-07-19). MG-21 intentionally ships infra as dispatch-only until this lands.
