---
id: MG-24
type: story
status: done
title: greenfield V2 infrastructure bootstrap — remote state/identity + create V2 stack from empty state
created: 2026-07-19
closed: 2026-07-23
closed_commit: 6fb7df9
---

## RESUME STATE 2026-07-23 — Flex hosting SHIPPED; live re-apply is the only remaining work

The hosting-model revision below is DONE and merged: **Flex Consumption for dev+prod, West US 2, Node 24** shipped in **PR #24 / commit `529ac54`** (full `feature` pipeline: architect → tech-lead → engineer → 3 red fix-rounds → test-engineer → docs; CI green). `azurerm_function_app_flex_consumption` + FC1 plan; **azapi control-plane deployment container** (no shared-key, no `storage_use_azuread`, no first-apply grant chicken-and-egg); Easy Auth + fail-closed precondition preserved; secret gate extended with fail-closed fixtures; ADR `mg-24-flex-consumption-hosting-model.md`; prod data-loss protection tracked in **MG-35**. The "PAUSED / BLOCKS resume" section below is therefore RESOLVED — it is retained only as history.

**The ONLY remaining MG-24 work is the operator-gated live sequence** (deterministic code is complete):
1. Destroy the stranded NCUS partial: `terraform destroy` against the current dev state, then delete the orphaned Functions storage account `mgv2dev13bd19e9f03d` (exists in Azure, not in state).
2. Re-`init` (backend-dev) + `plan` the Flex/West US 2/Node 24 stack → operator plan review + secret-inspection gate.
3. `apply` → 2nd-plan no-op → representative tag change → plan → apply → no-op (the 10-step greenfield + reconcile proof) → capture evidence.
4. Then MG-21 (publish to the Flex dev FA, 401→2xx auth smoke) and MG-23 (dev workflow split).

GitHub OIDC coordinates (dev+prod env vars) are already wired; `DEV_TF_BACKEND_READY` still unset (flip only after step 3 proves the dev plan/apply).

---

## PAUSED 2026-07-23 — hosting model under revision (Flex Consumption evaluation)

The live greenfield DEV apply is **PAUSED mid-run**. The apply created ~30 resources (RG, Log Analytics, App Insights, Cosmos account + `meatgeek` DB + 5 containers, IoT Hub + routes/endpoints/consumer groups, Event Hubs ns + hub, SignalR, Functions **service plan**) then **FAILED** on the Functions host storage account: `403 KeyBasedAuthenticationNotPermitted`. Root cause: the azurerm provider's post-create blob-data-plane readiness poll used shared-key auth against an account created with `shared_access_key_enabled=false`, because the provider block lacks `storage_use_azuread=true`. The Function App, its RBAC role assignments, and the monitoring module were NOT created. Remote dev state (`meatgeek-v2/dev.tfstate` in `tfstate-dev`) is intact; **no V1 resource was touched**. An **orphaned** Functions storage account (`mgv2dev13bd19e9f03d`) exists in Azure but not in Terraform state — import or delete it before resuming.

### Hosting-model revision (operator-directed 2026-07-23) — BLOCKS resume
The inherited **Y1-dev / EP1-prod** split is scaffold-default, justified only by generic "cost efficiency" / "better performance" comments; no MeatGeek requirement justifies different hosting models per environment. Before resuming the bootstrap:

1. Evaluate **Flex Consumption** for BOTH dev and prod (one hosting architecture for both envs).
2. Dev may use scale-to-zero / no always-ready capacity; prod may use always-ready instances + different memory/concurrency settings.
3. Validate for the **target region** (dev = North Central US): Flex Consumption availability, Node 20 support, deployment tooling, Easy Auth, managed-identity host storage, networking, and Terraform azurerm provider support.
4. Prefer the **Azure-Files-free managed-identity deployment model**.
5. Do **NOT** enable storage shared-key access merely to preserve legacy Y1/EP1 assumptions. **This supersedes the earlier "keep keys as a documented exception" fallback for the Functions host storage** (the data-service local-auth posture below still applies to Cosmos/SignalR/Event Hubs/IoT Hub).
6. Retain Elastic Premium ONLY if a specific documented requirement cannot be satisfied by Flex.
7. Update the ADR, Terraform tests, runbook, secret gate, and cost expectations accordingly.

