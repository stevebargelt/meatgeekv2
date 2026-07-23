# Plan-level security-posture test for the Functions module (MG-24 step 1).
#
# Runs the module as the config-under-test with a MOCKED azurerm provider — NO
# live Azure, NO credentials, NO apply. It EXERCISES the rendered plan (not just
# static text) to prove the security invariants item 2 (App Insights AAD
# ingestion), item 3 (dev Easy-Auth validation-only + fail-closed) and item 9
# (globally-unique Function App name) must hold — now on the Flex Consumption
# resource (azurerm_function_app_flex_consumption) after the MG-24 hosting
# revision replaced the Y1/EP1 azurerm_linux_function_app.
#
# Run:  terraform -chdir=apps/infrastructure/modules/functions test
# (init the module dir with `terraform init -backend=false` first).

mock_provider "azurerm" {}

# The module now creates the Flex deployment blob container via azapi over the ARM
# control plane (Microsoft.Storage/.../blobServices/containers), so the azapi
# provider is mocked here too — NO live Azure, NO credentials.
mock_provider "azapi" {}

variables {
  resource_prefix                        = "meatgeek-v2-dev"
  global_suffix                          = "abc123def456"
  resource_group_name                    = "meatgeek-v2-dev-rg"
  resource_group_id                      = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg"
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
    condition     = azurerm_function_app_flex_consumption.main.name == "meatgeek-v2-dev-func-abc123def456"
    error_message = "Function App name must append global_suffix for global uniqueness"
  }
}

# MG-24 Flex deployment-storage posture — the deployment package is read from a
# blobContainer authenticated by the Function App's SYSTEM-ASSIGNED managed
# identity, and the underlying storage account keeps shared-key access DISABLED.
# There is no Azure Files content share and no shared key, so AzureWebJobsStorage
# cannot fall back to a key and no key can leak into state — the precondition the
# gate's storage-residual acceptance relies on. The account is created via azapi
# over the ARM control plane (Microsoft.Storage/storageAccounts), so shared-key
# disablement is asserted on the azapi body (allowSharedKeyAccess=false) rather
# than the former azurerm shared_access_key_enabled attribute.
run "deployment_storage_is_managed_identity_only" {
  command = plan
  assert {
    condition     = azapi_resource.functions_storage.body.properties.allowSharedKeyAccess == false
    error_message = "Function storage must set allowSharedKeyAccess=false (no account key can authenticate or leak into state)"
  }
  assert {
    condition     = azapi_resource.functions_storage.body.kind == "StorageV2"
    error_message = "Function storage must be StorageV2"
  }
  assert {
    condition     = azapi_resource.functions_storage.body.properties.minimumTlsVersion == "TLS1_2"
    error_message = "Function storage must enforce minimumTlsVersion=TLS1_2"
  }
  assert {
    condition     = azurerm_function_app_flex_consumption.main.storage_authentication_type == "SystemAssignedIdentity"
    error_message = "Flex deployment storage must authenticate with the system-assigned managed identity, not a storage account key"
  }
  assert {
    condition     = azurerm_function_app_flex_consumption.main.storage_container_type == "blobContainer"
    error_message = "Flex deployment storage must use a blobContainer (MI-auth), not an Azure Files content share"
  }
  # The deployment container must be PRIVATE — never anonymously readable. The
  # package ZIP is fetched by the Function App's managed identity, so no public
  # blob access is ever needed. It is created via azapi over the ARM control plane
  # (publicAccess = "None"). (The endpoint itself is built by string interpolation
  # of the blob endpoint + this container name, carrying no SAS / AccountKey; the
  # plain-URL shape is asserted by the pre-apply secret gate.)
  assert {
    condition     = azapi_resource.deployment_container.body.properties.publicAccess == "None"
    error_message = "Flex deployment container must be private (publicAccess = \"None\", no anonymous blob access)"
  }
  # Node 24 runtime (matches the API engines.node and the operator's local Node).
  assert {
    condition     = azurerm_function_app_flex_consumption.main.runtime_name == "node" && azurerm_function_app_flex_consumption.main.runtime_version == "24"
    error_message = "Flex runtime must be node / version 24"
  }
}

