# Native Azure Monitor OTLP ingestion via `otlphttp` + `azureauth` (managed identity), replacing the community `azuremonitor` exporter

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

- The collector's **`otlphttp`** exporter targets a **Data Collection Endpoint
  (DCE)** logs-ingestion URI, routing to a **Data Collection Rule (DCR)** by its
  **immutable id** + **stream name** (`x-ms-dcr-immutable-id` /
  `x-ms-stream-name` headers). The DCR transforms the OTLP trace stream into the
  workspace-based App Insights tables (`AppDependencies` / `AppTraces`).
- Authentication is Entra-only via the **`azureauth`** collector extension,
  backed by a **user-assigned** Container App **managed identity**. The extension
  mints an AAD token (audience `https://monitor.azure.com`, derived from the
  request Host) — **no ingestion key, no connection string** in the collector.
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
   `azurerm_monitor_data_collection_rule.otlp.id`. This is **deliberately
   different** from the Function App's Breeze path
   (`functions_appinsights_publisher`), whose same-named role is scoped to App
   Insights. Copying the App Insights scope here would **not** authorize DCR
   ingestion.

3. **Pinned CONTRIB image.** `otlphttp` + `azureauth` + `file_storage` all
   require the Contrib distribution, and `azureauth` first ships in Contrib
   `0.126.0`. The image is pinned to **`otel/opentelemetry-collector-contrib:0.128.0`**
   (resolve to a digest at deploy time). Native OTLP ingestion is version- and
   region-sensitive, so the pin is intentional, not incidental.

4. **Fail-closed edge boundary.** The collector Container App has **no `ingress`
   block** (no public listener) and the OTLP receiver binds **loopback only**
   (`127.0.0.1:4317`/`:4318`). The edge devices are off Azure's VNet and
   **cannot reach the collector yet, by design** — secure ingress is MG-34.

5. **Persistent durability (F3).** A `file_storage`-backed `sending_queue` plus
   `retry_on_failure` (with `max_elapsed_time: 0`) spools telemetry to disk so it
   survives collector restarts and transient 5xx/throttling rather than being
   dropped. It must be backed by a persistent Azure File volume on the Container
   App.

6. **Default-off activation flag.** `var.enable_native_otlp` (default `false`)
   count-guards the `native_otlp` module in `main.tf`, so with the flag off the
   module creates **zero** net-new resources and `terraform validate`/`plan` are
   unchanged. Production activation is a deliberate flag flip, not a side effect
   of a normal apply.

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
  and is version-sensitive — hence the pinned `otelcol-contrib:0.128.0` and the
  MG-25 preview-acceptance gate. The DCR `stream_declaration` columns,
  `transform_kql`, and `output_stream` binding are the **authored baseline**;
  they are finalized under MG-25.

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
