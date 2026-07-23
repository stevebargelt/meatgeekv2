# native-otlp module — OUTBOUND native Azure Monitor OTLP telemetry path.
#
# STATUS (MG-33 F1/F3, 3rd operational review + doc-verification pass):
# AUTHORED + STATIC-VALIDATED ONLY, DEFAULT-OFF. The config shapes here are now
# DOC-VERIFIED against Microsoft PRIMARY sources (see citations below), but are
# STILL NOT proven OPERATIONAL — no live span has reached App Insights. APPLY is
# gated on:
#   - MG-24  — the Container Apps managed environment does not exist yet; this
#              module references it via var.container_app_environment_id.
#   - MG-25  — native-OTLP preview acceptance in the target region.
#   - MG-34  — secure off-VNet edge ingress + live span-to-App-Insights proof.
# The root `enable_native_otlp` flag (default false) count-guards the module
# block in ../../main.tf, so with the flag OFF this file creates ZERO resources
# and `terraform validate` passes. Production activation is a deliberate flag
# flip (MG-25), NOT a side effect of a normal apply.
#
# DOC-VERIFIED (primary Microsoft sources reconciled in the 3rd review):
#   - MS Learn "Send OpenTelemetry data to Azure Monitor" / native OTLP ingestion
#     (preview): the DCR uses the built-in `Microsoft-OTel-Traces-*` streams and a
#     directDataSources.otelTraces data source enriched from an App Insights
#     reference — NOT a hand-rolled custom stream + KQL transform.
#   - AzureMonitorCommunity OTLP_DCE_DCR ARM template: the exact DCR body shape
#     (references.applicationInsights / directDataSources.otelTraces /
#     destinations.logAnalytics / dataFlows) reproduced in the azapi_resource
#     below.
#   - azureauthextension README: the extension key is `azure_auth` (current), the
#     ingestion scope MUST be set EXPLICITLY (`scopes:`) — it is NOT derived from
#     the request Host; audience is pinned from config.
#   - Advisory GHSA-pjv4-3c63-699f: azure_auth inbound (receiver) auth bypass in
#     0.124.0–0.150.0. Outbound (exporter) auth is unaffected, but the image pin
#     is set > 0.150.0 so MG-34's future collector RECEIVER auth is outside the
#     advisory range. See var.collector_image.
#
# Data flow (when activated):
#   edge OTLP -> collector Container App (otlphttp + azure_auth) -> DCE logs-
#   ingestion host / <dcr-immutable-id> / Microsoft-OTLP-Traces / otlp/v1/traces
#   -> native-OTLP DCR (Microsoft-OTel-Traces-* streams) -> Log Analytics
#   workspace -> App Insights trace tables.
#
# FAIL-CLOSED: the collector Container App has NO ingress block => no public
# OTLP listener. Edges cannot reach it yet, BY DESIGN (MG-34 adds secure
# ingress). Do NOT add an external `ingress` block here without MG-34.

