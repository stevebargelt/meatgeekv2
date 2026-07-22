# Native Azure Monitor OTLP ingestion via `otlphttp` + `azure_auth` (managed identity), replacing the community `azuremonitor` exporter

- **Status:** Proposed (authored + static-validated; activation MG-24/MG-25/MG-34-gated)
- **Date:** 2026-07-22
- **Ticket:** MG-33 (F1 collector auth / F3 collector artifact hardening)
- **Scope:** `apps/infrastructure/otel-collector` (collector config), `apps/infrastructure/modules/native-otlp` (DCE/DCR/UAI/RBAC/Container App), and the `enable_native_otlp` wiring in `apps/infrastructure/main.tf` / `variables.tf`

> **Honest boundary.** Everything below is **authored and static-validated only**
> (`terraform validate`/`fmt`, module tests with a mocked provider, and a CI
> `otelcol-contrib validate --config` step). It is **NOT operationally verified**:
> no Go span has been shown landing in App Insights through this path. Live proof
> is fenced behind MG-34 (see Consequences). Do not read a green `otelcol-contrib
> validate` or a clean `terraform plan` as "telemetry flows."

## Context

The Go edge services (`apps/device-controller`, `apps/data-pusher`) emit
OpenTelemetry over **OTLP**. Application Insights does not accept raw OTLP, so a
central OpenTelemetry Collector sits between the edges and Azure Monitor and
forwards the telemetry on.

The collector's forwarding leg previously used the community
**`azuremonitor`** (Contrib) exporter, configured with an App Insights
**`connection_string`** — i.e. **local (instrumentation-key) auth**. That path
is **non-functional in this stack**: [`mg-24-appinsights-key-in-terraform-state`](mg-24-appinsights-key-in-terraform-state.md)
sets **`local_authentication_enabled = false`** on
`azurerm_application_insights.main`, which forces **Entra (AAD)-only ingestion**
and **rejects** any telemetry submitted with only the connection-string / ikey.
The community `azuremonitor` exporter has **no Entra authentication path**, so
under this deliberate secrets-out-of-state posture the collector could not
authenticate to App Insights at all. F1 recorded this as a hard blocker.

A second, independent problem (F3): the collector artifact was not
deployment-safe — an unpinned image, no persistent queue or retry, a `0.0.0.0`
listener, no CI config validation, and a README that described the old exporter
as "the supported path" and implied this directory provisions the Container Apps
environment. F3 folds into this same rewrite.

## Decision

Replace the community `azuremonitor` exporter with **native Azure Monitor OTLP
ingestion**:

- The collector's **`otlphttp`** exporter posts to the **full native-OTLP traces
  ingestion URL** on a **Data Collection Endpoint (DCE)** — the exporter's
  **`traces_endpoint`**, shaped
  `https://<logs-dce-ingestion-host>/dataCollectionRules/<dcr-immutable-id>/streams/Microsoft-OTLP-Traces/otlp/v1/traces`.
  Routing is carried by the **URL path** (the DCR immutable id and the fixed
  `Microsoft-OTLP-Traces` entry stream), **not** by `x-ms-dcr-immutable-id` /
  `x-ms-stream-name` headers (those are removed). The **Data Collection Rule
  (DCR)** ingests the built-in `Microsoft-OTel-Traces-*` streams and enriches
  them from an App Insights reference into the workspace-based App Insights
  tables (`AppDependencies` / `AppTraces`).
- Authentication is Entra-only via the **`azure_auth`** collector extension
  (renamed from `azureauth` as of Contrib `>=0.148.0`), backed by a
  **user-assigned** Container App **managed identity**. The extension mints an
  AAD token for an **explicitly configured** `scopes:` audience —
  `https://monitor.azure.com/.default` — which is **pinned from config, not
  derived from the request Host**. **No ingestion key, no connection string** in
  the collector.
- **`local_authentication_enabled = false` stays set** on App Insights. This
  change adds an Entra-authenticated ingestion path; it does **not** re-open
  local auth.

The Go edge OTLP contract is **unchanged** — services still export OTLP at the
collector via `OTEL_EXPORTER_OTLP_ENDPOINT`; only the collector's outbound leg
changed.

### Load-bearing details

1. **User-assigned (not system-assigned) managed identity.** The DCR role
   assignment needs the identity's principal id **before** the Container App
   exists. A system-assigned identity only exists after the app is created,
   reintroducing the create-then-grant ordering gap this stack deliberately
   avoids (`azurerm_user_assigned_identity.collector`).

