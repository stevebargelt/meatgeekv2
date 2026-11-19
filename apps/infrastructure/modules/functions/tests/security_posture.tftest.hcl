# Plan-level security-posture test for the Functions module (MG-24 step 1).
#
# Runs the module as the config-under-test with MOCKED providers — NO live Azure,
# NO credentials, NO apply. It EXERCISES the rendered plan (not just static text)
# to prove the security invariants item 2 (App Insights AAD ingestion), item 3
# (dev Easy-Auth validation-only + fail-closed) and item 9 (globally-unique
# Function App name) must hold.
#
# HAR-15: the Function App is an azapi Microsoft.Web/sites resource
# (azapi_resource.function_app) and Easy Auth is its own azapi
# Microsoft.Web/sites/config resource named authsettingsV2
# (azapi_resource.function_app_auth). The assertions below are the same
# properties the suite asserted on the former azurerm Flex resource, read from
# the request bodies azapi actually sends. Because a site PUT replaces the whole
# app settings collection, the declared settings ARE the deployed settings, so
# the host-storage absence assertions are now authoritative, not regression
# fences.
#
# Run:  terraform -chdir=apps/infrastructure/modules/functions test
# (init the module dir with `terraform init -backend=false` first).

mock_provider "azurerm" {}

# The storage account, deployment container, Function App site and its Easy
# Auth config are all azapi resources, so azapi is mocked too.
mock_provider "azapi" {}

variables {
  environment                            = "dev"
  resource_prefix                        = "meatgeek-v2-dev"
  global_suffix                          = "abc123def456"
  resource_group_name                    = "meatgeek-v2-dev-rg"
  resource_group_id                      = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg"
  location                               = "westus2"
  storage_account_name                   = "mgv2devabc123def456"
  application_insights_connection_string = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://westus2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/"
  cosmos_account_endpoint                = "https://mgv2dev.documents.azure.com/"
  cosmos_database_name                   = "meatgeek-v2-dev-db"
  cooks_container_name                   = "cooks"
  devices_container_name                 = "devices"
  temperatures_container_name            = "temperatures"
  users_container_name                   = "users"
  recipes_container_name                 = "recipes"
  eventhub_namespace_fqdn                = "meatgeek-v2-dev-eventhub-ns-abc123def456.servicebus.windows.net"
  signalr_service_uri                    = "https://meatgeek-v2-dev-signalr-abc123def456.service.signalr.net"
  iothub_service_hostname                = "meatgeek-v2-dev-iothub-abc123def456.azure-devices.net"
  temperature_broadcast_consumer_group   = "api-broadcast"
  # dev/prod tfvars always supply explicit, non-empty CORS origins (no wildcard).
  cors_allowed_origins = ["http://localhost:4200"]
  # Configured (real dev/prod) auth path — a non-empty API registration client id.
  auth_active_directory_client_id = "11111111-1111-1111-1111-111111111111"
  auth_active_directory_tenant_id = "22222222-2222-2222-2222-222222222222"
  auth_allowed_audiences          = ["api://meatgeek-v2-dev-api"]
  # allowedApplications = the CALLING client (Azure CLI public client), NOT the
  # API registration. This is the smoke-test caller that acquires the token.
  auth_allowed_client_app_ids = ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"]
}

# item 9 — Function App name carries the subscription-derived global suffix so a
# greenfield apply cannot collide with a pre-existing Function App anywhere.
run "function_app_name_is_globally_unique" {
  command = plan
  assert {
    condition     = azapi_resource.function_app.name == "meatgeek-v2-dev-func-abc123def456"
    error_message = "Function App name must append global_suffix for global uniqueness"
  }
  # The site is created in the module's resource group. The root's import id is
  # derived from these same two values, so they must stay the site's identity.
  assert {
    condition     = azapi_resource.function_app.parent_id == var.resource_group_id
    error_message = "The Function App site must be created in the module's resource group (parent_id = var.resource_group_id)"
  }
  assert {
    condition     = azapi_resource.function_app.body.kind == "functionapp,linux"
    error_message = "The site must be a Linux function app (kind = \"functionapp,linux\")"
  }
}

