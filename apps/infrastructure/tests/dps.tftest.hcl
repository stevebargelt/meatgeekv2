# Plan-level test for the HAR-131 IoT Hub Device Provisioning Service wiring
# (goal HAR-130).
#
# Runs the ROOT module with MOCKED providers: no live Azure, no credentials, no
# apply (static check 15). It pins the two switches:
#
#   - var.dps_enabled: OFF (the default, and prod) plans no DPS, no linked hub
#     and no role assignment. ON plans the module, and the DPS identity's
#     `IoT Hub Registry Contributor` grant scoped to the IoT Hub ALONE, as a
#     ServicePrincipal, and the module links the hub the root passes in.
#   - var.dps_ci_enroller_enabled: azurerm_role_assignment.dps_ci_enroller is 0
#     unless it is true AND dps_enabled AND the app-deploy principal is set; when
#     on it is `Device Provisioning Service Data Contributor` scoped to the DPS,
#     as a ServicePrincipal.
#
# The DPS resource and its linked hub themselves (S1, Hashed, system identity,
# identity-based keyless link) are pinned by modules/dps/tests/dps.tftest.hcl;
# a root test cannot address resources inside a child module.
#
# module.iot_hub is overridden so its ids are KNOWN at plan time; a mocked
# computed id is unknown under `command = plan`, and an assertion on an unknown
# value cannot pass. module.dps is overridden the same way in the runs that
# assert on its id and principal.
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
    targets_consumer_group_name               = "api-targets"
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
  app_deploy_principal_object_id   = "22222222-2222-2222-2222-222222222222"
}

run "dps_off_by_default" {
  command = plan

  assert {
    condition     = length(module.dps) == 0
    error_message = "with dps_enabled unset no DPS (and so no linked hub) may be planned"
  }

  assert {
    condition     = length(azurerm_role_assignment.dps_hub_registry_contributor) == 0
    error_message = "with dps_enabled unset the DPS identity's IoT Hub Registry Contributor grant must not be planned"
  }

  assert {
    condition     = length(azurerm_role_assignment.dps_ci_enroller) == 0
    error_message = "with dps_enabled unset the CI enroller grant must not be planned"
  }

  assert {
    condition     = output.dps_name == "" && output.dps_id_scope == "" && output.dps_global_endpoint == ""
    error_message = "the DPS outputs must be empty when dps_enabled is false"
  }
}

run "ci_enroller_on_without_dps_plans_nothing" {
  command = plan

  variables {
    dps_enabled             = false
    dps_ci_enroller_enabled = true
  }

  assert {
    condition     = length(module.dps) == 0 && length(azurerm_role_assignment.dps_ci_enroller) == 0
    error_message = "dps_ci_enroller_enabled alone must not plan a DPS or a grant"
  }
}

# Not overridden here, so the module's own wiring is planned: the linked hub's
# host name is the IoT Hub's, as the root passes it in.
run "dps_on_links_the_hub" {
  command = plan

  variables {
    dps_enabled = true
  }

  assert {
    condition     = length(module.dps) == 1
    error_message = "with dps_enabled = true exactly one DPS module instance must be planned"
  }

  assert {
    condition     = module.dps[0].linked_iot_hub_hostname == module.iot_hub.hostname
    error_message = "the DPS must link the stack's IoT Hub"
  }
}