2. **`Monitoring Metrics Publisher` scoped to the DCR — NOT App Insights.** This
   is the non-obvious requirement. Ingestion through the DCE/DCR authorizes
   against the **DCR** resource, so
   `azurerm_role_assignment.collector_dcr_publisher` is scoped to
   `azapi_resource.otlp_dcr.id`. This is **deliberately
   different** from the Function App's Breeze path
   (`functions_appinsights_publisher`), whose same-named role is scoped to App
   Insights. Copying the App Insights scope here would **not** authorize DCR
   ingestion.

3. **Native-OTLP DCR authored via `azapi` (not `azurerm`).** The DCR is an
   `azapi_resource` of type
   `Microsoft.Insights/dataCollectionRules@2024-03-11` carrying
   `references.applicationInsights` plus a `directDataSources.otelTraces` data
   source over the **built-in** `Microsoft-OTel-Traces-*` streams
   (`-Spans` / `-Events` / `-Resources`) with App Insights enrichment
   (`enrichWithReference` / `replaceResourceIdWithReference`). This is the shape
   the MS OTLP_DCE_DCR ARM template targets; the `azurerm` provider's
   `azurerm_monitor_data_collection_rule` (v4) **cannot express** it, so the
   `azapi` provider (`~> 2.0`) is added for this one resource. The DCE stays an
   `azurerm` resource — only the DCR needed the native-OTLP body.

4. **Pinned CONTRIB image.** `otlphttp` + `azure_auth` + `file_storage` all
   require the Contrib distribution. The image is pinned to
   **`otel/opentelemetry-collector-contrib:0.151.0`** by **tag AND `@sha256`
   digest** (re-resolve the digest at deploy). The version floor is DOC-VERIFIED
   (3rd review): **`>=0.132.0`** (native-OTLP prerequisite), **`>=0.148.0`** (the
   current `azure_auth` config syntax — key renamed from `azureauth`, explicit
   `scopes:` supported), and **`>0.150.0`** so it is **outside** the
   `GHSA-pjv4-3c63-699f` `azure_auth` inbound-auth-bypass advisory range
   (`0.124.0–0.150.0`). The outbound (exporter) auth used here is unaffected by
   that advisory, but the `>0.150.0` pin keeps MG-34's future collector
   **receiver** (inbound) auth off any version that accepts unauthenticated
   inbound requests. Native OTLP ingestion is version- and region-sensitive, so
   the pin is intentional, not incidental.

5. **Fail-closed edge boundary.** The collector Container App has **no `ingress`
   block** (no public listener) and the OTLP receiver binds **loopback only**
   (`127.0.0.1:4317`/`:4318`). The edge devices are off Azure's VNet and
   **cannot reach the collector yet, by design** — secure ingress is MG-34.

6. **Persistent durability (F3).** A `file_storage`-backed `sending_queue` plus
   `retry_on_failure` (with `max_elapsed_time: 0`) spools telemetry to disk so it
   survives collector restarts and transient 5xx/throttling rather than being
   dropped. It must be backed by a persistent Azure File volume on the Container
   App.

7. **Default-off activation flag.** `var.enable_native_otlp` (default `false`)
   count-guards the `native_otlp` module in `main.tf`, so with the flag off the
   module creates **zero** net-new resources and `terraform validate`/`plan` are
   unchanged. Production activation is a deliberate flag flip, not a side effect
   of a normal apply.

## Corrections (3rd review)

An earlier authoring of this decision **guessed** the native-OTLP specifics and
was **wrong on every count**. A 3rd operational review plus a research pass
against **Microsoft primary sources** corrected them. For the record, what changed
and why:

| Detail | Prior (wrong) | Corrected (DOC-VERIFIED) | Primary source |
| --- | --- | --- | --- |
| Extension key | `azureauth` | `azure_auth` (renamed as of Contrib `>=0.148.0`) | azureauthextension README |
| Ingestion scope | audience `https://monitor.azure.com`, **derived from the request Host** | **explicit** `scopes: [https://monitor.azure.com/.default]`, pinned from config | azureauthextension README |
| Exporter routing | bare `endpoint` + `x-ms-dcr-immutable-id` / `x-ms-stream-name` headers | full `traces_endpoint` URL (`.../dataCollectionRules/<immutable-id>/streams/Microsoft-OTLP-Traces/otlp/v1/traces`); **no headers** | MS Learn native-OTLP ingestion doc |
| DCR shape | `azurerm` custom `stream_declaration` + KQL `transform_kql` into `Microsoft-AppDependencies` | `azapi` `Microsoft.Insights/dataCollectionRules@2024-03-11` with `references.applicationInsights` + `directDataSources.otelTraces` over built-in `Microsoft-OTel-Traces-*` streams | AzureMonitorCommunity OTLP_DCE_DCR ARM template |
| Collector image | `0.128.0` (claim: `azureauth` first ships `0.126.0`) | `0.151.0`, tag + `@sha256` digest; floor `>=0.132.0` / `>=0.148.0` / `>0.150.0` | advisory `GHSA-pjv4-3c63-699f` |

