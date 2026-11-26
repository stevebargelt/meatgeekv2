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
# prod data-loss protection (a durable preventdestroy/backup posture) was tracked
# separately, as MG-35 in a retired tracker.
location = "West US 2"

# Production-grade retention settings
appinsights_retention_days = 365
log_retention_days         = 90

# IoT Hub - Standard tier for production, sized by daily message quota (HAR-62).
# IoT Hub is single-region and its SLA does not depend on unit count, so extra units
# add message capacity only. The unit count follows from the load:
#   Load:      device_count = 100. Each device sends one reading every 5 s
#              (POLL_INTERVAL default 5*time.Second in apps/data-pusher/cmd/main.go):
#              86,400 s / 5 s = 17,280 device-to-cloud messages per device per day,
#              x 100 devices = 1,728,000 messages a day for the fleet.
#   Size:      one reading is well under the 4 KB metering block, so it counts as
#              one message.
#   Twin:      twin reads and updates are a few per cook per device and do not
#              change the result.
#   Capacity:  one S1 unit allows 400,000 messages a day, so
#              ceil(1,728,000 / 400,000) = ceil(4.32) = 5 units = 2,000,000 a day,
#              about 86% of quota used.
#   Over quota: IoT Hub rejects device-to-cloud messages until the daily reset.
#              data-pusher keeps them in its durable on-disk queue and retries.
#   Next step: S2 provides 6,000,000 messages a day per unit and is the next step if
#              the fleet or the poll rate grows.
iot_hub_sku_name     = "S1" # Standard tier - 400,000 messages/day per unit
iot_hub_sku_capacity = 5    # 5 x 400,000 = 2,000,000/day for 1,728,000/day of load (~86%)

# CosmosDB - V2-owned account (created by the cosmos-db module)
#
# FREE TIER — EXPLICITLY OFF for prod, and it must stay off (MG-48).
# The subscription has exactly ONE free-tier Cosmos slot and DEV holds it (see
# dev.tfvars). This is set false explicitly rather than left to the module default
# so the decision is visible at the point someone would change it: if prod ever
# claimed the slot, Azure would refuse dev's account the free tier and dev's next
# apply would silently start paying again. Prod's throughput is also far past the
# 1000 RU/s allowance, so the tier would buy prod nothing.
#
# ⚠️ FORCE-NEW: free_tier_enabled is settable only at account CREATION. Setting this
# true DESTROYS AND RECREATES module.cosmos_db.azurerm_cosmosdb_account.main — in
# prod that is PRODUCTION DATA LOSS, and nothing in this graph stops it (there is
# deliberately no prevent_destroy; see the location warning above and MG-35).
cosmos_enable_free_tier   = false
temperature_data_ttl_days = 90 # Full 90-day retention for production

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

# SignalR - Standard tier for production, sized by concurrent connections (HAR-62).
# SignalR is single-region and its SLA does not depend on unit count, so extra units
# add capacity only.
#   Connections: one Standard unit holds 1,000 concurrent connections. Since HAR-58
#                the Pis hold none; only the app clients connect. 100 owners at a few
#                clients each is a few hundred connections, so 1 unit.
#   Messages:    one unit includes 1,000,000 messages a day. Above that, Standard
#                bills overage rather than refusing. So message volume, up to the
#                1,728,000 readings a day pushed to watching clients, is a cost and
#                not a cap.
signalr_sku_name     = "Standard_S1" # Standard tier - 1,000 concurrent connections per unit
signalr_sku_capacity = 1             # a few hundred app-client connections fit in one unit

# Device settings for production
device_count = 100
# max_daily_messages is the documented sizing input for the IoT Hub arithmetic above:
# 100 devices x 17,280 readings/day = 1,728,000. No resource reads it today.
max_daily_messages = 1728000

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

# MG-23 (automated dev GitOps reconciliation, CI-run) — subscription-scoped budget
# is NOT managed from this stack, in prod either. Prod infra CI stays PLAN-ONLY and
# operator-applied today (prod's CI-run apply is MG-25), so prod could technically
# still manage a /subscriptions/<id> resource. It is set false anyway, deliberately:
#   - one graph, one boundary. "The Terraform stack is authoritative for resources
#     INSIDE meatgeek-v2-<env>-rg and nothing else" is a far easier invariant to
#     keep true than an env-conditional one, and the static checks enforce it
#     uniformly rather than per-environment.
#   - MG-25 activates prod on the same RG-scoped apply identity and would hit this
#     exact wall; discovering it then, mid-apply, is strictly worse than now.
# The RG-scope budget above remains the primary prod spend control. The
# subscription-level credit warning is an operator/bootstrap concern.
#
# If a prod apply has ALREADY created this resource, flipping to false plans a
# DESTROY — drop it from state instead, keeping the live alert:
#   terraform state rm 'module.monitoring.azurerm_consumption_budget_subscription.credit_budget'
manage_subscription_budget = false
