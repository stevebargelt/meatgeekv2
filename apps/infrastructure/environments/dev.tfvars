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
# NO IN-GRAPH DESTROY GUARD EXISTS: a location change is ForceNew on the Cosmos
# account (and on IoT Hub), and there is deliberately NO prevent_destroy in the
# shared modules. Terraform's prevent_destroy is a static literal that cannot be
# env-gated (dev vs prod), and MG-24 is greenfield, so no in-graph guard was added.
# Real prod data-loss protection is tracked separately in MG-35.
#
# WHAT THE CONTROL IS NOW (MG-23, automated dev GitOps reconciliation, CI-run).
# Under MG-24 (Terraform reconciliation, operator-run) the operator's own judgement
# at apply time was the only control. MG-23 removes the operator from the STEADY-
# STATE dev path: applies happen automatically on merge to main, so the control is
# now a PIPELINE control:
#   1. Pull requests get credentialless, backendless validation only (ci.yml's
#      validate-infrastructure). No pull request plans against dev state; the only
#      plan is the one .github/workflows/infra-apply-dev.yml saves after merge.
#   2. The destroy circuit-breaker in that workflow inspects the SAVED plan and
#      FAILS the run on ANY destroy or forget. The automatic path cannot carry a
#      destroy authorization at all.
#   3. The only route to a destructive change is the reviewer-approved
#      workflow_dispatch RECOVERY run on main, whose `authorized_changes` input
#      names the EXACT SET of action-qualified tokens (`delete:<address>`,
#      `forget:<address>`) to allow. A set, never a count; see
#      scripts/tf-plan-destroy-guard.sh.
# So a `location` edit here does NOT silently auto-apply: the post-merge apply
# fails, and going ahead needs a recovery run naming every destroyed resource.
# That is a REFUSAL, not data protection: the authorized run still destroys and
# recreates Cosmos with temperature-history loss, and nothing in the code restores
# it. A region cutover still requires a Cosmos migration/restore decision first.
# Prod is unaffected (still operator-run, plan-only in CI; prod's CI-run apply is
# MG-25).
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
#
# FREE TIER — dev holds the subscription's one free-tier slot (MG-48).
# Azure grants exactly ONE free-tier Cosmos account per SUBSCRIPTION (1000 RU/s +
# 25 GB free). That slot was occupied by the V1 `meatgeek` account, which is why
# V2 dev was created with it off and has been paying full price ever since; V1 was
# retired on 2026-08-06 (data exported and verified first — 9,886 documents), so
# the slot is now free and dev claims it. Dev provisions 400 RU/s on the
# temperatures container against a 1000 RU/s allowance, so the ENTIRE Cosmos
# throughput charge for dev (~$24/mo) goes to zero. Prod is explicitly false in
# prod.tfvars so a prod apply can never take the slot out from under dev.
#
# ⚠️ FORCE-NEW: free_tier_enabled is settable only at account CREATION. Flipping
# this DESTROYS AND RECREATES module.cosmos_db.azurerm_cosmosdb_account.main. Dev is
# greenfield so the recreate is acceptable here, but the apply must be authorized
# through the dev workflow's destroy guard (authorized_changes).
cosmos_enable_free_tier = true
# Readings retention is the same in every environment and is set per Reading
# by the device (ADR 0001), not here.

# Azure Functions — Flex Consumption (MG-24 hosting revision, 2026-07-23).
# Replaces the inherited Y1 service plan. Flex resolves the Y1 MI-storage 403 by
# using an MI-auth BLOB deployment container instead of an Azure Files content
# share, so shared_access_key_enabled=false stays on the functions storage account.
#
# Flex knobs (mapped to functionAppConfig.scaleAndConcurrency on the azapi
# Microsoft.Web/sites resource since HAR-15):
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

