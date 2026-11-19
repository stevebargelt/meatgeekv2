# Plan-level test for the HAR-41 simulated-device registry grant (goal HAR-39).
#
# Runs the ROOT module with MOCKED providers: no live Azure, no credentials, no
# apply (static check 15). It pins the switch on
# azurerm_role_assignment.simulated_device_registry_contributor:
#
#   - OFF when simulated_device_id is empty (the shipped state: neither tfvars
#     sets it, so merging the grant changes nothing live);
#   - OFF when app_deploy_principal_object_id is empty;
#   - ON (exactly one) only when both are set, and then it is
#     `IoT Hub Registry Contributor`, scoped to the IoT Hub ALONE (not the RG),
#     granted to the app-deploy principal as a ServicePrincipal.
#
# module.iot_hub is overridden so its iot_hub_id is a KNOWN value at plan time;
# a mocked computed id is unknown under `command = plan`, and an assertion on an
# unknown value cannot pass. The override pins the value the scope must equal.
#
# Run:  terraform -chdir=apps/infrastructure test
# (init with `terraform init -backend=false` first).

mock_provider "azurerm" {}
mock_provider "azapi" {}
mock_provider "time" {}

override_module {
  target = module.iot_hub
  outputs = {
    iot_hub_id              = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Devices/IotHubs/meatgeek-v2-dev-iothub"
    iot_hub_name            = "meatgeek-v2-dev-iothub"
    hostname                = "meatgeek-v2-dev-iothub.azure-devices.net"
    identity_principal_id   = "33333333-3333-3333-3333-333333333333"
    eventhub_namespace_id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.EventHub/namespaces/meatgeek-v2-dev-ehns"
    eventhub_namespace_fqdn = "meatgeek-v2-dev-ehns.servicebus.windows.net"
  }
}

# Placeholder ids only (all-zero / repeated-digit GUIDs), never the real dev
# coordinates. The functions_auth_* values are here because modules/functions
# refuses, by precondition, to plan a Function App without Easy Auth; they are
# not what this test is about.
variables {
  environment                      = "dev"
  functions_auth_client_id         = "11111111-1111-1111-1111-111111111111"
  functions_auth_tenant_id         = "00000000-0000-0000-0000-000000000000"
  functions_auth_allowed_audiences = ["api://11111111-1111-1111-1111-111111111111"]
}

run "grant_off_when_simulated_device_id_empty" {
  command = plan

  variables {
    simulated_device_id            = ""
    app_deploy_principal_object_id = "22222222-2222-2222-2222-222222222222"
  }

  assert {
    condition     = length(azurerm_role_assignment.simulated_device_registry_contributor) == 0
    error_message = "the IoT Hub Registry Contributor grant must be OFF when simulated_device_id is empty"
  }

  assert {
    condition     = output.simulated_device_id == ""
    error_message = "output simulated_device_id must be empty when the variable is unset"
  }
}

run "grant_off_when_app_deploy_principal_empty" {
  command = plan

  variables {
    simulated_device_id            = "meatgeek-sim-01"
    app_deploy_principal_object_id = ""
  }

  assert {
    condition     = length(azurerm_role_assignment.simulated_device_registry_contributor) == 0
    error_message = "the IoT Hub Registry Contributor grant must be OFF when app_deploy_principal_object_id is empty"
  }
}

run "grant_on_when_both_set" {
  command = plan

  variables {
    simulated_device_id            = "meatgeek-sim-01"
    app_deploy_principal_object_id = "22222222-2222-2222-2222-222222222222"
  }

  assert {
    condition     = length(azurerm_role_assignment.simulated_device_registry_contributor) == 1
    error_message = "exactly one IoT Hub Registry Contributor grant when both simulated_device_id and app_deploy_principal_object_id are set"
  }

  assert {
    condition     = azurerm_role_assignment.simulated_device_registry_contributor[0].role_definition_name == "IoT Hub Registry Contributor"
    error_message = "the grant must be IoT Hub Registry Contributor"
  }

  assert {
    condition     = azurerm_role_assignment.simulated_device_registry_contributor[0].scope == module.iot_hub.iot_hub_id
    error_message = "the grant must be scoped to the IoT Hub alone, not the resource group"
  }

  assert {
    condition     = azurerm_role_assignment.simulated_device_registry_contributor[0].principal_id == var.app_deploy_principal_object_id
    error_message = "the grant must go to the app-deploy principal"
  }

  assert {
    condition     = azurerm_role_assignment.simulated_device_registry_contributor[0].principal_type == "ServicePrincipal"
    error_message = "the grant's principal_type must be ServicePrincipal"
  }

  assert {
    condition     = output.simulated_device_id == "meatgeek-sim-01"
    error_message = "output simulated_device_id must carry the variable's value"
  }
}

run "rejects_device_id_outside_api_rule" {
  command = plan

  variables {
    simulated_device_id = "bad device/id"
  }

  expect_failures = [var.simulated_device_id]
}