run "dps_on_grants_registry_contributor_on_the_hub" {
  command = plan

  variables {
    dps_enabled = true
  }

  override_module {
    target = module.dps
    outputs = {
      dps_id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Devices/provisioningServices/meatgeek-v2-dev-dps"
      dps_name                = "meatgeek-v2-dev-dps"
      dps_id_scope            = "0ne00000000"
      dps_global_endpoint     = "global.azure-devices-provisioning.net"
      linked_iot_hub_hostname = "meatgeek-v2-dev-iothub.azure-devices.net"
      identity_principal_id   = "55555555-5555-5555-5555-555555555555"
    }
  }

  assert {
    condition     = length(azurerm_role_assignment.dps_hub_registry_contributor) == 1
    error_message = "exactly one IoT Hub Registry Contributor grant for the DPS identity"
  }

  assert {
    condition     = azurerm_role_assignment.dps_hub_registry_contributor[0].role_definition_name == "IoT Hub Registry Contributor"
    error_message = "the DPS identity's grant must be IoT Hub Registry Contributor"
  }

  assert {
    condition     = azurerm_role_assignment.dps_hub_registry_contributor[0].scope == module.iot_hub.iot_hub_id
    error_message = "the DPS identity's grant must be scoped to the IoT Hub alone, not the resource group"
  }

  assert {
    condition     = azurerm_role_assignment.dps_hub_registry_contributor[0].principal_id == module.dps[0].identity_principal_id
    error_message = "the grant must go to the DPS's system-assigned identity"
  }

  assert {
    condition     = azurerm_role_assignment.dps_hub_registry_contributor[0].principal_type == "ServicePrincipal"
    error_message = "the grant's principal_type must be ServicePrincipal"
  }

  assert {
    condition     = length(azurerm_role_assignment.dps_ci_enroller) == 0
    error_message = "the CI enroller grant must stay off unless dps_ci_enroller_enabled is true"
  }

  assert {
    condition     = output.dps_name == "meatgeek-v2-dev-dps"
    error_message = "output dps_name must carry the module's value"
  }

  assert {
    condition     = output.dps_id_scope == "0ne00000000"
    error_message = "output dps_id_scope must carry the module's value"
  }

  assert {
    condition     = output.dps_global_endpoint == "global.azure-devices-provisioning.net"
    error_message = "output dps_global_endpoint must carry the module's value"
  }
}

run "ci_enroller_off_when_app_deploy_principal_empty" {
  command = plan

  variables {
    dps_enabled                    = true
    dps_ci_enroller_enabled        = true
    app_deploy_principal_object_id = ""
  }

  assert {
    condition     = length(azurerm_role_assignment.dps_ci_enroller) == 0
    error_message = "the CI enroller grant must be OFF when app_deploy_principal_object_id is empty"
  }
}

run "ci_enroller_on_when_all_three_set" {
  command = plan

  variables {
    dps_enabled             = true
    dps_ci_enroller_enabled = true
  }

  override_module {
    target = module.dps
    outputs = {
      dps_id                  = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Devices/provisioningServices/meatgeek-v2-dev-dps"
      dps_name                = "meatgeek-v2-dev-dps"
      dps_id_scope            = "0ne00000000"
      dps_global_endpoint     = "global.azure-devices-provisioning.net"
      linked_iot_hub_hostname = "meatgeek-v2-dev-iothub.azure-devices.net"
      identity_principal_id   = "55555555-5555-5555-5555-555555555555"
    }
  }

  assert {
    condition     = length(azurerm_role_assignment.dps_ci_enroller) == 1
    error_message = "exactly one CI enroller grant when dps_enabled, dps_ci_enroller_enabled and the app-deploy principal are all set"
  }

  assert {
    condition     = azurerm_role_assignment.dps_ci_enroller[0].role_definition_name == "Device Provisioning Service Data Contributor"
    error_message = "the CI enroller grant must be Device Provisioning Service Data Contributor"
  }

  assert {
    condition     = azurerm_role_assignment.dps_ci_enroller[0].scope == module.dps[0].dps_id
    error_message = "the CI enroller grant must be scoped to the DPS alone"
  }

  assert {
    condition     = azurerm_role_assignment.dps_ci_enroller[0].principal_id == var.app_deploy_principal_object_id
    error_message = "the CI enroller grant must go to the app-deploy principal"
  }

  assert {
    condition     = azurerm_role_assignment.dps_ci_enroller[0].principal_type == "ServicePrincipal"
    error_message = "the CI enroller grant's principal_type must be ServicePrincipal"
  }
}