# HAR-15: dev state holds the Function App under the former azurerm Flex
# resource. true makes the root import blocks adopt that SAME live site (and its
# authsettingsV2 config) into the azapi resources, while a `removed` block drops
# the azurerm address without destroying anything. The site and its managed
# identity are never recreated. Once dev has applied this, the imports are
# no-ops; delete the toggle and the import blocks together.
adopt_existing_function_app = true

# SignalR - Free tier
signalr_sku_name     = "Free_F1" # Free tier - 20 concurrent connections
signalr_sku_capacity = 1

# Device settings for development
device_count       = 5
max_daily_messages = 10000

# Security - More permissive for development
allowed_ip_ranges = ["0.0.0.0/0"]

# HTTP posture (S2) — explicit, env-specific CORS origins (no wildcard).
# Dev allows the local web/mobile dev servers plus the Vercel PRODUCTION origin
# of the web app (https://meatgeekv2-web.vercel.app, HAR-94). Vercel PREVIEW
# origins (*.vercel.app per-branch/per-deploy URLs) are deliberately NOT allowed:
# by the owner's decision, sign-in only works on the production origin.
functions_cors_allowed_origins = ["http://localhost:4200", "http://localhost:3000", "https://meatgeekv2-web.vercel.app"]
signalr_cors_allowed_origins   = ["http://localhost:4200", "http://localhost:3000", "https://meatgeekv2-web.vercel.app"]

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
# token's appid/azp), NOT the API registration. A token from any OTHER client is
# rejected. Dev has five callers:
#
# 1. The Azure CLI PUBLIC client (04b07795-8ddb-461a-bbee-02f9e1bf7b46): by-hand
#    smoke tests and acceptance runs with a DELEGATED token from
#    `az account get-access-token --scope "<App ID URI>/access_as_user"`. It MUST be
#    pre-authorized for access_as_user on the dev API registration (bootstrap
#    SMOKE_TEST_CLIENT_IDS → preAuthorizedApplications), else token acquisition
#    prompts for consent.
# 2. The dev APP-PUBLISH identity (the `development` environment's
#    AZURE_APP_DEPLOY_CLIENT_ID): the acceptance job in
#    .github/workflows/app-deploy-dev.yml calls the deployed API as this identity
#    with an APP-ONLY token for "<App ID URI>/.default", to prove each dev deploy
#    works without a human (MG-36). Client-credentials tokens need no
#    pre-authorization; this entry is what lets Easy Auth accept it.
# 3. The dev ACCEPTANCE PEER identity (`meatgeek-v2-dev-acceptance-peer`, the
#    `development` environment's AZURE_ACCEPTANCE_PEER_CLIENT_ID, HAR-61): the
#    second caller for the HAR-55 cross-user proof, a signed-in caller that does
#    NOT own the simulated device. It also signs in with an APP-ONLY token for
#    "<App ID URI>/.default", so it needs no pre-authorization either. It holds
#    ZERO Azure roles; this entry is its only access to anything.
# 4. The dev web SPA (`meatgeek-v2-dev-web`, the `development` environment's
#    DEV_WEB_CLIENT_ID, HAR-82): the browser app at
#    https://meatgeekv2-web.vercel.app signs the pitmaster in and calls the API
#    with a DELEGATED user token for "<App ID URI>/access_as_user". It is a
#    PUBLIC SPA client (auth code + PKCE, no client secret). The bootstrap
#    pre-authorizes it for access_as_user on the dev API registration
#    (preAuthorizedApplications), which is why sign-in shows no consent prompt.
# 5. The dev iOS app (`meatgeek-v2-dev-ios`, the `development` environment's
#    DEV_IOS_CLIENT_ID, HAR-159): the native iOS app signs the pitmaster in
#    with MSAL in the system browser and calls the API with a DELEGATED user
#    token for "<App ID URI>/access_as_user". It is a PUBLIC native client
#    (auth code + PKCE, redirect msauth.com.meatgeek.ios://auth, no client
#    secret). The bootstrap pre-authorizes it for access_as_user on the dev API
#    registration (preAuthorizedApplications), which is why sign-in shows no
#    consent prompt.
functions_auth_allowed_client_app_ids = [
  "04b07795-8ddb-461a-bbee-02f9e1bf7b46", # Azure CLI public client
  "8426e178-a4f6-49f8-868a-f070a4ae397f", # dev app-publish identity (AZURE_APP_DEPLOY_CLIENT_ID)
  "62d55e23-b8e8-412f-bcd5-147674ec53bd", # dev acceptance peer identity (AZURE_ACCEPTANCE_PEER_CLIENT_ID), zero Azure roles, second caller for the HAR-55 cross-user proof (HAR-61)
  "508bb3be-30f9-4b03-8d95-93e086de85e1", # dev web SPA meatgeek-v2-dev-web (DEV_WEB_CLIENT_ID), HAR-82, delegated user tokens, pre-authorized for access_as_user
  "b422c945-cb04-4d97-a816-3f20eb54176b", # dev iOS public client meatgeek-v2-dev-ios (DEV_IOS_CLIENT_ID), HAR-159, delegated user tokens, pre-authorized for access_as_user
]

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

