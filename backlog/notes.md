**Last session ended 2026-07-27. MG-23 activated live end-to-end and CLOSED.**

**Where we left off:** MG-23 (automated dev GitOps reconciliation) is fully LIVE — `DEV_TF_BACKEND_READY=true`, every green-`main` push auto-applies to dev infra, AC7 proven both directions (tag add→apply→CONVERGED→present in Azure; remove→apply→CONVERGED→gone). Closed with an Acceptance Evidence grid (audit `4b0cc75`). Activation surfaced+fixed 3 latent defects the credentialless CI couldn't catch.

**Picked up next (ordered):**
1. **MG-42 — do FIRST, it gates others.** Durable bootstrap fix: derive OIDC fed-cred subjects from the repo's live `sub_claim_prefix` (this repo/account injects owner+repo immutable IDs: `repo:stevebargelt@4857343/meatgeekv2@1304558512`), not hardcoded `repo:${GITHUB_REPO}`. **Hard constraint until it lands: do NOT re-run `bootstrap.sh` — it REVERTS the manually-fixed `development-infra-apply` fed cred back to the broken standard prefix and breaks the live loop.** The `development` (app-deploy) and `production` fed creds are STILL on the broken prefix.
2. **[non-ticket] T6 acceptance test** (allowlist-reconcile live regression) — deferred; run it AFTER MG-42 (T6 re-runs bootstrap). Not a blocker: condition correctness already proven (live condition + T1–T7 pass + bootstrap.test reconcile assertions green).
3. **MG-41** — fix stale MG-23 safety docs still describing the removed PR-plan workflow.
4. **MG-36** (automated dev app-deploy) needs MG-42 first (its `development` cred is broken-prefix). Then **MG-25** (prod activation — same OIDC-prefix fix will apply to prod), **MG-37** (dev telemetry).

**External state to remember:**
- Dev auto-apply loop is LIVE against VSE02 (sub c7e800cb) / `meatgeek-v2-dev-rg`. Apply SP `meatgeek-v2-github-infra-apply-dev` (client 8d7d37cb / obj 1ca5b347). Its fed cred is MANUALLY on the custom prefix — fragile until MG-42.
- Activation fixes on main: OIDC backend auth `094d0ce` (#30 — added ARM_USE_OIDC/CLIENT_ID/TENANT_ID); budget resource_group_id `b9c922f` (#31 — use var.resource_group_id, not the apply-deferred data source).
- Retired dev plan identity (oidc-dev 63432b04 / SP cc58ece1) fully DECOMMISSIONED; `development-infra-plan` env never existed live (404). Both apply environments verified PROTECTED.
- Recovery path wired + env verified but the live destroy-authorization recovery run was never exercised (no destroy arose).

**Decisions worth not relitigating:**
- B7 branch protection on `main` CONSCIOUSLY SKIPPED — not an MG-23 AC; a solo repo can't satisfy required PR reviews, and the apply-path gates (main-only env policy + workflow_run conclusion/head_branch gate + fail-closed destroy-guard + secret-gate) are the real control. Do not re-raise as a blocker.
- Dispatch forge via `/Users/stevebargelt/code/forge-stable/bin/forge` (dev `~/code/forge` WIP breaks the CLI). Present operator decisions as a lettered chat list, not AskUserQuestion. (Both in memory.)
- The MG-23/MG-24 design assumed standard OIDC subjects; this repo's enterprise policy breaks that — MG-42 is the durable fix.

**Shipped (for reference):** MG-23 CLOSED — credentialless PR validation, automatic green-main reconcile via dedicated least-priv infra-apply OIDC identity (conditioned RBAC-Admin allowlist, fail-closed secret + destroy/removal gates, stale-SHA guard, 90m timeout, concurrency), separate manual recovery, RG-scope boundary. Deterministic PR #27; activation fix PRs #30/#31. Filed this session: MG-41 (stale MG-23 docs), MG-42 (bootstrap OIDC prefix); earlier MG-38/39/40.
