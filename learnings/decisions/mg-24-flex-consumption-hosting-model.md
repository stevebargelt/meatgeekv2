# Single Flex Consumption hosting model for both dev and prod, replacing the inherited Y1(dev)/EP1(prod) split

- **Status:** Accepted (deterministic code landed; live destroy/re-apply operator-gated)
- **Date:** 2026-07-23
- **Ticket:** MG-24 (greenfield V2 infrastructure — Azure Functions hosting revision)
- **Scope:** `apps/infrastructure` — the Functions module
  (`modules/functions`), the root wiring (`main.tf` / `variables.tf`), the
  per-env tfvars, the pre-apply secret-inspection + static-check gates, the API
  runtime (`apps/api`), and the bootstrap runbook

> **Honest boundary.** Everything below is **authored and static-validated
> only**: `terraform validate` / `fmt -check`, the module test with a mocked
> provider, and `tf-static-checks.sh` / `tf-plan-secret-inspection.sh` exercised
> against fixtures. It is **NOT operationally verified** — no live Flex app has
> been applied, published to, or invoked through this path. The live
> destroy/re-apply (with the Cosmos-migration decision below) is the operator's
> out-of-band gated step, not part of this deterministic delivery. Do not read a
> green `terraform validate` as "the Function App is running on Flex."

## Context

The inherited MG-24 infrastructure ran the Azure Functions app on **two
different hosting SKUs**: a **Y1 Consumption** plan in dev and an **EP1 Elastic
Premium** plan in prod, via `azurerm_service_plan` +
`azurerm_linux_function_app`. Two problems drove the revision (operator-directed
2026-07-23, backed by the research in run
`run-mg-24-flex-consumption-evaluation-945b8c`):

1. **The Y1 dev apply failed.** Y1 Consumption requires an **Azure Files content
   share** on the host storage account, and that share is reached with a
   **shared key**. But MG-24's secrets-out-of-state posture keeps
   **`shared_access_key_enabled = false`** on `azurerm_storage_account.functions`
   (see [`mg-24-appinsights-key-in-terraform-state`](mg-24-appinsights-key-in-terraform-state.md),
   the Storage row). With shared-key auth disabled, the Y1 content-share path
   **403'd** — the hosting model and the storage hardening were mutually
   exclusive. Re-enabling the shared key to make Y1 work was rejected: it would
   reintroduce a live storage credential and break the coupled invariant that ADR
   enforces (MG-24 point 5).

2. **The Y1/EP1 split had no documented justification.** EP1 was inherited, not
   chosen; no requirement (VNET integration, always-warm SLA, pre-warmed
   instances beyond what Flex offers) was on record to retain it (MG-24 point 6).

## Decision

**Replace both plans with a SINGLE `azurerm_function_app_flex_consumption`
model** running **both** dev and prod, on the **pinned `azurerm` v4.81.0** — no
provider upgrade. Flex Consumption is fully supported on the pinned provider.

> **`azurerm_service_plan` is RETAINED, not removed.** "Both plans" above refers
> to the two inherited **SKUs** (Y1 in dev, EP1 in prod), collapsed to one. The
> `azurerm_service_plan` resource itself **stays** — re-SKU'd to **`FC1`** (the
> Flex Consumption plan) — because `service_plan_id` is a **required** argument on
> `azurerm_function_app_flex_consumption` in the pinned v4.81.0 schema. What is
> replaced is `azurerm_linux_function_app` (→ the flex resource) and the Y1/EP1
> SKUs (→ FC1), never the plan resource. See Consequences for the full statement.

The Flex resource is configured with:

- **`runtime_name = "node"`, `runtime_version = "24"`** — Node 24, matching the
  operator's local Node 24.17.0 and the API's bumped `engines.node`.
- **MI system-assigned BLOB deployment storage**:
  `storage_container_type = "blobContainer"`,
  `storage_authentication_type = "SystemAssignedIdentity"`,
  `storage_container_endpoint` pointing at a blob container on the **same**
  `azurerm_storage_account.functions` account — which **keeps
  `shared_access_key_enabled = false`**.
- **System-assigned identity** and the **entire `auth_settings_v2` Easy Auth
  block** (active_directory_v2, allowed_audiences, allowed_applications, token
  store disabled, `www_authentication_disabled`) carried **1:1** from the old
  `azurerm_linux_function_app`.
- The **fail-closed default-deny precondition** (S2 invariant) carried onto the
  flex resource: the plan is **refused** when `functions_auth_client_id` is
  empty, so an unconfigured-auth Function App can never plan.
- The **`function_app_name` output** remains the **single source of truth**
  carrying the global-uniqueness suffix that the deploy path reads.
- **Identity-based `app_settings` only** — App Insights (full connection string
  + `Authorization=AAD`), Cosmos endpoint, Event Hub namespace, SignalR
  serviceUri — no connection-string/key VALUES. Flex-deprecated settings
  (`WEBSITE_NODE_DEFAULT_VERSION`, `WEBSITE_CONTENT*`, `WEBSITE_TIME_ZONE`) are
  pruned.
