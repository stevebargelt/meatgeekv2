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

# The resource group RESOURCE ID (not just the name) — required as the azapi
# DCR's parent_id (azapi addresses parents by full resource id, unlike azurerm
# which takes resource_group_name). Passed from the root as azurerm_resource_group.main.id.
variable "resource_group_id" {
  description = "Resource id of the resource group (parent_id for the azapi native-OTLP DCR)."
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

# App Insights resource id — the DCR's references.applicationInsights entry. The
# native-OTLP DCR enriches spans from (and resolves the destination resource via)
# this reference. Passed from the root as azurerm_application_insights.main.id.
variable "application_insights_id" {
  description = "Resource id of the workspace-based Application Insights component the native-OTLP DCR references for trace enrichment (references.applicationInsights)."
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

# PINNED collector image — DOC-VERIFIED version floor (3rd review):
#   >= 0.132.0  native-OTLP prerequisite feature level
#   >= 0.148.0  the current `azure_auth` extension config syntax (key renamed
#               from `azureauth`; explicit `scopes:` supported)
#   >  0.150.0  OUTSIDE the GHSA-pjv4-3c63-699f azure_auth inbound-auth-bypass
#               advisory range (0.124.0–0.150.0). Outbound (exporter) auth used
#               here is UNAFFECTED, but pinning past the range means MG-34's
#               FUTURE collector RECEIVER (inbound) auth cannot land on a version
#               where azure_auth accepts unauthenticated inbound requests.
# 0.151.0 satisfies all three. Pinned by tag AND @sha256 digest for reproducibility.
#
# DIGEST: sha256:d57bfe8eee2378f31cb1193239fbcac521d54a5a071fca2bfc106916a32b892d
# was resolved from Docker Hub for the 0.151.0 multi-arch index at authoring time.
# !!! AT DEPLOY: RE-RESOLVE AND RE-CONFIRM THIS DIGEST, and re-confirm the tag is
# STRICTLY > 0.150.0 with GHSA-pjv4-3c63-699f's `patched` field verified for the
# chosen release before flipping enable_native_otlp on. Do NOT trust a stale
# digest across a rebuild of the same tag.
variable "collector_image" {
  description = "PINNED collector container image. MUST be the CONTRIB distribution (otlphttp + azure_auth + file_storage). Pinned by tag AND @sha256 digest. Floor >=0.132.0 (native OTLP), >=0.148.0 (azure_auth syntax), >0.150.0 (outside GHSA-pjv4-3c63-699f). Re-confirm the digest + advisory `patched` field at deploy (MG-25/MG-34)."
  type        = string
  default     = "otel/opentelemetry-collector-contrib:0.151.0@sha256:d57bfe8eee2378f31cb1193239fbcac521d54a5a071fca2bfc106916a32b892d"
}

variable "collector_storage_name" {
  description = "Name of the Container Apps environment storage (Azure File share) association that backs the collector's persistent file_storage spool (/var/lib/otelcol/file_storage). Provisioned under MG-24 alongside the environment; empty until then. The module is count-guarded OFF so validate passes with it empty."
  type        = string
  default     = ""
}

# NOTE (3rd review): the former `otlp_stream_name` variable is REMOVED. Native
# OTLP ingestion pins the stream inside the traces_endpoint URL segment (fixed
# `Microsoft-OTLP-Traces`) and the DCR declares the built-in Microsoft-OTel-
# Traces-* streams directly — there is no operator-tunable custom stream name and
# no x-ms-stream-name header any more.

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