# MG-24 Flex DEPLOYMENT-storage posture — the deployment package is read from a
# blobContainer authenticated by the Function App's SYSTEM-ASSIGNED managed
# identity, and the underlying storage account keeps shared-key access DISABLED.
# There is no Azure Files content share and no shared key, so nothing can fall
# back to a key and no key can leak into state — the precondition the gate's
# storage-residual acceptance relies on. The account is created via azapi over the
# ARM control plane (Microsoft.Storage/storageAccounts), so shared-key
# disablement is asserted on the azapi body (allowSharedKeyAccess=false).
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
    condition     = azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.authentication.type == "SystemAssignedIdentity"
    error_message = "Flex deployment storage must authenticate with the system-assigned managed identity, not a storage account key"
  }
  # The connection-string auth path names an app setting that would carry a
  # key. Under managed-identity auth it must not be set at all.
  assert {
    condition     = !can(azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.authentication.storageAccountConnectionStringName)
    error_message = "Flex deployment storage must not name a storage connection-string setting (storageAccountConnectionStringName) — that is the shared-key deployment path"
  }
  assert {
    condition     = azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.type == "blobContainer"
    error_message = "Flex deployment storage must use a blobContainer (MI-auth), not an Azure Files content share"
  }
  # The endpoint is a plain URL on the functions account and container: no SAS,
  # no AccountKey, nothing after the container name.
  assert {
    condition     = azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.value == "https://${var.storage_account_name}.blob.core.windows.net/deployment-package"
    error_message = "Flex deployment storage must be the plain blob-container URL of the functions storage account's deployment-package container (no SAS, no key)"
  }
  # The deployment container must be PRIVATE — never anonymously readable. The
  # package ZIP is fetched by the Function App's managed identity, so no public
  # blob access is ever needed.
  assert {
    condition     = azapi_resource.deployment_container.body.properties.publicAccess == "None"
    error_message = "Flex deployment container must be private (publicAccess = \"None\", no anonymous blob access)"
  }
  # Node 24 runtime (matches the API engines.node and the operator's local Node).
  assert {
    condition     = azapi_resource.function_app.body.properties.functionAppConfig.runtime.name == "node" && azapi_resource.function_app.body.properties.functionAppConfig.runtime.version == "24"
    error_message = "Flex runtime must be node / version 24"
  }
}

