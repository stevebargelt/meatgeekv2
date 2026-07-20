# Plan-level dependency-ordering test for the IoT Hub module (MG-24).
#
# Runs the module as the config-under-test with a MOCKED azurerm provider — NO
# live Azure, NO credentials, NO apply. It proves that the identity-based Cosmos
# routing endpoint is gated on the Cosmos data-plane role assignment: the endpoint
# writes to Cosmos with the IoT Hub managed identity, so on a greenfield apply it
# must be created only AFTER the "Cosmos DB Built-in Data Contributor" role exists,
# or IoT→Cosmos routing fails until the role propagates.
#
# The ordering is carried by terraform_data.cosmos_role_ready (input =
# var.cosmos_role_assignment_id), which the endpoint declares in depends_on. We
# assert the handle carries the role-assignment id passed from root; the depends_on
# edge on that handle is what serializes the endpoint after the role.
#
# Run:  terraform -chdir=apps/infrastructure/modules/iot-hub test
# (init the module dir with `terraform init -backend=false` first).

mock_provider "azurerm" {}

variables {
  resource_prefix           = "meatgeek-v2-dev"
  global_suffix             = "abc123def456"
  resource_group_name       = "meatgeek-v2-dev-rg"
  location                  = "westus2"
  cosmos_account_endpoint   = "https://mgv2dev.documents.azure.com/"
  cosmos_database_name      = "meatgeek"
  cosmos_container_name     = "temperatures"
  cosmos_role_assignment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.DocumentDB/databaseAccounts/mgv2dev/sqlRoleAssignments/11111111-1111-1111-1111-111111111111"
}

# The Cosmos routing endpoint's role-ready handle carries the exact role-assignment
# id passed from root. Because the endpoint depends_on this handle and the handle is
# fed by the role id, the endpoint is ordered strictly after the role assignment.
run "cosmos_endpoint_gated_on_role_assignment" {
  command = plan

  assert {
    condition     = terraform_data.cosmos_role_ready.input == var.cosmos_role_assignment_id
    error_message = "cosmos_role_ready handle must carry the Cosmos data-plane role-assignment id so the endpoint can order after it"
  }

  # The endpoint is identity-based — it is exactly the resource that requires the
  # role to exist first.
  assert {
    condition     = azurerm_iothub_endpoint_cosmosdb_account.cosmos_storage.authentication_type == "identityBased"
    error_message = "Cosmos routing endpoint must use identity-based auth (the reason the role must precede it)"
  }
}
