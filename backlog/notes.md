**Session 2026-07-20.**

**AZURE FACTS (authoritative):** V2 is GREENFIELD — no V2 Azure infra exists (`meatgeek-dev-rg` deleted); all remaining MeatGeek Azure resources are V1, OUT OF SCOPE (never import/touch/modify). No V2 migration, no state to recover. HARD SAFETY: never touch/import V1; no terraform apply against local/ephemeral state; no manual Azure resource creation to satisfy proofs; no prod deploy enabled.

**CRITICAL PATH — where we are:**

1. **MG-24 (greenfield V2 infra) — DETERMINISTIC LAYER MERGED (main `21be588`, PR #4). STILL OPEN.** Shipped + reviewed (6 red-wide rounds + green CI): remote-state backend + OIDC identity bootstrap; per-env isolated state (`meatgeek-v2/dev.tfstate`, `prod.tfstate`); no hardcoded subscription id; V2 naming `meatgeek-v2-${env}-*`; V2 OWNS its Cosmos; no `timestamp()` drift; FA-name single source; **managed identity across all services, NO avoidable secrets in state** (Cosmos/Storage/IoT-Hub/SignalR identity-based; App Insights via AAD/Monitoring-Metrics-Publisher, endpoint-only conn string); **Easy-Auth default-deny** (require auth on all endpoints, no anonymous business/health); wildcard-CORS removed (per-env origins); static V1-safety gate (FAILS on local *.tfstate); dev+prod SEPARATE OIDC federated identities (subjects `repo:<owner>/<repo>:environment:development|production`); CI plan-only. Accepted residual (ADR `learnings/decisions/mg-24-appinsights-key-in-terraform-state.md`): the AI resource's own computed key attribute is inherently in state — accepted (telemetry-write-only, AAD auth, restricted state).
   **REMAINING (operator, out-of-band) → the ONLY thing gating everything downstream:** run the greenfield bootstrap + dev `plan`/`apply` per `docs/infrastructure/bootstrap-runbook.md`: bootstrap state-storage + OIDC identity → `terraform plan` (empty dev state) → HUMAN review (scope/security/cost) → `apply` (creates V2 dev stack incl. Function App) → 2nd plan no-op → representative change → incremental plan/apply → no-op. Capture state key + plan/apply evidence + resource inventory. This closes MG-24 AND creates the dev Function App MG-21 needs.

2. **MG-21 (prod deploy corrective) — OPEN, blocked on MG-24.** Config MERGED (`3dd4165`, workflow_run CI-gated + PROD_DEPLOY_ENABLED + TOCTOU-safe stale-SHA guard + managed-identity Functions package + valid package). Closing evidence = deploy commit `3dd4165`'s package to the **MG-24-created dev Function App** (dev creds), AUTHENTICATED smoke test, capture invocation log. Do NOT manually create a Function App. `PROD_DEPLOY_ENABLED` stays DISABLED. Checklist on ticket.

3. **MG-23 (dev deploy split) — OPEN, depends on MG-24.** infra-deploy-dev plan-only until MG-24; then reconcile TF-owned dev stack via persistent dev state; app-deploy-dev targets the IaC FA name/identity; remove deploy-dev + orphaned artifact upload from ci.yml.

4. **MG-25 (prod activation) — OPEN, greenfield, depends on MG-24 + security.** Create prod from empty prod state via a reviewed creation plan; add prod-env secret; set `PROD_DEPLOY_ENABLED=true` LAST.

5. **Feature work (after infra):** MG-9 (data-models, cleanest start), MG-14 (Phase 2 SignalR), MG-6 (OTel).

**Shipped this session:** MG-20 (npm pin) + MG-22 (nx-set-shas) — PR #1 `56b0038`. MG-21 first split (reopened) — PR #2 `dc5df4d`. MG-21 corrective — PR #3 `3dd4165`. MG-24 greenfield deterministic layer — PR #4 `21be588`.

**External state:** GitHub PUBLIC; branch protection on `main` (setup, lint-and-test x4, build-typescript x2, build-go x2, validate-infrastructure, security-scan; deploy EXCLUDED). Prod creds ABSENT + PROD_DEPLOY_ENABLED unset (app-deploy-prod skips). Prod API-only.

**Ops notes:** (1) `forge review-loop` HANGS on host-side local verification here (nx isolation plugin-worker) — use `forge invoke red-wide` (container) + green PR CI as the review gate. (2) Use **Monitor** on launched work for prompt completion — don't rely on fixed ScheduleWakeup ticks. (3) The feature pipeline's build task goes 'complete' + can't be gated back; drive fix rounds via direct engineer + red-wide instead.

**Decisions not to relitigate:** V2 GREENFIELD; MG-24 keeps App Insights TF-managed with the accepted key-in-state residual (ADR); MG-21 corrective = workflow_run CI-gating + env-secret + PROD_DEPLOY_ENABLED (not a guard job); dev proof (authenticated) closes MG-21; prod activation = MG-25 (enable var LAST). Interim durable-dispatch rule (forge launch run + Monitor) until FG-552/562/563.

**Older shipped:** MG-15/16/17/18/19.