# MG-58 HOST-storage posture — a SEPARATELY NAMED invariant, deliberately NOT
# folded into deployment_storage_is_managed_identity_only above. Host storage and
# deployment storage are two independent authentication surfaces that happen to
# share one storage account: functionAppConfig configures only the DEPLOYMENT
# surface, and the host's own required storage (host lock and singleton leases,
# timer schedule status, the key store) is configured only by the
# AzureWebJobsStorage* app setting. Nothing about one implies the other.
#
# Both halves of the posture are asserted here, because a green half is what let
# the defect through:
#   POSITIVE — the identity-based account-name form is PRESENT and names the
#     functions storage account. Its absence is the MG-58 outage
#     (azure.functions.webjobs.storage Unhealthy / AuthenticationFailed).
#   NEGATIVE — the credential-carrying connection-string form is ABSENT, and so is
#     every service-URI variant and the deployment-storage connection string.
#
# HAR-15: these assertions read the settings collection azapi PUTs. That
# collection replaces whatever the site had, and nothing else writes it, so
# "absent here" now means "absent on the deployed site" — the property the
# azurerm provider made impossible to state in HCL. App Service treats setting
# names case-insensitively, so the absence checks lower-case every name.
run "host_storage_is_managed_identity_only" {
  command = plan
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["AzureWebJobsStorage__accountName"] == var.storage_account_name
    error_message = "Host storage must be wired identity-based via AzureWebJobsStorage__accountName = the functions storage account name (MG-58). Absent, the host cannot authenticate to its own required storage and no storage-dependent trigger (timer schedule status, singleton lease) can run"
  }
  # NEGATIVE: the credential-carrying form must never be declared, in any case.
  # With shared keys disabled it can only carry an unusable key, and the host
  # reads it BEFORE the identity form — its presence is the MG-58 outage.
  assert {
    condition     = !contains([for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : lower(s.name)], "azurewebjobsstorage")
    error_message = "The scalar AzureWebJobsStorage connection-string setting must NOT be declared (matched case-insensitively) — it carries a shared key or SAS and shadows the identity form. Host storage authenticates by managed identity (MG-58, HAR-15)"
  }
  # NEGATIVE: the deployment-storage connection string must never be declared.
  # Deployment storage authenticates by managed identity in functionAppConfig.
  assert {
    condition     = !contains([for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : lower(s.name)], "deployment_storage_connection_string")
    error_message = "DEPLOYMENT_STORAGE_CONNECTION_STRING must NOT be declared (matched case-insensitively) — deployment storage authenticates by managed identity, and a connection string here carries a key (MG-61, HAR-15)"
  }
  # NEGATIVE: exactly ONE host-storage form is published, case-insensitively.
  # Expressed as a set equality so it also rejects a variant nobody thought to
  # name (__blobServiceUri / __queueServiceUri / __tableServiceUri, or a
  # differently-cased duplicate of the account-name form).
  assert {
    condition     = [for n in sort([for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : lower(s.name)]) : n if startswith(n, "azurewebjobsstorage")] == ["azurewebjobsstorage__accountname"]
    error_message = "Exactly ONE host-storage setting form may be published — the account-name form. No AzureWebJobsStorage__blobServiceUri/__queueServiceUri/__tableServiceUri variant may accompany it: the forms are alternatives, and this account is on standard Azure DNS with no private endpoint and no VNet integration (MG-58)"
  }
  # The host reaches that account over its SYSTEM-ASSIGNED identity — the same
  # identity the deployment surface uses and the one the storage data roles are
  # granted to. Without an identity the account name resolves to nothing.
  assert {
    condition     = azapi_resource.function_app.identity[0].type == "SystemAssigned"
    error_message = "The identity-based host-storage form requires the app's system-assigned managed identity — AzureWebJobsStorage__accountName has no credential of its own to fall back on"
  }
}

# HAR-16 — the system identity declares identity_ids = [] (an empty LIST, not
# null). azapi v2.11.0 ModifyPlan (internal/services/azapi_resource.go:581-587)
# reuses the state identity, and so keeps principal_id KNOWN, only when the
# planned type AND identity_ids strictly equal the state's. State holds [], so an
# omitted (null) identity_ids left principal_id unknown and forced replacement of
# all six role assignments (Apply Dev Infrastructure run 44413716132).
run "system_identity_keeps_principal_id_known" {
  command = plan
  assert {
    condition     = azapi_resource.function_app.identity[0].type == "SystemAssigned"
    error_message = "The Function App identity must stay SystemAssigned (HAR-16: identity redesign is out of scope)"
  }
  assert {
    condition     = azapi_resource.function_app.identity[0].identity_ids != null && length(azapi_resource.function_app.identity[0].identity_ids) == 0
    error_message = "azapi_resource.function_app identity must declare identity_ids = [] (empty list, NOT null/omitted). azapi v2.11.0 copies the state principal_id into the plan only when identity_ids strictly equals the state's []; null leaves principal_id unknown and REPLACES all six role assignments (HAR-16, run 44413716132)"
  }
}

