---
id: MG-23
type: story
status: active
title: mirror the infra/app deploy split for dev (develop branch)
created: 2026-07-19
---

## Problem / policy

Companion to MG-21 (prod split). Apply the same standalone-workflow split to the dev/`develop` environment so dev deployment matches prod's model. Depends on MG-21 landing first (shares the workflow patterns).

## Scope

Two standalone workflows, and remove `deploy-dev` from `ci.yml`:

- **`infra-deploy-dev`** — trigger: `push` to `develop` filtered to `paths: [apps/infrastructure/**]`, plus `workflow_dispatch`. Runs `terraform init/plan/apply` (dev.tfvars) with `AZURE_CREDENTIALS`. Merge = approval; no mandatory reviewer.
- **`app-deploy-dev`** — trigger: `push` to `develop` filtered to `paths: [apps/api/**, apps/web/**, libs/**]`, plus `workflow_dispatch`. Builds own artifacts, deploys Functions API + web app (dev).

Same design constraints as MG-21: self-contained builds, credential-presence skip guard, per-env concurrency guard.

## Acceptance criteria

- `.github/workflows/infra-deploy-dev.yml` and `app-deploy-dev.yml` exist with the triggers/paths above and `workflow_dispatch`.
- Each skips cleanly when its Azure secret is absent; each has an env-scoped concurrency guard.
- `ci.yml` no longer contains `deploy-dev`; all remaining jobs pass.
- A push to `develop` touching infra paths schedules `infra-deploy-dev`; touching app paths schedules `app-deploy-dev`; a develop push touching neither triggers neither.
- Deploy capability preserved, only re-triggered/gated.

## Context

Filed 2026-07-19 as the dev half of the deploy-split policy. Sequence after MG-21.
