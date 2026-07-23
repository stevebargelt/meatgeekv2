# Development Environment Configuration

environment = "dev"

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
# NO DESTROY GUARD EXISTS: a location change is ForceNew on the Cosmos account (and
# on IoT Hub), and there is deliberately NO prevent_destroy / destroy guard in the
# shared modules. Terraform's prevent_destroy is a static literal that cannot be
# env-gated (dev vs prod), and MG-24 is greenfield, so no guard was added. Nothing in
# this code protects data at re-apply — the operator is the control. Real prod
# data-loss protection is tracked separately in MG-35.
#
# DEV is GREENFIELD: no temperature history to preserve, so the whole-stack recreate
# (including Cosmos) is intended and carries no data-loss concern here.
location = "West US 2"

# Development-friendly settings
appinsights_retention_days = 30
log_retention_days         = 30

# IoT Hub - S1 required for message routing (parallel routes to Cosmos + EventHub); F1 does not support routing. ~$10-25/mo delta.
iot_hub_sku_name     = "S1"
iot_hub_sku_capacity = 1

# CosmosDB - V2-owned account (created by the cosmos-db module)
cosmos_database_throughput     = 400  # Minimum allowed (will use full remaining capacity)
cosmos_database_max_throughput = 1000 # Auto-scale maximum for dev
temperature_data_ttl_days      = 7    # Shorter retention for dev (cost savings)

# Azure Functions — Flex Consumption (MG-24 hosting revision, 2026-07-23).
# Replaces the inherited Y1 service plan. Flex resolves the Y1 MI-storage 403 by
# using an MI-auth BLOB deployment container instead of an Azure Files content
# share, so shared_access_key_enabled=false stays on the functions storage account.
#
# Flex knobs (mapped to azurerm_function_app_flex_consumption on azurerm v4.81.0):
#   instance_memory_in_mb  — per-instance memory tier (smallest widely-supported GA
#                            tier is 2048 MB; keep small in dev for cost).
#   maximum_instance_count — hard ceiling on horizontal scale-out (dev capped low).
#   always_ready           — pre-warmed instances kept running at all times.
#
# COST (point 9): dev runs SCALE-TO-ZERO (always_ready = 0), so with no traffic the
# Function App bills ~$0 idle — only per-execution GB-s + requests when invoked.
# This keeps the Function App comfortably inside the $50 RG budget below.
instance_memory_in_mb  = 2048
maximum_instance_count = 40 # Flex minimum ceiling — dev needs no burst headroom
always_ready           = 0  # scale-to-zero: no always-on instances, ~$0 idle

# SignalR - Free tier
signalr_sku_name     = "Free_F1" # Free tier - 20 concurrent connections
signalr_sku_capacity = 1

# Device settings for development
device_count       = 5
max_daily_messages = 10000

# Security - More permissive for development
allowed_ip_ranges = ["0.0.0.0/0"]

# HTTP posture (S2) — explicit, env-specific CORS origins (no wildcard).
# Dev allows the local web/mobile dev servers only.
functions_cors_allowed_origins = ["http://localhost:4200", "http://localhost:3000"]
signalr_cors_allowed_origins   = ["http://localhost:4200", "http://localhost:3000"]

# Function App authentication (Easy Auth) — dev Entra API registration (MG-24 item 3).
#
# These three keys point the Function App's App Service Authentication at the
# SEPARATE dev API Entra registration provisioned by the bootstrap (NOT the
# GitHub deployment OIDC app). Fill them from the bootstrap output AFTER the
# registration exists:
#   functions_auth_client_id         <- the dev API registration's Application (client) ID
#   functions_auth_tenant_id         <- the dev tenant ID
#   functions_auth_allowed_audiences <- the dev API registration's App ID URI, e.g.
#                                       ["api://<dev-api-client-id>"] (matches the
#                                       token-acquisition scope in the runbook:
#                                       az account get-access-token --scope "<App ID URI>/access_as_user")
# See: apps/infrastructure/bootstrap/bootstrap.sh output and
#      docs/infrastructure/bootstrap-runbook.md (dev API auth / token-acquisition).
#
# DEFAULT-DENY / FAIL-CLOSED: leaving functions_auth_client_id empty is intentional
# and safe — the functions module's plan-time precondition REFUSES the plan while it
# is unset (an empty value cannot produce a valid auth_settings_v2, so an anonymous
# Function App can never be shipped). Populate these post-bootstrap to activate the
# REAL Entra provider; do NOT insert a dummy/non-empty client id (that would satisfy
# the precondition and ship a broken provider instead of failing closed).
functions_auth_client_id         = "348570b2-44e5-41a6-ad15-2a7032366130"
functions_auth_tenant_id         = "7466b411-ac2e-49a0-b5d5-b1e866d26bac"
functions_auth_allowed_audiences = ["api://348570b2-44e5-41a6-ad15-2a7032366130"]

# allowed_applications = the CALLING client(s) Easy Auth accepts (validates the
# token's appid/azp), NOT the API registration. The operator smoke test acquires
# a token via `az account get-access-token --scope "<App ID URI>/access_as_user"`,
# whose caller is the Azure CLI PUBLIC client (04b07795-8ddb-461a-bbee-02f9e1bf7b46),
# so that is the default. Override with a dedicated dev client's app id if you use
# one. Every id here MUST be pre-authorized for access_as_user on the dev API
# registration (bootstrap SMOKE_TEST_CLIENT_IDS → preAuthorizedApplications), else
# token acquisition prompts for consent. A token from any OTHER client is rejected.
functions_auth_allowed_client_app_ids = ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"] # Azure CLI public client

# App-deployment identity → Function App publish role (MG-24 item 4).
# The SERVICE PRINCIPAL OBJECT ID of the SEPARATE app-deployment identity that
# `func publish` runs as. The bootstrap (Part 1) creates that identity BEFORE
# this apply and emits its object id as AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID.
# Paste it here so THIS apply grants Website Contributor scoped to the Function
# App alone — then `func publish` works immediately, with no missing post-apply
# grant step. Leaving it empty still validates/plans but produces a Function App
# nothing can publish to; REQUIRED before you deploy code to dev.
app_deploy_principal_object_id = "2199ba47-ffae-4cba-86a5-acaa34113d9a"

# Cost management
enable_backup          = false # Disable backups in dev to save costs
backup_retention_days  = 1
auto_shutdown_enabled  = true                # Enable auto-shutdown for dev resources
budget_limit           = 50                  # Lower budget limit for development (RG scope)
secondary_budget_limit = 150                 # Subscription-level warning before $200 Azure credit exhausted
admin_email            = "steve@bargelt.com" # Update with your email for alerts

# Observability cost control
ingestion_cap_gb = 2 # Hard daily ingestion cap on Log Analytics workspace
