# IoT Hub Device Provisioning Service module for MeatGeek V2 (HAR-131, goal HAR-130).
#
# Devices get their IoT Hub identity from this DPS, using an X.509 certificate
# generated on the device, so nobody copies a device key. This module creates the
# DPS and links it to the IoT Hub. Nothing uses it yet: enrollments, device code
# and the CI enroller grant come later.
#
# WHY AZAPI AND NOT azurerm_iothub_dps. In azurerm 4.x that resource has no
# `identity` block, and its `linked_hub` block REQUIRES `connection_string`: the
# only link it can express is a hub shared-access-policy key, which would land in
# Terraform state as a live credential. The link here is IDENTITY-BASED instead:
# the DPS authenticates to the hub with its own system-assigned managed identity
# (ARM properties.iotHubs[].authenticationType = "SystemAssigned"), and the hub
# is named by hostName alone. No connection string, shared access policy key or
# hub key is passed to the DPS. tf-static-checks.sh check 21 fails the build if
# one appears in this module, and tests/dps.tftest.hcl asserts the planned body
# carries none.
#
# API VERSION. Identity-based linking (authenticationType, and hostName in place
# of connectionString) exists only from api-version 2026-11-01. Every earlier
# version, 2025-02-01-preview included, REQUIRES connectionString on a linked hub.
# 2026-11-01 is registered for Microsoft.Devices/ProvisioningServices in this
# subscription and offered in West US 2 (read with azread on 2026-11-22).
#
# schema_validation_enabled = false, ON THESE TWO RESOURCES ONLY. azapi checks a
# body against a schema embedded in the provider binary, and the pinned azapi
# (2.11.0, see .terraform.lock.hcl) was built before 2026-11-01 existed, so it
# rejects the api-version outright. The alternative was bumping azapi for the
# whole stack, which also manages the live Function App site; that is a
# dependency change this module does not need. ARM still validates the body
# server-side on every PUT. When azapi is next bumped (2.14.0 knows this
# version), delete both flags.

terraform {
  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }
}

locals {
  dps_type = "Microsoft.Devices/provisioningServices@2026-11-01"

  # The DPS's own settings. Declared once and sent by BOTH resources below; see
  # azapi_update_resource.linked_hub for why the second one restates them.
  dps_sku = {
    name     = "S1"
    capacity = 1
  }
  dps_properties = {
    allocationPolicy = "Hashed"
    # The Pi provisions from a home network, so the global endpoint must be
    # reachable from the internet. Devices still need an enrollment and a
    # certificate the DPS trusts; there are none yet.
    publicNetworkAccess = "Enabled"
  }

  # The ONE linked hub, identity-based. hostName names the hub; there is no
  # connectionString. The DPS identity's IoT Hub Registry Contributor grant on
  # the hub (root main.tf, azurerm_role_assignment.dps_hub_registry_contributor)
  # is what lets it create device identities there.
  linked_hubs = [
    {
      authenticationType    = "SystemAssigned"
      hostName              = var.iot_hub_hostname
      location              = var.location
      applyAllocationPolicy = true
      allocationWeight      = 1
    },
  ]
}

resource "azapi_resource" "dps" {
  type      = local.dps_type
  name      = "${var.resource_prefix}-dps-${var.global_suffix}"
  parent_id = var.resource_group_id
  location  = var.location
  tags      = var.tags

  ignore_casing             = true
  schema_validation_enabled = false

  identity {
    type = "SystemAssigned"
    # Same reason as the Function App site (modules/functions/main.tf, HAR-16):
    # azapi copies principal_id from state into the plan only when the planned
    # identity_ids equals the state's, and state holds []. Omitting it plans
    # null, principal_id goes unknown, and the role assignment that reads it is
    # planned for REPLACEMENT on every later plan.
    identity_ids = []
  }

  # NO iotHubs here, deliberately. The link authenticates with THIS resource's
  # identity, so it can only be made after that identity holds its role on the
  # hub, and the role needs this resource's principal id first. The link is
  # therefore a second step: azapi_update_resource.linked_hub below.
  body = {
    sku        = local.dps_sku
    properties = local.dps_properties
  }

  response_export_values = [
    "properties.idScope",
    "properties.deviceProvisioningHostName",
  ]
}

# Dependency handle for the DPS identity's role on the hub. Same pattern as
# terraform_data.cosmos_role_ready in modules/iot-hub/main.tf: the role
# assignment lives in the root and reads this module's identity_principal_id
# output, so the root passes its id back in, and only the linked hub (never the
# DPS itself) sits downstream of it. That keeps the graph acyclic.
resource "terraform_data" "hub_registry_role_ready" {
  input = var.hub_registry_role_assignment_id
}

# The linked hub. azapi_update_resource reads the DPS, merges this body into it
# and PUTs the result, so it adds iotHubs without dropping anything else.
#
# WHY IT ALSO RESTATES THE SKU, PROPERTIES AND TAGS. A change to any of those
# makes azapi_resource.dps PUT its own body, which has no iotHubs, and an ARM
# PUT is a full replace, so it can drop the link. Carrying the same values here means the
# same change also plans an IN-PLACE update of this resource, which runs after
# the DPS update (it reads azapi_resource.dps.id) and puts the link back in the
# same apply. Coupling them with replace_triggered_by instead would plan a
# replace, which tf-plan-destroy-guard.sh counts as a protected delete and
# refuses on every routine tag edit.
resource "azapi_update_resource" "linked_hub" {
  type        = local.dps_type
  resource_id = azapi_resource.dps.id

  ignore_casing = true

  body = {
    sku        = local.dps_sku
    tags       = var.tags
    properties = merge(local.dps_properties, { iotHubs = local.linked_hubs })
  }

  depends_on = [terraform_data.hub_registry_role_ready]
}