# item 2 — the FULL App Insights connection string (InstrumentationKey included)
# reaches the app as APPLICATIONINSIGHTS_CONNECTION_STRING, and Authorization=AAD
# makes ingestion identity-based. The ikey is a non-credential because the root
# sets local_authentication_enabled=false on the AI resource; that coupling is
# enforced by the pre-apply inspection gate on this setting.
#
# HAR-15: under azurerm the string was wired through the native
# site_config.application_insights_connection_string field, which the provider
# turned into this same app setting on the wire (declaring it directly caused a
# perpetual azurerm diff). azapi sends the settings collection verbatim, so the
# setting is declared directly and asserted here.
run "appinsights_full_connection_string_aad" {
  command = plan
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["APPLICATIONINSIGHTS_CONNECTION_STRING"] == var.application_insights_connection_string
    error_message = "APPLICATIONINSIGHTS_CONNECTION_STRING must be the full TF-managed App Insights connection string"
  }
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["APPLICATIONINSIGHTS_AUTHENTICATION_STRING"] == "Authorization=AAD"
    error_message = "Telemetry ingestion must authenticate via AAD"
  }
  # NEGATIVE: the bare instrumentation key setting is not published. The full
  # connection string is the only App Insights destination the app gets.
  assert {
    condition     = !contains([for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : lower(s.name)], "appinsights_instrumentationkey")
    error_message = "APPINSIGHTS_INSTRUMENTATIONKEY must NOT be declared — a bare ikey is prohibited in app settings"
  }
  # NEGATIVE: no OTHER service's secret (SAS / account / primary key) may reach
  # the app settings. The AI connection string is the only accepted residual.
  assert {
    condition     = alltrue([for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : !can(regex("(?i)(accountkey|sharedaccesskey|sharedaccesssignature|primarykey|secondarykey)=", s.value))])
    error_message = "No SAS/account/primary key may appear in Function App app settings"
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
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["COSMOSDB_DATABASE_NAME"] == var.cosmos_database_name
    error_message = "COSMOSDB_DATABASE_NAME must be set from var.cosmos_database_name — the API reads this setting and has no fallback (MG-51)"
  }
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["COSMOSDB__accountEndpoint"] == var.cosmos_account_endpoint
    error_message = "COSMOSDB__accountEndpoint must still be set alongside the database name — the app needs both to reach Cosmos"
  }
}

# MG-59 — the cooks CONTAINER name reaches the app the same MG-51-safe way the
# database name does: present in the app settings and equal to the module input
# (root wires it from module.cosmos_db.destination_container_names.cooks), NOT a
# literal restated in the module. This is the setting the cooks adapter's
# fail-loud guard reads (COSMOSDB_COOKS_CONTAINER_NAME).
run "cooks_container_name_reaches_the_app" {
  command = plan
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["COSMOSDB_COOKS_CONTAINER_NAME"] == var.cooks_container_name
    error_message = "COSMOSDB_COOKS_CONTAINER_NAME must be set from var.cooks_container_name — the cooks adapter reads this setting and has no fallback (MG-59)"
  }
}

# HAR-19 — the devices, temperatures, users and recipes container names reach
# the app exactly as the cooks name does: present in the app settings and equal
# to the module input (root wires each from
# module.cosmos_db.destination_container_names.<entity>), never a literal.
run "entity_container_names_reach_the_app" {
  command = plan
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["COSMOSDB_DEVICES_CONTAINER_NAME"] == var.devices_container_name
    error_message = "COSMOSDB_DEVICES_CONTAINER_NAME must be set from var.devices_container_name (HAR-19)"
  }
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["COSMOSDB_TEMPERATURES_CONTAINER_NAME"] == var.temperatures_container_name
    error_message = "COSMOSDB_TEMPERATURES_CONTAINER_NAME must be set from var.temperatures_container_name (HAR-19)"
  }
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["COSMOSDB_USERS_CONTAINER_NAME"] == var.users_container_name
    error_message = "COSMOSDB_USERS_CONTAINER_NAME must be set from var.users_container_name (HAR-19)"
  }
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["COSMOSDB_RECIPES_CONTAINER_NAME"] == var.recipes_container_name
    error_message = "COSMOSDB_RECIPES_CONTAINER_NAME must be set from var.recipes_container_name (HAR-19)"
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

# MG-59 negative — a blank cooks container name is refused at plan time, exactly
# as the database name is. A blank setting deploys cooks handlers that cannot
# address their container (a config-drift 404), so it must not be expressible.
run "empty_cooks_container_name_is_refused" {
  command = plan
  variables {
    cooks_container_name = ""
  }
  expect_failures = [
    var.cooks_container_name,
  ]
}

