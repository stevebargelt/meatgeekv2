# Plan-level Flex Consumption HOSTING-BEHAVIOR tests for the Functions module
# (MG-24 verify phase — test-engineer).
#
# security_posture.tftest.hcl next door proves the S1/S2 SECURITY invariants
# (secrets-out-of-state, Easy-Auth fail-closed, global uniqueness). THIS file
# proves the operator-facing HOSTING behaviour the MG-24 Flex revision introduced
# and that a future edit could silently regress:
#
#   * dev SCALE-TO-ZERO  — always_ready = 0 renders NO always_ready block, so the
#     app bills ~$0 idle (the $50-RG-budget promise).
#   * prod ALWAYS-READY  — always_ready >= 1 renders exactly one warm "http" group
#     at the requested instance_count (no cold starts on prod traffic).
#   * the per-instance scale knobs (instance_memory_in_mb / maximum_instance_count)
#     flow from the tfvars var straight onto the flex resource.
#   * Flex-deprecated app settings (WEBSITE_NODE_DEFAULT_VERSION / WEBSITE_CONTENT* /
#     WEBSITE_TIME_ZONE / WEBSITE_RUN_FROM_PACKAGE) are PRUNED — Flex manages the
#     runtime + package mount itself and rejects/ignores them.
#   * the count/var-guarded app-deploy-principal grant materialises a Storage Blob
#     Data Contributor role-assignment ONLY when the object id is supplied.
#   * the Flex scale-knob variable validations reject out-of-range input at plan
#     time (fail-closed on a mis-tuned plan rather than a bad apply).
#
# Runs with MOCKED providers — NO live Azure, NO credentials, NO apply.
# Run:  terraform -chdir=apps/infrastructure/modules/functions test
# (init the module dir with `terraform init -backend=false` first).

mock_provider "azurerm" {}
mock_provider "azapi" {}

# Base = the CONFIGURED (real dev/prod) path: a non-empty API registration client
# id, explicit CORS, Node-24-shaped inputs. Individual runs override only the knob
# under test so each behaviour is exercised in isolation.
variables {
  resource_prefix                        = "meatgeek-v2-dev"
  global_suffix                          = "abc123def456"
  resource_group_name                    = "meatgeek-v2-dev-rg"
  resource_group_id                      = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg"
  location                               = "westus2"
  storage_account_name                   = "mgv2devabc123def456"
  application_insights_connection_string = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://westus2.in.applicationinsights.azure.com/"
  cosmos_account_endpoint                = "https://mgv2dev.documents.azure.com/"
  eventhub_namespace_fqdn                = "meatgeek-v2-dev-eventhub-ns-abc123def456.servicebus.windows.net"
  signalr_service_uri                    = "https://meatgeek-v2-dev-signalr-abc123def456.service.signalr.net"
  cors_allowed_origins                   = ["http://localhost:4200"]
  auth_active_directory_client_id        = "11111111-1111-1111-1111-111111111111"
  auth_active_directory_tenant_id        = "22222222-2222-2222-2222-222222222222"
  auth_allowed_audiences                 = ["api://meatgeek-v2-dev-api"]
  auth_allowed_client_app_ids            = ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"]
}

# --- dev SCALE-TO-ZERO -------------------------------------------------------
# always_ready = 0 (dev.tfvars) must render NO always_ready block. The dynamic
# block is gated `for_each = var.always_ready > 0 ? [1] : []`, so at 0 the app
# has zero pre-warmed instances and bills ~$0 idle. This is the exact "dev scale
# to zero" acceptance — a regression (e.g. always keeping a warm block) would
# silently start billing.
run "dev_always_ready_zero_scales_to_zero" {
  command = plan
  variables {
    always_ready           = 0
    instance_memory_in_mb  = 2048
    maximum_instance_count = 40
  }
  assert {
    condition     = length(azurerm_function_app_flex_consumption.main.always_ready) == 0
    error_message = "dev (always_ready=0) must render NO always_ready block — scale-to-zero, ~$0 idle"
  }
  # The scale knobs still flow onto the resource even with no warm instances.
  assert {
    condition     = azurerm_function_app_flex_consumption.main.instance_memory_in_mb == 2048
    error_message = "instance_memory_in_mb must flow from the tfvars var onto the flex resource"
  }
  assert {
    condition     = azurerm_function_app_flex_consumption.main.maximum_instance_count == 40
    error_message = "maximum_instance_count must flow from the tfvars var onto the flex resource"
  }
}

