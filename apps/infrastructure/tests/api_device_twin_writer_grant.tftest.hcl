# Plan-level test for the HAR-56 API device-twin writer grant (goal HAR-55).
#
# Runs the ROOT module with MOCKED providers: no live Azure, no credentials, no
# apply (static check 15). It pins the switch on
# azurerm_role_assignment.functions_iothub_twin_contributor:
#
#   - OFF when api_device_twin_writer_enabled is unset (the shipped state: neither
#     tfvars sets it, so merging the grant adds no role assignment live);
#   - OFF when it is explicitly false;
#   - ON (exactly one) when it is true, and then it is `IoT Hub Twin
#     Contributor`, scoped to the IoT Hub ALONE (not the RG), granted to the
#     Function App identity as a ServicePrincipal.
#
# module.iot_hub is overridden so its iot_hub_id is a KNOWN value at plan time;
# a mocked computed id is unknown under `command = plan`, and an assertion on an
# unknown value cannot pass. The override pins the value the scope must equal.
# The Function App principal is computed by the mocked provider and so unknown at
# plan time; the principal reference is plain in main.tf and is not asserted here.
#
# Run:  terraform -chdir=apps/infrastructure test
# (init with `terraform init -backend=false` first).

mock_provider "azurerm" {}
mock_provider "azapi" {}
mock_provider "time" {}

override_module {
  target = module.iot_hub
  outputs = {
    iot_hub_id                                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Devices/IotHubs/meatgeek-v2-dev-iothub"
    iot_hub_name                              = "meatgeek-v2-dev-iothub"
    hostname                                  = "meatgeek-v2-dev-iothub.azure-devices.net"
    identity_principal_id                     = "33333333-3333-3333-3333-333333333333"
    eventhub_namespace_id                     = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.EventHub/namespaces/meatgeek-v2-dev-ehns"
    eventhub_namespace_fqdn                   = "meatgeek-v2-dev-ehns.servicebus.windows.net"
    temperature_broadcast_consumer_group_name = "api-broadcast"
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

run "grant_off_by_default" {
  command = plan

  assert {
    condition     = var.api_device_twin_writer_enabled == false
    error_message = "api_device_twin_writer_enabled must default to false"
  }

  assert {
    condition     = length(azurerm_role_assignment.functions_iothub_twin_contributor) == 0
    error_message = "the IoT Hub Twin Contributor grant must be OFF when api_device_twin_writer_enabled is unset"
  }
}

run "grant_off_when_disabled" {
  command = plan

  variables {
    api_device_twin_writer_enabled = false
  }

  assert {
    condition     = length(azurerm_role_assignment.functions_iothub_twin_contributor) == 0
    error_message = "the IoT Hub Twin Contributor grant must be OFF when api_device_twin_writer_enabled is false"
  }
}

run "grant_on_when_enabled" {
  command = plan

  variables {
    api_device_twin_writer_enabled = true
  }

  assert {
    condition     = length(azurerm_role_assignment.functions_iothub_twin_contributor) == 1
    error_message = "exactly one IoT Hub Twin Contributor grant when api_device_twin_writer_enabled is true"
  }

  assert {
    condition     = azurerm_role_assignment.functions_iothub_twin_contributor[0].role_definition_name == "IoT Hub Twin Contributor"
    error_message = "the grant must be IoT Hub Twin Contributor"
  }

  assert {
    condition     = azurerm_role_assignment.functions_iothub_twin_contributor[0].scope == module.iot_hub.iot_hub_id
    error_message = "the grant must be scoped to the IoT Hub alone, not the resource group"
  }

  assert {
    condition     = azurerm_role_assignment.functions_iothub_twin_contributor[0].principal_type == "ServicePrincipal"
    error_message = "the grant's principal_type must be ServicePrincipal"
  }
}
