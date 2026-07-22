# MeatGeek OTel Collector

The **required translation hop** between the Go edge services and Azure
Application Insights.

## Purpose (MG-33 / F2)

The Go edge services — `apps/device-controller` and `apps/data-pusher` — emit
OpenTelemetry over **OTLP**. Application Insights does **not** accept raw OTLP:
its ingestion endpoint speaks the App Insights protocol (Breeze) with its own
auth. Exporting OTLP straight at the App Insights ingestion endpoint (an earlier
assumption corrected by F2) therefore does not deliver telemetry.

This collector closes that gap:

```
device-controller ─┐                         ┌── OTLP receiver
                   ├─ OTLP (traces/metrics) ─►│  (this collector)  ── azuremonitor exporter ──► Application Insights
data-pusher ───────┘                         └──
```

- **Receiver:** OTLP over gRPC (`:4317`) and HTTP (`:4318`).
- **Exporter:** `azuremonitor`, the OpenTelemetry-Collector-**Contrib** exporter
  that translates OTLP into the Application Insights ingestion protocol and
  handles auth. It is the supported path; the Azure Monitor Go exporter is not
  yet GA (see `apps/device-controller/internal/telemetry/setup.go`).
- **Pipelines:** `traces` (primary — carries the per-reading W3C trace chain,
  MG-33 / F3) and `metrics`.

Use a distribution that includes the contrib exporters, e.g.
`otel/opentelemetry-collector-contrib`. The core `otel/opentelemetry-collector`
image does **not** include `azuremonitor`.

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

> Note: the two gates are on **different** env vars and belong to **different**
> tiers. The **edge services** gate OTLP export on `OTEL_EXPORTER_OTLP_ENDPOINT`
> (empty → no-op, offline). The **collector** gates its App Insights export on
> `APPLICATIONINSIGHTS_CONNECTION_STRING` — that variable belongs to the
> collector only. With a central collector the edge services need just
> `OTEL_EXPORTER_OTLP_ENDPOINT` and never the App Insights connection string.

## Recommended deployment: central collector (BLOCKED-on-MG-24)

The recommended topology is a **single central collector** running as an **Azure
Container App** in the environment created by MG-24. The edge services reach it
over the network via `OTEL_EXPORTER_OTLP_ENDPOINT`; there is no per-edge
collector to operate or patch.

**Live deployment is BLOCKED-on-MG-24.** The Container Apps environment does not
exist until the greenfield bootstrap runs. The operator stands this collector up
**during or after** that bootstrap. This directory is intentionally the **config
+ doc artifact only** — no Terraform here creates the collector, because that
infrastructure is MG-24-gated. Wiring the live Container App belongs to the
MG-24 follow-up, not here.

### What the collector needs at deploy time

- **`APPLICATIONINSIGHTS_CONNECTION_STRING`** — the App Insights connection
  string, supplied as a Container App secret / env var (never committed). This
  is what the `azuremonitor` exporter reads.
- **Managed identity (for AAD-based ingestion)** — assign the Container App a
  managed identity with the appropriate role on the Application Insights /
  Log Analytics resource so ingestion authenticates via AAD rather than the
  connection-string instrumentation key alone.
- **Ingress** — expose the OTLP ports (`4317`/`4318`) on the network the edge
  services can reach; restrict to the edge origins as appropriate.

## Files

- `collector-config.yaml` — the collector configuration (OTLP in, App Insights
  out). Mount it at the container's config path and run the contrib collector
  against it.
- `README.md` — this document.

## Local validation

The config is plain YAML; validate shape with any YAML parser, e.g.:

```
python3 -c "import yaml,sys; yaml.safe_load(open('collector-config.yaml')); print('ok')"
```

A full config check requires a collector binary:

```
otelcol-contrib validate --config collector-config.yaml
```
