# native-otlp module variables.
#
# This module authors the OUTBOUND native-OTLP telemetry path (collector Container
# App -> DCE/DCR -> workspace-based App Insights). It is instantiated ONLY when
# the root `enable_native_otlp` flag is true (the module block in ../../main.tf
# is count-guarded), so with the flag OFF this module creates ZERO resources and
# `terraform validate` passes without any of these inputs being meaningfully set.

variable "resource_prefix" {
  description = "Prefix for resource names (e.g. meatgeek-v2-dev)"
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group the collector resources live in"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "log_analytics_workspace_id" {
  description = "Resource id of the Log Analytics workspace backing the workspace-based App Insights. The DCR routes OTLP traces into this workspace's App-Insights tables (AppTraces / AppDependencies)."
  type        = string
}

variable "container_app_environment_id" {
  description = "Resource id of the Container Apps managed environment (created by MG-24 bootstrap). Empty until MG-24 lands; the module is count-guarded OFF so validate passes with it empty. REQUIRED (non-empty) before enable_native_otlp can be flipped on (MG-25 activation)."
  type        = string
  default     = ""
}

variable "collector_image" {
  description = "PINNED collector container image. MUST be the CONTRIB distribution (otlphttp + azureauth + file_storage). Pin by tag AND digest for reproducibility."
  type        = string
  default     = "otel/opentelemetry-collector-contrib:0.128.0"
}

variable "collector_storage_name" {
  description = "Name of the Container Apps environment storage (Azure File share) association that backs the collector's persistent file_storage spool (/var/lib/otelcol/file_storage). Provisioned under MG-24 alongside the environment; empty until then. The module is count-guarded OFF so validate passes with it empty."
  type        = string
  default     = ""
}

variable "otlp_stream_name" {
  description = "DCR stream name the collector's otlphttp exporter targets (x-ms-stream-name). Must match the stream_declaration below and the collector-config env value."
  type        = string
  default     = "Custom-OtelTraces"
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
