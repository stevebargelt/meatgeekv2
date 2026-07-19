---
id: MG-22
type: story
status: done
title: fix Nx affected base on PR CI (git diff main fails in PR checkout)
created: 2026-07-18
closed: 2026-07-18
closed_commit: 56b003804e8e11b056ad5e0346f16905656d7d81
---

## Problem

The CI `setup` job's "Get affected projects" step runs `npx nx show projects --affected`, which resolves to `git diff --name-only --no-renames --relative "main" "HEAD"`. On a **pull-request** checkout the local `main` branch ref does not exist (only `origin/main` is fetched), so the command fails:

```
fatal: ambiguous argument 'main': unknown revision or path not in the working tree.
NX Command failed: git diff --name-only --no-renames --relative "main" "HEAD"
```

This fails the required `setup` check, which cascades skips to `build-typescript` and `lint-and-test`. It blocks **every** pull request, not just any one change.

## Why it surfaced now

The repo previously pushed directly to `main`, where the `main` ref exists and the diff resolves. MG-20's PR (#1) is the first PR to run CI, exposing the latent bug. Nx's `defaultBase` (likely `main` in `nx.json`) is not valid in a PR checkout context.

## Candidate fixes (decide approach)

- Add `nrwl/nx-set-shas@v4` to compute `NX_BASE`/`NX_HEAD` correctly for both `push` and `pull_request` (Nx-recommended).
- Or point the base at `origin/main` (fetch-depth is already 0), e.g. `nx.json` `defaultBase: "origin/main"` or an explicit `--base=origin/main`.
- Or materialize a local `main` ref in the workflow before the affected step.

## Acceptance criteria

- A pull request's `setup` job computes affected projects successfully (no `unknown revision 'main'` error).
- `build-typescript` and `lint-and-test` run (not skipped) on a PR that touches their projects.
- Direct pushes to `main` still compute affected projects correctly.
- CI green on a PR after the fix.

## Context

Blocks MG-20 merge (PR #1). Filed while MG-20's npm-pin change itself is correct and green on the runner.