# MG-23 (automated dev GitOps reconciliation, CI-run) — subscription-scoped budget
# is NOT managed from this stack. dev is the CI-APPLIED environment, and its apply
# identity is Contributor scoped ONLY to meatgeek-v2-dev-rg; a /subscriptions/<id>
# resource needs a subscription-scoped writer, so leaving it in the graph would make
# the whole configuration unappliable from CI. Resolved in the graph, never by
# widening the identity. The RG-scope budget above (budget_limit) is unaffected and
# remains the primary spend control; the subscription-level credit warning becomes
# a bootstrap/operator concern.
#
# ⚠️  dev APPLIED this resource under MG-24, so it IS in dev state: setting this
# false plans a DESTROY. Before activating the MG-23 loop, drop it from state
# WITHOUT touching Azure (keeps the live spend alert, moves ownership out of CI):
#   terraform state rm 'module.monitoring.azurerm_consumption_budget_subscription.credit_budget'
# Skipping that step means the first CI apply plans a delete and the destroy
# circuit-breaker correctly FAILS the run. See docs/infrastructure/mg23-live-acceptance.md.
manage_subscription_budget = false

# Observability cost control
ingestion_cap_gb = 2 # Hard daily ingestion cap on Log Analytics workspace

# HAR-39 standing simulated device: the acceptance job creates it and sends as it.
simulated_device_id = "meatgeek-dev-simulated-smoker"

# HAR-56 API device-twin writer grant: IoT Hub Twin Contributor for the Function
# App identity, scoped to the hub. Safe to switch on because the owner re-ran
# bootstrap.sh on 2026-11-20 for HAR-55, which taught the infra-apply identity's
# ABAC condition the role (allowlist GUID 494bdba2-168f-4f31-a0a1-191d2f7c028c).
api_device_twin_writer_enabled = true

# HAR-131 IoT Hub Device Provisioning Service, linked to the hub with the DPS's
# own managed identity. Its one role (IoT Hub Registry Contributor on the hub)
# is already allowlisted and in the live ABAC condition.
dps_enabled = true
# HAR-131 CI enroller grant: on since the owner re-ran bootstrap.sh on 2026-11-22.
dps_ci_enroller_enabled = true

# #241 Key Vault for the APNs signing key; the owner imports the key by hand
# (docs/infrastructure/apns-key-vault.md). The Function App's grant, Key Vault
# Crypto User on that vault: on since the owner re-ran bootstrap.sh on
# 2026-11-26, which put the role in the live ABAC condition.
apns_key_vault_enabled  = true
apns_key_signer_enabled = true

# #243 what the API needs to call Apple. Neither is account-specific. The key id
# and team id are not here: they come from the APNS_KEY_ID and APNS_TEAM_ID
# GitHub secrets as TF_VAR_apns_key_id and TF_VAR_apns_team_id.
apns_bundle_id = "com.meatgeek.ios"
apns_host      = "api.sandbox.push.apple.com"
