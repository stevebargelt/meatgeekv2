# Plan-level security-posture test for the Functions module (MG-24 step 1).
#
# Runs the module as the config-under-test with a MOCKED azurerm provider — NO
# live Azure, NO credentials, NO apply. It EXERCISES the rendered plan (not just
# static text) to prove the security invariants item 2 (App Insights AAD
# ingestion), item 3 (dev Easy-Auth validation-only + fail-closed) and item 9
# (globally-unique Function App name) must hold.
#
# Run:  terraform -chdir=apps/infrastructure/modules/functions test
# (init the module dir with `terraform init -backend=false` first).

mock_provider "azurerm" {}

variables {
  resource_prefix                        = "meatgeek-v2-dev"
  global_suffix                          = "abc123def456"
  resource_group_name                    = "meatgeek-v2-dev-rg"
  location                               = "westus2"
  storage_account_name                   = "mgv2devabc123def456"
  application_insights_connection_string = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://westus2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/"
  cosmos_account_endpoint                = "https://mgv2dev.documents.azure.com/"
  eventhub_namespace_fqdn                = "meatgeek-v2-dev-eventhub-ns-abc123def456.servicebus.windows.net"
  signalr_service_uri                    = "https://meatgeek-v2-dev-signalr-abc123def456.service.signalr.net"
  # dev/prod tfvars always supply explicit, non-empty CORS origins (no wildcard).
  cors_allowed_origins = ["http://localhost:4200"]
  # Configured (real dev/prod) auth path — a non-empty API registration client id.
  auth_active_directory_client_id = "11111111-1111-1111-1111-111111111111"
  auth_active_directory_tenant_id = "22222222-2222-2222-2222-222222222222"
  auth_allowed_audiences          = ["api://meatgeek-v2-dev-api"]
  # allowed_applications = the CALLING client (Azure CLI public client), NOT the
  # API registration. This is the smoke-test caller that acquires the token.
  auth_allowed_client_app_ids = ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"]
}

# item 9 — Function App name carries the subscription-derived global suffix so a
# greenfield apply cannot collide with a pre-existing Function App anywhere.
run "function_app_name_is_globally_unique" {
  command = plan
  assert {
    condition     = azurerm_linux_function_app.main.name == "meatgeek-v2-dev-func-abc123def456"
    error_message = "Function App name must append global_suffix for global uniqueness"
  }
}

# MG-24 data-service local-auth posture — host storage is fully managed-identity:
# shared-key access is DISABLED (so the account's inherent key attribute cannot
# authenticate and AzureWebJobsStorage cannot fall back to a key), and the host
# resolves storage via its managed identity. This is what makes it SAFE to leave
# shared_access_key_enabled=false without breaking the Functions runtime — the
# precondition the gate's storage-residual acceptance relies on.
run "host_storage_is_managed_identity_only" {
  command = plan
  assert {
    condition     = azurerm_storage_account.functions.shared_access_key_enabled == false
    error_message = "Function host storage must have shared_access_key_enabled=false (no account key can authenticate or leak into state)"
  }
  assert {
    condition     = azurerm_linux_function_app.main.storage_uses_managed_identity == true
    error_message = "AzureWebJobsStorage must use the managed identity, not a storage account key"
  }
}

# item 2 — the FULL App Insights connection string (InstrumentationKey included)
# is wired verbatim as APPLICATIONINSIGHTS_CONNECTION_STRING (NOT an
# endpoint-only literal), alongside Authorization=AAD. The ikey is a
# non-credential because the root sets local_authentication_enabled=false on the
# AI resource (that coupling is enforced by the pre-apply inspection gate).
run "appinsights_full_connection_string_aad" {
  command = plan
  assert {
    condition     = azurerm_linux_function_app.main.app_settings["APPLICATIONINSIGHTS_CONNECTION_STRING"] == var.application_insights_connection_string
    error_message = "APPLICATIONINSIGHTS_CONNECTION_STRING must be the full TF-managed connection string, not an endpoint-only literal"
  }
  assert {
    condition     = azurerm_linux_function_app.main.app_settings["APPLICATIONINSIGHTS_AUTHENTICATION_STRING"] == "Authorization=AAD"
    error_message = "Telemetry ingestion must authenticate via AAD"
  }
  # NEGATIVE: no OTHER service's secret (SAS / account / primary key) may reach
  # app_settings. The AI connection string is the only accepted residual.
  assert {
    condition     = alltrue([for v in values(azurerm_linux_function_app.main.app_settings) : !can(regex("(?i)(accountkey|sharedaccesskey|primarykey|secondarykey)=", v))])
    error_message = "No SAS/account/primary key may appear in Function App app_settings"
  }
}

# item 3 (configured path) — Easy Auth is validation-only: client-secret-free,
# audience/app pinned, token store off, and unauthenticated requests rejected.
run "easy_auth_is_validation_only_and_fail_closed" {
  command = plan
  assert {
    condition     = azurerm_linux_function_app.main.auth_settings_v2[0].require_authentication == true
    error_message = "require_authentication must be true"
  }
  assert {
    condition     = azurerm_linux_function_app.main.auth_settings_v2[0].unauthenticated_action == "Return401"
    error_message = "Unauthenticated requests must be rejected with 401"
  }
  # allowed_applications validates the CALLING client (appid/azp), NOT the API
  # registration. It must carry the smoke-test client (Azure CLI public client),
  # and must NOT be bound to the API registration's own client id.
  assert {
    condition     = contains(azurerm_linux_function_app.main.auth_settings_v2[0].active_directory_v2[0].allowed_applications, "04b07795-8ddb-461a-bbee-02f9e1bf7b46")
    error_message = "allowed_applications must contain the calling client app id (Azure CLI public client), not the API registration"
  }
  assert {
    condition     = !contains(azurerm_linux_function_app.main.auth_settings_v2[0].active_directory_v2[0].allowed_applications, "11111111-1111-1111-1111-111111111111")
    error_message = "allowed_applications must NOT be the API registration client id (that is the callee, never the caller)"
  }
  # client_id + allowed_audiences carry the API registration / App ID URI.
  assert {
    condition     = azurerm_linux_function_app.main.auth_settings_v2[0].active_directory_v2[0].client_id == "11111111-1111-1111-1111-111111111111"
    error_message = "client_id must be the API registration client id"
  }
  # NEGATIVE: no client secret is ever configured (bearer validation only).
  assert {
    condition     = azurerm_linux_function_app.main.auth_settings_v2[0].active_directory_v2[0].client_secret_setting_name == null || azurerm_linux_function_app.main.auth_settings_v2[0].active_directory_v2[0].client_secret_setting_name == ""
    error_message = "No client secret may be configured for the Function App auth provider"
  }
  # NEGATIVE: token store disabled (no token-at-rest surface).
  assert {
    condition     = azurerm_linux_function_app.main.auth_settings_v2[0].login[0].token_store_enabled == false
    error_message = "Easy Auth token store must be disabled"
  }
}

# item 3 (unconfigured path) — FAIL-CLOSED. With no API registration client id,
# the plan is REFUSED by the precondition: an anonymous Function App can never be
# deployed. (Azure cannot render a valid auth_settings_v2 without a provider, so
# there is no "auth-enabled-but-no-provider" deployable state.)
run "unconfigured_auth_is_refused_fail_closed" {
  command = plan
  variables {
    auth_active_directory_client_id = ""
    auth_active_directory_tenant_id = ""
    auth_allowed_audiences          = []
  }
  expect_failures = [
    azurerm_linux_function_app.main,
  ]
}