- **Scale knobs** exposed as variables: `instance_memory_in_mb`,
  `maximum_instance_count`, `always_ready` — **dev `always_ready = 0`**
  (scale-to-zero), **prod `always_ready >= 1`** with per-instance memory /
  concurrency.

### Why this resolves the Y1 403 (Azure-Files-free)

Flex Consumption does **not** use an Azure Files content share. Its deployment
artifact (the package zip) lives in a **blob container** reached over **managed
identity / AAD**, not a shared key. Because the deployment path is MI-blob, the
functions storage account can **keep `shared_access_key_enabled = false`** and
Flex still deploys and runs. The hosting model and the secrets-out-of-state
storage posture are **no longer in conflict** — which is exactly the coupling
that broke Y1.

### West US 2 — and the whole-stack relocation blast radius

Flex Consumption is region-constrained; the target region is **West US 2**
(replacing North Central US), set via `location` in both tfvars.

**This is NOT a Function-App-scoped move.** `var.location` fans out through
`local.location` to `azurerm_resource_group.main.location` and therefore to
**every module** — Cosmos DB, IoT Hub, SignalR, App Insights, and storage all
relocate. Consequences at the live re-apply:

- **All resources destroy + recreate** — a region change is not an in-place
  migration for any of them.
- **Cosmos DB data loss** — recreating the Cosmos account in a new region drops
  its data. The operator needs a **Cosmos-migration decision** (export/import or
  accept greenfield loss) **before** the live apply. This deterministic pipeline
  implements the directed region change but does **not** perform or gate the
  migration; that is the operator's call at re-apply.

  **There is NO destroy guard anywhere in the shared modules, by design.** No
  `prevent_destroy` is set on the Cosmos account, the IoT Hub, or any other shared
  module — do not read any statement in this ADR, the tfvars, or the runbook as a
  claim that prod is protected from a destroy: it is **not**. A `location` change
  is **ForceNew** on **Cosmos DB and IoT Hub** (and recreates the rest of the
  stack), so the live re-apply drops their data with **nothing in code to stop
  it**. This is deliberate: V2 is **greenfield** — there is no data to protect
  yet — and `prevent_destroy` is a **literal** Terraform cannot env-gate, so
  setting it would be ON for dev and **block the intended greenfield West US 2
  recreate** MG-24 requires. The ForceNew/data-loss note lives in
  `modules/cosmos-db/main.tf`. Real prod data-loss protection (prod-specific
  `prevent_destroy` / backup policy / approval gate for Cosmos **and** IoT Hub) is
  **not built here** — it is tracked as follow-up ticket **MG-35** (MG-25
  prod-hardening scope).

The Flex change **also** forces destroy+recreate of the Function App itself:
there is **no in-place migration** from a Consumption/Premium plan to Flex
Consumption, independent of the region move.

### Control-plane deployment container — NO `storage_use_azuread`, NO pre-apply grant

The deployment blob container is created with **azapi over the ARM CONTROL PLANE**
(`Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01`), the same
pattern the native-otlp module uses for its DCR — **not** `azurerm_storage_container`,
which is a storage **DATA-plane** operation.

This was a corrective decision (MG-24 reds 2f5154 / b08ced). A **data-plane**
container create against an account with `shared_access_key_enabled = false` — an
account **this apply creates** — needs the apply principal to already hold a
**Storage Blob Data** role on a storage account that does not exist until mid-apply.
That is a **same-apply chicken-and-egg** that 403s, otherwise papered over with a
fragile pre-apply data-plane grant + an RBAC-propagation wait. The **control-plane**
create needs only the resource-management permission the apply principal already
holds (Contributor on the resource group), so:

- The provider block **does NOT set `storage_use_azuread`** — nothing in the stack
  performs a storage data-plane operation through the `azurerm` provider anymore, so
  the provider-global switch (and its side effects) is unnecessary and removed.
- **No pre-apply Storage-Blob-Data-Owner grant to the apply/CI principal is
  required.** The **first apply is executable with NO manual pre-grant.**

The Function App still reads the package ZIP from the container at **runtime over its
OWN system-assigned managed identity** (Storage Blob Data Owner, granted in-module) —
that is the app's identity, not the Terraform provider's, and is unaffected.

### Three-identity separation on the one deployment container

The single blob deployment container is touched by **three distinct
identities**, each with the least role it needs:

| Identity | Role | When |
| --- | --- | --- |
| **Function App system-assigned MI** | Storage Blob Data Owner (existing) | Runtime — reads the package zip to run |
| **App-deploy principal** (`var.app_deploy_principal_object_id`) | Storage Blob Data Contributor **scoped to the azapi-created deployment container** via a control-plane `azurerm_role_assignment` (NEW, count/var-guarded) — in addition to its existing Website Contributor on the Function App. This is a resource-management role assignment, **not** a pre-apply operator grant. | Deploy — `func publish` / OneDeploy writes the package zip |
| **Apply/CI principal** | Its existing resource-management role (Contributor on the RG) — **no** storage data-plane role needed | Plan/apply — CREATES the container over the ARM control plane (azapi) |

