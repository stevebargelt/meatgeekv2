---
id: MG-39
type: story
status: active
title: "urgent supply-chain: pin snyk@master + remove SNYK_TOKEN from PR-executed code; pin Terraform providers in all CI-invoked modules"
created: 2026-07-27
---

## Problem (urgent, split out of MG-23)

Supply-chain exposures surfaced during MG-23 review. Kept OUT of MG-23 per operator direction; MG-23 must not carry repo-wide supply-chain work.

1. **`snyk@master` runs with a secret on PR triggers.** `security-scan` in `.github/workflows/ci.yml` uses `uses: snyk/actions/node@master` (mutable branch) with `secrets.SNYK_TOKEN` on `pull_request` — a PR-executed mutable third-party action with a secret is a token-exfiltration path. Its substantive steps also carry `continue-on-error: true` (green regardless of findings).
2. **Unpinned Terraform provider in a CI-executed module.** `apps/infrastructure/modules/monitoring` has no azurerm version constraint + gitignored lock, yet CI runs `terraform init`+`test` there each PR/push.
3. **Production deployment executes mutable third-party action tags after granting an Azure OIDC identity.** `infra-deploy-prod.yml` / `app-deploy-prod.yml` use non-SHA-pinned `uses:` on jobs that hold `id-token: write` + azure/login — a supply-chain path onto a privileged prod identity. (Surfaced by red-security on the MG-23 run; MG-23 touches these files for prose only, so pinning them is MG-39.)

## Acceptance criteria

- `snyk/actions/node` SHA-pinned (or removed from PR-executed context); `SNYK_TOKEN` unreachable by PR-executed code; re-evaluate the `continue-on-error: true` masking.
- Every CI-invoked terraform module has a committed multi-platform `.terraform.lock.hcl` + explicit provider constraint (modules/monitoring specifically); a static check fails when a CI-invoked module lacks a lock.
- Every `uses:` on any workflow job that holds `id-token: write` / azure/login (prod infra + app deploy) is SHA-pinned to an immutable commit.

## Priority

URGENT — the PR-executed `snyk@master`+secret path is live today; pin it first.

## Context

Split from MG-23 per operator direction 2026-07-27. Independent of MG-23.
