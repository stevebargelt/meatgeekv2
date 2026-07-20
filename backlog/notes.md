**Session updated 2026-07-20.**

**AUTHORITATIVE AZURE FACTS (2026-07-20):** `meatgeek-dev-rg` was deliberately DELETED. MeatGeek **V2 has NO Azure dev or prod infrastructure**. All remaining MeatGeek Azure resources are the OLD **V1** system — OUT OF SCOPE (do NOT import/adopt/modify/rename/delete). No V2 brownfield migration, no V2 state to recover. **Everything V2 is GREENFIELD** — after a minimal state/identity bootstrap the repo creates the complete V2 environment from empty state; subsequent runs load durable remote state and reconcile incrementally.

**HARD SAFETY:** don't touch any V1 resource; don't import V1 into V2 state; don't `terraform apply` with ephemeral local state; don't create Azure resources manually to satisfy MG-21; don't enable prod deploy.

**Critical path / dependency order:**
1. **MG-24 (KEYSTONE, greenfield V2 infra bootstrap)** — remote-state storage + OIDC identity + repeatable bootstrap; per-env isolated state (`meatgeek-v2/dev.tfstate`, `prod.tfstate`); de-hardcode subscription id; V2 naming `meatgeek-v2-${env}-*`; V2 owns its Cosmos (drop V1 shared account dep); remove `timestamp()` tag drift; align Function App naming across TF/Nx/workflows; CI apply DISABLED until backend+greenfield plan ready. Greenfield DEV proof: empty state → plan → human review → apply creates full dev stack (incl. Function App) → 2nd plan no-op → representative change → incremental plan/apply → no-op; capture state key + plan/apply evidence + resource inventory. Deterministic Terraform+bootstrap = pipeline; the credentialed bootstrap+plan/apply = operator-gated.
2. **MG-21 (open)** — dev integration proof now DEPENDS ON MG-24 creating the TF-owned V2 dev Function App. After the dev stack exists: deploy commit `3dd4165`'s verified package to THAT Terraform-created Function App, smoke-test a real endpoint, capture the invocation log. Do NOT manually create a proof Function App outside Terraform. `PROD_DEPLOY_ENABLED` stays DISABLED. Closing checklist (on ticket): SHA 3dd4165, exact build/publish cmd, publish result, endpoint+HTTP status+response, timestamp + Azure invocation log.
3. **MG-23** — dev deploy split; `infra-deploy-dev` plan-only/non-applying until MG-24, then reconcile the TF-owned dev stack via persistent dev state; `app-deploy-dev` targets the IaC-established Function App name/identity (no hardcoded name). Depends on MG-24.
4. **MG-25** — production activation, also greenfield (nothing to import): create prod later from independent empty prod state via a reviewed creation plan; gate on MG-24 + prod security readiness; add prod-env credential when ready; set `PROD_DEPLOY_ENABLED=true` LAST.
5. **Feature work** (after infra unblocks) — MG-9 (data-models, cleanest start), MG-14 (Phase 2 SignalR), MG-6 (OTel).

**Next action:** route MG-24 (greenfield infra bootstrap) through the Forge feature pipeline (architect → tech-lead → engineer → test-engineer+reds → docs) for the deterministic Terraform + bootstrap procedure; the real Azure bootstrap + dev plan/apply is operator-gated.

**MG-21 corrective (MERGED, main `3dd4165`, PR #3) — done + post-merge-verified:** app-deploy-prod is workflow_run CI-gated + `PROD_DEPLOY_ENABLED` gate + `head_sha` checkout + TOCTOU-safe stale-SHA guard + no dispatch + no guard job + env only on deploy job + pinned func 4.12.1 + valid Functions package. Post-merge: CI green; Deploy Prod App SKIPPED (gated off, no false deployment); infra-deploy-prod didn't fire. infra-deploy-prod is plan-only.

**Shipped this session:** MG-20 (npm pin) + MG-22 (nx-set-shas) — PR #1 `56b0038`. First MG-21 split (reopened) — PR #2 `dc5df4d`. MG-21 corrective — PR #3 `3dd4165`.

**External state:** GitHub PUBLIC; branch protection on `main` = setup, lint-and-test x4, build-typescript x2, build-go x2, validate-infrastructure, security-scan (deploy EXCLUDED, enforce_admins off). Prod creds ABSENT + `PROD_DEPLOY_ENABLED` unset (app-deploy-prod skips). Prod is API-only.

**Ops notes:** (1) `forge review-loop` HANGS on host-side local verification here (nx isolation plugin-worker) — use `forge invoke red-wide` (container) + green PR CI as the review gate. (2) Use a **Monitor** on launched work for prompt completion — don't rely on fixed ScheduleWakeup ticks.

**Decisions not to relitigate:** V2 is GREENFIELD (2026-07-20). MG-21 corrective = operator Option A (workflow_run CI-gating), env-secret + PROD_DEPLOY_ENABLED (not a guard job), no dispatch on app deploy, infra plan-only until MG-24. Dev proof closes MG-21 (gated on MG-24's TF dev Function App); prod activation = MG-25 (enable variable LAST). Interim durable-dispatch rule (forge launch run + Monitor) until FG-552/562/563.

**Older shipped:** MG-15/16/17/18/19.
