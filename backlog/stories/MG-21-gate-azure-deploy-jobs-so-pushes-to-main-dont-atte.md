---
id: MG-21
type: story
status: active
title: gate Azure deploy jobs so pushes to main don't attempt prod deploy
created: 2026-07-18
---

## Problem

`deploy-prod` (and related Azure deploy jobs) run on every push to `main` but have no Azure credentials, so they FAIL every time. They are excluded from the branch-protection merge gate so they don't block, but every otherwise-green run shows an overall red status, and each push blindly attempts a production deploy.

## Fix

Gate the Azure deploy jobs so they only run when appropriate:
- Condition the deploy jobs on presence of Azure credentials / an explicit deploy trigger (e.g. `if:` guarded on a secret, a tag, a manual `workflow_dispatch`, or an environment gate) rather than firing on every `push` to `main`.
- Ensure a normal push to `main` produces an all-green run with no attempted prod deploy.

## Acceptance criteria

- A push to `main` no longer triggers a failing `deploy-prod` job (job is skipped or not scheduled without deploy context).
- Overall CI status for a clean push to `main` is green (no red from ungated deploy jobs).
- Deploy path still runs when the intended deploy trigger/credentials are present (deploy capability not removed, only gated).

## Context

Refiled — a prior session's HEAD commit subject claimed to file this as "MG-21" but the ticket never persisted in the backlog.
