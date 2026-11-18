# Azure Functions Module Outputs

output "function_app_id" {
  description = "ID of the Azure Function App"
  value       = azapi_resource.function_app.id
}

output "function_app_name" {
  description = "Name of the Azure Function App"
  value       = azapi_resource.function_app.name
}

output "function_app_url" {
  description = "URL of the Azure Function App"
  value       = "https://${azapi_resource.function_app.output.properties.defaultHostName}"
}

output "hostname" {
  description = "Default hostname of the Function App"
  value       = azapi_resource.function_app.output.properties.defaultHostName
}

output "storage_account_name" {
  description = "Name of the storage account (created via azapi over the ARM control plane)."
  value       = azapi_resource.functions_storage.name
}

output "deployment_container_name" {
  description = "Name of the Flex Consumption deployment-package blob container (target of `func publish`/OneDeploy). function_app_name remains the deploy source of truth; this is informational for the runbook."
  value       = local.deployment_container_name
}

# NOTE: the former `storage_connection_string` output was REMOVED (MG-24 S1).
# Storage is identity-based (Flex MI blob deployment; shared_access_key_enabled=
# false); no account key / connection string is generated or surfaced, so none
# can leak via state.

output "identity_principal_id" {
  description = "Principal ID of the Function App system-assigned managed identity (consumed by the root module to grant Cosmos / Event Hub / SignalR data-plane roles)."
  value       = azapi_resource.function_app.identity[0].principal_id
}

# HAR-15 migration support. The root module adopts an EXISTING site (one the
# former azurerm Flex resource created) with Terraform `import` blocks, which
# need the ARM ids at plan time. These are derived from the module's inputs, not
# read from the resources, so they are known before the site is read and the
# import does not depend on the resource it imports. They carry the api-version
# the resources use so the imported state matches the configured type.
output "function_app_import_ids" {
  description = "ARM ids (with ?api-version) of the Function App site and its config/authsettingsV2, derived from module inputs. Used only by the root module's import blocks that adopt a site the azurerm Flex resource created (HAR-15)."
  value = {
    site = "${local.function_app_resource_id}?api-version=${local.web_api_version}"
    auth = "${local.function_app_resource_id}/config/authsettingsV2?api-version=${local.web_api_version}"
  }
}
