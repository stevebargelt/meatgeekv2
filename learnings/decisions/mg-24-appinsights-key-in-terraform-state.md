# Data-service keys remain in Terraform state as computed attributes, made inert by disabling local/key auth where safe (accepted risk); IoT Hub is the documented exception

> Originally scoped to the Application Insights connection string; **generalized
> in MG-24 round 11** to the full data-service posture (Cosmos DB, SignalR,
> Storage) with IoT Hub as the one documented exception. The App Insights
> reasoning below is the worked example the generalization follows.

- **Status:** Accepted (revised — MG-24 corrective round; generalized round 11)
- **Date:** 2026-07-20
- **Ticket:** MG-24 (greenfield V2 infrastructure — secrets-out-of-state hardening)
- **Scope:** `apps/infrastructure` — App Insights telemetry wiring plus the
  Cosmos / SignalR / Storage / IoT Hub data services and the pre-apply
  secret-inspection gate

> **Attribute-name note (MG-12):** The App Insights and Cosmos DB resources now
> express local/key-auth disablement as **`local_authentication_enabled = false`**,
> renamed from the deprecated `local_authentication_disabled = true` for azurerm
> v5 forward-compat. This is an **inverted boolean with identical semantics** —
> local/key auth is OFF; the security decision and accepted-residual reasoning are
> unchanged. The secret-inspection gate and the cosmos-db module tests track the
> new attribute name. SignalR (`local_auth_enabled = false`), Storage
> (`shared_access_key_enabled = false`), and the Event Hubs namespace
> (`local_authentication_enabled = false`) were **not** part of this rename.

## Context

MG-24 drove every backing service the Function App uses to an **identity-based**
model: the app runs under a **system-assigned managed identity**, and access to
Cosmos DB, the IoT-telemetry Event Hub, SignalR, and host storage is granted by
**RBAC role assignments** over **non-secret endpoints**. The former
`connection_string` / `primary_key` / SAS secret outputs on the Cosmos, Storage,
IoT Hub, and SignalR modules were removed, so **no connection string or primary
key VALUE is ever USED — none is placed in `app_settings` or surfaced as a
Terraform output** for those services.

### Correction (MG-24 red-wide round 12): the Event Hubs namespace RootManage key is now disabled too — IoT Hub is the SOLE live-key exception

Round 11 (below) disabled local/key auth on Cosmos, SignalR, and Storage and left
IoT Hub as the documented exception — but it **missed the Event Hubs namespace**.
`azurerm_eventhub_namespace.main` auto-creates a **RootManageSharedAccessKey** SAS
policy whose primary/secondary keys and connection strings are computed attributes
that land in state **by construction**, and round 11 left SAS auth **enabled** on
it. That made the RootManage key a **live data-plane credential in state that was
outside the documented IoT-Hub exception** — so the claim "IoT Hub is the ONLY
live-key exception" was, at that point, false.

The fix is to set **`local_authentication_enabled = false`** on
`azurerm_eventhub_namespace.main`, exactly as Cosmos/SignalR/Storage disable their
local auth. This is **safe** because both access paths to the namespace are
already **identity-based**, not SAS: the IoT Hub **produces** via
`azurerm_iothub_endpoint_eventhub.eventhub_realtime`
(`authentication_type = identityBased`) backed by the *Azure Event Hubs Data
Sender* role assignment, and the Function App **consumes** via *Azure Event Hubs
Data Receiver* (`IOTHUB_EVENTS__fullyQualifiedNamespace`). Nothing reads the
RootManage key. With local auth disabled the RootManage key becomes a
**non-authenticating residual**, and **IoT Hub is once again the sole documented
live-key exception** (device connectivity). The secret-inspection gate now
enforces this for `azurerm_eventhub_namespace` (`local_authentication_enabled ==
false`) the same way it does for the other data services.

### Correction (MG-24 red-wide round 11): the inherent-key residual is broader than App Insights

An earlier version of this ADR asserted that "no connection strings or primary
keys land in Terraform state" for Cosmos / Storage / IoT Hub / SignalR — that
those services were "fully identity-based with no secrets in state." **That
claim was inaccurate.** Removing the secret OUTPUTS and never USING a key does
not remove the key from state. Just like App Insights, **every TF-managed data
service exposes its key / connection-string as a COMPUTED attribute**, and
Terraform reads those attributes back into state on each apply. So the Cosmos
account's `primary_key` / `connection_strings`, the Storage account's access
keys, the SignalR service's `primary_access_key`, the Event Hubs namespace's
auto-created `RootManageSharedAccessKey`, and the IoT Hub's
`shared_access_policy` keys are all present in state **by construction** — no
`azurerm` argument suppresses them. The accurate posture is therefore the same
as App Insights: not "no keys in state," but **keys that cannot authenticate**,
achieved by disabling local/key auth on each service **where doing so is safe**.
The section "**Extending the control to the data services**" below records that
generalized decision and the one deliberate exception (IoT Hub).