**Deliverable before resume:** a Flex-vs-EP/Consumption feature comparison against points 1–4 plus any concrete blocker. The 10-step greenfield proof, the reconcile proof, and the MG-21/MG-23 follow-ons resume only AFTER the hosting model is settled and re-planned.

---

## LIVE BOOTSTRAP UNBLOCKED — all operational-review corrective items shipped + re-reviewed (2026-07-22)

The 9 blocking corrective items from the 2026-07-20 operational review are **RESOLVED on `main` (HEAD `95142ac`)**, verified item-by-item against the current tree. The live greenfield bootstrap may now proceed. **MG-24 stays OPEN** until the 10-step DEV proof below is completed with captured evidence.

### Corrective items — RESOLVED (verified 2026-07-22 against main)
1. ✅ **Dev CI plan** binds persistent dev state (`terraform init -backend-config=environments/backend-dev.hcl`), gated on `DEV_TF_BACKEND_READY` (skip-clean until backend ready) — `.github/workflows/ci.yml`.
2. ✅ **App Insights AAD ingestion** passes the full connection string + `APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD`; `local_authentication_enabled = false` on `azurerm_application_insights` (the valid azurerm-v4 attribute; `= false` disables local auth, functionally identical to the item's `local_authentication_disabled = true`).
3. ✅ **Dev Entra API auth registration** — a separate `meatgeek-v2-dev-api` app is created in `bootstrap.sh` (Azure CLI/Graph, not the GitHub OIDC reg): bearer-validation-only, exposes `access_as_user`, Easy Auth `require_authentication=true` / `Return401` / token store disabled / no secret.
4. ✅ **Separate plan vs deploy identities** — plan/read identity (`AZURE_CLIENT_ID`, Reader + container-scoped state access) distinct from the app-deploy identity (`AZURE_APP_DEPLOY_CLIENT_ID`, Website Contributor scoped to the Function App only); `func publish` uses the deploy identity, not the plan identity.
5. ✅ **`ARM_SUBSCRIPTION_ID`** mandated in the runbook and set in all workflows (azurerm v4 requires it; `az account set` alone is insufficient).
6. ✅ **Fail-closed secret-inspection gate** — `scripts/tf-plan-secret-inspection.sh` parses `terraform show -json`, distinguishes names from values, accepts only the AI ikey residual under local-auth-disabled, and `exit 1`s on violation; wired into the runbook BEFORE apply. The old always-green `grep … || echo` is removed and forbidden by the static gate.
7. ✅ **`timestamp()` drift removed** — no `timestamp()` in any `.tf`; budget start dates derive from a `time_static.budget_anchor` persisted in state.
8. ✅ **Bootstrap doc corrections** — per-env `tfstate-dev`/`tfstate-prod`, `STATE_CONTAINER` documented as unsupported, container-scoped state RBAC, false legacy-`terraform.tfstate` claim removed.
9. ✅ **Global-uniqueness suffix** — deterministic subscription-derived suffix applied to state storage account, Function App, IoT Hub, Event Hubs namespace, and SignalR.

The app-auth token/consent contract, refined defaults, and data-service local-auth posture below (operator-approved 2026-07-20) remain the authoritative design and are implemented as summarized above. The re-review requirement is satisfied: the corrections were verified against the operational path (CI init/plan command shape, AAD ingestion per MS docs, RBAC split, fail-closed gate exit code, runbook completeness), not just static shape.

### App-auth token/consent contract + refined defaults (OPERATOR-APPROVED 2026-07-20)

Item 3 app-auth model = bearer-token VALIDATION-only (no interactive login, no client secret, token store disabled). Confirmed no browser AI producer exists, so `local_authentication_disabled=true` (item 2) is safe. Required contract:

**Token issuance / consent (must be complete — not a bare --resource):**
- The dev API Entra registration EXPOSES a delegated scope `access_as_user`; the smoke-test client app is explicitly authorized/preauthorized for that scope.
- Operator token acquisition uses the v2 SCOPE form: `az account get-access-token --scope "${APP_ID_URI}/access_as_user"` (a bare `--resource` will NOT work without scope+consent config).

**Easy Auth validation (require_authentication=true, unauthenticated_action=Return401, token store DISABLED, NO client secret):**
- single dev tenant issuer; allowed audience = the EXACT API App ID URI; an explicit allowed client application; initially the operator/test identity if practical.

**Registration lifecycle:** the dev API registration lives in the bootstrap boundary BUT is VERSION-CONTROLLED + IDEMPOTENTLY reconciled (e.g. `azuread_application`/scripted, NOT a portal/manual object). Dev and prod registrations remain SEPARATE.

**Smoke-test evidence (MG-21):** no-token → 401; wrong-audience/wrong-client → rejected; valid-token → 2xx + the matching invocation log. NEVER log or attach the token.

**Refined defaults (operator-approved):**
- Separate identity client-id vars: `AZURE_PLAN_CLIENT_ID` (Reader + its env state container) and `AZURE_APP_DEPLOY_CLIENT_ID` (Website Contributor scoped ONLY to the Function App). Distinct principals.
- Dev-plan CI job gated on repo variable `DEV_TF_BACKEND_READY` (set ONLY after backend/OIDC/GitHub wiring works) — skip-clean until then, no expected-red job.
- Budget `start_date`: use a `time_static` resource persisted in remote state (or a required, validated environment-inception-date var) — NOT `timestamp()`, NOT a committed rolling default.
- The suffixed state-account name is derived IDENTICALLY across bootstrap, backend init (`backend-*.hcl`), and the workflows — single derivation, no divergent hardcoding.

### Data-service local-auth posture (operator decision 2026-07-20, red-wide round 11)

Every TF-managed data service stores its own keys as INHERENT computed attributes in state (Cosmos primary_key, Storage primary_access_key, IoT Hub SAS keys, SignalR primary_access_key), the same as the App Insights ikey. Resolution: DISABLE local/key auth where SAFE so those in-state keys cannot authenticate; document the rest; correct the over-strong "no data-plane secrets in state" claim.
- Cosmos: local_authentication_disabled = true (FA + IoT routing use MI + RBAC).
- SignalR: AAD-only / local auth disabled (FA uses the SignalR RBAC role).
- Storage: shared_access_key_enabled = false ONLY IF the Function host storage (AzureWebJobsStorage) is fully managed-identity; VERIFY first, else keep keys as a documented exception (do NOT break Functions).
- IoT Hub: KEEP key/SAS auth (device / data-pusher / device-controller connectivity) as an explicit DOCUMENTED exception with restricted state access.
- Extend the secret-inspection gate to VERIFY local-auth-disabled on Cosmos/Storage/SignalR (accept their key-attribute residual only when local auth is off, like the App Insights binding); IoT Hub is the acknowledged exception.
- Extend the ADR (learnings/decisions/) to cover all four services + the IoT exception. Correct the claim in README/runbook/docs to: no data-plane secret is USED or reaches app_settings/outputs; access is identity-based; TF-managed resources inherent key attributes are in state but NON-AUTHENTICATING where local auth is disabled; IoT Hub retains key-based device auth (documented exception), state access restricted.

## Status (2026-07-20)

**Deterministic greenfield layer MERGED to main as `21be588` (PR #4).** Remote state + OIDC identity bootstrap, per-env isolated state, V2-owned Cosmos, V2 naming, no subscription-id/timestamp drift, FA-name single source, managed identity across all services with **no avoidable secrets in state** (the AI resource-attribute residual is operator-accepted + ADR'd), Easy-Auth default-deny, V1-safety static gate, bootstrap script + runbook. Reviewed via 6 red-wide rounds (secrets-in-state, open-API, OIDC-subject, gate-honesty all caught + fixed) + green CI. **MG-24 stays OPEN** — remaining = the OPERATOR's out-of-band greenfield bootstrap + dev `plan`/`apply` (the 10-step dev proof) that creates the V2 dev stack. See `docs/infrastructure/bootstrap-runbook.md`.

## Authoritative Azure facts (2026-07-20)

- `meatgeek-dev-rg` was deliberately DELETED. MeatGeek **V2 has NO Azure dev or prod infrastructure**.
- All remaining MeatGeek Azure resources belong to the OLD **V1** system and are **OUT OF SCOPE**: do NOT import, adopt, modify, rename, or delete them.
- There is **no V2 brownfield migration and no V2 state to recover**. This is GREENFIELD.

## GitOps contract

After a minimal state/identity bootstrap, this repository creates the COMPLETE MeatGeek V2 environment from scratch. The first apply starts from EMPTY environment state; every subsequent run loads the same durable remote state and reconciles incremental changes.

## Required scope

1. **Minimal bootstrap boundary:** durable Azure remote-state storage; deployment identity/OIDC trust; a documented, repeatable bootstrap procedure.
2. **Isolated state per environment**, e.g. `meatgeek-v2/dev.tfstate` and `meatgeek-v2/prod.tfstate`.
3. **Remove the hardcoded Azure subscription ID** — obtain it via explicit configuration or the authenticated environment.
4. **Unambiguous V2 resource naming** such as `meatgeek-v2-${environment}-*` so V2 cannot be confused with V1.
5. **Remove dependencies on legacy V1 infrastructure**, including the existing shared Cosmos account — V2 must CREATE and OWN its Cosmos resources (unless a separately-managed V2 platform stack is intentionally designed).
6. **Remove timestamp-based tag drift** (`CreatedDate = timestamp()`).
7. **Align Function App naming** across Terraform outputs, Nx deployment, and workflows — one source of truth, no independent hardcoded conventions.
8. **Dev and prod configuration/state cannot collide.**
9. **Keep Terraform apply DISABLED in CI** until the backend and greenfield plan are ready.

## Greenfield DEV acceptance proof

1. Begin with NO V2 dev resources and EMPTY remote dev state.
2. `terraform plan` proposes the expected COMPLETE V2 dev stack.
3. Human reviews the plan for scope, security, and cost.
4. Apply successfully CREATES the complete V2 dev infrastructure, INCLUDING the Function App.
5. A second plan is a NO-OP.
6. Make a representative infrastructure change in Git.
7. The next plan proposes ONLY that incremental change.
8. Apply it successfully.
9. The following plan returns to NO-OP.
10. Capture the state key, plan/apply evidence, and resulting resource inventory.

## Security requirements (FOUNDATIONAL — operator-directed 2026-07-20, must be in place BEFORE the first greenfield apply)

### S1. No plaintext runtime secrets in Terraform state

> **Accepted residual (operator decision 2026-07-20):** the `azurerm_application_insights` instrumentation key/connection_string is an inherent COMPUTED attribute of the TF-managed resource and is therefore in state (true of any TF-managed resource's attributes). App Insights stays TF-managed; accepted as low-risk — telemetry-write-only (no data/resource access), the Function App authenticates via managed identity/AAD (key unused for auth), and state access is restricted. Documented as an ADR under `learnings/decisions/`. This is the ONLY accepted exception: Cosmos/Storage/IoT Hub/SignalR are fully identity-based, and no connection-string/key VALUE may appear in app_settings or outputs (gate-enforced).
 (secrets-in-state is a state-model defect, not a prod concern)
- Function App uses a **managed identity**.
- Replace Cosmos, Storage, IoT Hub, and SignalR **connection-string app settings** with **identity-based access + non-secret endpoints** wherever supported.
- Grant **narrowly-scoped RBAC roles** to the Function App identity (least privilege per service).
- **Remove connection-string/key outputs and references from Terraform** (no secret outputs).
- Use **Key Vault references ONLY where managed identity is unavailable**, and ensure Terraform does NOT generate or ingest the secret value itself.
- Do NOT upload binary plans or plan JSON containing sensitive values (CI plan artifacts).
- **Restrict backend state-container access** to the identities that genuinely require state access.

### S2. Function App HTTP security posture (the security boundary of the created infra)
- **Remove wildcard CORS**; configure **explicit allowed origins per environment**. Keep `support_credentials=false` unless an intentional credential/cookie design requires it. CORS is NOT authorization and does not block direct HTTP clients — treat separately.
- **Require authentication for ALL business endpoints**, especially state-changing ones (e.g. `startCook`). Anonymous allowed ONLY for an explicitly-designed minimal health/readiness endpoint if needed.
- Prefer **identity-based platform authentication** (App Service Authentication / Entra ID) over distributing Function keys to clients. If the final auth design isn't ready, **default-deny** business endpoints rather than exposing them anonymously. Do NOT put client secrets in Terraform state.

## Additional acceptance criteria (security)

- **State/plan inspection proof**: a check/AC proving NO runtime credentials or primary keys are present in state/plan BEFORE the first apply (identity-based access + non-secret endpoints; no secret outputs).
- **Deterministic HTTP-posture tests**: wildcard CORS absent; allowed origins are environment-specific; unauthenticated business requests return 401/403; disallowed origins receive no permissive CORS response; the authenticated dev smoke test succeeds.
- Backend state-container access restricted to identities that require it; per-env CI identities/state isolation (dev and prod do not share a service principal or whole-state access).
- MG-25 retains BROADER prod hardening (network isolation, approval policy, rotation procedures, prod RBAC review) — but S1/S2 above are foundational and land in MG-24.

## Red-review fixes folded into this ticket (2026-07-20)

- [HIGH] Enforce the architect's #1 guard: the static gate MUST fail if a local `*.tfstate` exists at init/plan (do not exempt the on-disk V1-bound tfstate).
- [HIGH] Per-env isolated CI identities + state access (no shared SP / whole-state access) — scope 8.
- [MEDIUM] Functions storage-account name must be GLOBALLY unique (subscription-derived suffix) so a greenfield apply cannot fail on a name collision.
- [MEDIUM] Revert the build-window `package-lock.json` mutation (npm10/11 skew — do not delete optional-peer entries).
- [MEDIUM] Update the workflow regression spec to be compatible with the OIDC/remote-backend workflows (full suite must pass).
- [MEDIUM] Fix `bootstrap.sh` so container creation does not fail closed on data-plane auth (grant/await the blob-data role, or use an auth mode that works for the operator's control-plane role).

## Acceptance criteria

- Bootstrap boundary established + documented (remote-state storage, OIDC/identity trust, repeatable procedure); no hardcoded subscription ID; per-environment isolated state keys; V2 naming `meatgeek-v2-${environment}-*`; no V1 dependencies (V2 owns its Cosmos); no `timestamp()` tag drift; Function App naming aligned across TF/Nx/workflows; dev|prod state/config cannot collide.
- CI Terraform apply remains disabled until backend + greenfield plan are ready.
- The 10-step greenfield DEV proof above is completed with captured evidence (state key, plan/apply logs, resource inventory).

## Safety constraints (hard)

- Do NOT touch any remaining V1 Azure resource. Do NOT import V1 resources into V2 state. Do NOT run Terraform apply with ephemeral LOCAL state. Do NOT create Azure resources manually.

## Split of work

Deterministic (pipeline): the greenfield Terraform (config, remote backend wiring, per-env state, OIDC, naming, subscription-id de-hardcode, Cosmos ownership, drift removal, naming alignment) + the documented bootstrap procedure. Credentialed/operator-gated: running the bootstrap, the human plan review, and the real dev plan/apply that creates the stack (the acceptance proof).

## Context

Rewritten 2026-07-20 from "wire backend + migrate/import" to GREENFIELD V2 bootstrap per authoritative Azure facts (no V2 infra exists; V1 out of scope). Keystone for MG-21 (dev proof needs the TF-created dev Function App), MG-23 (dev reconcile), MG-25 (prod, also greenfield).
