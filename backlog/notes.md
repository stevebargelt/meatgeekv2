SESSION 2026-07-22 — SECOND operational review: all 4 findings addressed at AUTHORED level. Paused at the live/operator boundary.

SECOND-REVIEW OUTCOMES:
- F2 (High, trace not end-to-end): FIXED, merged #16 (b492270). One trace id spans poll→device→queue→publish→IoT per reading; join integration test. MG-33 F3-AC met.
- F4 (Med, bootstrap.sh:468 ||true masked Graph failure): FIXED, merged #17 (b1d79ef). operator_state_grant_oid() principal-type detect + fail-loud. MG-32 re-CLOSED (all AC walked).
- F1 (High, collector can't auth: azuremonitor=local-auth vs local_authentication_enabled=false): operator chose native Azure Monitor OTLP. AUTHORED + merged #18 (8a03a13): modules/native-otlp (DCE/DCR, user-assigned MI, Monitoring Metrics Publisher scoped to the DCR, pinned otelcol-contrib:0.128.0 Container App + persistent AzureFile file_storage spool), collector-config.yaml (otlphttp+azureauth+sending_queue+retry), config DELIVERED via CApp secret, enable_native_otlp default-off with lifecycle preconditions, CI otelcol validate, ADR (learnings/decisions/mg-33-native-azure-monitor-otlp-ingestion.md). FAIL-CLOSED: no CApp ingress + loopback-only receiver.
- F3 (Med, collector not deployable/edge-safe): FOLDED into #18 (pinned image, queue/retry, no-public-listener, CI validate, README rewrite drops inaccurate 'supported path').

red-wide caught 5 operational defects on F1 that terraform validate missed (config-not-delivered, unenforced flag prereqs, preview-semantics, stale doc) — all fixed; r2 PASS. This is the operational-path lesson working: harder gate catches what static validation can't.

MG-33 STAYS OPEN — blocked by MG-34.
MG-34 (NEW, open): MG-33 F1 activation blocker. AC1 secure off-VNet edge ingress (Pis→collector: mTLS/token/private-link — NO public unauth listener); AC2 live Go-span-to-App-Insights proof (MG-24/MG-25-gated); AC3 negative RBAC check (remove MMP-on-DCR → ingestion rejected). ALSO folds in F2/F3 native-OTLP PREVIEW-semantics verify (DCE OTLP endpoint attribute, azureauth token scope, min otelcol-contrib version) — UNVERIFIED, confirm against Azure native-OTLP preview docs at MG-25 (unverifiable from dev env now; honestly annotated in-config).

REMAINING (all operator/live/decision-gated): MG-24 bootstrap keystone (now safe); MG-25 native-OTLP preview acceptance; MG-34 live proof; MG-6 Sentry decision; MG-30 device-ownership; MG-31 payload; MG-14 AC5; MG-29; MG-13/MG-7 Phase3.
SAFETY: V2 greenfield — never touch V1; no local-state apply; local_authentication_enabled + enable_native_otlp STAY false; no manual Azure resources; PROD_DEPLOY_ENABLED unset until MG-25.
OPS: forge review-loop hangs (nx) → red-wide + green PR CI. Completion Monitors: use 'forge show <run-id>' run-status, NOT 'forge launch show' grep (command echo false-fires). gh pr merge --delete-branch SWITCHES local to main. Local npm 11.13 vs pinned 10.9.8 — never regen lockfile locally. data-pusher/dist gitignored.