The values above are now **DOC-VERIFIED** — reconciled against the four primary
sources named — but that verification is **documentary, not operational**. The
config remains **authored + static-validated only** (`terraform validate`/`fmt`
clean flag-off with the `azapi` provider installed, plus the CI
`otelcol-contrib validate --config` step); **no live Go span has reached App
Insights**. The live span-to-App-Insights proof and the negative RBAC check are
**MG-34** (itself MG-24/MG-25-gated). Do not read DOC-VERIFIED as "telemetry
flows."

## Alternatives considered

- **Re-enable local (connection-string) auth on App Insights so the community
  `azuremonitor` exporter works.** **Rejected.** It reverses the deliberate
  secret-in-state posture of [`mg-24-appinsights-key-in-terraform-state`](mg-24-appinsights-key-in-terraform-state.md):
  the in-state ikey is accepted **only because** `local_authentication_enabled =
  false` makes it non-authenticating, and that coupling is machine-enforced by
  the pre-apply secret-inspection gate. Turning local auth back on would make the
  in-state key a live ingestion credential again.

- **Point telemetry at a different backend.** **Rejected** to stay within the
  existing App Insights / Log Analytics workspace already provisioned and
  RBAC-wired in this stack. A new backend adds a parallel observability estate
  for no benefit here.

The chosen path is the only option that preserves **Entra-only ingestion** *and*
keeps the **Go edge OTLP contract unchanged**.

## Consequences

- **Native OTLP ingestion is DEV-PREVIEW.** It is not GA, is regionally limited,
  and is version-sensitive — hence the pinned `otelcol-contrib:0.151.0` (tag +
  digest) and the MG-25 preview-acceptance gate. The DCR body
  (`references.applicationInsights`, `directDataSources.otelTraces` over the
  built-in `Microsoft-OTel-Traces-*` streams, `destinations.logAnalytics`,
  `dataFlows`) is DOC-VERIFIED against the MS OTLP_DCE_DCR ARM template but
  remains the **authored baseline**; it is confirmed against live ingestion under
  MG-25.

- **Production activation is fenced.** Flipping `enable_native_otlp` on requires:
  - **MG-24** — the Container Apps managed environment + its Azure File storage
    association (passed in via `container_app_environment_id` /
    `otlp_collector_storage_name`); both are empty until MG-24 lands.
  - **MG-25** — native-OTLP preview acceptance in the target region.

- **RBAC is DCR-scoped** (`Monitoring Metrics Publisher` on the DCR, not App
  Insights) — the non-obvious requirement above. MG-34 AC3 proves the negative:
  remove this assignment and ingestion must be rejected.

- **Edge ingress + live proof are MG-34.** The fail-closed posture means edges
  cannot reach the collector until MG-34 delivers secure off-VNet ingress
  (mTLS / auth-terminating proxy / private tunnel), the live
  Go-span-to-App-Insights proof (AC2), and the negative RBAC check (AC3). MG-33
  cannot close on this authoring alone.

- **Metrics are intentionally not wired.** The removed `azuremonitor` exporter
  carried metrics for free; native OTLP ingestion needs its own DCR stream +
  transform for metrics, which is out of scope for F1/F3 (traces). Deferred.

- **Validation scope.** Authored + static-validated only: `terraform
  validate`/`fmt`, module tests (mocked provider), and CI `otelcol-contrib
  validate --config`. **Not** operationally verified — see the boundary note at
  the top and MG-34.

- Related docs: the collector topology and gate chain are documented in
  [`apps/infrastructure/otel-collector/README.md`](../../apps/infrastructure/otel-collector/README.md);
  the local-auth-disabled posture this decision preserves is in
  [`mg-24-appinsights-key-in-terraform-state`](mg-24-appinsights-key-in-terraform-state.md).
