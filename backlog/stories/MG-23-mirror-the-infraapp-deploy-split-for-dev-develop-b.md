---
id: MG-23
type: story
status: active
title: mirror the infra/app deploy split for dev (develop branch)
created: 2026-07-19
---

## Problem / policy

Companion to MG-21 (prod app deploy) — apply the standalone-workflow split to the dev/`develop` environment. Updated 2026-07-20 for the greenfield Azure facts: V2 has NO dev infrastructure; the dev stack is created by MG-24 (Terraform, greenfield). DEPENDS ON MG-24.

## Scope

Two standalone workflows, remove `deploy-dev` from `ci.yml`:

- **`infra-deploy-dev`** — keep **plan-only / non-applying** until MG-24 establishes durable remote dev state. After MG-24, the workflow must reconcile the **Terraform-owned dev stack through the persistent dev state** (`meatgeek-v2/dev.tfstate`) — never an ephemeral local-state apply. `workflow_dispatch`; env-scoped concurrency, `cancel-in-progress: false`.
- **`app-deploy-dev`** — mirror `app-deploy-prod`'s corrective safety: CI-gated (`workflow_run` on CI success for `develop`, not a bare push race), `workflow_dispatch` restricted to `refs/heads/develop`, credential-skip/gating, self-contained build, `environment: development` only on the real deploy job. **App deployment MUST target the Function App identity/name established by the IaC contract (MG-24)** — do NOT hardcode an independent name; consume the Terraform-aligned name/output.
- Remove `deploy-dev` from `ci.yml`; when it goes, ALSO remove the now-orphaned build-artifact upload (retained today only because `deploy-dev` downloads it — MG-21).

## Acceptance criteria

- `app-deploy-dev.yml` + `infra-deploy-dev.yml` exist; `deploy-dev` + the orphaned artifact upload removed from `ci.yml`; remaining jobs pass.
- `infra-deploy-dev` does NO local-state apply; after MG-24 it reconciles the TF-owned dev stack via the persistent dev state key.
- `app-deploy-dev` deploys only after CI success for the commit; dispatch restricted to `develop`; targets the IaC-established Function App name/identity (MG-24 contract), not a hardcoded name.
- Deploy capability preserved, only re-triggered/gated.

## Context

Updated 2026-07-20 for greenfield facts. DEPENDS ON MG-24 (durable dev state + TF-owned dev Function App). Do NOT apply against ephemeral local state; do NOT touch V1.