# item 2 (+ MG-24 second-plan no-op fix) — the FULL App Insights connection string
# (InstrumentationKey included) is wired verbatim via the Flex resource's NATIVE
# site_config.application_insights_connection_string field (NOT an app_setting):
# the Flex provider reflects APPLICATIONINSIGHTS_CONNECTION_STRING into that native
# field, so setting it as an app_setting produced a perpetual second-plan diff.
# Authorization=AAD stays a plain app_setting. The ikey is a non-credential because
# the root sets local_authentication_enabled=false on the AI resource (that coupling
# is enforced by the pre-apply inspection gate, on the site_config field now).
run "appinsights_full_connection_string_aad" {
  command = plan
  assert {
    condition     = azurerm_function_app_flex_consumption.main.site_config[0].application_insights_connection_string == var.application_insights_connection_string
    error_message = "site_config.application_insights_connection_string must be the full TF-managed connection string (native Flex field, not an app_setting — the second-plan no-op fix)"
  }
  # The AI conn string must NOT be duplicated back into app_settings (that is the
  # exact drift the native-field wiring removes).
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "APPLICATIONINSIGHTS_CONNECTION_STRING")
    error_message = "APPLICATIONINSIGHTS_CONNECTION_STRING must NOT be an app_setting — it is wired via the native site_config field (second-plan no-op fix)"
  }
  assert {
    condition     = azurerm_function_app_flex_consumption.main.app_settings["APPLICATIONINSIGHTS_AUTHENTICATION_STRING"] == "Authorization=AAD"
    error_message = "Telemetry ingestion must authenticate via AAD"
  }
  # NEGATIVE: no OTHER service's secret (SAS / account / primary key) may reach
  # app_settings. The AI connection string is the only accepted residual.
  assert {
    condition     = alltrue([for v in values(azurerm_function_app_flex_consumption.main.app_settings) : !can(regex("(?i)(accountkey|sharedaccesskey|primarykey|secondarykey)=", v))])
    error_message = "No SAS/account/primary key may appear in Function App app_settings"
  }
}

# item 3 (configured path) — Easy Auth is validation-only: client-secret-free,
# audience/app pinned, token store off, and unauthenticated requests rejected.
run "easy_auth_is_validation_only_and_fail_closed" {
  command = plan
  assert {
    condition     = azurerm_function_app_flex_consumption.main.auth_settings_v2[0].require_authentication == true
    error_message = "require_authentication must be true"
  }
  assert {
    condition     = azurerm_function_app_flex_consumption.main.auth_settings_v2[0].unauthenticated_action == "Return401"
    error_message = "Unauthenticated requests must be rejected with 401"
  }
  # allowed_applications validates the CALLING client (appid/azp), NOT the API
  # registration. It must carry the smoke-test client (Azure CLI public client),
  # and must NOT be bound to the API registration's own client id.
  assert {
    condition     = contains(azurerm_function_app_flex_consumption.main.auth_settings_v2[0].active_directory_v2[0].allowed_applications, "04b07795-8ddb-461a-bbee-02f9e1bf7b46")
    error_message = "allowed_applications must contain the calling client app id (Azure CLI public client), not the API registration"
  }
  assert {
    condition     = !contains(azurerm_function_app_flex_consumption.main.auth_settings_v2[0].active_directory_v2[0].allowed_applications, "11111111-1111-1111-1111-111111111111")
    error_message = "allowed_applications must NOT be the API registration client id (that is the callee, never the caller)"
  }
  # client_id + allowed_audiences carry the API registration / App ID URI.
  assert {
    condition     = azurerm_function_app_flex_consumption.main.auth_settings_v2[0].active_directory_v2[0].client_id == "11111111-1111-1111-1111-111111111111"
    error_message = "client_id must be the API registration client id"
  }
  # NEGATIVE: no client secret is ever configured (bearer validation only).
  assert {
    condition     = azurerm_function_app_flex_consumption.main.auth_settings_v2[0].active_directory_v2[0].client_secret_setting_name == null || azurerm_function_app_flex_consumption.main.auth_settings_v2[0].active_directory_v2[0].client_secret_setting_name == ""
    error_message = "No client secret may be configured for the Function App auth provider"
  }
  # NEGATIVE: token store disabled (no token-at-rest surface).
  assert {
    condition     = azurerm_function_app_flex_consumption.main.auth_settings_v2[0].login[0].token_store_enabled == false
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
    azurerm_function_app_flex_consumption.main,
  ]
}