Application Insights was the first case examined. The
`azurerm_application_insights.main` resource exposes `instrumentation_key` and
`connection_string` as **computed attributes** — the Azure platform generates
them when the resource is created. Terraform reads every managed resource's
computed attributes back into state on each apply, so those values are present
in the state file **by construction**. There is no `azurerm` argument that
suppresses them; the only way to keep the key out of *this* stack's state is to
stop managing the App Insights resource in this stack.

### Correction to the original decision

The first MG-24 pass tried to keep the risk down by parsing the
**`IngestionEndpoint`** out of the connection string and passing only that
endpoint-only fragment to
`APPLICATIONINSIGHTS_CONNECTION_STRING`, deliberately dropping the
`InstrumentationKey`. **An operator operational review invalidated that
approach.** Microsoft treats the connection string — **including its
`InstrumentationKey` segment** — as the **destination-resource identifier** that
the ingestion client uses to route telemetry to the correct App Insights
component. This is required **even under Entra (AAD) authenticated ingestion**:
`APPLICATIONINSIGHTS_AUTHENTICATION_STRING="Authorization=AAD"` changes *how the
caller authenticates*, not *how the destination is identified*. An
endpoint-only value without the `InstrumentationKey` does not reliably resolve
the destination and is not the shape Microsoft documents. So the corrected
wiring must pass the **full TF-managed connection string** (with the
`InstrumentationKey`) to the Function App.

That reopens the question the endpoint-only hack was meant to close: the
`InstrumentationKey` is now present in `app_settings` **and** state. The
corrected control is to make the key **inert for authentication** rather than to
hide it.

## Decision

**Accept** the Application Insights **full connection string** (with its
`InstrumentationKey`) being present in `app_settings` and Terraform state, on the
condition that **`local_authentication_enabled = false`** is set on
`azurerm_application_insights.main`. Do not move the resource out of the primary
stack to suppress the key.

The acceptance rests on the following facts, all verifiable in
`apps/infrastructure`:

1. **The instrumentation key cannot authenticate ingestion.** Setting
   **`local_authentication_enabled = false`** on
   `azurerm_application_insights.main` forces **Entra (AAD)-only ingestion**: the
   platform rejects any telemetry submitted with only the instrumentation key.
   The key that sits in `app_settings`/state is therefore a **destination
   identifier, not a credential** — even in full disclosure it cannot be used to
   write telemetry, because key-based (local) auth is turned off at the
   component. This is the load-bearing control that replaces the old
   endpoint-only parse.

2. **Runtime ingestion is identity-based.** The Function App authenticates to
   App Insights via **managed identity / AAD**, not the key. Its identity holds
   the **`Monitoring Metrics Publisher`** role on the App Insights resource
   (`azurerm_role_assignment.functions_appinsights_publisher` in `main.tf`), and
   the host is configured with
   **`APPLICATIONINSIGHTS_AUTHENTICATION_STRING = "Authorization=AAD"`**. The
   full connection string in
   `APPLICATIONINSIGHTS_CONNECTION_STRING = "<full TF-managed connection string>"`
   supplies the destination coordinates; the AAD credential (not the key)
   authorizes the write.

3. **Telemetry-write-only blast radius.** Even if local auth were ever
   re-enabled, the instrumentation/ingestion key grants only **telemetry
   ingestion** into this one App Insights component. It confers no read access to
   telemetry already stored, and no access to any other Azure data plane or
   resource. The worst case is spurious telemetry writes to a single component —
   not data exfiltration or resource control.

4. **State-container access is restricted.** The Terraform state lives in the
   remote `azurerm` backend state container, whose access is **container-scoped
   RBAC-restricted**, so the value at rest is not broadly readable.

### Coupled invariant (enforced by the step-8 gate)

The connection string is safe in `app_settings`/state **only while
`local_authentication_enabled = false` remains set**. If that flag is ever
removed, the instrumentation key becomes a live ingestion credential again and
this acceptance no longer holds.

