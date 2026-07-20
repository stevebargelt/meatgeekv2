# Application Insights instrumentation key remains in Terraform state (accepted risk)

- **Status:** Accepted
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

Red-wide security review flagged the key's presence in state as a finding. The
operator reviewed it and **accepted it as low risk** rather than restructuring
the stack.

## Decision

**Accept** the Application Insights instrumentation key / connection string being
present in Terraform state. Do not move the resource out of the primary stack to
suppress it.

The acceptance rests on three facts, all verifiable in `apps/infrastructure`:

1. **Telemetry-write-only.** The instrumentation/ingestion key grants only
   **telemetry ingestion** into this one App Insights component. It confers no
   read access to telemetry already stored, and no access to any other Azure
   data plane or resource. The blast radius of disclosure is spurious telemetry
   writes to a single component — not data exfiltration or resource control.

2. **The key is not used for authentication.** The Function App authenticates to
   App Insights via **managed identity / AAD**, not the key. Its identity holds
   the **`Monitoring Metrics Publisher`** role on the App Insights resource
   (`azurerm_role_assignment.functions_appinsights_publisher` in `main.tf`), and
   the host is configured with
   **`APPLICATIONINSIGHTS_AUTHENTICATION_STRING = "Authorization=AAD"`**. Only
   the **non-secret ingestion endpoint** is propagated to the app —
   `APPLICATIONINSIGHTS_CONNECTION_STRING = "IngestionEndpoint=<url>"`, with the
   `IngestionEndpoint` parsed out of the connection string in the root module
   and the key portion deliberately dropped. The instrumentation key is
   therefore **not** placed in `app_settings`, and runtime telemetry publishing
   does not depend on it.

3. **State-container access is restricted.** The Terraform state lives in the
   remote `azurerm` backend state container, whose access is restricted, so the
   value at rest is not broadly readable.

All **other** services — Cosmos DB, Storage, IoT Hub, SignalR — remain **fully
identity-based with no secrets in state**. This decision is narrowly about the
inherent App Insights computed attribute and changes nothing about that posture.

## Alternatives considered

- **Move Application Insights (and its Log Analytics workspace) to a separate
  bootstrap / platform stack.** The primary stack would then consume the
  ingestion endpoint as a data source or variable, and the instrumentation key
  would live only in the platform stack's state. **Not chosen:** it introduces
  real structural complexity — a second state file, cross-stack wiring and apply
  ordering, and split ownership of the observability resources — to protect a
  **low-sensitivity, telemetry-write-only** value that is not used for
  authentication. The complexity is not justified by the sensitivity of the key.

## Consequences

- The Application Insights instrumentation key / connection string remains in the
  primary stack's Terraform state as a computed attribute; this is expected and
  accepted, not a regression to fix.
- The runtime authentication path stays identity-based (AAD + `Monitoring
  Metrics Publisher`); the key is inert for auth. Any future move to eliminate
  the key from state must preserve that path, not replace it with key-based
  ingestion.
- If App Insights sensitivity ever rises (e.g. it starts brokering access beyond
  telemetry ingestion), revisit the separate-platform-stack alternative above.
- Related docs: identity-based access is described in
  [`docs/api/azure-functions.md`](../../docs/api/azure-functions.md#application-settings),
  [`docs/infrastructure/terraform-setup.md`](../../docs/infrastructure/terraform-setup.md),
  and [`docs/infrastructure/bootstrap-runbook.md`](../../docs/infrastructure/bootstrap-runbook.md).
