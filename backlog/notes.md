**Last session ended 2026-07-23.**

**Where we left off:** Closed gates 1–4 (MG-24 + MG-21). Re-scoped MG-23 to the automated-dev-infra-GitOps 8-point spec and was about to route it (implementation_full) when `forge route explain` broke ("no seed generation is published"). I then reflexively ran `forge upgrade` to fix it — operator (rightly) challenged that. Ended mid-discussion about whether the upgrade outcome is acceptable.

**Picked up next:**
1. **Resolve the `forge upgrade` fallout FIRST (non-ticket, blocks everything).** `forge upgrade` this session republished the routing-policy seed generation BUT also (a) rewrote the CLAUDE.md orchestrator block (uncommitted `M CLAUDE.md`) and (b) left `agent-dev-worker:latest` STALE. Decide: keep or revert the CLAUDE.md change; rebuild the agent image (`docker/build.sh` or `forge upgrade --rebuild-image`) before ANY agent pipeline; and root-cause WHY the seed generation went unpublished mid-session (unexplained — it worked earlier for MG-24 routing).
2. **Commit the uncommitted backlog state** (MG-21/MG-24 moved to done/, MG-23 retitled, MG-36/MG-37 new) — decide alongside the CLAUDE.md decision.
3. **Route MG-23** (active) via implementation_full once routing resolves + the image is rebuilt: deterministic code (the least-privilege infra-apply SP + PR-plan/`infra-apply-dev` workflows + security review) THEN a live merge-driven GitOps-loop proof (operator-gated, like MG-24's apply). Sets `DEV_TF_BACKEND_READY=true`.
4. Then MG-36 (automated dev app-deploy — carries the proven Flex-deploy findings), then MG-37 (dev telemetry).

**External state to remember:**
- LIVE dev Azure stack is UP: `meatgeek-v2-dev-rg` in **West US 2** (~50 tf resources / 16 Azure resources), Flex Consumption FA with the API deployed + serving authed traffic. Costs accruing. State: `meatgeek-v2/dev.tfstate` in `tfstate-dev` on `meatgeekv2tfc49dbf8ad608`.
- `DEV_TF_BACKEND_READY` still UNSET (MG-23 sets it once its workflows land). GitHub `development`/`production` env OIDC vars are wired.
- Bootstrap identities live: plan (Reader), app-deploy (Website Contributor on FA), dev API reg `meatgeek-v2-dev-api` (348570b2). MG-23 still needs a NEW dedicated infra-apply SP (per its spec).
- `agent-dev-worker:latest` STALE (rebuild before pipelines). Opt-in auth profiles (bedrock/api) unconfigured — only matters if selected.
- App Insights telemetry NOT flowing from the Flex FA despite correct wiring (MG-37).
- Deploying to the Flex FA requires the self-contained method (see MG-36): `nx build api` → `npm install --omit=dev --ignore-scripts` in dist → `func … publish --javascript --no-build`. The bare nx `deploy` target does NOT work on Flex.

**Decisions worth not relitigating:**
- Hosting = **Flex Consumption for BOTH envs**, West US 2, Node 24, azapi control-plane MI storage (shared-key disabled) — replaced the inherited Y1/EP1 split. Operator-chosen; the Y1 MI-storage 403 forced it.
- Terminology: MG-24 proved **Terraform reconciliation** (operator-run apply); MG-23 proves **automated dev GitOps reconciliation** (CI-run). Not the same; don't conflate.
- MG-23 infra-apply identity = Contributor + **conditioned** RBAC-Admin (TF-managed-role allowlist + SP/MI-only; no Owner/Contributor/UAA/RBAC-Admin grants) + container-scoped Blob Data; OIDC-only; `development`/main-restricted. Operator-specified.
- App-deploy work SPLIT out of MG-23 → MG-36 (formal; carries all original MG-23 app-deploy ACs; depends on MG-21).
- MG-21 closed on the HTTP-200-with-body execution proof; the App-Insights invocation-log form deferred to MG-37 (operator-accepted). Trunk-based `main` — NO `develop` branch (do not create one).
- Long applies/deploys run via `forge launch run` (tmux, uncapped) — the harness `!` 2-min cap was killing mid-apply and leaving partial stacks.

**Shipped (for reference):**
- MG-24 — greenfield V2 dev env (Flex/West US 2/Node 24, azapi MI storage), created from empty state, second-plan no-op + representative-change reconcile proven, secret gate green (PRs #23–#26; head `6fb7df9`).
- MG-21 — exact main package deployed to the Flex dev FA (5 functions), auth smoke passed (401 / 200+body / 401).
- Filed: MG-35 (prod data-loss protection), MG-36 (automated dev app-deploy + Flex-deploy findings), MG-37 (dev telemetry-flow).
