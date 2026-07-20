**Session 2026-07-19.**

**MG-21 — prod deploy split + CORRECTIVE hardening: in flight (PR #3, tip 2129a7d), NOT yet merged, stays OPEN after merge.**
An external P1/P2 review reopened the first MG-21 shipment (it had shipped a CI-gating regression + overclaimed deploy capability). The corrective round (operator Option A + 8-point spec) hardens the prod workflows:
- `app-deploy-prod.yml` — triggers via `workflow_run` on **CI/CD Pipeline** completion, deploys ONLY when that run's conclusion==success/event==push/head_branch==main AND repo variable **`PROD_DEPLOY_ENABLED`=='true'**. Checks out `workflow_run.head_sha`; **stale-SHA guard** re-verified immediately before deploy (TOCTOU closed — deploy gates on both an initial and a final freshness check). NO `workflow_dispatch` (retry via GitHub re-run). NO credential-guard job; `environment: production` only on the deploy job. `AZURE_CREDENTIALS_PROD` must be a **production-ENVIRONMENT secret**. Azure Functions Core Tools pinned (4.12.1). Builds + verifies a valid Functions package (`apps/api/host.json`+`package.json`, `tools/verify-func-package.js`).
- `infra-deploy-prod.yml` — **plan-only** (no `terraform apply`), dispatch-only, pending MG-24.
- Tests: `prod-deploy-split.spec.ts` (new-model assertions) + `verify-func-package.spec.ts`. Docs reconciled (ci-cd, nx-commands, terraform-setup, azure-functions, plan).

**Remaining to close MG-21 (req 8 — operator-gated):** the deterministic config+packaging is done; the closing EVIDENCE is a credentialed **dev Function App deploy** of the exact packaged `dist/apps/api` — operator-triggered. Operator actions when ready:
1. Store `AZURE_CREDENTIALS_PROD` as a **production-environment** secret.
2. Set repo variable `PROD_DEPLOY_ENABLED=true`.
3. Run a dev Function App deploy (`nx deploy api` / `func publish`) to prove the package publishes, then report back → MG-21 closes.

**Follow-ups (AC expanded per the review):**
- **MG-23** — dev deploy split; dev infra plan-only until MG-24 (no unsafe empty-state auto-apply); mirror app-deploy safety; remove the now-orphaned artifact upload when `deploy-dev` leaves ci.yml.
- **MG-24** — wire terraform azurerm remote backend, MIGRATE/IMPORT authoritative state (a fresh empty backend still recreates infra), prove a no-recreate first plan, THEN enable infra auto-apply-on-merge. Also align infra-deploy-prod's guard/env model (residual of review finding #6).
- **Feature work** — MG-9 (data-models, cleanest start), MG-14 (Phase 2 SignalR), MG-6 (OTel).

**Shipped earlier this session:** MG-20 (npm pin 10.9.8 + corepack), MG-22 (nx-set-shas PR-CI fix) — PR #1 `56b0038`. The FIRST MG-21 split (later reopened) — PR #2 `dc5df4d`.

**External state:** GitHub PUBLIC; branch protection on `main` requires setup, lint-and-test x4, build-typescript x2, build-go x2, validate-infrastructure, security-scan (deploy EXCLUDED, enforce_admins off). Prod creds ABSENT (app-deploy-prod skips green). Prod is API-only. Terraform on LOCAL state (MG-24).

**Ops note:** `forge review-loop` HANGS on this repo's host-side local verification (nx plugin-worker stall) — used `forge invoke red-wide` (container) + green PR CI as the review gate instead. If review-loop is needed later, watch for the hang.

**Decisions not to relitigate:** MG-21 corrective = operator Option A (workflow_run CI-gating), env-secret + PROD_DEPLOY_ENABLED variable (not a credential-guard job), no dispatch on app deploy, infra plan-only until MG-24. Binding interim durable-dispatch rule still in effect (forge launch run + ScheduleWakeup) until FG-552/562/563.

**Older shipped:** MG-15/16/17/18/19.
