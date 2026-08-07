# Route/endpoint replacement-pairing test for the IoT Hub module (MG-48).
#
# Runs the module as the config-under-test with a MOCKED azurerm provider — NO
# live Azure, NO credentials, NO apply.
#
# WHAT THIS FILE DOES NOT DO — read before trusting it as the regression guard.
# It does NOT prove that replacing an endpoint plans its route for replacement.
# That property is a state DIFF: a resource can only be "replaced" relative to a
# prior state. A `terraform test` run block with `command = plan` always starts
# from EMPTY state (verified: every plan run reports "0 to destroy"), and static
# check 15 forbids `command = apply` because the PR gate is credentialless. So a
# tftest that satisfies check 15 has no prior state and can never observe a
# replacement. `plan_options { replace = [...] }` does not help either — with
# nothing in state it is a no-op. `replace_triggered_by` is also absent from
# `terraform show -json`, so the plan JSON cannot be inspected for it.
#
# The replacement propagation and its destroy/create ORDER were instead verified
# out-of-band, against a synthetic graph of the identical shape built on the
# builtin terraform_data provider (no credentials, real apply): with the
# lifecycle block the plan is "2 to add, 2 to destroy" and the apply order is
# destroy route -> destroy endpoint -> create endpoint -> create route; with the
# block removed it is "1 to add, 1 to destroy" and the route is left live, which
# is the IH400111 failure. See the MG-48 result notes for both transcripts.
#
# What this file DOES pin is the premise the fix rests on: each route reaches its
# endpoint through an attribute whose value is a STATIC LITERAL, identical before
# and after replacement. That is precisely why the endpoint_names reference below
# propagates ordering but not replacement, and therefore why each route needs the
# `replace_triggered_by` lifecycle block in main.tf. If someone ever makes an
# endpoint name derive from something that changes on replacement, these
# assertions fail and the lifecycle blocks should be revisited.
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

# Each route must name exactly the endpoint it is paired with, and that endpoint
# name must be the fixed literal. The pairing is what each lifecycle block's
# replace_triggered_by has to mirror; the literal is why it is needed at all.
run "routes_reach_their_endpoints_through_a_static_literal_name" {
  command = plan

  assert {
    condition     = azurerm_iothub_endpoint_cosmosdb_account.cosmos_storage.name == "cosmos-storage"
    error_message = "Cosmos endpoint name must be the fixed literal 'cosmos-storage' — a name that CHANGED on replacement would make the route's config change on its own, and the replace_triggered_by block in main.tf would no longer be the thing carrying replacement across"
  }

  assert {
    condition     = one(azurerm_iothub_route.cosmos.endpoint_names) == "cosmos-storage"
    error_message = "Cosmos route must route to the cosmos-storage endpoint — this is the pairing azurerm_iothub_route.cosmos's replace_triggered_by must name"
  }

  assert {
    condition     = azurerm_iothub_endpoint_eventhub.eventhub_realtime.name == "eventhub-realtime"
    error_message = "Event Hub endpoint name must be the fixed literal 'eventhub-realtime' — same reasoning as the Cosmos endpoint above"
  }

  assert {
    condition     = one(azurerm_iothub_route.eventhub.endpoint_names) == "eventhub-realtime"
    error_message = "Event Hub route must route to the eventhub-realtime endpoint — this is the pairing azurerm_iothub_route.eventhub's replace_triggered_by must name"
  }
}