# HAR-19 negative — a blank devices container name is refused at plan time, as cooks is.
run "empty_devices_container_name_is_refused" {
  command = plan
  variables {
    devices_container_name = " "
  }
  expect_failures = [
    var.devices_container_name,
  ]
}

# HAR-19 negative — a blank temperatures container name is refused at plan time, as cooks is.
run "empty_temperatures_container_name_is_refused" {
  command = plan
  variables {
    temperatures_container_name = " "
  }
  expect_failures = [
    var.temperatures_container_name,
  ]
}

# HAR-19 negative — a blank users container name is refused at plan time, as cooks is.
run "empty_users_container_name_is_refused" {
  command = plan
  variables {
    users_container_name = " "
  }
  expect_failures = [
    var.users_container_name,
  ]
}

# HAR-19 negative — a blank recipes container name is refused at plan time, as cooks is.
run "empty_recipes_container_name_is_refused" {
  command = plan
  variables {
    recipes_container_name = " "
  }
  expect_failures = [
    var.recipes_container_name,
  ]
}

# item 3 (configured path) — Easy Auth is validation-only: client-secret-free,
# audience/app pinned, token store off, and unauthenticated requests rejected.
# Asserted on the config/authsettingsV2 body azapi PUTs.
run "easy_auth_is_validation_only_and_fail_closed" {
  command = plan
  # It is the authsettingsV2 config child, not some other config resource. (Its
  # parent is the site's computed id, unknown at plan; tf-static-checks.sh
  # asserts parent_id = azapi_resource.function_app.id in the HCL.)
  assert {
    condition     = azapi_resource.function_app_auth.name == "authsettingsV2"
    error_message = "Easy Auth must be the Function App site's config/authsettingsV2"
  }
  assert {
    condition     = azapi_resource.function_app_auth.body.properties.platform.enabled == true
    error_message = "Easy Auth must be enabled on the platform"
  }
  assert {
    condition     = azapi_resource.function_app_auth.body.properties.globalValidation.requireAuthentication == true
    error_message = "requireAuthentication must be true"
  }
  assert {
    condition     = azapi_resource.function_app_auth.body.properties.globalValidation.unauthenticatedClientAction == "Return401"
    error_message = "Unauthenticated requests must be rejected with 401"
  }
  # allowedApplications validates the CALLING client (appid/azp), NOT the API
  # registration. It must carry the smoke-test client (Azure CLI public client),
  # and must NOT be bound to the API registration's own client id.
  assert {
    condition     = contains(azapi_resource.function_app_auth.body.properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedApplications, "04b07795-8ddb-461a-bbee-02f9e1bf7b46")
    error_message = "allowedApplications must contain the calling client app id (Azure CLI public client), not the API registration"
  }
  assert {
    condition     = !contains(azapi_resource.function_app_auth.body.properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedApplications, "11111111-1111-1111-1111-111111111111")
    error_message = "allowedApplications must NOT be the API registration client id (that is the callee, never the caller)"
  }
  # clientId + allowedAudiences carry the API registration / App ID URI, and the
  # issuer is the tenant's v2.0 endpoint.
  assert {
    condition     = azapi_resource.function_app_auth.body.properties.identityProviders.azureActiveDirectory.registration.clientId == "11111111-1111-1111-1111-111111111111"
    error_message = "clientId must be the API registration client id"
  }
  assert {
    condition     = azapi_resource.function_app_auth.body.properties.identityProviders.azureActiveDirectory.registration.openIdIssuer == "https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0"
    error_message = "openIdIssuer must be the configured tenant's v2.0 endpoint"
  }
  assert {
    condition     = jsonencode(azapi_resource.function_app_auth.body.properties.identityProviders.azureActiveDirectory.validation.allowedAudiences) == jsonencode(["api://meatgeek-v2-dev-api"])
    error_message = "allowedAudiences must be exactly the configured API App ID URI(s)"
  }
  # Bearer-validation-only API: no browser challenge.
  assert {
    condition     = azapi_resource.function_app_auth.body.properties.identityProviders.azureActiveDirectory.login.disableWWWAuthenticate == true
    error_message = "The WWW-Authenticate challenge must be disabled (bearer validation only, clean 401)"
  }
  # NEGATIVE: no client secret is ever configured (bearer validation only).
  assert {
    condition     = !can(azapi_resource.function_app_auth.body.properties.identityProviders.azureActiveDirectory.registration.clientSecretSettingName) && !can(azapi_resource.function_app_auth.body.properties.identityProviders.azureActiveDirectory.registration.clientSecretCertificateThumbprint)
    error_message = "No client secret may be configured for the Function App auth provider"
  }
  # NEGATIVE: token store disabled (no token-at-rest surface).
  assert {
    condition     = azapi_resource.function_app_auth.body.properties.login.tokenStore.enabled == false
    error_message = "Easy Auth token store must be disabled"
  }
}

