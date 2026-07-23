# MeatGeek OTel Collector

The **required translation hop** between the Go edge services and Azure
Application Insights.

> **Status (MG-33 F1/F3): AUTHORED + STATIC-VALIDATED ONLY — NOT operational.**
> The native-OTLP path below is authored, `terraform validate`-clean, and passes
> a CI `otelcol-contrib validate --config` check. No Go span has been shown
> landing in App Insights through it. It is **default-off** (`enable_native_otlp`)
> and **fail-closed** (no ingress; loopback-only receiver), so edges cannot reach
> it yet **by design**. Standing it up live is gated on MG-24 + MG-25 + MG-34 —
> see [Gate chain](#gate-chain). Do not read a green validate as "telemetry
> flows."

## Purpose (MG-33)

The Go edge services — `apps/device-controller` and `apps/data-pusher` — emit
OpenTelemetry over **OTLP**. Application Insights does **not** accept raw OTLP,
so this collector receives the edge OTLP and forwards it to Azure Monitor.

The forwarding leg uses **native Azure Monitor OTLP ingestion**: the collector's
`otlphttp` exporter posts to the full native-OTLP **`traces_endpoint`** URL on a
**Data Collection Endpoint (DCE)** — routing is carried by the URL **path** (the
**Data Collection Rule (DCR)** immutable id + the fixed `Microsoft-OTLP-Traces`
entry stream), which lands in the workspace-based App Insights tables,
authenticated by the `azure_auth` extension using a **user-assigned managed
identity**.

```
device-controller ─┐                       ┌─ OTLP receiver ─ otlphttp ─┐
                   ├─ OTLP (traces) ───────►│  (this collector,          │─ azure_auth (user-assigned MI, AAD) ─► DCE ─► DCR ─► App Insights
data-pusher ───────┘   [reachable only      │   loopback-only receiver)  │                                              (OTelSpans / OTelTraces)
                        after MG-34]        └────────────────────────────┘
```

This **replaces** the collector's former `azuremonitor` (Breeze) exporter. That
exporter authenticated with an App Insights **connection string** (local /
instrumentation-key auth), which `azurerm_application_insights.main`'s
**`local_authentication_enabled = false`** (see
[`learnings/decisions/mg-24-appinsights-key-in-terraform-state.md`](../../../learnings/decisions/mg-24-appinsights-key-in-terraform-state.md))
**rejects** — and the community `azuremonitor` exporter has **no Entra auth
path**, so it was non-functional in this stack. The native-OTLP rewrite is
recorded in
[`learnings/decisions/mg-33-native-azure-monitor-otlp-ingestion.md`](../../../learnings/decisions/mg-33-native-azure-monitor-otlp-ingestion.md).

- **Receiver:** OTLP over gRPC (`127.0.0.1:4317`) and HTTP (`127.0.0.1:4318`),
  **loopback only** (fail-closed — see below).
- **Exporter:** `otlphttp` → the full native-OTLP `traces_endpoint` URL on the
  DCE, with the `azure_auth` extension supplying the AAD bearer token for its
  explicitly-configured `https://monitor.azure.com/.default` scope. Requires the
  **Contrib** distribution.
- **Pipeline:** `traces` only (the per-reading W3C trace chain, MG-33 F2/F3).
  Metrics are intentionally not wired — native OTLP needs its own DCR stream +
  transform for metrics, deferred.

Use the pinned Contrib image **`otel/opentelemetry-collector-contrib:0.151.0`**,
pinned by **tag AND `@sha256` digest** (Terraform `var.collector_image`;
re-resolve the digest at deploy). `otlphttp` + `azure_auth` + `file_storage` all
require the Contrib distribution. The version floor is DOC-VERIFIED (3rd review):
**`>=0.132.0`** (native OTLP), **`>=0.148.0`** (current `azure_auth` config
syntax — the extension key was renamed from `azureauth`), and **`>0.150.0`** so
it is **outside** the `GHSA-pjv4-3c63-699f` `azure_auth` inbound-auth-bypass
advisory range (`0.124.0–0.150.0`); outbound auth here is unaffected, but the pin
keeps MG-34's future receiver auth off a vulnerable version. The core
`otel/opentelemetry-collector` image does **not** include these.

## Outbound topology (native OTLP)

Provisioned by the `native-otlp` Terraform module
(`apps/infrastructure/modules/native-otlp`), instantiated only when
`enable_native_otlp` is true:

- **Collector Container App** — runs the pinned Contrib collector with a
  **user-assigned managed identity**. User-assigned (not system-assigned) so the
  DCR role assignment can grant against the identity's principal id **before** the
  app exists, avoiding a create-then-grant ordering gap.
- **`azure_auth` extension** — mints an AAD token for an **explicitly
  configured** `scopes:` audience — `https://monitor.azure.com/.default` (pinned
  from config, **not** derived from the request Host) — from that identity. No
  ingestion key, no connection string in the collector.
- **DCE + DCR (native OTLP)** — the `otlphttp` exporter posts to the full
  native-OTLP `traces_endpoint` URL
  (`https://<logs-dce-ingestion-host>/dataCollectionRules/<dcr-immutable-id>/streams/Microsoft-OTLP-Traces/otlp/v1/traces`);
  routing is by URL path, **not** `x-ms-dcr-immutable-id` / `x-ms-stream-name`
  headers. The DCR is an **`azapi_resource`**
  (`Microsoft.Insights/dataCollectionRules@2024-03-11`) with
  `references.applicationInsights` + a `directDataSources.otelTraces` data source
  over the built-in `Microsoft-OTel-Traces-*` streams, enriched from the App
  Insights reference into the workspace-based OpenTelemetry-schema tables
  (`OTelSpans` / `OTelTraces`) — native-OTLP ingestion lands there, **not** the
  classic `AppDependencies` / `AppTraces`. It targets the **same** Log Analytics
  workspace App Insights is bound to. `azurerm`'s
  `azurerm_monitor_data_collection_rule` (v4) cannot express this body, so the
  `azapi` provider authors the DCR; the DCE stays an `azurerm` resource.
- **DCR-scoped RBAC** — the identity holds **`Monitoring Metrics Publisher`
  scoped to the DCR** (`azurerm_role_assignment.collector_dcr_publisher`, scoped
  to `azapi_resource.otlp_dcr.id`), **not** App Insights and **not** the
  workspace. Ingestion through the DCE/DCR authorizes against the DCR; this is
  deliberately different from the Function App's Breeze path, whose same-named
  role is scoped to App Insights. MG-34 AC3 proves the negative: remove this
  assignment and ingestion is rejected.

Every Azure-specific value (the full `traces_endpoint` URL — built in Terraform
from the DCE ingestion host + the DCR immutable id — the UAI client id, and the
storage name) is **Terraform-emitted and injected at runtime via env-var
substitution** — never hand-copied into `collector-config.yaml`.

## Fail-closed posture

The collector is deliberately unreachable from the edges until MG-34:

- The collector Container App has **no `ingress` block** — no public/external
  OTLP listener.
- The OTLP receiver binds **loopback only** (`127.0.0.1:4317`/`:4318`).

The edge devices run on Raspberry Pis **off Azure's VNet** and cannot reach this
collector **by design**. Secure off-VNet ingress (mTLS / auth-terminating proxy /
private tunnel) is the separate blocking dependency **MG-34**. Do **not** change
the receiver to `0.0.0.0` or add an ingress block without MG-34.

## Durability (F3)

The exporter uses a **persistent `sending_queue`** backed by the
`file_storage/otlp_queue` extension (spool at
`/var/lib/otelcol/file_storage`), plus `retry_on_failure` with backoff
(`max_elapsed_time: 0` — retry indefinitely rather than drop). The spool must be
backed by a **persistent Azure File volume** on the Container App (an ephemeral
overlay defeats the durability intent). The volume + its storage association are
provisioned under MG-24 alongside the environment.

## How the Go services point at it

The edge telemetry packages honor the standard OTLP env var. Point each service
at the collector instead of at App Insights:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector-host>:4318
```

The HTTP exporter used in this repo
(`go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp`) targets the
`:4318` HTTP endpoint. Exporter selection on the edge services is gated **solely
on `OTEL_EXPORTER_OTLP_ENDPOINT`**: a service with an **empty** (or
whitespace-only) `OTEL_EXPORTER_OTLP_ENDPOINT` selects a no-op exporter and runs
fully offline (e.g. a Raspberry Pi with no backend reachable), while a set
endpoint selects the real OTLP exporter that reaches this collector. The edge
services never read `APPLICATIONINSIGHTS_CONNECTION_STRING` at all.

> Note: under the native-OTLP path the App Insights **connection string is no
> longer used by the collector** — the `otlphttp` + `azure_auth` path
> authenticates via managed identity, not a connection string. The edge services
> need only `OTEL_EXPORTER_OTLP_ENDPOINT`; neither tier carries the App Insights
> connection string on this path.

## Container Apps environment (MG-24)

The recommended topology is a **single central collector** running as an Azure
Container App. The managed environment that hosts it — and the Azure File storage
association backing the persistent spool — is **created by the MG-24 bootstrap**,
not here. The `native-otlp` module **references** the environment by id via
`container_app_environment_id` (and the storage by `collector_storage_name`);
both are empty until MG-24 lands and are **required (non-empty)** before
`enable_native_otlp` can be flipped on.

The module is **count-guarded off** by `enable_native_otlp` (default false), so
with the flag off it creates **zero** net-new resources and
`terraform validate`/`plan` are unchanged.

## Gate chain

This directory is **authored + static-validated now**. Before the collector is
operational (and before MG-33 can close):

1. **MG-24** — the Container Apps managed environment + storage association exist
   (`container_app_environment_id` / `otlp_collector_storage_name` populated).
2. **MG-25** — native-OTLP preview acceptance in the target region; the DCR body
   (`directDataSources.otelTraces` over the built-in `Microsoft-OTel-Traces-*`
   streams) is confirmed against live ingestion.
3. **MG-34** — secure off-VNet edge ingress, the **live**
   Go-span-to-App-Insights proof (a real edge span appears queryable by
   `TraceId` in the OpenTelemetry-schema tables `OTelSpans`/`OTelTraces` —
   where native-OTLP ingestion lands, **not** the classic
   `AppDependencies`/`AppTraces` — carrying the expected per-reading W3C
   traceparent, and surfaces in the corresponding Application Insights
   experience), and the **negative RBAC check** (remove the DCR role assignment
   → ingestion rejected).

Only after all three is `enable_native_otlp` flipped on and the path considered
operational. Nothing here is proven to deliver telemetry today.

## Files

- `collector-config.yaml` — the collector configuration (OTLP in →
  `otlphttp` + `azure_auth` out). Mount it at the container's config path and run
  the Contrib collector against it.
- `README.md` — this document.

## Local validation

The config is plain YAML; validate shape with any YAML parser, e.g.:

```
python3 -c "import yaml,sys; yaml.safe_load(open('collector-config.yaml')); print('ok')"
```

A full config check requires the Contrib collector binary (also run in CI):

```
otelcol-contrib validate --config collector-config.yaml
```

A green validate confirms the config **parses**, not that telemetry flows — see
the status note at the top.