# --- prod ALWAYS-READY -------------------------------------------------------
# always_ready >= 1 (prod.tfvars) must render exactly ONE warm group, named the
# built-in "http" group, at the requested instance_count — a warm HTTP baseline
# so the first post-idle request is not cold.
run "prod_always_ready_warm_baseline" {
  command = plan
  variables {
    always_ready           = 1
    instance_memory_in_mb  = 2048
    maximum_instance_count = 100
  }
  assert {
    condition     = length(azurerm_function_app_flex_consumption.main.always_ready) == 1
    error_message = "prod (always_ready>=1) must render exactly one always_ready block (warm baseline)"
  }
  assert {
    condition     = one(azurerm_function_app_flex_consumption.main.always_ready).name == "http"
    error_message = "the warm group must target the built-in \"http\" group (all HTTP-triggered functions)"
  }
  assert {
    condition     = one(azurerm_function_app_flex_consumption.main.always_ready).instance_count == 1
    error_message = "the warm group instance_count must equal var.always_ready"
  }
  assert {
    condition     = azurerm_function_app_flex_consumption.main.maximum_instance_count == 100
    error_message = "prod maximum_instance_count must flow onto the flex resource"
  }
}

# A higher prod always_ready must scale the warm group, not clamp to 1.
run "prod_always_ready_honours_requested_count" {
  command = plan
  variables {
    always_ready = 3
  }
  assert {
    condition     = one(azurerm_function_app_flex_consumption.main.always_ready).instance_count == 3
    error_message = "always_ready must render the requested warm instance_count verbatim (not clamp to 1)"
  }
}

# --- Flex-FORBIDDEN app settings PRUNED --------------------------------------
# Flex manages the runtime version and the package mount itself; the classic
# Consumption/Elastic app settings are deprecated-or-rejected and must NOT be set.
# Assert the concrete keys named in the brief are absent from app_settings.
#
# FUNCTIONS_WORKER_RUNTIME is the load-bearing one (MG-24 apply defect): a Flex
# site REJECTS it with 400 BadRequest ExtendedCode 51021, failing the create —
# the worker runtime is declared via runtime_name/runtime_version, asserted below.
run "flex_deprecated_app_settings_are_pruned" {
  command = plan
  # The apply-breaking key: FUNCTIONS_WORKER_RUNTIME must NOT be an app setting.
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "FUNCTIONS_WORKER_RUNTIME")
    error_message = "FUNCTIONS_WORKER_RUNTIME is REJECTED on Flex (400 BadRequest 51021) — the runtime is runtime_name/runtime_version, not an app setting"
  }
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "FUNCTIONS_EXTENSION_VERSION")
    error_message = "FUNCTIONS_EXTENSION_VERSION is Flex-managed — must not be in app_settings"
  }
  # No classic host-storage setting (Flex configures host storage itself).
  assert {
    condition     = length([for k in keys(azurerm_function_app_flex_consumption.main.app_settings) : k if startswith(k, "AzureWebJobsStorage")]) == 0
    error_message = "No AzureWebJobsStorage* setting may be present on Flex — host storage is Flex-managed (and would carry a key)"
  }
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "WEBSITE_NODE_DEFAULT_VERSION")
    error_message = "WEBSITE_NODE_DEFAULT_VERSION is Flex-deprecated (Flex sets runtime_version) — must not be in app_settings"
  }
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "WEBSITE_CONTENTAZUREFILECONNECTIONSTRING")
    error_message = "WEBSITE_CONTENTAZUREFILECONNECTIONSTRING is Flex-deprecated (no Azure Files content share) — must not be in app_settings"
  }
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "WEBSITE_CONTENTSHARE")
    error_message = "WEBSITE_CONTENTSHARE is Flex-deprecated (no Azure Files content share) — must not be in app_settings"
  }
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "WEBSITE_RUN_FROM_PACKAGE")
    error_message = "WEBSITE_RUN_FROM_PACKAGE is Flex-deprecated (Flex manages the package mount) — must not be in app_settings"
  }
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "WEBSITE_TIME_ZONE")
    error_message = "WEBSITE_TIME_ZONE is a Flex-deprecated legacy setting — must not be in app_settings"
  }
  # Positive control: the runtime IS declared via the Flex-native field, not a setting.
  assert {
    condition     = azurerm_function_app_flex_consumption.main.runtime_name == "node" && azurerm_function_app_flex_consumption.main.runtime_version == "24"
    error_message = "Flex runtime must be declared node/24 via runtime_name/runtime_version (not a WEBSITE_* app setting)"
  }
  # Positive control: pruning the Flex-FORBIDDEN keys must NOT strip the four
  # identity-based (non-secret endpoint) settings the host needs — an over-eager
  # "prune everything" edit would silently break Cosmos/IoT/SignalR/App Insights
  # wiring. Assert each REMAINS present in app_settings.
  # The AAD App Insights auth setting REMAINS in app_settings. The connection
  # string itself is NOT an app_setting — it is wired via the native
  # site_config.application_insights_connection_string field (second-plan no-op
  # fix), so assert it is present there and absent from app_settings.
  assert {
    condition     = contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "APPLICATIONINSIGHTS_AUTHENTICATION_STRING")
    error_message = "the AAD-identity App Insights auth setting (APPLICATIONINSIGHTS_AUTHENTICATION_STRING) must REMAIN after pruning the Flex-forbidden keys"
  }
  assert {
    condition     = !contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "APPLICATIONINSIGHTS_CONNECTION_STRING")
    error_message = "APPLICATIONINSIGHTS_CONNECTION_STRING must NOT be an app_setting — it is wired via the native site_config field (second-plan no-op fix)"
  }
  assert {
    condition     = azurerm_function_app_flex_consumption.main.site_config[0].application_insights_connection_string == var.application_insights_connection_string
    error_message = "the App Insights connection string must be wired via the native site_config.application_insights_connection_string field"
  }
  assert {
    condition     = contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "COSMOSDB__accountEndpoint")
    error_message = "the identity-based COSMOSDB__accountEndpoint setting must REMAIN after pruning the Flex-forbidden keys"
  }
  assert {
    condition     = contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "IOTHUB_EVENTS__fullyQualifiedNamespace")
    error_message = "the identity-based IOTHUB_EVENTS__fullyQualifiedNamespace setting must REMAIN after pruning the Flex-forbidden keys"
  }
  assert {
    condition     = contains(keys(azurerm_function_app_flex_consumption.main.app_settings), "AzureSignalRConnectionString__serviceUri")
    error_message = "the identity-based AzureSignalRConnectionString__serviceUri setting must REMAIN after pruning the Flex-forbidden keys"
  }
}