This coupling is **not** left to reviewer memory — it is **fail-closed
enforced** by the pre-apply security gate:

- **`apps/infrastructure/scripts/tf-plan-secret-inspection.sh`** parses
  `terraform show -json`, distinguishes field **names** from **values**, and
  **allows the full App Insights connection string in the Function App
  `app_settings` ONLY when `azurerm_application_insights.main` has
  `local_authentication_enabled = false`**. Any other connection string /
  primary|access|SAS key / instrumentation key in `app_settings` or outputs — or
  the AI connection string **without** the local-auth-disabled flag — makes the
  script **exit nonzero**. It is the **required pre-apply gate** and is invoked
  before `terraform apply` in the runbook.
- **`apps/infrastructure/scripts/tf-static-checks.sh`** (check 9) statically
  asserts the same cross-field condition on the Terraform source: the full
  `var.application_insights_connection_string` may reach the FA `app_settings`
  **only** when `main.tf` sets `local_authentication_enabled = false` on the AI
  resource.

## Extending the control to the data services (MG-24 round 11)

The App Insights control — *accept the inherent in-state key, but disable
local/key auth so it cannot authenticate* — is not unique to App Insights. It is
the correct posture for **every** TF-managed data service whose keys are
inherent computed attributes. The operator-approved decision is to apply it
**where safe** and to document the one place it is not:

