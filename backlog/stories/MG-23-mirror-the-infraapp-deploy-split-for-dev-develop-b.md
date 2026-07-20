---
id: MG-23
type: story
status: active
title: mirror the infra/app deploy split for dev (develop branch)
created: 2026-07-19
---

## Problem / policy

Companion to MG-21 (prod split). Apply the same standalone-workflow split to the dev/`develop` environment. DEPENDS ON MG-24 for anything that applies infra — dev terraform has the SAME empty-local-state hazard as prod.

## Scope

Two standalone workflows, remove `deploy-dev` from `ci.yml`:

- **`app-deploy-dev`** — mirror `app-deploy-prod` WITH its corrective safety (see MG-21): gated on CI success for the commit (`workflow_run`, not a bare push race), `environment: development` only on the real deploy job (not the guard), `workflow_dispatch` restricted to `refs/heads/develop`, credential-skip guard on `AZURE_CREDENTIALS`, self-contained build. Deploys the dev app surface (dev deploys web too, per current `deploy-dev` — confirm API+web for dev).
- **`infra-deploy-dev`** — dev Terraform. MUST NOT auto-apply against empty local state: keep it **plan-only / `workflow_dispatch`-only** until MG-24 establishes and validates dev remote state, exactly as MG-21 does for prod. Add the `push`+`apps/infrastructure/**` auto-apply trigger ONLY as part of / after MG-24.
- Remove `deploy-dev` from `ci.yml`. When it goes, ALSO remove the now-orphaned build-artifact upload from `ci.yml`'s build-typescript job (retained today only because `deploy-dev` downloads it — MG-21).

## Acceptance criteria

- `app-deploy-dev.yml` + `infra-deploy-dev.yml` exist; `deploy-dev` and (with it) the build-artifact upload removed from `ci.yml`; remaining jobs pass.
- `app-deploy-dev` deploys only after CI quality jobs succeed for the commit; `environment` only on the deploy job; dispatch restricted to `refs/heads/develop`; credential-skip guard.
- `infra-deploy-dev` does NO local-state `terraform apply` — plan-only/dispatch-only until MG-24 (this ticket depends on MG-24 for dev auto-apply).
- Deploy capability preserved, only re-triggered/gated.

## Context

Filed 2026-07-19 as the dev half. AC expanded per external review: dev must not ship the same unsafe empty-state auto-apply — depend on MG-24 or stay plan-only; and mirror MG-21's app-deploy corrective safety (CI-gating, ref-enforcement, guard-env fix).