# item 3 (unconfigured path) — FAIL-CLOSED. With no API registration client id,
# the plan is REFUSED by the precondition on the authsettingsV2 resource: an
# anonymous Function App can never be deployed. (Azure cannot render valid
# authsettingsV2 without a provider, so there is no
# "auth-enabled-but-no-provider" deployable state.)
run "unconfigured_auth_is_refused_fail_closed" {
  command = plan
  variables {
    auth_active_directory_client_id = ""
    auth_active_directory_tenant_id = ""
    auth_allowed_audiences          = []
  }
  expect_failures = [
    azapi_resource.function_app_auth,
  ]
}

# The other three preconditions, each in isolation: a client id with no tenant,
# no audience, or no calling-client allowlist is refused rather than deployed
# as an Easy Auth that rejects every token or accepts any client.
run "auth_without_tenant_is_refused" {
  command = plan
  variables {
    auth_active_directory_tenant_id = ""
  }
  expect_failures = [
    azapi_resource.function_app_auth,
  ]
}

run "auth_without_audience_is_refused" {
  command = plan
  variables {
    auth_allowed_audiences = []
  }
  expect_failures = [
    azapi_resource.function_app_auth,
  ]
}

run "auth_without_calling_client_allowlist_is_refused" {
  command = plan
  variables {
    auth_allowed_client_app_ids = []
  }
  expect_failures = [
    azapi_resource.function_app_auth,
  ]
}

# HAR-15 migration — the root module adopts the existing dev site with import
# blocks whose ids come from the function_app_import_ids output. Those ids must
# name exactly the site and config child this module manages, at the
# api-version the resources declare; a mismatch would import the wrong object
# or fail the dev plan. Derived from the inputs, never a literal dev id.
run "import_ids_name_the_site_this_module_manages" {
  command = plan
  assert {
    condition     = output.function_app_import_ids.site == "${var.resource_group_id}/providers/Microsoft.Web/sites/${azapi_resource.function_app.name}?api-version=${split("@", azapi_resource.function_app.type)[1]}"
    error_message = "function_app_import_ids.site must be <resource group id>/providers/Microsoft.Web/sites/<site name>?api-version=<the site's api-version>"
  }
  assert {
    condition     = output.function_app_import_ids.auth == "${var.resource_group_id}/providers/Microsoft.Web/sites/${azapi_resource.function_app.name}/config/${azapi_resource.function_app_auth.name}?api-version=${split("@", azapi_resource.function_app_auth.type)[1]}"
    error_message = "function_app_import_ids.auth must be the site's config/authsettingsV2 id at the auth resource's api-version"
  }
  assert {
    condition     = startswith(azapi_resource.function_app.type, "Microsoft.Web/sites@") && startswith(azapi_resource.function_app_auth.type, "Microsoft.Web/sites/config@")
    error_message = "The site and its Easy Auth config must be Microsoft.Web/sites and Microsoft.Web/sites/config resources"
  }
}