| Service | In-state key attribute(s) | Control | Why safe / why exception |
| --- | --- | --- | --- |
| **Cosmos DB** (`azurerm_cosmosdb_account.main`) | `primary_key`, `secondary_key`, `connection_strings` | `local_authentication_enabled = false` | Data-plane access is AAD/RBAC: the Function App **and** the IoT Hub identity each hold *Cosmos DB Built-in Data Contributor* (SQL role assignments). Both keep working with key auth off; the in-state key can no longer authenticate. |
| **SignalR** (`azurerm_signalr_service.main`) | `primary_access_key`, `primary_connection_string` | `local_auth_enabled = false` | The Function App connects identity-based via `AzureSignalRConnectionString__serviceUri` and holds *SignalR Service Owner*. AAD negotiation keeps working with AccessKey auth off. |
| **Storage** (`azurerm_storage_account.functions`) | account access keys, connection string | `shared_access_key_enabled = false` (already set) | Deployment storage is **fully managed-identity** under the MG-24 Flex hosting model: the Flex app reads its package from a `blobContainer` via `storage_authentication_type = "SystemAssignedIdentity"` (no Azure Files content share, no `storage_account_access_key`, no key-based `AzureWebJobsStorage`), and the identity holds *Storage Blob Data Owner* + *Storage Queue Data Contributor*. Shared-key auth is safely off without breaking the Functions runtime — see [ADR: Flex Consumption hosting model](mg-24-flex-consumption-hosting-model.md). |
| **Event Hubs namespace** (`azurerm_eventhub_namespace.main`) | auto-created `RootManageSharedAccessKey` primary/secondary keys + connection strings | `local_authentication_enabled = false` | Both access paths are identity-based: the IoT Hub **produces** via `azurerm_iothub_endpoint_eventhub.eventhub_realtime` (`authentication_type = identityBased` + *Azure Event Hubs Data Sender*), and the Function App **consumes** via *Azure Event Hubs Data Receiver* (`IOTHUB_EVENTS__fullyQualifiedNamespace`). Nothing reads the RootManage key, so SAS auth is safely off (round 12). |
| **IoT Hub** (`azurerm_iothub.main`) | `shared_access_policy[].primary_key` / `secondary_key` (SAS) | **NOT disabled — the SOLE documented exception** | Real BBQ **devices**, the **data-pusher**, and the **device-controller** authenticate to the hub with **SAS keys** (the device SDKs' supported path). Setting `local_authentication_enabled = false` would sever device connectivity. Key auth is deliberately kept enabled; the in-state SAS keys are **live credentials**. This is now the **only** service whose in-state key remains live. |

The load-bearing facts that made the App Insights key inert (local auth off →
key cannot authenticate; runtime access is identity-based; restricted state
access) apply identically to Cosmos, SignalR, Storage, and the Event Hubs
namespace (round 12). For those four, the in-state key is a
**present-but-non-authenticating residual**, exactly like the App Insights ikey.

**IoT Hub is the accepted exception.** Its SAS keys remain live because device
connectivity requires them. The mitigation is the same fourth control the App
Insights acceptance already rests on — **restricted, container-scoped RBAC state
access** (the state blob is not broadly readable) — plus this documented
acceptance. The blast radius is bounded to the IoT Hub data plane (device
message ingest / C2D), and rotating the SAS policy keys invalidates any leaked
copy. If IoT ever moves fully to per-device X.509 / AAD auth, revisit and
disable local auth here too.

### Coupled invariant, generalized (enforced by the gate)

The per-service acceptance holds **only while local/key auth stays disabled** on
Cosmos, SignalR, Storage, and the Event Hubs namespace.
`apps/infrastructure/scripts/tf-plan-secret-inspection.sh`
now enforces this over the real plan/state: for each `azurerm_cosmosdb_account` /
`azurerm_storage_account` / `azurerm_signalr_service` / `azurerm_eventhub_namespace`
it **accepts** the inherent key residual **only** when that resource's disable-flag
is set (`local_authentication_enabled = false` / `shared_access_key_enabled = false`
/ `local_auth_enabled = false` / `local_authentication_enabled = false`), and
**flags a VIOLATION (exit nonzero)** if local auth is left enabled — because then
the in-state key is a live credential. `azurerm_iothub` key attributes are the
**acknowledged exception**: accepted with a printed note. A real credential VALUE reaching `app_settings` or an output is
a violation regardless of service, unchanged.

## Alternatives considered

- **Keep the endpoint-only parse (original MG-24 approach).** **Rejected as
  non-functional:** Microsoft requires the full connection string (including the
  `InstrumentationKey`) as the destination identifier even under AAD ingestion,
  so an endpoint-only value does not reliably resolve the App Insights component.
  The corrective round replaced this hack with the local-auth-disabled control.

- **Move Application Insights (and its Log Analytics workspace) to a separate
  bootstrap / platform stack.** The primary stack would then consume the
  ingestion coordinates as a data source or variable, and the connection string
  would live only in the platform stack's state. **Not chosen:** it introduces
  real structural complexity — a second state file, cross-stack wiring and apply
  ordering, and split ownership of the observability resources — to protect a
  **low-sensitivity, telemetry-write-only** value that has been rendered inert
  for authentication by `local_authentication_enabled = false`. The complexity is
  not justified.

## Consequences

- The Application Insights **full connection string** (with its
  `InstrumentationKey`) is present in `app_settings` and the primary stack's
  Terraform state; this is expected and accepted, **conditioned on**
  `local_authentication_enabled = false` making the key inert for auth.
- The runtime authentication path stays identity-based (AAD + `Monitoring
  Metrics Publisher`); the key is a destination identifier, not a credential. Any
  future change must preserve `local_authentication_enabled = false`, not replace
  AAD ingestion with key-based ingestion.
- The coupled invariant is machine-enforced: removing
  `local_authentication_enabled = false` will fail both the pre-apply
  `tf-plan-secret-inspection.sh` gate and the `tf-static-checks.sh` check 9 —
  the change cannot ship silently.
- If App Insights sensitivity ever rises (e.g. it starts brokering access beyond
  telemetry ingestion), revisit the separate-platform-stack alternative above.
- **Validation scope.** This coupling — and the rest of the MG-24 deterministic
  layer (Terraform sources, the fail-closed `tf-plan-secret-inspection.sh` gate,
  the bootstrap script, the workflow wiring) — is **static-validated and
  operationally-verified where possible** without live Azure: `terraform validate`
  / `fmt` / module `test` (mocked provider), the `tf-plan-secret-inspection.sh`
  gate exercised against crafted plan/state fixtures (accepted-residual → exit 0,
  planted key in `resource_changes.after` → nonzero), the bootstrap unit tests,
  and the api-interfaces posture specs. The **greenfield DEV acceptance proof**
  (the live apply / publish / token-acquisition + authenticated-invocation flow in
  the runbook's Part 2) is the **operator's out-of-band live run** — it requires a
  real dev tenant/subscription and is **not** part of this deterministic delivery;
  it is captured as operator evidence, not CI.
- Related docs: the required pre-apply inspection gate and the local-auth-disabled
  model are documented in
  [`docs/infrastructure/bootstrap-runbook.md`](../../docs/infrastructure/bootstrap-runbook.md)
  and [`apps/infrastructure/README.md`](../../apps/infrastructure/README.md);
  identity-based access is described in
  [`docs/api/azure-functions.md`](../../docs/api/azure-functions.md#application-settings)
  and
  [`docs/infrastructure/terraform-setup.md`](../../docs/infrastructure/terraform-setup.md).
