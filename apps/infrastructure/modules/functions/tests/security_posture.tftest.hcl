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
  cosmos_database_name                   = "meatgeek-v2-dev-db"
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

# MG-24 Flex DEPLOYMENT-storage posture — the deployment package is read from a
# blobContainer authenticated by the Function App's SYSTEM-ASSIGNED managed
# identity, and the underlying storage account keeps shared-key access DISABLED.
# There is no Azure Files content share and no shared key, so nothing can fall
# back to a key and no key can leak into state — the precondition the gate's
# storage-residual acceptance relies on. The account is created via azapi over the
# ARM control plane (Microsoft.Storage/storageAccounts), so shared-key
# disablement is asserted on the azapi body (allowSharedKeyAccess=false) rather
# than the former azurerm shared_access_key_enabled attribute.
#
# SCOPE (MG-58): this run block covers DEPLOYMENT storage ONLY. HOST storage
# (AzureWebJobsStorage) is a SEPARATE authentication surface on the SAME account
# and is asserted by its own run block below. Do NOT fold the two together — a
# fully-configured deployment surface coexisted with a completely unconfigured
# host surface while this assertion stayed green, and that is exactly how the
# MG-58 defect survived MG-24's verify phase.
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

# MG-58 HOST-storage posture — a SEPARATELY NAMED invariant, deliberately NOT
# folded into deployment_storage_is_managed_identity_only above. Host storage and
# deployment storage are two independent authentication surfaces that happen to
# share one storage account: the flex resource's storage_* arguments configure
# only the DEPLOYMENT surface, and the host's own required storage (host lock and
# singleton leases, timer schedule status, the key store) is configured only by
# the AzureWebJobsStorage* app setting. Nothing about one implies the other.
#
# Both halves of the posture are asserted here, because a green half is what let
# the defect through:
#   POSITIVE — the identity-based account-name form is PRESENT and names the
#     functions storage account. Its absence is the MG-58 outage
#     (azure.functions.webjobs.storage Unhealthy / AuthenticationFailed).
#   NEGATIVE — the credential-carrying connection-string form is ABSENT, and so is
#     every service-URI variant. The account-name form and the service-URI form
#     are ALTERNATIVES, not complements.
# The account NAME is not a credential: no key, no SAS, no connection string
# reaches app_settings or state, so this is compatible with — and depends on —
# allowSharedKeyAccess=false asserted above. Shared keys are NOT restored.
run "host_storage_is_managed_identity_only" {
  command = plan
  assert {
    condition     = azurerm_function_app_flex_consumption.main.app_settings["AzureWebJobsStorage__accountName"] == var.storage_account_name
    error_message = "Host storage must be wired identity-based via AzureWebJobsStorage__accountName = the functions storage account name (MG-58). Absent, the host cannot authenticate to its own required storage and no storage-dependent trigger (timer schedule status, singleton lease) can run"
  }
  # NEGATIVE: the credential-carrying form must never come back. This is the
  # secrets-out-of-state invariant for the host surface — a connection string here
  # would carry an account key or SAS, which the account cannot even mint
  # (allowSharedKeyAccess=false) and which must never reach app_settings or state.
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "AzureWebJobsStorage")
    error_message = "The bare AzureWebJobsStorage connection-string form must NOT be an app setting — it carries a shared key or SAS. Host storage authenticates by managed identity (MG-58); shared keys stay disabled"
  }
  # NEGATIVE: exactly ONE host-storage form is published. Expressed as a set
  # equality so it also rejects a variant nobody thought to name.
  assert {
    condition     = [for k in sort(keys(azurerm_function_app_flex_consumption.main.app_settings)) : k if startswith(k, "AzureWebJobsStorage")] == ["AzureWebJobsStorage__accountName"]
    error_message = "Exactly ONE host-storage setting form may be published — the account-name form. No AzureWebJobsStorage__blobServiceUri/__queueServiceUri/__tableServiceUri variant may accompany it: the forms are alternatives, and this account is on standard Azure DNS with no private endpoint and no VNet integration (MG-58)"
  }
  # The host reaches that account over its SYSTEM-ASSIGNED identity — the same
  # identity the deployment surface uses and the one the storage data roles are
  # granted to. Without an identity the account name resolves to nothing.
  assert {
    condition     = azurerm_function_app_flex_consumption.main.identity[0].type == "SystemAssigned"
    error_message = "The identity-based host-storage form requires the app's system-assigned managed identity — AzureWebJobsStorage__accountName has no credential of its own to fall back on"
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

# MG-51 — the Cosmos wiring names a DATABASE, not just an account. The endpoint
# alone left the API to guess, and it guessed a database that has never existed
# while the IoT ingest path (wired with the real name) kept passing. Both halves
# are asserted on the rendered plan: the setting is present, and its value is the
# module input rather than a literal restated here.
run "cosmos_database_name_reaches_the_app" {
  command = plan
  assert {
    condition     = azurerm_function_app_flex_consumption.main.app_settings["COSMOSDB_DATABASE_NAME"] == var.cosmos_database_name
    error_message = "COSMOSDB_DATABASE_NAME must be set from var.cosmos_database_name — the API reads this setting and has no fallback (MG-51)"
  }
  assert {
    condition     = azurerm_function_app_flex_consumption.main.app_settings["COSMOSDB__accountEndpoint"] == var.cosmos_account_endpoint
    error_message = "COSMOSDB__accountEndpoint must still be set alongside the database name — the app needs both to reach Cosmos"
  }
}

# MG-51 negative — an empty database name is refused at plan time. A blank
# setting deploys an app that cannot resolve a database at all, which is the same
# outage as the absent setting this ticket fixes; it must not be expressible.
run "empty_cosmos_database_name_is_refused" {
  command = plan
  variables {
    cosmos_database_name = ""
  }
  expect_failures = [
    var.cosmos_database_name,
  ]
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