### EP1 not retained

EP1 is **dropped**, not carried into prod. No documented requirement justified
Elastic Premium (MG-24 point 6); Flex's `always_ready`/per-instance memory
covers the prod warm-baseline need at materially lower cost.

### Cost posture

- **Dev:** `always_ready = 0` → **scale-to-zero**, **~$0 idle**, comfortably
  inside the $50 RG budget.
- **Prod:** `always_ready >= 1` → a small always-ready GB-s baseline, **materially
  below the EP1 floor** it replaces.

## Relationship to the App Insights / data-service ADR

This ADR **reuses**, and does not duplicate, the accepted-residual /
coupled-invariant model in
[`mg-24-appinsights-key-in-terraform-state`](mg-24-appinsights-key-in-terraform-state.md).
That ADR established:

- The **`shared_access_key_enabled = false`** posture on the functions storage
  account (the Storage row) — which Flex's MI-blob deployment lets us **keep**
  rather than relax. Flex is what makes that row's "shared-key auth safely off
  without breaking the Functions runtime" claim continue to hold under the new
  hosting model.
- The **fail-closed gate machinery** (`tf-plan-secret-inspection.sh` +
  `tf-static-checks.sh` check 9) that this change re-points at the
  `azurerm_function_app_flex_consumption` resource shape: the gate still walks
  `app_settings` (and now `site_config`) for prohibited secret VALUES, still
  passes on the flex shape, and still **fails closed** if shared-key is
  re-enabled. **No new authenticating-key exception is introduced** — the IoT Hub
  exception list is unchanged.

See that ADR for the full inert-key reasoning; it is not repeated here.

## Alternatives considered

- **Re-enable storage shared key so Y1 works.** **Rejected** — reintroduces a
  live storage credential in state and breaks the coupled invariant the
  data-service ADR enforces (MG-24 point 5). Flex removes the need entirely.
- **Keep the Y1/EP1 split, fix Y1 another way.** **Rejected** — no path fixes the
  Y1 content-share 403 without shared-key; and EP1 has no documented requirement
  (MG-24 point 6). A single model is simpler and cheaper.
- **Upgrade the provider to get Flex.** **Unnecessary** — Flex Consumption is
  supported on the pinned `azurerm` v4.81.0; no upgrade is taken.

## Consequences

- **Both envs run one Flex Consumption model** on the pinned provider. The
  `azurerm_linux_function_app` resource is **replaced** by
  `azurerm_function_app_flex_consumption`. The `azurerm_service_plan` is **RETAINED
  but repurposed to SKU `FC1`** (the Flex plan): `service_plan_id` is a **required**
  argument on the flex resource in the pinned `azurerm` v4.81.0 schema, so the plan
  resource must stay — it is **not** removed, only re-SKU'd from Y1/EP1 to FC1.
  Any future change must not reintroduce a **Y1/EP1** plan SKU or an Azure Files
  content share.
- **The live re-apply is destroy+recreate of the entire stack**, region-driven,
  with **Cosmos data loss** requiring an operator migration decision first. This
  is expected and operator-gated — out of scope for this deterministic pipeline.
- **The deployment container is created over the ARM control plane (azapi), so the
  first apply needs NO pre-apply storage data-plane grant** and the provider does
  **not** set `storage_use_azuread`. This removes the same-apply chicken-and-egg and
  the provider-global data-plane side effects the architect flagged (MG-24 reds
  2f5154 / b08ced).
- **The deploy flow is Flex OneDeploy** (`func publish` / OneDeploy of the
  package zip to the MI-auth blob container), not Kudu zip-deploy /
  `WEBSITE_RUN_FROM_PACKAGE` / an Azure Files share. `function_app_name` stays the
  deploy source of truth; the app-deploy principal gains a deployment-container
  Blob Data role.
- **Node 24** is the runtime; the API's `engines.node` and the CI Node version
  are bumped to match.
- **The secrets-out-of-state posture is preserved.** Shared-key stays disabled on
  the functions storage account; the fail-closed gates carry to the flex resource
  shape and still fail closed on a re-enabled key. The IoT-Hub-only exception set
  is unchanged.
- Related docs: the Flex deploy model, Node 24, and the West US 2 + whole-stack
  relocation caveat are documented in
  [`docs/infrastructure/bootstrap-runbook.md`](../../docs/infrastructure/bootstrap-runbook.md).
  There is **no** pre-apply Blob-Data-Owner grant to document — the deployment
  container is created over the ARM control plane (azapi), so the first apply
  needs no manual data-plane grant and the provider sets no `storage_use_azuread`.
