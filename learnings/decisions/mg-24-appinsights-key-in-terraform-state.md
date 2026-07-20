# Application Insights connection string remains in Terraform state, made inert by local-auth disable (accepted risk)

- **Status:** Accepted (revised — MG-24 corrective round)
- **Date:** 2026-07-20
- **Ticket:** MG-24 (greenfield V2 infrastructure — secrets-out-of-state hardening)
- **Scope:** `apps/infrastructure` (`azurerm_application_insights.main` and the
  Function App telemetry wiring)

## Context

MG-24 drove every backing service the Function App uses to an **identity-based**
model: the app runs under a **system-assigned managed identity**, and access to
Cosmos DB, the IoT-telemetry Event Hub, SignalR, and host storage is granted by
**RBAC role assignments** over **non-secret endpoints**. The former
`connection_string` / `primary_key` / SAS secret outputs on the Cosmos, Storage,
IoT Hub, and SignalR modules were removed, so **no connection strings or primary
keys land in `app_settings` or Terraform state** for those services.

Application Insights is the one remaining exception. The
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
condition that **`local_authentication_disabled = true`** is set on
`azurerm_application_insights.main`. Do not move the resource out of the primary
stack to suppress the key.

The acceptance rests on the following facts, all verifiable in
`apps/infrastructure`:

1. **The instrumentation key cannot authenticate ingestion.** Setting
   **`local_authentication_disabled = true`** on
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
`local_authentication_disabled = true` remains set**. If that flag is ever
removed, the instrumentation key becomes a live ingestion credential again and
this acceptance no longer holds.

This coupling is **not** left to reviewer memory — it is **fail-closed
enforced** by the pre-apply security gate:

- **`apps/infrastructure/scripts/tf-plan-secret-inspection.sh`** parses
  `terraform show -json`, distinguishes field **names** from **values**, and
  **allows the full App Insights connection string in the Function App
  `app_settings` ONLY when `azurerm_application_insights.main` has
  `local_authentication_disabled = true`**. Any other connection string /
  primary|access|SAS key / instrumentation key in `app_settings` or outputs — or
  the AI connection string **without** the local-auth-disabled flag — makes the
  script **exit nonzero**. It is the **required pre-apply gate** and is invoked
  before `terraform apply` in the runbook.
- **`apps/infrastructure/scripts/tf-static-checks.sh`** (check 9) statically
  asserts the same cross-field condition on the Terraform source: the full
  `var.application_insights_connection_string` may reach the FA `app_settings`
  **only** when `main.tf` sets `local_authentication_disabled = true` on the AI
  resource.

All **other** services — Cosmos DB, Storage, IoT Hub, SignalR — remain **fully
identity-based with no secrets in state**. This decision is narrowly about the
inherent App Insights computed attribute and changes nothing about that posture.

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
  for authentication by `local_authentication_disabled = true`. The complexity is
  not justified.

## Consequences

- The Application Insights **full connection string** (with its
  `InstrumentationKey`) is present in `app_settings` and the primary stack's
  Terraform state; this is expected and accepted, **conditioned on**
  `local_authentication_disabled = true` making the key inert for auth.
- The runtime authentication path stays identity-based (AAD + `Monitoring
  Metrics Publisher`); the key is a destination identifier, not a credential. Any
  future change must preserve `local_authentication_disabled = true`, not replace
  AAD ingestion with key-based ingestion.
- The coupled invariant is machine-enforced: removing
  `local_authentication_disabled` will fail both the pre-apply
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