# HAR-17 — config/authsettingsV2 ignores ONLY the tags ARM echoes from the parent
# site. GET of that proxy resource returns the site's tags, azapi v2.11.0 Read
# stores them, and an unset `tags` plans null, so without ignore_changes the dev
# apply's final drift plan can never converge (Apply Dev Infrastructure run
# 44418353799). `tags = var.tags` is not an option: azapi's embedded schema for
# Microsoft.Web/sites/config has no `tags` and refuses it at validate time.
#
# A mocked provider cannot reproduce azapi's ModifyPlan (it is the real
# provider's tagsWithDefaultTags that plans null), and a lifecycle argument is not
# an expression a test can reference. So the first assertion reads the module
# source this run plans: the function_app_auth block must carry exactly
# `ignore_changes = [tags]` on a code line (a commented-out line does not match),
# and must not ignore body or identity. The plan-level assertions pin the rest of
# the contract: the request body declares no tags (schema validation would refuse
# them) and the site still carries var.tags, the value ARM echoes.
run "auth_config_ignores_echoed_parent_tags" {
  command = plan
  assert {
    condition = can(regex(
      "(?m)^[ \\t]*ignore_changes[ \\t]*=[ \\t]*\\[[ \\t]*tags[ \\t]*\\][ \\t]*$",
      regex("(?s)resource \"azapi_resource\" \"function_app_auth\" \\{.*?\\n\\}\\n", file("${path.module}/main.tf"))
    ))
    error_message = "azapi_resource.function_app_auth must declare lifecycle { ignore_changes = [tags] }. ARM echoes the parent site's tags on config/authsettingsV2 and azapi plans an unset tags as null, so without it every dev apply fails its final drift plan (HAR-17, run 44418353799)"
  }
  assert {
    condition     = length(regexall("(?m)^[ \\t]*ignore_changes[ \\t]*=", regex("(?s)resource \"azapi_resource\" \"function_app_auth\" \\{.*?\\n\\}\\n", file("${path.module}/main.tf")))) == 1
    error_message = "azapi_resource.function_app_auth must have exactly one ignore_changes, and it must be [tags]: body, identity and every other attribute stay managed (HAR-17)"
  }
  assert {
    condition     = !contains(keys(azapi_resource.function_app_auth.body), "tags")
    error_message = "config/authsettingsV2's body must not declare tags: azapi's embedded schema for Microsoft.Web/sites/config has no tags property"
  }
  assert {
    condition     = azapi_resource.function_app.tags == var.tags
    error_message = "The site must carry var.tags; ARM echoes them on config/authsettingsV2, which is why that resource ignores tags"
  }
}

# HAR-17 — MEATGEEK_ENVIRONMENT tells the running app its environment. A plain,
# non-secret label from the module input, never a literal restated here. Its
# arrival through Terraform is goal HAR-9 item 7's setting-change proof.
run "meatgeek_environment_reaches_the_app" {
  command = plan
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["MEATGEEK_ENVIRONMENT"] == var.environment
    error_message = "MEATGEEK_ENVIRONMENT must be in the site's app settings, set from var.environment (HAR-17)"
  }
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["MEATGEEK_ENVIRONMENT"] == "dev"
    error_message = "With environment = \"dev\" the app must see MEATGEEK_ENVIRONMENT = \"dev\""
  }
}

run "meatgeek_environment_follows_prod" {
  command = plan
  variables {
    environment = "prod"
  }
  assert {
    condition     = { for s in azapi_resource.function_app.body.properties.siteConfig.appSettings : s.name => s.value }["MEATGEEK_ENVIRONMENT"] == "prod"
    error_message = "With environment = \"prod\" the app must see MEATGEEK_ENVIRONMENT = \"prod\""
  }
}

# Only dev and prod are environments; anything else is refused at plan time
# rather than published to the app as a label nobody expects.
run "unknown_environment_is_refused" {
  command = plan
  variables {
    environment = "staging"
  }
  expect_failures = [
    var.environment,
  ]
}
