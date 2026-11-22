# Plan-level test for the IoT Hub Device Provisioning Service module (HAR-131).
#
# Runs the module with a MOCKED azapi provider: no live Azure, no credentials, no
# apply (static check 15). It pins:
#
#   - the DPS: S1, capacity 1, Hashed allocation, public network access on,
#     system-assigned identity, the naming convention;
#   - the linked hub: exactly one, identity-based (authenticationType
#     SystemAssigned), named by host name, and carrying NO connection string or
#     key of any kind;
#   - the ordering: the linked hub waits on the role-assignment handle, and the
#     handle carries the role assignment id the root passes in.
#
# The root wiring (the flags, the two role assignments, the outputs) is pinned by
# apps/infrastructure/tests/dps.tftest.hcl.
#
# Run:  terraform -chdir=apps/infrastructure/modules/dps test
# (init with `terraform init -backend=false` first).

mock_provider "azapi" {}

variables {
  resource_prefix                 = "meatgeek-v2-dev"
  global_suffix                   = "0123456789ab"
  resource_group_id               = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg"
  location                        = "westus2"
  iot_hub_hostname                = "meatgeek-v2-dev-iothub-0123456789ab.azure-devices.net"
  hub_registry_role_assignment_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Devices/IotHubs/meatgeek-v2-dev-iothub-0123456789ab/providers/Microsoft.Authorization/roleAssignments/44444444-4444-4444-4444-444444444444"
  tags = {
    Project = "MeatGeek V2"
  }
}

run "dps_shape" {
  command = plan

  assert {
    condition     = azapi_resource.dps.type == "Microsoft.Devices/provisioningServices@2026-11-01"
    error_message = "the DPS must use api-version 2026-11-01, the first version with identity-based hub links"
  }

  assert {
    condition     = azapi_resource.dps.name == "meatgeek-v2-dev-dps-0123456789ab"
    error_message = "the DPS must be named <resource_prefix>-dps-<global_suffix>"
  }

  assert {
    condition     = azapi_resource.dps.parent_id == var.resource_group_id && azapi_resource.dps.location == var.location
    error_message = "the DPS must live in the hub's resource group and location"
  }

  assert {
    condition     = azapi_resource.dps.tags == var.tags
    error_message = "the DPS must carry the tags passed in (the hub's)"
  }

  assert {
    condition     = azapi_resource.dps.body.sku.name == "S1" && azapi_resource.dps.body.sku.capacity == 1
    error_message = "the DPS must be SKU S1, capacity 1"
  }

  assert {
    condition     = azapi_resource.dps.body.properties.allocationPolicy == "Hashed"
    error_message = "the DPS allocation policy must be Hashed"
  }

  assert {
    condition     = azapi_resource.dps.body.properties.publicNetworkAccess == "Enabled"
    error_message = "the DPS must allow public network access (the Pi is on a home network)"
  }

  assert {
    condition     = azapi_resource.dps.identity[0].type == "SystemAssigned"
    error_message = "the DPS must have a system-assigned managed identity"
  }

  assert {
    condition     = length(azapi_resource.dps.identity[0].identity_ids) == 0
    error_message = "the DPS identity must declare identity_ids = [] so principal_id stays known on later plans (HAR-16)"
  }

  assert {
    condition     = !can(azapi_resource.dps.body.properties.iotHubs)
    error_message = "the DPS resource itself must not carry iotHubs: the link waits for the identity's role (azapi_update_resource.linked_hub)"
  }
}

run "linked_hub_is_identity_based_and_keyless" {
  command = plan

  assert {
    condition     = azapi_update_resource.linked_hub.type == azapi_resource.dps.type
    error_message = "the linked hub must be written with the same api-version as the DPS"
  }

  assert {
    condition     = length(azapi_update_resource.linked_hub.body.properties.iotHubs) == 1
    error_message = "exactly one linked hub"
  }

  assert {
    condition     = azapi_update_resource.linked_hub.body.properties.iotHubs[0].authenticationType == "SystemAssigned"
    error_message = "the linked hub must authenticate with the DPS's system-assigned identity"
  }

  assert {
    condition     = azapi_update_resource.linked_hub.body.properties.iotHubs[0].hostName == var.iot_hub_hostname
    error_message = "the linked hub must be the hub passed in, named by host name"
  }

  assert {
    condition     = azapi_update_resource.linked_hub.body.properties.iotHubs[0].location == var.location
    error_message = "the linked hub's location must be the hub's region"
  }

  assert {
    condition     = output.linked_iot_hub_hostname == var.iot_hub_hostname
    error_message = "output linked_iot_hub_hostname must be the linked hub's host name"
  }

  # The keyless property, asserted on the planned body: no connection string and
  # no key-bearing field on the link, and no key-based authentication type.
  assert {
    condition = alltrue([
      for hub in azapi_update_resource.linked_hub.body.properties.iotHubs :
      !can(hub.connectionString) && !can(hub.sharedAccessKey) && !can(hub.primaryKey) && hub.authenticationType != "KeyBased"
    ])
    error_message = "the linked hub must carry no connection string or key and must not be KeyBased"
  }

  assert {
    condition     = !can(azapi_update_resource.linked_hub.sensitive_body.properties)
    error_message = "the linked hub must not send anything through sensitive_body (that is where a key would hide)"
  }

  # The update restates the DPS's own settings, so a change to any of them also
  # re-asserts the link in the same apply (see the comment in main.tf).
  assert {
    condition = (
      azapi_update_resource.linked_hub.body.sku == azapi_resource.dps.body.sku &&
      azapi_update_resource.linked_hub.body.properties.allocationPolicy == azapi_resource.dps.body.properties.allocationPolicy &&
      azapi_update_resource.linked_hub.body.properties.publicNetworkAccess == azapi_resource.dps.body.properties.publicNetworkAccess &&
      azapi_update_resource.linked_hub.body.tags == var.tags
    )
    error_message = "the linked hub update must restate the DPS's sku, properties and tags"
  }
}

run "linked_hub_waits_on_role_handle" {
  command = plan

  assert {
    condition     = terraform_data.hub_registry_role_ready.input == var.hub_registry_role_assignment_id
    error_message = "the role handle must carry the role assignment id the root passes in"
  }
}

run "rejects_connection_string_as_hub_hostname" {
  command = plan

  variables {
    iot_hub_hostname = "HostName=meatgeek-v2-dev-iothub.azure-devices.net;SharedAccessKeyName=iothubowner;SharedAccessKey=AAAA"
  }

  expect_failures = [var.iot_hub_hostname]
}
