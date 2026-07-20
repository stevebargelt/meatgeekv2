---
id: MG-21
type: story
status: active
title: split prod deploy into standalone infra + app workflows (path-triggered)
created: 2026-07-18
---

## Status

REOPENED 2026-07-19 after an external P1/P2 review. The split + red-on-push fix SHIPPED (merge `dc5df4d`, PR #2) but the prod workflows are NOT production-ready and MG-21 was closed prematurely. Corrective spec (operator-approved, Option A) below. **MG-21 stays OPEN until the exact packaged artifact is successfully deployed to a dev Function App (operator-triggered credentialed proof, req 8).** Prod creds are currently ABSENT — nothing is live.

## Corrective requirements (operator-specified)

1. **CI-gated trigger (regression fix).** `app-deploy-prod` triggers via `on: workflow_run` ONLY when ALL hold: workflow name == `CI/CD Pipeline`; `action`==`completed`; upstream `event`==`push`; upstream `head_branch`==`main`; upstream `conclusion`==`success`. (Restores the old `needs: [lint-and-test, build-typescript, build-go, validate-infrastructure]` gate that the split dropped.)
2. **Deploy the CI'd SHA explicitly.** Checkout & deploy `github.event.workflow_run.head_sha` — never rely on `workflow_run`'s default checkout ref.
3. **Stale-SHA guard.** Before deploying, verify `workflow_run.head_sha` is STILL the current `main` tip; if `main` has advanced, do NOT deploy the stale SHA (abort/skip). (Rollback is a separate, deliberately-designed mechanism, not this.)
4. **No `workflow_dispatch` on `app-deploy-prod`.** Dispatch restricted to `main` still bypasses the CI gate; GitHub's re-run of a failed deploy is the retry path. Remove it entirely from the app workflow.
5. **Env-secret + variable gate (replaces the guard job).** `AZURE_CREDENTIALS_PROD` stored as a **production-environment secret** (operator setup). REMOVE the credential-presence guard job. Add a repository variable **`PROD_DEPLOY_ENABLED`** (operator setup) and gate the real deploy job on `vars.PROD_DEPLOY_ENABLED == 'true'`. Keep `environment: production` ONLY on the real deploy job (no false-deployment record when gated off).
6. **Pin Azure Functions Core Tools reproducibly** — a pinned version, not runner-preinstalled or a floating global.
7. **Valid deployment package.** `nx build api` output at the artifact root must be a deployable Functions package: `host.json` + `package.json` present AND all paths inside them correct RELATIVE TO THE ARTIFACT ROOT (scriptFile/extensionBundle/main etc.). Merely copying the files in is insufficient.
8. **Land deterministic config + packaging checks now; keep MG-21 OPEN** until the exact packaged artifact is successfully deployed to a dev Function App using the SAME deploy mechanism. Operator triggers that credentialed integration proof.

## Also (this ticket, infra workflow)

- `infra-deploy-prod`: NO `terraform apply` against local state — plan-only until MG-24. Keep `workflow_dispatch` (manual/recovery), plan-only.

## Acceptance criteria

- `app-deploy-prod.yml` triggers via `workflow_run` on `CI/CD Pipeline` with the full 5-condition gate (req 1); checks out/deploys `workflow_run.head_sha` (req 2); has a stale-SHA guard that skips if `head_sha` != current `main` (req 3); has NO `workflow_dispatch` (req 4).
- No credential-guard job remains; the deploy job is gated on `vars.PROD_DEPLOY_ENABLED == 'true'` and carries `environment: production`; nothing else carries an `environment` (req 5). (Operator sets the env secret + the variable.)
- Azure Functions Core Tools pinned to an explicit version (req 6).
- The built `dist/apps/api` artifact is a valid Functions package with correct internal relative paths — verified by a deterministic packaging check/test (req 7).
- Deterministic config + packaging checks committed and green; guard/stale-SHA/gating logic covered by `prod-deploy-split.spec.ts`.
- `infra-deploy-prod` is plan-only (no local-state apply).
- MG-21 remains OPEN pending the operator's successful dev Function App deploy of the exact packaged artifact (req 8) — that is the closing evidence.

## Context

Reopened per external review 2026-07-19; requirements refined by operator (Option A: `workflow_run` CI-gating). State-migration + dev auto-apply are MG-24/MG-23 (AC already expanded).