# --- USER-ASSIGNED managed identity for the collector ------------------------
# User-assigned (NOT system-assigned): the DCR role assignment below needs the
# identity's principal id BEFORE the Container App exists. A system-assigned
# identity only exists after the app is created, reintroducing the create-then-
# grant ordering gap the rest of this stack deliberately avoids.
resource "azurerm_user_assigned_identity" "collector" {
  name                = "${var.resource_prefix}-otel-collector-uai"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

# --- Data Collection Endpoint (DCE) ------------------------------------------
# The logs-ingestion host the collector's otlphttp exporter targets. KEPT as an
# azurerm resource (not converted to azapi): the DCE is a stable, well-supported
# azurerm resource and was NOT the broken part — only the DCR needed the native-
# OTLP body shape that azurerm's azurerm_monitor_data_collection_rule cannot
# express (directDataSources.otelTraces). Minimizing the azapi surface keeps the
# diff readable. `.logs_ingestion_endpoint` supplies the ingestion host used to
# build the full native-OTLP traces_endpoint URL (see locals below).
resource "azurerm_monitor_data_collection_endpoint" "otlp" {
  name                = "${var.resource_prefix}-otlp-dce"
  resource_group_name = var.resource_group_name
  location            = var.location
  # No public network access toggle is exposed here beyond provider defaults;
  # the DCE is an Azure-side ingestion endpoint (outbound target), not an
  # edge-facing listener — the fail-closed edge boundary is enforced at the
  # collector receiver (loopback-only) + the MG-34 ingress design, not here.
  tags = var.tags
}

# --- Data Collection Rule (DCR) — NATIVE OTLP (azapi) ------------------------
# DOC-VERIFIED corrective (3rd review): the previous azurerm_monitor_data_
# collection_rule declared a hand-rolled custom stream + identity KQL transform
# into Microsoft-AppDependencies. That is NOT a native-OTLP DCR and would not
# ingest OTLP spans. The correct shape — per the AzureMonitorCommunity
# OTLP_DCE_DCR ARM template and MS Learn native-OTLP docs — is a DCR that
# references the App Insights resource and declares a directDataSources.otelTraces
# data source over the BUILT-IN Microsoft-OTel-Traces-* streams. azurerm cannot
# express this body, so it is authored via azapi against apiVersion 2024-03-11
# (the api-version the MS template targets).
#
# STILL OPERATIONALLY UNVERIFIED (MG-25/MG-34): the body matches the MS primary
# sources at authoring time, but no live span has been ingested. Do NOT treat a
# green plan/validate as proof the path works end-to-end.
resource "azapi_resource" "otlp_dcr" {
  type      = "Microsoft.Insights/dataCollectionRules@2024-03-11"
  name      = "${var.resource_prefix}-otlp-dcr"
  location  = var.location
  parent_id = var.resource_group_id
  tags      = var.tags

  body = {
    properties = {
      # Bind the DCR to the DCE so ingestion routes through the endpoint above.
      dataCollectionEndpointId = azurerm_monitor_data_collection_endpoint.otlp.id

      # App Insights reference used to enrich + resolve the destination resource
      # for OTLP traces (per the MS ARM template). Named `applicationInsightsResource`
      # and consumed by the otelTraces data source's enrichWithReference below.
      references = {
        applicationInsights = [
          {
            resourceId = var.application_insights_id
            name       = "applicationInsightsResource"
          }
        ]
      }

      # Native-OTLP direct data source over the BUILT-IN OTel trace streams.
      # enrichWithReference/replaceResourceIdWithReference tie spans to the App
      # Insights resource above. Verbatim shape from the MS OTLP_DCE_DCR template.
      directDataSources = {
        otelTraces = [
          {
            streams                        = ["Microsoft-OTel-Traces-Spans", "Microsoft-OTel-Traces-Events", "Microsoft-OTel-Traces-Resources"]
            enrichWithResourceAttributes   = ["*"]
            enrichWithReference            = "applicationInsightsResource"
            replaceResourceIdWithReference = true
            name                           = "otelTracesDataSourceDirect"
          }
        ]
      }

      destinations = {
        logAnalytics = [
          {
            workspaceResourceId = var.log_analytics_workspace_id
            name                = "myLAW"
          }
        ]
      }

      # TRACES-ONLY: this DCR declares only the otelTraces data source above (no
      # otelLogs), so the flow carries the trace streams ONLY. Microsoft's full
      # ARM template also lists Microsoft-OTel-Logs, but that stream is valid
      # there solely because that template also declares an otelLogs data source.
      # Including it here without a backing data source risks Azure-side DCR
      # validation failure at apply, so it is intentionally omitted.
      dataFlows = [
        {
          streams      = ["Microsoft-OTel-Traces-Spans", "Microsoft-OTel-Traces-Events", "Microsoft-OTel-Traces-Resources"]
          destinations = ["myLAW"]
        }
      ]
    }
  }

  # Export the server-computed immutable id so we can build the traces_endpoint
  # URL and expose it as a module output. (azapi surfaces response fields only
  # when explicitly exported.)
  response_export_values = ["properties.immutableId"]

  # The DCE must exist before the DCR binds to it.
  depends_on = [azurerm_monitor_data_collection_endpoint.otlp]
}

# --- Native-OTLP ingestion coordinates ---------------------------------------
# The full native-OTLP traces ingestion URL is built HERE (not hand-copied and
# not passed as separate headers). Per the MS native-OTLP ingestion doc the shape
# is fixed:
#   https://<logs-dce-ingestion-host>/dataCollectionRules/<dcr-immutable-id>/streams/Microsoft-OTLP-Traces/otlp/v1/traces
# The stream segment is the FIXED logical OTLP entry stream `Microsoft-OTLP-Traces`
# (distinct from the DCR's internal Microsoft-OTel-Traces-* streams above). The
# DCE `.logs_ingestion_endpoint` is already `https://<host>` (no trailing slash).
locals {
  dcr_immutable_id = azapi_resource.otlp_dcr.output.properties.immutableId
  otlp_traces_endpoint = format(
    "%s/dataCollectionRules/%s/streams/Microsoft-OTLP-Traces/otlp/v1/traces",
    azurerm_monitor_data_collection_endpoint.otlp.logs_ingestion_endpoint,
    local.dcr_immutable_id,
  )
}

# --- RBAC: Monitoring Metrics Publisher SCOPED TO THE DCR --------------------
# CRITICAL (non-obvious): the scope is the DCR resource id — NOT App Insights,
# NOT the Log Analytics workspace. Ingestion through the DCE/DCR authorizes
# against the DCR. (Contrast the Function App's Breeze path at ../../main.tf,
# whose Monitoring Metrics Publisher is scoped to App Insights — do NOT copy that
# scope here; it would not authorize DCR ingestion.) The scope is now the AZAPI
# DCR's id. MG-34 AC3 proves the negative: remove THIS assignment and ingestion
# is rejected.
resource "azurerm_role_assignment" "collector_dcr_publisher" {
  scope                = azapi_resource.otlp_dcr.id
  role_definition_name = "Monitoring Metrics Publisher"
  principal_id         = azurerm_user_assigned_identity.collector.principal_id
}

# --- Collector Container App -------------------------------------------------
# Pinned contrib collector, wired to the single native-OTLP traces_endpoint URL +
# UAI client id via env (matching collector-config.yaml's env-var substitution).
# The managed environment is created by MG-24; this references it by id.
#
# FAIL-CLOSED: NO `ingress` block => no external/public listener. The collector
# receiver binds loopback-only (collector-config.yaml). Edges reach it only once
# MG-34's secure ingress lands. Do NOT add ingress here without MG-34.
resource "azurerm_container_app" "collector" {
  name                         = "${var.resource_prefix}-otel-collector"
  container_app_environment_id = var.container_app_environment_id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.collector.id]
  }

  # Deliver the repo's collector-config.yaml to the container as a Secret-backed
  # volume file. FIX (MG-33 F1 review): without this, only the spool volume was
  # mounted and otelcol-contrib fell back to its DEFAULT config (plain OTLP in /
  # debug out — NO otlphttp/azure_auth), so the authored native-OTLP config was
  # never actually delivered. The YAML holds NO secrets (every Azure value is
  # ${env:...}-substituted at runtime), but a Secret volume is the azurerm_
  # container_app-native mechanism to materialize an arbitrary file at a fixed
  # path. SINGLE SOURCE OF TRUTH: content is read from the repo file via file() —
  # never a divergent copy. Secret names disallow dots, so the file lands as
  # `collector-config` (no extension) and the container args point --config at it
  # (otelcol's file provider ignores the extension).
  secret {
    name  = "collector-config"
    value = file("${path.module}/../../otel-collector/collector-config.yaml")
  }

  template {
    # Persistent spool volume backing the collector's file_storage sending_queue
    # (/var/lib/otelcol/file_storage). Azure File share associated to the managed
    # environment under MG-24; storage_name empty until then (module is off).
    volume {
      name         = "otel-file-storage"
      storage_type = "AzureFile"
      storage_name = var.collector_storage_name
    }

    # Secret-backed volume that materializes the collector-config secret as a file
    # (filename == secret name == `collector-config`) under the mount path.
    volume {
      name         = "otel-config"
      storage_type = "Secret"
    }

    container {
      name   = "otel-collector"
      image  = var.collector_image
      cpu    = 0.5
      memory = "1Gi"

      # Point otelcol-contrib at the delivered config file (overrides the image's
      # default CMD of `--config /etc/otelcol-contrib/config.yaml`). The Secret
      # volume mounts `collector-config` (no extension) into this dir.
      args = ["--config", "/etc/otelcol/config/collector-config"]

      # Mount the persistent spool at the path collector-config.yaml expects.
      volume_mounts {
        name = "otel-file-storage"
        path = "/var/lib/otelcol/file_storage"
      }

      # Mount the delivered collector config (Secret volume) at the --config dir.
      volume_mounts {
        name = "otel-config"
        path = "/etc/otelcol/config"
      }

      # Every Azure-specific value is Terraform-emitted (never hand-copied),
      # matching the ${env:...} substitutions in collector-config.yaml.
      env {
        name  = "AZURE_OTLP_UAI_CLIENT_ID"
        value = azurerm_user_assigned_identity.collector.client_id
      }
      # SINGLE native-OTLP ingestion URL (DOC-VERIFIED shape). Built in Terraform
      # from the DCE ingestion host + the DCR immutable id (see locals). Replaces
      # the former bare-endpoint + x-ms-dcr-immutable-id/x-ms-stream-name headers:
      # the stream (Microsoft-OTLP-Traces) is fixed INSIDE this URL, so no header
      # routing and no separate stream env are needed.
      env {
        name  = "AZURE_MONITOR_OTLP_TRACES_ENDPOINT"
        value = local.otlp_traces_endpoint
      }
    }
  }

  tags = var.tags

  # FLAG-PREREQUISITE ENFORCEMENT (MG-33 F1 review fix). This module is only
  # instantiated when enable_native_otlp is true, so these preconditions ONLY
  # evaluate on activation — with the flag OFF the module is not instantiated,
  # zero resources plan, and `terraform validate` passes untouched. On plan/apply
  # with the flag ON, an empty required input FAILS LOUD here rather than silently
  # producing a broken Container App (no environment / no spool storage).
  lifecycle {
    precondition {
      condition     = trimspace(var.container_app_environment_id) != ""
      error_message = "enable_native_otlp is true but container_app_environment_id is empty. The Container Apps managed environment (MG-24) must exist and its id be supplied before the flag can activate."
    }
    precondition {
      condition     = trimspace(var.collector_storage_name) != ""
      error_message = "enable_native_otlp is true but collector_storage_name is empty. The Azure File storage association backing the collector's persistent spool (MG-24) must exist and its name be supplied before the flag can activate."
    }
  }

  # The identity + DCR must exist (and the role be granted) before the app runs.
  depends_on = [
    azurerm_role_assignment.collector_dcr_publisher,
    azurerm_user_assigned_identity.collector,
  ]
}
