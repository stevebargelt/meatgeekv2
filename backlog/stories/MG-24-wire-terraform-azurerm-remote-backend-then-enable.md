---
id: MG-24
type: story
status: active
title: greenfield V2 infrastructure bootstrap — remote state/identity + create V2 stack from empty state
created: 2026-07-19
---

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

### S1. No plaintext runtime secrets in Terraform state (secrets-in-state is a state-model defect, not a prod concern)
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
