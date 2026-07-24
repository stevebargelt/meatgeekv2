---
id: MG-36
type: story
status: active
title: automated dev app-deployment workflow — CI-gated, exact-SHA, dedicated publish identity
created: 2026-07-23
---

## Origin

SPLIT OUT of MG-23 on 2026-07-23. MG-23 was re-scoped to automated dev INFRASTRUCTURE GitOps reconciliation only; this ticket carries the automated dev APPLICATION-deployment work so none of the original MG-23 app-deploy acceptance criteria are lost.

## Depends on

- **MG-21** — the one-off operator-authenticated dev publish + auth-smoke proof MUST succeed first. Any packaging / Flex-deployment / Easy-Auth / runtime problems MG-21 exposes are inputs to this ticket's design.
- MG-24 (done) — TF-owned dev Flex Function App + the dedicated app-publish OIDC identity (AZURE_APP_DEPLOY_CLIENT_ID) + its Website-Contributor-scoped-to-the-FA role.

## Scope

An automated dev app-deployment workflow, trunk-based main (NO develop branch):
- Publishes the API package to the TF-established dev Function App (consume the Terraform function_app_name output / IaC contract — never a hardcoded name).
- CI-gated: deploys only after the CI/CD Pipeline SUCCEEDS for the exact commit; checks out/deploys the exact successful SHA (no bare-push race).
- Authenticates via the dedicated app-PUBLISH identity (AZURE_APP_DEPLOY_CLIENT_ID, Website Contributor scoped to the FA only) through the development GitHub Environment OIDC — NOT the infra plan/apply identities.
- Flex Consumption OneDeploy model (package to the MI blob deployment container); no Azure Files / WEBSITE_RUN_FROM_PACKAGE assumptions.
- environment: development only on the real deploy job; clean skip when not configured.

## Acceptance criteria

- app-deploy-dev workflow exists; deploys only on CI success for the exact SHA; targets the IaC-established FA name/identity (not hardcoded); uses the app-publish identity via development OIDC.
- Deploy capability preserved end-to-end (build -> publish -> function responds) on the Flex dev FA.
- Carries forward the original MG-23 app-deploy ACs (CI-gated not bare-push; dispatch branch-restricted; self-contained build; environment scoping).

## Context

Companion to MG-23 (infra GitOps). Do NOT create a develop branch. Do NOT reuse the infra plan/apply identities for app publish.

## Flex deploy findings from MG-21 (2026-07-23) — proven inputs

The MG-21 manual dev publish exercised the real Flex deploy and surfaced these — the automated workflow MUST account for them:

1. **`func ... publish` needs `--javascript` explicitly.** Azure Functions Core Tools (4.9.0) reads the legacy `FUNCTIONS_WORKER_RUNTIME` app_setting (correctly REMOVED for Flex) and errors `Can't determine project language` / `Worker runtime cannot be 'None'`. The FA's `functionAppConfig.runtime = node/24` is set correctly on the resource; the tool just doesn't read it. Pass `--javascript`.
2. **The deploy package must be SELF-CONTAINED.** The nx webpack build externalizes deps (`@azure/functions`, `@azure/monitor-opentelemetry`, `@opentelemetry/resources`) into a thin `main.js` with **no `node_modules`**, and the emitted `dist/apps/api/package.json` carries the monorepo's **nx build scripts**. Oryx REMOTE build FAILS: `sh: 1: nx: not found` (Oryx runs the package.json build script). So either (a) `npm install --omit=dev --ignore-scripts` into the dist package and deploy self-contained (`--javascript --no-build`), OR (b) emit a clean deployable `package.json` (runtime deps only, no nx scripts) so Oryx can `npm install`. The bare nx `deploy` target (`func azure functionapp publish {fa}`) does NOT work for Flex as-is — this is a real packaging fix the workflow (or the api build target) needs.
3. **PROVEN working method (MG-21):** `nx build api` → `npm install --omit=dev --ignore-scripts` in `dist/apps/api` → `func azure functionapp publish <fa> --javascript --no-build` → 5 functions registered (getDevices/getCurrentTemperatures/negotiate/startCook/stopCook) → authenticated GET `/api/devices` returned HTTP 200 with a real body.
4. **Identity:** MG-21 published as the OPERATOR identity (the app-publish OIDC SP is OIDC-only, no local login). MG-36's automated workflow uses `AZURE_APP_DEPLOY_CLIENT_ID` via the `development` GitHub Environment OIDC — verify it publishes with the corrected method (`--javascript` + self-contained package).