# --- app-deploy-principal deployment-container grant (MG-24 item 4) -----------
# When app_deploy_principal_object_id is supplied, the module grants that SEPARATE
# deploy identity Storage Blob Data Contributor on the deployment container alone
# (so `func publish`/OneDeploy can write the package ZIP), targeting exactly that
# principal — least-privilege, scoped to the container, not the whole account.
run "deploy_principal_gets_scoped_blob_write_when_set" {
  command = plan
  variables {
    app_deploy_principal_object_id = "2199ba47-ffae-4cba-86a5-acaa34113d9a"
  }
  assert {
    condition     = length(azurerm_role_assignment.deploy_principal_deployment_container) == 1
    error_message = "a non-empty app_deploy_principal_object_id must materialise the deploy-container role assignment"
  }
  assert {
    condition     = azurerm_role_assignment.deploy_principal_deployment_container[0].role_definition_name == "Storage Blob Data Contributor"
    error_message = "the deploy principal must get Storage Blob Data Contributor (write the package ZIP), not a broader role"
  }
  assert {
    condition     = azurerm_role_assignment.deploy_principal_deployment_container[0].principal_id == "2199ba47-ffae-4cba-86a5-acaa34113d9a"
    error_message = "the grant must target the supplied app-deploy principal object id"
  }
}

# Guard the count/var pattern: an EMPTY object id skips the grant entirely so a
# bare `terraform validate`/plan still works (no dangling principal).
run "deploy_principal_grant_skipped_when_unset" {
  command = plan
  variables {
    app_deploy_principal_object_id = ""
  }
  assert {
    condition     = length(azurerm_role_assignment.deploy_principal_deployment_container) == 0
    error_message = "an empty app_deploy_principal_object_id must skip the deploy-container grant (count-guarded)"
  }
}

# --- Flex scale-knob variable validations (fail-closed on mis-tuning) ---------
# instance_memory_in_mb is restricted to the Flex-supported tiers; a bogus tier
# must be rejected at plan time, not silently applied.
run "rejects_unsupported_instance_memory_tier" {
  command = plan
  variables {
    instance_memory_in_mb = 1024
  }
  expect_failures = [var.instance_memory_in_mb]
}

# maximum_instance_count must be a sane horizontal ceiling (1..1000).
run "rejects_zero_maximum_instance_count" {
  command = plan
  variables {
    maximum_instance_count = 0
  }
  expect_failures = [var.maximum_instance_count]
}

# always_ready must be non-negative (0 = scale-to-zero).
run "rejects_negative_always_ready" {
  command = plan
  variables {
    always_ready = -1
  }
  expect_failures = [var.always_ready]
}
