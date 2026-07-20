---
id: MG-24
type: story
status: active
title: greenfield V2 infrastructure bootstrap — remote state/identity + create V2 stack from empty state
created: 2026-07-19
---

## LIVE BOOTSTRAP BLOCKED — operational review found blocking defects (2026-07-20)

The deterministic layer merged (`21be588`, PR #4) but an OPERATOR OPERATIONAL review (reproducing the real path) found it does NOT actually work end-to-end. Static checks (fmt/validate/static-greps/bootstrap unit tests) + red-wide validated SHAPE, not the operational path. **Do NOT run the live bootstrap until the items below are corrected, merged, and RE-REVIEWED (with operational validation), and the runbook can actually complete MG-24 + unblock MG-21's authenticated dev proof.** MG-24 stays OPEN.

### Corrective items (all blocking unless noted)
1. **Dev CI plan is broken.** `.github/workflows/ci.yml` runs `terraform init -backend=false` then `plan` → fails "Backend initialization required" (reproduced) and would plan against empty state. Fix: `terraform init -backend-config=environments/backend-dev.hcl` and plan against persistent dev state (reconcile the TF-owned dev stack), as prod does. Structure it so it's meaningful only post-bootstrap.
2. **App Insights AAD ingestion is wired WRONG (invalid, drops telemetry).** Endpoint-only `IngestionEndpoint=<url>` is invalid — Microsoft requires the InstrumentationKey in the connection string as the destination-resource IDENTIFIER, even under Entra auth. Fix: pass the FULL TF-managed connection string to `APPLICATIONINSIGHTS_CONNECTION_STRING`; keep `APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD` + Monitoring Metrics Publisher; **set `local_authentication_disabled = true` on `azurerm_application_insights`** so the ikey cannot authenticate ingestion. REWRITE the ADR: the ikey remains in state/app_settings as an identifier but cannot authenticate (local auth disabled). Update the static gate to reflect the corrected model.
3. **Authenticated MG-21 dev smoke is currently IMPOSSIBLE.** `functions_auth_client_id` defaults empty, no tfvars supplies one; Easy Auth rejects every request but configures NO identity provider. Fix: provision/document a SEPARATE dev Entra API auth registration (client/tenant/audience), configure Easy Auth with a real provider, and document the operator's token-acquisition path + how to invoke an authenticated endpoint. Do NOT reuse the GitHub deployment OIDC registration as the app's user/API auth design without explicit architecture + review.
4. **"Deployment identities" cannot deploy.** `bootstrap.sh` grants the GitHub identities only **Reader**, but `app-deploy-prod.yml` uses that identity for `func publish` (Reader can't publish). Separate: CI Terraform PLAN identity = Reader + its env's state container; APP DEPLOYMENT identity = least-privilege publish scoped to its Function App. Stop calling the plan identities "deployment identities." Prod's deploy identity+role is a REQUIRED MG-25 AC before `PROD_DEPLOY_ENABLED`.
5. **Runbook omits `ARM_SUBSCRIPTION_ID`.** AzureRM v4 requires it; `az account set` alone is insufficient. Export/pass `ARM_SUBSCRIPTION_ID` (or `subscription_id`) after verifying the selected subscription.
6. **The "authoritative" secret inspection is not a gate.** The README grep matches field NAMES not values, `grep ... || echo "no secrets"` ALWAYS exits 0, it flags the accepted AI attributes, and it's not even in the runbook. Replace with a structured FAIL-CLOSED plan/state inspection: parse Terraform JSON, distinguish names from values, allow ONLY the accepted AI residual, reject prohibited credentials in app_settings/outputs, EXIT NONZERO on violation, and put it in the runbook BEFORE apply.
7. **No-drift claim is false.** `modules/monitoring/main.tf` (~:33, :275) derives budget start dates from `timestamp()` (the static gate ignores them) → changes monthly → 2nd-plan-no-op breaks across month boundaries. Remove the drift; gate must catch it.
8. **Bootstrap doc corrections:** containers are `tfstate-dev`/`tfstate-prod` (not `tfstate`); `STATE_CONTAINER` is NOT a supported override; state RBAC is container-scoped (not account-scoped); NO legacy `terraform.tfstate` is tracked/present (remove that false claim).
9. **Global-uniqueness audit:** apply the deterministic subscription-derived suffix consistently to ALL globally-scoped names (state storage account, Function App, IoT Hub, Event Hubs namespace, SignalR) — or document + test a deliberate exception. (Only Cosmos + Functions storage currently have it.)

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

### Re-review requirement
Re-review MUST exercise/verify the OPERATIONAL path (init/plan command validity, AAD ingestion per MS docs, RBAC sufficiency for the operation, fail-closed gate actually exits nonzero, runbook completeness), not just static shape.

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
