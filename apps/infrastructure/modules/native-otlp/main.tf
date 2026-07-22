# native-otlp module — OUTBOUND native Azure Monitor OTLP telemetry path.
#
# STATUS (MG-33 F1/F3): AUTHORED + STATIC-VALIDATED ONLY, DEFAULT-OFF. Nothing
# here is proven operational. APPLY is gated on:
#   - MG-24  — the Container Apps managed environment does not exist yet; this
#              module references it via var.container_app_environment_id.
#   - MG-25  — native-OTLP preview acceptance in the target region.
#   - MG-34  — secure off-VNet edge ingress + live span-to-App-Insights proof.
# The root `enable_native_otlp` flag (default false) count-guards the module
# block in ../../main.tf, so with the flag OFF this file creates ZERO resources
# and `terraform validate` passes. Production activation is a deliberate flag
# flip (MG-25), NOT a side effect of a normal apply.
#
# Data flow (when activated):
#   edge OTLP -> collector Container App (otlphttp + azureauth) -> DCE logs-
#   ingestion endpoint -> DCR (stream + transform) -> Log Analytics workspace
#   -> App Insights tables (AppTraces / AppDependencies).
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
# The logs-ingestion endpoint the collector's otlphttp exporter targets.
#
# !!! UNVERIFIED PREVIEW SEMANTICS (MG-25 activation, tracked by MG-34) !!!
# The exporter below targets `.logs_ingestion_endpoint` (the DCR Logs Ingestion
# API URI). Whether Azure Monitor NATIVE OTLP INGESTION (PREVIEW) actually
# accepts OTLP at that SAME endpoint — vs. a DEDICATED OTLP ingestion URI or a
# DIFFERENT DCE attribute (and at what api-version) — is NOT confirmed here.
# MUST be verified against the current Azure Monitor native-OTLP-ingestion
# preview docs BEFORE the enable_native_otlp flag is flipped on. Do NOT treat
# this attribute choice as proven.
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

# --- Data Collection Rule (DCR) ----------------------------------------------
# Declares the incoming OTLP trace stream and transforms it into the
# workspace-based App Insights tables. The transform_kql + output_stream binding
# to the App tables is finalized under the MG-25 native-OTLP preview; the shape
# here is the authored baseline (schema-valid, not yet operationally proven).
resource "azurerm_monitor_data_collection_rule" "otlp" {
  name                        = "${var.resource_prefix}-otlp-dcr"
  resource_group_name         = var.resource_group_name
  location                    = var.location
  data_collection_endpoint_id = azurerm_monitor_data_collection_endpoint.otlp.id

  destinations {
    log_analytics {
      workspace_resource_id = var.log_analytics_workspace_id
      name                  = "appinsights-workspace"
    }
  }

  # Incoming OTLP span stream. Columns are the representative OTLP span fields the
  # transform reads; the authoritative column set is pinned under MG-25.
  stream_declaration {
    stream_name = var.otlp_stream_name
    column {
      name = "TimeGenerated"
      type = "datetime"
    }
    column {
      name = "TraceId"
      type = "string"
    }
    column {
      name = "SpanId"
      type = "string"
    }
    column {
      name = "ParentId"
      type = "string"
    }
    column {
      name = "Name"
      type = "string"
    }
    column {
      name = "Kind"
      type = "string"
    }
    column {
      name = "StartTime"
      type = "datetime"
    }
    column {
      name = "EndTime"
      type = "datetime"
    }
    column {
      name = "Attributes"
      type = "dynamic"
    }
    column {
      name = "Resource"
      type = "dynamic"
    }
  }

  data_flow {
    streams      = [var.otlp_stream_name]
    destinations = ["appinsights-workspace"]
    # Project the OTLP span stream onto the App Insights dependency table shape.
    # Finalized under MG-25; kept minimal + identity-preserving here.
    transform_kql = "source | extend TimeGenerated = TimeGenerated"
    # Built-in App Insights table the transformed rows land in (per-reading W3C
    # trace chain becomes queryable as AppDependencies; MG-33 F2/F3).
    output_stream = "Microsoft-AppDependencies"
  }

  tags = var.tags

  # The DCE must exist before the DCR references it.
  depends_on = [azurerm_monitor_data_collection_endpoint.otlp]
}

# --- RBAC: Monitoring Metrics Publisher SCOPED TO THE DCR --------------------
# CRITICAL (non-obvious): the scope is the DCR resource id — NOT App Insights,
# NOT the Log Analytics workspace. Ingestion through the DCE/DCR authorizes
# against the DCR. (Contrast the Function App's Breeze path at ../../main.tf,
# whose Monitoring Metrics Publisher is scoped to App Insights — do NOT copy that
# scope here; it would not authorize DCR ingestion.) MG-34 AC3 proves the
# negative: remove THIS assignment and ingestion is rejected.
resource "azurerm_role_assignment" "collector_dcr_publisher" {
  scope                = azurerm_monitor_data_collection_rule.otlp.id
  role_definition_name = "Monitoring Metrics Publisher"
  principal_id         = azurerm_user_assigned_identity.collector.principal_id
}

# --- Collector Container App -------------------------------------------------
# Pinned contrib collector, wired to the DCE endpoint + DCR immutable id + UAI
# client id via env (matching collector-config.yaml's env-var substitution). The
# managed environment is created by MG-24; this references it by id.
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
  # debug out — NO otlphttp/azureauth), so the authored native-OTLP config was
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
      # UNVERIFIED PREVIEW SEMANTICS (see the DCE resource above / MG-34): whether
      # `.logs_ingestion_endpoint` is the correct native-OTLP target must be
      # confirmed against the Azure native-OTLP-ingestion preview docs at MG-25.
      env {
        name  = "AZURE_MONITOR_OTLP_ENDPOINT"
        value = azurerm_monitor_data_collection_endpoint.otlp.logs_ingestion_endpoint
      }
      env {
        name  = "AZURE_MONITOR_DCR_IMMUTABLE_ID"
        value = azurerm_monitor_data_collection_rule.otlp.immutable_id
      }
      env {
        name  = "AZURE_MONITOR_STREAM_NAME"
        value = var.otlp_stream_name
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
