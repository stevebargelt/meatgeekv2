---
id: MG-21
type: story
status: done
title: split prod deploy into standalone infra + app workflows (path-triggered)
created: 2026-07-18
closed: 2026-07-24
closed_commit: 6fb7df9
---

## Status

REOPENED 2026-07-19 after an external P1/P2 review. The split + red-on-push fix SHIPPED (merge `dc5df4d`, PR #2) but the prod workflows are NOT production-ready and MG-21 was closed prematurely. Corrective spec (operator-approved, Option A) below. **MG-21 stays OPEN until the exact packaged artifact is successfully deployed to a dev Function App (operator-triggered credentialed proof, req 8).** Prod creds are currently ABSENT — nothing is live. **UPDATE 2026-07-19:** corrective config + packaging MERGED to main as `3dd4165` (PR #3), including the TOCTOU stale-SHA fix (freshness re-checked immediately before deploy). All deterministic parts (workflow_run CI-gating, PROD_DEPLOY_ENABLED gate, head_sha checkout, TOCTOU-safe stale-SHA guard, no dispatch, no guard job, env only on deploy job, pinned func@4.12.1, valid Functions package) are done and reviewed (red-wide pass + green CI). REMAINING closing evidence = the operator's credentialed dev Function App deploy of the exact packaged artifact (req 8).

## Corrective requirements (operator-specified)

1. **CI-gated trigger (regression fix).** `app-deploy-prod` triggers via `on: workflow_run` ONLY when ALL hold: workflow name == `CI/CD Pipeline`; `action`==`completed`; upstream `event`==`push`; upstream `head_branch`==`main`; upstream `conclusion`==`success`. (Restores the old `needs: [lint-and-test, build-typescript, build-go, validate-infrastructure]` gate that the split dropped.)
2. **Deploy the CI'd SHA explicitly.** Checkout & deploy `github.event.workflow_run.head_sha` — never rely on `workflow_run`'s default checkout ref.
3. **Stale-SHA guard.** Before deploying, verify `workflow_run.head_sha` is STILL the current `main` tip; if `main` has advanced, do NOT deploy the stale SHA (abort/skip). (Rollback is a separate, deliberately-designed mechanism, not this.)
4. **No `workflow_dispatch` on `app-deploy-prod`.** Dispatch restricted to `main` still bypasses the CI gate; GitHub's re-run of a failed deploy is the retry path. Remove it entirely from the app workflow.
5. **Env-secret + variable gate (replaces the guard job).** `AZURE_CREDENTIALS_PROD` stored as a **production-environment secret** (operator setup). REMOVE the credential-presence guard job. Add a repository variable **`PROD_DEPLOY_ENABLED`** (operator setup) and gate the real deploy job on `vars.PROD_DEPLOY_ENABLED == 'true'`. Keep `environment: production` ONLY on the real deploy job (no false-deployment record when gated off).
6. **Pin Azure Functions Core Tools reproducibly** — a pinned version, not runner-preinstalled or a floating global.
7. **Valid deployment package.** `nx build api` output at the artifact root must be a deployable Functions package: `host.json` + `package.json` present AND all paths inside them correct RELATIVE TO THE ARTIFACT ROOT (scriptFile/extensionBundle/main etc.). Merely copying the files in is insufficient.
8. **Land deterministic config + packaging checks now; keep MG-21 OPEN** until the exact packaged artifact (commit `3dd4165`) is deployed to the **dev** Function App using DEV credentials and a real endpoint is smoke-tested. That dev integration proof is the ONLY closing evidence for MG-21. `PROD_DEPLOY_ENABLED` stays **DISABLED** throughout — it is not needed to prove the package. Adding the production-environment `AZURE_CREDENTIALS_PROD` secret and enabling `PROD_DEPLOY_ENABLED` are SEPARATE production-activation steps (tracked in MG-25), performed later once prod infrastructure (MG-24) and security are ready, with the enable variable set LAST.

## Also (this ticket, infra workflow)

- `infra-deploy-prod`: NO `terraform apply` against local state — plan-only until MG-24. Keep `workflow_dispatch` (manual/recovery), plan-only.

## Acceptance criteria

- `app-deploy-prod.yml` triggers via `workflow_run` on `CI/CD Pipeline` with the full 5-condition gate (req 1); checks out/deploys `workflow_run.head_sha` (req 2); has a stale-SHA guard that skips if `head_sha` != current `main` (req 3); has NO `workflow_dispatch` (req 4).
- No credential-guard job remains; the deploy job is gated on `vars.PROD_DEPLOY_ENABLED == 'true'` and carries `environment: production`; nothing else carries an `environment` (req 5). (Operator sets the env secret + the variable.)
- Azure Functions Core Tools pinned to an explicit version (req 6).
- The built `dist/apps/api` artifact is a valid Functions package with correct internal relative paths — verified by a deterministic packaging check/test (req 7).
- Deterministic config + packaging checks committed and green; guard/stale-SHA/gating logic covered by `prod-deploy-split.spec.ts`.
- `infra-deploy-prod` is plan-only (no local-state apply).
- MG-21 remains OPEN pending the operator's successful DEV Function App deploy (dev creds) of the exact packaged artifact + a real-endpoint smoke test (req 8) — that dev proof is the closing evidence. Prod-secret + PROD_DEPLOY_ENABLED enable are NOT part of closing MG-21 (that is MG-25, production activation).

## Publish path for the dev proof (operator-decided 2026-07-20)

The manual MG-21 dev integration proof publishes with the OPERATOR's OWN authenticated dev session (`az login` as your dev identity → `nx build api` → `func publish` / `nx deploy api --env=dev` to the MG-24-created dev Function App). This proves the exact packaged artifact deploys and the AUTHENTICATED endpoint responds. The app-deploy OIDC service principal + its Website Contributor role (created by MG-24) is the AUTOMATED/CI deploy path — it is OIDC-only (no local login) and is exercised for real when MG-23's `app-deploy-dev` workflow lands; it is NOT used for this manual proof.

## Dependency (2026-07-20 — greenfield Azure facts)

MeatGeek V2 has NO Azure dev infrastructure now (`meatgeek-dev-rg` was deleted; remaining MeatGeek resources are V1, out of scope). So MG-21's dev proof **DEPENDS ON MG-24** first creating the Terraform-owned V2 **dev** stack including the dev Function App. Sequence: MG-24 creates the dev Function App via IaC → then deploy commit `3dd4165`'s verified package to THAT Terraform-created Function App → smoke-test + capture the invocation log → MG-21 closes. **Do NOT manually create a proof Function App outside Terraform.** `PROD_DEPLOY_ENABLED` stays DISABLED throughout.

## Closing evidence checklist (req 8 — dev integration proof)

MG-21 closes only when the operator captures ALL of the following for the DEV deploy (attach to the ticket). `PROD_DEPLOY_ENABLED` stays DISABLED throughout.

- [ ] **Commit SHA** — `3dd4165` (the exact commit whose package is deployed).
- [ ] **Exact build/publish command(s)** run (e.g. `npx nx build api` then `nx deploy api --env=dev` / `func azure functionapp publish <MG-24-terraform-created dev Function App>` from `dist/apps/api`).
- [ ] **Successful publish result** — the publish command's success output (uploaded/deployed confirmation).
- [ ] **Dev endpoint + HTTP status + representative response** — smoke-test an AUTHENTICATED dev request (MG-24 hardens the Function App: no anonymous business endpoints, no wildcard CORS). Capture the URL, the auth method used, the HTTP status (e.g. 200 for the authenticated call; confirm an UNauthenticated call returns 401/403), and a representative response body. Do NOT assume an anonymous endpoint.
- [ ] **Timestamp + corresponding Azure invocation log** — the time of the smoke test and the matching Azure Functions invocation log entry proving the request hit the deployed function.

## Context (prod activation)

Production credentials and activation are NOT part of this checklist and NOT part of closing MG-21 — they live in **MG-25** (add `AZURE_CREDENTIALS_PROD` production-environment secret, then set `PROD_DEPLOY_ENABLED=true` LAST), gated on MG-24 (prod infra + validated remote state) and security hardening.

## Context

Reopened per external review 2026-07-19; requirements refined by operator (Option A: `workflow_run` CI-gating). State-migration + dev auto-apply are MG-24/MG-23 (AC already expanded).
