---
id: MG-25
type: story
status: active
title: "production activation: add prod-env secret + enable PROD_DEPLOY_ENABLED (gated on infra+security)"
created: 2026-07-20
---

## Problem

Production deployment must NOT be activated until production infrastructure and security are ready. Updated 2026-07-20: **production is also GREENFIELD — nothing to import.** V2 has no prod infrastructure; V1 is out of scope. Prod is created later from an independent empty prod state.

## Scope — production activation, in order (all gated)

1. **Prerequisites (do NOT activate before these):**
   - **MG-24 complete** for production: create prod from an **independent EMPTY prod state** (`meatgeek-v2/prod.tfstate`) — greenfield, no import. This requires a **reviewed production creation plan** (human review for scope/security/cost) and a successful apply that creates the complete V2 prod stack including the Function App, then a no-op re-plan.
   - **Production security readiness** reviewed (least-privilege deployment identity/OIDC for prod, secret scoping, environment protection posture, required approvals).
2. **Add the production credential only when ready** — `AZURE_CREDENTIALS_PROD` as a GitHub `production`-ENVIRONMENT secret, least-privilege.
3. **Set `PROD_DEPLOY_ENABLED=true` LAST** — only after 1 and 2. Until it flips, `app-deploy-prod`'s `deploy-api` job skips cleanly on every CI success.

## Acceptance criteria

- Prod V2 stack created greenfield from empty prod state via a reviewed creation plan (MG-24 for prod); no V1 import; second plan no-op.
- Production security readiness reviewed and recorded.
- `AZURE_CREDENTIALS_PROD` present as a production-environment secret, least-privilege scope.
- `PROD_DEPLOY_ENABLED=true` set only after the above (LAST step); first real prod deploy publishes and a prod endpoint smoke-tests green.

## Context

Split from MG-21 corrective (2026-07-19); updated 2026-07-20 for greenfield facts. DEPENDS ON MG-24 (greenfield prod stack) + security readiness + reviewed prod creation plan. Do NOT import V1; do NOT enable prod deploy early.
