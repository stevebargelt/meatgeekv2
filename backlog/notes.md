SESSION 2026-07-22 — external-operational-review corrections COMPLETE. All 6 findings from the operator's review are shipped:
- F1/F5/F6 (bootstrap: valid emitted HCL + HCL-validation test + CI-gated bootstrap tests + fail-loud ||die + bounded RBAC poll replacing blind sleep) = MG-32, merged 24b4e38, CLOSED. Bootstrap is now SAFE to run.
- F2/F3/F4 (Go OTLP->OTel Collector [operator-chosen], NOT App Insights ingestion; per-reading W3C root span + traceparent persisted in durable queue record; docs distinguish implemented scaffolding vs operational) = MG-33, merged 11ad979 (PR#15), CLOSED. red-wide converged at r8 PASS after an 8-round doc-overclaim sweep of observability.md; CI green.

REMAINING — all operator/live/decision-gated (paused here):
1. MG-24 greenfield Azure bootstrap KEYSTONE (now SAFE; 10-step runbook in docs/infrastructure/bootstrap-runbook.md). Unblocks MG-21/23/25, MG-14 AC5, MG-6 Bucket C, and the LIVE OTel pieces (central collector Container App deploy + live IoT-Hub receiver Function — the operational half of MG-33 scaffolding).
2. MG-6 Bucket B — Sentry org/project decision (milestone mg-6-sentry-decision); then MG-7 mobile-sentry.
3. MG-31 cook_stopped payload (persist real Cook vs minimize contract — rec: minimize).
4. MG-30 device-group authz (needs user->device ownership model decision).
LIVE/AC5-gated after MG-24: MG-14 AC5, MG-29, MG-6 Bucket C. DEFERRED Phase3: MG-13, MG-7.

SAFETY (unchanged): V2 greenfield — never touch V1; no local-state apply; no manual Azure resources; PROD_DEPLOY_ENABLED unset until MG-25.
OPS: forge review-loop hangs here (nx plugin-worker) -> use forge invoke red-wide + green PR CI. Local npm 11.13 vs pinned 10.9.8 — never regen lockfile locally. data-pusher/dist binaries are gitignored (red-wide may false-flag stale local builds; repo is grep-clean).
