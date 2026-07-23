# Production Environment Configuration

environment = "prod"

# Azure region (MG-24 Flex hosting revision, 2026-07-23).
# West US 2 replaces North Central US because Azure Functions Flex Consumption is
# a region-gated offering and North Central US is NOT a supported Flex region.
#
# ⚠️  WHOLE-STACK RELOCATION WARNING (architect high-risk finding) ⚠️
# `location` is NOT Function-App-scoped. It flows var.location -> local.location ->
# azurerm_resource_group.main.location and every module reads the RG location, so
# changing it relocates the ENTIRE stack: Cosmos DB, IoT Hub, SignalR, App Insights,
# Log Analytics, and all storage accounts move regions too. Azure cannot move these
# in place, so the operator's live re-apply will DESTROY AND RECREATE all of them —
# including COSMOS DATA LOSS (temperature history) unless a Cosmos migration/restore
# is performed first. This deterministic plan only writes the code; the region cutover
# is an operator-gated re-apply that MUST carry a Cosmos-migration decision. See the
# ADR (learnings/decisions/mg-24-flex-consumption-hosting-model.md) and the runbook.
#
# NO DESTROY GUARD EXISTS (do NOT assume prod is protected): a region change is
# ForceNew on the Cosmos account (and on IoT Hub), and there is deliberately NO
# prevent_destroy / destroy guard in the shared modules. Terraform's prevent_destroy
# is a static literal that cannot be env-gated (dev vs prod), and MG-24 is greenfield,
# so no guard was added. This means the `location` cutover will NOT hard-fail to
# protect prod data — at the operator's live re-apply it will DESTROY AND RECREATE the
# Cosmos account with TEMPERATURE-HISTORY DATA LOSS unless a migration/restore is done
# first. The operator is the only control here; nothing in this code stops it. Real
# prod data-loss protection (a durable preventdestroy/backup posture) is tracked
# separately in MG-35 — see backlog/stories/MG-35-*.
location = "West US 2"

# Production-grade retention settings
appinsights_retention_days = 365
log_retention_days         = 90

# IoT Hub - Standard tier for production
iot_hub_sku_name     = "S1" # Standard tier - 400,000 messages/day
iot_hub_sku_capacity = 2    # 2 units for redundancy

# CosmosDB - V2-owned account (created by the cosmos-db module)
cosmos_database_throughput     = 400  # Cost-optimized base throughput
cosmos_database_max_throughput = 4000 # Auto-scale for production spikes when needed
temperature_data_ttl_days      = 90   # Full 90-day retention for production

# Azure Functions — Flex Consumption (MG-24 hosting revision, 2026-07-23).
# Replaces the inherited EP1 Premium plan. EP1 is NOT retained (MG-24 point 6: no
# documented requirement for the always-on Premium floor). A single Flex model now
# serves BOTH environments; prod differs only by keeping always-ready instances warm.
#
# Flex knobs (mapped to azurerm_function_app_flex_consumption on azurerm v4.81.0):
#   instance_memory_in_mb  — per-instance memory tier (2048 MB GA baseline).
#   maximum_instance_count — hard ceiling on horizontal scale-out.
#   always_ready           — pre-warmed instances kept running to eliminate cold
#                            starts on production traffic.
#
# COST (point 9): prod keeps always_ready = 1 pre-warmed instance. Its baseline is
# one instance × 2048 MB billed continuously as always-ready GB-s — materially BELOW
# the EP1 Premium floor (EP1 bills a full dedicated vCPU + 3.5 GB always-on plan),
# while still eliminating cold starts. Scale-out above the warm instance bills
# per-execution GB-s only. Raise always_ready if steady concurrency demands it.
instance_memory_in_mb  = 2048
maximum_instance_count = 100 # Flex default ceiling — room for production burst
always_ready           = 1   # one pre-warmed instance: no cold starts on prod traffic

# SignalR - Standard tier for production
signalr_sku_name     = "Standard_S1" # Standard tier - 1,000 concurrent connections
signalr_sku_capacity = 2             # 2 units for redundancy

# Device settings for production
device_count       = 100
max_daily_messages = 1000000

# Security - Restricted IP ranges (should be customized)
allowed_ip_ranges = [
  "10.0.0.0/8",    # Private networks
  "172.16.0.0/12", # Private networks
  "192.168.0.0/16" # Private networks
]

# HTTP posture (S2) — explicit, env-specific CORS origins (no wildcard).
# Prod allows only the production web front-end origins.
functions_cors_allowed_origins = ["https://meatgeek.com", "https://www.meatgeek.com"]
signalr_cors_allowed_origins   = ["https://meatgeek.com", "https://www.meatgeek.com"]

# Backup and disaster recovery
enable_backup         = true
backup_retention_days = 30
auto_shutdown_enabled = false # Never auto-shutdown production
budget_limit          = 200   # Reduced budget with cost-optimized throughput
