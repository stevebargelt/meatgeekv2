# Development Environment Configuration

environment = "dev"
location    = "North Central US"

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

# Azure Functions - Consumption plan
functions_app_service_plan_sku = "Y1" # Consumption plan for cost efficiency

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
functions_auth_client_id         = "" # <dev API registration Application (client) ID>
functions_auth_tenant_id         = "" # <dev tenant ID>
functions_auth_allowed_audiences = [] # ["api://<dev-api-client-id>"]  (dev API App ID URI)

# allowed_applications = the CALLING client(s) Easy Auth accepts (validates the
# token's appid/azp), NOT the API registration. The operator smoke test acquires
# a token via `az account get-access-token --scope "<App ID URI>/access_as_user"`,
# whose caller is the Azure CLI PUBLIC client (04b07795-8ddb-461a-bbee-02f9e1bf7b46),
# so that is the default. Override with a dedicated dev client's app id if you use
# one. Every id here MUST be pre-authorized for access_as_user on the dev API
# registration (bootstrap SMOKE_TEST_CLIENT_IDS → preAuthorizedApplications), else
# token acquisition prompts for consent. A token from any OTHER client is rejected.
functions_auth_allowed_client_app_ids = ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"] # Azure CLI public client

# Cost management
enable_backup          = false # Disable backups in dev to save costs
backup_retention_days  = 1
auto_shutdown_enabled  = true                # Enable auto-shutdown for dev resources
budget_limit           = 50                  # Lower budget limit for development (RG scope)
secondary_budget_limit = 150                 # Subscription-level warning before $200 Azure credit exhausted
admin_email            = "steve@bargelt.com" # Update with your email for alerts

# Observability cost control
ingestion_cap_gb = 2 # Hard daily ingestion cap on Log Analytics workspace
